import assert from "node:assert/strict";
import test from "node:test";

import { claimPlatformWorkerJobs } from "@core-agent/runtime-core";

import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";

let harness: IntegrationHarness;

async function poll(
  predicate: () => Promise<boolean> | boolean,
  category: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${category}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readyConversation() {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  const conversation = await harness.createConversation({
    tenant_id: provisioned.tenant_id,
    profile_id: provisioned.profile_ids[0]!,
  });
  return { provisioned, conversation };
}

test.before(async () => {
  harness = await createIntegrationHarness("recovery");
});

test.after(async () => {
  await harness?.close();
});

test("Worker exit after claim permits lease reclaim", async () => {
  await harness.stopWorker();
  const provisioned = await harness.provisionSyntheticB2B();
  const claimed = await claimPlatformWorkerJobs(harness.db, {
    workerId: "worker_exited_after_claim",
    limit: 1,
    leaseMs: 30_000,
    jobKinds: ["provision_runtime"],
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.payloadRef, provisioned.runtime_id);

  await harness.db.updateTable("worker_jobs").set({
    lease_expires_at: new Date(0),
  }).where("tenant_id", "=", provisioned.tenant_id)
    .where("job_id", "=", claimed[0]!.jobId).execute();
  await harness.startWorker("worker_reclaimer");
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  const job = await harness.db.selectFrom("worker_jobs")
    .select(["status", "attempt_count", "lease_owner"])
    .where("job_id", "=", claimed[0]!.jobId).executeTakeFirstOrThrow();
  assert.deepEqual(job, { status: "succeeded", attempt_count: 2, lease_owner: null });
});

test("API restart does not affect an in-flight Worker Run", async () => {
  const { provisioned, conversation } = await readyConversation();
  const releaseHermes = harness.fakeHermes.holdNextSuccess();
  try {
    const callsBefore = harness.fakeHermes.executionCallCount;
    const run = await harness.createRun(
      conversation.conversation_id,
      "Synthetic API restart",
      { tenantId: provisioned.tenant_id },
    );
    await poll(
      () => harness.fakeHermes.executionCallCount > callsBefore,
      "in-flight Hermes request",
    );
    await harness.restartApi();
    releaseHermes();
    await harness.worker.untilRunStatus(run.run_id, "succeeded");
    assert.equal((await harness.getRun(run.run_id)).status, "succeeded");
  } finally {
    releaseHermes();
  }
});

test("missed fake notification still delivers committed PostgreSQL events", async () => {
  const { provisioned, conversation } = await readyConversation();
  const waitsBefore = harness.notifier.waitCount;
  harness.notifier.dropNext(20);
  const pending = harness.readEvents(conversation.conversation_id, {
    afterSequence: 1,
    stopAfterType: "run.completed",
    tenantId: provisioned.tenant_id,
  });
  await poll(
    () => harness.notifier.waitCount > waitsBefore,
    "SSE notifier registration",
  );
  const run = await harness.createRun(
    conversation.conversation_id,
    "Synthetic missed wake",
    { tenantId: provisioned.tenant_id },
  );
  const received = await pending;
  assert.equal(received.events.at(-1)?.event_type, "run.completed");
  assert(received.events.some((event) => event.run_id === run.run_id));
});

test("Outbox dispatcher restart emits a wake hint without duplicating ProductEvent", async () => {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  await harness.stopWorker();
  const conversation = await harness.createConversation({
    tenant_id: provisioned.tenant_id,
    profile_id: provisioned.profile_ids[0]!,
  });
  const streamId = `conversation_${conversation.conversation_id}`;
  const before = await harness.db.selectFrom("product_events")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("tenant_id", "=", provisioned.tenant_id)
    .where("stream_id", "=", streamId).executeTakeFirstOrThrow();
  assert.equal(before.count, "1");
  const hintsBefore = harness.notifier.hints.length;

  await harness.startWorker("worker_outbox_restart");
  await poll(
    () => harness.notifier.hints.length > hintsBefore
      && harness.notifier.hints.some((hint) => hint.stream_id === streamId),
    "outbox wake hint after restart",
  );
  const after = await harness.db.selectFrom("product_events")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("tenant_id", "=", provisioned.tenant_id)
    .where("stream_id", "=", streamId).executeTakeFirstOrThrow();
  assert.equal(after.count, "1");
});

test("retryable Supervisor inspection retries before dispatch within its ceiling", async () => {
  const { provisioned, conversation } = await readyConversation();
  harness.fakeSupervisor.enqueue({
    kind: "reject",
    retryable: true,
    summary: "Synthetic inspection dependency outage",
  });
  const supervisorBefore = harness.fakeSupervisor.requests.length;
  const hermesBefore = harness.hermesTransportAttempts.filter(
    (kind) => kind === "execution",
  ).length;
  const run = await harness.createRun(
    conversation.conversation_id,
    "Synthetic inspection retry",
    { tenantId: provisioned.tenant_id },
  );
  const retrying = await harness.worker.untilRunJobStatus(run.run_id, "retrying");
  assert.equal(retrying.effect_state, "pre_effect");
  await harness.db.updateTable("worker_jobs").set({ next_attempt_at: new Date(0) })
    .where("run_id", "=", run.run_id).execute();
  await harness.worker.untilRunStatus(run.run_id, "succeeded");
  const job = await harness.db.selectFrom("worker_jobs")
    .select(["attempt_count", "max_attempts", "status"])
    .where("run_id", "=", run.run_id).executeTakeFirstOrThrow();
  assert.equal(job.status, "succeeded");
  assert.equal(job.attempt_count, 2);
  assert(job.attempt_count <= job.max_attempts);
  assert.equal(harness.fakeSupervisor.requests.length - supervisorBefore, 2);
  assert.equal(
    harness.hermesTransportAttempts.filter((kind) => kind === "execution").length
      - hermesBefore,
    1,
  );
});

test("Hermes refusal before first delta is not replayed after dispatch", async () => {
  const { provisioned, conversation } = await readyConversation();
  await harness.fakeHermes.refuseConnections();
  const attemptsBefore = harness.hermesTransportAttempts.filter(
    (kind) => kind === "execution",
  ).length;
  try {
    const run = await harness.createRun(
      conversation.conversation_id,
      "Synthetic refused execution",
      { tenantId: provisioned.tenant_id },
    );
    await harness.worker.untilRunStatus(run.run_id, "failed");
    const job = await harness.db.selectFrom("worker_jobs")
      .select(["status", "attempt_count", "effect_state"])
      .where("run_id", "=", run.run_id).executeTakeFirstOrThrow();
    assert.deepEqual(job, {
      status: "failed",
      attempt_count: 1,
      effect_state: "unsafe_to_replay",
    });
    assert.equal(
      harness.hermesTransportAttempts.filter((kind) => kind === "execution").length
        - attemptsBefore,
      1,
    );
  } finally {
    await harness.fakeHermes.start();
  }
});

test("Hermes post-delta disconnect is not replayed after dispatch", async () => {
  const { provisioned, conversation } = await readyConversation();
  harness.fakeHermes.enqueue("post_delta_disconnect");
  const attemptsBefore = harness.hermesTransportAttempts.filter(
    (kind) => kind === "execution",
  ).length;
  const run = await harness.createRun(
    conversation.conversation_id,
    "Synthetic disconnect execution",
    { tenantId: provisioned.tenant_id },
  );
  await harness.worker.untilRunStatus(run.run_id, "failed");
  const job = await harness.db.selectFrom("worker_jobs")
    .select(["status", "attempt_count", "effect_state"])
    .where("run_id", "=", run.run_id).executeTakeFirstOrThrow();
  assert.deepEqual(job, {
    status: "failed",
    attempt_count: 1,
    effect_state: "unsafe_to_replay",
  });
  assert.equal(
    harness.hermesTransportAttempts.filter((kind) => kind === "execution").length
      - attemptsBefore,
    1,
  );
});

test("child retry creates a new Run and preserves its failed parent", async () => {
  const { provisioned, conversation } = await readyConversation();
  harness.fakeHermes.enqueue("non_event_stream");
  const parent = await harness.createRun(
    conversation.conversation_id,
    "Synthetic failed parent",
    { tenantId: provisioned.tenant_id },
  );
  await harness.worker.untilRunStatus(parent.run_id, "failed");
  const child = await harness.createRun(
    conversation.conversation_id,
    "Synthetic child retry",
    { tenantId: provisioned.tenant_id, parentRunId: parent.run_id },
  );
  await harness.worker.untilRunStatus(child.run_id, "succeeded");
  assert.notEqual(child.run_id, parent.run_id);
  assert.equal((await harness.getRun(parent.run_id)).status, "failed");
  const storedChild = await harness.getRun(child.run_id);
  assert.equal(storedChild.status, "succeeded");
  assert.equal(storedChild.parent_run_id, parent.run_id);
});

test("foreign tenant and stream wakeups never cross an SSE stream", async () => {
  const first = await readyConversation();
  const second = await readyConversation();
  const waitsBefore = harness.notifier.waitCount;
  const firstPending = harness.readEvents(first.conversation.conversation_id, {
    afterSequence: 1,
    stopAfterType: "run.completed",
    tenantId: first.provisioned.tenant_id,
  });
  await poll(() => harness.notifier.waitCount > waitsBefore, "isolated SSE wait");

  const foreignRun = await harness.createRun(
    second.conversation.conversation_id,
    "Synthetic foreign stream",
    { tenantId: second.provisioned.tenant_id },
  );
  await harness.worker.untilRunStatus(foreignRun.run_id, "succeeded");
  const stillPending = Symbol("still pending");
  assert.equal(await Promise.race([
    firstPending,
    new Promise<typeof stillPending>((resolve) => setTimeout(() => resolve(stillPending), 125)),
  ]), stillPending);

  const ownRun = await harness.createRun(
    first.conversation.conversation_id,
    "Synthetic own stream",
    { tenantId: first.provisioned.tenant_id },
  );
  const received = await firstPending;
  assert(received.events.every(
    (event) => event.tenant_id === first.provisioned.tenant_id
      && event.conversation_id === first.conversation.conversation_id,
  ));
  assert(received.events.some((event) => event.run_id === ownRun.run_id));
  assert(received.events.every((event) => event.run_id !== foreignRun.run_id));
});
