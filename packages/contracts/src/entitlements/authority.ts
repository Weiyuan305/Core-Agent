import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  parseStrictUtcTimestamp,
  ResourceMetadataFields,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";
import { CanonicalSemanticVersionSchema } from "./catalog.js";

export const EntitlementStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("suspended"),
  Type.Literal("expired"),
  Type.Literal("revoked"),
]);

export const AssignmentStatusSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("available"),
  Type.Literal("suspended"),
  Type.Literal("expired"),
  Type.Literal("failed"),
  Type.Literal("revoked"),
]);

export const EntitlementSourceSchema = Type.Literal("platform_manual");

export const EntitlementReasonCodeSchema = Type.Union([
  Type.Literal("platform_grant"),
  Type.Literal("administrator_suspended"),
  Type.Literal("administrator_reactivated"),
  Type.Literal("platform_revoked"),
  Type.Literal("validity_expired"),
]);

export const AssignmentReasonCodeSchema = Type.Union([
  Type.Literal("seat_assigned"),
  Type.Literal("administrator_suspended"),
  Type.Literal("authority_suspended"),
  Type.Literal("validity_expired"),
  Type.Literal("runtime_preparation_failed"),
  Type.Literal("administrator_revoked"),
]);

const EntitlementBaseFields = {
  ...ResourceMetadataFields,
  entitlement_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  tenant_pack_release_id: OpaqueIdSchema,
  pack_version_id: OpaqueIdSchema,
  pack_version: CanonicalSemanticVersionSchema,
  source: EntitlementSourceSchema,
  external_order_ref: OpaqueIdSchema,
  valid_from: UtcTimestampSchema,
  expires_at: Type.Optional(UtcTimestampSchema),
  status: EntitlementStatusSchema,
  reason_code: EntitlementReasonCodeSchema,
} as const;

export const EntitlementSchema = Type.Union([
  Type.Object({
    ...EntitlementBaseFields,
    tenant_mode: Type.Literal("b2b"),
    assignment_mode: Type.Literal("seat"),
    seat_quantity: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...EntitlementBaseFields,
    tenant_mode: Type.Literal("b2c"),
    assignment_mode: Type.Literal("automatic"),
  }, { additionalProperties: false }),
], { $id: "core-agent://v1/entitlement" });

export const EntitlementAssignmentSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    assignment_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    entitlement_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    status: AssignmentStatusSchema,
    reason_code: AssignmentReasonCodeSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/entitlement-assignment" },
);

export type Entitlement = Static<typeof EntitlementSchema>;
export type EntitlementAssignment = Static<typeof EntitlementAssignmentSchema>;

export function validateEntitlement(
  entitlement: Pick<Entitlement, "valid_from" | "expires_at">,
): ContractViolation[] {
  if (entitlement.expires_at === undefined) return [];
  const validFrom = parseStrictUtcTimestamp(entitlement.valid_from);
  const expiresAt = parseStrictUtcTimestamp(entitlement.expires_at);
  if (validFrom !== undefined && expiresAt !== undefined && expiresAt <= validFrom) {
    return [violation(
      "ENTITLEMENT_VALIDITY_INVERTED",
      "expires_at",
      "Entitlement expiry must be later than its validity start",
    )];
  }
  return [];
}
