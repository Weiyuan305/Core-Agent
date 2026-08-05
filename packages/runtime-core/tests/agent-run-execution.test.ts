import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
  claimJobs,
  createRedactor,
  createRuntimeDatabase,
  WorkerAgentRunRepository,
  type ClaimedJob,
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
const executionNow = new Date("2026-08-05T01:30:00.000Z");

async function setupExecution(tenantId: string) {
  const { profileId } = await seedReadyTenant(db, tenantId);
  await db.insertInto("secret_references").values([{
    tenant_id: tenantId,
    reference_id: `ingress_${tenantId}`,
    purpose: "integration",
    version: 1,
    status: "active",
    created_at: admissionNow,
    updated_at: admissionNow,
  }, {
    tenant_id: tenantId,
    reference_id: "provider_secret_admission",
    purpose: "provider_credential",
    version: 1,
    status: "active",
    created_at: admissionNow,
    updated_at: admissionNow,
  }]).execute();
  const context = serviceContext(tenantId);
  const conversation = await createConversation({ db, now: () => admissionNow }, context, withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `idem_conversation_${tenantId}`,
    tenant_id: tenantId,
    profile_id: profileId,
  }));
  const run = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, context, conversation.conversation_id, withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: `idem_run_${tenantId}`,
    client_request_id: `client_run_${tenantId}`,
    input_message: { client_message_id: `client_message_${tenantId}`, content: "Keep the exact user prompt." },
  }));
  const claimed = await claimJobs(db, { tenantId, workerId: "worker_execute", limit: 1, leaseMs: 300_000 });
  assert.equal(claimed.length, 1);
  const job = claimed[0];
  assert.equal(job?.jobKind, "execute_agent_run");
  return {
    tenantId,
    run,
    conversation,
    job: job as Extract<ClaimedJob, { jobKind: "execute_agent_run" }>,
    repository: new WorkerAgentRunRepository(db, providerCatalog, createRedactor([]), () => executionNow),
  };
}

test.beforeEach(async () => resetAdmissionDatabase(pool));
test.after(async () => db.destroy());

test("Agent Run execution atomically begins, persists ordered unsafe deltas, and completes one assistant Message", async () => {
  const setup = await setupExecution("tenant_execute_lifecycle");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", attemptCount: setup.job.attemptCount, runId: setup.run.run_id };

  const begun = await setup.repository.begin(ref);
  assert.equal(begun.kind, "admitted");
  if (begun.kind !== "admitted") return;
  assert.equal(begun.facts.content, "Keep the exact user prompt.");
  assert.equal(begun.facts.profileRef, `hermes_${setup.tenantId}`);
  assert.equal(begun.facts.modelId, "model_admission");
  assert.equal(begun.facts.timeoutMs, 10_000);
  assert.equal(begun.facts.ingressSecretRef.purpose, "hermes_ingress");

  assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
  assert.deepEqual(await setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "Hello"), { kind: "updated" });
  assert.deepEqual(await setup.repository.persistDelta(ref, begun.facts.assistantMessageId, " there"), { kind: "updated" });
  assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.tenantId).execute().then((rows) => rows.length), 1, "no partial assistant Message");
  assert.deepEqual(await setup.repository.complete(ref, begun.facts, "Hello there"), { kind: "updated" });

  const storedRun = await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", setup.tenantId).where("run_id", "=", setup.run.run_id).executeTakeFirstOrThrow();
  assert.equal(storedRun.status, "succeeded");
  assert.equal(storedRun.started_at?.toISOString(), executionNow.toISOString());
  assert.equal(storedRun.finished_at?.toISOString(), executionNow.toISOString());
  assert.equal(storedRun.resource_version, "3");
  const assistant = await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.tenantId).where("role", "=", "assistant").executeTakeFirstOrThrow();
  assert.equal(assistant.message_id, begun.facts.assistantMessageId);
  assert.equal(assistant.status, "completed");
  assert.equal(assistant.content, "Hello there");
  const session = await db.selectFrom("sessions").selectAll().where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow();
  assert.equal(session.last_active_at.toISOString(), executionNow.toISOString());
  assert.equal(session.resource_version, "2");
  const storedJob = await db.selectFrom("worker_jobs").selectAll().where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow();
  assert.equal(storedJob.effect_state, "unsafe_to_replay");
  assert.equal(storedJob.status, "succeeded");
  assert.equal(storedJob.lease_owner, null);
  assert.deepEqual(
    await db.selectFrom("product_events").select("event_type").where("tenant_id", "=", setup.tenantId).orderBy("sequence").execute().then((rows) => rows.map((row) => row.event_type)),
    ["conversation.created", "message.created", "run.queued", "run.started", "message.delta", "message.delta", "message.completed", "run.completed"],
  );
  assert.equal(await db.selectFrom("audit_events").selectAll().where("tenant_id", "=", setup.tenantId).execute().then((rows) => rows.length), 3);
  assert.equal(await db.selectFrom("outbox").selectAll().where("tenant_id", "=", setup.tenantId).execute().then((rows) => rows.length), 8);
});

