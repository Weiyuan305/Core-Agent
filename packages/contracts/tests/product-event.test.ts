import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  AgentRunStatusSchema,
  ApprovalEventSchema,
  ApprovalStatusSchema,
  AuditEventSchema,
  ContainerObservedStateSchema,
  ConversationEventSchema,
  ConversationStatusSchema,
  ErrorCategorySchema,
  ErrorEnvelopeSchema,
  ErrorReportedEventSchema,
  MembershipRoleSchema,
  MessageCreatedEventSchema,
  MessageCompletedEventSchema,
  MessageDeltaEventSchema,
  ProductEventSchema,
  RuntimeEventSchema,
  RunEventSchema,
  StableErrorCodeSchema,
  TaskEventSchema,
  TaskStatusSchema,
  ToolEventSchema,
  classifyProductEvent,
  validateProductEventConsistency,
  type ProductEvent,
} from "../src/index.js";

const base = {
  schema_version: 1 as const,
  event_id: "event_demo",
  occurred_at: "2026-08-03T01:02:03Z",
  sequence: 4,
  tenant_id: "tenant_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  correlation_id: "conversation_demo",
  causation_id: "run_demo",
  conversation_id: "conversation_demo",
  run_id: "run_demo",
};

const knownEvents = [
  { event_type: "conversation.created", payload: { conversation_id: "conversation_demo", status: "active" } },
  { event_type: "conversation.archived", payload: { conversation_id: "conversation_demo", status: "archived" } },
  { event_type: "run.queued", payload: { run_id: "run_demo", status: "queued" } },
  { event_type: "run.started", payload: { run_id: "run_demo", status: "running" } },
  { event_type: "run.waiting_approval", payload: { run_id: "run_demo", status: "waiting_approval" } },
  { event_type: "run.completed", payload: { run_id: "run_demo", status: "succeeded", summary: "Finished" } },
  { event_type: "run.failed", payload: { run_id: "run_demo", status: "failed" } },
  { event_type: "run.cancelled", payload: { run_id: "run_demo", status: "cancelled" } },
  { event_type: "message.delta", payload: { message_id: "message_demo", delta: "Hello" } },
  { event_type: "message.completed", payload: { message_id: "message_demo", content: "Hello" } },
  { event_type: "message.created", payload: { message_id: "message_demo", role: "user", status: "completed" } },
  { event_type: "task.created", payload: { task_id: "task_demo", status: "queued" } },
  { event_type: "task.status_changed", payload: { task_id: "task_demo", status: "running" } },
  { event_type: "approval.requested", payload: { approval_id: "approval_demo", status: "pending" } },
  { event_type: "approval.resolved", payload: { approval_id: "approval_demo", status: "approved" } },
  { event_type: "tool.requested", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "requested" } },
  { event_type: "tool.started", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "started" } },
  { event_type: "tool.succeeded", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "succeeded", summary: "Matched" } },
  { event_type: "tool.failed", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "failed" } },
  { event_type: "runtime.status_changed", payload: { container_id: "container_demo", observed_state: "ready" } },
  { event_type: "runtime.command_accepted", payload: { container_id: "container_demo", command: "restart", desired_state: "running" } },
  { event_type: "error.reported", payload: { error_id: "error_demo", code: "APPROVAL_REQUIRED", category: "authorization" } },
] as const;

test("accepts a typed message delta and rejects hidden reasoning", () => {
  const event = { ...base, event_type: "message.delta", payload: { message_id: "message_demo", delta: "Hello" } };
  const validator = Schema.Compile(ProductEventSchema);
  assert.equal(validator.Check(event), true);
  assert.equal(validator.Check({ ...event, payload: { ...event.payload, hidden_reasoning: "private" } }), false);
  assert.equal(validator.Check({ ...event, payload: { ...event.payload, chain_of_thought: "private" } }), false);
});

test("accepts all 22 approved event types across ten strict families", () => {
  assert.equal(new Set(knownEvents.map(({ event_type }) => event_type)).size, 22);
  const validator = Schema.Compile(ProductEventSchema);
  for (const event of knownEvents) {
    assert.equal(validator.Check({ ...base, ...event }), true, event.event_type);
    assert.equal(validator.Check({ ...base, ...event, payload: { ...event.payload, unlisted: true } }), false, `${event.event_type} strict payload`);
  }
});

