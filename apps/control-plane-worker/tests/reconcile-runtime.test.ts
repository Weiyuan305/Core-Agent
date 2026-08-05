import assert from "node:assert/strict";
import test from "node:test";

import { REMOVED_RUNTIME_IMAGE_REF } from "@core-agent/runtime-core";

import { handleReconcileRuntime } from "../src/handlers/reconcile-runtime.js";

const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

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
      isCurrent: async () => true, markEffectDispatched: async () => true,
      succeed: async () => true, retry: async () => true, fail: async () => true,
    }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 2, command, effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
    assert.equal(result.kind, "succeeded");
    assert.deepEqual(kinds, ["inspect", command]);
    assert.match(operationIds[0]!, /^op_[a-f0-9]{48}$/);
    assert.match(operationIds[1]!, /^op_[a-f0-9]{48}$/);
    assert.notEqual(operationIds[0], operationIds[1]);
  });
}

test("external Runtime effects are durably marked before dispatch and complete with an effect proof", async () => {
  const order: string[] = [];
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => {
      order.push(`supervisor:${request.kind}`);
      if (request.kind === "inspect") return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageRef } };
      assert.deepEqual(order, ["supervisor:inspect", "mark", "supervisor:start"]);
      return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } };
    },
    reprovision: async () => { throw new Error("not expected"); },
    isCurrent: async () => true,
    markEffectDispatched: async () => { order.push("mark"); return true; },
    succeed: async (_job, success) => {
      assert.deepEqual(success, { kind: "effect_dispatched", command: "start", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } });
      order.push("complete:effect_dispatched");
      return true;
    },
    retry: async () => true,
    fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_effect_proof", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(order, ["supervisor:inspect", "mark", "supervisor:start", "complete:effect_dispatched"]);
});

test("pre-effect inspection success carries an explicit inspect proof", async () => {
  let marks = 0;
  const observation = { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true as const, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" };
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation }),
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true,
    markEffectDispatched: async () => { marks += 1; return true; },
    succeed: async (_job, success) => {
      assert.deepEqual(success, { kind: "inspect_proved", command: "start", observation });
      return true;
    },
    retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_inspect_proof", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.equal(marks, 0);
});

test("superseded reconciliation carries an explicit closed disposition", async () => {
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 2, observedState: "ready", desiredState: "running" }),
    supervisor: async () => { throw new Error("not expected"); }, reprovision: async () => { throw new Error("not expected"); },
    isCurrent: async () => true, markEffectDispatched: async () => true,
    succeed: async (_job, success) => { assert.deepEqual(success, { kind: "superseded" }); return true; },
    retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_superseded_proof", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
});

test("retryable inspect failure reschedules without issuing an effect", async () => {
  let effects = 0; let retries = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => {
      effects += request.kind === "inspect" ? 0 : 1;
      return { protocol_version: 1, operation_id: request.operation_id, outcome: "failed", code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary: "Supervisor unavailable" };
    },
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, markEffectDispatched: async () => true, succeed: async () => true,
    retry: async () => { retries += 1; return true; }, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.equal(result.kind, "retry"); assert.equal(effects, 0); assert.equal(retries, 1);
});

test("missing desired-running runtime reprovisions from stored facts instead of lifecycle start", async () => {
  const kinds: string[] = []; let reprovisions = 0;
  const observation = { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" };
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { ...observation, exists: false, lifecycle: "removed", image_ref: REMOVED_RUNTIME_IMAGE_REF } }; },
    reprovision: async () => { reprovisions += 1; return { protocol_version: 1, operation_id: "op_reprovision", outcome: "accepted", observation }; }, isCurrent: async () => true, markEffectDispatched: async () => true,
    succeed: async () => true, retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(reprovisions, 1);
});

for (const [command, lifecycle, exists] of [["start", "running", true], ["stop", "stopped", true], ["delete", "removed", false]] as const) {
  test(`${command} completes without replay when inspect already proves the effect`, async () => {
    const kinds: string[] = []; let completions = 0;
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: command === "start" ? "ready" : command === "stop" ? "stopped" : "deleted", desiredState: command === "stop" ? "stopped" : command === "delete" ? "deleted" : "running" }),
      supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists, lifecycle, health: "healthy", image_ref: exists ? imageRef : REMOVED_RUNTIME_IMAGE_REF, ...(lifecycle === "running" ? { private_origin: "http://172.30.0.4:8642" } : {}) } }; },
      reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, markEffectDispatched: async () => true,
      succeed: async () => { completions += 1; return true; }, retry: async () => true, fail: async () => true,
    }, { tenantId: "tenant_a", jobId: "job_noop", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command, effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
    assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(completions, 1);
  });
}

