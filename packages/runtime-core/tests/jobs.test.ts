import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations, claimJobs, claimPlatformWorkerJobs, completeJob, createRedactor, createRuntimeDatabase, failJob, heartbeatJob, retryDecision, withRuntimeAdvisoryLock } from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));

async function reset(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
  await db.insertInto("tenants").values({
    tenant_id: "tenant_jobs", schema_version: 1, resource_version: 1,
    tenant_mode: "b2b", status: "active", display_name: "Synthetic jobs tenant",
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
}

async function insertJob(): Promise<void> {
  await db.insertInto("worker_jobs").values({
    tenant_id: "tenant_jobs", job_id: "job_1", job_kind: "dispatch_outbox", status: "queued",
    attempt_count: 0, max_attempts: 3, lease_owner: null, lease_expires_at: null,
    next_attempt_at: new Date(0), payload_ref: "payload_1", effect_state: "pre_effect",
    runtime_command: null,
    last_error_summary: null, run_id: null, container_id: null,
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
}

async function insertRuntime(): Promise<void> {
  await db.insertInto("runtime_containers").values({
    tenant_id: "tenant_jobs", container_id: "runtime_recovery", schema_version: 1, resource_version: 1,
    command_version: 1, runtime_kind: "hermes", desired_state: "running", observed_state: "ready",
    image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`, runtime_platform: "linux/amd64",
    generation: 1, volume_ref: "volume_recovery", health_status: "healthy", last_probed_at: null,
    failure_summary: null, created_at: new Date(0), updated_at: new Date(0),
  }).execute();
}

async function insertRecoveryJob(input: {
  jobId: string; jobKind: "reconcile_runtime" | "execute_agent_run" | "dispatch_outbox";
  status: "queued" | "retrying" | "running"; attemptCount: number; maxAttempts: number;
  effectState: "pre_effect" | "unsafe_to_replay"; runtimeCommand?: "restart";
}): Promise<void> {
  const reconcile = input.jobKind === "reconcile_runtime";
  await db.insertInto("worker_jobs").values({
    tenant_id: "tenant_jobs", job_id: input.jobId, job_kind: input.jobKind, status: input.status,
    attempt_count: input.attemptCount, max_attempts: input.maxAttempts,
    lease_owner: input.status === "running" ? "worker_crashed" : null,
    lease_expires_at: input.status === "running" ? new Date(0) : null,
    next_attempt_at: input.status === "running" ? new Date("2100-01-01T00:00:00.000Z") : new Date(0),
    payload_ref: reconcile ? "runtime_recovery" : input.jobId,
    runtime_command: reconcile ? input.runtimeCommand ?? "restart" : null,
    target_command_version: reconcile ? 1 : null, effect_state: input.effectState,
    last_error_summary: null, run_id: null, container_id: reconcile ? "runtime_recovery" : null,
    created_at: new Date(0), updated_at: new Date(0),
  }).execute();
}

test.beforeEach(reset);
test.after(async () => { await db.destroy(); });

test("concurrent workers claim a job once and reclaim only after lease expiry", async () => {
  await insertJob();
  const [left, right] = await Promise.all([
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_a", limit: 1, leaseMs: 30_000 }),
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_b", limit: 1, leaseMs: 30_000 }),
  ]);
  assert.equal(left.length + right.length, 1);
  await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").execute();
  assert.equal((await claimJobs(db, {
    tenantId: "tenant_jobs", workerId: "worker_c", limit: 1, leaseMs: 30_000,
  })).length, 1);
});

test("expired final reconcile work is reclaimed once without incrementing beyond max", async () => {
  await insertRuntime();
  await insertRecoveryJob({ jobId: "job_final_reconcile", jobKind: "reconcile_runtime", status: "running", attemptCount: 3, maxAttempts: 3, effectState: "unsafe_to_replay" });
  const [left, right] = await Promise.all([
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_recover_a", limit: 1, leaseMs: 30_000 }),
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_recover_b", limit: 1, leaseMs: 30_000 }),
  ]);
  const recovered = [...left, ...right];
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.attemptCount, 3);
  assert.equal(recovered[0]?.recoveryOnly, true);
  assert.equal(recovered[0]?.effectState, "unsafe_to_replay");
  assert.equal((await db.selectFrom("worker_jobs").select("attempt_count").where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_final_reconcile").executeTakeFirstOrThrow()).attempt_count, 3);
  assert.deepEqual(await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_recover_c", limit: 1, leaseMs: 30_000 }), []);
});

test("expired final execute jobs reclaim pre and unsafe phases without incrementing", async () => {
  await insertRecoveryJob({ jobId: "job_execute_pre", jobKind: "execute_agent_run", status: "running", attemptCount: 2, maxAttempts: 2, effectState: "pre_effect" });
  await insertRecoveryJob({ jobId: "job_execute_unsafe", jobKind: "execute_agent_run", status: "running", attemptCount: 2, maxAttempts: 2, effectState: "unsafe_to_replay" });
  const [left, right] = await Promise.all([
    claimPlatformWorkerJobs(db, { workerId: "platform_recover_a", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
    claimPlatformWorkerJobs(db, { workerId: "platform_recover_b", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
  ]);
  const recovered = [...left, ...right].sort((a, b) => a.jobId.localeCompare(b.jobId));
  assert.deepEqual(recovered.map((job) => ({ jobId: job.jobId, attemptCount: job.attemptCount, recoveryOnly: job.recoveryOnly, effectState: job.effectState })), [
    { jobId: "job_execute_pre", attemptCount: 2, recoveryOnly: true, effectState: "pre_effect" },
    { jobId: "job_execute_unsafe", attemptCount: 2, recoveryOnly: true, effectState: "unsafe_to_replay" },
  ]);
  assert.deepEqual(await claimPlatformWorkerJobs(db, { workerId: "platform_recover_c", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }), []);
});

test("queued and retrying max-attempt jobs are ineligible while a normal final claim is not recovery-only", async () => {
  await insertRecoveryJob({ jobId: "job_queued_max", jobKind: "dispatch_outbox", status: "queued", attemptCount: 3, maxAttempts: 3, effectState: "pre_effect" });
  await insertRecoveryJob({ jobId: "job_retrying_max", jobKind: "dispatch_outbox", status: "retrying", attemptCount: 3, maxAttempts: 3, effectState: "pre_effect" });
  assert.deepEqual(await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_max", limit: 8, leaseMs: 30_000 }), []);
  assert.deepEqual(await claimPlatformWorkerJobs(db, { workerId: "platform_max", limit: 8, leaseMs: 30_000 }), []);

  await insertRuntime();
  await insertRecoveryJob({ jobId: "job_normal_final", jobKind: "reconcile_runtime", status: "queued", attemptCount: 2, maxAttempts: 3, effectState: "pre_effect" });
  const [claimed] = await claimPlatformWorkerJobs(db, { workerId: "platform_final", limit: 1, leaseMs: 30_000 });
  assert.equal(claimed?.attemptCount, 3);
  assert.equal(claimed?.recoveryOnly, false);
});

test("worker job storage rejects attempt counts beyond max attempts", async () => {
  await assert.rejects(
    insertRecoveryJob({ jobId: "job_invalid_attempt", jobKind: "execute_agent_run", status: "running", attemptCount: 4, maxAttempts: 3, effectState: "unsafe_to_replay" }),
    /worker_jobs_attempt_count_max_check/,
  );
});

test("platform Worker claims eligible jobs across tenants without duplicate ownership", async () => {
  await insertJob();
  await db.insertInto("tenants").values({ tenant_id: "tenant_jobs_b", schema_version: 1, resource_version: 1, tenant_mode: "b2b", status: "active", display_name: "B", created_at: new Date(0), updated_at: new Date(0) }).execute();
  await db.insertInto("worker_jobs").values({ tenant_id: "tenant_jobs_b", job_id: "job_b", job_kind: "dispatch_outbox", status: "queued", attempt_count: 0, max_attempts: 3, lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(0), payload_ref: "payload_b", runtime_command: null, effect_state: "pre_effect", last_error_summary: null, run_id: null, container_id: null, created_at: new Date(1), updated_at: new Date(1) }).execute();
  const [left, right] = await Promise.all([
    claimPlatformWorkerJobs(db, { workerId: "platform_a", limit: 8, leaseMs: 30_000 }),
    claimPlatformWorkerJobs(db, { workerId: "platform_b", limit: 8, leaseMs: 30_000 }),
  ]);
  assert.deepEqual(new Set([...left, ...right].map((job) => job.tenantId)), new Set(["tenant_jobs", "tenant_jobs_b"]));
  assert.equal(left.length + right.length, 2);
});

test("runtime advisory lock serializes external work for one tenant runtime", async () => {
  let active = 0; let maximum = 0;
  const work = () => withRuntimeAdvisoryLock(db, "tenant_jobs", "runtime_1", async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  });
  await Promise.all([work(), work()]);
  assert.equal(maximum, 1);
});

test("claimed jobs discriminate reconcile command intent and fail closed on invalid storage", async () => {
  await insertJob();
  await db.insertInto("runtime_containers").values({
    tenant_id: "tenant_jobs", container_id: "runtime_1", schema_version: 1, resource_version: 1,
    runtime_kind: "hermes", desired_state: "running", observed_state: "requested",
    image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`, generation: 1, volume_ref: "volume_1",
    health_status: "unknown", last_probed_at: null, failure_summary: null,
    created_at: new Date(0), updated_at: new Date(0),
  }).execute();
  await db.insertInto("worker_jobs").values({
    tenant_id: "tenant_jobs", job_id: "job_reconcile", job_kind: "reconcile_runtime", status: "queued",
    attempt_count: 0, max_attempts: 3, lease_owner: null, lease_expires_at: null,
    next_attempt_at: new Date(0), payload_ref: "runtime_1", effect_state: "pre_effect",
    runtime_command: "restart", last_error_summary: null, run_id: null, container_id: "runtime_1",
    target_command_version: 1,
    created_at: new Date(1), updated_at: new Date(1),
  }).execute();
  const jobs = await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_shapes", limit: 2, leaseMs: 30_000 });
  for (const job of jobs) {
    if (job.jobKind === "reconcile_runtime") {
      const intent: "start" | "stop" | "restart" | "delete" = job.runtimeCommand;
      assert.equal(intent, "restart");
      assert.equal(job.targetCommandVersion, 1);
    } else {
      const noIntent: null = job.runtimeCommand;
      assert.equal(noIntent, null);
      assert.equal(job.targetCommandVersion, null);
    }
  }

  await db.updateTable("worker_jobs").set({ next_attempt_at: new Date("2100-01-01T00:00:00.000Z") })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").execute();
  await db.updateTable("worker_jobs").set({ status: "queued", lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(0), effect_state: "unsafe_to_replay" })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_reconcile").execute();
  const [observeOnly] = await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_observe", limit: 1, leaseMs: 30_000 });
  assert.equal(observeOnly?.jobKind, "reconcile_runtime");
  if (observeOnly?.jobKind === "reconcile_runtime") assert.equal(observeOnly.effectState, "unsafe_to_replay");

  await db.schema.alterTable("worker_jobs").dropConstraint("worker_jobs_runtime_command_intent_check").execute();
  await db.updateTable("worker_jobs").set({
    status: "queued", lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(0), runtime_command: "start",
  }).where("job_id", "=", "job_1").execute();
  await assert.rejects(
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_invalid", limit: 1, leaseMs: 30_000 }),
    /Stored worker job command intent is invalid/,
  );
  await db.updateTable("worker_jobs").set({ next_attempt_at: new Date("2100-01-01T00:00:00.000Z") })
    .where("job_id", "=", "job_1").execute();
  await db.updateTable("worker_jobs").set({
    status: "queued", lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(0), runtime_command: null,
  }).where("job_id", "=", "job_reconcile").execute();
  await assert.rejects(
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_invalid", limit: 1, leaseMs: 30_000 }),
    /Stored worker job command intent is invalid/,
  );
});

test("stale workers cannot backdate or future-date database lease authority", async () => {
  await insertJob();
  await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_a", limit: 1, leaseMs: 30_000 });
  await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").execute();
  assert.deepEqual(await completeJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_a",
    now: new Date(0),
  } as never), { kind: "lease_lost" });
  assert.deepEqual(await heartbeatJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_a", leaseMs: 30_000,
    now: new Date("2100-01-01T00:00:00.000Z"),
  } as never), { kind: "lease_lost" });
});

