import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { DomainError } from "../src/domain/idempotency.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const administratorPool = new Pool({ connectionString: databaseUrl });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hmacKey = createHash("sha256").update("task6-public-rate-limit-hmac-key", "utf8").digest();
let identityDb: Kysely<RuntimeDatabase>;

type BucketKind = "signup" | "login" | "reset" | "apple_start" | "apple_link" | "apple_callback" | "invitation_accept" | "reauthenticate";
interface ConsumeInput {
  readonly bucketKind: BucketKind;
  readonly accountIdentifier: string;
  readonly clientIdentifier: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly dimensions?: "both" | "account" | "client";
}
type ConsumePublicRateLimit = (
  dependencies: { readonly db: Kysely<RuntimeDatabase>; readonly hmacKey: Uint8Array },
  input: ConsumeInput,
) => Promise<number | null>;

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

async function ensureIdentityRoles(): Promise<void> {
  await administratorPool.query(`do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then
        create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then
        create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
    end
  $$`);
}

async function setIdentityPassword(password: string | null): Promise<void> {
  const client = await administratorPool.connect();
  try {
    await client.query("begin");
    await client.query("set local password_encryption = 'scram-sha-256'");
    await client.query("select set_config('core_agent.task6_rate_password', $1, true)", [password ?? ""]);
    await client.query(`do $password$
      begin
        if current_setting('core_agent.task6_rate_password') = '' then
          alter role core_agent_identity password null;
        else
          execute format('alter role core_agent_identity login password %L', current_setting('core_agent.task6_rate_password'));
        end if;
        perform set_config('core_agent.task6_rate_password', '', true);
      end
    $password$`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resetDatabase(): Promise<void> {
  await administratorPool.query("drop schema public cascade; create schema public;");
  await applyMigrations(administratorPool, migrationsDirectory);
}

function input(overrides: Partial<ConsumeInput> = {}): ConsumeInput {
  return {
    bucketKind: "login",
    accountIdentifier: "person@example.test",
    clientIdentifier: "203.0.113.41|device-opaque-41",
    limit: 2,
    windowMs: 60_000,
    ...overrides,
  };
}

async function stableConcurrencyWindowMs(): Promise<number> {
  const result = await administratorPool.query<{ now_ms: string }>(
    "select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now_ms",
  );
  const nowMs = Number(result.rows[0]?.now_ms);
  assert.equal(Number.isSafeInteger(nowMs), true);
  const maximumWindowMs = 30 * 24 * 60 * 60 * 1_000;
  const boundarySafetyMs = 120_000;
  for (let index = 0; index < 64; index += 1) {
    const windowMs = maximumWindowMs - index * 7_919;
    const elapsedMs = nowMs % windowMs;
    if (elapsedMs > boundarySafetyMs && windowMs - elapsedMs > boundarySafetyMs) return windowMs;
  }
  throw new Error("database clock is too close to every concurrency-test window boundary");
}

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityDb = createRuntimeDatabase(new Pool({ connectionString: target.toString(), max: 24 }));
});

test.beforeEach(resetDatabase);

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("public fixed-window rate limits persist independent account and IP-device HMAC dimensions", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const buckets: BucketKind[] = [
    "signup", "login", "reset", "apple_start", "apple_link", "apple_callback", "invitation_accept", "reauthenticate",
  ];
  for (const bucketKind of buckets) {
    assert.equal(await consumePublicRateLimit({ db: identityDb, hmacKey }, input({ bucketKind })), null);
  }
  const rows = await administratorPool.query<{
    bucket_kind: string;
    account_identifier_hmac: Buffer;
    client_identifier_hmac: Buffer;
  }>(`select bucket_kind, account_identifier_hmac, client_identifier_hmac
      from public_rate_limits order by bucket_kind`);
  assert.deepEqual(rows.rows.map((row) => row.bucket_kind), [...buckets, ...buckets].sort());
  const account = createHmac("sha256", hmacKey).update("account:person@example.test", "utf8").digest();
  const client = createHmac("sha256", hmacKey).update("client:203.0.113.41|device-opaque-41", "utf8").digest();
  const anyAccount = createHmac("sha256", hmacKey).update("account:*", "utf8").digest();
  const anyClient = createHmac("sha256", hmacKey).update("client:*", "utf8").digest();
  for (const row of rows.rows) {
    assert.equal(row.account_identifier_hmac.length, 32);
    assert.equal(row.client_identifier_hmac.length, 32);
    const accountDimension = row.account_identifier_hmac.equals(account) && row.client_identifier_hmac.equals(anyClient);
    const clientDimension = row.account_identifier_hmac.equals(anyAccount) && row.client_identifier_hmac.equals(client);
    assert.equal(accountDimension || clientDimension, true);
  }
  assert.equal(JSON.stringify(rows.rows).includes("person@example.test"), false);
  assert.equal(JSON.stringify(rows.rows).includes("203.0.113.41"), false);
  assert.equal(JSON.stringify(rows.rows).includes("device-opaque-41"), false);
});

