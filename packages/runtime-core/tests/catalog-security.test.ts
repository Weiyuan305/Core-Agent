import assert from "node:assert/strict";
import test from "node:test";
import { ImmutableArtifactRefSchema } from "@core-agent/contracts";
import Schema from "typebox/schema";

import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
function validation(): (value: unknown, kind: "capability" | "pack") => unknown {
  const value = runtime.validateCatalogCommandInput;
  assert.equal(typeof value, "function", "validateCatalogCommandInput must be exported");
  return value as (value: unknown, kind: "capability" | "pack") => unknown;
}
const canary = "catalog-canary-secret-must-never-leak";
const valid = Object.freeze({
  schema_version: 1, idempotency_key: "catalog-security", capability_id: "capability_security", capability_version_id: "capability_version_security",
  display_name: "Security", owning_domain: "synthetic", kind: "mcp", version: "1.0.0", artifact_ref: `manifest:sha256:${"a".repeat(64)}`,
  contract_ref: "synthetic/security@1.0.0", risk_class: "read", approval_requirement: "none",
  compatibility: { core_contract_version: "0.7.0", domain_contract_version: "1.0.0", runtime_protocol_version: "1.0.0", tenant_modes: ["b2b"] }, expected_resource_version: null,
});

test("catalog validation rejects hostile shapes without invoking accessors or reflecting input", () => {
  const accessor = { ...valid } as Record<string, unknown>; let accessed = 0;
  Object.defineProperty(accessor, "display_name", { enumerable: true, get() { accessed += 1; return canary; } });
  const attacks: unknown[] = [
    accessor,
    new Proxy({ ...valid, display_name: canary }, {}),
    Object.assign(Object.create({ poisoned: canary }), valid),
    { ...valid, compatibility: { ...valid.compatibility, tenant_modes: ["b2b", , "b2c"] } },
    { ...valid, display_name: canary.repeat(100) },
  ];
  for (const attack of attacks) {
    assert.throws(() => validation()(attack, "capability"), (error: unknown) => {
      assert(error instanceof DomainError); assert(!String(error.message).includes(canary)); return true;
    });
  }
  assert.equal(accessed, 0);
});

test("exact released Contracts validation remains stricter than the illustrative artifact regex", () => {
  const bad = { ...valid, version: "01.0.0", artifact_ref: `oci:UPPERCASE/${"a".repeat(1)}@sha256:${"a".repeat(64)}` };
  assert.throws(() => validation()(bad, "capability"), { code: "INVALID_REQUEST" });
  assert.equal(canonicalPayloadHash(valid).startsWith("sha256:"), true);
});

test("Runtime artifact admission exactly matches Contracts 0.8 for npm and qualified OCI boundaries", () => {
  const digest = Buffer.alloc(64, 0x61).toString("base64");
  const artifacts = [
    `npm:${"a".repeat(214)}@1.0.0#sha512-${digest}`,
    `oci:registry.example:5000/repository/path@sha256:${"a".repeat(64)}`,
    `oci:localhost:5000/repository@sha256:${"a".repeat(64)}`,
    `oci:registry.example.invalid/repository@sha256:${"a".repeat(64)}`,
    `oci:registry.example/repository@sha256:${"A".repeat(64)}`,
  ];
  for (const artifact_ref of artifacts) {
    const payload = { ...valid, artifact_ref };
    const acceptedByContracts = Schema.Check(ImmutableArtifactRefSchema, artifact_ref);
    assert.equal(
      (() => { try { validation()({ ...payload, payload_hash: canonicalPayloadHash(payload) }, "capability"); return true; } catch { return false; } })(),
      acceptedByContracts,
      artifact_ref,
    );
  }
});

test("catalog command copying bounds cycles depth nodes arrays and aggregate bytes without traps or reflection", () => {
  const cyclic = { ...valid, compatibility: { ...valid.compatibility } } as Record<string, unknown>;
  cyclic.irrelevant = cyclic;
  let deep: Record<string, unknown> = { canary };
  for (let index = 0; index < 80; index += 1) deep = { next: deep };
  const deepPayload = { ...valid, irrelevant: deep };
  const hugePayload = { ...valid, irrelevant: "x".repeat(70_000) };
  const giantArray = { ...valid, irrelevant: new Array(300).fill("x") };
  for (const payload of [cyclic, deepPayload, hugePayload, giantArray]) {
    assert.throws(() => validation()({ ...payload, payload_hash: "sha256:" + "0".repeat(64) }, "capability"), (error: unknown) => {
      assert(error instanceof DomainError); assert.equal(error.code, "INVALID_REQUEST"); assert(!error.message.includes(canary)); return true;
    });
  }
});

test("catalog command boundary rejects empty members, Pack nesting, duplicates, mutable artifacts, and oversized metadata", () => {
  const pack = {
    schema_version: 1, idempotency_key: "pack-boundary", pack_product_id: "pack_boundary", pack_version_id: "pack_version_boundary",
    display_name: "Boundary", tenant_modes: ["b2b"], version: "1.0.0", expected_resource_version: null,
    members: [{ capability_id: "capability_security", capability_version_id: "capability_version_security", version: "1.0.0" }],
  };
  for (const malformed of [
    { ...pack, members: [] },
    { ...pack, members: [{ ...pack.members[0], pack_version_id: "nested_pack" }] },
  ]) assert.throws(() => validation()({ ...malformed, payload_hash: canonicalPayloadHash(malformed) }, "pack"), { code: "INVALID_REQUEST" });
  for (const malformed of [
    { ...valid, artifact_ref: "oci:registry.example/mutable:latest" },
    { ...valid, display_name: "x".repeat(201) },
  ]) assert.throws(() => validation()({ ...malformed, payload_hash: canonicalPayloadHash(malformed) }, "capability"), { code: "INVALID_REQUEST" });
});