test("persisted job failures use a required registered-material redactor", async () => {
  await insertJob();
  await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_a", limit: 1, leaseMs: 30_000 });
  const secret = "sentinel-secret-0123456789";
  assert.deepEqual(await failJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_a",
    lastErrorSummary: `Basic abc api_key=${secret}`, redactor: createRedactor([secret]),
  }), { kind: "updated" });
  const job = await db.selectFrom("worker_jobs").select("last_error_summary")
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").executeTakeFirstOrThrow();
  assert.doesNotMatch(job.last_error_summary ?? "", /Basic|api_key|sentinel-secret/);
});

test("retry decisions reject invalid scheduling inputs", () => {
  const failure = { code: "DEPENDENCY_UNAVAILABLE" as const, retryable: true, summary: "safe" };
  assert.throws(() => retryDecision(failure, 0, 3, new Date(), () => 0, createRedactor([])), /attemptCount/);
  assert.throws(() => retryDecision(failure, 1, 0, new Date(), () => 0, createRedactor([])), /maxAttempts/);
  assert.throws(() => retryDecision(failure, 1, 3, new Date("invalid"), () => 0, createRedactor([])), /now/);
  assert.throws(() => retryDecision(failure, 1, 3, new Date(), () => 1, createRedactor([])), /random/);
});
