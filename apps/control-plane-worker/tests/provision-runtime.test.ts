import assert from "node:assert/strict";
import test from "node:test";

import { handleProvisionRuntime } from "../src/handlers/provision-runtime.js";

const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;

test("provisioning probes sorted Profiles and releases ingress material", async () => {
  const calls: string[] = [];
  let released = 0;
  const result = await handleProvisionRuntime({
    loadFacts: async () => ({
      tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1,
      imageRef, platform: "linux/amd64", volumeRef: "volume_a",
      ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
      profiles: [
        { profileId: "profile_b", hermesProfileRef: "beta", description: "B", providerConfigId: "provider_a", providerBaseUrl: "https://provider.example/v1", modelId: "model_a", providerSecretRef: { reference_id: "provider_secret_a", version: 1, purpose: "model_provider" } },
        { profileId: "profile_a", hermesProfileRef: "alpha", description: "A", providerConfigId: "provider_a", providerBaseUrl: "https://provider.example/v1", modelId: "model_a", providerSecretRef: { reference_id: "provider_secret_a", version: 1, purpose: "model_provider" } },
      ],
    }),
    transitionToProvisioning: async () => true,
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://core-agent-runtime-abcd:8642" } }),
    getIngressMaterial: async () => ({ text: () => "synthetic-ingress", release: () => { released += 1; } }),
    probe: async (input) => { calls.push(`${input.profileRef}:${input.sessionId}:${input.origin}`); },
    succeed: async () => true,
    retry: async () => true,
    fail: async () => true,
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 1, maxAttempts: 5 }, new AbortController().signal);
  assert.equal(result.kind, "succeeded");
  assert.deepEqual(calls.map((call) => call.split(":")[0]), ["alpha", "beta"]);
  assert.match(calls[0]!, /readiness-runtime_a-1/);
  assert.equal(released, 1);
});

test("provisioning rejects unsafe private origins and still releases ingress material", async () => {
  let released = 0;
  let failed = 0;
  const result = await handleProvisionRuntime({
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, platform: "linux/amd64", volumeRef: "volume_a", ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" }, profiles: [] }),
    transitionToProvisioning: async () => true,
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://169.254.169.254:8642" } }),
    getIngressMaterial: async () => ({ text: () => "synthetic", release: () => { released += 1; } }),
    probe: async () => undefined, succeed: async () => true, retry: async () => true,
    fail: async () => { failed += 1; return true; },
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 5, maxAttempts: 5 }, new AbortController().signal);
  assert.equal(result.kind, "failed");
  assert.equal(released, 0);
  assert.equal(failed, 1);
});
