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
  { event_type: "task.created", payload: { task_id: "task_demo", status: "queued" } },
  { event_type: "task.status_changed", payload: { task_id: "task_demo", status: "running" } },
  { event_type: "approval.requested", payload: { approval_id: "approval_demo", status: "pending" } },
  { event_type: "approval.resolved", payload: { approval_id: "approval_demo", status: "approved" } },
  { event_type: "tool.requested", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "requested" } },
  { event_type: "tool.started", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "started" } },
  { event_type: "tool.succeeded", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "succeeded", summary: "Matched" } },
  { event_type: "tool.failed", payload: { tool_call_id: "tool_call_demo", tool_name: "eduapply.match", status: "failed" } },
  { event_type: "runtime.status_changed", payload: { container_id: "container_demo", observed_state: "ready" } },
  { event_type: "error.reported", payload: { error_id: "error_demo", code: "APPROVAL_REQUIRED", category: "authorization" } },
] as const;

test("accepts a typed message delta and rejects hidden reasoning", () => {
  const event = { ...base, event_type: "message.delta", payload: { message_id: "message_demo", delta: "Hello" } };
  const validator = Schema.Compile(ProductEventSchema);
  assert.equal(validator.Check(event), true);
  assert.equal(validator.Check({ ...event, payload: { ...event.payload, hidden_reasoning: "private" } }), false);
  assert.equal(validator.Check({ ...event, payload: { ...event.payload, chain_of_thought: "private" } }), false);
});

test("accepts all 20 approved event types across nine strict families", () => {
  assert.equal(new Set(knownEvents.map(({ event_type }) => event_type)).size, 20);
  const validator = Schema.Compile(ProductEventSchema);
  for (const event of knownEvents) {
    assert.equal(validator.Check({ ...base, ...event }), true, event.event_type);
    assert.equal(validator.Check({ ...base, ...event, payload: { ...event.payload, unlisted: true } }), false, `${event.event_type} strict payload`);
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

test("classifies unknown events without breaking the cursor consumer", () => {
  assert.equal(Schema.Compile(ProductEventSchema).Check({ ...base, event_type: "future.event", payload: {} }), false);
  assert.equal(classifyProductEvent({ ...base, event_type: "future.event", payload: {} }), "unknown");
  assert.equal(classifyProductEvent({ ...base, event_type: "message.delta", payload: { message_id: "message_demo", delta: "Hello" } }), "known");
  assert.equal(classifyProductEvent({ ...base, event_type: "future.event", payload: {}, extra: true }), "invalid");
  assert.equal(classifyProductEvent({ ...base, event_id: "", event_type: "future.event", payload: {} }), "invalid");
});

test("marks only event and error-code extension points extensible", () => {
  const eventTypeSchemas = [
    ConversationEventSchema,
    RunEventSchema,
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
    assert.equal(eventSchema.properties.event_type["x-extensible-union"], true);
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
    ToolEventSchema.properties.payload.properties.status,
  ]) {
    assert.equal(stateOrRole["x-extensible-union"], undefined);
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
