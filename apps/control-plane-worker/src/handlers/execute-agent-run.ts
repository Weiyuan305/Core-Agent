import {
  HermesStreamError,
  type AgentRunBeginResult,
  type AgentRunWorkerJobRef,
  type ClaimedJob,
  type JobLeaseResult,
  type StoredAgentRunExecutionFacts,
} from "@core-agent/runtime-core";

import type { HandlerResult } from "../dispatch-job.js";

export type ExecuteAgentRunJob = Extract<ClaimedJob, { jobKind: "execute_agent_run" }>;

export interface ExecuteAgentRunPort {
  begin(job: AgentRunWorkerJobRef): Promise<AgentRunBeginResult>;
  inspectRuntime(facts: StoredAgentRunExecutionFacts, signal: AbortSignal): Promise<string>;
  markDispatched(job: AgentRunWorkerJobRef): Promise<JobLeaseResult>;
  stream(facts: StoredAgentRunExecutionFacts, origin: string, signal: AbortSignal): AsyncIterable<string>;
  persistDelta(job: AgentRunWorkerJobRef, messageId: string, delta: string): Promise<JobLeaseResult>;
  complete(job: AgentRunWorkerJobRef, facts: StoredAgentRunExecutionFacts, content: string): Promise<JobLeaseResult>;
  retry(job: AgentRunWorkerJobRef, summary: string): Promise<JobLeaseResult>;
  fail(job: AgentRunWorkerJobRef, summary: string): Promise<JobLeaseResult>;
}

function ref(workerId: string, job: ExecuteAgentRunJob): AgentRunWorkerJobRef {
  return { tenantId: job.tenantId, jobId: job.jobId, workerId, attemptCount: job.attemptCount, runId: job.payloadRef };
}

function leaseLost(): HandlerResult { return { kind: "failed", summary: "Worker job lease lost" }; }

function retryable(error: unknown): boolean {
  if (error instanceof HermesStreamError) return error.retryable;
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "retryable");
  return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
}

async function terminalFailure(
  port: ExecuteAgentRunPort,
  jobRef: AgentRunWorkerJobRef,
  summary: string,
): Promise<HandlerResult> {
  const result = await port.fail(jobRef, summary);
  return result.kind === "lease_lost" ? leaseLost() : { kind: "failed", summary };
}

export async function handleExecuteAgentRun(
  port: ExecuteAgentRunPort,
  job: ExecuteAgentRunJob,
  signal: AbortSignal,
  workerId = "worker_execute",
): Promise<HandlerResult> {
  const jobRef = ref(workerId, job);
  if (job.recoveryOnly) {
    return terminalFailure(port, jobRef, "Final-attempt recovery cannot safely replay Agent execution");
  }
  if (job.effectState === "unsafe_to_replay") {
    return terminalFailure(port, jobRef, "Agent execution cannot safely replay durable output");
  }
  if (signal.aborted) return leaseLost();

  let begun: AgentRunBeginResult;
  try { begun = await port.begin(jobRef); }
  catch {
    if (signal.aborted) return leaseLost();
    return terminalFailure(port, jobRef, "Agent execution admission failed");
  }
  if (begun.kind === "lease_lost") return leaseLost();
  let dispatched = false;
  let content = "";
  try {
    if (signal.aborted) return leaseLost();
    const origin = await port.inspectRuntime(begun.facts, signal);
    if (signal.aborted) return leaseLost();
    const marked = await port.markDispatched(jobRef);
    if (marked.kind === "lease_lost") return leaseLost();
    dispatched = true;
    if (signal.aborted) return leaseLost();
    for await (const delta of port.stream(begun.facts, origin, signal)) {
      if (signal.aborted) return leaseLost();
      const persisted = await port.persistDelta(jobRef, begun.facts.assistantMessageId, delta);
      if (persisted.kind === "lease_lost") return leaseLost();
      content += delta;
    }
    if (signal.aborted) return leaseLost();
    const completed = await port.complete(jobRef, begun.facts, content);
    return completed.kind === "lease_lost" ? leaseLost() : { kind: "succeeded" };
  } catch (error) {
    if (signal.aborted) return leaseLost();
    if (dispatched) return terminalFailure(port, jobRef, "Agent execution failed after dispatch");
    if (retryable(error) && job.attemptCount < job.maxAttempts) {
      const retried = await port.retry(jobRef, "Agent execution dependency is unavailable");
      return retried.kind === "lease_lost" ? leaseLost() : { kind: "retry", summary: "Agent execution dependency is unavailable" };
    }
    return terminalFailure(port, jobRef, "Agent execution failed before durable output");
  }
}
