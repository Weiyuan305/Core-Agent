import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { CoreSession } from "@core-agent/contracts";
import type { Kysely, Transaction } from "kysely";
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
type RequireRecentReauthentication = (
  context: {
    readonly trx: Transaction<RuntimeDatabase>;
    readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
  },
  input: { readonly actorId: string; readonly sessionId: string },
) => Promise<void>;

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
  await identityDb.transaction().execute((trx) => {
    const context = {
      trx,
      // Legacy-shaped extras prove the implementation cannot trust a caller snapshot.
      db: identityDb,
      databaseNow: async (clockTrx: Transaction<RuntimeDatabase>) => {
        assert.strictEqual(clockTrx, trx);
        return new Date(now);
      },
    };
    const input = {
      ...session,
      actorId: session.actor_id,
      sessionId: session.session_id,
    };
    return requireRecentReauthentication(context, input);
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
  const issueOpaqueCoreSessionCredential = requiredFunction<
    (randomSource: (size: number) => Buffer) => OwnedOpaqueCredential
  >("issueOpaqueCoreSessionCredential");
  const retainedCredentialBuffer = Buffer.alloc(32, 0x45);
  const credential = issueOpaqueCoreSessionCredential(() => retainedCredentialBuffer);
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

test("recent reauthentication is accepted at 9:59 and rejected at 10:00 or later", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const issued = await issue("session_reauthentication");
  await identityDb.updateTable("core_sessions").set({ reauthenticated_at: createdAt })
    .where("session_id", "=", issued.session.session_id).execute();
  const authenticated = await authenticateCoreSession(
    dependencies(new Date(createdAt.getTime() + 9 * 60_000 + 59_000)),
    { sessionSecret: issued.sessionSecret },
  );
  await assert.doesNotReject(requireRecentAt(
    authenticated.session,
    new Date(createdAt.getTime() + 9 * 60_000 + 59_000),
  ));
  await assert.rejects(
    requireRecentAt(
      authenticated.session,
      new Date(createdAt.getTime() + 10 * 60_000),
    ),
    recentReauthenticationFailure,
  );
});

test("recent reauthentication rejects stale snapshots after durable revoke expiry or timestamp change", async () => {
  const authenticateCoreSession = requiredFunction<AuthenticateCoreSession>("authenticateCoreSession");
  const revokeCoreSession = requiredFunction<RevokeCoreSession>("revokeCoreSession");
  const checkAt = new Date(createdAt.getTime() + 9 * 60_000 + 59_000);

  const revoked = await issue("session_stale_reauthentication_revoked");
  await identityDb.updateTable("core_sessions").set({ reauthenticated_at: createdAt })
    .where("session_id", "=", revoked.session.session_id).execute();
  const revokedSnapshot = await authenticateCoreSession(dependencies(checkAt), {
    sessionSecret: revoked.sessionSecret,
  });
  await revokeCoreSession(dependencies(checkAt), {
    actorId: revokedSnapshot.session.actor_id,
    sessionId: revokedSnapshot.session.session_id,
    reason: "user_sign_out",
  });
  await assert.rejects(
    requireRecentAt(revokedSnapshot.session, checkAt),
    recentReauthenticationFailure,
  );

  const expired = await issue("session_stale_reauthentication_expired");
  await identityDb.updateTable("core_sessions").set({ reauthenticated_at: createdAt })
    .where("session_id", "=", expired.session.session_id).execute();
  const expiredSnapshot = await authenticateCoreSession(dependencies(checkAt), {
    sessionSecret: expired.sessionSecret,
  });
  await identityDb.updateTable("core_sessions").set({ idle_expires_at: checkAt })
    .where("session_id", "=", expiredSnapshot.session.session_id).execute();
  await assert.rejects(
    requireRecentAt(expiredSnapshot.session, checkAt),
    recentReauthenticationFailure,
  );

  const changed = await issue("session_stale_reauthentication_changed");
  await identityDb.updateTable("core_sessions").set({ reauthenticated_at: createdAt })
    .where("session_id", "=", changed.session.session_id).execute();
  const changedSnapshot = await authenticateCoreSession(dependencies(checkAt), {
    sessionSecret: changed.sessionSecret,
  });
  await identityDb.updateTable("core_sessions").set({
    reauthenticated_at: new Date(createdAt.getTime() - 1_000),
  }).where("session_id", "=", changedSnapshot.session.session_id).execute();
  await assert.rejects(
    requireRecentAt(changedSnapshot.session, checkAt),
    recentReauthenticationFailure,
  );
});
