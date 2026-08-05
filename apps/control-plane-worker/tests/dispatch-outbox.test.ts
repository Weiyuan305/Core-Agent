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

test("Outbox dispatcher rejects an impossible eleventh attempt before notification", async () => {
  let notifications = 0;
  await assert.rejects(dispatchOutbox({
    claim: async () => [{ tenantId: "tenant_a", outboxId: "outbox_a", streamId: "runtime_a", lastSequence: 7, attemptCount: 11 }],
    notify: async () => { notifications += 1; },
    delivered: async () => true,
    retry: async () => true,
  }, "worker_a"), /attemptCount/);
  assert.equal(notifications, 0);
});

test("Outbox dispatcher reports false delivered and retry fences without false success", async () => {
  let retryAfterNotification = 0;
  const result = await dispatchOutbox({
    claim: async () => [
      { tenantId: "tenant_a", outboxId: "outbox_ack_lost", streamId: "runtime_a", lastSequence: 7, attemptCount: 10 },
      { tenantId: "tenant_a", outboxId: "outbox_retry_lost", streamId: "runtime_a", lastSequence: 8, attemptCount: 9 },
    ],
    notify: async (payload) => {
      if (payload.includes('"last_committed_sequence":8')) throw new Error("synthetic notification failure");
    },
    delivered: async () => false,
    retry: async () => { retryAfterNotification += 1; return false; },
  }, "worker_a");

  assert.deepEqual(result, { delivered: 0, retried: 0 });
  assert.equal(retryAfterNotification, 1, "only the failed notification may request retry");
});
