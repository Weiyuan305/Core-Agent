import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely, Transaction } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";
import { appendAuditEvent } from "../src/repositories/events.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

interface ReplaceAuthProviderSubjectCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly old_auth_subject_id: string;
  readonly expected_resource_version: number;
  readonly new_auth_subject: {
    readonly provider: "supabase";
    readonly provider_subject: string;
    readonly provider_identity_kind: "email_password" | "apple" | "email_password_apple";
    readonly verified_at: string;
  };
}

interface ReplacementResult {
  readonly schema_version: 1;
  readonly actor_id: string;
  readonly old_auth_subject_id: string;
  readonly new_auth_subject_id: string;
  readonly old_auth_subject_resource_version: number;
  readonly new_auth_subject_resource_version: 1;
  readonly revoked_session_count: number;
}

type ReplaceAuthProviderSubject = (
  dependencies: {
    readonly db: Kysely<RuntimeDatabase>;
    readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
  },
  context: { readonly requestId: string; readonly traceId: string },
  command: ReplaceAuthProviderSubjectCommand,
) => Promise<ReplacementResult>;

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const now = new Date("2026-08-20T05:00:00.000Z");

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public");
  await applyMigrations(pool, migrationsDirectory);
}

async function seedIdentity(options: { readonly secondActorSubject?: string } = {}): Promise<void> {
  await db.insertInto("tenants").values({
    tenant_id: "tenant_replace", schema_version: 1, resource_version: 1, tenant_mode: "b2c",
    status: "active", display_name: "Replacement tenant", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("actors").values({
    actor_id: "actor_replace", schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: "Replacement actor", status: "active", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("memberships").values({
    tenant_id: "tenant_replace", membership_id: "membership_replace", actor_id: "actor_replace",
    schema_version: 1, resource_version: 1, roles: ["student"], membership_source: "self",
    seat_ref: null, status: "active", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("profiles").values({
    tenant_id: "tenant_replace", profile_id: "profile_replace", schema_version: 1, resource_version: 1,
    owner_actor_id: "actor_replace", profile_kind: "default", hermes_profile_ref: "hermes_replace",
    description: "Replacement profile", status: "active", provider_config_id: "provider_replace",
    model_id: "model_replace", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("auth_subjects").values({
    auth_subject_id: "auth_subject_old", actor_id: "actor_replace", provider: "supabase",
    provider_subject: "provider-subject-old", provider_identity_kind: "email_password", verified_at: now,
    status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("private_identity_pii").values({
    actor_id: "actor_replace", normalized_email_hmac: Buffer.alloc(32, 0x11),
    encrypted_email: Buffer.from("opaque-private-email"), encryption_key_ref: "identity-key-v1",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("core_sessions").values([
    {
      session_id: "session_replace_web", secret_digest: Buffer.alloc(32, 0x21), csrf_digest: Buffer.alloc(32, 0x31),
      actor_id: "actor_replace", auth_subject_id: "auth_subject_old", client_kind: "web", status: "active",
      device_label: null, created_at: now, last_seen_at: now,
      idle_expires_at: new Date("2026-08-27T05:00:00.000Z"), absolute_expires_at: new Date("2026-09-19T05:00:00.000Z"),
      reauthenticated_at: now, revocation_reason: null, resource_version: 1, updated_at: now,
    },
    {
      session_id: "session_replace_native", secret_digest: Buffer.alloc(32, 0x22), csrf_digest: null,
      actor_id: "actor_replace", auth_subject_id: "auth_subject_old", client_kind: "iphone", status: "active",
      device_label: "phone", created_at: now, last_seen_at: now,
      idle_expires_at: new Date("2026-08-27T05:00:00.000Z"), absolute_expires_at: new Date("2026-09-19T05:00:00.000Z"),
      reauthenticated_at: null, revocation_reason: null, resource_version: 1, updated_at: now,
    },
  ]).execute();
  await db.insertInto("runtime_containers").values({
    tenant_id: "tenant_replace", container_id: "container_replace", schema_version: 1,
    resource_version: 1, command_version: 1, runtime_kind: "hermes", desired_state: "running",
    observed_state: "ready", image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`,
    runtime_platform: "linux/arm64", generation: 1, volume_ref: "volume_replace", health_status: "healthy",
    last_probed_at: now, failure_summary: null, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("conversations").values({
    tenant_id: "tenant_replace", conversation_id: "conversation_replace", profile_id: "profile_replace",
    created_by_actor_id: "actor_replace", status: "active", schema_version: 1, resource_version: 1,
    student_ref: null, case_ref: null, created_at: now, updated_at: now,
  }).execute();
  await db.transaction().execute(async (trx) => appendAuditEvent({ tenantId: "tenant_replace", trx }, {
    schema_version: 1,
    audit_event_id: "audit_replace_existing",
    occurred_at: now.toISOString(),
    tenant_id: "tenant_replace",
    actor_id: "actor_replace",
    membership_id: "membership_replace",
    effective_role: "student",
    action: "identity.session.authenticate",
    resource_type: "core_session",
    resource_id: "session_replace_web",
    decision: "allowed",
    outcome: "succeeded",
    request_id: "request_replace_existing",
    trace_id: "trace_replace_existing",
    reason_summary: "Existing authority evidence",
    entitlement_snapshot_ref: {
      snapshot_id: "snapshot_replace_existing",
      version: 7,
      evaluated_at: now.toISOString(),
    },
    resource_version: 1,
  }));
  if (options.secondActorSubject !== undefined) {
    await db.insertInto("actors").values({
      actor_id: "actor_other", schema_version: 1, resource_version: 1, actor_kind: "human",
      display_name: "Other actor", status: "active", created_at: now, updated_at: now,
    }).execute();
    await db.insertInto("auth_subjects").values({
      auth_subject_id: "auth_subject_other", actor_id: "actor_other", provider: "supabase",
      provider_subject: options.secondActorSubject, provider_identity_kind: "email_password", verified_at: now,
      status: "active", resource_version: 1, created_at: now, updated_at: now,
    }).execute();
  }
}

function command(overrides: Partial<ReplaceAuthProviderSubjectCommand> = {}): ReplaceAuthProviderSubjectCommand {
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "replace-provider-01",
    old_auth_subject_id: "auth_subject_old",
    expected_resource_version: 1,
    new_auth_subject: {
      provider: "supabase" as const,
      provider_subject: "provider-subject-new",
      provider_identity_kind: "email_password_apple" as const,
      verified_at: "2026-08-20T04:59:00.000Z",
    },
    ...overrides,
  };
  return { ...facts, payload_hash: overrides.payload_hash ?? canonicalPayloadHash(facts) };
}

const context = Object.freeze({ requestId: "request_replace", traceId: "trace_replace" });

async function replacementFacts(): Promise<Record<string, unknown>> {
  const [actors, memberships, profiles, conversations, runtimes, subjects, sessions, events, audits, outbox, idempotency] = await Promise.all([
    db.selectFrom("actors").select(["actor_id", "resource_version", "status"]).orderBy("actor_id").execute(),
    db.selectFrom("memberships").select(["tenant_id", "membership_id", "actor_id", "resource_version", "status"]).orderBy("membership_id").execute(),
    db.selectFrom("profiles").select(["tenant_id", "profile_id", "owner_actor_id", "resource_version", "status"]).orderBy("profile_id").execute(),
    db.selectFrom("conversations").select(["tenant_id", "conversation_id", "profile_id", "resource_version", "status"]).orderBy("conversation_id").execute(),
    db.selectFrom("runtime_containers").select(["tenant_id", "container_id", "resource_version", "observed_state"]).orderBy("container_id").execute(),
    db.selectFrom("auth_subjects").select(["auth_subject_id", "actor_id", "provider", "provider_subject", "provider_identity_kind", "status", "resource_version"]).orderBy("auth_subject_id").execute(),
    db.selectFrom("core_sessions").select(["session_id", "auth_subject_id", "status", "revocation_reason", "resource_version"]).orderBy("session_id").execute(),
    db.selectFrom("product_events").select(["tenant_id", "event_id", "event_type", "payload"]).orderBy("event_id").execute(),
    db.selectFrom("audit_events").select(["tenant_id", "audit_event_id", "actor_id", "membership_id", "action", "resource_id", "entitlement_snapshot_ref", "event_json"]).orderBy("audit_event_id").execute(),
    db.selectFrom("outbox").select(["tenant_id", "outbox_id", "event_id", "status"]).orderBy("outbox_id").execute(),
    db.selectFrom("idempotency_records").select(["tenant_id", "idempotency_key", "payload_hash", "operation", "status", "result_ref", "response_json"]).orderBy("idempotency_key").execute(),
  ]);
  return { actors, memberships, profiles, conversations, runtimes, subjects, sessions, events, audits, outbox, idempotency };
}

test.beforeEach(async () => {
  await resetDatabase();
  await seedIdentity();
});

test.after(async () => {
  await db.destroy();
});

test("provider replacement preserves business identifiers and atomically revokes old authority and every Core Session", async () => {
  const replaceAuthProviderSubject = requiredFunction<ReplaceAuthProviderSubject>("replaceAuthProviderSubject");
  const before = await replacementFacts();
  const result = await replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command());

  assert.equal(result.schema_version, 1);
  assert.equal(result.actor_id, "actor_replace");
  assert.equal(result.old_auth_subject_id, "auth_subject_old");
  assert.match(result.new_auth_subject_id, /^auth_subject_[a-f0-9]{32}$/u);
  assert.equal(result.old_auth_subject_resource_version, 2);
  assert.equal(result.new_auth_subject_resource_version, 1);
  assert.equal(result.revoked_session_count, 2);

  const after = await replacementFacts();
  for (const key of ["actors", "memberships", "profiles", "conversations", "runtimes"] as const) {
    assert.deepEqual(after[key], before[key], `${key} business authority must remain byte-for-byte stable`);
  }
  assert.deepEqual(after.subjects, [
    {
      auth_subject_id: result.new_auth_subject_id, actor_id: "actor_replace", provider: "supabase",
      provider_subject: "provider-subject-new", provider_identity_kind: "email_password_apple", status: "active", resource_version: "1",
    },
    {
      auth_subject_id: "auth_subject_old", actor_id: "actor_replace", provider: "supabase",
      provider_subject: "provider-subject-old", provider_identity_kind: "email_password", status: "revoked", resource_version: "2",
    },
  ]);
  assert.deepEqual(after.sessions, [
    { session_id: "session_replace_native", auth_subject_id: "auth_subject_old", status: "revoked", revocation_reason: "provider_replaced", resource_version: "2" },
    { session_id: "session_replace_web", auth_subject_id: "auth_subject_old", status: "revoked", revocation_reason: "provider_replaced", resource_version: "2" },
  ]);
  assert.equal((after.events as unknown[]).length, 1);
  assert.equal((after.audits as unknown[]).length, 2);
  assert.equal((after.outbox as unknown[]).length, 1);
  assert.equal((after.idempotency as unknown[]).length, 1);
  assert.deepEqual(
    (after.audits as readonly { readonly audit_event_id: string }[]).find((audit) => audit.audit_event_id === "audit_replace_existing"),
    (before.audits as readonly { readonly audit_event_id: string }[]).find((audit) => audit.audit_event_id === "audit_replace_existing"),
    "existing Audit resource ID and Entitlement snapshot reference must remain unchanged",
  );
  const publicEvidence = JSON.stringify({ result, events: after.events, audits: after.audits, outbox: after.outbox, idempotency: after.idempotency });
  assert.doesNotMatch(publicEvidence, /provider-subject-(?:old|new)|opaque-private-email|@/u);
});

test("provider replacement replays exactly and rejects a changed payload without duplicate durable effects", async () => {
  const replaceAuthProviderSubject = requiredFunction<ReplaceAuthProviderSubject>("replaceAuthProviderSubject");
  const first = await replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command());
  const replay = await replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command());
  assert.deepEqual(replay, first);
  const afterReplay = await replacementFacts();
  assert.equal((afterReplay.events as unknown[]).length, 1);
  assert.equal((afterReplay.audits as unknown[]).length, 2);
  assert.equal((afterReplay.outbox as unknown[]).length, 1);

  const changedFacts = command({
    new_auth_subject: {
      provider: "supabase", provider_subject: "provider-subject-changed",
      provider_identity_kind: "email_password", verified_at: "2026-08-20T04:59:00.000Z",
    },
  });
  await assert.rejects(
    replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, changedFacts),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(await replacementFacts(), afterReplay);
});

test("provider replacement rejects a provider-subject collision and rolls back every write", async () => {
  await resetDatabase();
  await seedIdentity({ secondActorSubject: "provider-subject-new" });
  const replaceAuthProviderSubject = requiredFunction<ReplaceAuthProviderSubject>("replaceAuthProviderSubject");
  const before = await replacementFacts();
  await assert.rejects(
    replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command()),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(await replacementFacts(), before);
});

test("provider replacement rejects stale version authority before mutation", async () => {
  const replaceAuthProviderSubject = requiredFunction<ReplaceAuthProviderSubject>("replaceAuthProviderSubject");
  const before = await replacementFacts();
  await assert.rejects(
    replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command({ expected_resource_version: 2 })),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  assert.deepEqual(await replacementFacts(), before);
});

test("concurrent identical provider replacement commands converge on one replacement graph", async () => {
  const replaceAuthProviderSubject = requiredFunction<ReplaceAuthProviderSubject>("replaceAuthProviderSubject");
  const results = await Promise.all([
    replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command()),
    replaceAuthProviderSubject({ db, databaseNow: async () => new Date(now) }, context, command()),
  ]);
  assert.deepEqual(results[1], results[0]);
  const facts = await replacementFacts();
  assert.equal((facts.subjects as unknown[]).length, 2);
  assert.equal((facts.events as unknown[]).length, 1);
  assert.equal((facts.audits as unknown[]).length, 2);
  assert.equal((facts.outbox as unknown[]).length, 1);
});
