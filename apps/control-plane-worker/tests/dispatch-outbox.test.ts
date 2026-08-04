import assert from "node:assert/strict";
import test from "node:test";

import { dispatchOutbox } from "../src/handlers/dispatch-outbox.js";

test("Outbox wakeup exposes only tenant stream and committed sequence", async () => {
  let payload = "";
  const result = await dispatchOutbox({
    claim: async () => [{ tenantId: "tenant_a", outboxId: "outbox_a", streamId: "runtime_a", lastSequence: 7 }],
    notify: async (value) => { payload = value; },
    delivered: async () => true,
    retry: async () => true,
  }, "worker_a");
  assert.deepEqual(result, { delivered: 1, retried: 0 });
  assert.deepEqual(JSON.parse(payload), { tenant_id: "tenant_a", stream_id: "runtime_a", last_committed_sequence: 7 });
});
