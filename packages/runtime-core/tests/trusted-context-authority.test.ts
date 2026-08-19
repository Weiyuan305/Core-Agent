import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { SignedTrustedRequestContext } from "@core-agent/contracts";
import type { Kysely, Transaction } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

interface SnapshotAuthority {
  readonly snapshotRef: { readonly snapshot_id: string; readonly version: number; readonly evaluated_at: string };
  readonly capabilityIds: readonly string[];
  readonly current: boolean;
  readonly bootstrapOnly: boolean;
}
interface EntitlementSnapshotAuthorityPort {
  loadCurrentSnapshot(input: {
    readonly trx: Transaction<RuntimeDatabase>;
    readonly tenantId: string;
    readonly profileId: string;
    readonly membershipId: string;
    readonly actorId: string;
    readonly now: Date;
  }): Promise<SnapshotAuthority>;
}
type IssueTrustedContext = (dependencies: {
  readonly db: Kysely<RuntimeDatabase>;
  readonly signingKey: { readonly keyId: string; readonly privateKey: KeyObject };
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly entitlementSnapshotAuthority: EntitlementSnapshotAuthorityPort;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}, input: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly effectiveRole: "admin" | "consultant" | "student";
  readonly profileId: string;
  readonly containerId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly clientRequestId: string;
  readonly contextId: string;
  readonly ttlSeconds: number;
}) => Promise<SignedTrustedRequestContext>;

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const now = new Date("2026-08-19T02:00:00.000Z");

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public");
  await applyMigrations(pool, migrationsDirectory);
}

