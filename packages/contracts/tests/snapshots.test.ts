import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  CapabilityServiceProjectionSchema,
  EntitlementSnapshotSchema,
  ProfileSnapshotPointerSchema,
  validateEntitlementSnapshot,
  validateEntitlementSnapshotRef,
} from "../src/index.js";

const metadata = {
  schema_version: 1 as const,
  resource_version: 1,
  created_at: "2026-08-20T01:00:00Z",
  updated_at: "2026-08-20T01:00:00Z",
};

const snapshot = {
  ...metadata,
  snapshot_id: "snapshot_demo_7",
  tenant_id: "tenant_demo",
  profile_id: "profile_demo",
  version: 7,
  evaluated_at: "2026-08-20T01:00:00Z",
  source_entitlement_ids: ["entitlement_a", "entitlement_b"],
  source_assignment_ids: ["assignment_a", "assignment_b"],
  source_release_ids: ["release_a", "release_b"],
  capabilities: [
    {
      capability_id: "capability.eduapply.read",
      capability_version_id: "capability_version.eduapply.read.1",
      version: "1.0.0",
    },
    {
      capability_id: "capability.housing.read",
      capability_version_id: "capability_version.housing.read.1",
      version: "1.0.0",
    },
  ],
  canonical_input_hash: `sha256:${"e".repeat(64)}`,
};

const snapshotRef = {
  snapshot_id: snapshot.snapshot_id,
  version: snapshot.version,
  evaluated_at: snapshot.evaluated_at,
};

const authoritativeCapabilityVersions = snapshot.capabilities.map((capability) => ({
  ...metadata,
  ...capability,
  kind: "mcp" as const,
  artifact_ref: `oci:registry.example.invalid/${capability.capability_id}@sha256:${"a".repeat(64)}`,
  contract_ref: "core.capabilities@1.0.0",
  risk_class: "read" as const,
  approval_requirement: "none" as const,
  compatibility: {
    core_contract_version: "0.7.0",
    domain_contract_version: "1.0.0",
    runtime_protocol_version: "1.0.0",
    tenant_modes: ["b2b" as const, "b2c" as const],
  },
  status: "reviewed" as const,
}));

const capabilityAuthority = {
  first_release: true,
  capability_versions: authoritativeCapabilityVersions,
};

test("entitlement snapshot accepts sorted exact source and capability identities", () => {
  assert.equal(Schema.Check(EntitlementSnapshotSchema, snapshot), true);
  assert.deepEqual(validateEntitlementSnapshot(snapshot, capabilityAuthority), []);
  assert.deepEqual(validateEntitlementSnapshotRef(snapshot, snapshotRef), []);
  assert.equal(Schema.Check(EntitlementSnapshotSchema, { ...snapshot, extra: true }), false);
  assert.equal(Schema.Check(EntitlementSnapshotSchema, {
    ...snapshot,
    canonical_input_hash: `sha256:${"E".repeat(64)}`,
  }), false);
});

test("snapshot validation rejects unsorted and duplicate source references", () => {
  const cases = [
    ["source_entitlement_ids", ["entitlement_b", "entitlement_a"], "SNAPSHOT_ENTITLEMENTS_NOT_SORTED"],
    ["source_assignment_ids", ["assignment_a", "assignment_a"], "SNAPSHOT_ASSIGNMENTS_DUPLICATE"],
    ["source_release_ids", ["release_b", "release_a"], "SNAPSHOT_RELEASES_NOT_SORTED"],
  ] as const;
  for (const [field, value, code] of cases) {
    assert.deepEqual(
      validateEntitlementSnapshot({ ...snapshot, [field]: value }, capabilityAuthority).map((item) => item.code),
      [code],
      field,
    );
  }
});

test("snapshot validation rejects unsorted, duplicate, and conflicting capability triples", () => {
  const [first, second] = snapshot.capabilities;
  assert.deepEqual(
    validateEntitlementSnapshot({ ...snapshot, capabilities: [second!, first!] }, capabilityAuthority).map((item) => item.code),
    ["SNAPSHOT_CAPABILITIES_NOT_SORTED"],
  );
  assert.deepEqual(
    validateEntitlementSnapshot({ ...snapshot, capabilities: [first!, { ...first! }] }, capabilityAuthority).map((item) => item.code),
    ["SNAPSHOT_CAPABILITY_DUPLICATE"],
  );
  assert.deepEqual(
    validateEntitlementSnapshot({
      ...snapshot,
      capabilities: [
        first!,
        { ...first!, capability_version_id: "capability_version.eduapply.read.2", version: "2.0.0" },
      ],
    }, capabilityAuthority).map((item) => item.code),
    ["SNAPSHOT_CAPABILITY_CONFLICT"],
  );
});

