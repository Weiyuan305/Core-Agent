import assert from "node:assert/strict";
import test from "node:test";

import { DatabaseTransactionRetryExhaustedError, HermesStreamError, type ClaimedJob, type StoredAgentRunExecutionFacts } from "@core-agent/runtime-core";

import {
  handleExecuteAgentRun,
  type ExecuteAgentRunPort,
} from "../src/handlers/execute-agent-run.js";

const job: Extract<ClaimedJob, { jobKind: "execute_agent_run" }> = {
  tenantId: "tenant_a",
  jobId: "job_execute_a",
  jobKind: "execute_agent_run",
  attemptCount: 1,
  maxAttempts: 3,
  payloadRef: "run_a",
  recoveryOnly: false,
  leaseExpiresAt: new Date("2026-08-05T02:00:30.000Z"),
  runtimeCommand: null,
  targetCommandVersion: null,
  effectState: "pre_effect",
};

const facts: StoredAgentRunExecutionFacts = {
  tenantId: "tenant_a",
  jobId: "job_execute_a",
  runId: "run_a",
  conversationId: "conversation_a",
  assistantMessageId: "message_assistant_a",
  profileRef: "consultant_a",
  sessionRef: "hermes_session_a",
  modelId: "cywx/gpt-5.6-sol",
  timeoutMs: 90_000,
  content: "Synthetic hello",
  ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
  runtime: {
    runtimeId: "runtime_a",
    generation: 1,
    imageRef: `managed/runtime:v1@sha256:${"a".repeat(64)}`,
  },
};

function scriptedStream(script: readonly (string | Error)[]): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of script) {
        if (item instanceof Error) throw item;
        yield item;
      }
    },
  };
}

type ReviewedExecuteAgentRunPort = ExecuteAgentRunPort & {
  markDispatched(job: Parameters<ExecuteAgentRunPort["begin"]>[0]): Promise<{ kind: "updated" } | { kind: "lease_lost" }>;
};

function port(overrides: Partial<ReviewedExecuteAgentRunPort> = {}) {
  const calls: string[] = [];
  const value = {
    begin: async () => { calls.push("begin"); return { kind: "admitted", facts }; },
    inspectRuntime: async () => { calls.push("inspect"); return "http://core-agent-runtime-example:8642"; },
    markDispatched: async () => { calls.push("mark-dispatched"); return { kind: "updated" as const }; },
    stream: () => { calls.push("hermes"); return scriptedStream(["Hello", " there"]); },
    persistDelta: async (_job, _messageId, delta) => { calls.push(`delta:${delta}`); return { kind: "updated" }; },
    complete: async (_job, _facts, content) => { calls.push(`complete:${content}`); return { kind: "updated" }; },
    retry: async () => { calls.push("retry"); return { kind: "updated" }; },
    fail: async (_job, summary) => { calls.push(`fail:${summary}`); return { kind: "updated" }; },
    ...overrides,
  } satisfies ReviewedExecuteAgentRunPort;
  return { value, calls };
}

test("execute Agent Run durably persists each delta before pulling the next one and completes exact content", async () => {
  let outstandingDelta = false;
  const setup = port({
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        assert.equal(outstandingDelta, false);
        outstandingDelta = true; yield "Hello";
        assert.equal(outstandingDelta, false, "first delta must be durable before the iterator advances");
        outstandingDelta = true; yield " there";
        assert.equal(outstandingDelta, false, "second delta must be durable before completion");
      },
    }),
    persistDelta: async (_job, _messageId, delta) => {
      setup.calls.push(`delta:${delta}`); outstandingDelta = false; return { kind: "updated" };
    },
  });

  const result = await handleExecuteAgentRun(setup.value, job, new AbortController().signal);

  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(setup.calls, ["begin", "inspect", "mark-dispatched", "delta:Hello", "delta: there", "complete:Hello there"]);
});

test("disconnect after first durable delta terminalizes without automatic replay", async () => {
  let hermesCalls = 0;
  const setup = port({
    stream: () => { hermesCalls += 1; return scriptedStream(["partial", new HermesStreamError("DEPENDENCY_UNAVAILABLE", true)]); },
  });

  const result = await handleExecuteAgentRun(setup.value, job, new AbortController().signal);

  assert.equal(result.kind, "failed");
  assert.equal(hermesCalls, 1);
  assert.deepEqual(setup.calls, [
    "begin", "inspect", "mark-dispatched", "delta:partial", "fail:Agent execution failed after dispatch",
  ]);
  assert.equal(setup.calls.includes("retry"), false);
});