test("rejects every fixed event type and status contradiction", () => {
  const contradictions = [
    { event_type: "conversation.created", payload: { conversation_id: "conversation_demo", status: "archived" } },
    { event_type: "conversation.archived", payload: { conversation_id: "conversation_demo", status: "active" } },
    { event_type: "run.queued", payload: { run_id: "run_demo", status: "running" } },
    { event_type: "run.started", payload: { run_id: "run_demo", status: "queued" } },
    { event_type: "run.waiting_approval", payload: { run_id: "run_demo", status: "running" } },
    { event_type: "run.completed", payload: { run_id: "run_demo", status: "failed" } },
    { event_type: "run.failed", payload: { run_id: "run_demo", status: "succeeded" } },
    { event_type: "run.cancelled", payload: { run_id: "run_demo", status: "failed" } },
    { event_type: "task.created", payload: { task_id: "task_demo", status: "running" } },
    { event_type: "approval.requested", payload: { approval_id: "approval_demo", status: "approved" } },
    { event_type: "approval.resolved", payload: { approval_id: "approval_demo", status: "pending" } },
    { event_type: "tool.requested", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "started" } },
    { event_type: "tool.started", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "requested" } },
    { event_type: "tool.succeeded", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "failed" } },
    { event_type: "tool.failed", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "succeeded" } },
  ] as const;
  const validator = Schema.Compile(ProductEventSchema);

  for (const event of contradictions) {
    const value = { ...base, ...event };
    assert.equal(validator.Check(value), false, event.event_type);
    assert.equal(classifyProductEvent(value), "invalid", `${event.event_type} classification`);
  }
});

test("accepts the deliberately variable status event branches", () => {
  const validator = Schema.Compile(ProductEventSchema);
  for (const status of [
    "queued", "running", "waiting_approval", "paused", "succeeded", "failed", "cancelled",
  ] as const) {
    assert.equal(validator.Check({
      ...base,
      event_type: "task.status_changed",
      payload: { task_id: "task_demo", status },
    }), true, `task.status_changed ${status}`);
  }
  for (const status of ["approved", "rejected", "expired", "cancelled"] as const) {
    assert.equal(validator.Check({
      ...base,
      event_type: "approval.resolved",
      payload: { approval_id: "approval_demo", status },
    }), true, `approval.resolved ${status}`);
  }
  for (const observed_state of [
    "requested", "provisioning", "starting", "ready", "draining", "upgrading",
    "recovering", "stopping", "stopped", "failed", "deleting", "deleted",
  ] as const) {
    assert.equal(validator.Check({
      ...base,
      event_type: "runtime.status_changed",
      payload: { container_id: "container_demo", observed_state },
    }), true, `runtime.status_changed ${observed_state}`);
  }
});

test("runtime command acceptance binds each command to its truthful desired state", () => {
  const validator = Schema.Compile(ProductEventSchema);
  for (const [command, desired_state] of [
    ["start", "running"], ["restart", "running"], ["stop", "stopped"], ["delete", "deleted"],
  ] as const) {
    const event = {
      ...base,
      event_type: "runtime.command_accepted",
      payload: { container_id: "container_demo", command, desired_state },
    };
    assert.equal(validator.Check(event), true, command);
    const contradictoryState = desired_state === "running" ? "stopped" : "running";
    assert.equal(validator.Check({ ...event, payload: { ...event.payload, desired_state: contradictoryState } }), false, command);
  }
});

test("accepts the message.created branch with its fixed user completion", () => {
  const event = {
    ...base,
    event_type: "message.created",
    payload: { message_id: "msg_01", role: "user", status: "completed" },
  };
  assert.equal(Schema.Check(ProductEventSchema, event), true);
  assert.equal(Schema.Check(MessageCreatedEventSchema, event), true);
  assert.equal(Schema.Check(ProductEventSchema, {
    ...event,
    payload: { ...event.payload, role: "assistant" },
  }), false);
});