test("safe pre-effect retry of an already-running Run does not duplicate run.started", async () => {
  const setup = await setupExecution("tenant_execute_safe_retry");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", attemptCount: setup.job.attemptCount, runId: setup.run.run_id };
  assert.equal((await setup.repository.begin(ref)).kind, "admitted");
  assert.deepEqual(await setup.repository.retry(ref, "Dependency unavailable", executionNow), { kind: "updated" });
  const reclaimed = await claimJobs(db, { tenantId: setup.tenantId, workerId: "worker_retry", limit: 1, leaseMs: 300_000 });
  assert.equal(reclaimed.length, 1);
  const retryRef = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_retry", attemptCount: reclaimed[0]!.attemptCount, runId: setup.run.run_id };
  assert.equal((await setup.repository.begin(retryRef)).kind, "admitted");
  assert.equal(
    await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "=", "run.started").execute().then((rows) => rows.length),
    1,
  );
});

test("dispatch mark rejects a queued Run before begin", { timeout: 5_000 }, async () => {
  const setup = await setupExecution("tenant_execute_dispatch_before_begin");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", attemptCount: setup.job.attemptCount, runId: setup.run.run_id };

  await assert.rejects(setup.repository.markDispatched(ref), /Run is not running/);
  assert.deepEqual(
    await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow(),
    { effect_state: "pre_effect" },
  );
});

test("dispatch is durably marked unsafe before any delta and pre-dispatch deltas are rejected", { timeout: 5_000 }, async () => {
  const setup = await setupExecution("tenant_execute_dispatch_boundary");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  const begun = await setup.repository.begin(ref);
  assert.equal(begun.kind, "admitted");
  if (begun.kind !== "admitted") return;

  await assert.rejects(
    setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "too early"),
    /requires durable dispatch/,
  );
  assert.deepEqual(
    await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow(),
    { effect_state: "pre_effect" },
  );

  assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
  assert.deepEqual(
    await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow(),
    { effect_state: "unsafe_to_replay" },
  );
  assert.deepEqual(await setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "after mark"), { kind: "updated" });
});

test("dispatch mark loses authority when a worker-job row wait crosses the database lease", { timeout: 5_000 }, async () => {
  const setup = await setupExecution("tenant_execute_mark_wait");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  assert.equal((await setup.repository.begin(ref)).kind, "admitted");
  await pool.query(
    "update worker_jobs set lease_expires_at = clock_timestamp() + interval '150 milliseconds' where tenant_id = $1 and job_id = $2",
    [setup.tenantId, setup.job.jobId],
  );

  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select job_id from worker_jobs where tenant_id = $1 and job_id = $2 for update", [setup.tenantId, setup.job.jobId]);
    const pending = setup.repository.markDispatched(ref);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await blocker.query("commit");
    assert.deepEqual(await pending, { kind: "lease_lost" });
  } finally {
    try { await blocker.query("rollback"); } catch { /* transaction already closed */ }
    blocker.release();
  }
  assert.deepEqual(
    await db.selectFrom("worker_jobs").select(["status", "effect_state"]).where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow(),
    { status: "running", effect_state: "pre_effect" },
  );
});

test("a crash after dispatch mark is reclaimed as unsafe and cannot become a safe retry", { timeout: 5_000 }, async () => {
  const setup = await setupExecution("tenant_execute_mark_crash");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  assert.equal((await setup.repository.begin(ref)).kind, "admitted");
  assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
  await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", setup.tenantId).where("job_id", "=", setup.job.jobId).execute();

  const [reclaimed] = await claimJobs(db, { tenantId: setup.tenantId, workerId: "worker_recovery", limit: 1, leaseMs: 300_000 });
  assert.equal(reclaimed?.effectState, "unsafe_to_replay");
  assert.equal(reclaimed?.recoveryOnly, false);
  assert.deepEqual(await setup.repository.fail({ ...ref, workerId: "worker_recovery" }, "Unsafe dispatched request cannot replay"), { kind: "updated" });
});

