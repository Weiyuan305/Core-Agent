import assert from "node:assert/strict";
import test from "node:test";

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
