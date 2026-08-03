import Type, { type Static } from "typebox";

import { OpaqueIdSchema, SchemaVersionSchema } from "../common/primitives.js";
import { PayloadHashSchema } from "./idempotency.js";
import { MessageContentSchema } from "./messages.js";

export const CreateAgentRunRequestSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
  client_request_id: OpaqueIdSchema,
  input_message: Type.Object({
    client_message_id: OpaqueIdSchema,
    content: MessageContentSchema,
  }, { additionalProperties: false }),
  parent_run_id: Type.Optional(OpaqueIdSchema),
}, { additionalProperties: false, $id: "core-agent://v1/create-agent-run-request" });

export type CreateAgentRunRequest = Static<typeof CreateAgentRunRequestSchema>;
