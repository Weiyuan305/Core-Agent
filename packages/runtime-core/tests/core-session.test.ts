import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CoreSession } from "@core-agent/contracts";
import type {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  Transaction,
  UnknownRow,
} from "kysely";
import { sql } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { DomainError } from "../src/domain/idempotency.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const coreSessionRepository = await import("../src/repositories/identity/core-sessions.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const administratorPool = new Pool({ connectionString: databaseUrl });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const createdAt = new Date("2026-08-17T01:00:00.000Z");
const dayMs = 24 * 60 * 60 * 1_000;
let identityDb: Kysely<RuntimeDatabase>;
let entropyByte = 0x31;
let entropySizes: number[] = [];

interface SessionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly randomBytes?: (size: number) => Buffer;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

interface IssueInput {
  readonly sessionId: string;
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly clientKind: "web" | "iphone" | "macos";
  readonly deviceLabel?: string;
}

interface Issued {
  readonly session: CoreSession;
  readonly sessionSecret: string;
  readonly csrfSecret?: string;
}

interface Authenticated {
  readonly session: CoreSession;
  readonly authority: { readonly actorId: string; readonly actorStatus: string };
  readonly authSubject: {
    readonly authSubjectId: string;
    readonly actorId: string;
    readonly provider: "supabase";
    readonly identityKind: "email_password" | "apple";
    readonly status: "active" | "unlinked" | "revoked";
  };
}

type IssueCoreSession = (dependencies: SessionDependencies, input: IssueInput) => Promise<Issued>;
type AuthenticateCoreSession = (
  dependencies: SessionDependencies,
  input: { readonly sessionSecret: string; readonly csrfSecret?: string; readonly requireCsrf?: boolean },
) => Promise<Authenticated>;
type RevokeCoreSession = (
  dependencies: SessionDependencies,
  input: { readonly actorId: string; readonly sessionId: string; readonly reason: "user_sign_out" | "administrator_revoked" },
) => Promise<CoreSession>;
type RevokeCoreSessions = (
  dependencies: SessionDependencies,
  input:
    | { readonly actorId: string; readonly reason: "password_reset" | "actor_disabled" | "account_deletion_requested" | "administrator_revoked" }
    | { readonly actorId: string; readonly authSubjectId: string; readonly reason: "provider_unlinked" },
) => Promise<number>;
interface ReauthenticationDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

interface ReauthenticationTransactionContext {
  readonly trx: Transaction<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

interface CurrentSessionAuthorityInput {
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly sessionId: string;
}

interface VerifiedPasswordSubject {
  readonly provider: "supabase";
  readonly providerSubject: string;
  readonly identityKind: "email_password";
  readonly normalizedEmail: string;
  readonly verifiedAt: string;
}

interface EstablishedReauthentication {
  readonly schema_version: 1;
  readonly reauthenticated_at: string;
  readonly valid_until: string;
  readonly session_resource_version: number;
}

type EstablishRecentReauthentication = (
  dependencies: ReauthenticationDependencies,
  input: CurrentSessionAuthorityInput & {
    readonly verifiedPasswordSubject: VerifiedPasswordSubject;
  },
) => Promise<EstablishedReauthentication>;

interface RecentReauthenticationAuthority {
  readonly session: CoreSession;
  readonly reauthenticatedAt: string;
  readonly validUntil: string;
}

type RequireRecentReauthentication = (
  context: ReauthenticationTransactionContext,
  input: CurrentSessionAuthorityInput,
) => Promise<RecentReauthenticationAuthority>;

type RevokeCoreSessionInTransaction = (
  dependencies: Pick<SessionDependencies, "databaseNow">,
  trx: Transaction<RuntimeDatabase>,
  input: { readonly actorId: string; readonly sessionId: string; readonly reason: "user_sign_out" | "administrator_revoked" },
) => Promise<CoreSession>;

type WithDatabaseTransactionRetry = <T>(
  db: Kysely<RuntimeDatabase>,
  work: (trx: Transaction<RuntimeDatabase>) => Promise<T>,
) => Promise<T>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function assertPending<T>(promise: Promise<T>): Promise<void> {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => "fulfilled" as const, () => "rejected" as const),
    new Promise<typeof pending>((resolve) => setTimeout(resolve, 50, pending)),
  ]);
  assert.equal(outcome, pending);
}

function verifiedPasswordSubject(): VerifiedPasswordSubject {
  return {
    provider: "supabase",
    providerSubject: "provider-subject_password",
    identityKind: "email_password",
    normalizedEmail: "person@example.test",
    verifiedAt: createdAt.toISOString(),
  };
}

function captureQueryDigestBuffers(captured: Buffer[][]): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs) {
      return args.node;
    },
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      for (const row of args.result.rows) {
        const buffers = Object.values(row).filter(Buffer.isBuffer);
        if (buffers.length > 0) captured.push(buffers);
      }
      return args.result;
    },
  };
}

function nonCanonicalBase64UrlAlias(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(secret.at(-1)!);
  assert.notEqual(lastIndex, -1);
  const aliasIndex = (lastIndex & ~3) + ((lastIndex + 1) & 3);
  const alias = `${secret.slice(0, -1)}${alphabet[aliasIndex]}`;
  assert.notEqual(alias, secret);
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(secret, "base64url"));
  return alias;
}

interface OwnedOpaqueCredential {
  readonly secret: string;
  readonly digest: Buffer;
  clear(): void;
}

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

function recentReauthenticationFailure(error: unknown): error is DomainError {
  return error instanceof DomainError
    && error.code === "UNAUTHENTICATED"
    && error.message === "UNAUTHENTICATED: Recent reauthentication is required";
}

