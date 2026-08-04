import { createHash } from "node:crypto";

import { canonicalSupervisorRequestHash, REMOVED_RUNTIME_IMAGE_REF, type LifecycleRuntimeCommandDataV1, type SupervisorRequestV1, type SupervisorResponseV1 } from "@core-agent/runtime-core";

import type { HandlerResult } from "../dispatch-job.js";
import { validatePrivateHermesOrigin } from "./provision-runtime.js";

type RuntimeCommand = "start" | "stop" | "restart" | "delete";
type ReconcileEffectState = "pre_effect" | "unsafe_to_replay";
interface ReconcileJob { readonly tenantId: string; readonly jobId: string; readonly attemptCount: number; readonly maxAttempts: number; readonly targetCommandVersion: number; readonly command: RuntimeCommand; readonly effectState: ReconcileEffectState }
interface ReconcileFacts { readonly tenantId: string; readonly runtimeId: string; readonly generation: number; readonly imageRef: string; readonly commandVersion: number; readonly observedState: string; readonly desiredState: string }
export interface ReconcileRuntimePort {
  loadFacts(job: ReconcileJob): Promise<ReconcileFacts>;
  supervisor(request: SupervisorRequestV1, signal: AbortSignal): Promise<SupervisorResponseV1>;
  reprovision(job: ReconcileJob, signal: AbortSignal): Promise<SupervisorResponseV1>;
  isCurrent(job: ReconcileJob): Promise<boolean>;
  markEffectDispatched(job: ReconcileJob): Promise<boolean>;
  succeed(job: ReconcileJob, response?: SupervisorResponseV1): Promise<boolean>;
  retry(job: ReconcileJob, summary: string): Promise<boolean>;
  fail(job: ReconcileJob, summary: string): Promise<boolean>;
}

function request(facts: ReconcileFacts, kind: "inspect" | RuntimeCommand, operationId: string): SupervisorRequestV1 {
  const data: LifecycleRuntimeCommandDataV1 = { protocol_version: 1, operation_id: operationId, kind, tenant_id: facts.tenantId, runtime_id: facts.runtimeId, generation: facts.generation };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}
function operationId(job: ReconcileJob, suffix: string): string {
  return `op_${createHash("sha256").update(`${job.jobId}:${suffix}`, "utf8").digest("hex").slice(0, 48)}`;
}
function compatible(facts: ReconcileFacts, response: SupervisorResponseV1): boolean {
  if (response.outcome !== "accepted") return false;
  const observation = response.observation;
  if (observation.tenant_id !== facts.tenantId || observation.runtime_id !== facts.runtimeId || observation.generation !== facts.generation) return false;
  return observation.exists
    ? observation.image_ref === facts.imageRef
    : observation.lifecycle === "removed" && observation.image_ref === REMOVED_RUNTIME_IMAGE_REF;
}
function summary(value: unknown): string { return (value instanceof Error ? value.message : String(value)).slice(0, 1000); }
function retryable(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true; }
function effectMatches(command: RuntimeCommand, response: SupervisorResponseV1): boolean {
  if (response.outcome !== "accepted") return false;
  const observation = response.observation;
  if (command === "delete") return !observation.exists && observation.lifecycle === "removed";
  if (command === "stop") return observation.exists && observation.lifecycle === "stopped";
  return observation.exists && observation.lifecycle === "running";
}
function inspectionAlreadySatisfies(command: RuntimeCommand, response: Extract<SupervisorResponseV1, { outcome: "accepted" }>): boolean {
  const observation = response.observation;
  if (command === "delete") return !observation.exists && observation.lifecycle === "removed";
  if (command === "stop") return observation.exists && observation.lifecycle === "stopped";
  if (command === "start") return observation.exists && observation.lifecycle === "running";
  return false;
}
function inspectionAllowsEffect(command: RuntimeCommand, response: Extract<SupervisorResponseV1, { outcome: "accepted" }>): boolean {
  const observation = response.observation;
  if (command === "delete") return observation.exists;
  if (command === "stop") return observation.exists && ["created", "running"].includes(observation.lifecycle);
  if (command === "restart") return observation.exists && observation.lifecycle === "running";
  return observation.exists && ["created", "stopped"].includes(observation.lifecycle);
}
async function unhealthyRunningResult(port: ReconcileRuntimePort, job: ReconcileJob, markDispatched = false): Promise<HandlerResult> {
  const text = "Supervisor reports the running runtime is not healthy";
  if (markDispatched && !await port.markEffectDispatched(job)) return { kind: "failed", summary: "Worker job lease lost" };
  if (job.attemptCount < job.maxAttempts) {
    if (!await port.retry(job, text)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "retry", summary: text };
  }
  if (!await port.fail(job, text)) return { kind: "failed", summary: "Worker job lease lost" };
  return { kind: "failed", summary: text };
}
async function failClosedObservation(port: ReconcileRuntimePort, job: ReconcileJob): Promise<HandlerResult> {
  const text = "Supervisor observation contradicts the dispatched runtime effect";
  if (!await port.fail(job, text)) return { kind: "failed", summary: "Worker job lease lost" };
  return { kind: "failed", summary: text };
}

