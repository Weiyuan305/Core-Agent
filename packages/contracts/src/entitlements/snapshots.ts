import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  ResourceMetadataFields,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";
import {
  EntitlementSnapshotRefSchema,
  type EntitlementSnapshotRef,
} from "../runtime/refs.js";
import {
  CanonicalSemanticVersionSchema,
  type CapabilityVersionAuthority,
  validateCapabilityVersionAuthority,
} from "./catalog.js";

export const CanonicalSha256Schema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

export const SnapshotCapabilitySchema = Type.Object(
  {
    capability_id: OpaqueIdSchema,
    capability_version_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
  },
  { additionalProperties: false },
);

export const EntitlementSnapshotSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    snapshot_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    version: Type.Integer({ minimum: 1 }),
    evaluated_at: UtcTimestampSchema,
    source_entitlement_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    source_assignment_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    source_release_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    capabilities: Type.Array(SnapshotCapabilitySchema, { uniqueItems: true }),
    canonical_input_hash: CanonicalSha256Schema,
  },
  { additionalProperties: false, $id: "core-agent://v1/entitlement-snapshot" },
);

export const ProfileSnapshotPointerSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    tenant_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    entitlement_snapshot_ref: EntitlementSnapshotRefSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/profile-snapshot-pointer" },
);

export const ServiceFailureReasonCodeSchema = Type.Union([
  Type.Literal("runtime_preparation_failed"),
  Type.Literal("runtime_health_check_failed"),
  Type.Literal("capability_manifest_mismatch"),
]);

const ProjectionBaseFields = {
  ...ResourceMetadataFields,
  projection_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  entitlement_snapshot_ref: Type.Object(
    EntitlementSnapshotRefSchema.properties,
    { additionalProperties: false },
  ),
  generation: Type.Integer({ minimum: 1 }),
} as const;

export const CapabilityServiceProjectionSchema = Type.Union([
  Type.Object({ ...ProjectionBaseFields, status: Type.Literal("preparing") }, { additionalProperties: false }),
  Type.Object({ ...ProjectionBaseFields, status: Type.Literal("available") }, { additionalProperties: false }),
  Type.Object({
    ...ProjectionBaseFields,
    status: Type.Literal("failed"),
    reason_code: ServiceFailureReasonCodeSchema,
  }, { additionalProperties: false }),
], { $id: "core-agent://v1/capability-service-projection" });

export type SnapshotCapability = Static<typeof SnapshotCapabilitySchema>;
export type EntitlementSnapshot = Static<typeof EntitlementSnapshotSchema>;
export type ProfileSnapshotPointer = Static<typeof ProfileSnapshotPointerSchema>;
export type CapabilityServiceProjection = Static<typeof CapabilityServiceProjectionSchema>;

function validateSortedIds(
  values: readonly string[],
  label: string,
  duplicateCode: string,
  sortedCode: string,
): ContractViolation[] {
  if (new Set(values).size !== values.length) {
    return [violation(duplicateCode, label, `${label} must not contain duplicates`)];
  }
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      return [violation(sortedCode, label, `${label} must use canonical order`)];
    }
  }
  return [];
}

function capabilityKey(capability: SnapshotCapability): string {
  return `${capability.capability_id}\0${capability.capability_version_id}\0${capability.version}`;
}

export function validateEntitlementSnapshot(
  snapshot: Pick<
    EntitlementSnapshot,
    "source_entitlement_ids" | "source_assignment_ids" | "source_release_ids" | "capabilities"
  >,
  authority: CapabilityVersionAuthority,
): ContractViolation[] {
  const sourceChecks = [
    validateSortedIds(snapshot.source_entitlement_ids, "source_entitlement_ids", "SNAPSHOT_ENTITLEMENTS_DUPLICATE", "SNAPSHOT_ENTITLEMENTS_NOT_SORTED"),
    validateSortedIds(snapshot.source_assignment_ids, "source_assignment_ids", "SNAPSHOT_ASSIGNMENTS_DUPLICATE", "SNAPSHOT_ASSIGNMENTS_NOT_SORTED"),
    validateSortedIds(snapshot.source_release_ids, "source_release_ids", "SNAPSHOT_RELEASES_DUPLICATE", "SNAPSHOT_RELEASES_NOT_SORTED"),
  ];
  for (const violations of sourceChecks) {
    if (violations.length > 0) return violations;
  }

  const exact = new Set<string>();
  const capabilityIds = new Set<string>();
  for (const capability of snapshot.capabilities) {
    const key = capabilityKey(capability);
    if (exact.has(key)) {
      return [violation(
        "SNAPSHOT_CAPABILITY_DUPLICATE",
        "capabilities",
        "Snapshot capability triples must be unique",
      )];
    }
    exact.add(key);
    if (capabilityIds.has(capability.capability_id)) {
      return [violation(
        "SNAPSHOT_CAPABILITY_CONFLICT",
        "capabilities.capability_id",
        "A snapshot cannot contain multiple versions of one Capability",
      )];
    }
    capabilityIds.add(capability.capability_id);
  }
  for (let index = 1; index < snapshot.capabilities.length; index += 1) {
    if (capabilityKey(snapshot.capabilities[index - 1]!) >= capabilityKey(snapshot.capabilities[index]!)) {
      return [violation(
        "SNAPSHOT_CAPABILITIES_NOT_SORTED",
        "capabilities",
        "Snapshot capabilities must use canonical order",
      )];
    }
  }
  return validateCapabilityVersionAuthority(snapshot.capabilities, authority, "capabilities");
}

export function validateEntitlementSnapshotRef(
  snapshot: Pick<EntitlementSnapshot, "snapshot_id" | "version" | "evaluated_at">,
  reference: EntitlementSnapshotRef,
): ContractViolation[] {
  return snapshot.snapshot_id === reference.snapshot_id
    && snapshot.version === reference.version
    && snapshot.evaluated_at === reference.evaluated_at
    ? []
    : [violation(
        "ENTITLEMENT_SNAPSHOT_REF_MISMATCH",
        "entitlement_snapshot_ref",
        "Entitlement snapshot reference must identify the exact immutable snapshot",
      )];
}
