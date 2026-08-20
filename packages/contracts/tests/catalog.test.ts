import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  ApprovalRequirementSchema,
  CapabilityKindSchema,
  CapabilityRiskClassSchema,
  CapabilitySchema,
  CapabilityVersionSchema,
  CapabilityVersionStatusSchema,
  ImmutableArtifactRefSchema,
  PackMemberSchema,
  PackProductSchema,
  PackVersionSchema,
  PackVersionStatusSchema,
  TenantPackReleaseSchema,
  validateCatalogContractInput,
  validatePackVersion,
} from "../src/index.js";

const metadata = {
  schema_version: 1 as const,
  resource_version: 1,
  created_at: "2026-08-20T01:00:00Z",
  updated_at: "2026-08-20T01:00:00Z",
};

const member = {
  capability_id: "capability.eduapply.read",
  capability_version_id: "capability_version.eduapply.read.1",
  version: "1.2.3",
};

const capability = {
  ...metadata,
  capability_id: member.capability_id,
  display_name: "EduApply read access",
  owning_domain: "eduapply",
  kind: "mcp",
};

const capabilityVersion = {
  ...metadata,
  capability_version_id: member.capability_version_id,
  capability_id: member.capability_id,
  version: member.version,
  kind: "mcp",
  artifact_ref: `oci:registry.example.invalid/eduapply/read@sha256:${"a".repeat(64)}`,
  contract_ref: "eduapply.contracts@2.1.0",
  risk_class: "read",
  approval_requirement: "none",
  compatibility: {
    core_contract_version: "0.7.0",
    domain_contract_version: "2.1.0",
    runtime_protocol_version: "1.0.0",
    tenant_modes: ["b2b", "b2c"],
  },
  status: "reviewed",
};

const capabilityAuthority = {
  first_release: true,
  capability_versions: [capabilityVersion],
};

const exactSha512Digest = Buffer.alloc(64, 0x61).toString("base64");

const packVersion = {
  ...metadata,
  pack_version_id: "pack_version.eduapply.1",
  pack_product_id: "pack.eduapply",
  version: "1.0.0",
  status: "published",
  members: [member],
};

test("catalog vocabularies are closed", () => {
  const cases = [
    [CapabilityKindSchema, ["mcp", "skill", "policy"], "tool"],
    [CapabilityRiskClassSchema, ["read", "draft_write", "external_write", "privileged"], "write"],
    [ApprovalRequirementSchema, ["none", "user_confirmation", "human_approval"], "manager"],
    [CapabilityVersionStatusSchema, ["draft", "reviewed", "retired", "blocked"], "published"],
    [PackVersionStatusSchema, ["draft", "reviewed", "published", "retired", "blocked"], "active"],
  ] as const;

  for (const [schema, allowed, rejected] of cases) {
    const validator = Schema.Compile(schema);
    for (const value of allowed) assert.equal(validator.Check(value), true, value);
    assert.equal(validator.Check(rejected), false, rejected);
  }
});

test("capability catalog resources accept exact reviewed immutable metadata", () => {
  assert.equal(Schema.Check(CapabilitySchema, capability), true);
  assert.equal(Schema.Check(CapabilityVersionSchema, capabilityVersion), true);
  assert.equal(Schema.Check(CapabilitySchema, { ...capability, kind: "tool" }), false);
  assert.equal(Schema.Check(CapabilityVersionSchema, { ...capabilityVersion, extra: true }), false);

  for (const artifact_ref of [
    `oci:registry.example.invalid/eduapply/read@sha256:${"b".repeat(64)}`,
    `npm:@eduapply/contracts@2.1.0#sha512-${exactSha512Digest}`,
    `manifest:sha256:${"c".repeat(64)}`,
  ]) {
    assert.equal(Schema.Check(CapabilityVersionSchema, { ...capabilityVersion, artifact_ref }), true, artifact_ref);
  }
  for (const version of ["1.2.3-0", "1.2.3-alpha.1"] as const) {
    assert.equal(Schema.Check(CapabilityVersionSchema, { ...capabilityVersion, version }), true, version);
  }
});

