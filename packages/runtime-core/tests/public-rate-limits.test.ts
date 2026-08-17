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

type BucketKind = "signup" | "login" | "reset" | "apple_callback" | "invitation_accept" | "reauthenticate";
interface ConsumeInput {
  readonly bucketKind: BucketKind;
  readonly accountIdentifier: string;
  readonly clientIdentifier: string;
  readonly limit: number;
  readonly windowMs: number;
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

test("public fixed-window rate limits persist only account and IP-device HMACs in six separate buckets", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const buckets: BucketKind[] = [
    "signup", "login", "reset", "apple_callback", "invitation_accept", "reauthenticate",
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
  assert.deepEqual(rows.rows.map((row) => row.bucket_kind), [...buckets].sort());
  for (const row of rows.rows) {
    assert.equal(row.account_identifier_hmac.length, 32);
    assert.equal(row.client_identifier_hmac.length, 32);
    assert.deepEqual(
      row.account_identifier_hmac,
      createHmac("sha256", hmacKey).update("person@example.test", "utf8").digest(),
    );
    assert.deepEqual(
      row.client_identifier_hmac,
      createHmac("sha256", hmacKey).update("203.0.113.41|device-opaque-41", "utf8").digest(),
    );
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

test("concurrent public attempts share one atomic PostgreSQL counter", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const results = await Promise.all(Array.from({ length: 20 }, () => (
    consumePublicRateLimit({ db: identityDb, hmacKey }, input({ limit: 5 }))
  )));
  assert.equal(results.filter((retryAfterMs) => retryAfterMs === null).length, 5);
  assert.equal(results.filter((retryAfterMs) => typeof retryAfterMs === "number" && retryAfterMs > 0).length, 15);
  const row = await administratorPool.query<{ request_count: number }>(
    "select request_count from public_rate_limits",
  );
  assert.equal(row.rows[0]?.request_count, 20);
});

test("rate-limit identity pairs and bucket kinds do not consume one another", async () => {
  const consumePublicRateLimit = requiredFunction<ConsumePublicRateLimit>("consumePublicRateLimit");
  const consume = (overrides: Partial<ConsumeInput> = {}) => (
    consumePublicRateLimit({ db: identityDb, hmacKey }, input({ limit: 1, ...overrides }))
  );
  assert.equal(await consume(), null);
  assert.equal(typeof await consume(), "number");
  assert.equal(await consume({ accountIdentifier: "another@example.test" }), null);
  assert.equal(await consume({ clientIdentifier: "198.51.100.2|another-device" }), null);
  assert.equal(await consume({ bucketKind: "reset" }), null);
  const count = await administratorPool.query<{ count: number }>(
    "select count(*)::int as count from public_rate_limits",
  );
  assert.equal(count.rows[0]?.count, 4);
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
  assert.match(ciEquivalent, /a normally issued Apple Session becomes eligible after verified password reauthentication/u);
  assert.match(ciEquivalent, /protected reauthenticated mutations serialize behind disable unlink and revoke/u);
  assert.match(ciEquivalent, /public fixed-window rate limits persist only account and IP-device HMACs/u);
  const repositorySource = await readFile(
    join(repositoryRoot, "packages", "runtime-core", "src", "repositories", "identity", "public-rate-limits.ts"),
    "utf8",
  );
  assert.match(repositorySource, /insert into public_rate_limits[\s\S]*on conflict[\s\S]*do update/iu);
  assert.doesNotMatch(repositorySource, /selectFrom\(["']public_rate_limits["']\)/u);
});