test("fixed-window exhaustion returns only database-bounded retry-after milliseconds", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  assert.equal(await consumePublicRateLimit({ db: identityDb, hmacKey }, input()), null);
  assert.equal(await consumePublicRateLimit({ db: identityDb, hmacKey }, input()), null);
  const retryAfterMs = await consumePublicRateLimit({ db: identityDb, hmacKey }, input());
  assert.equal(typeof retryAfterMs, "number");
  assert((retryAfterMs ?? 0) > 0 && (retryAfterMs ?? 0) <= 60_000);
  const row = await administratorPool.query<{
    request_count: number;
    aligned: boolean;
    future_expiry: boolean;
    bounded_expiry: boolean;
  }>(`select request_count,
        mod((extract(epoch from window_started_at) * 1000)::bigint, 60000) = 0 as aligned,
        expires_at > clock_timestamp() as future_expiry,
        expires_at <= clock_timestamp() + interval '60 seconds' as bounded_expiry
      from public_rate_limits`);
  assert.deepEqual(row.rows[0], {
    request_count: 3,
    aligned: true,
    future_expiry: true,
    bounded_expiry: true,
  });
});

test("account and client rate-limit dimensions exhaust independently", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const consume = (overrides: Partial<ConsumeInput>) => consumePublicRateLimit(
    { db: identityDb, hmacKey },
    input({ limit: 1, ...overrides }),
  );
  assert.equal(await consume({ bucketKind: "signup", accountIdentifier: "same@example.test", clientIdentifier: "client-a" }), null);
  assert.equal(typeof await consume({ bucketKind: "signup", accountIdentifier: "same@example.test", clientIdentifier: "client-b" }), "number");
  assert.equal(await consume({ bucketKind: "login", accountIdentifier: "first@example.test", clientIdentifier: "same-client" }), null);
  assert.equal(typeof await consume({ bucketKind: "login", accountIdentifier: "second@example.test", clientIdentifier: "same-client" }), "number");
});

test("explicit route-client and server-account dimensions never collapse into a global bucket", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const consume = (overrides: Partial<ConsumeInput>) => consumePublicRateLimit(
    { db: identityDb, hmacKey },
    input({ limit: 1, ...overrides }),
  );

  assert.equal(await consume({
    bucketKind: "apple_callback", dimensions: "client",
    accountIdentifier: "route:/auth/v1/apple/callback", clientIdentifier: "same-client",
  }), null);
  assert.equal(typeof await consume({
    bucketKind: "apple_callback", dimensions: "client",
    accountIdentifier: "route:/auth/v1/apple/callback/rotated", clientIdentifier: "same-client",
  }), "number", "attacker-controlled route/account facts cannot rotate the stable client bucket");
  assert.equal(await consume({
    bucketKind: "apple_callback", dimensions: "client",
    accountIdentifier: "route:/auth/v1/apple/callback", clientIdentifier: "independent-client",
  }), null);

  assert.equal(await consume({
    bucketKind: "invitation_accept", dimensions: "account",
    accountIdentifier: "server-invitation-a", clientIdentifier: "client-a",
  }), null);
  assert.equal(typeof await consume({
    bucketKind: "invitation_accept", dimensions: "account",
    accountIdentifier: "server-invitation-a", clientIdentifier: "client-b",
  }), "number", "client rotation cannot bypass the server-derived account bucket");
  assert.equal(await consume({
    bucketKind: "invitation_accept", dimensions: "account",
    accountIdentifier: "server-invitation-b", clientIdentifier: "client-a",
  }), null, "different server-derived accounts do not collapse into one global bucket");
});

