import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalSupervisorRequestHash, loadProviderCatalog, type ProvisionRuntimeCommandDataV1 } from "@core-agent/runtime-core";

import { deriveRuntimeNames, validateSupervisorPolicy } from "../src/policy.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imageLock = JSON.parse(await readFile(join(repositoryRoot, "infra", "hermes", "base-images.lock.json"), "utf8")) as unknown;
const catalog = loadProviderCatalog(JSON.parse(await readFile(join(repositoryRoot, "infra", "runtime", "providers.dev.json"), "utf8")));
const amd64Image = `nousresearch/hermes-agent:v2026.7.30@sha256:${"5316c2c2534c49f5e1b1691e1a2115f1230d900033c3b35d1c8fc2e47352b26d"}`;

function provisionData(overrides: Partial<ProvisionRuntimeCommandDataV1["runtime"]> = {}): ProvisionRuntimeCommandDataV1 {
  return {
    protocol_version: 1,
    operation_id: "operation_a",
    kind: "provision",
    runtime: {
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 7,
      image_ref: amd64Image,
      platform: "linux/amd64",
      volume_ref: "volume_a",
      ingress_secret_ref: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
      profiles: [{
        profile_id: "profile_a",
        hermes_profile_ref: "profile_a",
        description: "Synthetic consultant",
        provider_config_id: "tokenhub-main",
        provider_base_url: "https://tokenhub.infplacex.com/v1/chat/completions",
        model_id: "cywx/gpt-5.6-sol",
        provider_secret_ref: { reference_id: "provider_tokenhub_main", version: 1, purpose: "model_provider" },
      }],
      ...overrides,
    },
  };
}

function signed(data = provisionData()) {
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

test("policy accepts only the exact managed image platform provider model and secret purposes", () => {
  assert.doesNotThrow(() => validateSupervisorPolicy(signed(), { imageLock, providerCatalog: catalog }));
  const invalid = [
    provisionData({ image_ref: `other/runtime@sha256:${"a".repeat(64)}` }),
    provisionData({ platform: "linux/arm64" }),
    provisionData({ profiles: [{ ...provisionData().runtime.profiles[0]!, provider_base_url: "https://other.example/v1" }] }),
    provisionData({ profiles: [{ ...provisionData().runtime.profiles[0]!, model_id: "unknown-model" }] }),
    provisionData({ profiles: [{ ...provisionData().runtime.profiles[0]!, provider_secret_ref: { reference_id: "provider_tokenhub_main", version: 1, purpose: "hermes_ingress" } }] }),
    provisionData({ ingress_secret_ref: { reference_id: "ingress_a", version: 1, purpose: "model_provider" } }),
  ];
  for (const data of invalid) {
    assert.throws(() => validateSupervisorPolicy(signed(data), { imageLock, providerCatalog: catalog }), /SUPERVISOR_REJECTED/);
  }
});

test("policy rejects duplicate profiles, unbounded labels descriptions and generations", () => {
  const profile = provisionData().runtime.profiles[0]!;
  const invalid = [
    provisionData({ profiles: [profile, { ...profile }] }),
    provisionData({ profiles: [{ ...profile, hermes_profile_ref: "UPPERCASE" }] }),
    provisionData({ profiles: [{ ...profile, description: "x".repeat(2_001) }] }),
    provisionData({ tenant_id: "tenant/unsafe" }),
    provisionData({ generation: 2_147_483_648 }),
  ];
  for (const data of invalid) {
    assert.throws(() => validateSupervisorPolicy(signed(data), { imageLock, providerCatalog: catalog }), /SUPERVISOR_REJECTED/);
  }
});

test("policy derives deterministic Docker names internally and rejects supplied names", () => {
  assert.deepEqual(deriveRuntimeNames({ tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 7 }), {
    container: "core-agent-runtime-f7451a3e701c28c5-g7",
    volume: "core-agent-data-f7451a3e701c28c5",
    network: "core-agent-backplane",
  });
  const data = provisionData();
  const request = signed(data);
  assert.throws(
    () => validateSupervisorPolicy({ ...request, runtime: { ...request.runtime, container_name: deriveRuntimeNames(request.runtime).container } } as never, { imageLock, providerCatalog: catalog }),
    /SUPERVISOR_REJECTED/,
  );
});