async function seedCurrentAuthority(): Promise<void> {
  await db.insertInto("tenants").values({
    tenant_id: "tenant_trusted", schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: "Trusted tenant", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("actors").values({
    actor_id: "actor_trusted", schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: "Trusted actor", status: "active", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("auth_subjects").values({
    auth_subject_id: "subject_trusted", actor_id: "actor_trusted", provider: "supabase",
    provider_subject: "provider_trusted", provider_identity_kind: "email_password", verified_at: now,
    status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("memberships").values({
    tenant_id: "tenant_trusted", membership_id: "membership_trusted", actor_id: "actor_trusted",
    schema_version: 1, resource_version: 1, roles: ["consultant"], membership_source: "company",
    seat_ref: null, status: "active", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("profiles").values({
    tenant_id: "tenant_trusted", profile_id: "profile_trusted", schema_version: 1, resource_version: 1,
    owner_actor_id: "actor_trusted", profile_kind: "consultant", hermes_profile_ref: "hermes_trusted",
    description: "Trusted profile", status: "active", provider_config_id: "provider_trusted",
    model_id: "model_trusted", created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("runtime_containers").values({
    tenant_id: "tenant_trusted", container_id: "container_trusted", schema_version: 1,
    resource_version: 1, command_version: 1, runtime_kind: "hermes", desired_state: "running",
    observed_state: "ready", image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`,
    runtime_platform: "linux/arm64", generation: 1, volume_ref: "volume_trusted", health_status: "healthy",
    last_probed_at: now, failure_summary: null, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("conversations").values({
    tenant_id: "tenant_trusted", conversation_id: "conversation_trusted", profile_id: "profile_trusted",
    created_by_actor_id: "actor_trusted", status: "active", schema_version: 1, resource_version: 1,
    student_ref: null, case_ref: null, created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("agent_runs").values({
    tenant_id: "tenant_trusted", run_id: "run_trusted", conversation_id: "conversation_trusted",
    request_id: "request_trusted", trace_id: "trace_trusted", client_request_id: "client_trusted",
    idempotency_key: "idem_trusted", parent_run_id: null, schema_version: 1, resource_version: 1,
    status: "queued", started_at: null, finished_at: null, failure_code: null, failure_summary: null,
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("core_sessions").values({
    session_id: "session_trusted", secret_digest: Buffer.alloc(32, 1), csrf_digest: null,
    actor_id: "actor_trusted", auth_subject_id: "subject_trusted", client_kind: "web", status: "active",
    device_label: null, created_at: now, last_seen_at: now,
    idle_expires_at: new Date("2026-08-26T02:00:00.000Z"),
    absolute_expires_at: new Date("2026-09-18T02:00:00.000Z"), reauthenticated_at: null,
    revocation_reason: null, resource_version: 1, updated_at: now,
  }).execute();
}

function input() {
  return {
    sessionId: "session_trusted", tenantId: "tenant_trusted", membershipId: "membership_trusted",
    effectiveRole: "consultant" as const, profileId: "profile_trusted", containerId: "container_trusted",
    conversationId: "conversation_trusted", runId: "run_trusted", requestId: "request_trusted",
    traceId: "trace_trusted", clientRequestId: "client_trusted", contextId: "context_trusted", ttlSeconds: 300,
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  await seedCurrentAuthority();
});

test.after(async () => {
  await db.destroy();
});

test("trusted context is signed only from current Session identity graph runtime Run and snapshot authority", async () => {
  const issueTrustedContext = requiredFunction<IssueTrustedContext>("issueTrustedContext");
  const verifyTrustedContextSignature = requiredFunction<(input: unknown) => SignedTrustedRequestContext>("verifyTrustedContextSignature");
  const pair = generateKeyPairSync("ed25519");
  let snapshotCalls = 0;
  const entitlementSnapshotAuthority: EntitlementSnapshotAuthorityPort = {
    async loadCurrentSnapshot(authority) {
      snapshotCalls += 1;
      assert.equal(authority.tenantId, "tenant_trusted");
      assert.equal(authority.profileId, "profile_trusted");
      assert.equal(authority.membershipId, "membership_trusted");
      assert.equal(authority.actorId, "actor_trusted");
      assert.equal(authority.now.toISOString(), now.toISOString());
      assert.equal((await authority.trx.selectFrom("actors").select("status").where("actor_id", "=", authority.actorId).executeTakeFirst())?.status, "active");
      return {
        snapshotRef: { snapshot_id: "snapshot_current", version: 7, evaluated_at: "2026-08-19T01:59:00.000Z" },
        capabilityIds: ["capability_z", "capability_a", "capability_z"], current: true, bootstrapOnly: false,
      };
    },
  };
  const envelope = await issueTrustedContext({
    db, signingKey: { keyId: "key_trusted", privateKey: pair.privateKey },
    issuer: "identity-gateway", audience: ["worker", "control-plane-api", "worker"],
    entitlementSnapshotAuthority, databaseNow: async () => new Date(now),
  }, input());
  assert.equal(snapshotCalls, 1);
  assert.deepEqual(envelope.payload.capability_ids, ["capability_a", "capability_z"]);
  assert.deepEqual(envelope.payload.audience, ["control-plane-api", "worker"]);
  assert.equal(envelope.payload.actor_id, "actor_trusted");
  assert.equal(envelope.payload.original_actor_id, "actor_trusted");
  assert.equal(envelope.payload.request_id, "request_trusted");
  assert.equal(envelope.payload.trace_id, "trace_trusted");
  assert.equal(envelope.payload.client_request_id, "client_trusted");
  assert.equal(envelope.payload.issued_at, "2026-08-19T02:00:00.000Z");
  assert.equal(envelope.payload.expires_at, "2026-08-19T02:05:00.000Z");
  assert.equal(Object.isFrozen(envelope.payload.capability_ids), true);
  assert.deepEqual(verifyTrustedContextSignature({
    envelope,
    keys: [{ keyId: "key_trusted", publicKey: pair.publicKey, status: "active", activatedAt: "2026-08-19T00:00:00.000Z" }],
    expectedIssuer: "identity-gateway", expectedAudience: "control-plane-api", now: new Date("2026-08-19T02:01:00.000Z"),
  }), envelope);
});

test("trusted context issuance fails closed on stale Session Membership Profile Tenant runtime Run or snapshot authority", async () => {
  const issueTrustedContext = requiredFunction<IssueTrustedContext>("issueTrustedContext");
  const pair = generateKeyPairSync("ed25519");
  let current = true;
  const dependencies = {
    db, signingKey: { keyId: "key_trusted", privateKey: pair.privateKey },
    issuer: "identity-gateway", audience: ["control-plane-api"], databaseNow: async () => new Date(now),
    entitlementSnapshotAuthority: {
      async loadCurrentSnapshot(): Promise<SnapshotAuthority> {
        return {
          snapshotRef: { snapshot_id: "snapshot_current", version: 1, evaluated_at: now.toISOString() },
          capabilityIds: [], current, bootstrapOnly: false,
        };
      },
    },
  };
  const mutations = [
    () => db.updateTable("core_sessions").set({ status: "revoked", revocation_reason: "administrator_revoked" }).where("session_id", "=", "session_trusted").execute(),
    () => db.updateTable("actors").set({ status: "disabled" }).where("actor_id", "=", "actor_trusted").execute(),
    () => db.updateTable("auth_subjects").set({ status: "revoked" }).where("auth_subject_id", "=", "subject_trusted").execute(),
    () => db.updateTable("memberships").set({ status: "suspended" }).where("tenant_id", "=", "tenant_trusted").where("membership_id", "=", "membership_trusted").execute(),
    () => db.updateTable("profiles").set({ status: "suspended" }).where("tenant_id", "=", "tenant_trusted").where("profile_id", "=", "profile_trusted").execute(),
    () => db.updateTable("tenants").set({ status: "suspended" }).where("tenant_id", "=", "tenant_trusted").execute(),
    () => db.updateTable("runtime_containers").set({ health_status: "unhealthy" }).where("tenant_id", "=", "tenant_trusted").execute(),
    () => db.updateTable("agent_runs").set({ client_request_id: "changed_client" }).where("tenant_id", "=", "tenant_trusted").execute(),
  ];
  for (const mutate of mutations) {
    await resetDatabase();
    await seedCurrentAuthority();
    await mutate();
    await assert.rejects(issueTrustedContext(dependencies, input()), /UNAUTHENTICATED|RESOURCE_NOT_FOUND|INVALID_STATE_TRANSITION/);
  }
  await resetDatabase();
  await seedCurrentAuthority();
  current = false;
  await assert.rejects(issueTrustedContext(dependencies, input()), /UNAUTHENTICATED|INVALID_STATE_TRANSITION/);
});

test("identity bootstrap snapshot is explicit and cannot admit an Agent Run", async () => {
  const createPort = requiredFunction<() => EntitlementSnapshotAuthorityPort>("createIdentityBootstrapEntitlementSnapshotAuthorityPort");
  const assertAdmission = requiredFunction<(envelope: SignedTrustedRequestContext) => void>("assertTrustedContextAgentRunAdmission");
  const issueTrustedContext = requiredFunction<IssueTrustedContext>("issueTrustedContext");
  const pair = generateKeyPairSync("ed25519");
  const envelope = await issueTrustedContext({
    db, signingKey: { keyId: "key_trusted", privateKey: pair.privateKey }, issuer: "identity-gateway",
    audience: ["control-plane-api"], entitlementSnapshotAuthority: createPort(), databaseNow: async () => new Date(now),
  }, input());
  assert.deepEqual(envelope.payload.entitlement_snapshot_ref, {
    snapshot_id: "identity_bootstrap_empty", version: 1, evaluated_at: "1970-01-01T00:00:00.000Z",
  });
  assert.deepEqual(envelope.payload.capability_ids, []);
  assert.throws(() => assertAdmission(envelope), /INVALID_STATE_TRANSITION|ENTITLEMENT|bootstrap/i);
});
