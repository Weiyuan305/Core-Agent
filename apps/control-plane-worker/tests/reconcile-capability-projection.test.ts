import assert from "node:assert/strict";
import test from "node:test";

import {
  createCapabilityRuntimeManifest,
  type CapabilityRuntimeObservation,
  type SupervisorRequestV2,
  type SupervisorResponseV2,
} from "@core-agent/runtime-core";

import {
  handleReconcileCapabilityProjection,
  type CapabilityProjectionFacts,
  type CapabilityProjectionPort,
} from "../src/handlers/reconcile-capability-projection.js";

const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;

function facts(): CapabilityProjectionFacts {
  const capability = createCapabilityRuntimeManifest({
    tenantId: "tenant_a",
    snapshotId: "snapshot_a",
    snapshotVersion: 3,
    runtimeGeneration: 7,
    capabilities: [{
      capabilityId: "capability_a",
      capabilityVersionId: "capability_version_a",
      version: "1.2.3",
      kind: "mcp",
      riskClass: "read",
    }],
  });
  return Object.freeze({
    tenantId: "tenant_a",
    projectionId: "projection_a",
    profileId: "profile_a",
    snapshotId: "snapshot_a",
    snapshotVersion: 3,
    runtimeId: "runtime_a",
    runtimeGeneration: 7,
    imageRef,
    platform: "linux/amd64",
    volumeRef: "volume_a",
    ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" as const },
    profiles: [{
      profileId: "profile_a", hermesProfileRef: "alpha", description: "A",
      providerConfigId: "provider_a", providerBaseUrl: "https://provider.example/v1", modelId: "model_a",
      providerSecretRef: { reference_id: "provider_secret_a", version: 1, purpose: "model_provider" as const },
    }],
    expectedProfileIds: ["profile_a"],
    manifest: capability.manifest,
    manifestDigest: capability.digest,
  });
}

function accepted(request: SupervisorRequestV2, value = facts()): SupervisorResponseV2 {
  const observation: CapabilityRuntimeObservation = {
    tenant_id: value.tenantId,
    runtime_id: value.runtimeId,
    generation: value.runtimeGeneration,
    exists: true,
    lifecycle: "running",
    health: "healthy",
    image_ref: value.imageRef,
    private_origin: "http://core-agent-runtime-abcd:8642",
    profile_ids: value.expectedProfileIds,
    capability_manifest_digest: value.manifestDigest,
  };
  return { protocol_version: 2, operation_id: request.operation_id, outcome: "accepted", observation };
}

function port(overrides: Partial<CapabilityProjectionPort> = {}) {
  const calls: string[] = [];
  const requests: SupervisorRequestV2[] = [];
  const value = facts();
  const implementation: CapabilityProjectionPort = {
    prepare: async () => { calls.push("prepare"); return { kind: "ready", facts: value }; },
    markEffectDispatched: async () => { calls.push("fence"); return true; },
    supervisor: async (request) => { calls.push(request.kind); requests.push(request); return accepted(request, value); },
    complete: async (_job, completedFacts, observation) => {
      calls.push("complete");
      assert.equal(completedFacts, value);
      assert.equal(observation.capability_manifest_digest, value.manifestDigest);
      return { kind: "completed" };
    },
    retry: async () => { calls.push("retry"); return true; },
    fail: async () => { calls.push("fail"); return { kind: "failed" }; },
    ...overrides,
  };
  return { implementation, calls, requests, value };
}

const job = Object.freeze({
  tenantId: "tenant_a", jobId: "job_projection_a", attemptCount: 1, maxAttempts: 5,
  effectState: "pre_effect" as const,
});

test("projection fences one deterministic v2 provision, inspects, then commits availability", async () => {
  const state = port();
  const result = await handleReconcileCapabilityProjection(state.implementation, job, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(state.calls, ["prepare", "fence", "provision", "inspect", "complete"]);
  assert.equal(state.requests.length, 2);
  assert.equal(state.requests[0]!.protocol_version, 2);
  assert.equal(state.requests[0]!.kind, "provision");
  assert.equal(state.requests[1]!.kind, "inspect");
  assert.equal(state.requests[0]!.operation_id, "op_27648d4b71b63162457410f9810f1fb87816f9c290fd30e9");
  assert.equal(state.requests[1]!.operation_id, "op_473669dad574dc88430549281cc86ac201b32e65185a94fe");
});

test("projection recovery reuses the same durable provision identity before inspection", async () => {
  const state = port();
  const result = await handleReconcileCapabilityProjection(
    state.implementation,
    { ...job, effectState: "unsafe_to_replay" },
    new AbortController().signal,
  );
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(state.calls, ["prepare", "provision", "inspect", "complete"]);
  assert.equal(state.requests[0]!.operation_id, "op_27648d4b71b63162457410f9810f1fb87816f9c290fd30e9");
});

test("projection mismatch retries without making authority available", async () => {
  let completed = 0;
  const state = port({
    supervisor: async (request) => {
      if (request.kind === "provision") return accepted(request);
      const response = accepted(request);
      if (response.outcome !== "accepted") return response;
      return { ...response, observation: { ...response.observation, capability_manifest_digest: `sha256:${"f".repeat(64)}` } };
    },
    complete: async () => { completed += 1; return { kind: "completed" }; },
  });
  const result = await handleReconcileCapabilityProjection(state.implementation, job, new AbortController().signal);
  assert.equal(result.kind, "retry");
  assert.equal(completed, 0);
  assert.equal(state.calls.at(-1), "retry");
});

test("projection terminal failure records a safe reason and never completes", async () => {
  let reason: string | undefined;
  const state = port({
    supervisor: async (request) => ({
      protocol_version: 2, operation_id: request.operation_id, outcome: "failed",
      code: "DEPENDENCY_UNAVAILABLE", retryable: false, summary: "Bearer synthetic-secret internal /path",
    }),
    fail: async (_job, failure) => { reason = `${failure.reasonCode}:${failure.summary}`; return { kind: "failed" }; },
  });
  const result = await handleReconcileCapabilityProjection(
    state.implementation,
    { ...job, attemptCount: 5 },
    new AbortController().signal,
  );
  assert.equal(result.kind, "failed");
  assert.match(reason ?? "", /^runtime_preparation_failed:/);
  assert.doesNotMatch(reason ?? "", /synthetic-secret/);
  assert.equal(state.calls.includes("complete"), false);
});
