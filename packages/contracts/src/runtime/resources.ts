import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields, UtcTimestampSchema } from "../common/primitives.js";
import { AgentRunFailureCodeSchema } from "./failures.js";
import { CaseRefSchema, StudentRefSchema } from "./refs.js";

export const ContainerDesiredStateSchema = Type.Union([
  Type.Literal("running"), Type.Literal("stopped"), Type.Literal("deleted"),
]);
export const ContainerObservedStateSchema = Type.Union([
  Type.Literal("requested"), Type.Literal("provisioning"), Type.Literal("starting"),
  Type.Literal("ready"), Type.Literal("draining"), Type.Literal("upgrading"),
  Type.Literal("recovering"), Type.Literal("stopping"), Type.Literal("stopped"),
  Type.Literal("failed"), Type.Literal("deleting"), Type.Literal("deleted"),
]);
export const ContainerHealthStatusSchema = Type.Union([
  Type.Literal("unknown"), Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("unhealthy"),
]);
export const ConversationStatusSchema = Type.Union([
  Type.Literal("active"), Type.Literal("archived"), Type.Literal("closed"),
]);
export const SessionStatusSchema = Type.Union([
  Type.Literal("active"), Type.Literal("idle"), Type.Literal("expired"), Type.Literal("closed"),
]);
export const AgentRunStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting_approval"),
  Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"),
]);
export const TaskStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting_approval"),
  Type.Literal("paused"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"),
]);
export const DependencyStatusSchema = Type.Union([
  Type.Literal("not_checked"), Type.Literal("ready"), Type.Literal("blocked"), Type.Literal("unavailable"),
]);

export const RuntimeContainerSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    container_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    runtime_kind: Type.Literal("hermes"),
    desired_state: ContainerDesiredStateSchema,
    observed_state: ContainerObservedStateSchema,
    image_ref: Type.String({ pattern: "^.+@sha256:[a-f0-9]{64}$" }),
    generation: Type.Integer({ minimum: 1 }),
    volume_ref: OpaqueIdSchema,
    health_status: ContainerHealthStatusSchema,
    last_probed_at: Type.Optional(UtcTimestampSchema),
    failure_summary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false, $id: "core-agent://v1/runtime-container" },
);

export const ConversationSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    conversation_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    created_by_actor_id: OpaqueIdSchema,
    status: ConversationStatusSchema,
    student_ref: Type.Optional(StudentRefSchema),
    case_ref: Type.Optional(CaseRefSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/conversation" },
);

export const SessionSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    session_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    conversation_id: OpaqueIdSchema,
    status: SessionStatusSchema,
    last_active_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    hermes_session_ref: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/session" },
);

export const AgentRunSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    run_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    conversation_id: OpaqueIdSchema,
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
    client_request_id: OpaqueIdSchema,
    idempotency_key: OpaqueIdSchema,
    parent_run_id: Type.Optional(OpaqueIdSchema),
    status: AgentRunStatusSchema,
    started_at: Type.Optional(UtcTimestampSchema),
    finished_at: Type.Optional(UtcTimestampSchema),
    failure_code: Type.Optional(AgentRunFailureCodeSchema),
    failure_summary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false, $id: "core-agent://v1/agent-run" },
);

export const TaskSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    task_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    origin_run_id: OpaqueIdSchema,
    idempotency_key: OpaqueIdSchema,
    capability_id: Type.Optional(OpaqueIdSchema),
    student_ref: Type.Optional(StudentRefSchema),
    case_ref: Type.Optional(CaseRefSchema),
    status: TaskStatusSchema,
    attempt_count: Type.Integer({ minimum: 0 }),
    dependency_status: DependencyStatusSchema,
    result_summary: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false, $id: "core-agent://v1/task" },
);

export type RuntimeContainer = Static<typeof RuntimeContainerSchema>;
export type Conversation = Static<typeof ConversationSchema>;
export type Session = Static<typeof SessionSchema>;
export type AgentRun = Static<typeof AgentRunSchema>;
export type Task = Static<typeof TaskSchema>;
