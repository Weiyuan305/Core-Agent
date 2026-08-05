import assert from "node:assert/strict";
import test from "node:test";

import { dispatchOutbox } from "../src/handlers/dispatch-outbox.js";

test("Outbox wakeup exposes only tenant stream and committed sequence", async () => {
  let payload = "";
  const result = await dispatchOutbox({
    claim: async () => [{ tenantId: "tenant_a", outboxId: "outbox_a", streamId: "runtime_a", lastSequence: 7, attemptCount: 3 }],
    notify: async (value) => { payload = value; },
    delivered: async () => true,
    retry: async () => true,
  }, "worker_a");
  assert.deepEqual(result, { delivered: 1, retried: 0 });
  assert.deepEqual(JSON.parse(payload), { tenant_id: "tenant_a", stream_id: "runtime_a", last_committed_sequence: 7 });
});

test("Outbox dispatcher carries the captured claim attempt to delivered and retry mutations", async () => {
  const attempts: number[] = [];
  await dispatchOutbox({
    claim: async () => [{ tenantId: "tenant_a", outboxId: "outbox_delivered", streamId: "runtime_a", lastSequence: 7, attemptCount: 4 }, { tenantId: "tenant_a", outboxId: "outbox_retry", streamId: "runtime_a", lastSequence: 8, attemptCount: 5 }],
    notify: async (payload) => { if (payload.includes("8")) throw new Error("synthetic failure"); },
    delivered: async (row) => { attempts.push(row.attemptCount); return true; },
    retry: async (row) => { attempts.push(row.attemptCount); return true; },
  }, "worker_a");
  assert.deepEqual(attempts, [4, 5]);
});

test("Outbox dispatcher refuses a malformed claimed row without an attempt fence", async () => {
  await assert.rejects(dispatchOutbox({
    claim: async () => [{ tenantId: "tenant_a", outboxId: "outbox_a", streamId: "runtime_a", lastSequence: 7 }] as never,
    notify: async () => undefined,
    delivered: async () => true,
    retry: async () => true,
  }, "worker_a"), /attemptCount/);
});