export async function handleReconcileRuntime(port: ReconcileRuntimePort, job: ReconcileJob, signal: AbortSignal): Promise<HandlerResult> {
  try {
    const facts = await port.loadFacts(job);
    if (facts.commandVersion !== job.targetCommandVersion) {
      if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "succeeded" };
    }
    const inspected = await port.supervisor(request(facts, "inspect", operationId(job, `attempt-${job.attemptCount}-inspect`)), signal);
    if (inspected.outcome !== "accepted") {
      const text = summary(inspected.summary);
      if (inspected.retryable && job.attemptCount < job.maxAttempts) { await port.retry(job, text); return { kind: "retry", summary: text }; }
      await port.fail(job, text); return { kind: "failed", summary: text };
    }
    if (!compatible(facts, inspected)) throw new Error("Supervisor inspect observation does not match stored runtime identity");
    if (job.effectState === "unsafe_to_replay") {
      if (!effectMatches(job.command, inspected)) return failClosedObservation(port, job);
      if (inspected.observation.lifecycle === "running") validatePrivateHermesOrigin(inspected.observation.private_origin);
      if (inspected.observation.lifecycle === "running" && inspected.observation.health !== "healthy") return unhealthyRunningResult(port, job);
      if (!await port.succeed(job, inspected)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "succeeded" };
    }
    if (inspectionAlreadySatisfies(job.command, inspected)) {
      if (inspected.observation.lifecycle === "running") validatePrivateHermesOrigin(inspected.observation.private_origin);
      if (inspected.observation.lifecycle === "running" && inspected.observation.health !== "healthy") return unhealthyRunningResult(port, job);
      if (!await port.succeed(job, inspected)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "succeeded" };
    }
    if (inspected.observation.exists && !inspectionAllowsEffect(job.command, inspected)) throw new Error("Supervisor inspection is incompatible with requested operation");
    if (!await port.isCurrent(job)) {
      if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "succeeded" };
    }
    const effected = !inspected.observation.exists && facts.desiredState === "running"
      ? await port.reprovision(job, signal)
      : await port.supervisor(request(facts, job.command, operationId(job, `effect-${job.command}`)), signal);
    if (effected.outcome !== "accepted") {
      const text = summary(effected.summary);
      if (effected.retryable && job.attemptCount < job.maxAttempts) { await port.retry(job, text); return { kind: "retry", summary: text }; }
      await port.fail(job, text); return { kind: "failed", summary: text };
    }
    if (!compatible(facts, effected) || !effectMatches(job.command, effected)) throw new Error("Supervisor lifecycle observation does not match requested operation");
    if (effected.observation.lifecycle === "running") validatePrivateHermesOrigin(effected.observation.private_origin);
    if (effected.observation.lifecycle === "running" && effected.observation.health !== "healthy") return unhealthyRunningResult(port, job, true);
    if (!await port.succeed(job, effected)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "succeeded" };
  } catch (error) {
    const text = summary(error);
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    if (job.attemptCount < job.maxAttempts && retryable(error)) { await port.retry(job, text); return { kind: "retry", summary: text }; }
    await port.fail(job, text); return { kind: "failed", summary: text };
  }
}
