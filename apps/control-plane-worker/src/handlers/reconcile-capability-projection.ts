import { createHash } from "node:crypto";

import {
  canonicalSupervisorRequestHash,
  isDatabaseTransactionRetryExhaustedError,
  type CapabilityInspectRuntimeCommandDataV2,
  type CapabilityProvisionRuntimeCommandDataV2,
  type CapabilityRuntimeManifestV1,
  type CapabilityRuntimeObservation,
  type SecretReference,
  type SupervisorRequestV2,
  type SupervisorResponseV2,
} from "@core-agent/runtime-core";

import type { HandlerResult } from "../dispatch-job.js";

export interface CapabilityProjectionProfileFacts {
  readonly profileId: string;
  readonly hermesProfileRef: string;
  readonly description: string;
  readonly providerConfigId: string;
  readonly providerBaseUrl: string;
  readonly modelId: string;
  readonly providerSecretRef: SecretReference;
}

export interface CapabilityProjectionFacts {
  readonly tenantId: string;
  readonly projectionId: string;
  readonly profileId: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
  readonly imageRef: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly volumeRef: string;
  readonly ingressSecretRef: SecretReference;
  readonly profiles: readonly CapabilityProjectionProfileFacts[];
  readonly expectedProfileIds: readonly string[];
  readonly manifest: CapabilityRuntimeManifestV1;
  readonly manifestDigest: `sha256:${string}`;
}

export interface CapabilityProjectionJob {
  readonly tenantId: string;
  readonly jobId: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly effectState: "pre_effect" | "unsafe_to_replay";
}

export type CapabilityProjectionFailureReason =
  | "runtime_preparation_failed"
  | "runtime_health_check_failed"
  | "capability_manifest_mismatch";

export interface CapabilityProjectionFailure {
  readonly reasonCode: CapabilityProjectionFailureReason;
  readonly summary: string;
}

export interface CapabilityProjectionPort {
  prepare(job: CapabilityProjectionJob): Promise<
    | { readonly kind: "ready"; readonly facts: CapabilityProjectionFacts }
    | { readonly kind: "superseded" | "lease_lost" }
  >;
  markEffectDispatched(job: CapabilityProjectionJob, facts: CapabilityProjectionFacts): Promise<boolean>;
  supervisor(request: SupervisorRequestV2, signal: AbortSignal): Promise<SupervisorResponseV2>;
  complete(
    job: CapabilityProjectionJob,
    facts: CapabilityProjectionFacts,
    observation: CapabilityRuntimeObservation,
  ): Promise<{ readonly kind: "completed" | "superseded" | "lease_lost" }>;
  retry(job: CapabilityProjectionJob, failure: CapabilityProjectionFailure): Promise<boolean>;
  fail(job: CapabilityProjectionJob, failure: CapabilityProjectionFailure): Promise<{ readonly kind: "failed" | "superseded" | "lease_lost" }>;
}

class ProjectionFailure extends Error {
  public constructor(readonly reasonCode: CapabilityProjectionFailureReason, message: string, readonly retryable = true) {
    super(message);
  }
}

function operationId(job: CapabilityProjectionJob, facts: CapabilityProjectionFacts, kind: "provision" | "inspect"): string {
  return `op_${createHash("sha256").update(`${job.jobId}:${facts.projectionId}:${kind}`, "utf8").digest("hex").slice(0, 48)}`;
}

function sortedProfiles(facts: CapabilityProjectionFacts) {
  return [...facts.profiles]
    .sort((left, right) => Buffer.compare(Buffer.from(left.hermesProfileRef, "utf8"), Buffer.from(right.hermesProfileRef, "utf8")))
    .map((profile) => ({
      profile_id: profile.profileId,
      hermes_profile_ref: profile.hermesProfileRef,
      description: profile.description,
      provider_config_id: profile.providerConfigId,
      provider_base_url: profile.providerBaseUrl,
      model_id: profile.modelId,
      provider_secret_ref: profile.providerSecretRef,
    }));
}

