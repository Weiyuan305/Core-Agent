import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely, Transaction } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const db = createRuntimeDatabase(pool);
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const dayMs = 24 * 60 * 60 * 1_000;

interface CommandContext {
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly traceId: string;
}

interface DeletionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly entitlementRevocation: {
    revokeInTransaction(input: {
      readonly trx: Transaction<RuntimeDatabase>;
      readonly actorId: string;
      readonly accountDeletionId: string;
    }): Promise<void>;
  };
  readonly runtimeStopIntent: {
    stopInTransaction(input: {
      readonly trx: Transaction<RuntimeDatabase>;
      readonly tenantId: string;
      readonly accountDeletionId: string;
      readonly now: Date;
    }): Promise<void>;
  };
}

type RequestDeletion = (
  dependencies: DeletionDependencies,
  context: CommandContext,
  input: Record<string, unknown>,
) => Promise<{ schema_version: 1; account_deletion_id: string; status: "deletion_pending"; scheduled_for: string; resource_version: number }>;
type CancelDeletion = (
  dependencies: Pick<DeletionDependencies, "db"> & { readonly databaseNow?: () => Promise<Date> },
  context: CommandContext,
  input: Record<string, unknown>,
) => Promise<{ schema_version: 1; account_deletion_id: string; status: "cancelled"; resource_version: number }>;
type FinalizeDeletion = (
  dependencies: Pick<DeletionDependencies, "db"> & { readonly databaseNow?: () => Promise<Date> },
  input: { readonly accountDeletionId: string },
) => Promise<{ kind: "deleted" | "already_terminal" | "not_due" }>;
type LoadDeletionFinalization = (
  db: Kysely<RuntimeDatabase>,
  accountDeletionId: string,
  cursor?: string | null,
  limit?: number,
) => Promise<{
  kind: "due" | "not_due" | "cancelled" | "deleted" | "not_found";
  providerSubjects: readonly string[];
  nextCursor: string | null;
  done: boolean;
}>;
type AuthenticateRecovery = (
  dependencies: Pick<DeletionDependencies, "db">,
  input: { readonly sessionSecret: string; readonly csrfSecret?: string; readonly requireCsrf?: boolean },
) => Promise<{ actorId: string; authSubjectId: string; actorResourceVersion: number; session: { resource_version: number } }>;
type EstablishRecoveryReauthentication = (
  dependencies: Pick<DeletionDependencies, "db">,
  input: {
    readonly actorId: string; readonly authSubjectId: string; readonly sessionId: string;
    readonly expectedResourceVersion: number;
    readonly verifiedPasswordSubject: {
      readonly provider: "supabase"; readonly providerSubject: string;
      readonly identityKind: "email_password"; readonly normalizedEmail: string; readonly verifiedAt: string;
    };
  },
) => Promise<{ schema_version: 1; reauthenticated_at: string; valid_until: string; session_resource_version: number }>;

const sessionSecret = Buffer.alloc(32, 0x22).toString("base64url");
const csrfSecret = Buffer.alloc(32, 0x23).toString("base64url");

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

const context: CommandContext = Object.freeze({
  actorId: "actor_deletion",
  authSubjectId: "subject_deletion",
  sessionId: "session_deletion",
  requestId: "request_deletion",
  traceId: "trace_deletion",
});

function command<T extends Record<string, unknown>>(facts: T): T & { payload_hash: string } {
  return { ...facts, payload_hash: canonicalPayloadHash(facts) };
}

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public");
  await applyMigrations(pool, migrations);
}

async function ensureIdentityRoles(): Promise<void> {
  await pool.query(`do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then
        create role core_agent_app nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then
        create role core_agent_identity nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
    end
  $$`);
}