test("restart executes its durable effect even when inspect is already running", async () => {
  const kinds: string[] = [];
  await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }; },
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, markEffectDispatched: async () => true, succeed: async () => true, retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_restart", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.deepEqual(kinds, ["inspect", "restart"]);
});

test("a newer command accepted during inspect suppresses the stale external effect", async () => {
  const kinds: string[] = []; let superseded = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageRef } }; },
    reprovision: async () => { throw new Error("stale reprovision must not execute"); },
    isCurrent: async () => false, markEffectDispatched: async () => true,
    succeed: async (_job, success) => { assert.deepEqual(success, { kind: "superseded" }); superseded += 1; return true; },
    retry: async () => true, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_stale", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(superseded, 1);
});

for (const health of ["unknown", "degraded", "unhealthy"] as const) {
  test(`running ${health} observation never advances runtime readiness`, async () => {
    let succeeded = 0; let retried = 0;
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
      supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }),
      reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, markEffectDispatched: async () => true,
      succeed: async () => { succeeded += 1; return true; }, retry: async () => { retried += 1; return true; }, fail: async () => true,
    }, { tenantId: "tenant_a", jobId: "job_health", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
    assert.equal(result.kind, "retry"); assert.equal(succeeded, 0); assert.equal(retried, 1);
  });
}

test("missing observation rejects the stored image digest instead of the removed sentinel", async () => {
  let failed = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "deleted" }),
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: false, lifecycle: "removed", health: "unknown", image_ref: imageRef } }),
    reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true, markEffectDispatched: async () => true, succeed: async () => true, retry: async () => true,
    fail: async () => { failed += 1; return true; },
  }, { tenantId: "tenant_a", jobId: "job_missing_digest", attemptCount: 5, maxAttempts: 5, targetCommandVersion: 1, command: "delete", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  assert.equal(result.kind, "failed"); assert.equal(failed, 1);
});

test("restart marks an accepted nonhealthy effect and the next attempt observes healthy without replay", async () => {
  let effectState: "pre_effect" | "unsafe_to_replay" = "pre_effect";
  let restartCalls = 0; let completed = 0;
  const order: string[] = [];
  const journal = new Map<string, { protocol_version: 1; operation_id: string; outcome: "accepted"; observation: { tenant_id: string; runtime_id: string; generation: number; exists: true; lifecycle: "running"; health: "unknown"; image_ref: string; private_origin: string } }>();
  const facts = { tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" };
  const port = {
    loadFacts: async () => facts,
    supervisor: async (request: Parameters<Parameters<typeof handleReconcileRuntime>[0]["supervisor"]>[0]) => {
      if (request.kind === "inspect") {
        return { protocol_version: 1 as const, operation_id: request.operation_id, outcome: "accepted" as const, observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } };
      }
      const replay = journal.get(request.operation_id);
      if (replay !== undefined) return replay;
      restartCalls += 1;
      const accepted = { protocol_version: 1 as const, operation_id: request.operation_id, outcome: "accepted" as const, observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true as const, lifecycle: "running" as const, health: "unknown" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } };
      journal.set(request.operation_id, accepted);
      return accepted;
    },
    reprovision: async () => { throw new Error("not expected"); },
    isCurrent: async () => true,
    markEffectDispatched: async () => { order.push("mark"); effectState = "unsafe_to_replay"; return true; },
    succeed: async () => { completed += 1; return true; },
    retry: async () => { order.push("retry"); return true; },
    fail: async () => true,
  };
  const first = await handleReconcileRuntime(port, { tenantId: "tenant_a", jobId: "job_restart_journal", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
  const second = await handleReconcileRuntime(port, { tenantId: "tenant_a", jobId: "job_restart_journal", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState, recoveryOnly: false }, new AbortController().signal);
  assert.equal(first.kind, "retry"); assert.equal(second.kind, "succeeded");
  assert.equal(restartCalls, 1); assert.equal(journal.size, 1); assert.equal(completed, 1); assert.deepEqual(order, ["mark", "retry"]);
});

test("a dispatched restart stays observe-only through persistent nonhealthy health and fails at max attempts", async () => {
  let effectState: "pre_effect" | "unsafe_to_replay" = "pre_effect";
  let restartCalls = 0; let failed = 0; let retries = 0;
  for (let attemptCount = 1; attemptCount <= 3; attemptCount += 1) {
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
      supervisor: async (request) => {
        if (request.kind === "restart") restartCalls += 1;
        const health = request.kind === "restart" || effectState === "unsafe_to_replay" ? "unknown" as const : "healthy" as const;
        return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } };
      },
      reprovision: async () => { throw new Error("not expected"); }, isCurrent: async () => true,
      markEffectDispatched: async () => { effectState = "unsafe_to_replay"; return true; }, succeed: async () => true,
      retry: async () => { retries += 1; return true; }, fail: async () => { failed += 1; return true; },
    }, { tenantId: "tenant_a", jobId: "job_restart_unhealthy", attemptCount, maxAttempts: 3, targetCommandVersion: 1, command: "restart", effectState, recoveryOnly: false }, new AbortController().signal);
    assert.equal(result.kind, attemptCount < 3 ? "retry" : "failed");
  }
  assert.equal(restartCalls, 1); assert.equal(retries, 2); assert.equal(failed, 1);
});