test("snapshot capability triples require exact reviewed allowed authority", () => {
  const [firstAuthority, secondAuthority] = authoritativeCapabilityVersions;
  const nonExecuting = {
    ...firstAuthority!,
    kind: "policy" as const,
    artifact_ref: `manifest:sha256:${"c".repeat(64)}`,
    risk_class: "draft_write" as const,
  };
  assert.deepEqual(validateEntitlementSnapshot(snapshot, {
    ...capabilityAuthority,
    capability_versions: [nonExecuting, secondAuthority!],
  }), []);
  assert.deepEqual(
    validateEntitlementSnapshot(snapshot, {
      ...capabilityAuthority,
      capability_versions: [firstAuthority!],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_AUTHORITY_MISSING"],
  );
  assert.deepEqual(
    validateEntitlementSnapshot(snapshot, {
      ...capabilityAuthority,
      capability_versions: [{ ...firstAuthority!, capability_id: "capability.wrong" }, secondAuthority!],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_AUTHORITY_MISMATCH"],
  );
  assert.deepEqual(
    validateEntitlementSnapshot(snapshot, {
      ...capabilityAuthority,
      capability_versions: [{ ...firstAuthority!, status: "draft" }, secondAuthority!],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_NOT_REVIEWED"],
  );
  assert.deepEqual(
    validateEntitlementSnapshot(snapshot, {
      ...capabilityAuthority,
      capability_versions: [{ ...firstAuthority!, status: "retired" }, secondAuthority!],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_NOT_REVIEWED"],
  );
  assert.deepEqual(
    validateEntitlementSnapshot(snapshot, {
      ...capabilityAuthority,
      capability_versions: [{ ...firstAuthority!, status: "blocked" }, secondAuthority!],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_BLOCKED"],
  );
  for (const risk_class of ["external_write", "privileged"] as const) {
    assert.deepEqual(
      validateEntitlementSnapshot(snapshot, {
        ...capabilityAuthority,
        capability_versions: [{ ...firstAuthority!, risk_class }, secondAuthority!],
      }).map((item) => item.code),
      ["CAPABILITY_VERSION_RISK_FORBIDDEN"],
    );
  }
  assert.deepEqual(
    validateEntitlementSnapshot(snapshot, {
      ...capabilityAuthority,
      capability_versions: [{ ...firstAuthority!, risk_class: "draft_write" }, secondAuthority!],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_RISK_FORBIDDEN"],
  );
});

test("Snapshot authority diagnostics identify capability and authoritative record fields", () => {
  const [firstAuthority, secondAuthority] = authoritativeCapabilityVersions;
  assert.equal(validateEntitlementSnapshot(snapshot, {
    ...capabilityAuthority,
    capability_versions: [firstAuthority!],
  })[0]?.path, "capabilities[1].capability_version_id");
  assert.equal(validateEntitlementSnapshot(snapshot, {
    ...capabilityAuthority,
    capability_versions: [{ ...firstAuthority!, capability_id: "capability.wrong" }, secondAuthority!],
  })[0]?.path, "capabilities[0].capability_id");
  assert.equal(validateEntitlementSnapshot(snapshot, {
    ...capabilityAuthority,
    capability_versions: [{ ...firstAuthority!, status: "retired" }, secondAuthority!],
  })[0]?.path, "authority.capability_versions[0].status");
  assert.equal(validateEntitlementSnapshot(snapshot, {
    ...capabilityAuthority,
    capability_versions: [{ ...firstAuthority!, risk_class: "external_write" }, secondAuthority!],
  })[0]?.path, "authority.capability_versions[0].risk_class");
});

test("snapshot reference must exactly identify the effective immutable snapshot", () => {
  for (const ref of [
    { ...snapshotRef, snapshot_id: "snapshot_other" },
    { ...snapshotRef, version: 8 },
    { ...snapshotRef, evaluated_at: "2026-08-20T01:00:01Z" },
  ]) {
    assert.deepEqual(
      validateEntitlementSnapshotRef(snapshot, ref).map((item) => item.code),
      ["ENTITLEMENT_SNAPSHOT_REF_MISMATCH"],
    );
  }
});

test("profile snapshot pointer carries only the exact current snapshot reference", () => {
  const pointer = {
    ...metadata,
    tenant_id: "tenant_demo",
    profile_id: "profile_demo",
    entitlement_snapshot_ref: snapshotRef,
  };
  assert.equal(Schema.Check(ProfileSnapshotPointerSchema, pointer), true);
  assert.equal(Schema.Check(ProfileSnapshotPointerSchema, { ...pointer, capability_ids: ["forged"] }), false);
});

test("service projection binds preparation state, generation, and snapshot ref", () => {
  const base = {
    ...metadata,
    projection_id: "projection_demo",
    tenant_id: "tenant_demo",
    profile_id: "profile_demo",
    entitlement_snapshot_ref: snapshotRef,
    generation: 7,
  };
  assert.equal(Schema.Check(CapabilityServiceProjectionSchema, { ...base, status: "preparing" }), true);
  assert.equal(Schema.Check(CapabilityServiceProjectionSchema, { ...base, status: "available" }), true);
  assert.equal(Schema.Check(CapabilityServiceProjectionSchema, {
    ...base,
    status: "failed",
    reason_code: "runtime_preparation_failed",
  }), true);
  assert.equal(Schema.Check(CapabilityServiceProjectionSchema, { ...base, status: "failed" }), false);
  assert.equal(Schema.Check(CapabilityServiceProjectionSchema, {
    ...base,
    status: "preparing",
    reason_code: "runtime_preparation_failed",
  }), false);
});
