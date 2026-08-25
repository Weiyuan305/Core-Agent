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
import {
  CaseRefSchema,
  EntitlementSnapshotRefSchema,
  StudentRefSchema,
} from "../runtime/refs.js";
import {
  ContainerObservedStateSchema,
  TaskStatusSchema,
} from "../runtime/resources.js";
import { MembershipStatusSchema } from "../tenant/identity.js";
import { CoreSessionRevocationReasonCodeSchema } from "../identity/authority.js";
import { ServiceFailureReasonCodeSchema } from "../entitlements/snapshots.js";

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
const EmbeddedEntitlementSnapshotRefSchema = Type.Omit(
  EntitlementSnapshotRefSchema,
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

export const PolicyDecisionEventReasonSchema = Type.Union([
  Type.Literal("POLICY_ALLOWED"),
  Type.Literal("SESSION_NOT_ACTIVE"),
  Type.Literal("CURRENT_AUTHORITY_CHANGED"),
  Type.Literal("CAPABILITY_NOT_EFFECTIVE"),
  Type.Literal("POLICY_NOT_PERMITTED"),
  Type.Literal("TOOL_NOT_BOUND"),
  Type.Literal("ARGUMENTS_INVALID"),
  Type.Literal("PROOF_INVALID"),
  Type.Literal("PROOF_EXPIRED"),
  Type.Literal("PROOF_REPLAYED"),
  Type.Literal("DOWNSTREAM_UNAVAILABLE"),
  Type.Literal("DOWNSTREAM_CONTRACT_INVALID"),
]);

const PolicySessionOpenedEventSchema = createEventBranch("policy_session.opened", {
  policy_session_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  policy_version: Type.Literal("core-agent-read-mcp-v1"),
  state: Type.Literal("active"),
  resource_version: ResourceVersionSchema,
});
const PolicySessionClosedEventSchema = createEventBranch("policy_session.closed", {
  policy_session_id: OpaqueIdSchema,
  run_id: OpaqueIdSchema,
  policy_version: Type.Literal("core-agent-read-mcp-v1"),
  state: Type.Union([Type.Literal("closed"), Type.Literal("expired")]),
  resource_version: ResourceVersionSchema,
});
const PolicyDecisionRecordedEventSchema = createEventBranch("policy.decision_recorded", {
  policy_session_id: OpaqueIdSchema,
  decision_id: OpaqueIdSchema,
  tool_call_id: OpaqueIdSchema,
  decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
  reason: PolicyDecisionEventReasonSchema,
  policy_version: Type.Literal("core-agent-read-mcp-v1"),
  resource_version: ResourceVersionSchema,
});

export const PolicyEventSchema = Type.Union(
  [PolicySessionOpenedEventSchema, PolicySessionClosedEventSchema, PolicyDecisionRecordedEventSchema],
  { $id: "core-agent://v1/policy-event", "x-extensible-union": true },
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

export const MembershipEventReasonCodeSchema = Type.Union([
  Type.Literal("invitation_accepted"),
  Type.Literal("administrator_suspended"),
  Type.Literal("administrator_revoked"),
  Type.Literal("consultant_role_granted"),
  Type.Literal("consultant_role_revoked"),
  Type.Literal("platform_role_projected"),
  Type.Literal("platform_role_revoked"),
  Type.Literal("account_deletion_requested"),
  Type.Literal("account_deletion_cancelled"),
  Type.Literal("actor_disabled"),
  Type.Literal("tenant_closed"),
]);
const IdentityRegisteredEventSchema = createEventBranch("identity.registered", {
  actor_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  resource_version: ResourceVersionSchema,
});
const AuthSubjectReplacedEventSchema = createEventBranch("auth_subject.replaced", {
  actor_id: OpaqueIdSchema,
  old_auth_subject_id: OpaqueIdSchema,
  new_auth_subject_id: OpaqueIdSchema,
  old_status: Type.Literal("revoked"),
  new_status: Type.Literal("active"),
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
const InvitationRevokedEventSchema = createEventBranch("invitation.changed", {
    invitation_id: OpaqueIdSchema,
    membership_id: OpaqueIdSchema,
    status: Type.Literal("revoked"),
    resource_version: ResourceVersionSchema,
});
const InvitationReplacedEventSchema = createEventBranch("invitation.changed", {
    invitation_id: OpaqueIdSchema,
    membership_id: OpaqueIdSchema,
    status: Type.Literal("replaced"),
    replacement_invitation_id: OpaqueIdSchema,
    resource_version: ResourceVersionSchema,
});
const InvitationExpiredEventSchema = createEventBranch("invitation.changed", {
    invitation_id: OpaqueIdSchema,
    membership_id: OpaqueIdSchema,
    status: Type.Literal("expired"),
    resource_version: ResourceVersionSchema,
});
const PlatformRoleChangedEventSchema = createEventBranch("platform_role.changed", {
  platform_role_assignment_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: Type.Union([Type.Literal("active"), Type.Literal("revoked")]),
  resource_version: ResourceVersionSchema,
});
const MembershipChangedEventSchema = createEventBranch("membership.changed", {
  membership_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: MembershipStatusSchema,
  reason_code: Type.Optional(MembershipEventReasonCodeSchema),
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
  AuthSubjectReplacedEventSchema,
  InvitationCreatedEventSchema,
  InvitationAcceptedEventSchema,
  InvitationRevokedEventSchema,
  InvitationReplacedEventSchema,
  InvitationExpiredEventSchema,
  PlatformRoleChangedEventSchema,
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

const PackReleaseSelectedEventSchema = createEventBranch("pack.release_selected", {
  tenant_pack_release_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  pack_version_id: OpaqueIdSchema,
  generation: Type.Integer({ minimum: 1 }),
  status: Type.Literal("current"),
  resource_version: ResourceVersionSchema,
});
const EntitlementActivatedEventSchema = createEventBranch("entitlement.activated", {
  entitlement_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  status: Type.Literal("active"),
  reason_code: Type.Union([
    Type.Literal("platform_grant"),
    Type.Literal("administrator_reactivated"),
  ]),
  resource_version: ResourceVersionSchema,
});
const EntitlementSuspendedEventSchema = createEventBranch("entitlement.suspended", {
  entitlement_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  status: Type.Literal("suspended"),
  reason_code: Type.Literal("administrator_suspended"),
  resource_version: ResourceVersionSchema,
});
const EntitlementRevokedEventSchema = createEventBranch("entitlement.revoked", {
  entitlement_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
  reason_code: Type.Literal("platform_revoked"),
  resource_version: ResourceVersionSchema,
});
const EntitlementExpiredEventSchema = createEventBranch("entitlement.expired", {
  entitlement_id: OpaqueIdSchema,
  pack_product_id: OpaqueIdSchema,
  status: Type.Literal("expired"),
  reason_code: Type.Literal("validity_expired"),
  resource_version: ResourceVersionSchema,
});
const AssignmentCreatedEventSchema = createEventBranch("assignment.created", {
  assignment_id: OpaqueIdSchema,
  entitlement_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  status: Type.Literal("preparing"),
  reason_code: Type.Literal("seat_assigned"),
  resource_version: ResourceVersionSchema,
});
const AssignmentRevokedEventSchema = createEventBranch("assignment.revoked", {
  assignment_id: OpaqueIdSchema,
  entitlement_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
  reason_code: Type.Literal("administrator_revoked"),
  resource_version: ResourceVersionSchema,
});
const EntitlementSnapshotChangedEventSchema = createEventBranch("entitlement_snapshot.changed", {
  profile_id: OpaqueIdSchema,
  entitlement_snapshot_ref: EmbeddedEntitlementSnapshotRefSchema,
  resource_version: ResourceVersionSchema,
});

const EntitlementEventBranchSchemas = [
  PackReleaseSelectedEventSchema,
  EntitlementActivatedEventSchema,
  EntitlementSuspendedEventSchema,
  EntitlementRevokedEventSchema,
  EntitlementExpiredEventSchema,
  AssignmentCreatedEventSchema,
  AssignmentRevokedEventSchema,
  EntitlementSnapshotChangedEventSchema,
] as const;

export const EntitlementEventSchema = Type.Union(
  [...EntitlementEventBranchSchemas],
  { $id: "core-agent://v1/entitlement-event", "x-extensible-union": true },
);

function createCatalogCapabilityEvent<
  const EventType extends "capability_version.created" | "capability_version.reviewed" | "capability_version.retired" | "capability_version.blocked",
  const Status extends "draft" | "reviewed" | "retired" | "blocked",
>(eventType: EventType, status: Status) {
  return createEventBranch(eventType, { capability_version_id: OpaqueIdSchema, capability_id: OpaqueIdSchema, status: Type.Literal(status), resource_version: ResourceVersionSchema });
}
function createCatalogPackEvent<
  const EventType extends "pack_version.created" | "pack_version.reviewed" | "pack_version.published" | "pack_version.retired" | "pack_version.blocked",
  const Status extends "draft" | "reviewed" | "published" | "retired" | "blocked",
>(eventType: EventType, status: Status) {
  return createEventBranch(eventType, { pack_version_id: OpaqueIdSchema, pack_product_id: OpaqueIdSchema, status: Type.Literal(status), resource_version: ResourceVersionSchema });
}
const CatalogEventBranchSchemas = [
  createCatalogCapabilityEvent("capability_version.created", "draft"),
  createCatalogCapabilityEvent("capability_version.reviewed", "reviewed"),
  createCatalogCapabilityEvent("capability_version.retired", "retired"),
  createCatalogCapabilityEvent("capability_version.blocked", "blocked"),
  createCatalogPackEvent("pack_version.created", "draft"),
  createCatalogPackEvent("pack_version.reviewed", "reviewed"),
  createCatalogPackEvent("pack_version.published", "published"),
  createCatalogPackEvent("pack_version.retired", "retired"),
  createCatalogPackEvent("pack_version.blocked", "blocked"),
] as const;
export const CatalogEventSchema = Type.Union([...CatalogEventBranchSchemas], { $id: "core-agent://v1/catalog-event", "x-extensible-union": true });

function createServiceEventBranch<
  const EventType extends "service.preparing" | "service.available",
  const State extends "preparing" | "available",
>(eventType: EventType, state: State) {
  return createEventBranch(eventType, {
    profile_id: OpaqueIdSchema,
    generation: Type.Integer({ minimum: 1 }),
    entitlement_snapshot_ref: EmbeddedEntitlementSnapshotRefSchema,
    state: Type.Literal(state),
  });
}

const ServicePreparingEventSchema = createServiceEventBranch("service.preparing", "preparing");
const ServiceAvailableEventSchema = createServiceEventBranch("service.available", "available");
const ServiceFailedEventSchema = createEventBranch("service.failed", {
  profile_id: OpaqueIdSchema,
  generation: Type.Integer({ minimum: 1 }),
  entitlement_snapshot_ref: EmbeddedEntitlementSnapshotRefSchema,
  state: Type.Literal("failed"),
  reason_code: ServiceFailureReasonCodeSchema,
});

const ServiceEventBranchSchemas = [
  ServicePreparingEventSchema,
  ServiceAvailableEventSchema,
  ServiceFailedEventSchema,
] as const;

export const ServiceEventSchema = Type.Union(
  [...ServiceEventBranchSchemas],
  { $id: "core-agent://v1/service-event", "x-extensible-union": true },
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
  PolicySessionOpenedEventSchema,
  PolicySessionClosedEventSchema,
  PolicyDecisionRecordedEventSchema,
  RuntimeStatusChangedEventSchema,
  ...RuntimeCommandAcceptedEventBranches,
  ErrorReportedEventBranchSchema,
  MessageCreatedEventBranchSchema,
  ...IdentityEventBranchSchemas,
  ...EntitlementEventBranchSchemas,
  ...CatalogEventBranchSchemas,
  ...ServiceEventBranchSchemas,
] as const;

const ProductEventFamilySchemas = [
  ConversationEventSchema,
  RunEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  TaskEventSchema,
  ApprovalEventSchema,
  ToolEventSchema,
  PolicyEventSchema,
  RuntimeEventSchema,
  ErrorReportedEventSchema,
  MessageCreatedEventSchema,
  IdentityEventSchema,
  EntitlementEventSchema,
  CatalogEventSchema,
  ServiceEventSchema,
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
  ["profile_id", "EVENT_PROFILE_ID_MISMATCH"],
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
