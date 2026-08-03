import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields } from "../common/primitives.js";

export const TenantModeSchema = Type.Union([Type.Literal("b2b"), Type.Literal("b2c")]);
export const TenantStatusSchema = Type.Union([
  Type.Literal("provisioning"), Type.Literal("active"), Type.Literal("suspended"),
  Type.Literal("closing"), Type.Literal("closed"),
]);
export const ActorKindSchema = Type.Union([Type.Literal("human"), Type.Literal("service")]);
export const ActorStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("disabled")]);
export const MembershipRoleSchema = Type.Union([
  Type.Literal("admin"), Type.Literal("consultant"), Type.Literal("student"),
]);
export const MembershipStatusSchema = Type.Union([
  Type.Literal("invited"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("revoked"),
]);

export const TenantSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    tenant_id: OpaqueIdSchema,
    tenant_mode: TenantModeSchema,
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    status: TenantStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/tenant" },
);

export const ActorSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    actor_id: OpaqueIdSchema,
    actor_kind: ActorKindSchema,
    status: ActorStatusSchema,
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false, $id: "core-agent://v1/actor" },
);

export const MembershipSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    membership_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    roles: Type.Array(MembershipRoleSchema, { minItems: 1, uniqueItems: true }),
    seat_ref: Type.Optional(OpaqueIdSchema),
    status: MembershipStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/membership" },
);

export type Tenant = Static<typeof TenantSchema>;
export type Actor = Static<typeof ActorSchema>;
export type Membership = Static<typeof MembershipSchema>;