test("concurrent public attempts share one atomic PostgreSQL counter", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const windowMs = await stableConcurrencyWindowMs();
  const results = await Promise.all(Array.from({ length: 20 }, () => (
    consumePublicRateLimit({ db: identityDb, hmacKey }, input({ limit: 5, windowMs }))
  )));
  assert.equal(results.filter((retryAfterMs) => retryAfterMs === null).length, 5);
  assert.equal(results.filter((retryAfterMs) => typeof retryAfterMs === "number" && retryAfterMs > 0).length, 15);
  const row = await administratorPool.query<{ request_count: number }>(
    "select request_count from public_rate_limits",
  );
  assert.equal(row.rows[0]?.request_count, 20);
});

test("rate-limit account and client dimensions cannot be bypassed independently", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const consume = (overrides: Partial<ConsumeInput> = {}) => (
    consumePublicRateLimit({ db: identityDb, hmacKey }, input({ limit: 1, ...overrides }))
  );
  assert.equal(await consume(), null);
  assert.equal(typeof await consume(), "number");
  assert.equal(typeof await consume({ accountIdentifier: "another@example.test" }), "number");
  assert.equal(typeof await consume({ clientIdentifier: "198.51.100.2|another-device" }), "number");
  assert.equal(await consume({
    accountIdentifier: "third@example.test", clientIdentifier: "198.51.100.3|third-device",
  }), null);
  assert.equal(await consume({ bucketKind: "reset" }), null);
  const count = await administratorPool.query<{ count: number }>(
    "select count(*)::int as count from public_rate_limits",
  );
  assert.equal(count.rows[0]?.count, 8);
});

test("invalid rate-limit policy and protection key fail without reflecting account IP or device identifiers", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const attempts = [
    () => consumePublicRateLimit({ db: identityDb, hmacKey: Buffer.alloc(8) }, input()),
    () => consumePublicRateLimit({ db: identityDb, hmacKey }, input({ limit: 0 })),
    () => consumePublicRateLimit({ db: identityDb, hmacKey }, input({ windowMs: 0 })),
    () => consumePublicRateLimit({ db: identityDb, hmacKey }, input({ accountIdentifier: "" })),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (error: unknown) => {
      assert(error instanceof DomainError);
      assert.equal(error.message.includes("person@example.test"), false);
      assert.equal(error.message.includes("203.0.113.41"), false);
      assert.equal(error.message.includes("device-opaque-41"), false);
      return true;
    });
  }
});

test("formal PostgreSQL registration includes both Task 6 suites exactly once and pins their CI markers", async () => {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "packages", "runtime-core", "package.json"), "utf8")) as {
    scripts: { "test:postgres": string };
  };
  for (const suite of ["tests/core-session.test.ts", "tests/public-rate-limits.test.ts"]) {
    assert.equal(packageJson.scripts["test:postgres"].split(suite).length - 1, 1, `${suite} must be registered exactly once`);
  }
  const ciEquivalent = await readFile(
    join(repositoryRoot, "tests", "runtime", "database-ci-equivalent.integration.mjs"),
    "utf8",
  );
  assert.match(ciEquivalent, /Session lifetime uses the injected database clock/u);
  assert.match(ciEquivalent, /owned Session credential buffers are cleared after use/u);
  assert.match(ciEquivalent, /authentication clears original query-result digest Buffers/u);
  assert.match(ciEquivalent, /Session authentication rejects non-canonical base64url credential aliases/u);
  assert.match(ciEquivalent, /verified password reauthentication durably establishes the exact 10-minute authority boundary/u);
  assert.match(ciEquivalent, /external provider work stays outside retry while the durable Session command rechecks current authority/u);
  assert.match(ciEquivalent, /a normally issued Apple Session becomes eligible after verified password reauthentication/u);
  assert.match(ciEquivalent, /protected reauthenticated mutations serialize behind disable unlink and revoke/u);
  assert.match(ciEquivalent, /transaction-scoped guard retains canonical locks through a real protected Session command/u);
  assert.match(ciEquivalent, /public fixed-window rate limits persist independent account and IP-device HMAC dimensions/u);
  const repositorySource = await readFile(
    join(repositoryRoot, "packages", "runtime-core", "src", "repositories", "identity", "public-rate-limits.ts"),
    "utf8",
  );
  assert.match(repositorySource, /insert into public_rate_limits[\s\S]*on conflict[\s\S]*do update/iu);
  assert.doesNotMatch(repositorySource, /selectFrom\(["']public_rate_limits["']\)/u);
});
