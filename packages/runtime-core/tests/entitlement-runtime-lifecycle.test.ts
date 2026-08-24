import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "kysely";
import { Pool } from "pg";

import {
  claimPlatformWorkerJobs,
  createRuntimeDatabase,
  deriveRuntimeContainerId,
  DomainError,
  enqueueIdleB2cRuntimeStopJobs,
  RuntimeActivityRepository,
} from "../src/index.js";
import { createAgentRun } from "../src/services/create-agent-run.js";
import { createConversation } from "../src/services/create-conversation.js";
import {
  admissionNow,
  providerCatalog,
  resetAdmissionDatabase,
  seedReadyTenant,
  serviceContext,
  withPayloadHash,
} from "./admission-test-support.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);

function conversationRequest(tenantId: string, profileId: string) {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `conversation_${tenantId}`,
    tenant_id: tenantId,
    profile_id: profileId,
  });
}

function runRequest(tenantId: string) {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `run_${tenantId}`,
    client_request_id: `client_${tenantId}`,
    input_message: { client_message_id: `message_${tenantId}`, content: "Wake the exact managed Runtime." },
  });
}

async function seedConversation(tenantId: string) {
  const seeded = await seedReadyTenant(db, tenantId);
  const conversation = await createConversation(
    { db, now: () => admissionNow },
    serviceContext(tenantId),
    conversationRequest(tenantId, seeded.profileId),
  );
  return { ...seeded, conversation };
}

