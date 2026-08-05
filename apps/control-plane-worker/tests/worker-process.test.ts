import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerClock, createWorkerLeaseOwner } from "../src/server.js";

test("idle wait removes its abort listener after the timer resolves", async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];

  await createWorkerClock().wait(1, controller.signal);
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("already-aborted idle waits add no listener", async () => {
  const controller = new AbortController();
  controller.abort();
  let added = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];

  await createWorkerClock().wait(1, controller.signal);
  assert.equal(added, 0);
});

test("aborting after idle listener registration removes that listener", async () => {
  const controller = new AbortController();
  let removed = 0;
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];
  const wait = createWorkerClock().wait(10_000, controller.signal);
  controller.abort();
  await wait;
  assert.equal(removed, 1);
});

test("each Worker process has a bounded unique lease-owner incarnation", () => {
  const first = createWorkerLeaseOwner("worker_alpha", () => "11111111-1111-4111-8111-111111111111");
  const second = createWorkerLeaseOwner("worker_alpha", () => "22222222-2222-4222-8222-222222222222");
  assert.notEqual(first, second);
  assert.match(first, /^worker_alpha:[0-9a-f-]{36}$/);
  assert.equal(first.length <= 128, true);
  assert.throws(() => createWorkerLeaseOwner("invalid worker", () => "11111111-1111-4111-8111-111111111111"), /worker/i);
});