test("a reclaimed unsafe reconcile attempt never replays its dispatched effect", async () => {
  const kinds: string[] = []; let retries = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "unknown", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }; },
    reprovision: async () => { throw new Error("unsafe attempt must not reprovision"); }, isCurrent: async () => true,
    markEffectDispatched: async () => { throw new Error("unsafe attempt is already marked"); }, succeed: async () => true,
    retry: async () => { retries += 1; return true; }, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_reclaimed", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "unsafe_to_replay", recoveryOnly: false }, new AbortController().signal);
  assert.equal(result.kind, "retry"); assert.deepEqual(kinds, ["inspect"]); assert.equal(retries, 1);
});

for (const [command, observation] of [
  ["start", { exists: true as const, lifecycle: "stopped" as const, health: "unknown" as const, image_ref: imageRef }],
  ["restart", { exists: false as const, lifecycle: "removed" as const, health: "unknown" as const, image_ref: REMOVED_RUNTIME_IMAGE_REF }],
  ["stop", { exists: true as const, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" }],
  ["delete", { exists: true as const, lifecycle: "stopped" as const, health: "unknown" as const, image_ref: imageRef }],
] as const) {
  test(`unsafe ${command} fails closed on an observation that contradicts the dispatched effect`, async () => {
    const kinds: string[] = []; let failed = 0;
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: command === "stop" ? "stopped" : command === "delete" ? "deleted" : "running" }),
      supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, ...observation } }; },
      reprovision: async () => { throw new Error("unsafe attempt must not reprovision"); }, isCurrent: async () => true,
      markEffectDispatched: async () => { throw new Error("unsafe attempt is already marked"); }, succeed: async () => true, retry: async () => true,
      fail: async () => { failed += 1; return true; },
    }, { tenantId: "tenant_a", jobId: `job_unsafe_${command}`, attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command, effectState: "unsafe_to_replay", recoveryOnly: false }, new AbortController().signal);
    assert.equal(result.kind, "failed"); assert.deepEqual(kinds, ["inspect"]); assert.equal(failed, 1);
  });
}

for (const persistedIdentityMismatch of ["payload_ref", "container_id"] as const) {
  test(`${persistedIdentityMismatch} mismatch while marking a dispatched effect performs zero external effects`, async () => {
    let retried = 0; let failed = 0; let externalEffects = 0; const kinds: string[] = [];
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
      supervisor: async (request) => { kinds.push(request.kind); if (request.kind !== "inspect") externalEffects += 1; return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } as const }; },
      reprovision: async () => { externalEffects += 1; throw new Error("not expected"); }, isCurrent: async () => true, markEffectDispatched: async () => false,
      succeed: async () => true, retry: async () => { retried += 1; return true; }, fail: async () => { failed += 1; return true; },
    }, { tenantId: "tenant_a", jobId: `job_mark_${persistedIdentityMismatch}`, attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
    assert.deepEqual(result, { kind: "failed", summary: "Worker job lease lost" }); assert.deepEqual(kinds, ["inspect"]); assert.equal(externalEffects, 0); assert.equal(retried, 0); assert.equal(failed, 0);
  });
}