test("Hermes acceptance before the first delta is already unsafe and never retries", async () => {
  const setup = port({
    stream: () => {
      setup.calls.push("hermes-accepted");
      return scriptedStream([new HermesStreamError("DEPENDENCY_UNAVAILABLE", true)]);
    },
  });

  const result = await handleExecuteAgentRun(setup.value, job, new AbortController().signal);

  assert.deepEqual(result, { kind: "failed", summary: "Agent execution failed after dispatch" });
  assert.deepEqual(setup.calls, [
    "begin", "inspect", "mark-dispatched", "hermes-accepted", "fail:Agent execution failed after dispatch",
  ]);
  assert.equal(setup.calls.includes("retry"), false);
});

test("database concurrency exhaustion after unsafe dispatch leaves Agent Run finalization to lease recovery", async () => {
  const setup = port({
    complete: async () => { setup.calls.push("complete:db-exhausted"); throw new DatabaseTransactionRetryExhaustedError(); },
  });

  await assert.rejects(
    handleExecuteAgentRun(setup.value, job, new AbortController().signal),
    DatabaseTransactionRetryExhaustedError,
  );
  assert.deepEqual(setup.calls, [
    "begin", "inspect", "mark-dispatched", "hermes", "delta:Hello", "delta: there", "complete:db-exhausted",
  ]);
  assert.equal(setup.calls.some((call) => call === "retry" || call.startsWith("fail:")), false);
});

test("lease loss while marking dispatch performs zero SecretStore or Hermes work", async () => {
  const setup = port({
    markDispatched: async () => { setup.calls.push("mark-dispatched"); return { kind: "lease_lost" }; },
  });

  const result = await handleExecuteAgentRun(setup.value, job, new AbortController().signal);

  assert.deepEqual(result, { kind: "failed", summary: "Worker job lease lost" });
  assert.deepEqual(setup.calls, ["begin", "inspect", "mark-dispatched"]);
});

test("unsafe reclaim and final-attempt recovery terminalize with zero inspect, secret, or Hermes work", async () => {
  for (const recovered of [
    { ...job, effectState: "unsafe_to_replay" as const },
    { ...job, attemptCount: 3, recoveryOnly: true, effectState: "pre_effect" as const },
    { ...job, attemptCount: 3, recoveryOnly: true, effectState: "unsafe_to_replay" as const },
  ]) {
    const setup = port();
    const result = await handleExecuteAgentRun(setup.value, recovered, new AbortController().signal);
    assert.equal(result.kind, "failed");
    assert.deepEqual(setup.calls, [
      recovered.recoveryOnly ? "fail:Final-attempt recovery cannot safely replay Agent execution" : "fail:Agent execution cannot safely replay durable output",
    ]);
  }
});

test("Worker cancellation and lease loss stop execution without a business terminal claim", async () => {
  const cancelled = new AbortController();
  const cancellation = port({
    stream: () => ({ async *[Symbol.asyncIterator]() { cancelled.abort(); yield "ignored"; } }),
  });
  const cancelResult = await handleExecuteAgentRun(cancellation.value, job, cancelled.signal);
  assert.equal(cancelResult.kind, "failed");
  assert.equal(cancellation.calls.some((call) => call.startsWith("fail:") || call === "retry" || call.startsWith("complete:")), false);

  const leaseLoss = port({ persistDelta: async () => ({ kind: "lease_lost" }) });
  const leaseResult = await handleExecuteAgentRun(leaseLoss.value, job, new AbortController().signal);
  assert.deepEqual(leaseResult, { kind: "failed", summary: "Worker job lease lost" });
  assert.equal(leaseLoss.calls.some((call) => call.startsWith("fail:") || call === "retry"), false);
});

test("stored authority inconsistency terminalizes with a stable summary and no external work", async () => {
  const setup = port({ begin: async () => { setup.calls.push("begin"); throw new Error("provider secret private value"); } });
  const result = await handleExecuteAgentRun(setup.value, job, new AbortController().signal);
  assert.deepEqual(result, { kind: "failed", summary: "Agent execution admission failed" });
  assert.deepEqual(setup.calls, ["begin", "fail:Agent execution admission failed"]);
});
