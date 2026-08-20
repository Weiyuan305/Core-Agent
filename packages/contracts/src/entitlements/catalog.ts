import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  ResourceMetadataFields,
} from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";
import { TenantModeSchema } from "../tenant/identity.js";

const semverPrereleaseIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const canonicalSemverBody = `(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${semverPrereleaseIdentifier}(?:\\.${semverPrereleaseIdentifier})*)?`;
const canonicalSemverPattern = `^${canonicalSemverBody}$`;
const contractRefPattern = `^[a-z0-9][a-z0-9._/-]{0,127}@${canonicalSemverBody}$`;
const npmPackageNamePattern = "(?:[a-z0-9][a-z0-9._~-]*|@[a-z0-9][a-z0-9._~-]*/[a-z0-9][a-z0-9._~-]*)";
const canonicalSha512Base64Pattern = "[A-Za-z0-9+/]{85}[AQgw]==";

export const CanonicalSemanticVersionSchema = Type.String({
  minLength: 5,
  maxLength: 128,
  pattern: canonicalSemverPattern,
});

export const ImmutableArtifactRefSchema = Type.Union([
  Type.String({
    pattern: "^oci:(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?/)?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)*@sha256:[a-f0-9]{64}$",
  }),
  Type.String({
    pattern: `^npm:${npmPackageNamePattern}@${canonicalSemverBody}#sha512-${canonicalSha512Base64Pattern}$`,
  }),
  Type.String({ pattern: "^manifest:sha256:[a-f0-9]{64}$" }),
]);

export const ExactContractRefSchema = Type.String({
  minLength: 7,
  maxLength: 256,
  pattern: contractRefPattern,
});

export const CapabilityKindSchema = Type.Union([
  Type.Literal("mcp"),
  Type.Literal("skill"),
  Type.Literal("policy"),
]);

export const CapabilityRiskClassSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("draft_write"),
  Type.Literal("external_write"),
  Type.Literal("privileged"),
]);

export const ApprovalRequirementSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("user_confirmation"),
  Type.Literal("human_approval"),
]);

export const CapabilityVersionStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("reviewed"),
  Type.Literal("retired"),
  Type.Literal("blocked"),
]);

export const PackVersionStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("reviewed"),
  Type.Literal("published"),
  Type.Literal("retired"),
  Type.Literal("blocked"),
]);

export const TenantPackReleaseStatusSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("current"),
  Type.Literal("failed"),
  Type.Literal("superseded"),
]);

export const CapabilitySchema = Type.Object(
  {
    ...ResourceMetadataFields,
    capability_id: OpaqueIdSchema,
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    owning_domain: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    kind: CapabilityKindSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/capability" },
);

export const CapabilityCompatibilitySchema = Type.Object(
  {
    core_contract_version: CanonicalSemanticVersionSchema,
    domain_contract_version: CanonicalSemanticVersionSchema,
    runtime_protocol_version: CanonicalSemanticVersionSchema,
    tenant_modes: Type.Array(TenantModeSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const CapabilityVersionSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    capability_version_id: OpaqueIdSchema,
    capability_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
    kind: CapabilityKindSchema,
    artifact_ref: ImmutableArtifactRefSchema,
    contract_ref: ExactContractRefSchema,
    risk_class: CapabilityRiskClassSchema,
    approval_requirement: ApprovalRequirementSchema,
    compatibility: CapabilityCompatibilitySchema,
    status: CapabilityVersionStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/capability-version" },
);

export const PackProductSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    pack_product_id: OpaqueIdSchema,
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    tenant_modes: Type.Array(TenantModeSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
  },
  { additionalProperties: false, $id: "core-agent://v1/pack-product" },
);

export const PackMemberRefSchema = Type.Object(
  {
    capability_id: OpaqueIdSchema,
    capability_version_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
  },
  { additionalProperties: false },
);

export const PackMemberSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    pack_member_id: OpaqueIdSchema,
    pack_version_id: OpaqueIdSchema,
    capability_id: OpaqueIdSchema,
    capability_version_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/pack-member" },
);

export const PackVersionSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    pack_version_id: OpaqueIdSchema,
    pack_product_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
    status: PackVersionStatusSchema,
    members: Type.Array(PackMemberRefSchema, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false, $id: "core-agent://v1/pack-version" },
);

export const TenantPackReleaseSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    tenant_pack_release_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    pack_product_id: OpaqueIdSchema,
    pack_version_id: OpaqueIdSchema,
    pack_version: CanonicalSemanticVersionSchema,
    generation: Type.Integer({ minimum: 1 }),
    status: TenantPackReleaseStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/tenant-pack-release" },
);

export type Capability = Static<typeof CapabilitySchema>;
export type CapabilityVersion = Static<typeof CapabilityVersionSchema>;
export type PackProduct = Static<typeof PackProductSchema>;
export type PackMember = Static<typeof PackMemberSchema>;
export type PackMemberRef = Static<typeof PackMemberRefSchema>;
export type PackVersion = Static<typeof PackVersionSchema>;
export type TenantPackRelease = Static<typeof TenantPackReleaseSchema>;