test("immutable npm artifacts require canonical names, versions, and exact SHA-512 SRI bytes", () => {
  for (const artifactRef of [
    `npm:core-agent-capability@1.2.3-alpha.1#sha512-${exactSha512Digest}`,
    `npm:@eduapply/contracts@2.1.0#sha512-${exactSha512Digest}`,
  ]) {
    assert.equal(Schema.Check(ImmutableArtifactRefSchema, artifactRef), true, artifactRef);
  }

  const nonCanonicalPaddingBits = `${exactSha512Digest.slice(0, -3)}B==`;
  for (const artifactRef of [
    `npm:../../mutable-local@1.0.0#sha512-${exactSha512Digest}`,
    `npm:/tmp/mutable-local@1.0.0#sha512-${exactSha512Digest}`,
    `npm://server/mutable-local@1.0.0#sha512-${exactSha512Digest}`,
    `npm:@eduapply//contracts@1.0.0#sha512-${exactSha512Digest}`,
    `npm:EduApply@1.0.0#sha512-${exactSha512Digest}`,
    `npm:@EduApply/contracts@1.0.0#sha512-${exactSha512Digest}`,
    `npm:eduapply@1.0.0-01#sha512-${exactSha512Digest}`,
    "npm:eduapply@1.0.0#sha512-YWJjZA==",
    `npm:eduapply@1.0.0#sha512-${nonCanonicalPaddingBits}`,
    `npm:eduapply@1.0.0#sha512-${exactSha512Digest.slice(0, -2)}=`,
    `npm:eduapply@1.0.0#sha512-${exactSha512Digest.slice(0, -2)}===`,
    `npm:eduapply@1.0.0#sha512-${exactSha512Digest.slice(0, -4)}*A==`,
  ]) {
    assert.equal(Schema.Check(ImmutableArtifactRefSchema, artifactRef), false, artifactRef);
  }
});

test("immutable npm artifact package identities enforce the independent 214-character limit", () => {
  const unscoped214 = "a".repeat(214);
  const unscoped215 = "a".repeat(215);
  const scoped214 = `@${"s".repeat(100)}/${"p".repeat(112)}`;
  const scoped215 = `@${"s".repeat(100)}/${"p".repeat(113)}`;
  const longPrerelease = `1.2.3-${"a".repeat(100)}`;
  assert.equal(unscoped214.length, 214);
  assert.equal(scoped214.length, 214);

  for (const artifactRef of [
    `npm:${unscoped214}@0.0.0#sha512-${exactSha512Digest}`,
    `npm:${scoped214}@0.0.0#sha512-${exactSha512Digest}`,
    `npm:${unscoped214}@${longPrerelease}#sha512-${exactSha512Digest}`,
  ]) {
    assert.equal(Schema.Check(ImmutableArtifactRefSchema, artifactRef), true, artifactRef);
  }
  for (const artifactRef of [
    `npm:${unscoped215}@0.0.0#sha512-${exactSha512Digest}`,
    `npm:${scoped215}@0.0.0#sha512-${exactSha512Digest}`,
    `npm:${unscoped215}@${longPrerelease}#sha512-${exactSha512Digest}`,
  ]) {
    assert.equal(Schema.Check(ImmutableArtifactRefSchema, artifactRef), false, artifactRef);
  }
});

test("immutable OCI artifacts use canonical lowercase distribution coordinates", () => {
  const digest = `sha256:${"d".repeat(64)}`;
  for (const artifactRef of [
    `oci:registry.example.invalid/eduapply/read@${digest}`,
    `oci:registry.example.invalid:5000/eduapply/read-only@${digest}`,
    `oci:eduapply/repo.name@${digest}`,
    `oci:eduapply/repo_name@${digest}`,
  ]) {
    assert.equal(Schema.Check(ImmutableArtifactRefSchema, artifactRef), true, artifactRef);
  }
  for (const artifactRef of [
    `oci:Registry.example.invalid/eduapply/read@${digest}`,
    `oci:registry.example.invalid/EduApply/read@${digest}`,
    `oci:registry.example.invalid/-eduapply/read@${digest}`,
    `oci:registry.example.invalid/eduapply/read.@${digest}`,
    `oci:registry.example.invalid/eduapply/repo..name@${digest}`,
    `oci:registry.example.invalid/eduapply/repo._name@${digest}`,
    `oci:registry.example.invalid/eduapply//read@${digest}`,
    `oci:registry.example.invalid/eduapply/./read@${digest}`,
    `oci:registry.example.invalid/eduapply/../read@${digest}`,
    `oci:https://registry.example.invalid/eduapply/read@${digest}`,
    `oci:registry.example.invalid/eduapply/read:latest@${digest}`,
    `oci:registry.example.invalid:0/eduapply/read@${digest}`,
    `oci:registry.example.invalid:0001/eduapply/read@${digest}`,
    `oci:registry.example.invalid:65536/eduapply/read@${digest}`,
    `oci:registry.example.invalid:abc/eduapply/read@${digest}`,
  ]) {
    assert.equal(Schema.Check(ImmutableArtifactRefSchema, artifactRef), false, artifactRef);
  }
});