async function seedDeletionAuthority(mode: "b2c" | "b2b" = "b2c"): Promise<void> {
  const now = new Date();
  await db.insertInto("tenants").values({
    tenant_id: "tenant_deletion", schema_version: 1, resource_version: 1,
    tenant_mode: mode, status: "active", display_name: mode === "b2b" ? "Retained Company" : "Deletion Tenant",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("actors").values({
    actor_id: context.actorId, schema_version: 1, resource_version: 1,
    actor_kind: "human", display_name: "Deletion Person", status: "active",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("memberships").values({
    tenant_id: "tenant_deletion", membership_id: "membership_deletion", actor_id: context.actorId,
    schema_version: 1, resource_version: 1,
    roles: mode === "b2b" ? ["consultant"] : ["student"], membership_source: mode === "b2b" ? "company" : "self",
    seat_ref: null, status: "active", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("profiles").values({
    tenant_id: "tenant_deletion", profile_id: "profile_deletion", schema_version: 1,
    resource_version: 1, owner_actor_id: context.actorId, profile_kind: mode === "b2b" ? "consultant" : "default",
    hermes_profile_ref: "hermes_profile_deletion", description: "retained personal resource",
    status: "active", provider_config_id: "provider_deletion", model_id: "model_deletion",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("auth_subjects").values({
    auth_subject_id: context.authSubjectId, actor_id: context.actorId, provider: "supabase",
    provider_subject: "provider-subject-deletion", provider_identity_kind: "email_password",
    verified_at: now, status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("private_identity_pii").values({
    actor_id: context.actorId, normalized_email_hmac: Buffer.alloc(32, 0x11),
    encrypted_email: Buffer.from("encrypted-email"), encryption_key_ref: "identity_pii_key",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("core_sessions").values({
    session_id: context.sessionId,
    secret_digest: createHash("sha256").update(Buffer.from(sessionSecret, "base64url")).digest(),
    csrf_digest: createHash("sha256").update(Buffer.from(csrfSecret, "base64url")).digest(),
    actor_id: context.actorId, auth_subject_id: context.authSubjectId, client_kind: "web", status: "active",
    device_label: "Deletion Browser", created_at: now, last_seen_at: now,
    idle_expires_at: new Date(now.getTime() + dayMs), absolute_expires_at: new Date(now.getTime() + 2 * dayMs),
    reauthenticated_at: now, revocation_reason: null, resource_version: 1, updated_at: now,
  }).execute();
  await db.insertInto("oauth_transactions").values({
    oauth_transaction_id: "oauth_deletion_apple_link", provider: "supabase", flow_kind: "apple_link",
    actor_id: context.actorId, client_kind: "web", state_digest: Buffer.alloc(32, 0x31),
    nonce_digest: Buffer.alloc(32, 0x32), pkce_verifier_ciphertext: Buffer.alloc(33, 0x33),
    redirect_uri: "https://app.example.test/auth/apple/callback", status: "pending",
    expires_at: new Date(now.getTime() + dayMs), consumed_at: null,
    provider_completion_status: "provider_completed", provider_completion_started_at: now,
    expected_provider_subject_ciphertext: null, provider_subject_ciphertext: Buffer.alloc(33, 0x34),
    provider_completion_payload_hash: `sha256:${"3".repeat(64)}`,
    provider_settlement_expires_at: new Date(now.getTime() + dayMs + 30 * 60_000),
    provider_completed_at: now, provider_evidence_at: now, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("runtime_containers").values({
    tenant_id: "tenant_deletion", container_id: "runtime_deletion", schema_version: 1,
    resource_version: 1, command_version: 1, runtime_kind: "hermes", desired_state: "running",
    observed_state: "ready", image_ref: `hermes@sha256:${"d".repeat(64)}`, runtime_platform: "linux/arm64",
    generation: 1, volume_ref: "volume_must_be_retained", health_status: "healthy",
    last_probed_at: now, failure_summary: null, created_at: now, updated_at: now,
  }).execute();
}

function requestInput(idempotencyKey = "delete-account-once") {
  return command({
    schema_version: 1, idempotency_key: idempotencyKey,
    expected_resource_version: 1, reason_code: "user_requested",
  });
}

function deletionDependencies(calls: string[]): DeletionDependencies {
  return {
    db,
    entitlementRevocation: {
      async revokeInTransaction(input) {
        calls.push(`entitlement:${input.actorId}:${input.accountDeletionId}`);
      },
    },
    runtimeStopIntent: {
      async stopInTransaction(input) {
        calls.push(`runtime:${input.tenantId}:${input.accountDeletionId}`);
        await input.trx.updateTable("runtime_containers").set({
          desired_state: "stopped", resource_version: 2, command_version: 2, updated_at: input.now,
        }).where("tenant_id", "=", input.tenantId).where("container_id", "=", "runtime_deletion").execute();
      },
    },
  };
}

test.before(ensureIdentityRoles);

test.beforeEach(async () => {
  await resetDatabase();
  await seedDeletionAuthority();
});

test.after(async () => {
  await db.destroy();
});

test("deletion request is one serializable Actor-first transition with exact database deadline and immediate authority revocation", async () => {
  const requestAccountDeletion = requiredFunction<RequestDeletion>("requestAccountDeletion");
  const calls: string[] = [];
  let accessorCalls = 0;
  const accessorInput = Object.defineProperty({
    schema_version: 1, idempotency_key: "delete-accessor", expected_resource_version: 1,
    reason_code: "user_requested",
  }, "payload_hash", { enumerable: true, get() { accessorCalls += 1; return "not-read"; } });
  await assert.rejects(requestAccountDeletion(deletionDependencies(calls), context, accessorInput),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST");
  assert.equal(accessorCalls, 0);
  const trapped = new Proxy(requestInput("delete-proxy"), {
    get() { throw new Error("request get trap must not run"); },
    getPrototypeOf() { throw new Error("request prototype trap must not run"); },
    ownKeys() { throw new Error("request ownKeys trap must not run"); },
    getOwnPropertyDescriptor() { throw new Error("request descriptor trap must not run"); },
  });
  await assert.rejects(requestAccountDeletion(deletionDependencies(calls), context, trapped),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST");
  const before = Date.now();
  const response = await requestAccountDeletion(deletionDependencies(calls), context, requestInput());
  const after = Date.now();
  const replay = await requestAccountDeletion(deletionDependencies(calls), context, requestInput());
  await assert.rejects(requestAccountDeletion(deletionDependencies(calls), {
    ...context, authSubjectId: "subject_other", sessionId: "session_other",
  }, requestInput()), (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED");

  assert.equal(response.status, "deletion_pending");
  assert.deepEqual(replay, response);
  const scheduled = Date.parse(response.scheduled_for);
  assert.equal(scheduled >= before + 30 * dayMs && scheduled <= after + 30 * dayMs, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /^entitlement:actor_deletion:account_deletion_/u);
  assert.match(calls[1]!, /^runtime:tenant_deletion:account_deletion_/u);

  const actor = await db.selectFrom("actors").select(["status", "resource_version"]).executeTakeFirstOrThrow();
  const membership = await db.selectFrom("memberships").select(["status", "resource_version"]).executeTakeFirstOrThrow();
  const session = await db.selectFrom("core_sessions").select(["status", "revocation_reason"]).executeTakeFirstOrThrow();
  const runtimeRow = await db.selectFrom("runtime_containers").select(["desired_state", "volume_ref"]).executeTakeFirstOrThrow();
  assert.deepEqual({ status: actor.status, version: Number(actor.resource_version) }, { status: "deletion_pending", version: 2 });
  assert.deepEqual({ status: membership.status, version: Number(membership.resource_version) }, { status: "revoked", version: 2 });
  assert.deepEqual(session, { status: "revoked", revocation_reason: "account_deletion_requested" });
  assert.deepEqual(runtimeRow, { desired_state: "stopped", volume_ref: "volume_must_be_retained" });

  assert.equal((await db.selectFrom("account_deletions").select("account_deletion_id").execute()).length, 1);
  assert.equal((await db.selectFrom("worker_jobs").select("job_id").where("job_kind", "=", "finalize_account_deletion").execute()).length, 1);
  assert.equal((await db.selectFrom("product_events").select("event_id").where("event_type", "=", "account.deletion_requested").execute()).length, 1);
  assert.equal((await db.selectFrom("outbox").select("outbox_id").execute()).length, 1);
  assert.equal((await db.selectFrom("audit_events").select("audit_event_id").where("action", "=", "identity.account-deletion.request").execute()).length, 1);
  const durableArtifacts = JSON.stringify({
    events: await db.selectFrom("product_events").selectAll().execute(),
    audits: await db.selectFrom("audit_events").selectAll().execute(),
    outbox: await db.selectFrom("outbox").selectAll().execute(),
    jobs: await db.selectFrom("worker_jobs").selectAll().execute(),
  });
  assert.doesNotMatch(durableArtifacts, /provider-subject-deletion|deletion@example|encrypted-email/u);
});

test("cancellation requires the exact provider identity and recent deletion-revoked Session, restores only captured authority, and excludes the deadline", async () => {
  const requestAccountDeletion = requiredFunction<RequestDeletion>("requestAccountDeletion");
  const cancelAccountDeletion = requiredFunction<CancelDeletion>("cancelAccountDeletion");
  const authenticateRecovery = requiredFunction<AuthenticateRecovery>("authenticateAccountDeletionRecoverySession");
  const establishRecovery = requiredFunction<EstablishRecoveryReauthentication>("establishAccountDeletionRecoveryReauthentication");
  const response = await requestAccountDeletion(deletionDependencies([]), context, requestInput());
  const cancelFacts = {
    schema_version: 1, idempotency_key: "cancel-account-once", expected_resource_version: 1,
    account_deletion_id: response.account_deletion_id,
  };
  await assert.rejects(
    cancelAccountDeletion({ db }, context, command(cancelFacts)),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );
  await assert.rejects(
    authenticateRecovery({ db }, { sessionSecret: "x".repeat(43), csrfSecret, requireCsrf: true }),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );
  const recovery = await authenticateRecovery({ db }, { sessionSecret, csrfSecret, requireCsrf: true });
  assert.deepEqual({ actorId: recovery.actorId, authSubjectId: recovery.authSubjectId }, {
    actorId: context.actorId, authSubjectId: context.authSubjectId,
  });
  await assert.rejects(establishRecovery({ db }, {
    actorId: recovery.actorId, authSubjectId: recovery.authSubjectId, sessionId: context.sessionId,
    expectedResourceVersion: 1,
    verifiedPasswordSubject: {
      provider: "supabase", providerSubject: "different-provider-subject", identityKind: "email_password",
      normalizedEmail: "deletion@example.test", verifiedAt: new Date().toISOString(),
    },
  }), (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED");
  const reauthenticated = await establishRecovery({ db }, {
    actorId: recovery.actorId, authSubjectId: recovery.authSubjectId, sessionId: context.sessionId,
    expectedResourceVersion: 1,
    verifiedPasswordSubject: {
      provider: "supabase", providerSubject: "provider-subject-deletion", identityKind: "email_password",
      normalizedEmail: "deletion@example.test", verifiedAt: new Date().toISOString(),
    },
  });
  assert.equal(reauthenticated.session_resource_version, recovery.session.resource_version + 1);
  const cancelled = await cancelAccountDeletion({ db }, context, command(cancelFacts));
  assert.deepEqual(cancelled, {
    schema_version: 1, account_deletion_id: response.account_deletion_id, status: "cancelled", resource_version: 2,
  });
  assert.deepEqual(await cancelAccountDeletion({ db }, context, command(cancelFacts)), cancelled);
  await db.updateTable("core_sessions").set({ reauthenticated_at: new Date(0) })
    .where("session_id", "=", context.sessionId).execute();
  await db.updateTable("account_deletions").set({ scheduled_for: new Date(0) })
    .where("account_deletion_id", "=", response.account_deletion_id).execute();
  assert.deepEqual(await cancelAccountDeletion({ db }, context, command(cancelFacts)), cancelled,
    "a committed cancellation must replay after its former recovery deadline and reauthentication window");
  assert.equal((await db.selectFrom("actors").select("status").executeTakeFirstOrThrow()).status, "active");
  assert.equal((await db.selectFrom("memberships").select("status").executeTakeFirstOrThrow()).status, "active");
  assert.equal((await db.selectFrom("core_sessions").select("status").executeTakeFirstOrThrow()).status, "revoked");
  assert.equal((await db.selectFrom("runtime_containers").select("desired_state").executeTakeFirstOrThrow()).desired_state, "stopped");

  await resetDatabase();
  await seedDeletionAuthority();
  const boundary = await requestAccountDeletion(deletionDependencies([]), context, requestInput("delete-at-boundary"));
  const deadline = new Date();
  await db.updateTable("account_deletions").set({ scheduled_for: deadline })
    .where("account_deletion_id", "=", boundary.account_deletion_id).execute();
  await db.updateTable("core_sessions").set({ reauthenticated_at: deadline })
    .where("session_id", "=", context.sessionId).execute();
  await assert.rejects(cancelAccountDeletion({ db }, context, command({
    ...cancelFacts, idempotency_key: "cancel-at-boundary", account_deletion_id: boundary.account_deletion_id,
  })), (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATE_TRANSITION");
});

test("cancellation and finalization retain Actor-first lock order at the exclusive deadline", async () => {
  const requestAccountDeletion = requiredFunction<RequestDeletion>("requestAccountDeletion");
  const cancelAccountDeletion = requiredFunction<CancelDeletion>("cancelAccountDeletion");
  const finalizeAccountDeletion = requiredFunction<FinalizeDeletion>("finalizeAccountDeletion");
  const requested = await requestAccountDeletion(deletionDependencies([]), context, requestInput("delete-lock-order"));
  const deadline = new Date("2035-01-31T00:00:00.000Z");
  const cancellationNow = new Date(deadline.getTime() - 1);
  const finalizationNow = new Date(deadline);
  await db.updateTable("account_deletions").set({ scheduled_for: deadline })
    .where("account_deletion_id", "=", requested.account_deletion_id).execute();
  await db.updateTable("core_sessions").set({ reauthenticated_at: cancellationNow })
    .where("session_id", "=", context.sessionId).execute();

  let signalCancellationClock!: () => void;
  let releaseCancellationClock!: () => void;
  const cancellationClockReached = new Promise<void>((resolve) => { signalCancellationClock = resolve; });
  const cancellationClockRelease = new Promise<void>((resolve) => { releaseCancellationClock = resolve; });
  const cancellationFacts = {
    schema_version: 1, idempotency_key: "cancel-lock-order", expected_resource_version: 1,
    account_deletion_id: requested.account_deletion_id,
  };
  const cancellation = cancelAccountDeletion({
    db,
    async databaseNow() {
      signalCancellationClock();
      await cancellationClockRelease;
      return cancellationNow;
    },
  }, context, command(cancellationFacts));
  await cancellationClockReached;

  const finalizerApplicationName = "task9_finalizer_lock_order";
  const finalizerUrl = new URL(databaseUrl);
  finalizerUrl.searchParams.set("application_name", finalizerApplicationName);
  const finalizerDb = createRuntimeDatabase(new Pool({ connectionString: finalizerUrl.toString(), max: 1 }));
  const finalization = finalizeAccountDeletion({
    db: finalizerDb,
    async databaseNow() { return finalizationNow; },
  }, { accountDeletionId: requested.account_deletion_id });
  try {
    let finalizerBlocked = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await pool.query<{ wait_event_type: string | null }>(
        "select wait_event_type from pg_stat_activity where application_name = $1",
        [finalizerApplicationName],
      );
      if (activity.rows[0]?.wait_event_type === "Lock") {
        finalizerBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finalizerBlocked, true, "finalizer must wait behind the Actor lock");
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom("account_deletions").select("account_deletion_id")
        .where("account_deletion_id", "=", requested.account_deletion_id)
        .forUpdate().noWait().executeTakeFirstOrThrow();
    });
  } finally {
    releaseCancellationClock();
  }
  assert.equal((await cancellation).status, "cancelled");
  assert.equal((await finalization).kind, "already_terminal");
  await finalizerDb.destroy();
});

test("finalization erases authentication PII atomically and pseudonymizes retained business references without deleting company or Volume data", async () => {
  await resetDatabase();
  await seedDeletionAuthority("b2b");
  const requestAccountDeletion = requiredFunction<RequestDeletion>("requestAccountDeletion");
  const finalizeAccountDeletion = requiredFunction<FinalizeDeletion>("finalizeAccountDeletion");
  const loadAccountDeletionFinalization = requiredFunction<LoadDeletionFinalization>("loadAccountDeletionFinalization");
  const response = await requestAccountDeletion(deletionDependencies([]), context, requestInput());
  const now = new Date();
  await db.insertInto("auth_subjects").values(Array.from({ length: 51 }, (_, index) => ({
    auth_subject_id: `subject_deletion_${String(index).padStart(3, "0")}`,
    actor_id: context.actorId,
    provider: "supabase" as const,
    provider_subject: `provider-subject-${String(index).padStart(3, "0")}`,
    provider_identity_kind: "apple" as const,
    verified_at: now,
    status: "active" as const,
    resource_version: 1,
    created_at: now,
    updated_at: now,
  }))).execute();
  await db.updateTable("account_deletions").set({ scheduled_for: new Date(Date.now() - 1_000) })
    .where("account_deletion_id", "=", response.account_deletion_id).execute();

  const firstPage = await loadAccountDeletionFinalization(db, response.account_deletion_id);
  assert.deepEqual(firstPage, {
    kind: "due",
    providerSubjects: Array.from({ length: 50 }, (_, index) => `provider-subject-${String(index).padStart(3, "0")}`),
    nextCursor: "provider-subject-049",
    done: false,
  });
  const secondPage = await loadAccountDeletionFinalization(db, response.account_deletion_id, firstPage.nextCursor);
  assert.deepEqual(secondPage, {
    kind: "due",
    providerSubjects: ["provider-subject-050", "provider-subject-deletion"],
    nextCursor: null,
    done: true,
  });

  const first = await finalizeAccountDeletion({ db }, { accountDeletionId: response.account_deletion_id });
  assert.equal(first.kind, "deleted");
  const replay = await finalizeAccountDeletion({ db }, { accountDeletionId: response.account_deletion_id });
  assert.deepEqual(replay, { kind: "already_terminal" });

  const actor = await db.selectFrom("actors").select(["status", "display_name"]).executeTakeFirstOrThrow();
  assert.equal(actor.status, "deleted");
  assert.match(actor.display_name!, /^Deleted account [a-f0-9]{16}$/u);
  assert.equal((await db.selectFrom("core_sessions").select("session_id").execute()).length, 0);
  assert.equal((await db.selectFrom("auth_subjects").select("auth_subject_id").execute()).length, 0);
  assert.equal((await db.selectFrom("private_identity_pii").select("actor_id").execute()).length, 0);
  const oauth = await db.selectFrom("oauth_transactions").select([
    "actor_id", "status", "pkce_verifier_ciphertext", "provider_completion_status",
    "provider_subject_ciphertext", "provider_completion_payload_hash",
  ]).executeTakeFirstOrThrow();
  assert.deepEqual({
    actorId: oauth.actor_id,
    status: oauth.status,
    pkceBytes: oauth.pkce_verifier_ciphertext.length,
    completionStatus: oauth.provider_completion_status,
    providerSubjectCiphertext: oauth.provider_subject_ciphertext,
    completionPayloadHash: oauth.provider_completion_payload_hash,
  }, {
    actorId: null,
    status: "expired",
    pkceBytes: 1,
    completionStatus: "pending",
    providerSubjectCiphertext: null,
    completionPayloadHash: null,
  });
  assert.equal((await db.selectFrom("tenants").select("tenant_id").execute()).length, 1);
  assert.equal((await db.selectFrom("memberships").select("membership_id").execute()).length, 1);
  assert.equal((await db.selectFrom("profiles").select("profile_id").execute()).length, 1);
  assert.equal((await db.selectFrom("runtime_containers").select("volume_ref").executeTakeFirstOrThrow()).volume_ref, "volume_must_be_retained");
  assert.equal((await db.selectFrom("account_deletions").select("status").executeTakeFirstOrThrow()).status, "deleted");
  assert.equal((await db.selectFrom("product_events").select("event_id").where("event_type", "=", "account.deleted").execute()).length, 1);
});

test("finalization rolls back Session AuthSubject PII and Actor state together when a database boundary fails", async () => {
  const requestAccountDeletion = requiredFunction<RequestDeletion>("requestAccountDeletion");
  const finalizeAccountDeletion = requiredFunction<FinalizeDeletion>("finalizeAccountDeletion");
  const response = await requestAccountDeletion(deletionDependencies([]), context, requestInput());
  await db.updateTable("account_deletions").set({ scheduled_for: new Date(Date.now() - 1_000) })
    .where("account_deletion_id", "=", response.account_deletion_id).execute();
  await pool.query(`create function fail_task9_auth_subject_delete() returns trigger language plpgsql as $$
    begin raise exception 'synthetic Task9 finalization failure'; end $$`);
  await pool.query(`create trigger fail_task9_auth_subject_delete before delete on auth_subjects
    for each row execute function fail_task9_auth_subject_delete()`);
  try {
    await assert.rejects(
      finalizeAccountDeletion({ db }, { accountDeletionId: response.account_deletion_id }),
      /synthetic Task9 finalization failure/u,
    );
    assert.equal((await db.selectFrom("actors").select("status").executeTakeFirstOrThrow()).status, "deletion_pending");
    assert.equal((await db.selectFrom("core_sessions").select("status").executeTakeFirstOrThrow()).status, "revoked");
    assert.equal((await db.selectFrom("auth_subjects").select("auth_subject_id").execute()).length, 1);
    assert.equal((await db.selectFrom("private_identity_pii").select("actor_id").execute()).length, 1);
    const oauth = await db.selectFrom("oauth_transactions")
      .select(["actor_id", "pkce_verifier_ciphertext", "provider_subject_ciphertext"])
      .executeTakeFirstOrThrow();
    assert.equal(oauth.actor_id, context.actorId);
    assert.equal(oauth.pkce_verifier_ciphertext.length, 33);
    assert.equal(oauth.provider_subject_ciphertext?.length, 33);
    assert.equal((await db.selectFrom("account_deletions").select("status").executeTakeFirstOrThrow()).status, "deletion_pending");
    assert.equal((await db.selectFrom("product_events").select("event_id").where("event_type", "=", "account.deleted").execute()).length, 0);
  } finally {
    await pool.query("drop trigger if exists fail_task9_auth_subject_delete on auth_subjects");
    await pool.query("drop function if exists fail_task9_auth_subject_delete() cascade");
  }
});

test("request rollback covers every deletion side effect when a companion transaction port fails", async () => {
  const requestAccountDeletion = requiredFunction<RequestDeletion>("requestAccountDeletion");
  const base = deletionDependencies([]);
  const dependencies: DeletionDependencies = {
    ...base,
    entitlementRevocation: {
      async revokeInTransaction() { throw new Error("synthetic entitlement failure"); },
    },
  };
  await assert.rejects(requestAccountDeletion(dependencies, context, requestInput()), /synthetic entitlement failure/u);
  assert.equal((await db.selectFrom("actors").select("status").executeTakeFirstOrThrow()).status, "active");
  assert.equal((await db.selectFrom("memberships").select("status").executeTakeFirstOrThrow()).status, "active");
  assert.equal((await db.selectFrom("core_sessions").select("status").executeTakeFirstOrThrow()).status, "active");
  assert.equal((await db.selectFrom("account_deletions").select("account_deletion_id").execute()).length, 0);
  assert.equal((await db.selectFrom("worker_jobs").select("job_id").execute()).length, 0);
  assert.equal((await db.selectFrom("product_events").select("event_id").execute()).length, 0);
  assert.equal((await db.selectFrom("audit_events").select("audit_event_id").execute()).length, 0);
});