export interface CapabilityVersionAuthority {
  first_release: boolean;
  capability_versions: readonly CapabilityVersion[];
}

function isPlainData(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false;
  } else if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor)) return false;
    if (!isPlainData(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
}

export function validateCatalogContractInput(value: unknown): ContractViolation[] {
  return isPlainData(value, new Set())
    ? []
    : [violation(
        "CATALOG_INPUT_NOT_PLAIN_DATA",
        "$",
        "Catalog input must contain plain data without accessors or cycles",
      )];
}

function compareMember(left: PackMemberRef, right: PackMemberRef): number {
  const leftKey = `${left.capability_id}\0${left.capability_version_id}\0${left.version}`;
  const rightKey = `${right.capability_id}\0${right.capability_version_id}\0${right.version}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function validateCapabilityVersionAuthority(
  references: readonly PackMemberRef[],
  authority: CapabilityVersionAuthority,
  referenceCollection: "members" | "capabilities",
): ContractViolation[] {
  if (
    authority === undefined
    || authority === null
    || !Array.isArray(authority.capability_versions)
    || typeof authority.first_release !== "boolean"
  ) {
    return [violation(
      "CAPABILITY_VERSION_AUTHORITY_REQUIRED",
      "authority",
      "Exact authoritative Capability Version records are required",
    )];
  }

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]!;
    const recordIndexes = authority.capability_versions
      .map((candidate, candidateIndex) => (
        candidate.capability_version_id === reference.capability_version_id
          ? candidateIndex
          : -1
      ))
      .filter((candidateIndex) => candidateIndex >= 0);
    const referencePath = `${referenceCollection}[${index}]`;
    if (recordIndexes.length === 0) {
      return [violation(
        "CAPABILITY_VERSION_AUTHORITY_MISSING",
        `${referencePath}.capability_version_id`,
        "Referenced Capability Version is absent from authoritative records",
      )];
    }
    if (recordIndexes.length > 1) {
      return [violation(
        "CAPABILITY_VERSION_AUTHORITY_AMBIGUOUS",
        "authority.capability_versions",
        "Authoritative records must contain one Capability Version per identifier",
      )];
    }

    const recordIndex = recordIndexes[0]!;
    const record = authority.capability_versions[recordIndex]!;
    const authorityPath = `authority.capability_versions[${recordIndex}]`;
    if (record.capability_id !== reference.capability_id) {
      return [violation(
        "CAPABILITY_VERSION_AUTHORITY_MISMATCH",
        `${referencePath}.capability_id`,
        "Capability reference must exactly match its authoritative Version record",
      )];
    }
    if (record.version !== reference.version) {
      return [violation(
        "CAPABILITY_VERSION_AUTHORITY_MISMATCH",
        `${referencePath}.version`,
        "Capability reference must exactly match its authoritative Version record",
      )];
    }
    if (record.status === "blocked") {
      return [violation(
        "CAPABILITY_VERSION_BLOCKED",
        `${authorityPath}.status`,
        "Blocked Capability Versions cannot become effective",
      )];
    }
    if (record.status !== "reviewed") {
      return [violation(
        "CAPABILITY_VERSION_NOT_REVIEWED",
        `${authorityPath}.status`,
        "Only reviewed Capability Versions can become effective",
      )];
    }
    if (
      authority.first_release
      && (
        record.risk_class === "external_write"
        || record.risk_class === "privileged"
        || (record.risk_class === "draft_write" && !record.artifact_ref.startsWith("manifest:sha256:"))
      )
    ) {
      return [violation(
        "CAPABILITY_VERSION_RISK_FORBIDDEN",
        `${authorityPath}.risk_class`,
        "First release permits only reviewed reads or non-executing placeholder manifests",
      )];
    }
  }

  return [];
}

export function validatePackVersion(
  pack: Pick<PackVersion, "members">,
  authority: CapabilityVersionAuthority,
): ContractViolation[] {
  const exactMembers = new Set<string>();
  const capabilityIds = new Set<string>();
  for (const member of pack.members) {
    const exactKey = `${member.capability_id}\0${member.capability_version_id}\0${member.version}`;
    if (exactMembers.has(exactKey)) {
      return [violation("PACK_MEMBER_DUPLICATE", "members", "Pack members must be unique")];
    }
    exactMembers.add(exactKey);
    if (capabilityIds.has(member.capability_id)) {
      return [violation(
        "PACK_CAPABILITY_DUPLICATE",
        "members.capability_id",
        "A Pack version may reference one exact version of each Capability",
      )];
    }
    capabilityIds.add(member.capability_id);
  }
  for (let index = 1; index < pack.members.length; index += 1) {
    if (compareMember(pack.members[index - 1]!, pack.members[index]!) >= 0) {
      return [violation("PACK_MEMBERS_NOT_SORTED", "members", "Pack members must use canonical order")];
    }
  }
  return validateCapabilityVersionAuthority(pack.members, authority, "members");
}
