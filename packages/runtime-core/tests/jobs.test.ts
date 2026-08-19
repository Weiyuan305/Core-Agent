import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { sql } from "kysely";
import { Pool } from "pg";

import { applyMigrations, claimJobs, claimPlatformWorkerJobs, completeJob, createRedactor, createRuntimeDatabase, failJob, heartbeatJob, markJobEffectDispatched, retryDecision, withRuntimeAdvisoryLock } from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));

interface ExplainPlanNode {
  readonly "Actual Loops"?: number;
  readonly "Actual Rows"?: number;
  readonly Plans?: readonly ExplainPlanNode[];
}

function maximumActualWork(node: ExplainPlanNode): number {
  const nodeWork = (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
  return Math.max(nodeWork, ...(node.Plans ?? []).map(maximumActualWork));
}

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

async function insertExecuteBacklog(
  conversations: readonly { conversationId: string; count: number; createdOffset: number }[],
): Promise<void> {
  await db.insertInto("actors").values({
    actor_id: "actor_jobs", schema_version: 1, resource_version: 1,
    actor_kind: "human", display_name: "Jobs actor", status: "active", created_at: new Date(0), updated_at: new Date(0),
  }).execute();
  await db.insertInto("profiles").values({
    tenant_id: "tenant_jobs", profile_id: "profile_jobs", schema_version: 1, resource_version: 1,
    owner_actor_id: "actor_jobs", profile_kind: "default", hermes_profile_ref: "jobs",
    description: "Jobs profile", status: "active", provider_config_id: "provider_jobs", model_id: "model_jobs",
    created_at: new Date(0), updated_at: new Date(0),
  }).execute();
  const runs = [];
  const jobs = [];
  for (const conversation of conversations) {
    await db.insertInto("conversations").values({
      tenant_id: "tenant_jobs", conversation_id: conversation.conversationId, profile_id: "profile_jobs",
      created_by_actor_id: "actor_jobs", status: "active", schema_version: 1, resource_version: 1,
      student_ref: null, case_ref: null, created_at: new Date(conversation.createdOffset), updated_at: new Date(conversation.createdOffset),
    }).execute();
    for (let index = 0; index < conversation.count; index += 1) {
      const runId = `run_${conversation.conversationId}_${index}`;
      const createdAt = new Date(conversation.createdOffset + index);
      runs.push({
        tenant_id: "tenant_jobs", run_id: runId, conversation_id: conversation.conversationId,
        request_id: `request_${runId}`, trace_id: `trace_${runId}`, client_request_id: `client_${runId}`,
        idempotency_key: `idem_${runId}`, parent_run_id: null, schema_version: 1, resource_version: 1,
        status: "queued", started_at: null, finished_at: null, failure_summary: null,
        created_at: createdAt, updated_at: createdAt,
      });
      jobs.push({
        tenant_id: "tenant_jobs", job_id: `job_${conversation.conversationId}_${index}`, job_kind: "execute_agent_run",
        status: "queued", attempt_count: 0, max_attempts: 3, lease_owner: null, lease_expires_at: null,
        next_attempt_at: new Date(0), payload_ref: runId, effect_state: "pre_effect", runtime_command: null,
        target_command_version: null, last_error_summary: null, run_id: runId, container_id: null,
        created_at: createdAt, updated_at: createdAt,
      });
    }
  }
  if (runs.length > 0) await db.insertInto("agent_runs").values(runs).execute();
  if (jobs.length > 0) await db.insertInto("worker_jobs").values(jobs).execute();
}

async function insertRecoveryJob(input: {
  jobId: string; jobKind: "reconcile_runtime" | "execute_agent_run" | "dispatch_outbox" | "finalize_account_deletion";
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
  await insertExecuteBacklog([
    { conversationId: "execute_pre", count: 1, createdOffset: 1 },
    { conversationId: "execute_unsafe", count: 1, createdOffset: 2 },
  ]);
  await db.updateTable("worker_jobs").set({
    status: "running", attempt_count: 2, max_attempts: 2, lease_owner: "worker_crashed",
    lease_expires_at: new Date(0), effect_state: "pre_effect",
  }).where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_execute_pre_0").execute();
  await db.updateTable("worker_jobs").set({
    status: "running", attempt_count: 2, max_attempts: 2, lease_owner: "worker_crashed",
    lease_expires_at: new Date(0), effect_state: "unsafe_to_replay",
  }).where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_execute_unsafe_0").execute();
  const [left, right] = await Promise.all([
    claimPlatformWorkerJobs(db, { workerId: "platform_recover_a", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
    claimPlatformWorkerJobs(db, { workerId: "platform_recover_b", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
  ]);
  const recovered = [...left, ...right].sort((a, b) => a.jobId.localeCompare(b.jobId));
  assert.deepEqual(recovered.map((job) => ({ jobId: job.jobId, attemptCount: job.attemptCount, recoveryOnly: job.recoveryOnly, effectState: job.effectState })), [
    { jobId: "job_execute_pre_0", attemptCount: 2, recoveryOnly: true, effectState: "pre_effect" },
    { jobId: "job_execute_unsafe_0", attemptCount: 2, recoveryOnly: true, effectState: "unsafe_to_replay" },
  ]);
  assert.deepEqual(await claimPlatformWorkerJobs(db, { workerId: "platform_recover_c", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }), []);
});

test("account-deletion finalizer fences provider effects and only one worker reclaims an unsafe final attempt", async () => {
  await insertRecoveryJob({
    jobId: "job_delete_account", jobKind: "finalize_account_deletion",
    status: "queued", attemptCount: 0, maxAttempts: 2, effectState: "pre_effect",
  });
  const [claimed] = await claimPlatformWorkerJobs(db, {
    workerId: "deletion_worker_a", limit: 1, leaseMs: 30_000,
    jobKinds: ["finalize_account_deletion"],
  });
  assert.equal(claimed?.jobKind, "finalize_account_deletion");
  assert.equal(claimed?.effectState, "pre_effect");
  assert.deepEqual(await markJobEffectDispatched(db, {
    tenantId: "tenant_jobs", jobId: "job_delete_account", workerId: "wrong_worker", attemptCount: 1,
  }), { kind: "lease_lost" });
  assert.deepEqual(await markJobEffectDispatched(db, {
    tenantId: "tenant_jobs", jobId: "job_delete_account", workerId: "deletion_worker_a", attemptCount: 1,
  }), { kind: "updated" });
  await db.updateTable("worker_jobs").set({
    attempt_count: 2, max_attempts: 2, lease_owner: "worker_crashed", lease_expires_at: new Date(0),
  }).where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_delete_account").execute();
  const [left, right] = await Promise.all([
    claimPlatformWorkerJobs(db, { workerId: "deletion_recover_a", limit: 1, leaseMs: 30_000, jobKinds: ["finalize_account_deletion"] }),
    claimPlatformWorkerJobs(db, { workerId: "deletion_recover_b", limit: 1, leaseMs: 30_000, jobKinds: ["finalize_account_deletion"] }),
  ]);
  const recovered = [...left, ...right];
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.jobKind, "finalize_account_deletion");
  assert.equal(recovered[0]?.attemptCount, 2);
  assert.equal(recovered[0]?.recoveryOnly, true);
  assert.equal(recovered[0]?.effectState, "unsafe_to_replay");
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

test("platform claim reaches an unrelated Conversation beyond a large same-Conversation backlog", { timeout: 5_000 }, async () => {
  await insertExecuteBacklog([
    { conversationId: "conversation_hot", count: 8, createdOffset: 1 },
    { conversationId: "conversation_unrelated", count: 1, createdOffset: 100 },
  ]);

  const claimed = await claimPlatformWorkerJobs(db, {
    workerId: "platform_fair", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"],
  });

  assert.deepEqual(claimed.map((job) => job.jobId).sort(), [
    "job_conversation_hot_0", "job_conversation_unrelated_0",
  ]);
});

test("platform Conversation discovery stays non-expanding with 500 queued Runs", { timeout: 20_000 }, async () => {
  await insertExecuteBacklog([
    { conversationId: "conversation_scale", count: 500, createdOffset: 1 },
    { conversationId: "conversation_scale_unrelated", count: 1, createdOffset: 10_000 },
  ]);

  const explained = await sql<{ "QUERY PLAN": readonly [{ readonly Plan: ExplainPlanNode }] }>`
    explain (analyze, format json)
    with active_execute_conversations as materialized (
      select distinct active_jobs.tenant_id, active_runs.conversation_id
      from worker_jobs as active_jobs
      inner join agent_runs as active_runs
        on active_runs.tenant_id = active_jobs.tenant_id and active_runs.run_id = active_jobs.run_id
      where active_jobs.job_kind = 'execute_agent_run'
        and active_jobs.status = 'running'
        and active_jobs.lease_expires_at > now()
    )
    select jobs.tenant_id, runs.conversation_id, min(jobs.created_at) as oldest_created_at
    from worker_jobs as jobs
    inner join agent_runs as runs
      on runs.tenant_id = jobs.tenant_id and runs.run_id = jobs.run_id
    left join active_execute_conversations as active_conversations
      on active_conversations.tenant_id = jobs.tenant_id
      and active_conversations.conversation_id = runs.conversation_id
    where jobs.job_kind = 'execute_agent_run'
      and (
        (jobs.status in ('queued', 'retrying') and jobs.attempt_count < jobs.max_attempts and jobs.next_attempt_at <= now())
        or (jobs.status = 'running' and jobs.lease_expires_at < now())
      )
      and active_conversations.tenant_id is null
    group by jobs.tenant_id, runs.conversation_id
    order by oldest_created_at, jobs.tenant_id, runs.conversation_id
    limit 32
  `.execute(db);
  const plan = explained.rows[0]?.["QUERY PLAN"][0]?.Plan;
  assert.notEqual(plan, undefined);
  const maximumPlanWork = maximumActualWork(plan!);
  assert.equal(
    maximumPlanWork < 5_000,
    true,
    `discovery plan must not perform a quadratic jobs-by-runs expansion; observed maximum node work ${maximumPlanWork}`,
  );

  const claimed = await claimPlatformWorkerJobs(db, {
    workerId: "platform_scale", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"],
  });
  assert.deepEqual(claimed.map((job) => job.jobId).sort(), [
    "job_conversation_scale_0", "job_conversation_scale_unrelated_0",
  ]);

  const source = await readFile(new URL("../src/repositories/jobs.ts", import.meta.url), "utf8");
  const discovery = source.slice(source.indexOf("const executeCandidates"), source.indexOf("const candidates", source.indexOf("const executeCandidates")));
  assert.match(discovery, /cte\("active_execute_conversations"\)\.materialized\(\)/);
  assert.match(discovery, /leftJoin\("active_execute_conversations as active_conversations"/);
  assert.match(discovery, /where\("active_conversations\.tenant_id", "is", null\)/);
  assert.doesNotMatch(discovery, /not\(exists\(/);
});

test("two platform claimers cannot concurrently claim two Runs from one Conversation", { timeout: 5_000 }, async () => {
  await insertExecuteBacklog([{ conversationId: "conversation_shared", count: 2, createdOffset: 1 }]);

  const [left, right] = await Promise.all([
    claimPlatformWorkerJobs(db, { workerId: "platform_shared_a", limit: 1, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
    claimPlatformWorkerJobs(db, { workerId: "platform_shared_b", limit: 1, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
  ]);

  assert.equal(left.length + right.length, 1);
  assert.equal([...left, ...right][0]?.jobId, "job_conversation_shared_0");
});

test("an unexpired running Agent Run blocks later jobs only in its own Conversation", { timeout: 5_000 }, async () => {
  await insertExecuteBacklog([
    { conversationId: "conversation_busy", count: 2, createdOffset: 1 },
    { conversationId: "conversation_free", count: 1, createdOffset: 10 },
  ]);
  await db.updateTable("worker_jobs").set({
    status: "running", attempt_count: 1, lease_owner: "platform_existing",
    lease_expires_at: new Date("2100-01-01T00:00:00.000Z"),
  }).where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_conversation_busy_0").execute();

  const claimed = await claimPlatformWorkerJobs(db, {
    workerId: "platform_parallel", limit: 8, leaseMs: 30_000, jobKinds: ["execute_agent_run"],
  });

  assert.deepEqual(claimed.map((job) => job.jobId), ["job_conversation_free_0"]);
});

test("different Conversations remain claimable in parallel", { timeout: 5_000 }, async () => {
  await insertExecuteBacklog([
    { conversationId: "conversation_parallel_a", count: 1, createdOffset: 1 },
    { conversationId: "conversation_parallel_b", count: 1, createdOffset: 2 },
  ]);

  const [left, right] = await Promise.all([
    claimPlatformWorkerJobs(db, { workerId: "platform_parallel_a", limit: 1, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
    claimPlatformWorkerJobs(db, { workerId: "platform_parallel_b", limit: 1, leaseMs: 30_000, jobKinds: ["execute_agent_run"] }),
  ]);

  assert.deepEqual(new Set([...left, ...right].map((job) => job.jobId)), new Set([
    "job_conversation_parallel_a_0", "job_conversation_parallel_b_0",
  ]));
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
  const [claimed] = await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_a", limit: 1, leaseMs: 30_000 });
  await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").execute();
  assert.deepEqual(await completeJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_a", attemptCount: claimed!.attemptCount,
    now: new Date(0),
  } as never), { kind: "lease_lost" });
  assert.deepEqual(await heartbeatJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_a", attemptCount: claimed!.attemptCount, leaseMs: 30_000,
    now: new Date("2100-01-01T00:00:00.000Z"),
  } as never), { kind: "lease_lost" });
});

test("a replacement Worker with the same configured owner fences stale claim attempts", async () => {
  await insertJob();
  const [first] = await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_same", limit: 1, leaseMs: 30_000 });
  await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").execute();
  const [replacement] = await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_same", limit: 1, leaseMs: 30_000 });
  assert.equal(replacement?.attemptCount, (first?.attemptCount ?? 0) + 1);
  assert.deepEqual(await heartbeatJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_same", attemptCount: first!.attemptCount, leaseMs: 30_000,
  }), { kind: "lease_lost" });
  assert.deepEqual(await completeJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_same", attemptCount: first!.attemptCount,
  }), { kind: "lease_lost" });
});

test("persisted job failures use a required registered-material redactor", async () => {
  await insertJob();
  const [claimed] = await claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_a", limit: 1, leaseMs: 30_000 });
  const secret = "sentinel-secret-0123456789";
  assert.deepEqual(await failJob(db, {
    tenantId: "tenant_jobs", jobId: "job_1", workerId: "worker_a", attemptCount: claimed!.attemptCount,
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
