import assert from "node:assert/strict";
import test from "node:test";

import {
  createCapabilityRuntimeManifest,
  validateCapabilityRuntimeManifest,
} from "../src/runtime/capability-manifest.js";

const baseInput = Object.freeze({
  tenantId: "tenant_a",
  snapshotId: "snapshot_a",
  snapshotVersion: 3,
  runtimeGeneration: 7,
  capabilities: Object.freeze([
    Object.freeze({
      capabilityId: "capability_z",
      capabilityVersionId: "version_z",
      version: "2.0.0",
      kind: "policy" as const,
      riskClass: "read" as const,
    }),
    Object.freeze({
      capabilityId: "capability_a",
      capabilityVersionId: "version_a",
      version: "1.0.0",
      kind: "mcp" as const,
      riskClass: "draft_write" as const,
    }),
    Object.freeze({
      capabilityId: "capability_a",
      capabilityVersionId: "version_a",
      version: "1.0.0",
      kind: "mcp" as const,
      riskClass: "draft_write" as const,
    }),
  ]),
});

test("Capability Runtime manifest is exact sorted deduplicated and deterministic", () => {
  const first = createCapabilityRuntimeManifest(baseInput);
  const second = createCapabilityRuntimeManifest({
    ...baseInput,
    capabilities: [...baseInput.capabilities].reverse(),
  });

  assert.deepEqual(first, second);
  assert.deepEqual(first.manifest, {
    schema_version: 1,
    tenant_id: "tenant_a",
    snapshot_id: "snapshot_a",
    snapshot_version: 3,
    runtime_generation: 7,
    capabilities: [
      {
        capability_id: "capability_a",
        capability_version_id: "version_a",
        version: "1.0.0",
        kind: "mcp",
      },
      {
        capability_id: "capability_z",
        capability_version_id: "version_z",
        version: "2.0.0",
        kind: "policy",
      },
    ],
  });
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.canonicalJson, JSON.stringify(first.manifest));
  assert.deepEqual(validateCapabilityRuntimeManifest(first.manifest, first.digest), first.manifest);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.manifest));
  assert.ok(Object.isFrozen(first.manifest.capabilities));
});

test("Capability Runtime manifest rejects executable risk and conflicting versions", () => {
  for (const riskClass of ["external_write", "privileged"] as const) {
    assert.throws(() => createCapabilityRuntimeManifest({
      ...baseInput,
      capabilities: [{ ...baseInput.capabilities[0]!, riskClass }],
    }), /CAPABILITY_MANIFEST_INVALID/);
  }
  assert.throws(() => createCapabilityRuntimeManifest({
    ...baseInput,
    capabilities: [
      baseInput.capabilities[0]!,
      { ...baseInput.capabilities[0]!, capabilityVersionId: "version_other", version: "3.0.0" },
    ],
  }), /CAPABILITY_MANIFEST_INVALID/);
});

test("Capability Runtime manifest rejects secrets tool surfaces and hostile shapes", () => {
  const valid = createCapabilityRuntimeManifest(baseInput);
  const forbidden: unknown[] = [
    { ...valid.manifest, artifact_url: "https://artifact.example/private" },
    { ...valid.manifest, secret_ref: "secret_a" },
    { ...valid.manifest, tools: [{ name: "write_customer" }] },
    { ...valid.manifest, mcp_servers: [{ command: "node" }] },
    { ...valid.manifest, capabilities: [{ ...valid.manifest.capabilities[0]!, tool_schema: {} }] },
  ];
  for (const value of forbidden) {
    assert.throws(() => validateCapabilityRuntimeManifest(value, valid.digest), /CAPABILITY_MANIFEST_INVALID/);
  }

  let getterReads = 0;
  const accessor = { ...valid.manifest } as Record<string, unknown>;
  Object.defineProperty(accessor, "capabilities", {
    enumerable: true,
    get: () => {
      getterReads += 1;
      return [];
    },
  });
  assert.throws(() => validateCapabilityRuntimeManifest(accessor, valid.digest), /CAPABILITY_MANIFEST_INVALID/);
  assert.equal(getterReads, 0);
});

test("Capability Runtime manifest binds every field and enforces count and byte budgets", () => {
  const valid = createCapabilityRuntimeManifest(baseInput);
  assert.throws(() => createCapabilityRuntimeManifest({
    ...baseInput,
    capabilities: [],
  }), /CAPABILITY_MANIFEST_INVALID/);
  assert.throws(() => validateCapabilityRuntimeManifest(
    { ...valid.manifest, runtime_generation: 8 },
    valid.digest,
  ), /CAPABILITY_MANIFEST_INVALID/);
  assert.throws(() => createCapabilityRuntimeManifest({
    ...baseInput,
    capabilities: Array.from({ length: 257 }, (_, index) => ({
      capabilityId: `capability_${String(index).padStart(3, "0")}`,
      capabilityVersionId: `version_${String(index).padStart(3, "0")}`,
      version: "1.0.0",
      kind: "skill" as const,
      riskClass: "read" as const,
    })),
  }), /CAPABILITY_MANIFEST_INVALID/);
  assert.throws(() => createCapabilityRuntimeManifest({
    ...baseInput,
    capabilities: [{
      capabilityId: "capability_a",
      capabilityVersionId: "version_a",
      version: "1." + "0".repeat(70_000),
      kind: "skill" as const,
      riskClass: "read" as const,
    }],
  }), /CAPABILITY_MANIFEST_INVALID/);
});
