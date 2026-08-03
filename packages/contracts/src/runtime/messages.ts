import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields } from "../common/primitives.js";

export const MessageRoleSchema = Type.Union(
  [Type.Literal("user"), Type.Literal("assistant")],
  { "x-extensible-union": true },
);
export const MessageStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("streaming"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
export const MessageContentSchema = Type.String({ minLength: 1, maxLength: 64_000 });
export const MessageSchema = Type.Object({
  ...ResourceMetadataFields,
  message_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  conversation_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  role: MessageRoleSchema,
  status: MessageStatusSchema,
  content: MessageContentSchema,
}, { additionalProperties: false, $id: "core-agent://v1/message" });

export type Message = Static<typeof MessageSchema>;
