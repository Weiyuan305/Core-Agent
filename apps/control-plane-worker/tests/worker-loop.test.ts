import assert from "node:assert/strict";
import test from "node:test";

import { dispatchJob } from "../src/dispatch-job.js";
import { runWorkerLoop } from "../src/worker-loop.js";

test("worker claims at most eight jobs across tenants", async () => {
  const controller = new AbortController();
  const claims: number[] = [];
  let ticks = 0;
  await runWorkerLoop({
    tick: async () => { ticks += 1; },
    claim: async (limit) => { claims.push(limit); controller.abort(); return []; },
    dispatch: async () => undefined,
    wait: async () => undefined,
  }, controller.signal);
  assert.deepEqual(claims, [8]);
  assert.equal(ticks, 1);
});

test("dispatch heartbeat lease loss aborts work and suppresses terminal commit", async () => {
  let heartbeat: (() => Promise<void>) | undefined;
  let observedAbort = false;
  await dispatchJob({
    workerId: "worker_a",
    heartbeatEveryMs: 10_000,
    scheduleHeartbeat(callback) { heartbeat = callback; return () => undefined; },
    heartbeat: async () => "lease_lost",
    handle: async (_job, signal) => {
      await heartbeat?.();
      observedAbort = signal.aborted;
      return { kind: "succeeded" };
    },
  }, {
    tenantId: "tenant_a", jobId: "job_a", jobKind: "provision_runtime",
    runtimeCommand: null, payloadRef: "runtime_a", attemptCount: 1, maxAttempts: 5,
    targetCommandVersion: null, effectState: "pre_effect", recoveryOnly: false, leaseExpiresAt: new Date("2026-08-04T00:00:30.000Z"),
  }, new AbortController().signal);
  assert.equal(observedAbort, true);
});

test("abort during Worker tick or claim never dispatches newly returned work", async () => {
  for (const phase of ["tick", "claim"] as const) {
    const controller = new AbortController(); let dispatched = 0; let claims = 0;
    await runWorkerLoop({
      tick: async () => { if (phase === "tick") controller.abort(); },
      claim: async () => { claims += 1; if (phase === "claim") controller.abort(); return [{ jobId: "job_after_abort" }]; },
      dispatch: async () => { dispatched += 1; }, wait: async () => undefined,
    }, controller.signal);
    assert.equal(dispatched, 0, phase);
    assert.equal(claims, phase === "tick" ? 0 : 1, phase);
  }
});

test("already-aborted parent starts no heartbeat or handler effect", async () => {
  const controller = new AbortController(); controller.abort();
  let scheduled = 0; let handled = 0;
  await dispatchJob({
    workerId: "worker_a", heartbeatEveryMs: 10_000,
    scheduleHeartbeat: () => { scheduled += 1; return () => undefined; }, heartbeat: async () => "updated",
    handle: async () => { handled += 1; return { kind: "succeeded" }; },
  }, { tenantId: "tenant_a", jobId: "job_a", jobKind: "provision_runtime", runtimeCommand: null, targetCommandVersion: null, payloadRef: "runtime_a", attemptCount: 1, maxAttempts: 5, effectState: "pre_effect", recoveryOnly: false, leaseExpiresAt: new Date() }, controller.signal);
  assert.equal(scheduled, 0); assert.equal(handled, 0);
});

test("a free slot claims and starts new work while an earlier dispatch remains in flight", async () => {
  const controller = new AbortController();
  let claimCount = 0;
  let startedNew = false;
  const loop = runWorkerLoop({
    tick: async () => undefined,
    claim: async () => {
      claimCount += 1;
      if (claimCount === 1) return [{ jobId: "job_long" }];
      if (claimCount === 2) return [{ jobId: "job_new" }];
      return [];
    },
    dispatch: async (job, signal) => {
      if (job.jobId === "job_new") { startedNew = true; controller.abort(); return; }
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    wait: async () => undefined,
  }, controller.signal);
  await Promise.race([
    loop,
    new Promise<void>((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 100)),
  ]);
  await loop;

  assert.equal(startedNew, true);
  assert.equal(claimCount >= 2, true);
});

test("Outbox tick continues while all eight Worker slots contain long-running jobs", async () => {
  const controller = new AbortController();
  let ticks = 0;
  let claimed = false;
  const loop = runWorkerLoop({
    tick: async () => { ticks += 1; if (ticks === 2) controller.abort(); },
    claim: async () => {
      if (claimed) return [];
      claimed = true;
      return Array.from({ length: 8 }, (_, index) => ({ jobId: `job_long_${index}` }));
    },
    dispatch: async (_job, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    wait: async () => undefined,
  }, controller.signal);
  await Promise.race([
    loop,
    new Promise<void>((resolve) => setTimeout(() => { controller.abort(); resolve(); }, 100)),
  ]);
  await loop;

  assert.equal(ticks >= 2, true);
});

test("shutdown waits for every started dispatch to observe abort and finish cleanup", async () => {
  const controller = new AbortController();
  let cleaned = false;
  const loop = runWorkerLoop({
    tick: async () => undefined,
    claim: async () => [{ jobId: "job_cleanup" }],
    dispatch: async (_job, signal) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(signal.aborted, true);
      cleaned = true;
    },
    wait: async () => undefined,
  }, controller.signal);

  await loop;
  assert.equal(cleaned, true);
});

test("a rejected dispatch is observed and does not block later available work", async () => {
  const controller = new AbortController();
  let claims = 0;
  let completed = false;
  await runWorkerLoop({
    tick: async () => undefined,
    claim: async () => {
      claims += 1;
      if (claims === 1) return [{ jobId: "job_reject" }];
      if (claims === 2) return [{ jobId: "job_after_reject" }];
      controller.abort();
      return [];
    },
    dispatch: async (job) => {
      if (job.jobId === "job_reject") throw new Error("synthetic dispatch failure");
      completed = true;
    },
    wait: async () => undefined,
  }, controller.signal);

  assert.equal(completed, true);
});