export function buildCapabilityProvisionRequest(
  job: CapabilityProjectionJob,
  facts: CapabilityProjectionFacts,
): SupervisorRequestV2 {
  const data: CapabilityProvisionRuntimeCommandDataV2 = {
    protocol_version: 2,
    operation_id: operationId(job, facts, "provision"),
    kind: "provision",
    runtime: {
      tenant_id: facts.tenantId,
      runtime_id: facts.runtimeId,
      generation: facts.runtimeGeneration,
      image_ref: facts.imageRef,
      platform: facts.platform,
      volume_ref: facts.volumeRef,
      ingress_secret_ref: facts.ingressSecretRef,
      profiles: sortedProfiles(facts),
    },
    capability_manifest: facts.manifest,
    capability_manifest_digest: facts.manifestDigest,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

export function buildCapabilityInspectRequest(
  job: CapabilityProjectionJob,
  facts: CapabilityProjectionFacts,
): SupervisorRequestV2 {
  const data: CapabilityInspectRuntimeCommandDataV2 = {
    protocol_version: 2,
    operation_id: operationId(job, facts, "inspect"),
    kind: "inspect",
    tenant_id: facts.tenantId,
    runtime_id: facts.runtimeId,
    generation: facts.runtimeGeneration,
    capability_manifest_digest: facts.manifestDigest,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function exactProfileSet(actual: readonly string[], expected: readonly string[]): boolean {
  const sorted = [...expected].sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
  return actual.length === sorted.length && actual.every((profileId, index) => profileId === sorted[index]);
}

function requireObservation(
  response: SupervisorResponseV2,
  facts: CapabilityProjectionFacts,
): CapabilityRuntimeObservation {
  if (response.outcome !== "accepted") {
    throw new ProjectionFailure("runtime_preparation_failed", response.summary, response.retryable);
  }
  const observation = response.observation;
  if (
    observation.tenant_id !== facts.tenantId
    || observation.runtime_id !== facts.runtimeId
    || observation.generation !== facts.runtimeGeneration
    || observation.image_ref !== facts.imageRef
    || observation.capability_manifest_digest !== facts.manifestDigest
    || !exactProfileSet(observation.profile_ids, facts.expectedProfileIds)
  ) throw new ProjectionFailure("capability_manifest_mismatch", "Runtime capability projection proof did not match expected authority");
  if (!observation.exists || observation.lifecycle !== "running" || observation.health !== "healthy") {
    throw new ProjectionFailure("runtime_health_check_failed", "Runtime capability projection did not become healthy");
  }
  return observation;
}

function safeSummary(error: unknown): string {
  const source = error instanceof Error ? error.message : "Runtime capability projection failed";
  return source
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(?:\/[^\s]+)+/gu, "[PATH]")
    .slice(0, 500) || "Runtime capability projection failed";
}

function failureFrom(error: unknown): CapabilityProjectionFailure & { readonly retryable: boolean } {
  if (error instanceof ProjectionFailure) {
    return Object.freeze({ reasonCode: error.reasonCode, summary: safeSummary(error), retryable: error.retryable });
  }
  return Object.freeze({ reasonCode: "runtime_preparation_failed", summary: safeSummary(error), retryable: true });
}

export async function handleReconcileCapabilityProjection(
  port: CapabilityProjectionPort,
  job: CapabilityProjectionJob,
  signal: AbortSignal,
): Promise<HandlerResult> {
  try {
    const prepared = await port.prepare(job);
    if (prepared.kind !== "ready") {
      return prepared.kind === "lease_lost"
        ? { kind: "failed", summary: "Worker job lease lost" }
        : { kind: "succeeded" };
    }
    const facts = prepared.facts;
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    if (job.effectState === "pre_effect" && !await port.markEffectDispatched(job, facts)) {
      return { kind: "failed", summary: "Worker job lease lost" };
    }
    requireObservation(await port.supervisor(buildCapabilityProvisionRequest(job, facts), signal), facts);
    const observation = requireObservation(await port.supervisor(buildCapabilityInspectRequest(job, facts), signal), facts);
    const completed = await port.complete(job, facts, observation);
    if (completed.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "succeeded" };
  } catch (error) {
    if (isDatabaseTransactionRetryExhaustedError(error)) throw error;
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    const failure = failureFrom(error);
    if (failure.retryable && job.attemptCount < job.maxAttempts) {
      const retried = await port.retry(job, failure);
      return retried ? { kind: "retry", summary: failure.summary } : { kind: "failed", summary: "Worker job lease lost" };
    }
    const failed = await port.fail(job, failure);
    if (failed.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
    if (failed.kind === "superseded") return { kind: "succeeded" };
    return { kind: "failed", summary: failure.summary };
  }
}
