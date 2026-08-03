import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields, UtcTimestampSchema } from "../common/primitives.js";

export const ApprovalStatusSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"),
  Type.Literal("expired"), Type.Literal("cancelled"),
]);

export const ApprovalSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    approval_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    task_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    requested_action: OpaqueIdSchema,
    summary: Type.String({ minLength: 1, maxLength: 1000 }),
    status: ApprovalStatusSchema,
    requester_actor_id: OpaqueIdSchema,
    decision_actor_id: Type.Optional(OpaqueIdSchema),
    requested_at: UtcTimestampSchema,
    decided_at: Type.Optional(UtcTimestampSchema),
    decision_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    trusted_context_version: Type.Integer({ minimum: 1 }),
    expires_at: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/approval" },
);

export type Approval = Static<typeof ApprovalSchema>;