test("missing restart reprovision marks unknown health once then becomes inspect-only", async () => {
  let effectState: "pre_effect" | "unsafe_to_replay" = "pre_effect";
  let reprovisions = 0; const kinds: string[] = [];
  const port = {
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request: Parameters<Parameters<typeof handleReconcileRuntime>[0]["supervisor"]>[0]) => {
      kinds.push(request.kind);
      return { protocol_version: 1 as const, operation_id: request.operation_id, outcome: "accepted" as const, observation: effectState === "pre_effect"
        ? { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: false, lifecycle: "removed" as const, health: "unknown" as const, image_ref: REMOVED_RUNTIME_IMAGE_REF }
        : { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } };
    },
    reprovision: async () => { reprovisions += 1; return { protocol_version: 1 as const, operation_id: "op_reprovision", outcome: "accepted" as const, observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running" as const, health: "unknown" as const, image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }; },
    isCurrent: async () => true, markEffectDispatched: async () => { effectState = "unsafe_to_replay"; return true; },
    succeed: async () => true, retry: async () => true, fail: async () => true,
  };
  assert.equal((await handleReconcileRuntime(port, { tenantId: "tenant_a", jobId: "job_missing_restart", attemptCount: 1, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal)).kind, "retry");
  assert.equal((await handleReconcileRuntime(port, { tenantId: "tenant_a", jobId: "job_missing_restart", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState, recoveryOnly: false }, new AbortController().signal)).kind, "succeeded");
  assert.equal(reprovisions, 1); assert.deepEqual(kinds, ["inspect", "inspect"]);
});

test("final-attempt unsafe recovery observes a healthy restart and terminalizes without replay", async () => {
  const kinds: string[] = []; let completed = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }; },
    reprovision: async () => { throw new Error("recovery must not reprovision"); }, isCurrent: async () => { throw new Error("recovery must not admit an effect"); },
    markEffectDispatched: async () => { throw new Error("recovery is already durable"); }, succeed: async () => { completed += 1; return true; },
    retry: async () => { throw new Error("recovery cannot retry"); }, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_final_restart", attemptCount: 5, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.equal(result.kind, "succeeded"); assert.deepEqual(kinds, ["inspect"]); assert.equal(completed, 1);
});

test("final-attempt unsafe recovery fails nonhealthy observation without effect or retry", async () => {
  const kinds: string[] = []; let failed = 0;
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "unknown", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }; },
    reprovision: async () => { throw new Error("recovery must not reprovision"); }, isCurrent: async () => { throw new Error("recovery must not admit an effect"); },
    markEffectDispatched: async () => { throw new Error("recovery is already durable"); }, succeed: async () => true,
    retry: async () => { throw new Error("recovery cannot retry"); }, fail: async () => { failed += 1; return true; },
  }, { tenantId: "tenant_a", jobId: "job_final_unknown", attemptCount: 5, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.equal(result.kind, "failed"); assert.deepEqual(kinds, ["inspect"]); assert.equal(failed, 1);
});

test("final-attempt recovery reports lease loss when its terminal observation cannot commit", async () => {
  const result = await handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://172.30.0.4:8642" } }),
    reprovision: async () => { throw new Error("recovery must not reprovision"); }, isCurrent: async () => { throw new Error("recovery must not admit an effect"); },
    markEffectDispatched: async () => { throw new Error("recovery is already durable"); }, succeed: async () => false,
    retry: async () => { throw new Error("recovery cannot retry"); }, fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_final_lease_loss", attemptCount: 5, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.deepEqual(result, { kind: "failed", summary: "Worker job lease lost" });
});

