import assert from "node:assert/strict";
import test from "node:test";

import {
  handleStopIdleB2cRuntime,
  type StopIdleB2cRuntimePort,
} from "../src/handlers/stop-idle-b2c-runtime.js";

const job = Object.freeze({
  tenantId: "tenant_idle",
  jobId: "job_idle",
  attemptCount: 1,
  maxAttempts: 5,
  payloadRef: "runtime_idle",
  effectState: "pre_effect" as const,
  recoveryOnly: false,
});

test("idle stop succeeds only through the repository recheck", async () => {
  const calls: string[] = [];
  const port: StopIdleB2cRuntimePort = {
    stop: async (input) => {
      calls.push(`${input.tenantId}:${input.runtimeId}:${input.workerId}`);
      return { kind: "stopped" };
    },
  };
  assert.deepEqual(
    await handleStopIdleB2cRuntime(port, job, new AbortController().signal, "worker_idle"),
    { kind: "succeeded" },
  );
  assert.deepEqual(calls, ["tenant_idle:runtime_idle:worker_idle"]);
});

test("idle stop treats changed activity as superseded and lease loss as failure", async () => {
  const superseded: StopIdleB2cRuntimePort = { stop: async () => ({ kind: "superseded" }) };
  assert.deepEqual(
    await handleStopIdleB2cRuntime(superseded, job, new AbortController().signal),
    { kind: "succeeded" },
  );
  const lost: StopIdleB2cRuntimePort = { stop: async () => ({ kind: "lease_lost" }) };
  assert.deepEqual(
    await handleStopIdleB2cRuntime(lost, job, new AbortController().signal),
    { kind: "failed", summary: "Worker job lease lost" },
  );
});

test("an aborted idle stop performs no repository work", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const port: StopIdleB2cRuntimePort = { stop: async () => { calls += 1; return { kind: "stopped" }; } };
  assert.deepEqual(await handleStopIdleB2cRuntime(port, job, controller.signal), {
    kind: "failed", summary: "Worker job lease lost",
  });
  assert.equal(calls, 0);
});
