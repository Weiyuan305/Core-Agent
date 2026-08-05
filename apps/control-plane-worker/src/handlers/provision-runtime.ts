import { createHash } from "node:crypto";
import { isIP } from "node:net";

import {
  canonicalSupervisorRequestHash,
  isDatabaseTransactionRetryExhaustedError,
  type ProvisionRuntimeCommandDataV1,
  type ProvisionAdmissionResult,
  type ProvisionCompletionResult,
  type ProvisionFailureResult,
  type SecretReference,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import type { HandlerResult } from "../dispatch-job.js";

export interface ProvisionProfileFacts {
  readonly profileId: string;
  readonly hermesProfileRef: string;
  readonly description: string;
  readonly providerConfigId: string;
  readonly providerBaseUrl: string;
  readonly modelId: string;
  readonly providerSecretRef: SecretReference;
}

export interface ProvisionRuntimeFacts {
  readonly tenantId: string;
  readonly runtimeId: string;
  readonly generation: number;
  readonly imageRef: string;
  readonly platform: "linux/amd64" | "linux/arm64";
  readonly volumeRef: string;
  readonly ingressSecretRef: SecretReference;
  readonly profiles: readonly ProvisionProfileFacts[];
}

interface IngressMaterial { text(): string; release(): void }
interface ProvisionJob { readonly tenantId: string; readonly jobId: string; readonly attemptCount: number; readonly maxAttempts: number }

export interface ProvisionRuntimePort {
  loadFacts(job: ProvisionJob): Promise<ProvisionRuntimeFacts>;
  transitionToProvisioning(job: ProvisionJob): Promise<ProvisionAdmissionResult>;
  supervisor(request: SupervisorRequestV1, signal: AbortSignal): Promise<SupervisorResponseV1>;
  getIngressMaterial(reference: SecretReference): Promise<IngressMaterial>;
  probe(input: { origin: string; profileRef: string; sessionId: string; ingressKey: string; modelId: string }, signal: AbortSignal): Promise<void>;
  succeed(job: ProvisionJob): Promise<ProvisionCompletionResult>;
  retry(job: ProvisionJob, summary: string): Promise<boolean>;
  fail(job: ProvisionJob, summary: string): Promise<ProvisionFailureResult>;
}

export function validatePrivateHermesOrigin(value: string | undefined): string {
  if (value === undefined) throw new Error("Supervisor observation omitted the private Hermes origin");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Supervisor returned an unsafe private Hermes origin"); }
  if (
    url.protocol !== "http:" || url.port !== "8642" || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== ""
    || !trustedPrivateHost(url.hostname)
  ) throw new Error("Supervisor returned an unsafe private Hermes origin");
  return url.origin;
}

function trustedPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^core-agent-runtime-[a-z0-9]{4,64}$/.test(normalized)) return true;
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    return parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168);
  }
  return isIP(normalized) === 6 && /^(fc|fd)/i.test(normalized);
}

function observationMatches(facts: ProvisionRuntimeFacts, response: SupervisorResponseV1): response is Extract<SupervisorResponseV1, { outcome: "accepted" }> {
  if (response.outcome !== "accepted") return false;
  const observation = response.observation;
  return observation.tenant_id === facts.tenantId && observation.runtime_id === facts.runtimeId
    && observation.generation === facts.generation && observation.image_ref === facts.imageRef
    && observation.exists && observation.lifecycle === "running";
}

export function buildProvisionRuntimeRequest(facts: ProvisionRuntimeFacts, operationSeed: string): SupervisorRequestV1 {
  const operationId = `op_${createHash("sha256").update(`${operationSeed}:provision`, "utf8").digest("hex").slice(0, 48)}`;
  const data: ProvisionRuntimeCommandDataV1 = {
    protocol_version: 1, operation_id: operationId, kind: "provision",
    runtime: {
      tenant_id: facts.tenantId, runtime_id: facts.runtimeId, generation: facts.generation,
      image_ref: facts.imageRef, platform: facts.platform, volume_ref: facts.volumeRef,
      ingress_secret_ref: facts.ingressSecretRef,
      profiles: [...facts.profiles].sort((a, b) => a.hermesProfileRef.localeCompare(b.hermesProfileRef)).map((profile) => ({
        profile_id: profile.profileId, hermes_profile_ref: profile.hermesProfileRef,
        description: profile.description, provider_config_id: profile.providerConfigId,
        provider_base_url: profile.providerBaseUrl, model_id: profile.modelId,
        provider_secret_ref: profile.providerSecretRef,
      })),
    },
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function boundedSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : "Runtime provisioning failed";
  return text.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1000) || "Runtime provisioning failed";
}

function isTypedRetryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === true;
}

export async function handleProvisionRuntime(port: ProvisionRuntimePort, job: ProvisionJob, signal: AbortSignal): Promise<HandlerResult> {
  try {
    const admission = await port.transitionToProvisioning(job);
    if (admission.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
    if (admission.kind === "superseded") return { kind: "succeeded" };
    const facts = await port.loadFacts(job);
    const response = await port.supervisor(buildProvisionRuntimeRequest(facts, job.jobId), signal);
    if (response.outcome !== "accepted") {
      if (response.retryable && job.attemptCount < job.maxAttempts) {
        await port.retry(job, boundedSummary(response.summary));
        return { kind: "retry", summary: boundedSummary(response.summary) };
      }
      const failed = await port.fail(job, boundedSummary(response.summary));
      if (failed.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
      if (failed.kind === "superseded") return { kind: "succeeded" };
      return { kind: "failed", summary: boundedSummary(response.summary) };
    }
    if (!observationMatches(facts, response)) throw new Error("Supervisor observation does not match stored runtime identity");
    const origin = validatePrivateHermesOrigin(response.observation.private_origin);
    const material = await port.getIngressMaterial(facts.ingressSecretRef);
    try {
      for (const profile of [...facts.profiles].sort((a, b) => a.hermesProfileRef.localeCompare(b.hermesProfileRef))) {
        if (signal.aborted) throw new Error("Runtime provisioning aborted");
        await port.probe({ origin, profileRef: profile.hermesProfileRef, sessionId: `readiness-${facts.runtimeId}-${facts.generation}`, ingressKey: material.text(), modelId: profile.modelId }, signal);
      }
    } finally { material.release(); }
    const completed = await port.succeed(job);
    if (completed.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "succeeded" };
  } catch (error) {
    if (isDatabaseTransactionRetryExhaustedError(error)) throw error;
    const summary = boundedSummary(error);
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    if (job.attemptCount < job.maxAttempts && isTypedRetryable(error)) {
      await port.retry(job, summary); return { kind: "retry", summary };
    }
    const failed = await port.fail(job, summary);
    if (failed.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
    if (failed.kind === "superseded") return { kind: "succeeded" };
    return { kind: "failed", summary };
  }
}
