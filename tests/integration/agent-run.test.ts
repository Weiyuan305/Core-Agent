import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import {
  SYNTHETIC_INGRESS_KEY,
  SYNTHETIC_MODEL_ID,
} from "./fixtures/synthetic-tenant.js";

let harness: IntegrationHarness;

test.before(async () => {
  harness = await createIntegrationHarness("agent-run");
});

test.after(async () => {
  await harness?.close();
});

test("provision, converse, stream, restart, and resume", async () => {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  const conversation = await harness.createConversation({
    tenant_id: provisioned.tenant_id,
    profile_id: provisioned.profile_ids[0]!,
  });
  const run = await harness.createRun(
    conversation.conversation_id,
    "Synthetic hello",
  );
  const firstConnection = await harness.readEvents(
    conversation.conversation_id,
    {
      afterSequence: 0,
      stopAfterType: "message.delta",
    },
  );
  await harness.restartApi();
  const resumed = await harness.readEvents(conversation.conversation_id, {
    afterSequence: firstConnection.lastSequence,
    stopAfterType: "run.completed",
  });

  assert.deepEqual(
    [...firstConnection.events, ...resumed.events].map(
      (event) => event.event_type,
    ),
    [
      "conversation.created",
      "message.created",
      "run.queued",
      "run.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.completed",
    ],
  );
  assert.equal((await harness.getRun(run.run_id)).status, "succeeded");

  const execution = harness.fakeHermes.requests.find(
    (request) => request.kind === "execution",
  );
  assert.deepEqual(execution, {
    kind: "execution",
    route: `/p/hermes_${provisioned.tenant_id}/v1/chat/completions`,
    profileRef: `hermes_${provisioned.tenant_id}`,
    sessionId: conversation.conversation_id.replace(
      /^conversation_/,
      "hermes_session_",
    ),
    modelId: SYNTHETIC_MODEL_ID,
    authorizationAccepted: true,
    bodyClosed: true,
  });
  assert.doesNotMatch(JSON.stringify(harness.fakeHermes.requests), new RegExp(SYNTHETIC_INGRESS_KEY));
});

test("malformed Hermes streams fail once after the dispatch boundary", async () => {
  for (const script of [
    "pre_delta_timeout",
    "invalid_json",
    "overlong_line",
    "non_event_stream",
  ] as const) {
    const provisioned = await harness.provisionSyntheticB2B();
    await harness.worker.untilRuntimeReady(provisioned.runtime_id);
    const conversation = await harness.createConversation({
      tenant_id: provisioned.tenant_id,
      profile_id: provisioned.profile_ids[0]!,
    });
    harness.fakeHermes.enqueue(script);
    const attemptsBefore = harness.hermesTransportAttempts.filter(
      (kind) => kind === "execution",
    ).length;
    const run = await harness.createRun(
      conversation.conversation_id,
      `Synthetic ${script}`,
      { tenantId: provisioned.tenant_id },
    );
    await harness.worker.untilRunStatus(run.run_id, "failed");
    const job = await harness.db.selectFrom("worker_jobs")
      .select(["status", "attempt_count", "effect_state"])
      .where("run_id", "=", run.run_id)
      .executeTakeFirstOrThrow();
    assert.deepEqual(job, {
      status: "failed",
      attempt_count: 1,
      effect_state: "unsafe_to_replay",
    }, script);
    assert.equal(
      harness.hermesTransportAttempts.filter((kind) => kind === "execution").length
        - attemptsBefore,
      1,
      script,
    );
  }
});
