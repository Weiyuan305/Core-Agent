import assert from "node:assert/strict";
import test from "node:test";

import { REMOVED_RUNTIME_IMAGE_REF } from "@core-agent/runtime-core";

import { handleReconcileRuntime } from "../src/handlers/reconcile-runtime.js";

const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;

for (const command of ["start", "stop", "restart", "delete"] as const) {
  test(`reconciliation executes persisted ${command} intent with a stable effect operation`, async () => {
    const kinds: string[] = [];
    const operationIds: string[] = [];
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 2, observedState: command === "start" ? "stopped" : "ready", desiredState: command === "stop" ? "stopped" : command === "delete" ? "deleted" : "running" }),
      supervisor: async (request) => {
        kinds.push(request.kind); operationIds.push(request.operation_id);
        const inspecting = request.kind === "inspect";
        return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1,
          exists: inspecting ? true : command !== "delete",
          lifecycle: inspecting ? (command === "start" ? "stopped" : "running") : command === "stop" ? "stopped" : command === "delete" ? "removed" : "running",
          health: "healthy", image_ref: !inspecting && command === "delete" ? REMOVED_RUNTIME_IMAGE_REF : imageRef, ...(!inspecting && command === "delete" ? {} : { private_origin: "http://core-agent-runtime-abcd:8642" }) } };
      },
      reprovision: async () => { throw new Error("not expected"); },
      isCurrent: async () => true,
      succeed: async () => true, retry: async () => true, fail: async () => true,
    }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 2, command }, new AbortController().signal);
    assert.equal(result.kind, "succeeded");
    assert.deepEqual(kinds, ["inspect", command]);
    assert.match(operationIds[0]!, /^op_[a-f0-9]{48}$/);
    assert.match(operationIds[1]!, /^op_[a-f0-9]{48}$/);
    assert.notEqual(operationIds[0], operationIds[1]);
  });
}

test("retryable inspect failure reschedules without issuing an effect", async () => {
  let effects = 0; let retries = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => {
      effects += request.kind === "inspect" ? 0 : 1;
      return { protocol_version: 1, operation_id: request.operation_id, outcome: "failed", code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary: "Supervisor unavailable" };
    },
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, succeed: async () => true,
    retry: async () => { retries += 1; return true; }, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start" }, new AbortController().signal);
  assert.equal(result.kind, "retry"); assert.equal(effects, 0); assert.equal(retries, 1);
});

test("missing desired-running runtime reprovisions from stored facts instead of lifecycle start", async () => {
  const kinds: string[] = []; let reprovisions = 0;
  const observation = { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" };
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { ...observation, exists: false, lifecycle: "removed", image_ref: REMOVED_RUNTIME_IMAGE_REF } }; },
    reprovision: async () => { reprovisions += 1; return { protocol_version: 1, operation_id: "op_reprovision", outcome: "accepted", observation }; }, isCurrent: async () => true,
    succeed: async () => true, retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start" }, new AbortController().signal);
  assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(reprovisions, 1);
});

for (const [command, lifecycle, exists] of [["start", "running", true], ["stop", "stopped", true], ["delete", "removed", false]] as const) {
  test(`${command} completes without replay when inspect already proves the effect`, async () => {
    const kinds: string[] = []; let completions = 0;
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: command === "start" ? "ready" : command === "stop" ? "stopped" : "deleted", desiredState: command === "stop" ? "stopped" : command === "delete" ? "deleted" : "running" }),
      supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists, lifecycle, health: "healthy", image_ref: exists ? imageRef : REMOVED_RUNTIME_IMAGE_REF, ...(lifecycle === "running" ? { private_origin: "http://172.30.0.4:8642" } : {}) } }; },
      reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true,
      succeed: async () => { completions += 1; return true; }, retry: async () => true, fail: async () => true,
    }, { tenantId: "tenant_a", jobId: "job_noop", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command }, new AbortController().signal);
    assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(completions, 1);
  });
}

test("restart executes its durable effect even when inspect is already running", async () => {
  const kinds: string[] = [];
  await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }; },
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, succeed: async () => true, retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_restart", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command: "restart" }, new AbortController().signal);
  assert.deepEqual(kinds, ["inspect", "restart"]);
});

test("a newer command accepted during inspect suppresses the stale external effect", async () => {
  const kinds: string[] = []; let superseded = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageRef } }; },
    reprovision: async () => { throw new Error("stale reprovision must not execute"); },
    isCurrent: async () => false,
    succeed: async (_job, response) => { assert.equal(response, undefined); superseded += 1; return true; },
    retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_stale", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start" }, new AbortController().signal);
  assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(superseded, 1);
});

for (const health of ["unknown", "degraded", "unhealthy"] as const) {
  test(`running ${health} observation never advances runtime readiness`, async () => {
    let succeeded = 0; let retried = 0;
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
      supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }),
      reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true,
      succeed: async () => { succeeded += 1; return true; }, retry: async () => { retried += 1; return true; }, fail: async () => true,
    }, { tenantId: "tenant_a", jobId: "job_health", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start" }, new AbortController().signal);
    assert.equal(result.kind, "retry"); assert.equal(succeeded, 0); assert.equal(retried, 1);
  });
}

test("missing observation rejects the stored image digest instead of the removed sentinel", async () => {
  let failed = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "deleted" }),
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: false, lifecycle: "removed", health: "unknown", image_ref: imageRef } }),
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, succeed: async () => true, retry: async () => true,
    fail: async () => { failed += 1; return true; },
  }, { tenantId: "tenant_a", jobId: "job_missing_digest", attemptCount: 5, maxAttempts: 5, targetCommandVersion: 1, command: "delete" }, new AbortController().signal);
  assert.equal(result.kind, "failed"); assert.equal(failed, 1);
});
