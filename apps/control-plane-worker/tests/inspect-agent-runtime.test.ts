import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import type { StoredAgentRunExecutionFacts, SupervisorRequestV1 } from "@core-agent/runtime-core";

import { inspectAgentRunRuntime, type AgentRuntimeSupervisorPort } from "../src/inspect-agent-runtime.js";

const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;
const facts: StoredAgentRunExecutionFacts = {
  tenantId: "tenant_a", jobId: "job_execute_a", runId: "run_a", conversationId: "conversation_a",
  assistantMessageId: "message_assistant_a", profileRef: "consultant_a", sessionRef: "session_a",
  modelId: "model_a", timeoutMs: 10_000, content: "hello",
  ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
  runtime: { runtimeId: "runtime_a", generation: 7, imageRef },
};

test("Agent Run inspect uses a stable job-scoped operation and requires full current runtime identity", async () => {
  const requests: SupervisorRequestV1[] = [];
  const supervisor: AgentRuntimeSupervisorPort = {
    execute: async (request) => {
      requests.push(request);
      return { protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: {
        tenant_id: facts.tenantId, runtime_id: facts.runtime.runtimeId, generation: facts.runtime.generation,
        exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef,
        private_origin: "http://core-agent-runtime-example:8642",
      } };
    },
  };
  const signal = new AbortController().signal;
  assert.equal(await inspectAgentRunRuntime(supervisor, facts, 1, signal), "http://core-agent-runtime-example:8642");
  assert.equal(await inspectAgentRunRuntime(supervisor, facts, 1, signal), "http://core-agent-runtime-example:8642");
  assert.equal(await inspectAgentRunRuntime(supervisor, facts, 2, signal), "http://core-agent-runtime-example:8642");
  const firstAttempt = `op_${createHash("sha256").update("job_execute_a:1:inspect-agent-run-runtime", "utf8").digest("hex").slice(0, 48)}`;
  const secondAttempt = `op_${createHash("sha256").update("job_execute_a:2:inspect-agent-run-runtime", "utf8").digest("hex").slice(0, 48)}`;
  assert.deepEqual(requests.map((request) => request.operation_id), [firstAttempt, firstAttempt, secondAttempt]);
  assert.deepEqual(requests.map((request) => request.kind), ["inspect", "inspect", "inspect"]);
  assert.equal(requests[0]?.request_hash, requests[1]?.request_hash);
  assert.notEqual(requests[1]?.request_hash, requests[2]?.request_hash);
});

test("Agent Run inspect fails closed on every mismatched identity/readiness field and never reflects Supervisor summary", async () => {
  const valid = {
    tenant_id: facts.tenantId, runtime_id: facts.runtime.runtimeId, generation: facts.runtime.generation,
    exists: true as const, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageRef,
    private_origin: "http://core-agent-runtime-example:8642",
  };
  const changes = [
    { tenant_id: "tenant_other" }, { runtime_id: "runtime_other" }, { generation: 8 }, { exists: false as const },
    { lifecycle: "stopped" as const }, { health: "unhealthy" as const }, { image_ref: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
    { private_origin: "http://public.example:8642" },
  ];
  for (const change of changes) {
    const supervisor: AgentRuntimeSupervisorPort = { execute: async (request) => ({
      protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { ...valid, ...change },
    }) as never };
    await assert.rejects(inspectAgentRunRuntime(supervisor, facts, 1, new AbortController().signal));
  }
  const failed: AgentRuntimeSupervisorPort = { execute: async (request) => ({
    protocol_version: 1, operation_id: request.operation_id, outcome: "failed", code: "DEPENDENCY_UNAVAILABLE",
    retryable: true, summary: "provider-body private-token",
  }) };
  await assert.rejects(inspectAgentRunRuntime(failed, facts, 1, new AbortController().signal), (error: unknown) => {
    assert.doesNotMatch(String(error), /provider-body|private-token/);
    return true;
  });
});
