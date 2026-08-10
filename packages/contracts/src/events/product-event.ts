import Type, { type Static, type TProperties } from "typebox";
import Schema from "typebox/schema";

import {
  OpaqueIdSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
  SequenceSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";
import { AgentRunFailureCodeSchema } from "../runtime/failures.js";
import {
  ErrorCategorySchema,
  StableErrorCodeSchema,
} from "../errors/error-envelope.js";
import { CaseRefSchema, StudentRefSchema } from "../runtime/refs.js";
import {
  ContainerObservedStateSchema,
  TaskStatusSchema,
} from "../runtime/resources.js";
import { MembershipStatusSchema } from "../tenant/identity.js";
import { CoreSessionRevocationReasonCodeSchema } from "../identity/authority.js";

const EmbeddedStudentRefSchema = Type.Omit(
  StudentRefSchema,
  [],
  { additionalProperties: false },
);
const EmbeddedCaseRefSchema = Type.Omit(
  CaseRefSchema,
  [],
  { additionalProperties: false },
);

const EventAssociationFields = {
  profile_id: Type.Optional(OpaqueIdSchema),
  conversation_id: Type.Optional(OpaqueIdSchema),
  run_id: Type.Optional(OpaqueIdSchema),
  task_id: Type.Optional(OpaqueIdSchema),
  approval_id: Type.Optional(OpaqueIdSchema),
  student_ref: Type.Optional(EmbeddedStudentRefSchema),
  case_ref: Type.Optional(EmbeddedCaseRefSchema),
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

function createEventBranch<
  const EventType extends string,
  const Payload extends TProperties,
>(eventType: EventType, payload: Payload) {
  return Type.Object(
    {
      ...ProductEventBaseFields,
      event_type: Type.Literal(eventType, { "x-extensible-union": true }),
      payload: Type.Object(payload, { additionalProperties: false }),
    },
    { additionalProperties: false },
  );
}

const ConversationCreatedEventSchema = createEventBranch(
  "conversation.created",
  {
    conversation_id: OpaqueIdSchema,
    status: Type.Literal("active"),
  },
);
const ConversationArchivedEventSchema = createEventBranch(
  "conversation.archived",
  {
    conversation_id: OpaqueIdSchema,
    status: Type.Literal("archived"),
  },
);

export const ConversationEventSchema = Type.Union(
  [ConversationCreatedEventSchema, ConversationArchivedEventSchema],
  {
    $id: "core-agent://v1/conversation-event",
    "x-extensible-union": true,
  },
);

function createRunEventBranch<
  const EventType extends string,
  const Status extends
    | "queued"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled",
>(eventType: EventType, status: Status) {
  return createEventBranch(eventType, {
    run_id: OpaqueIdSchema,
    status: Type.Literal(status),
    summary: Type.Optional(Type.String({ maxLength: 4000 })),
  });
}

const RunQueuedEventSchema = createRunEventBranch("run.queued", "queued");
const RunStartedEventSchema = createRunEventBranch("run.started", "running");
const RunWaitingApprovalEventSchema = createRunEventBranch(
  "run.waiting_approval",
  "waiting_approval",
);
const RunCompletedEventSchema = createRunEventBranch("run.completed", "succeeded");
const RunFailedEventSchema = createEventBranch("run.failed", {
  run_id: OpaqueIdSchema,
  status: Type.Literal("failed"),
  failure_code: Type.Optional(AgentRunFailureCodeSchema),
  summary: Type.Optional(Type.String({ maxLength: 4000 })),
});
const RunCancelledEventSchema = createRunEventBranch("run.cancelled", "cancelled");

export const RunEventSchema = Type.Union(
  [
    RunQueuedEventSchema,
    RunStartedEventSchema,
    RunWaitingApprovalEventSchema,
    RunCompletedEventSchema,
    RunFailedEventSchema,
    RunCancelledEventSchema,
  ],
  { $id: "core-agent://v1/run-event", "x-extensible-union": true },
);

const MessageDeltaEventBranchSchema = createEventBranch(
  "message.delta",
  {
    message_id: OpaqueIdSchema,
    delta: Type.String({ maxLength: 16_000 }),
  },
);

export const MessageDeltaEventSchema = Type.Union(
  [MessageDeltaEventBranchSchema],
  { $id: "core-agent://v1/message-delta-event", "x-extensible-union": true },
);

const MessageCompletedEventBranchSchema = createEventBranch(
  "message.completed",
  {
    message_id: OpaqueIdSchema,
    content: Type.String({ maxLength: 4000 }),
  },
);

export const MessageCompletedEventSchema = Type.Union(
  [MessageCompletedEventBranchSchema],
  { $id: "core-agent://v1/message-completed-event", "x-extensible-union": true },
);

const MessageCreatedEventBranchSchema = createEventBranch("message.created", {
  message_id: OpaqueIdSchema,
  role: Type.Literal("user"),
  status: Type.Literal("completed"),
});

export const MessageCreatedEventSchema = Type.Union(
  [MessageCreatedEventBranchSchema],
  { $id: "core-agent://v1/message-created-event", "x-extensible-union": true },
);

const TaskCreatedEventSchema = createEventBranch(
  "task.created",
  {
    task_id: OpaqueIdSchema,
    status: Type.Literal("queued"),
  },
);
const TaskStatusChangedEventSchema = createEventBranch(
  "task.status_changed",
  {
    task_id: OpaqueIdSchema,
    status: TaskStatusSchema,
  },
);

export const TaskEventSchema = Type.Union(
  [TaskCreatedEventSchema, TaskStatusChangedEventSchema],
  { $id: "core-agent://v1/task-event", "x-extensible-union": true },
);

const ApprovalRequestedEventSchema = createEventBranch(
  "approval.requested",
  {
    approval_id: OpaqueIdSchema,
    status: Type.Literal("pending"),
  },
);
const ResolvedApprovalStatusSchema = Type.Union([
  Type.Literal("approved"),
  Type.Literal("rejected"),
  Type.Literal("expired"),
  Type.Literal("cancelled"),
]);
const ApprovalResolvedEventSchema = createEventBranch(
  "approval.resolved",
  {
    approval_id: OpaqueIdSchema,
    status: ResolvedApprovalStatusSchema,
  },
);

export const ApprovalEventSchema = Type.Union(
  [ApprovalRequestedEventSchema, ApprovalResolvedEventSchema],
  { $id: "core-agent://v1/approval-event", "x-extensible-union": true },
);

function createToolEventBranch<
  const EventType extends string,
  const Status extends "requested" | "started" | "succeeded" | "failed",
>(eventType: EventType, status: Status) {
  return createEventBranch(eventType, {
    tool_call_id: OpaqueIdSchema,
    tool_name: OpaqueIdSchema,
    status: Type.Literal(status),
    summary: Type.Optional(Type.String({ maxLength: 4000 })),
  });
}

const ToolRequestedEventSchema = createToolEventBranch("tool.requested", "requested");
const ToolStartedEventSchema = createToolEventBranch("tool.started", "started");
const ToolSucceededEventSchema = createToolEventBranch("tool.succeeded", "succeeded");
const ToolFailedEventSchema = createToolEventBranch("tool.failed", "failed");

export const ToolEventSchema = Type.Union(
  [
    ToolRequestedEventSchema,
    ToolStartedEventSchema,
    ToolSucceededEventSchema,
    ToolFailedEventSchema,
  ],
  { $id: "core-agent://v1/tool-event", "x-extensible-union": true },
);

const RuntimeStatusChangedEventSchema = createEventBranch(
  "runtime.status_changed",
  {
    container_id: OpaqueIdSchema,
    observed_state: ContainerObservedStateSchema,
  },
);

function createRuntimeCommandAcceptedBranch<
  const Command extends "start" | "stop" | "restart" | "delete",
  const DesiredState extends "running" | "stopped" | "deleted",
>(command: Command, desiredState: DesiredState) {
  return createEventBranch(
    "runtime.command_accepted",
    {
      container_id: OpaqueIdSchema,
      command: Type.Literal(command),
      desired_state: Type.Literal(desiredState),
    },
  );
}

const RuntimeCommandAcceptedEventBranches = [
  createRuntimeCommandAcceptedBranch("start", "running"),
  createRuntimeCommandAcceptedBranch("stop", "stopped"),
  createRuntimeCommandAcceptedBranch("restart", "running"),
  createRuntimeCommandAcceptedBranch("delete", "deleted"),
] as const;

export const RuntimeCommandAcceptedEventSchema = Type.Union(
  [...RuntimeCommandAcceptedEventBranches],
  { $id: "core-agent://v1/runtime-command-accepted-event" },
);

export const RuntimeEventSchema = Type.Union(
  [RuntimeStatusChangedEventSchema, ...RuntimeCommandAcceptedEventBranches],
  { $id: "core-agent://v1/runtime-event", "x-extensible-union": true },
);

const ErrorReportedEventBranchSchema = createEventBranch(
  "error.reported",
  {
    error_id: OpaqueIdSchema,
    code: StableErrorCodeSchema,
    category: ErrorCategorySchema,
  },
);

export const ErrorReportedEventSchema = Type.Union(
  [ErrorReportedEventBranchSchema],
  { $id: "core-agent://v1/error-reported-event", "x-extensible-union": true },
);

const SafeReasonCodeSchema = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9_]+$" });
const IdentityRegisteredEventSchema = createEventBranch("identity.registered", {
  actor_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  resource_version: ResourceVersionSchema,
});
const InvitationCreatedEventSchema = createEventBranch("invitation.created", {
  invitation_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  status: Type.Literal("pending"),
  resource_version: ResourceVersionSchema,
});
const InvitationAcceptedEventSchema = createEventBranch("invitation.accepted", {
  invitation_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: Type.Literal("accepted"),
  resource_version: ResourceVersionSchema,
});
const MembershipChangedEventSchema = createEventBranch("membership.changed", {
  membership_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: MembershipStatusSchema,
  reason_code: Type.Optional(SafeReasonCodeSchema),
  resource_version: ResourceVersionSchema,
});
const SessionRevokedEventSchema = createEventBranch("session.revoked", {
  session_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
  reason_code: Type.Optional(CoreSessionRevocationReasonCodeSchema),
  resource_version: ResourceVersionSchema,
});
const AccountDeletionRequestedEventSchema = createEventBranch("account.deletion_requested", {
  account_deletion_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: Type.Literal("deletion_pending"),
  resource_version: ResourceVersionSchema,
});
const AccountDeletionCancelledEventSchema = createEventBranch("account.deletion_cancelled", {
  account_deletion_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: Type.Literal("cancelled"),
  resource_version: ResourceVersionSchema,
});
const AccountDeletedEventSchema = createEventBranch("account.deleted", {
  account_deletion_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: Type.Literal("deleted"),
  resource_version: ResourceVersionSchema,
});

const IdentityEventBranchSchemas = [
  IdentityRegisteredEventSchema,
  InvitationCreatedEventSchema,
  InvitationAcceptedEventSchema,
  MembershipChangedEventSchema,
  SessionRevokedEventSchema,
  AccountDeletionRequestedEventSchema,
  AccountDeletionCancelledEventSchema,
  AccountDeletedEventSchema,
] as const;

export const IdentityEventSchema = Type.Union(
  [...IdentityEventBranchSchemas],
  { $id: "core-agent://v1/identity-event", "x-extensible-union": true },
);

const ProductEventBranchSchemas = [
  ConversationCreatedEventSchema,
  ConversationArchivedEventSchema,
  RunQueuedEventSchema,
  RunStartedEventSchema,
  RunWaitingApprovalEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  MessageDeltaEventBranchSchema,
  MessageCompletedEventBranchSchema,
  TaskCreatedEventSchema,
  TaskStatusChangedEventSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ToolRequestedEventSchema,
  ToolStartedEventSchema,
  ToolSucceededEventSchema,
  ToolFailedEventSchema,
  RuntimeStatusChangedEventSchema,
  ...RuntimeCommandAcceptedEventBranches,
  ErrorReportedEventBranchSchema,
  MessageCreatedEventBranchSchema,
  ...IdentityEventBranchSchemas,
] as const;

const ProductEventFamilySchemas = [
  ConversationEventSchema,
  RunEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  TaskEventSchema,
  ApprovalEventSchema,
  ToolEventSchema,
  RuntimeEventSchema,
  ErrorReportedEventSchema,
  MessageCreatedEventSchema,
  IdentityEventSchema,
] as const;

export const ProductEventSchema = Type.Union(
  [...ProductEventFamilySchemas],
  { $id: "core-agent://v1/product-event", "x-extensible-union": true },
);

const envelopeValidator = Schema.Compile(ProductEventEnvelopeSchema);
const knownEventValidator = Schema.Compile(ProductEventSchema);
const knownEventTypeValidator = Schema.Compile(Type.Union(
  ProductEventBranchSchemas.map((branch) => branch.properties.event_type),
));

export type ProductEvent = Static<typeof ProductEventSchema>;
export type ProductEventEnvelope = Static<typeof ProductEventEnvelopeSchema>;

export function classifyProductEvent(value: unknown): "known" | "unknown" | "invalid" {
  if (!envelopeValidator.Check(value)) return "invalid";
  if (knownEventValidator.Check(value)) return "known";
  return knownEventTypeValidator.Check(value.event_type) ? "invalid" : "unknown";
}

const associationIdChecks = [
  ["tenant_id", "EVENT_TENANT_ID_MISMATCH"],
  ["conversation_id", "EVENT_CONVERSATION_ID_MISMATCH"],
  ["run_id", "EVENT_RUN_ID_MISMATCH"],
  ["task_id", "EVENT_TASK_ID_MISMATCH"],
  ["approval_id", "EVENT_APPROVAL_ID_MISMATCH"],
] as const;

/**
 * Producer gate for associations that JSON Schema cannot compare across the
 * envelope and payload. Run this after ProductEventSchema validation and
 * before publishing a known event.
 */
export function validateProductEventConsistency(
  event: ProductEvent,
): ContractViolation[] {
  const envelope = event as unknown as Record<string, unknown>;
  const payload = envelope.payload as Record<string, unknown>;
  const violations: ContractViolation[] = [];

  for (const [field, code] of associationIdChecks) {
    if (
      typeof envelope[field] === "string"
      && typeof payload[field] === "string"
      && envelope[field] !== payload[field]
    ) {
      violations.push(violation(
        code,
        `payload.${field}`,
        `Payload ${field} must match the event association`,
      ));
    }
  }
  return violations;
}
