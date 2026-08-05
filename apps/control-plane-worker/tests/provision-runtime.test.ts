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
    transitionToProvisioning: async () => ({ kind: "admitted" }),
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://core-agent-runtime-abcd:8642" } }),
    getIngressMaterial: async () => ({ text: () => "synthetic-ingress", release: () => { released += 1; } }),
    probe: async (input) => { calls.push(`${input.profileRef}:${input.sessionId}:${input.origin}`); },
    succeed: async () => ({ kind: "completed" }),
    retry: async () => true,
    fail: async () => ({ kind: "failed" }),
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
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, platform: "linux/amd64", volumeRef: "volume_a", ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" }, profiles: [{ profileId: "profile_a", hermesProfileRef: "alpha", description: "A", providerConfigId: "provider_a", providerBaseUrl: "https://provider.example/v1", modelId: "model_a", providerSecretRef: { reference_id: "provider_secret_a", version: 1, purpose: "model_provider" } }] }),
    transitionToProvisioning: async () => ({ kind: "admitted" }),
    supervisor: async (request) => ({ protocol_version: 1, operation_id: request.operation_id, outcome: "accepted", observation: { tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageRef, private_origin: "http://169.254.169.254:8642" } }),
    getIngressMaterial: async () => ({ text: () => "synthetic", release: () => { released += 1; } }),
    probe: async () => undefined, succeed: async () => ({ kind: "completed" }), retry: async () => true,
    fail: async () => { failed += 1; return { kind: "failed" }; },
  }, { tenantId: "tenant_a", jobId: "job_a", attemptCount: 5, maxAttempts: 5 }, new AbortController().signal);
  assert.equal(result.kind, "failed");
  assert.equal(released, 0);
  assert.equal(failed, 1);
});

test("superseded initial provisioning completes without Supervisor, secret, or Hermes work", async () => {
  const externalCalls: string[] = [];
  const result = await handleProvisionRuntime({
    transitionToProvisioning: async () => ({ kind: "superseded" }) as never,
    loadFacts: async () => { externalCalls.push("facts"); throw new Error("superseded provision must stop at admission"); },
    supervisor: async () => { externalCalls.push("supervisor"); throw new Error("not expected"); },
    getIngressMaterial: async () => { externalCalls.push("secret"); throw new Error("not expected"); },
    probe: async () => { externalCalls.push("hermes"); },
    succeed: async () => ({ kind: "completed" }) as never,
    retry: async () => true,
    fail: async () => ({ kind: "failed" }) as never,
  }, { tenantId: "tenant_a", jobId: "job_superseded", attemptCount: 1, maxAttempts: 5 }, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(externalCalls, []);
});

test("a defensive supersession discovered during provision failure reports succeeded", async () => {
  let supervisorCalls = 0; let hermesCalls = 0;
  const result = await handleProvisionRuntime({
    transitionToProvisioning: async () => ({ kind: "admitted" }) as never,
    loadFacts: async () => ({ tenantId: "tenant_a", runtimeId: "runtime_a", generation: 1, imageRef, platform: "linux/amd64", volumeRef: "volume_a", ingressSecretRef: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" }, profiles: [] }),
    supervisor: async (request) => { supervisorCalls += 1; return { protocol_version: 1, operation_id: request.operation_id, outcome: "failed", code: "DEPENDENCY_UNAVAILABLE", retryable: false, summary: "synthetic failure" }; },
    getIngressMaterial: async () => { throw new Error("not expected"); },
    probe: async () => { hermesCalls += 1; },
    succeed: async () => ({ kind: "completed" }) as never,
    retry: async () => true,
    fail: async () => ({ kind: "superseded" }) as never,
  }, { tenantId: "tenant_a", jobId: "job_terminal_superseded", attemptCount: 5, maxAttempts: 5 }, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.equal(supervisorCalls, 0);
  assert.equal(hermesCalls, 0);
});