test.before(async () => {
  await pool.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then
      create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then
      create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'core_agent_migrator') then
      create role core_agent_migrator nologin nosuperuser nocreatedb nocreaterole noinherit;
    end if;
  end $$;`);
});
test.beforeEach(async () => resetAdmissionDatabase(pool));
test.after(async () => db.destroy());

test("Conversation, Session, and Run admission touch Runtime activity with PostgreSQL time", async () => {
  const tenantId = "tenant_lifecycle_activity";
  const seeded = await seedReadyTenant(db, tenantId);
  const before = await db.selectFrom("runtime_containers").select("generation")
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  const conversation = await createConversation(
    { db, now: () => new Date("2400-01-01T00:00:00.000Z") },
    serviceContext(tenantId),
    conversationRequest(tenantId, seeded.profileId),
  );
  const activity = await db.selectFrom("runtime_activity").selectAll()
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  assert.equal(Number(activity.runtime_generation), before.generation);
  assert.notEqual(activity.last_work_at.getUTCFullYear(), 2400, "application clock must not author activity");

  await createAgentRun(
    { db, providerCatalog, now: () => new Date("2400-01-01T00:00:00.000Z") },
    serviceContext(tenantId),
    conversation.conversation_id,
    runRequest(tenantId),
  );
  const touched = await db.selectFrom("runtime_activity").select(["last_work_at", "resource_version"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  assert.ok(touched.last_work_at >= activity.last_work_at);
  assert.equal(Number(touched.resource_version), Number(activity.resource_version) + 1);
});

test("a stopped B2C Runtime creates one idempotent wake before one Run is admitted", async () => {
  const tenantId = "tenant_lifecycle_wake";
  const seeded = await seedConversation(tenantId);
  const before = await db.selectFrom("runtime_containers")
    .select(["volume_ref", "capability_manifest_digest", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  await db.updateTable("runtime_containers").set({
    desired_state: "stopped", observed_state: "stopped", health_status: "unknown",
  }).where("tenant_id", "=", tenantId).execute();

  const attempt = () => createAgentRun(
    { db, providerCatalog, now: () => admissionNow },
    serviceContext(tenantId),
    seeded.conversation.conversation_id,
    runRequest(tenantId),
  );
  const outcomes = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(outcomes.every((outcome) => outcome.status === "rejected"
    && outcome.reason instanceof DomainError
    && outcome.reason.code === "SERVICE_PREPARING"), true, outcomes.map((outcome) => outcome.status === "fulfilled"
      ? "fulfilled"
      : `${outcome.reason instanceof DomainError ? outcome.reason.code : outcome.reason?.constructor?.name}:${String(outcome.reason)}`).join(" | "));
  const starts = await db.selectFrom("worker_jobs").select(["job_id", "runtime_command", "target_command_version"])
    .where("tenant_id", "=", tenantId).where("job_kind", "=", "reconcile_runtime")
    .where("runtime_command", "=", "start").execute();
  assert.equal(starts.length, 1);
  assert.equal(await db.selectFrom("agent_runs").select("run_id").where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 0);
  const waking = await db.selectFrom("runtime_containers")
    .select(["desired_state", "volume_ref", "capability_manifest_digest", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  assert.equal(waking.desired_state, "running");
  assert.deepEqual({
    volume_ref: waking.volume_ref,
    capability_manifest_digest: waking.capability_manifest_digest,
    generation: waking.generation,
  }, before);

  await db.updateTable("runtime_containers").set({ observed_state: "ready", health_status: "healthy" })
    .where("tenant_id", "=", tenantId).execute();
  const admitted = await attempt();
  const replay = await attempt();
  assert.deepEqual(replay, admitted);
  assert.equal(await db.selectFrom("agent_runs").select("run_id").where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
});

test("idle scheduling is B2C-only, uses the exact 30-minute boundary, and respects active Runs", async () => {
  const tenantId = "tenant_lifecycle_idle";
  const seeded = await seedConversation(tenantId);
  const generation = (await db.selectFrom("runtime_containers").select("generation")
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow()).generation;
  await db.insertInto("runtime_activity").values({
    tenant_id: tenantId,
    runtime_generation: generation,
    last_work_at: new Date(),
    active_conversation_count: 0,
    active_run_count: 0,
    resource_version: 1,
  }).onConflict((conflict) => conflict.columns(["tenant_id", "runtime_generation"]).doUpdateSet({
    last_work_at: new Date(), active_conversation_count: 0, active_run_count: 0,
  })).execute();
  await db.updateTable("runtime_activity").set({
    last_work_at: sql<Date>`clock_timestamp() - interval '29 minutes 59 seconds'`,
  }).where("tenant_id", "=", tenantId).execute();
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 10), 0);

  await db.updateTable("runtime_activity").set({
    last_work_at: sql<Date>`clock_timestamp() - interval '30 minutes'`,
  }).where("tenant_id", "=", tenantId).execute();
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 10), 1);
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 10), 0);

  await db.deleteFrom("worker_jobs").where("tenant_id", "=", tenantId)
    .where("job_kind", "=", "stop_idle_b2c_runtime").execute();
  await createAgentRun(
    { db, providerCatalog, now: () => admissionNow }, serviceContext(tenantId),
    seeded.conversation.conversation_id, runRequest(tenantId),
  );
  await db.updateTable("runtime_activity").set({ last_work_at: new Date(0) })
    .where("tenant_id", "=", tenantId).execute();
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 10), 0);

  const b2bTenantId = "tenant_lifecycle_b2b";
  const b2bRuntimeId = deriveRuntimeContainerId(b2bTenantId);
  await db.insertInto("tenants").values({
    tenant_id: b2bTenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: "Persistent company", created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("runtime_containers").values({
    tenant_id: b2bTenantId, container_id: b2bRuntimeId, schema_version: 1, resource_version: 1,
    command_version: 0, runtime_kind: "hermes", desired_state: "running", observed_state: "ready",
    image_ref: `managed/runtime:v1@sha256:${"b".repeat(64)}`, runtime_platform: "linux/amd64",
    generation: 1, volume_ref: "volume_lifecycle_b2b", health_status: "healthy",
    last_probed_at: admissionNow, failure_summary: null, created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("runtime_activity").values({
    tenant_id: b2bTenantId, runtime_generation: 1, last_work_at: new Date(0),
    active_conversation_count: 0, active_run_count: 0, resource_version: 1,
  }).execute();
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 10), 0);
});

test("the idle-stop worker rechecks authority, preserves Volume and manifest history, and emits one stop intent", async () => {
  const tenantId = "tenant_lifecycle_stop";
  await seedReadyTenant(db, tenantId);
  const runtime = await db.selectFrom("runtime_containers")
    .select(["container_id", "generation", "volume_ref", "capability_manifest_digest"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  await db.insertInto("runtime_activity").values({
    tenant_id: tenantId, runtime_generation: runtime.generation, last_work_at: new Date(0),
    active_conversation_count: 0, active_run_count: 0, resource_version: 1,
  }).execute();
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 1), 1);
  const [claimed] = await claimPlatformWorkerJobs(db, {
    workerId: "worker_idle", limit: 1, leaseMs: 30_000, jobKinds: ["stop_idle_b2c_runtime"],
  });
  assert.ok(claimed !== undefined && claimed.jobKind === "stop_idle_b2c_runtime");
  if (claimed === undefined || claimed.jobKind !== "stop_idle_b2c_runtime") return;
  const result = await new RuntimeActivityRepository(db).stopIdle({
    tenantId, jobId: claimed.jobId, workerId: "worker_idle", attemptCount: claimed.attemptCount,
    runtimeId: claimed.payloadRef,
  });
  assert.deepEqual(result, { kind: "stopped" });
  const stopped = await db.selectFrom("runtime_containers")
    .select(["desired_state", "volume_ref", "capability_manifest_digest", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  assert.equal(stopped.desired_state, "stopped");
  assert.deepEqual({ volume_ref: stopped.volume_ref, capability_manifest_digest: stopped.capability_manifest_digest, generation: stopped.generation }, {
    volume_ref: runtime.volume_ref, capability_manifest_digest: runtime.capability_manifest_digest, generation: runtime.generation,
  });
  const stopJobs = await db.selectFrom("worker_jobs").select(["runtime_command", "container_id"])
    .where("tenant_id", "=", tenantId).where("job_kind", "=", "reconcile_runtime")
    .where("runtime_command", "=", "stop").execute();
  assert.deepEqual(stopJobs, [{ runtime_command: "stop", container_id: runtime.container_id }]);
});

test("activity after scheduling supersedes the claimed idle stop under the Runtime lock", async () => {
  const tenantId = "tenant_lifecycle_recheck";
  await seedReadyTenant(db, tenantId);
  const runtime = await db.selectFrom("runtime_containers")
    .select(["container_id", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  await db.insertInto("runtime_activity").values({
    tenant_id: tenantId, runtime_generation: runtime.generation, last_work_at: new Date(0),
    active_conversation_count: 0, active_run_count: 0, resource_version: 1,
  }).execute();
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(db, 1), 1);
  const [claimed] = await claimPlatformWorkerJobs(db, {
    workerId: "worker_recheck", limit: 1, leaseMs: 30_000, jobKinds: ["stop_idle_b2c_runtime"],
  });
  assert.ok(claimed !== undefined && claimed.jobKind === "stop_idle_b2c_runtime");
  if (claimed === undefined || claimed.jobKind !== "stop_idle_b2c_runtime") return;
  await db.updateTable("runtime_activity").set({ last_work_at: sql<Date>`clock_timestamp()` })
    .where("tenant_id", "=", tenantId).execute();
  assert.deepEqual(await new RuntimeActivityRepository(db).stopIdle({
    tenantId, jobId: claimed.jobId, workerId: "worker_recheck",
    attemptCount: claimed.attemptCount, runtimeId: claimed.payloadRef,
  }), { kind: "superseded" });
  assert.equal((await db.selectFrom("runtime_containers").select("desired_state")
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow()).desired_state, "running");
  assert.equal(await db.selectFrom("worker_jobs").select("job_id")
    .where("tenant_id", "=", tenantId).where("job_kind", "=", "reconcile_runtime")
    .where("runtime_command", "=", "stop").execute().then((rows) => rows.length), 0);
});
