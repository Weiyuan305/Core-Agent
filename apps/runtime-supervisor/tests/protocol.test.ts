import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SUPERVISOR_FRAME_BYTES,
  canonicalSupervisorRequestHash,
  decodeSupervisorFrame,
  encodeSupervisorFrame,
  validateSupervisorRequest,
  type ProvisionRuntimeCommandDataV1,
} from "../src/protocol.js";

function provisionData(): ProvisionRuntimeCommandDataV1 {
  return {
    protocol_version: 1,
    operation_id: "operation_a",
    kind: "provision",
    runtime: {
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 1,
      image_ref: `managed/runtime@sha256:${"a".repeat(64)}`,
      platform: "linux/amd64",
      volume_ref: "volume_a",
      ingress_secret_ref: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
      profiles: [{
        profile_id: "profile_a",
        hermes_profile_ref: "profile_a",
        description: "Synthetic profile",
        provider_config_id: "provider_a",
        provider_base_url: "https://provider.example/v1",
        model_id: "model_a",
        provider_secret_ref: { reference_id: "provider_a", version: 1, purpose: "model_provider" },
      }],
    },
  };
}

function signed() {
  const data = provisionData();
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

test("unsafe Supervisor operations and unknown Docker controls are rejected", () => {
  const valid = signed();
  const forbidden: unknown[] = [
    { command: "exec", args: ["sh"] },
    { ...valid, runtime: { ...valid.runtime, host_path: "/Users/example" } },
    { ...valid, runtime: { ...valid.runtime, image_ref: "core-agent/hermes-runtime:latest" } },
    { ...valid, runtime: { ...valid.runtime, ports: ["0.0.0.0:8642:8642"] } },
    { ...valid, runtime: { ...valid.runtime, environment: { API_SERVER_KEY: "sentinel" } } },
    { ...valid, runtime: { ...valid.runtime, docker_options: { Privileged: true } } },
    { ...valid, runtime: { ...valid.runtime, network_ref: "client-selected" } },
    { protocol_version: 1, operation_id: "delete_a", request_hash: valid.request_hash, kind: "delete", tenant_id: "tenant_a", runtime_id: "runtime_a", generation: 1, destroy_volume: true },
    { ...valid, runtime: { ...valid.runtime, ingress_secret_ref: { ...valid.runtime.ingress_secret_ref, value: "sentinel" } } },
  ];
  for (const value of forbidden) {
    assert.throws(() => validateSupervisorRequest(value), /SUPERVISOR_REJECTED/);
  }
});

test("Supervisor validation rejects inherited, null-prototype, unknown, and sparse shapes", () => {
  const valid = signed();
  const inherited = Object.create(valid) as object;
  const nullPrototype = Object.assign(Object.create(null) as object, valid);
  const sparseProfiles = new Array(2);
  sparseProfiles[1] = valid.runtime.profiles[0];
  for (const value of [
    inherited,
    nullPrototype,
    { ...valid, unknown_bag: {} },
    { ...valid, runtime: { ...valid.runtime, profiles: sparseProfiles } },
  ]) {
    assert.throws(() => validateSupervisorRequest(value), /SUPERVISOR_REJECTED/);
  }
});

test("Supervisor validation rejects hidden and symbol own-property bags", () => {
  const hiddenRoot = signed() as Record<PropertyKey, unknown>;
  Object.defineProperty(hiddenRoot, "ports", { value: ["127.0.0.1:1:1"], enumerable: false });
  const hiddenNested = signed();
  Object.defineProperty(hiddenNested.runtime, "host_path", { value: "/private/path", enumerable: false });
  const symbolRoot = signed() as Record<PropertyKey, unknown>;
  symbolRoot[Symbol("docker_options")] = { privileged: true };
  const accessorRoot = signed();
  Object.defineProperty(accessorRoot, "operation_id", { get: () => "operation_a", enumerable: true });
  for (const [name, value] of [
    ["hidden root", hiddenRoot],
    ["hidden nested", hiddenNested],
    ["symbol root", symbolRoot],
    ["accessor root", accessorRoot],
  ] as const) {
    assert.throws(() => validateSupervisorRequest(value), /SUPERVISOR_REJECTED/, name);
  }
});

test("Supervisor request hashing is canonical, excludes request_hash, and permits opaque secret metadata", () => {
  const data = provisionData();
  const reversed = Object.fromEntries(Object.entries(data).reverse());
  const hash = canonicalSupervisorRequestHash(data);
  assert.equal(hash, canonicalSupervisorRequestHash(reversed));
  assert.equal(hash, canonicalSupervisorRequestHash({ ...data, request_hash: `sha256:${"f".repeat(64)}` }));
  assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => canonicalSupervisorRequestHash({ ...data, runtime: { ...data.runtime, profiles: [, data.runtime.profiles[0]] } }), /SUPERVISOR_REJECTED/);
});

test("Supervisor frame parser rejects invalid lengths, trailing data, UTF-8, and JSON", () => {
  const valid = encodeSupervisorFrame(signed());
  assert.deepEqual(decodeSupervisorFrame(valid), signed());

  const zero = Buffer.alloc(4);
  assert.throws(() => decodeSupervisorFrame(zero), /SUPERVISOR_REJECTED/);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_SUPERVISOR_FRAME_BYTES + 1);
  assert.throws(() => decodeSupervisorFrame(oversized), /SUPERVISOR_REJECTED/);
  assert.throws(() => decodeSupervisorFrame(Buffer.concat([valid, Buffer.from([0])])), /SUPERVISOR_REJECTED/);

  const invalidUtf8 = Buffer.from([0, 0, 0, 2, 0xc3, 0x28]);
  assert.throws(() => decodeSupervisorFrame(invalidUtf8), /SUPERVISOR_REJECTED/);
  const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("{")]);
  assert.throws(() => decodeSupervisorFrame(invalidJson), /SUPERVISOR_REJECTED/);
});
