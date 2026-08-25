import { randomUUID } from "node:crypto";

import type { AuditEvent, ProductEvent } from "@core-agent/contracts";
import type { Transaction } from "kysely";
import { sql } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { appendAuditEvent, appendProductEvents, type ProductEventWithoutSequence } from "../events.js";

type ToolState = "requested" | "started" | "succeeded" | "failed";

function toolEvent(input: {
  tenantId: string; runId: string; profileId: string; requestId: string; traceId: string; correlationId: string;
  toolCallId: string; toolName: string; state: ToolState; now: Date; summary?: string;
}): ProductEventWithoutSequence {
  return {
    schema_version: 1, event_id: `event-${randomUUID()}`, occurred_at: input.now.toISOString(), tenant_id: input.tenantId,
    request_id: input.requestId, trace_id: input.traceId, correlation_id: input.correlationId,
    causation_id: input.toolCallId, profile_id: input.profileId, run_id: input.runId,
    event_type: `tool.${input.state}`,
    payload: { tool_call_id: input.toolCallId, tool_name: input.toolName, status: input.state, ...(input.summary === undefined ? {} : { summary: input.summary }) },
  } as ProductEventWithoutSequence;
}

export async function recordRequestedToolCall(trx: Transaction<RuntimeDatabase>, input: {
  tenantId: string; mcpToolCallId: string; policySessionId: string; decisionId: string; proofId: string;
  bindingId: string; toolCallId: string; toolName: string; argumentsHash: string; now: Date;
  runId: string; profileId: string; requestId: string; traceId: string; correlationId: string;
}): Promise<void> {
  await trx.insertInto("mcp_tool_calls").values({
    tenant_id: input.tenantId, mcp_tool_call_id: input.mcpToolCallId, policy_session_id: input.policySessionId,
    decision_id: input.decisionId, proof_id: input.proofId, mcp_tool_binding_id: input.bindingId,
    tool_call_id: input.toolCallId, public_tool_name: input.toolName, arguments_hash: input.argumentsHash,
    status: "requested", reason_code: null, safe_result_summary: null, requested_at: input.now,
    started_at: null, finished_at: null, resource_version: 1, updated_at: input.now,
  }).execute();
  await appendProductEvents({ tenantId: input.tenantId, trx }, {
    streamId: `run-${input.runId}`, deliveryTarget: "internal_event_stream",
    events: [toolEvent({ ...input, state: "requested" })],
  });
}

export async function transitionToolCall(trx: Transaction<RuntimeDatabase>, input: {
  tenantId: string; mcpToolCallId: string; from: ToolState; to: Exclude<ToolState, "requested">; now: Date;
  reasonCode: string | null; summary: string | null; runId: string; profileId: string; actorId: string;
  membershipId: string; effectiveRole: "admin" | "consultant" | "student"; requestId: string; traceId: string;
  correlationId: string; toolCallId: string; toolName: string; policyVersion: string;
}): Promise<boolean> {
  const updated = await trx.updateTable("mcp_tool_calls").set({
    status: input.to, reason_code: input.reasonCode, safe_result_summary: input.summary,
    ...(input.to === "started" ? { started_at: input.now } : { finished_at: input.now }),
    resource_version: sql`resource_version + 1`, updated_at: input.now,
  }).where("tenant_id", "=", input.tenantId).where("mcp_tool_call_id", "=", input.mcpToolCallId)
    .where("status", "=", input.from).returning("resource_version").executeTakeFirst();
  if (updated === undefined) return false;
  await appendProductEvents({ tenantId: input.tenantId, trx }, {
    streamId: `run-${input.runId}`, deliveryTarget: "internal_event_stream",
    events: [toolEvent({
      tenantId: input.tenantId, runId: input.runId, profileId: input.profileId,
      requestId: input.requestId, traceId: input.traceId, correlationId: input.correlationId,
      toolCallId: input.toolCallId, toolName: input.toolName, state: input.to, now: input.now,
      ...(input.summary === null ? {} : { summary: input.summary }),
    })],
  });
  if (input.to === "succeeded" || input.to === "failed") {
    const event: AuditEvent = {
      schema_version: 1, audit_event_id: `audit-${randomUUID()}`, occurred_at: input.now.toISOString(),
      tenant_id: input.tenantId, actor_id: input.actorId, membership_id: input.membershipId,
      effective_role: input.effectiveRole, action: "tool.invoke", resource_type: "mcp_tool_call",
      resource_id: input.mcpToolCallId, decision: input.to === "succeeded" ? "allowed" : "denied",
      outcome: input.to === "succeeded" ? "succeeded" : "failed", request_id: input.requestId,
      trace_id: input.traceId, reason_summary: input.summary ?? "Tool invocation failed safely",
      run_id: input.runId, policy_version: input.policyVersion, resource_version: Number(updated.resource_version),
    };
    await appendAuditEvent({ tenantId: input.tenantId, trx }, event);
  }
  return true;
}
