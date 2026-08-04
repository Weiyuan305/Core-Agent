import { type AuditEvent, type ProductEvent } from "@core-agent/contracts";
import { sql } from "kysely";

import type { TenantTransaction } from "../db/transaction.js";
import { DomainError } from "../domain/idempotency.js";
import { validateAuditEvent, validateProductEvent } from "../domain/events.js";
import { safeContractInteger } from "./resources.js";

export interface AppendProductEventsInput {
  streamId: string;
  deliveryTarget: "internal_event_stream" | "webhook";
  events: readonly Omit<ProductEvent, "sequence">[];
}

export async function enqueueOutbox(
  context: TenantTransaction,
  input: { outboxId: string; eventId: string; deliveryTarget: "internal_event_stream" | "webhook"; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await context.trx.insertInto("outbox").values({
    tenant_id: context.tenantId,
    outbox_id: input.outboxId,
    event_id: input.eventId,
    delivery_target: input.deliveryTarget,
    status: "pending",
    attempt_count: 0,
    next_attempt_at: now,
    delivered_at: null,
    created_at: now,
    updated_at: now,
  }).execute();
}

export async function appendProductEvents(
  context: TenantTransaction,
  input: AppendProductEventsInput,
): Promise<ProductEvent[]> {
  const appended: ProductEvent[] = [];
  for (const partial of input.events) {
    if (partial.tenant_id !== context.tenantId) throw new DomainError("INVALID_REQUEST", "ProductEvent tenant does not match transaction scope");
    const allocation = await context.trx.insertInto("stream_sequences").values({
      tenant_id: context.tenantId,
      stream_id: input.streamId,
      last_sequence: 1,
    }).onConflict((conflict) => conflict.columns(["tenant_id", "stream_id"]).doUpdateSet({
      last_sequence: sql`stream_sequences.last_sequence + 1`,
    })).returning("last_sequence").executeTakeFirstOrThrow();
    const event = { ...partial, sequence: safeContractInteger(allocation.last_sequence) } as ProductEvent;
    validateProductEvent(event, context.tenantId);
    await context.trx.insertInto("product_events").values({
      tenant_id: event.tenant_id,
      event_id: event.event_id,
      stream_id: input.streamId,
      schema_version: event.schema_version,
      sequence: event.sequence,
      event_type: event.event_type,
      occurred_at: new Date(event.occurred_at),
      request_id: event.request_id,
      trace_id: event.trace_id,
      correlation_id: event.correlation_id,
      causation_id: event.causation_id,
      profile_id: event.profile_id ?? null,
      conversation_id: event.conversation_id ?? null,
      run_id: event.run_id ?? null,
      task_id: event.task_id ?? null,
      approval_id: event.approval_id ?? null,
      student_ref: event.student_ref ?? null,
      case_ref: event.case_ref ?? null,
      capability_id: event.capability_id ?? null,
      payload: event.payload,
    }).execute();
    await enqueueOutbox(context, {
      outboxId: `outbox_${event.event_id}`,
      eventId: event.event_id,
      deliveryTarget: input.deliveryTarget,
    });
    appended.push(event);
  }
  return appended;
}

export async function appendAuditEvent(context: TenantTransaction, event: AuditEvent): Promise<void> {
  validateAuditEvent(event, context.tenantId);
  await context.trx.insertInto("audit_events").values({
    tenant_id: event.tenant_id,
    audit_event_id: event.audit_event_id,
    schema_version: event.schema_version,
    occurred_at: new Date(event.occurred_at),
    actor_id: event.actor_id,
    membership_id: event.membership_id,
    effective_role: event.effective_role,
    action: event.action,
    resource_type: event.resource_type,
    resource_id: event.resource_id,
    decision: event.decision,
    outcome: event.outcome,
    request_id: event.request_id,
    trace_id: event.trace_id,
    reason_summary: event.reason_summary,
    delegation_id: event.delegation_id ?? null,
    delegation_reason: event.delegation_reason ?? null,
    run_id: event.run_id ?? null,
    task_id: event.task_id ?? null,
    approval_id: event.approval_id ?? null,
    policy_version: event.policy_version ?? null,
    entitlement_snapshot_ref: event.entitlement_snapshot_ref ?? null,
    consent_snapshot_ref: event.consent_snapshot_ref ?? null,
    change_summary: event.change_summary ?? null,
    resource_version: event.resource_version ?? null,
    event_json: event,
  }).execute();
}
