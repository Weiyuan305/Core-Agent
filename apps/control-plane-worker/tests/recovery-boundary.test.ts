import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    failRuntime: async () => { calls.push("fail-runtime"); return { kind: "failed" as const }; },
    complete: async () => { calls.push("complete"); return true; },
  };
  assert.equal((await handleNonReconcileRecovery(port, job("provision_runtime")))?.kind, "failed");
  assert.equal((await handleNonReconcileRecovery(port, job("dispatch_outbox")))?.kind, "succeeded");
  assert.deepEqual(calls, ["fail-runtime", "complete"]);
});

test("normal provision and Outbox jobs continue to their implemented handlers", async () => {
  const port = { failRuntime: async () => ({ kind: "failed" as const }), complete: async () => true };
  assert.equal(await handleNonReconcileRecovery(port, job("provision_runtime", false)), undefined);
  assert.equal(await handleNonReconcileRecovery(port, job("dispatch_outbox", false)), undefined);
});

test("production Worker claims Agent Run execution only after its normal and recovery handlers are implemented", () => {
  assert.deepEqual(implementedWorkerJobKinds, [
    "provision_runtime", "reconcile_runtime", "execute_agent_run", "dispatch_outbox",
    "project_platform_memberships",
  ]);
  assert.equal((implementedWorkerJobKinds as readonly string[]).includes("execute_agent_run"), true);
  assert.equal((implementedWorkerJobKinds as readonly string[]).includes("project_platform_memberships"), true);
});

test("final non-reconcile recovery reports lease loss instead of claiming terminal ownership", async () => {
  const port = { failRuntime: async () => ({ kind: "lease_lost" as const }), complete: async () => false };
  assert.deepEqual(await handleNonReconcileRecovery(port, job("provision_runtime")), { kind: "failed", summary: "Worker job lease lost" });
  assert.deepEqual(await handleNonReconcileRecovery(port, job("dispatch_outbox")), { kind: "failed", summary: "Worker job lease lost" });
});

test("dispatch places normal and recovery provision handling inside the runtime advisory lock", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const dispatchStart = source.indexOf("async function dispatchRuntimeJob");
  const provisionStart = source.indexOf('if (job.jobKind === "provision_runtime") return withRuntimeAdvisoryLock', dispatchStart);
  const reconcileStart = source.indexOf('if (job.jobKind === "reconcile_runtime") return withRuntimeAdvisoryLock', provisionStart);
  assert.notEqual(dispatchStart, -1);
  assert.notEqual(provisionStart, -1);
  assert.notEqual(reconcileStart, -1);
  assert.doesNotMatch(source.slice(dispatchStart, provisionStart), /handleNonReconcileRecovery/);
  assert.match(source.slice(provisionStart, reconcileStart), /handleNonReconcileRecovery/);
});

test("dispatch holds the distinct Conversation execution lock across the complete Agent Run handler", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const executeStart = source.indexOf('if (job.jobKind === "execute_agent_run")');
  const outboxStart = source.indexOf('if (job.jobKind === "dispatch_outbox")', executeStart);
  assert.notEqual(executeStart, -1);
  assert.notEqual(outboxStart, -1);
  const execution = source.slice(executeStart, outboxStart);
  assert.match(execution, /withAgentRunConversationLock/);
  assert.match(execution, /handleExecuteAgentRun/);
  assert.doesNotMatch(execution, /withRuntimeAdvisoryLock/);
  assert.equal(execution.indexOf("withAgentRunConversationLock") < execution.indexOf("handleExecuteAgentRun"), true);
});