test("unsafe recovery failure atomically terminalizes Run and job without an assistant Message", async () => {
  const setup = await setupExecution("tenant_execute_unsafe_failure");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  const begun = await setup.repository.begin(ref);
  assert.equal(begun.kind, "admitted");
  if (begun.kind !== "admitted") return;
  assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
  assert.deepEqual(await setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "partial"), { kind: "updated" });
  assert.deepEqual(await setup.repository.fail(ref, "Bearer private-secret socket provider-body"), { kind: "updated" });

  const storedRun = await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", setup.tenantId).where("run_id", "=", setup.run.run_id).executeTakeFirstOrThrow();
  assert.equal(storedRun.status, "failed");
  assert.equal(storedRun.failure_summary, "[REDACTED] socket provider-body");
  assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.tenantId).where("role", "=", "assistant").execute().then((rows) => rows.length), 0);
  assert.deepEqual(
    await db.selectFrom("product_events").select("event_type").where("tenant_id", "=", setup.tenantId).orderBy("sequence").execute().then((rows) => rows.map((row) => row.event_type).slice(-3)),
    ["run.started", "message.delta", "run.failed"],
  );
  const failedEvent = await db.selectFrom("product_events").select("payload").where("tenant_id", "=", setup.tenantId).where("event_type", "=", "run.failed").executeTakeFirstOrThrow();
  assert.doesNotMatch(JSON.stringify(failedEvent.payload), /private-secret/);
});

test("database-clock lease loss before begin, delta, completion, and failure writes no stale transaction", async () => {
  for (const phase of ["begin", "delta", "complete", "fail"] as const) {
    const setup = await setupExecution(`tenant_execute_lease_${phase}`);
    const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
    const begun = phase === "begin" ? undefined : await setup.repository.begin(ref);
    if (begun !== undefined) assert.equal(begun.kind, "admitted");
    if (phase === "delta" || phase === "complete") assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
    await db.updateTable("worker_jobs").set({ lease_expires_at: new Date("2000-01-01T00:00:00.000Z") }).where("tenant_id", "=", setup.tenantId).execute();
    const result = phase === "begin"
      ? await setup.repository.begin(ref)
      : phase === "delta"
        ? await setup.repository.persistDelta(ref, (begun as Extract<typeof begun, { kind: "admitted" }>).facts.assistantMessageId, "stale")
        : phase === "complete"
          ? await setup.repository.complete(ref, (begun as Extract<typeof begun, { kind: "admitted" }>).facts, "stale")
          : await setup.repository.fail(ref, "stale failure");
    assert.deepEqual(result, { kind: "lease_lost" });
    const storedRun = await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", setup.tenantId).executeTakeFirstOrThrow();
    assert.equal(storedRun.status, phase === "begin" ? "queued" : "running");
    assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "in", ["message.delta", "message.completed", "run.completed", "run.failed"]).execute().then((rows) => rows.length), 0);
  }
});

test("lease expiry while waiting on the Run row rolls back delta, completion, and failure transactions", async () => {
  for (const phase of ["delta", "complete", "fail"] as const) {
    const setup = await setupExecution(`tenant_execute_wait_${phase}`);
    const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
    const begun = await setup.repository.begin(ref);
    assert.equal(begun.kind, "admitted");
    if (begun.kind !== "admitted") continue;
    if (phase === "delta" || phase === "complete") assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
    if (phase === "complete") await setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "durable");

    await pool.query("update worker_jobs set lease_expires_at = clock_timestamp() + interval '150 milliseconds' where tenant_id = $1 and job_id = $2", [setup.tenantId, setup.job.jobId]);
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select run_id from agent_runs where tenant_id = $1 and run_id = $2 for update", [setup.tenantId, setup.run.run_id]);
      const pending = phase === "delta"
        ? setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "stale")
        : phase === "complete"
          ? setup.repository.complete(ref, begun.facts, "durable")
          : setup.repository.fail(ref, "stale failure");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await blocker.query("commit");
      assert.deepEqual(await pending, { kind: "lease_lost" });
    } finally {
      try { await blocker.query("rollback"); } catch { /* transaction already closed */ }
      blocker.release();
    }
    const run = await db.selectFrom("agent_runs").select("status").where("tenant_id", "=", setup.tenantId).where("run_id", "=", setup.run.run_id).executeTakeFirstOrThrow();
    assert.equal(run.status, "running");
    assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.tenantId).where("role", "=", "assistant").execute().then((rows) => rows.length), 0);
    assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "in", ["message.completed", "run.completed", "run.failed"]).execute().then((rows) => rows.length), 0);
    assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "=", "message.delta").execute().then((rows) => rows.length), phase === "complete" ? 1 : 0);
  }
});

