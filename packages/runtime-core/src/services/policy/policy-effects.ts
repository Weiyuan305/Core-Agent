import { randomUUID } from "node:crypto";

import type { AuditEvent } from "@core-agent/contracts";
import { sql, type Selectable, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { PolicySessionTable } from "../../db/policy-mcp-tables.js";
import { appendAuditEvent, appendProductEvents, type ProductEventWithoutSequence } from "../../repositories/events.js";
import { invalidateIssuedProofs } from "../../repositories/policy/sessions.js";

function policyEvent(session: Selectable<PolicySessionTable>, now: Date, input:
  | { kind: "opened"; resourceVersion: number }
  | { kind: "closed"; state: "closed" | "expired"; resourceVersion: number }
  | { kind: "decision"; decisionId: string; toolCallId: string; decision: "allow" | "deny"; reason: string; resourceVersion: number },
): ProductEventWithoutSequence {
  const base = {
    schema_version: 1 as const, event_id: `event-${randomUUID()}`, occurred_at: now.toISOString(),
    tenant_id: session.tenant_id, request_id: session.request_id, trace_id: session.trace_id,
    correlation_id: session.correlation_id, profile_id: session.profile_id,
    conversation_id: session.conversation_id, run_id: session.run_id,
  };
  if (input.kind === "opened") return {
    ...base, causation_id: session.policy_session_id, event_type: "policy_session.opened",
    payload: { policy_session_id: session.policy_session_id, run_id: session.run_id,
      policy_version: session.policy_version_id, state: "active", resource_version: input.resourceVersion },
  } as ProductEventWithoutSequence;
  if (input.kind === "closed") return {
    ...base, causation_id: session.policy_session_id, event_type: "policy_session.closed",
    payload: { policy_session_id: session.policy_session_id, run_id: session.run_id,
      policy_version: session.policy_version_id, state: input.state, resource_version: input.resourceVersion },
  } as ProductEventWithoutSequence;
  return {
    ...base, causation_id: input.decisionId, event_type: "policy.decision_recorded",
    payload: { policy_session_id: session.policy_session_id, decision_id: input.decisionId,
      tool_call_id: input.toolCallId, decision: input.decision, reason: input.reason,
      policy_version: session.policy_version_id, resource_version: input.resourceVersion },
  } as ProductEventWithoutSequence;
}

export async function appendPolicySessionEffect(
  trx: Transaction<RuntimeDatabase>, session: Selectable<PolicySessionTable>, now: Date,
  input: { kind: "opened"; resourceVersion: number } | { kind: "closed"; state: "closed" | "expired"; resourceVersion: number },
): Promise<void> {
  await appendProductEvents({ tenantId: session.tenant_id, trx }, {
    streamId: `run-${session.run_id}`, deliveryTarget: "internal_event_stream",
    events: [policyEvent(session, now, input)],
  });
  const event: AuditEvent = {
    schema_version: 1, audit_event_id: `audit-${randomUUID()}`, occurred_at: now.toISOString(),
    tenant_id: session.tenant_id, actor_id: session.actor_id, membership_id: session.membership_id,
    effective_role: session.effective_role, action: input.kind === "opened" ? "policy.session.open" : "policy.session.close",
    resource_type: "policy_session", resource_id: session.policy_session_id, decision: "allowed",
    outcome: "succeeded", request_id: session.request_id, trace_id: session.trace_id,
    reason_summary: input.kind === "opened" ? "Opened a current bounded Policy Session" : "Closed a Policy Session and revoked issued proofs",
    run_id: session.run_id, policy_version: session.policy_version_id, resource_version: input.resourceVersion,
    entitlement_snapshot_ref: { snapshot_id: session.snapshot_id, version: Number(session.snapshot_version), evaluated_at: session.snapshot_evaluated_at.toISOString() },
  };
  await appendAuditEvent({ tenantId: session.tenant_id, trx }, event);
}

export async function appendPolicyDecisionEffect(
  trx: Transaction<RuntimeDatabase>, session: Selectable<PolicySessionTable>, now: Date,
  input: { decisionId: string; toolCallId: string; decision: "allow" | "deny"; reason: string; resourceVersion: number },
): Promise<void> {
  await appendProductEvents({ tenantId: session.tenant_id, trx }, {
    streamId: `run-${session.run_id}`, deliveryTarget: "internal_event_stream",
    events: [policyEvent(session, now, { kind: "decision", ...input })],
  });
  await appendAuditEvent({ tenantId: session.tenant_id, trx }, {
    schema_version: 1, audit_event_id: `audit-${randomUUID()}`, occurred_at: now.toISOString(),
    tenant_id: session.tenant_id, actor_id: session.actor_id, membership_id: session.membership_id,
    effective_role: session.effective_role, action: "policy.decision", resource_type: "policy_decision",
    resource_id: input.decisionId, decision: input.decision === "allow" ? "allowed" : "denied", outcome: "succeeded",
    request_id: session.request_id, trace_id: session.trace_id, reason_summary: `Policy decision: ${input.reason}`,
    run_id: session.run_id, policy_version: session.policy_version_id, resource_version: input.resourceVersion,
    entitlement_snapshot_ref: { snapshot_id: session.snapshot_id, version: Number(session.snapshot_version), evaluated_at: session.snapshot_evaluated_at.toISOString() },
  });
}

export async function appendPolicyAuthenticationDenialAudit(
  trx: Transaction<RuntimeDatabase>, session: Selectable<PolicySessionTable>, now: Date,
  reason: "SESSION_NOT_ACTIVE" | "CURRENT_AUTHORITY_CHANGED",
): Promise<void> {
  await appendAuditEvent({ tenantId: session.tenant_id, trx }, {
    schema_version: 1, audit_event_id: `audit-${randomUUID()}`, occurred_at: now.toISOString(),
    tenant_id: session.tenant_id, actor_id: session.actor_id, membership_id: session.membership_id,
    effective_role: session.effective_role, action: "policy.authentication",
    resource_type: "policy_session", resource_id: session.policy_session_id, decision: "denied",
    outcome: "failed", request_id: session.request_id, trace_id: session.trace_id,
    reason_summary: `Policy authentication denied: ${reason}`, run_id: session.run_id,
    policy_version: session.policy_version_id, resource_version: Number(session.resource_version),
    entitlement_snapshot_ref: {
      snapshot_id: session.snapshot_id, version: Number(session.snapshot_version),
      evaluated_at: session.snapshot_evaluated_at.toISOString(),
    },
  });
}

export async function appendPolicyProofConsumedAudit(
  trx: Transaction<RuntimeDatabase>, session: Selectable<PolicySessionTable>, now: Date,
  input: { proofId: string; decisionId: string; resourceVersion: number },
): Promise<void> {
  await appendAuditEvent({ tenantId: session.tenant_id, trx }, {
    schema_version: 1, audit_event_id: `audit-${randomUUID()}`, occurred_at: now.toISOString(),
    tenant_id: session.tenant_id, actor_id: session.actor_id, membership_id: session.membership_id,
    effective_role: session.effective_role, action: "policy.proof.consume",
    resource_type: "policy_execution_proof", resource_id: input.proofId, decision: "allowed",
    outcome: "succeeded", request_id: session.request_id, trace_id: session.trace_id,
    reason_summary: `Consumed execution proof for decision ${input.decisionId}`, run_id: session.run_id,
    policy_version: session.policy_version_id, resource_version: input.resourceVersion,
    entitlement_snapshot_ref: {
      snapshot_id: session.snapshot_id, version: Number(session.snapshot_version),
      evaluated_at: session.snapshot_evaluated_at.toISOString(),
    },
  });
}

export async function terminatePolicySession(
  trx: Transaction<RuntimeDatabase>, session: Selectable<PolicySessionTable>, now: Date,
  state: "closed" | "expired",
  reason: NonNullable<PolicySessionTable["close_reason"]>,
): Promise<boolean> {
  const updated = await trx.updateTable("policy_sessions").set({
    state, close_reason: reason, closed_at: now, resource_version: sql`resource_version + 1`, updated_at: now,
  }).where("tenant_id", "=", session.tenant_id).where("policy_session_id", "=", session.policy_session_id)
    .where("state", "=", "active").returning("resource_version").executeTakeFirst();
  if (updated === undefined) return false;
  await invalidateIssuedProofs(trx, session.tenant_id, session.policy_session_id, now);
  await appendPolicySessionEffect(trx, session, now, { kind: "closed", state, resourceVersion: Number(updated.resource_version) });
  return true;
}
