import Type, { type Static } from "typebox";
import Schema from "typebox/schema";

import { ApprovalStatusSchema } from "../approval/schema.js";
import {
  OpaqueIdSchema,
  SchemaVersionSchema,
  SequenceSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import {
  ErrorCategorySchema,
  StableErrorCodeSchema,
} from "../errors/error-envelope.js";
import { CaseRefSchema, StudentRefSchema } from "../runtime/refs.js";
import {
  AgentRunStatusSchema,
  ContainerObservedStateSchema,
  ConversationStatusSchema,
  TaskStatusSchema,
} from "../runtime/resources.js";

const EventAssociationFields = {
  profile_id: Type.Optional(OpaqueIdSchema),
  conversation_id: Type.Optional(OpaqueIdSchema),
  run_id: Type.Optional(OpaqueIdSchema),
  task_id: Type.Optional(OpaqueIdSchema),
  approval_id: Type.Optional(OpaqueIdSchema),
  student_ref: Type.Optional(StudentRefSchema),
  case_ref: Type.Optional(CaseRefSchema),
  capability_id: Type.Optional(OpaqueIdSchema),
} as const;

const ProductEventBaseFields = {
  schema_version: SchemaVersionSchema,
  event_id: OpaqueIdSchema,
  occurred_at: UtcTimestampSchema,
  sequence: SequenceSchema,
  tenant_id: OpaqueIdSchema,
  request_id: OpaqueIdSchema,
  trace_id: OpaqueIdSchema,
  correlation_id: OpaqueIdSchema,
  causation_id: OpaqueIdSchema,
  ...EventAssociationFields,
} as const;

export const ProductEventEnvelopeSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: OpaqueIdSchema,
    payload: Type.Unknown(),
  },
  { additionalProperties: false, $id: "core-agent://v1/product-event-envelope" },
);

export const ConversationEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("conversation.created"),
      Type.Literal("conversation.archived"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        conversation_id: OpaqueIdSchema,
        status: ConversationStatusSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/conversation-event" },
);

export const RunEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("run.queued"),
      Type.Literal("run.started"),
      Type.Literal("run.waiting_approval"),
      Type.Literal("run.completed"),
      Type.Literal("run.failed"),
      Type.Literal("run.cancelled"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        run_id: OpaqueIdSchema,
        status: AgentRunStatusSchema,
        summary: Type.Optional(Type.String({ maxLength: 4000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/run-event" },
);

export const MessageDeltaEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("message.delta"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        message_id: OpaqueIdSchema,
        delta: Type.String({ maxLength: 16_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/message-delta-event" },
);

export const MessageCompletedEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("message.completed"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        message_id: OpaqueIdSchema,
        content: Type.String({ maxLength: 4000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/message-completed-event" },
);

export const TaskEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("task.created"),
      Type.Literal("task.status_changed"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        task_id: OpaqueIdSchema,
        status: TaskStatusSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/task-event" },
);

export const ApprovalEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("approval.requested"),
      Type.Literal("approval.resolved"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        approval_id: OpaqueIdSchema,
        status: ApprovalStatusSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/approval-event" },
);

export const ToolEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("tool.requested"),
      Type.Literal("tool.started"),
      Type.Literal("tool.succeeded"),
      Type.Literal("tool.failed"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        tool_call_id: OpaqueIdSchema,
        tool_name: OpaqueIdSchema,
        status: Type.Union([
          Type.Literal("requested"),
          Type.Literal("started"),
          Type.Literal("succeeded"),
          Type.Literal("failed"),
        ]),
        summary: Type.Optional(Type.String({ maxLength: 4000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/tool-event" },
);

export const RuntimeEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("runtime.status_changed"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        container_id: OpaqueIdSchema,
        observed_state: ContainerObservedStateSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/runtime-event" },
);

export const ErrorReportedEventSchema = Type.Object(
  {
    ...ProductEventBaseFields,
    event_type: Type.Union([
      Type.Literal("error.reported"),
    ], { "x-extensible-union": true }),
    payload: Type.Object(
      {
        error_id: OpaqueIdSchema,
        code: StableErrorCodeSchema,
        category: ErrorCategorySchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/error-reported-event" },
);

export const ProductEventSchema = Type.Union([
  ConversationEventSchema,
  RunEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  TaskEventSchema,
  ApprovalEventSchema,
  ToolEventSchema,
  RuntimeEventSchema,
  ErrorReportedEventSchema,
], { $id: "core-agent://v1/product-event", "x-extensible-union": true });

const envelopeValidator = Schema.Compile(ProductEventEnvelopeSchema);
const knownEventValidator = Schema.Compile(ProductEventSchema);
const knownEventTypeValidator = Schema.Compile(Type.Union([
  ConversationEventSchema.properties.event_type,
  RunEventSchema.properties.event_type,
  MessageDeltaEventSchema.properties.event_type,
  MessageCompletedEventSchema.properties.event_type,
  TaskEventSchema.properties.event_type,
  ApprovalEventSchema.properties.event_type,
  ToolEventSchema.properties.event_type,
  RuntimeEventSchema.properties.event_type,
  ErrorReportedEventSchema.properties.event_type,
]));

export type ProductEvent = Static<typeof ProductEventSchema>;
export type ProductEventEnvelope = Static<typeof ProductEventEnvelopeSchema>;

export function classifyProductEvent(value: unknown): "known" | "unknown" | "invalid" {
  if (!envelopeValidator.Check(value)) return "invalid";
  if (knownEventValidator.Check(value)) return "known";
  return knownEventTypeValidator.Check(value.event_type) ? "invalid" : "unknown";
}