test("lease expiry while message.delta waits on the stream sequence rolls back effect state, event, and Outbox", async () => {
  const setup = await setupExecution("tenant_execute_wait_stream");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  const begun = await setup.repository.begin(ref);
  assert.equal(begun.kind, "admitted");
  if (begun.kind !== "admitted") return;
  assert.deepEqual(await setup.repository.markDispatched(ref), { kind: "updated" });
  const beforeOutbox = await db.selectFrom("outbox").selectAll().where("tenant_id", "=", setup.tenantId).execute().then((rows) => rows.length);
  await pool.query("update worker_jobs set lease_expires_at = clock_timestamp() + interval '150 milliseconds' where tenant_id = $1 and job_id = $2", [setup.tenantId, setup.job.jobId]);

  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query("select stream_id from stream_sequences where tenant_id = $1 and stream_id = $2 for update", [setup.tenantId, `conversation_${setup.conversation.conversation_id}`]);
    const pending = setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "must roll back");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await blocker.query("commit");
    assert.deepEqual(await pending, { kind: "lease_lost" });
  } finally {
    try { await blocker.query("rollback"); } catch { /* transaction already closed */ }
    blocker.release();
  }
  const job = await db.selectFrom("worker_jobs").select(["status", "effect_state"]).where("tenant_id", "=", setup.tenantId).where("job_id", "=", setup.job.jobId).executeTakeFirstOrThrow();
  assert.deepEqual(job, { status: "running", effect_state: "unsafe_to_replay" });
  assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "=", "message.delta").execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("outbox").selectAll().where("tenant_id", "=", setup.tenantId).execute().then((rows) => rows.length), beforeOutbox);
});

test("two sequential Runs in one Conversation bind durable delta accounting only to the current Run", async () => {
  const setup = await setupExecution("tenant_execute_two_runs");
  const firstRef = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  const first = await setup.repository.begin(firstRef);
  assert.equal(first.kind, "admitted");
  if (first.kind !== "admitted") return;
  await setup.repository.markDispatched(firstRef);
  await setup.repository.persistDelta(firstRef, first.facts.assistantMessageId, "first answer");
  await setup.repository.complete(firstRef, first.facts, "first answer");

  const secondRun = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, serviceContext(setup.tenantId), setup.conversation.conversation_id, withPayloadHash({
    schema_version: 1 as const, idempotency_key: "idem_second_run", client_request_id: "client_second_run",
    input_message: { client_message_id: "client_message_second_run", content: "Second prompt" },
  }));
  const secondJobs = await claimJobs(db, { tenantId: setup.tenantId, workerId: "worker_second", limit: 1, leaseMs: 300_000 });
  assert.equal(secondJobs.length, 1);
  const secondRef = { tenantId: setup.tenantId, jobId: secondJobs[0]!.jobId, workerId: "worker_second", runId: secondRun.run_id };
  const second = await setup.repository.begin(secondRef);
  assert.equal(second.kind, "admitted");
  if (second.kind !== "admitted") return;
  await setup.repository.markDispatched(secondRef);
  assert.deepEqual(await setup.repository.persistDelta(secondRef, second.facts.assistantMessageId, "second answer"), { kind: "updated" });
  assert.deepEqual(await setup.repository.complete(secondRef, second.facts, "second answer"), { kind: "updated" });
  const assistants = await db.selectFrom("messages").select(["run_id", "content"]).where("tenant_id", "=", setup.tenantId).where("role", "=", "assistant").orderBy("created_at").execute();
  assert.deepEqual(assistants, [{ run_id: setup.run.run_id, content: "first answer" }, { run_id: secondRun.run_id, content: "second answer" }]);
});

