import assert from "node:assert/strict";
import test from "node:test";

import { implementedWorkerJobKinds } from "../src/main.js";
import { handleNonReconcileRecovery, type NonReconcileRecoveryJob } from "../src/recovery-boundary.js";

function job(jobKind: "provision_runtime" | "dispatch_outbox", recoveryOnly = true): NonReconcileRecoveryJob {
  return {
    tenantId: "tenant_a", jobId: `job_${jobKind}`, jobKind,
    runtimeCommand: null, targetCommandVersion: null, payloadRef: jobKind === "provision_runtime" ? "runtime_a" : "payload_a",
    attemptCount: 5, maxAttempts: 5, effectState: "pre_effect", recoveryOnly, leaseExpiresAt: new Date("2026-08-04T00:00:30.000Z"),
  };
}

test("final provision and Outbox recovery terminalize without any external dispatch", async () => {
  const calls: string[] = [];
  const port = {
    failRuntime: async () => { calls.push("fail-runtime"); return true; },
    complete: async () => { calls.push("complete"); return true; },
  };
  assert.equal((await handleNonReconcileRecovery(port, job("provision_runtime")))?.kind, "failed");
  assert.equal((await handleNonReconcileRecovery(port, job("dispatch_outbox")))?.kind, "succeeded");
  assert.deepEqual(calls, ["fail-runtime", "complete"]);
});

test("normal provision and Outbox jobs continue to their implemented handlers", async () => {
  const port = { failRuntime: async () => true, complete: async () => true };
  assert.equal(await handleNonReconcileRecovery(port, job("provision_runtime", false)), undefined);
  assert.equal(await handleNonReconcileRecovery(port, job("dispatch_outbox", false)), undefined);
});

test("production Worker claims only implemented jobs and excludes Agent Run execution", () => {
  assert.deepEqual(implementedWorkerJobKinds, ["provision_runtime", "reconcile_runtime", "dispatch_outbox"]);
  assert.equal((implementedWorkerJobKinds as readonly string[]).includes("execute_agent_run"), false);
});

test("final non-reconcile recovery reports lease loss instead of claiming terminal ownership", async () => {
  const port = { failRuntime: async () => false, complete: async () => false };
  assert.deepEqual(await handleNonReconcileRecovery(port, job("provision_runtime")), { kind: "failed", summary: "Worker job lease lost" });
  assert.deepEqual(await handleNonReconcileRecovery(port, job("dispatch_outbox")), { kind: "failed", summary: "Worker job lease lost" });
});