async function requireRecentAt(session: CoreSession, now: Date): Promise<void> {
  const requireRecentReauthentication = requiredFunction<RequireRecentReauthentication>("requireRecentReauthentication");
  await identityDb.transaction().execute(async (trx) => {
    await requireRecentReauthentication({
      trx,
      databaseNow: async () => new Date(now),
    }, {
      actorId: session.actor_id,
      authSubjectId: session.auth_subject_id,
      sessionId: session.session_id,
    });
  });
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
    await client.query("select set_config('core_agent.task6_identity_password', $1, true)", [password ?? ""]);
    await client.query(`do $password$
      begin
        if current_setting('core_agent.task6_identity_password') = '' then
          alter role core_agent_identity password null;
        else
          execute format('alter role core_agent_identity login password %L', current_setting('core_agent.task6_identity_password'));
        end if;
        perform set_config('core_agent.task6_identity_password', '', true);
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
  entropyByte = 0x31;
  entropySizes = [];
  await administratorPool.query("drop schema public cascade; create schema public;");
  await applyMigrations(administratorPool, migrationsDirectory);
}

async function seedActor(
  actorId: string,
  subjects: readonly { id: string; kind: "email_password" | "apple" }[],
): Promise<void> {
  await identityDb.insertInto("actors").values({
    actor_id: actorId,
    schema_version: 1,
    resource_version: 1,
    actor_kind: "human",
    display_name: actorId,
    status: "active",
    created_at: createdAt,
    updated_at: createdAt,
  }).execute();
  for (const subject of subjects) {
    await identityDb.insertInto("auth_subjects").values({
      auth_subject_id: subject.id,
      actor_id: actorId,
      provider: "supabase",
      provider_subject: `provider-${subject.id}`,
      provider_identity_kind: subject.kind,
      verified_at: createdAt,
      status: "active",
      resource_version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
  }
}

function dependencies(now = createdAt): SessionDependencies {
  return {
    db: identityDb,
    databaseNow: async () => new Date(now),
    randomBytes(size) {
      entropySizes.push(size);
      const bytes = Buffer.alloc(size, entropyByte);
      entropyByte += 1;
      return bytes;
    },
  };
}

async function issue(
  sessionId: string,
  overrides: Partial<IssueInput> = {},
  now = createdAt,
): Promise<Issued> {
  const issueCoreSession = requiredFunction<IssueCoreSession>("issueCoreSession");
  return issueCoreSession(dependencies(now), {
    sessionId,
    actorId: "actor_session",
    authSubjectId: "subject_password",
    clientKind: "web",
    deviceLabel: "Test browser",
    ...overrides,
  });
}

function publicSessionFailure(error: unknown): error is DomainError {
  return error instanceof DomainError
    && error.code === "UNAUTHENTICATED"
    && error.message === "UNAUTHENTICATED: Core Session is invalid";
}

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityDb = createRuntimeDatabase(new Pool({ connectionString: target.toString(), max: 16 }));
});

test.beforeEach(async () => {
  await resetDatabase();
  await seedActor("actor_session", [
    { id: "subject_password", kind: "email_password" },
    { id: "subject_apple", kind: "apple" },
  ]);
  await seedActor("actor_other", [{ id: "subject_other", kind: "email_password" }]);
});

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("web Session issuance consumes exactly two 32-byte secrets and persists only SHA-256 digests", async () => {
  const issued = await issue("session_web_entropy");
  assert.deepEqual(entropySizes, [32, 32]);
  assert.equal(issued.sessionSecret.length, 43);
  assert.equal(issued.csrfSecret?.length, 43);
  assert.equal(JSON.stringify(issued.session).includes(issued.sessionSecret), false);
  assert.equal(JSON.stringify(issued.session).includes(issued.csrfSecret!), false);

  const row = await administratorPool.query<{ secret_digest: Buffer; csrf_digest: Buffer }>(
    "select secret_digest, csrf_digest from core_sessions where session_id = $1",
    ["session_web_entropy"],
  );
  assert.equal(row.rows[0]?.secret_digest.length, 32);
  assert.equal(row.rows[0]?.csrf_digest.length, 32);
  assert.deepEqual(row.rows[0]?.secret_digest, createHash("sha256").update(Buffer.alloc(32, 0x31)).digest());
  assert.deepEqual(row.rows[0]?.csrf_digest, createHash("sha256").update(Buffer.alloc(32, 0x32)).digest());
  assert.equal(JSON.stringify(row.rows).includes(issued.sessionSecret), false);
  assert.equal(JSON.stringify(row.rows).includes(issued.csrfSecret!), false);
});

test("owned Session credential buffers are cleared after use and when web CSRF credential generation fails", async () => {
  const issueOpaqueCoreSessionCredential = coreSessionRepository.issueOpaqueCoreSessionCredential as
    ((randomSource: (size: number) => Buffer) => OwnedOpaqueCredential) | undefined;
  assert.equal(typeof issueOpaqueCoreSessionCredential, "function");
  assert.equal(runtime.issueOpaqueCoreSessionCredential, undefined);
  const retainedCredentialBuffer = Buffer.alloc(32, 0x45);
  const credential = issueOpaqueCoreSessionCredential!(() => retainedCredentialBuffer);
  assert.strictEqual(credential.digest, retainedCredentialBuffer);
  assert.equal(credential.digest.some((byte) => byte !== 0), true);
  credential.clear();
  assert.equal(retainedCredentialBuffer.every((byte) => byte === 0), true);

  const issueCoreSession = requiredFunction<IssueCoreSession>("issueCoreSession");
  const retainedSuccessfulWebBuffers = [Buffer.alloc(32, 0x49), Buffer.alloc(32, 0x4a)];
  let successfulRandomCall = 0;
  await issueCoreSession({
    db: identityDb,
    databaseNow: async () => new Date(createdAt),
    randomBytes: () => retainedSuccessfulWebBuffers[successfulRandomCall++]!,
  }, {
    sessionId: "session_owned_credentials_success",
    actorId: "actor_session",
    authSubjectId: "subject_password",
    clientKind: "web",
  });
  assert.equal(successfulRandomCall, 2);
  assert.equal(retainedSuccessfulWebBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true);

  const retainedWebBuffers = [Buffer.alloc(32, 0x51), Buffer.alloc(31, 0x52)];
  let randomCall = 0;
  await assert.rejects(
    issueCoreSession({
      db: identityDb,
      databaseNow: async () => new Date(createdAt),
      randomBytes(size) {
        assert.equal(size, 32);
        if (randomCall === 1) {
          assert.equal(retainedWebBuffers[0]!.some((byte) => byte !== 0), true);
          assert.equal(retainedWebBuffers[0]!.equals(Buffer.alloc(32, 0x51)), false);
        }
        return retainedWebBuffers[randomCall++]!;
      },
    }, {
      sessionId: "session_second_credential_failure",
      actorId: "actor_session",
      authSubjectId: "subject_password",
      clientKind: "web",
    }),
    (error: unknown) => error instanceof DomainError
      && error.code === "INTERNAL_ERROR"
      && error.message === "INTERNAL_ERROR: Core Session entropy failed",
  );
  assert.equal(randomCall, 2);
  assert.equal(retainedWebBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true);
});

test("constant-time Session digest comparison clears every caller-owned input and durable rows expose no digest copies", async () => {
  const secretTestInternals = coreSessionRepository.coreSessionSecretTestInternals as {
    readonly constantTimeOwnedDigestMatch?: (candidate: Buffer, stored: Buffer) => boolean;
  } | undefined;
  assert.equal(typeof secretTestInternals?.constantTimeOwnedDigestMatch, "function");
  for (const [candidate, stored, expected] of [
    [Buffer.alloc(32, 0x61), Buffer.alloc(32, 0x61), true],
    [Buffer.alloc(32, 0x61), Buffer.alloc(32, 0x62), false],
    [Buffer.alloc(31, 0x61), Buffer.alloc(33, 0x61), false],
  ] as const) {
    assert.equal(secretTestInternals!.constantTimeOwnedDigestMatch!(candidate, stored), expected);
    assert.equal(candidate.every((byte) => byte === 0), true);
    assert.equal(stored.every((byte) => byte === 0), true);
  }

  const repositoryPath = join(dirname(fileURLToPath(import.meta.url)), "../src/repositories/identity/core-sessions.ts");
  const source = await readFile(repositoryPath, "utf8");
  assert.doesNotMatch(source, /function rowToStoredCoreSession/u);
  const sessionColumnsSource = /const sessionColumns = \[([\s\S]*?)\] as const;/u.exec(source)?.[1];
  assert.notEqual(sessionColumnsSource, undefined);
  assert.doesNotMatch(sessionColumnsSource!, /secret_digest|csrf_digest/u);
});

test("authentication clears original query-result digest Buffers on success mismatch and mapping error", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");

  const success = await issue("session_query_buffers_success");
  const successfulBuffers: Buffer[][] = [];
  await authenticateCoreSession({
    ...dependencies(),
    db: identityDb.withPlugin(captureQueryDigestBuffers(successfulBuffers)),
  }, {
    sessionSecret: success.sessionSecret,
    csrfSecret: success.csrfSecret,
    requireCsrf: true,
  });
  assert(successfulBuffers.flat().length >= 3);
  assert.equal(successfulBuffers.flat().every((buffer) => buffer.every((byte) => byte === 0)), true);

  const mismatch = await issue("session_query_buffers_mismatch");
  const mismatchedBuffers: Buffer[][] = [];
  await assert.rejects(authenticateCoreSession({
    ...dependencies(),
    db: identityDb.withPlugin(captureQueryDigestBuffers(mismatchedBuffers)),
  }, {
    sessionSecret: mismatch.sessionSecret,
    csrfSecret: Buffer.alloc(32, 0x7f).toString("base64url"),
    requireCsrf: true,
  }), publicSessionFailure);
  assert(mismatchedBuffers.flat().length >= 3);
  assert.equal(mismatchedBuffers.flat().every((buffer) => buffer.every((byte) => byte === 0)), true);

  const mappingError = await issue("session_query_buffers_mapping_error");
  await administratorPool.query(
    "update core_sessions set resource_version = 9007199254740992 where session_id = $1",
    [mappingError.session.session_id],
  );
  const errorBuffers: Buffer[][] = [];
  await assert.rejects(authenticateCoreSession({
    ...dependencies(),
    db: identityDb.withPlugin(captureQueryDigestBuffers(errorBuffers)),
  }, {
    sessionSecret: mappingError.sessionSecret,
    csrfSecret: mappingError.csrfSecret,
    requireCsrf: true,
  }), (error: unknown) => error instanceof DomainError && error.code === "INTERNAL_ERROR");
  assert(errorBuffers.flat().length >= 3);
  assert.equal(errorBuffers.flat().every((buffer) => buffer.every((byte) => byte === 0)), true);
});

test("authentication does not select CSRF digests when CSRF validation is not required", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const issued = await issue("session_query_without_csrf");
  const resultKeys: string[][] = [];
  const plugin: KyselyPlugin = {
    transformQuery(args) {
      return args.node;
    },
    async transformResult(args) {
      for (const row of args.result.rows) resultKeys.push(Object.keys(row));
      return args.result;
    },
  };
  await authenticateCoreSession({
    ...dependencies(),
    db: identityDb.withPlugin(plugin),
  }, { sessionSecret: issued.sessionSecret });
  assert.equal(resultKeys.some((keys) => keys.includes("csrf_digest")), false);
});

test("native Session issuance consumes one 32-byte secret and never creates CSRF authority", async () => {
  const issued = await issue("session_native_entropy", { clientKind: "iphone", deviceLabel: "Phone" });
  assert.deepEqual(entropySizes, [32]);
  assert.equal(issued.csrfSecret, undefined);
  const row = await administratorPool.query<{ csrf_digest: Buffer | null }>(
    "select csrf_digest from core_sessions where session_id = $1",
    ["session_native_entropy"],
  );
  assert.equal(row.rows[0]?.csrf_digest, null);
});

test("Session issuance rejects non-string or overlong device labels before persistence", async () => {
  const issueCoreSession = requiredFunction<(
    dependencies: SessionDependencies,
    input: Record<string, unknown>,
  ) => Promise<Issued>>("issueCoreSession");
  for (const deviceLabel of [{ label: "not-a-string" }, "x".repeat(81)]) {
    await assert.rejects(
      issueCoreSession(dependencies(), {
        sessionId: `session_invalid_label_${typeof deviceLabel}`,
        actorId: "actor_session",
        authSubjectId: "subject_password",
        clientKind: "web",
        deviceLabel,
      }),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
  const row = await administratorPool.query<{ count: number }>(
    "select count(*)::int as count from core_sessions",
  );
  assert.equal(row.rows[0]?.count, 0);
});

test("Session lifetime uses the injected database clock for exact seven-day idle and thirty-day absolute expiry", async () => {
  const issued = await issue("session_lifetime");
  assert.equal(issued.session.created_at, createdAt.toISOString());
  assert.equal(issued.session.last_seen_at, createdAt.toISOString());
  assert.equal(issued.session.idle_expires_at, new Date(createdAt.getTime() + 7 * dayMs).toISOString());
  assert.equal(issued.session.absolute_expires_at, new Date(createdAt.getTime() + 30 * dayMs).toISOString());
  assert.equal(issued.session.resource_version, 1);
});

test("successful activity advances idle expiry to min(now plus seven days, absolute expiry) without extending absolute expiry", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const issued = await issue("session_bounded_activity");
  const daySix = new Date(createdAt.getTime() + 6 * dayMs);
  const first = await authenticateCoreSession(dependencies(daySix), {
    sessionSecret: issued.sessionSecret,
    csrfSecret: issued.csrfSecret,
    requireCsrf: true,
  });
  assert.equal(first.session.last_seen_at, daySix.toISOString());
  assert.equal(first.session.idle_expires_at, new Date(createdAt.getTime() + 13 * dayMs).toISOString());
  assert.equal(first.session.absolute_expires_at, new Date(createdAt.getTime() + 30 * dayMs).toISOString());

  for (const day of [12, 18, 24]) {
    await authenticateCoreSession(dependencies(new Date(createdAt.getTime() + day * dayMs)), {
      sessionSecret: issued.sessionSecret,
      csrfSecret: issued.csrfSecret,
      requireCsrf: true,
    });
  }
  const dayTwentyNine = new Date(createdAt.getTime() + 29 * dayMs);
  const second = await authenticateCoreSession(dependencies(dayTwentyNine), {
    sessionSecret: issued.sessionSecret,
    csrfSecret: issued.csrfSecret,
    requireCsrf: true,
  });
  assert.equal(second.session.idle_expires_at, new Date(createdAt.getTime() + 30 * dayMs).toISOString());
  assert.equal(second.session.absolute_expires_at, new Date(createdAt.getTime() + 30 * dayMs).toISOString());
});

test("authentication validates independent web CSRF authority and current Actor plus AuthSubject authority", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const issued = await issue("session_csrf");
  const authenticated = await authenticateCoreSession(dependencies(), {
    sessionSecret: issued.sessionSecret,
    csrfSecret: issued.csrfSecret,
    requireCsrf: true,
  });
  assert.equal(authenticated.authority.actorId, "actor_session");
  assert.equal(authenticated.authority.actorStatus, "active");
  assert.deepEqual(authenticated.authSubject, {
    authSubjectId: "subject_password",
    actorId: "actor_session",
    provider: "supabase",
    identityKind: "email_password",
    status: "active",
  });
  await assert.rejects(
    authenticateCoreSession(dependencies(), { sessionSecret: issued.sessionSecret, requireCsrf: true }),
    publicSessionFailure,
  );
  await assert.rejects(
    authenticateCoreSession(dependencies(), {
      sessionSecret: issued.sessionSecret,
      csrfSecret: Buffer.alloc(32, 0x7f).toString("base64url"),
      requireCsrf: true,
    }),
    publicSessionFailure,
  );
});

test("expired revoked malformed and unknown Session secrets have one public failure", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const revokeCoreSession = requiredFunction<RevokeCoreSession>("revokeCoreSession");
  const expired = await issue("session_expired");
  const revoked = await issue("session_revoked");
  await revokeCoreSession(dependencies(), {
    actorId: "actor_session",
    sessionId: revoked.session.session_id,
    reason: "user_sign_out",
  });
  const attempts = [
    () => authenticateCoreSession(dependencies(new Date(createdAt.getTime() + 7 * dayMs)), { sessionSecret: expired.sessionSecret }),
    () => authenticateCoreSession(dependencies(), { sessionSecret: revoked.sessionSecret }),
    () => authenticateCoreSession(dependencies(), { sessionSecret: Buffer.alloc(32, 0x70).toString("base64url") }),
    () => authenticateCoreSession(dependencies(), { sessionSecret: "not-base64url" }),
  ];
  const messages: string[] = [];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (error: unknown) => {
      assert.equal(publicSessionFailure(error), true);
      messages.push((error as Error).message);
      return true;
    });
  }
  assert.equal(new Set(messages).size, 1);
  const row = await administratorPool.query<{ status: string; revocation_reason: string | null }>(
    "select status, revocation_reason from core_sessions where session_id = $1",
    ["session_expired"],
  );
  assert.deepEqual(row.rows[0], { status: "expired", revocation_reason: null });
});

test("Session authentication rejects non-canonical base64url credential aliases", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const issued = await issue("session_noncanonical_alias");
  const sessionAlias = nonCanonicalBase64UrlAlias(issued.sessionSecret);
  const csrfAlias = nonCanonicalBase64UrlAlias(issued.csrfSecret!);
  await assert.rejects(
    authenticateCoreSession(dependencies(), { sessionSecret: sessionAlias }),
    publicSessionFailure,
  );
  await assert.rejects(
    authenticateCoreSession(dependencies(), {
      sessionSecret: issued.sessionSecret,
      csrfSecret: csrfAlias,
      requireCsrf: true,
    }),
    publicSessionFailure,
  );
});

test("current Actor or AuthSubject authority changes fail closed without provider availability", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const disabled = await issue("session_disabled_actor");
  await identityDb.updateTable("actors").set({ status: "disabled" }).where("actor_id", "=", "actor_session").execute();
  await assert.rejects(
    authenticateCoreSession(dependencies(), { sessionSecret: disabled.sessionSecret }),
    publicSessionFailure,
  );
  await identityDb.updateTable("actors").set({ status: "active" }).where("actor_id", "=", "actor_session").execute();
  const unlinked = await issue("session_unlinked_subject");
  await identityDb.updateTable("auth_subjects").set({ status: "unlinked" })
    .where("auth_subject_id", "=", "subject_password").execute();
  await assert.rejects(
    authenticateCoreSession(dependencies(), { sessionSecret: unlinked.sessionSecret }),
    publicSessionFailure,
  );
});

test("concurrent Session use and revoke preserve revoked authority", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const revokeCoreSession = requiredFunction<RevokeCoreSession>("revokeCoreSession");
  const issued = await issue("session_concurrent_revoke");
  const results = await Promise.allSettled([
    authenticateCoreSession(dependencies(new Date(createdAt.getTime() + dayMs)), {
      sessionSecret: issued.sessionSecret,
      csrfSecret: issued.csrfSecret,
      requireCsrf: true,
    }),
    revokeCoreSession(dependencies(new Date(createdAt.getTime() + dayMs)), {
      actorId: "actor_session",
      sessionId: issued.session.session_id,
      reason: "user_sign_out",
    }),
  ]);
  assert.equal(results[1]?.status, "fulfilled");
  if (results[0]?.status === "fulfilled") {
    assert.equal(results[0].value.session.session_id, issued.session.session_id);
    assert.equal(results[0].value.session.status, "active");
  } else {
    assert.equal(publicSessionFailure(results[0]?.reason), true);
  }
  const row = await administratorPool.query<{ status: string; revocation_reason: string; resource_version: number }>(
    "select status, revocation_reason, resource_version::int from core_sessions where session_id = $1",
    [issued.session.session_id],
  );
  assert.equal(row.rows[0]?.status, "revoked");
  assert.equal(row.rows[0]?.revocation_reason, "user_sign_out");
  assert((row.rows[0]?.resource_version ?? 0) >= 2);
});

test("password reset provider unlink Actor disable deletion and sign-out revoke only their required scope", async () => {
  const revokeCoreSession = requiredFunction<RevokeCoreSession>("revokeCoreSession");
  const revokeCoreSessions = requiredFunction<RevokeCoreSessions>("revokeCoreSessions");
  const cases = [
    { reason: "password_reset" as const, scope: "actor" as const },
    { reason: "actor_disabled" as const, scope: "actor" as const },
    { reason: "account_deletion_requested" as const, scope: "actor" as const },
  ];
  for (const [index, scenario] of cases.entries()) {
    const password = await issue(`session_scope_password_${index}`);
    const apple = await issue(`session_scope_apple_${index}`, { authSubjectId: "subject_apple" });
    await issue(`session_scope_other_${index}`, {
      actorId: "actor_other",
      authSubjectId: "subject_other",
    });
    assert.equal(await revokeCoreSessions(dependencies(), {
      actorId: "actor_session",
      reason: scenario.reason,
    }), 2);
    const rows = await administratorPool.query<{ session_id: string; status: string }>(
      "select session_id, status from core_sessions where session_id = any($1::text[]) order by session_id",
      [[password.session.session_id, apple.session.session_id, `session_scope_other_${index}`]],
    );
    assert.deepEqual(Object.fromEntries(rows.rows.map((row) => [row.session_id, row.status])), {
      [`session_scope_password_${index}`]: "revoked",
      [`session_scope_apple_${index}`]: "revoked",
      [`session_scope_other_${index}`]: "active",
    });
  }

  const password = await issue("session_provider_password");
  const apple = await issue("session_provider_apple", { authSubjectId: "subject_apple" });
  assert.equal(await revokeCoreSessions(dependencies(), {
    actorId: "actor_session",
    authSubjectId: "subject_apple",
    reason: "provider_unlinked",
  }), 1);
  const providerRows = await administratorPool.query<{ session_id: string; status: string }>(
    "select session_id, status from core_sessions where session_id = any($1::text[]) order by session_id",
    [[password.session.session_id, apple.session.session_id]],
  );
  assert.deepEqual(providerRows.rows, [
    { session_id: "session_provider_apple", status: "revoked" },
    { session_id: "session_provider_password", status: "active" },
  ]);

  const first = await issue("session_signout_first");
  const second = await issue("session_signout_second");
  await revokeCoreSession(dependencies(), {
    actorId: "actor_session",
    sessionId: first.session.session_id,
    reason: "user_sign_out",
  });
  const signoutRows = await administratorPool.query<{ session_id: string; status: string }>(
    "select session_id, status from core_sessions where session_id = any($1::text[]) order by session_id",
    [[first.session.session_id, second.session.session_id]],
  );
  assert.deepEqual(signoutRows.rows, [
    { session_id: "session_signout_first", status: "revoked" },
    { session_id: "session_signout_second", status: "active" },
  ]);
});

test("revocation rejects runtime reason and scope combinations that could broaden authority", async () => {
  const revokeCoreSessions = requiredFunction<(
    dependencies: SessionDependencies,
    input: Record<string, unknown>,
  ) => Promise<number>>("revokeCoreSessions");
  const issued = await issue("session_invalid_revocation_scope");
  for (const invalid of [
    { actorId: "actor_session", reason: "user_sign_out" },
    { actorId: "actor_session", reason: "provider_unlinked" },
    { actorId: "actor_session", authSubjectId: "subject_password", reason: "password_reset" },
  ]) {
    await assert.rejects(
      revokeCoreSessions(dependencies(), invalid),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
  const row = await administratorPool.query<{ status: string; revocation_reason: string | null }>(
    "select status, revocation_reason from core_sessions where session_id = $1",
    [issued.session.session_id],
  );
  assert.deepEqual(row.rows[0], { status: "active", revocation_reason: null });
});

test("verified password reauthentication durably establishes the exact 10-minute authority boundary", async () => {
  const establishRecentReauthentication = requiredFunction<EstablishRecentReauthentication>(
    "establishRecentReauthentication",
  );
  const issued = await issue("session_establish_reauthentication");
  const established = await establishRecentReauthentication({
    db: identityDb,
    databaseNow: async () => new Date(createdAt),
  }, {
    actorId: issued.session.actor_id,
    authSubjectId: issued.session.auth_subject_id,
    sessionId: issued.session.session_id,
    verifiedPasswordSubject: verifiedPasswordSubject(),
  });
  assert.deepEqual(established, {
    schema_version: 1,
    reauthenticated_at: createdAt.toISOString(),
    valid_until: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
    session_resource_version: 2,
  });
  const row = await administratorPool.query<{
    reauthenticated_at: Date;
    resource_version: number;
  }>("select reauthenticated_at, resource_version::int from core_sessions where session_id = $1", [
    issued.session.session_id,
  ]);
  assert.equal(row.rows[0]?.reauthenticated_at.toISOString(), established.reauthenticated_at);
  assert.equal(row.rows[0]?.resource_version, established.session_resource_version);

  let mutations = 0;
  await assert.doesNotReject(requireRecentAt(
    { ...issued.session, reauthenticated_at: established.reauthenticated_at },
    new Date(createdAt.getTime() + 9 * 60_000 + 59_000),
  ));
  await assert.rejects(
    identityDb.transaction().execute(async (trx) => {
      await requiredFunction<RequireRecentReauthentication>("requireRecentReauthentication")({
        trx,
        databaseNow: async () => new Date(createdAt.getTime() + 10 * 60_000),
      }, {
        actorId: issued.session.actor_id,
        authSubjectId: issued.session.auth_subject_id,
        sessionId: issued.session.session_id,
      });
      mutations += 1;
    }),
    recentReauthenticationFailure,
  );
  assert.equal(mutations, 0);
});

test("external provider work stays outside retry while the durable Session command rechecks current authority", async () => {
  const establishRecentReauthentication = requiredFunction<EstablishRecentReauthentication>(
    "establishRecentReauthentication",
  );
  const requireRecentReauthentication = requiredFunction<RequireRecentReauthentication>(
    "requireRecentReauthentication",
  );
  const revokeCoreSessionInTransaction = requiredFunction<RevokeCoreSessionInTransaction>(
    "revokeCoreSessionInTransaction",
  );
  const withDatabaseTransactionRetry = requiredFunction<WithDatabaseTransactionRetry>(
    "withDatabaseTransactionRetry",
  );
  const issued = await issue("session_reauthentication_retry_current");
  const target = await issue("session_reauthentication_retry_target");
  await establishRecentReauthentication({ db: identityDb, databaseNow: async () => new Date(createdAt) }, {
    actorId: issued.session.actor_id,
    authSubjectId: issued.session.auth_subject_id,
    sessionId: issued.session.session_id,
    verifiedPasswordSubject: verifiedPasswordSubject(),
  });

  let externalEffectCalls = 0;
  const providerStart = await (async () => {
    externalEffectCalls += 1;
    return Object.freeze({ authorizationUrl: "https://provider.invalid/authorize" });
  })();
  let transactionAttempts = 0;
  let authorityChecks = 0;
  const revoked = await withDatabaseTransactionRetry(identityDb, async (trx) => {
    transactionAttempts += 1;
    await requireRecentReauthentication({
      trx,
      databaseNow: async () => {
        authorityChecks += 1;
        return new Date(createdAt);
      },
    }, {
      actorId: issued.session.actor_id,
      authSubjectId: issued.session.auth_subject_id,
      sessionId: issued.session.session_id,
    });
    if (transactionAttempts === 1) {
      await sql`do $$ begin raise exception 'forced retry' using errcode = '40001'; end $$`.execute(trx);
    }
    return revokeCoreSessionInTransaction({ databaseNow: async () => new Date(createdAt) }, trx, {
      actorId: target.session.actor_id,
      sessionId: target.session.session_id,
      reason: "administrator_revoked",
    });
  });

  assert.equal(externalEffectCalls, 1);
  assert.equal(providerStart.authorizationUrl, "https://provider.invalid/authorize");
  assert.equal(transactionAttempts, 2);
  assert.equal(authorityChecks, 2);
  assert.equal(revoked.status, "revoked");
});

test("a normally issued Apple Session becomes eligible after verified password reauthentication", async () => {
  const establishRecentReauthentication = requiredFunction<EstablishRecentReauthentication>(
    "establishRecentReauthentication",
  );
  const issued = await issue("session_apple_password_reauthentication", {
    authSubjectId: "subject_apple",
  });
  const established = await establishRecentReauthentication({
    db: identityDb,
    databaseNow: async () => new Date(createdAt),
  }, {
    actorId: issued.session.actor_id,
    authSubjectId: issued.session.auth_subject_id,
    sessionId: issued.session.session_id,
    verifiedPasswordSubject: {
      ...verifiedPasswordSubject(),
      providerSubject: "provider-subject_apple",
    },
  });
  assert.equal(established.reauthenticated_at, createdAt.toISOString());
  await assert.doesNotReject(requireRecentAt(
    { ...issued.session, reauthenticated_at: established.reauthenticated_at },
    new Date(createdAt.getTime() + 9 * 60_000 + 59_000),
  ));
});

test("reauthentication establishment rejects revoked expired disabled unlinked and mismatched authority", async () => {
  const establishRecentReauthentication = requiredFunction<EstablishRecentReauthentication>(
    "establishRecentReauthentication",
  );
  const revokeCoreSession = requiredFunction<RevokeCoreSession>("revokeCoreSession");
  const establish = (session: CoreSession, now = createdAt, subject = verifiedPasswordSubject()) => (
    establishRecentReauthentication({ db: identityDb, databaseNow: async () => new Date(now) }, {
      actorId: session.actor_id,
      authSubjectId: session.auth_subject_id,
      sessionId: session.session_id,
      verifiedPasswordSubject: subject,
    })
  );

  const revoked = await issue("session_establish_revoked");
  await revokeCoreSession(dependencies(), {
    actorId: revoked.session.actor_id,
    sessionId: revoked.session.session_id,
    reason: "user_sign_out",
  });
  await assert.rejects(establish(revoked.session), (error: unknown) => (
    error instanceof DomainError && error.code === "UNAUTHENTICATED"
  ));

  const expired = await issue("session_establish_expired");
  await assert.rejects(
    establish(expired.session, new Date(createdAt.getTime() + 7 * dayMs)),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );

  const disabled = await issue("session_establish_disabled");
  await identityDb.updateTable("actors").set({ status: "disabled" })
    .where("actor_id", "=", disabled.session.actor_id).execute();
  await assert.rejects(establish(disabled.session), (error: unknown) => (
    error instanceof DomainError && error.code === "UNAUTHENTICATED"
  ));
  await identityDb.updateTable("actors").set({ status: "active" })
    .where("actor_id", "=", disabled.session.actor_id).execute();

  const unlinked = await issue("session_establish_unlinked");
  await identityDb.updateTable("auth_subjects").set({ status: "unlinked" })
    .where("auth_subject_id", "=", unlinked.session.auth_subject_id).execute();
  await assert.rejects(establish(unlinked.session), (error: unknown) => (
    error instanceof DomainError && error.code === "UNAUTHENTICATED"
  ));
  await identityDb.updateTable("auth_subjects").set({ status: "active" })
    .where("auth_subject_id", "=", unlinked.session.auth_subject_id).execute();

  const mismatched = await issue("session_establish_mismatched");
  await assert.rejects(establish(mismatched.session, createdAt, {
    ...verifiedPasswordSubject(),
    providerSubject: "provider-subject_other",
  }), (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED");
});

test("protected reauthenticated mutations serialize behind disable unlink and revoke before checking current authority", async () => {
  const establishRecentReauthentication = requiredFunction<EstablishRecentReauthentication>(
    "establishRecentReauthentication",
  );
  const requireRecentReauthentication = requiredFunction<RequireRecentReauthentication>(
    "requireRecentReauthentication",
  );
  const scenarios = ["disable", "unlink", "revoke"] as const;
  for (const scenario of scenarios) {
    const issued = await issue(`session_guard_behind_${scenario}`);
    await establishRecentReauthentication({ db: identityDb, databaseNow: async () => new Date(createdAt) }, {
      actorId: issued.session.actor_id,
      authSubjectId: issued.session.auth_subject_id,
      sessionId: issued.session.session_id,
      verifiedPasswordSubject: verifiedPasswordSubject(),
    });

    const managementReady = deferred<void>();
    const releaseManagement = deferred<void>();
    const management = identityDb.transaction().execute(async (trx) => {
      await trx.selectFrom("actors").select("actor_id")
        .where("actor_id", "=", issued.session.actor_id).forUpdate().executeTakeFirstOrThrow();
      if (scenario === "disable") {
        await trx.updateTable("actors").set({ status: "disabled" })
          .where("actor_id", "=", issued.session.actor_id).execute();
      } else if (scenario === "unlink") {
        await trx.selectFrom("auth_subjects").select("auth_subject_id")
          .where("auth_subject_id", "=", issued.session.auth_subject_id).forUpdate().executeTakeFirstOrThrow();
        await trx.updateTable("auth_subjects").set({ status: "unlinked" })
          .where("auth_subject_id", "=", issued.session.auth_subject_id).execute();
      } else {
        await trx.selectFrom("core_sessions").select("session_id")
          .where("session_id", "=", issued.session.session_id).forUpdate().executeTakeFirstOrThrow();
        await trx.updateTable("core_sessions").set({
          status: "revoked",
          revocation_reason: "administrator_revoked",
          resource_version: 3,
          updated_at: createdAt,
        }).where("session_id", "=", issued.session.session_id).execute();
      }
      managementReady.resolve();
      await releaseManagement.promise;
    });
    await managementReady.promise;
    let mutationCalls = 0;
    const protectedMutation = identityDb.transaction().execute(async (trx) => {
      await requireRecentReauthentication({
        trx,
        databaseNow: async () => new Date(createdAt),
      }, {
        actorId: issued.session.actor_id,
        authSubjectId: issued.session.auth_subject_id,
        sessionId: issued.session.session_id,
      });
      mutationCalls += 1;
      await trx.updateTable("core_sessions").set({ device_label: "protected mutation" })
        .where("session_id", "=", issued.session.session_id).execute();
    });
    try {
      await assertPending(protectedMutation);
    } finally {
      releaseManagement.resolve();
    }
    await management;
    await assert.rejects(protectedMutation, recentReauthenticationFailure);
    assert.equal(mutationCalls, 0, `${scenario} must commit before protected authority is evaluated`);

    if (scenario === "disable") {
      await identityDb.updateTable("actors").set({ status: "active" })
        .where("actor_id", "=", issued.session.actor_id).execute();
    } else if (scenario === "unlink") {
      await identityDb.updateTable("auth_subjects").set({ status: "active" })
        .where("auth_subject_id", "=", issued.session.auth_subject_id).execute();
    }
  }
});

test("transaction-scoped guard retains canonical locks through a real protected Session command", async () => {
  const establishRecentReauthentication = requiredFunction<EstablishRecentReauthentication>(
    "establishRecentReauthentication",
  );
  const requireRecentReauthentication = requiredFunction<RequireRecentReauthentication>(
    "requireRecentReauthentication",
  );
  const revokeCoreSessionInTransaction = requiredFunction<RevokeCoreSessionInTransaction>(
    "revokeCoreSessionInTransaction",
  );
  const revokeCoreSession = requiredFunction<RevokeCoreSession>("revokeCoreSession");

  for (const scenario of ["disable", "unlink", "revoke"] as const) {
    const current = await issue(`session_guard_current_${scenario}`);
    const target = await issue(`session_guard_target_${scenario}`);
    await establishRecentReauthentication({ db: identityDb, databaseNow: async () => new Date(createdAt) }, {
      actorId: current.session.actor_id,
      authSubjectId: current.session.auth_subject_id,
      sessionId: current.session.session_id,
      verifiedPasswordSubject: verifiedPasswordSubject(),
    });
    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    const protectedMutation = identityDb.transaction().execute(async (trx) => {
      await requireRecentReauthentication({
        trx,
        databaseNow: async () => new Date(createdAt),
      }, {
        actorId: current.session.actor_id,
        authSubjectId: current.session.auth_subject_id,
        sessionId: current.session.session_id,
      });
      const revoked = await revokeCoreSessionInTransaction({
        databaseNow: async () => new Date(createdAt),
      }, trx, {
        actorId: target.session.actor_id,
        sessionId: target.session.session_id,
        reason: "administrator_revoked",
      });
      mutationEntered.resolve();
      await releaseMutation.promise;
      return revoked.status;
    });
    await mutationEntered.promise;

    const management = scenario === "revoke"
      ? revokeCoreSession(dependencies(), {
        actorId: target.session.actor_id,
        sessionId: target.session.session_id,
        reason: "administrator_revoked",
      })
      : identityDb.transaction().execute(async (trx) => {
        await trx.selectFrom("actors").select("actor_id")
          .where("actor_id", "=", current.session.actor_id).forUpdate().executeTakeFirstOrThrow();
        if (scenario === "disable") {
          await trx.updateTable("actors").set({ status: "disabled" })
            .where("actor_id", "=", current.session.actor_id).execute();
        } else {
          await trx.selectFrom("auth_subjects").select("auth_subject_id")
            .where("auth_subject_id", "=", current.session.auth_subject_id).forUpdate().executeTakeFirstOrThrow();
          await trx.updateTable("auth_subjects").set({ status: "unlinked" })
            .where("auth_subject_id", "=", current.session.auth_subject_id).execute();
        }
      });
    try {
      await assertPending(management);
    } finally {
      releaseMutation.resolve();
    }
    assert.equal(await protectedMutation, "revoked");
    await management;
    const row = await administratorPool.query<{ status: string }>(
      "select status from core_sessions where session_id = $1",
      [target.session.session_id],
    );
    assert.equal(row.rows[0]?.status, "revoked");

    if (scenario === "disable") {
      await identityDb.updateTable("actors").set({ status: "active" })
        .where("actor_id", "=", current.session.actor_id).execute();
    } else if (scenario === "unlink") {
      await identityDb.updateTable("auth_subjects").set({ status: "active" })
        .where("auth_subject_id", "=", current.session.auth_subject_id).execute();
    }
  }
});