test("begin fails closed and rolls back run.started when current tenant, Actor, or admin Membership authority is inactive", async () => {
  for (const authority of ["tenant", "actor", "membership", "role"] as const) {
    const setup = await setupExecution(`tenant_execute_authority_${authority}`);
    if (authority === "tenant") await db.updateTable("tenants").set({ status: "suspended" }).where("tenant_id", "=", setup.tenantId).execute();
    if (authority === "actor") await db.updateTable("actors").set({ status: "disabled" }).where("tenant_id", "=", setup.tenantId).where("actor_id", "=", "core_agent_provisioner").execute();
    if (authority === "membership") await db.updateTable("memberships").set({ status: "suspended" }).where("tenant_id", "=", setup.tenantId).where("membership_id", "=", "core_agent_provisioner_admin").execute();
    if (authority === "role") await db.updateTable("memberships").set({ roles: ["student"] }).where("tenant_id", "=", setup.tenantId).where("membership_id", "=", "core_agent_provisioner_admin").execute();
    const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
    await assert.rejects(setup.repository.begin(ref));
    const run = await db.selectFrom("agent_runs").select("status").where("tenant_id", "=", setup.tenantId).where("run_id", "=", setup.run.run_id).executeTakeFirstOrThrow();
    assert.equal(run.status, "queued");
    assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "=", "run.started").execute().then((rows) => rows.length), 0);
  }
});

test("begin fails closed without reflecting tenant resource, runtime, provider, or secret inconsistencies", async () => {
  for (const inconsistency of ["profile", "session", "runtime", "provider", "provider_secret", "ingress_secret"] as const) {
    const setup = await setupExecution(`tenant_execute_inconsistent_${inconsistency}`);
    if (inconsistency === "profile") await db.updateTable("profiles").set({ status: "suspended" }).where("tenant_id", "=", setup.tenantId).execute();
    if (inconsistency === "session") await db.updateTable("sessions").set({ expires_at: new Date("2000-01-01T00:00:00.000Z") }).where("tenant_id", "=", setup.tenantId).execute();
    if (inconsistency === "runtime") await db.updateTable("runtime_containers").set({ health_status: "unhealthy" }).where("tenant_id", "=", setup.tenantId).execute();
    if (inconsistency === "provider") await db.updateTable("profiles").set({ model_id: "model_unmanaged" }).where("tenant_id", "=", setup.tenantId).execute();
    if (inconsistency === "provider_secret") await db.updateTable("secret_references").set({ status: "revoked" }).where("tenant_id", "=", setup.tenantId).where("purpose", "=", "provider_credential").execute();
    if (inconsistency === "ingress_secret") await db.updateTable("secret_references").set({ status: "revoked" }).where("tenant_id", "=", setup.tenantId).where("purpose", "=", "integration").execute();
    const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
    await assert.rejects(setup.repository.begin(ref), (error: unknown) => {
      assert.doesNotMatch(String(error), /provider_secret_admission|ingress_tenant|model_unmanaged/);
      return true;
    });
    assert.equal(await db.selectFrom("agent_runs").select("status").where("tenant_id", "=", setup.tenantId).where("run_id", "=", setup.run.run_id).executeTakeFirstOrThrow().then((row) => row.status), "queued");
  }
});

test("tampered in-memory completion facts roll back without an assistant Message or terminal event", async () => {
  const setup = await setupExecution("tenant_execute_tampered_facts");
  const ref = { tenantId: setup.tenantId, jobId: setup.job.jobId, workerId: "worker_execute", runId: setup.run.run_id };
  const begun = await setup.repository.begin(ref);
  assert.equal(begun.kind, "admitted");
  if (begun.kind !== "admitted") return;
  await setup.repository.markDispatched(ref);
  await setup.repository.persistDelta(ref, begun.facts.assistantMessageId, "answer");
  await assert.rejects(setup.repository.complete(ref, { ...begun.facts, assistantMessageId: "message_attacker" }, "answer"));
  assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.tenantId).where("role", "=", "assistant").execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.tenantId).where("event_type", "in", ["message.completed", "run.completed"]).execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("agent_runs").select("status").where("tenant_id", "=", setup.tenantId).where("run_id", "=", setup.run.run_id).executeTakeFirstOrThrow().then((row) => row.status), "running");
});
