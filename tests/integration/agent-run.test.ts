import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";

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
});