test("producer consistency gate accepts matching or absent association ids", () => {
  const matching = {
    ...base,
    event_type: "run.started",
    payload: { run_id: "run_demo", status: "running" },
  } as ProductEvent;
  const associationAbsent = {
    ...base,
    event_type: "task.created",
    payload: { task_id: "task_demo", status: "queued" },
  } as ProductEvent;

  assert.deepEqual(validateProductEventConsistency(matching), []);
  assert.deepEqual(validateProductEventConsistency(associationAbsent), []);
});

test("producer consistency gate reports stable association mismatches", () => {
  const mismatches = [
    {
      event: {
        ...base,
        event_type: "conversation.created",
        payload: { conversation_id: "conversation_other", status: "active" },
      },
      code: "EVENT_CONVERSATION_ID_MISMATCH",
      path: "payload.conversation_id",
    },
    {
      event: {
        ...base,
        event_type: "run.started",
        payload: { run_id: "run_other", status: "running" },
      },
      code: "EVENT_RUN_ID_MISMATCH",
      path: "payload.run_id",
    },
    {
      event: {
        ...base,
        task_id: "task_demo",
        event_type: "task.created",
        payload: { task_id: "task_other", status: "queued" },
      },
      code: "EVENT_TASK_ID_MISMATCH",
      path: "payload.task_id",
    },
    {
      event: {
        ...base,
        approval_id: "approval_demo",
        event_type: "approval.requested",
        payload: { approval_id: "approval_other", status: "pending" },
      },
      code: "EVENT_APPROVAL_ID_MISMATCH",
      path: "payload.approval_id",
    },
  ] as const;

  for (const { event, code, path } of mismatches) {
    assert.deepEqual(
      validateProductEventConsistency(event as ProductEvent).map((item) => ({
        code: item.code,
        path: item.path,
      })),
      [{ code, path }],
    );
  }
});

test("keeps event text bounded and tool payloads redacted", () => {
  const validator = Schema.Compile(ProductEventSchema);
  assert.equal(validator.Check({ ...base, event_type: "message.delta", payload: { message_id: "message_demo", delta: "x".repeat(16_001) } }), false);
  assert.equal(validator.Check({ ...base, event_type: "message.completed", payload: { message_id: "message_demo", content: "x".repeat(4_001) } }), false);
  for (const forbidden of ["arguments", "raw_input", "raw_output"] as const) {
    assert.equal(validator.Check({
      ...base,
      event_type: "tool.requested",
      payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "requested", [forbidden]: "private" },
    }), false, forbidden);
  }
});

test("classifies malformed known events as invalid", () => {
  assert.equal(classifyProductEvent({
    ...base,
    event_type: "message.delta",
    payload: { message_id: "message_demo" },
  }), "invalid");
  assert.equal(classifyProductEvent({
    ...base,
    event_type: "message.delta",
    payload: { message_id: "message_demo", delta: "Hello", hidden_reasoning: "private" },
  }), "invalid");
});

test("distinguishes valid known and structurally valid future events", () => {
  assert.equal(Schema.Compile(ProductEventSchema).Check({ ...base, event_type: "future.event", payload: {} }), false);
  assert.equal(classifyProductEvent({ ...base, event_type: "message.delta", payload: { message_id: "message_demo", delta: "Hello" } }), "known");
  assert.equal(classifyProductEvent({ ...base, event_type: "future.event", payload: {} }), "unknown");
  assert.equal(classifyProductEvent({ ...base, event_type: "future.event", payload: {}, extra: true }), "invalid");
  assert.equal(classifyProductEvent({ ...base, event_id: "", event_type: "future.event", payload: {} }), "invalid");
});

