import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import {
  ConsentSnapshotRefSchema,
  EntitlementSnapshotRefSchema,
} from "../runtime/refs.js";
import { MembershipRoleSchema } from "../tenant/identity.js";

export const AuditEventSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    audit_event_id: OpaqueIdSchema,
    occurred_at: UtcTimestampSchema,
    tenant_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    membership_id: OpaqueIdSchema,
    effective_role: MembershipRoleSchema,
    action: OpaqueIdSchema,
    resource_type: OpaqueIdSchema,
    resource_id: OpaqueIdSchema,
    decision: Type.Union([
      Type.Literal("allowed"),
      Type.Literal("denied"),
      Type.Literal("not_applicable"),
    ]),
    outcome: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("pending"),
    ]),
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
    reason_summary: Type.String({ maxLength: 2000 }),
    delegation_id: Type.Optional(OpaqueIdSchema),
    delegation_reason: Type.Optional(Type.String({ maxLength: 2000 })),
    run_id: Type.Optional(OpaqueIdSchema),
    task_id: Type.Optional(OpaqueIdSchema),
    approval_id: Type.Optional(OpaqueIdSchema),
    policy_version: Type.Optional(OpaqueIdSchema),
    entitlement_snapshot_ref: Type.Optional(EntitlementSnapshotRefSchema),
    consent_snapshot_ref: Type.Optional(ConsentSnapshotRefSchema),
    change_summary: Type.Optional(Type.String({ maxLength: 2000 })),
    resource_version: Type.Optional(ResourceVersionSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/audit-event" },
);

export type AuditEvent = Static<typeof AuditEventSchema>;
