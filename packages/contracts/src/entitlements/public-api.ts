import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { IdempotencyRequestSchema } from "../runtime/idempotency.js";
import {
  EntitlementSourceSchema,
} from "./authority.js";

export const PublicServiceStateSchema = Type.Union([
  Type.Literal("preparing"),
  Type.Literal("available"),
  Type.Literal("suspended"),
  Type.Literal("expired"),
  Type.Literal("unavailable"),
]);

const PublicServiceFields = {
  schema_version: SchemaVersionSchema,
  service_id: OpaqueIdSchema,
  display_name: Type.String({ minLength: 1, maxLength: 200 }),
  valid_from: UtcTimestampSchema,
  expires_at: Type.Optional(UtcTimestampSchema),
  service_state: PublicServiceStateSchema,
} as const;

export const CompanyServiceSummarySchema = Type.Object(
  {
    ...PublicServiceFields,
    used_seats: Type.Integer({ minimum: 0 }),
    total_seats: Type.Integer({ minimum: 1 }),
    available_seats: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: "core-agent://v1/company-service-summary" },
);

export const StudentServiceSummarySchema = Type.Object(
  PublicServiceFields,
  { additionalProperties: false, $id: "core-agent://v1/student-service-summary" },
);

export const CompanyAssignmentSummarySchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    assignment_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    profile_display_name: Type.String({ minLength: 1, maxLength: 200 }),
    service_display_name: Type.String({ minLength: 1, maxLength: 200 }),
    service_state: PublicServiceStateSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/company-assignment-summary" },
);

const IdempotencyRequestFields = IdempotencyRequestSchema.properties;

export const SelectTenantPackReleaseRequestSchema = Type.Object(
  {
    ...IdempotencyRequestFields,
    tenant_id: OpaqueIdSchema,
    pack_product_id: OpaqueIdSchema,
    pack_version_id: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/select-tenant-pack-release-request" },
);

const GrantEntitlementFields = {
  ...IdempotencyRequestFields,
  tenant_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  source: EntitlementSourceSchema,
  external_order_ref: OpaqueIdSchema,
  expires_at: Type.Optional(UtcTimestampSchema),
} as const;

export const GrantEntitlementRequestSchema = Type.Union([
  Type.Object({
    ...GrantEntitlementFields,
    tenant_mode: Type.Literal("b2b"),
    assignment_mode: Type.Literal("seat"),
    seat_quantity: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...GrantEntitlementFields,
    tenant_mode: Type.Literal("b2c"),
    assignment_mode: Type.Literal("automatic"),
  }, { additionalProperties: false }),
], { $id: "core-agent://v1/grant-entitlement-request" });

const ChangeEntitlementStatusFields = {
  ...IdempotencyRequestFields,
  entitlement_id: OpaqueIdSchema,
  expected_resource_version: ResourceVersionSchema,
} as const;

export const ChangeEntitlementStatusRequestSchema = Type.Union([
  Type.Object({
    ...ChangeEntitlementStatusFields,
    status: Type.Literal("suspended"),
    reason_code: Type.Literal("administrator_suspended"),
  }, { additionalProperties: false }),
  Type.Object({
    ...ChangeEntitlementStatusFields,
    status: Type.Literal("active"),
    reason_code: Type.Literal("administrator_reactivated"),
  }, { additionalProperties: false }),
  Type.Object({
    ...ChangeEntitlementStatusFields,
    status: Type.Literal("revoked"),
    reason_code: Type.Literal("platform_revoked"),
  }, { additionalProperties: false }),
], { $id: "core-agent://v1/change-entitlement-status-request" });

export const AssignPackSeatRequestSchema = Type.Object(
  {
    ...IdempotencyRequestFields,
    entitlement_id: OpaqueIdSchema,
    expected_resource_version: ResourceVersionSchema,
    profile_id: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/assign-pack-seat-request" },
);

export const RevokePackSeatRequestSchema = Type.Object(
  {
    ...IdempotencyRequestFields,
    assignment_id: OpaqueIdSchema,
    expected_resource_version: ResourceVersionSchema,
    reason_code: Type.Literal("administrator_revoked"),
  },
  { additionalProperties: false, $id: "core-agent://v1/revoke-pack-seat-request" },
);

export type CompanyServiceSummary = Static<typeof CompanyServiceSummarySchema>;
export type StudentServiceSummary = Static<typeof StudentServiceSummarySchema>;
export type CompanyAssignmentSummary = Static<typeof CompanyAssignmentSummarySchema>;
export type SelectTenantPackReleaseRequest = Static<typeof SelectTenantPackReleaseRequestSchema>;
export type GrantEntitlementRequest = Static<typeof GrantEntitlementRequestSchema>;
export type ChangeEntitlementStatusRequest = Static<typeof ChangeEntitlementStatusRequestSchema>;
export type AssignPackSeatRequest = Static<typeof AssignPackSeatRequestSchema>;
export type RevokePackSeatRequest = Static<typeof RevokePackSeatRequestSchema>;