test("immutable OCI artifact coordinates enforce the independent 255-character limit", () => {
  const coordinate255 = "a".repeat(255);
  const coordinate256 = "a".repeat(256);
  const digest = `sha256:${"e".repeat(64)}`;
  assert.equal(coordinate255.length, 255);
  assert.equal(
    Schema.Check(ImmutableArtifactRefSchema, `oci:${coordinate255}@${digest}`),
    true,
  );
  assert.equal(
    Schema.Check(ImmutableArtifactRefSchema, `oci:${coordinate256}@${digest}`),
    false,
  );
});

test("capability versions reject mutable artifacts, arbitrary URLs, ranges, and non-canonical versions", () => {
  for (const artifact_ref of [
    "oci:registry.example.invalid/eduapply/read:latest",
    `oci:registry.example.invalid/eduapply/read:latest@sha256:${"b".repeat(64)}`,
    `oci:registry.example.invalid/eduapply/read:stable@sha256:${"b".repeat(64)}`,
    "npm:@eduapply/contracts@^2.1.0#sha512-YWJjZA==",
    "https://downloads.example.invalid/capability.tar.gz",
    `manifest:sha256:${"A".repeat(64)}`,
  ]) {
    assert.equal(Schema.Check(CapabilityVersionSchema, { ...capabilityVersion, artifact_ref }), false, artifact_ref);
  }
  for (const version of ["1.2", "v1.2.3", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha.01", "1.2.3+build", "^1.2.3", "latest"] as const) {
    assert.equal(Schema.Check(CapabilityVersionSchema, { ...capabilityVersion, version }), false, version);
  }
  for (const contract_ref of ["eduapply.contracts@2.1.0-01", "eduapply.contracts@^2.1.0", "https://example.invalid/contracts/2.1.0", "latest"] as const) {
    assert.equal(Schema.Check(CapabilityVersionSchema, { ...capabilityVersion, contract_ref }), false, contract_ref);
  }
});

test("pack catalog resources contain a sorted non-empty exact member set", () => {
  const product = {
    ...metadata,
    pack_product_id: "pack.eduapply",
    display_name: "EduApply",
    tenant_modes: ["b2b", "b2c"],
  };
  const storedMember = {
    ...metadata,
    pack_member_id: "pack_member.eduapply.read.1",
    pack_version_id: packVersion.pack_version_id,
    ...member,
  };
  const release = {
    ...metadata,
    tenant_pack_release_id: "tenant_release.demo.eduapply.1",
    tenant_id: "tenant_demo",
    pack_product_id: product.pack_product_id,
    pack_version_id: packVersion.pack_version_id,
    pack_version: packVersion.version,
    generation: 1,
    status: "current",
  };

  assert.equal(Schema.Check(PackProductSchema, product), true);
  assert.equal(Schema.Check(PackMemberSchema, storedMember), true);
  assert.equal(Schema.Check(PackVersionSchema, packVersion), true);
  assert.deepEqual(validatePackVersion(packVersion, capabilityAuthority), []);
  assert.equal(Schema.Check(TenantPackReleaseSchema, release), true);
  assert.equal(Schema.Check(PackVersionSchema, { ...packVersion, members: [] }), false);
  assert.equal(Schema.Check(PackVersionSchema, {
    ...packVersion,
    members: [{ ...member, pack_version_id: "nested_pack" }],
  }), false);
});

test("pack version validation rejects duplicate and unsorted capability members", () => {
  const second = {
    capability_id: "capability.housing.read",
    capability_version_id: "capability_version.housing.read.1",
    version: "1.0.0",
  };
  assert.deepEqual(
    validatePackVersion({ ...packVersion, members: [second, member] }, capabilityAuthority).map((item) => item.code),
    ["PACK_MEMBERS_NOT_SORTED"],
  );
  assert.deepEqual(
    validatePackVersion({ ...packVersion, members: [member, { ...member }] }, capabilityAuthority).map((item) => item.code),
    ["PACK_MEMBER_DUPLICATE"],
  );
  assert.deepEqual(
    validatePackVersion({
      ...packVersion,
      members: [member, { ...member, capability_version_id: "capability_version.eduapply.read.2", version: "2.0.0" }],
    }, capabilityAuthority).map((item) => item.code),
    ["PACK_CAPABILITY_DUPLICATE"],
  );
});

test("Pack tuple identity and ordering remain injective when opaque ids contain NUL", () => {
  const collisionMembers = [
    {
      capability_id: "capability.a",
      capability_version_id: "capability.b\0version",
      version: "1.0.0",
    },
    {
      capability_id: "capability.a\0capability.b",
      capability_version_id: "version",
      version: "1.0.0",
    },
  ];
  const collisionAuthority = {
    first_release: true,
    capability_versions: collisionMembers.map((reference) => ({
      ...capabilityVersion,
      ...reference,
    })),
  };
  assert.deepEqual(
    validatePackVersion({ ...packVersion, members: collisionMembers }, collisionAuthority),
    [],
  );
  assert.deepEqual(
    validatePackVersion(
      { ...packVersion, members: [...collisionMembers].reverse() },
      collisionAuthority,
    ).map((item) => item.code),
    ["PACK_MEMBERS_NOT_SORTED"],
  );
});

test("published Pack members require exact reviewed Capability Version authority", () => {
  assert.deepEqual(
    validatePackVersion(packVersion, { ...capabilityAuthority, capability_versions: [] }).map((item) => item.code),
    ["CAPABILITY_VERSION_AUTHORITY_MISSING"],
  );
  assert.deepEqual(
    validatePackVersion(packVersion, {
      ...capabilityAuthority,
      capability_versions: [{ ...capabilityVersion, version: "1.2.4" }],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_AUTHORITY_MISMATCH"],
  );
  for (const status of ["draft", "retired"] as const) {
    assert.deepEqual(
      validatePackVersion(packVersion, {
        ...capabilityAuthority,
        capability_versions: [{ ...capabilityVersion, status }],
      }).map((item) => item.code),
      ["CAPABILITY_VERSION_NOT_REVIEWED"],
      status,
    );
  }
  assert.deepEqual(
    validatePackVersion(packVersion, {
      ...capabilityAuthority,
      capability_versions: [{ ...capabilityVersion, status: "blocked" }],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_BLOCKED"],
  );
});

test("Pack authority diagnostics identify member and authoritative record fields", () => {
  assert.deepEqual(
    validatePackVersion(packVersion, { ...capabilityAuthority, capability_versions: [] })[0],
    {
      code: "CAPABILITY_VERSION_AUTHORITY_MISSING",
      path: "members[0].capability_version_id",
      message: "Referenced Capability Version is absent from authoritative records",
    },
  );
  assert.equal(validatePackVersion(packVersion, {
    ...capabilityAuthority,
    capability_versions: [{ ...capabilityVersion, version: "1.2.4" }],
  })[0]?.path, "members[0].version");
  assert.equal(validatePackVersion(packVersion, {
    ...capabilityAuthority,
    capability_versions: [{ ...capabilityVersion, status: "blocked" }],
  })[0]?.path, "authority.capability_versions[0].status");
  assert.equal(validatePackVersion(packVersion, {
    ...capabilityAuthority,
    capability_versions: [{ ...capabilityVersion, risk_class: "privileged" }],
  })[0]?.path, "authority.capability_versions[0].risk_class");
});

test("first-release Pack authority allows reviewed reads and placeholder manifests only", () => {
  const nonExecuting = {
    ...capabilityVersion,
    kind: "policy" as const,
    artifact_ref: `manifest:sha256:${"c".repeat(64)}`,
    risk_class: "draft_write" as const,
  };
  assert.deepEqual(validatePackVersion(packVersion, capabilityAuthority), []);
  assert.deepEqual(validatePackVersion(packVersion, {
    ...capabilityAuthority,
    capability_versions: [nonExecuting],
  }), []);

  for (const risk_class of ["external_write", "privileged"] as const) {
    assert.deepEqual(
      validatePackVersion(packVersion, {
        ...capabilityAuthority,
        capability_versions: [{ ...capabilityVersion, risk_class }],
      }).map((item) => item.code),
      ["CAPABILITY_VERSION_RISK_FORBIDDEN"],
      risk_class,
    );
  }
  assert.deepEqual(
    validatePackVersion(packVersion, {
      ...capabilityAuthority,
      capability_versions: [{ ...capabilityVersion, risk_class: "draft_write" }],
    }).map((item) => item.code),
    ["CAPABILITY_VERSION_RISK_FORBIDDEN"],
  );
});

test("catalog hostile accessor input fails without invoking the accessor", () => {
  let getterCalls = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "capability_id", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "capability.hostile";
    },
  });

  assert.deepEqual(
    validateCatalogContractInput(hostile).map((item) => item.code),
    ["CATALOG_INPUT_NOT_PLAIN_DATA"],
  );
  assert.equal(getterCalls, 0);
});