test("marks only event and error-code extension points extensible", () => {
  const eventTypeSchemas = [
    ConversationEventSchema,
    RunEventSchema,
    MessageCreatedEventSchema,
    MessageDeltaEventSchema,
    MessageCompletedEventSchema,
    TaskEventSchema,
    ApprovalEventSchema,
    ToolEventSchema,
    RuntimeEventSchema,
    ErrorReportedEventSchema,
  ] as const;
  assert.equal(ProductEventSchema["x-extensible-union"], true);
  for (const eventSchema of eventTypeSchemas) {
    const schema = eventSchema as unknown as Record<string, unknown>;
    assert.equal(schema["x-extensible-union"], true);
    const branches = Array.isArray(schema.anyOf)
      ? schema.anyOf as Array<{ properties: { event_type: Record<string, unknown> } }>
      : [schema as unknown as { properties: { event_type: Record<string, unknown> } }];
    for (const branch of branches) {
      assert.equal(branch.properties.event_type["x-extensible-union"], true);
    }
  }
  assert.equal(StableErrorCodeSchema["x-extensible-union"], true);
  for (const stateOrRole of [
    AgentRunStatusSchema,
    ApprovalStatusSchema,
    ContainerObservedStateSchema,
    ConversationStatusSchema,
    ErrorCategorySchema,
    TaskStatusSchema,
    MembershipRoleSchema,
  ]) {
    assert.equal(stateOrRole["x-extensible-union"], undefined);
  }
  const toolBranches = (ToolEventSchema as unknown as {
    anyOf: Array<{ properties: { payload: { properties: { status: Record<string, unknown> } } } }>;
  }).anyOf;
  for (const branch of toolBranches) {
    assert.equal(branch.properties.payload.properties.status["x-extensible-union"], undefined);
  }
});

test("runtime errors add the accepted stable machine codes", () => {
  const validator = Schema.Compile(StableErrorCodeSchema);
  for (const code of [
    "INVALID_REQUEST",
    "UNAUTHENTICATED",
    "RESOURCE_NOT_FOUND",
    "RESOURCE_VERSION_CONFLICT",
    "INVALID_STATE_TRANSITION",
    "RUNTIME_NOT_READY",
    "SUPERVISOR_REJECTED",
    "DEPENDENCY_TIMEOUT",
  ]) {
    assert.equal(validator.Check(code), true, code);
  }
});

test("audit events are server-shaped and redacted", () => {
  const audit = {
    schema_version: 1,
    audit_event_id: "audit_demo",
    occurred_at: "2026-08-03T01:02:03Z",
    tenant_id: "tenant_demo",
    actor_id: "actor_demo",
    membership_id: "membership_demo",
    effective_role: "consultant",
    action: "application.review",
    resource_type: "case",
    resource_id: "case_demo",
    decision: "allowed",
    outcome: "succeeded",
    request_id: "request_demo",
    trace_id: "trace_demo",
    reason_summary: "Policy checks passed",
    delegation_id: "delegation_demo",
    delegation_reason: "Acting for the assigned consultant",
    run_id: "run_demo",
    task_id: "task_demo",
    approval_id: "approval_demo",
    policy_version: "policy_v1",
    entitlement_snapshot_ref: { snapshot_id: "entitlement_demo", version: 1, evaluated_at: "2026-08-03T01:02:03Z" },
    consent_snapshot_ref: { snapshot_id: "consent_demo", version: 1, evaluated_at: "2026-08-03T01:02:03Z" },
    change_summary: "Review recorded",
    resource_version: 2,
  };
  const validator = Schema.Compile(AuditEventSchema);
  assert.equal(validator.Check(audit), true);
  assert.equal(validator.Check({ ...audit, api_key: "synthetic" }), false);
  assert.equal(validator.Check({ ...audit, reason_summary: "x".repeat(2_001) }), false);
  assert.equal(validator.Check({ ...audit, decision: "maybe" }), false);
});

test("error envelope exposes stable machine semantics", () => {
  const error = {
    schema_version: 1,
    error_id: "error_demo",
    code: "APPROVAL_REQUIRED",
    category: "authorization",
    message: "Approval is required before this action",
    retryable: false,
    request_id: "request_demo",
    trace_id: "trace_demo",
    retry_after_ms: 0,
    field_errors: [{ path: "approval_id", code: "required", message: "Approval is required" }],
    resource_type: "approval",
    resource_id: "approval_demo",
    resource_version: 1,
    current_state: "pending",
  };
  const validator = Schema.Compile(ErrorEnvelopeSchema);
  assert.equal(validator.Check(error), true);
  assert.equal(validator.Check({ ...error, stack: "internal stack" }), false);
  assert.equal(validator.Check({ ...error, code: "UNLISTED" }), false);
  assert.equal(validator.Check({ ...error, retry_after_ms: -1 }), false);
  assert.equal(validator.Check({ ...error, field_errors: [{ ...error.field_errors[0], raw_input: "private" }] }), false);
});
