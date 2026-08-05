import { createHash } from "node:crypto";

import {
  canonicalSupervisorRequestHash,
  HermesStreamError,
  validateManagedHermesOrigin,
  type LifecycleRuntimeCommandDataV1,
  type RuntimeSupervisorClient,
  type StoredAgentRunExecutionFacts,
} from "@core-agent/runtime-core";

function operationId(jobId: string, attemptCount: number): string {
  return `op_${createHash("sha256").update(`${jobId}:${attemptCount}:inspect-agent-run-runtime`, "utf8").digest("hex").slice(0, 48)}`;
}

export async function inspectAgentRunRuntime(
  supervisor: Pick<RuntimeSupervisorClient, "execute">,
  facts: StoredAgentRunExecutionFacts,
  attemptCount: number,
  signal: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) throw new HermesStreamError("DEPENDENCY_UNAVAILABLE", false);
  const data: LifecycleRuntimeCommandDataV1 = {
    protocol_version: 1,
    operation_id: operationId(facts.jobId, attemptCount),
    kind: "inspect",
    tenant_id: facts.tenantId,
    runtime_id: facts.runtime.runtimeId,
    generation: facts.runtime.generation,
  };
  const response = await supervisor.execute({ ...data, request_hash: canonicalSupervisorRequestHash(data) }, signal);
  if (response.outcome !== "accepted") throw new HermesStreamError("DEPENDENCY_UNAVAILABLE", response.retryable);
  const observation = response.observation;
  if (
    observation.tenant_id !== facts.tenantId || observation.runtime_id !== facts.runtime.runtimeId
    || observation.generation !== facts.runtime.generation || observation.image_ref !== facts.runtime.imageRef
    || !observation.exists || observation.lifecycle !== "running" || observation.health !== "healthy"
    || observation.private_origin === undefined
  ) throw new HermesStreamError("DEPENDENCY_UNAVAILABLE", false);
  return validateManagedHermesOrigin(observation.private_origin);
}