for (const [command, exists, lifecycle, health, expected] of [
  ["start", true, "running", "healthy", "succeeded"],
  ["stop", true, "stopped", "unknown", "succeeded"],
  ["delete", false, "removed", "unknown", "succeeded"],
  ["restart", true, "running", "healthy", "failed"],
] as const) {
  test(`final-attempt pre-effect ${command} recovery ${expected === "succeeded" ? "accepts proved state" : "fails closed"} without effect`, async () => {
    const kinds: string[] = []; let completed = 0; let failed = 0;
    const result = await handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: command === "stop" ? "stopped" : command === "delete" ? "deleted" : "running" }),
      supervisor: async (request) => { kinds.push(request.kind); return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists, lifecycle, health, image_ref: exists ? imageRef : REMOVED_RUNTIME_IMAGE_REF, ...(lifecycle === "running" ? { private_origin: "http://172.30.0.4:8642" } : {}) } }; },
      reprovision: async () => { throw new Error("recovery must not reprovision"); }, isCurrent: async () => { throw new Error("recovery must not admit an effect"); },
      markEffectDispatched: async () => { throw new Error("pre-effect recovery cannot dispatch"); }, succeed: async () => { completed += 1; return true; },
      retry: async () => { throw new Error("recovery cannot retry"); }, fail: async () => { failed += 1; return true; },
    }, { tenantId: "tenant_a", jobId: `job_final_pre_${command}`, attemptCount: 5, maxAttempts: 5, targetCommandVersion: 1, command, effectState: "pre_effect", recoveryOnly: true }, new AbortController().signal);
    assert.equal(result.kind, expected); assert.deepEqual(kinds, ["inspect"]); assert.equal(completed, expected === "succeeded" ? 1 : 0); assert.equal(failed, expected === "failed" ? 1 : 0);
  });
}

for (const scenario of ["rejected", "thrown", "timeout", "final-attempt"] as const) {
  test(`a newer command supersedes an old pre-effect ${scenario} result in flight`, async () => {
    const effect = deferred<Awaited<ReturnType<Parameters<typeof handleReconcileRuntime>[0]["supervisor"]>>>();
    let enteredEffect!: () => void;
    const effectEntered = new Promise<void>((resolve) => { enteredEffect = resolve; });
    let superseded = false;
    let terminalizations = 0;
    const attemptCount = scenario === "final-attempt" ? 5 : 1;
    const handling = handleReconcileRuntime({
      loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "stopped", desiredState: "running" }),
      supervisor: async (request) => {
        if (request.kind === "inspect") return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageRef } };
        enteredEffect();
        return effect.promise;
      },
      reprovision: async () => { throw new Error("not expected"); },
      isCurrent: async () => true,
      markEffectDispatched: async () => true,
      succeed: async () => true,
      retry: async () => { terminalizations += 1; return superseded ? { kind: "superseded" as const } : { kind: "retried" as const }; },
      fail: async () => { terminalizations += 1; return superseded ? { kind: "superseded" as const } : { kind: "failed" as const }; },
    }, { tenantId: "tenant_a", jobId: `job_${scenario}`, attemptCount, maxAttempts: 5, targetCommandVersion: 1, command: "start", effectState: "pre_effect", recoveryOnly: false }, new AbortController().signal);
    await effectEntered;
    superseded = true;
    if (scenario === "thrown") effect.reject(new Error("synthetic effect throw"));
    else if (scenario === "timeout") effect.reject(Object.assign(new Error("synthetic timeout"), { retryable: true }));
    else effect.resolve({ protocol_version: 1, operation_id: "op_effect", outcome: "failed", code: "DEPENDENCY_UNAVAILABLE", retryable: scenario === "final-attempt", summary: "synthetic rejection" });

    assert.deepEqual(await handling, { kind: "succeeded" });
    assert.equal(terminalizations, 1);
  });
}

test("a newer command supersedes a contradictory unsafe inspection in flight", async () => {
  const inspection = deferred<Awaited<ReturnType<Parameters<typeof handleReconcileRuntime>[0]["supervisor"]>>>();
  let enteredInspect!: () => void;
  const inspectEntered = new Promise<void>((resolve) => { enteredInspect = resolve; });
  let superseded = false;
  const handling = handleReconcileRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, commandVersion: 1, observedState: "ready", desiredState: "running" }),
    supervisor: async () => { enteredInspect(); return inspection.promise; },
    reprovision: async () => { throw new Error("unsafe work must not replay"); },
    isCurrent: async () => { throw new Error("unsafe work must not readmit an effect"); },
    markEffectDispatched: async () => { throw new Error("already dispatched"); },
    succeed: async () => true,
    retry: async () => ({ kind: "retried" as const }),
    fail: async () => superseded ? { kind: "superseded" as const } : { kind: "failed" as const },
  }, { tenantId: "tenant_a", jobId: "job_unsafe_superseded", attemptCount: 2, maxAttempts: 5, targetCommandVersion: 1, command: "restart", effectState: "unsafe_to_replay", recoveryOnly: false }, new AbortController().signal);
  await inspectEntered;
  superseded = true;
  inspection.resolve({ protocol_version: 1, operation_id: "op_inspect", outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageRef } });
  assert.deepEqual(await handling, { kind: "succeeded" });
});
