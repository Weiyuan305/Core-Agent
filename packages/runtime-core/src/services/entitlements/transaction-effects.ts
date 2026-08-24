import { createHash } from "node:crypto";

import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { appendAuditEvent, appendProductEvents, type ProductEventWithoutSequence } from "../../repositories/events.js";
import type { EntitlementCommandContext, PlatformEntitlementAuthority } from "./authority.js";

function derivedId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32)}`;
}

export interface EntitlementLifecycleEffect {
  readonly tenantId: string;
  readonly resourceType: "tenant_pack_release" | "entitlement" | "assignment";
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly eventType?: string;
  readonly eventPayload?: Record<string, unknown>;
  readonly profileId?: string;
  readonly reconcilePayloadRef?: string;
  readonly now: Date;
}

/** Appends the complete authority mutation evidence graph in the caller-owned transaction. */
export async function appendEntitlementLifecycleEffects(
  trx: Transaction<RuntimeDatabase>,
  authority: PlatformEntitlementAuthority,
  context: EntitlementCommandContext,
  effect: EntitlementLifecycleEffect,
): Promise<void> {
  await trx.insertInto("platform_authority_audit").values({
    platform_authority_audit_id: derivedId("platform_audit", effect.idempotencyKey, effect.operation),
    authority_tenant_id: authority.authorityTenantId,
    actor_id: context.performingActorId,
    membership_id: authority.membershipId,
    action: effect.operation,
    decision: "allowed",
    outcome: "succeeded",
    resource_type: effect.resourceType,
    resource_id: effect.resourceId,
    resource_version: effect.resourceVersion,
    request_id: context.requestId,
    trace_id: context.traceId,
    reason_summary: "Applied a versioned platform entitlement authority change",
    change_summary: null,
    occurred_at: effect.now,
  }).execute();

  await appendAuditEvent({ tenantId: authority.authorityTenantId, trx }, {
    schema_version: 1,
    audit_event_id: derivedId("audit_entitlement", effect.idempotencyKey, effect.operation),
    occurred_at: effect.now.toISOString(),
    tenant_id: authority.authorityTenantId,
    actor_id: context.performingActorId,
    membership_id: authority.membershipId,
    effective_role: "admin",
    action: effect.operation,
    resource_type: effect.resourceType,
    resource_id: effect.resourceId,
    decision: "allowed",
    outcome: "succeeded",
    request_id: context.requestId,
    trace_id: context.traceId,
    reason_summary: "Applied a versioned platform entitlement authority change",
    resource_version: effect.resourceVersion,
  });

  if (effect.eventType !== undefined && effect.eventPayload !== undefined) {
    const eventId = derivedId("event_entitlement", effect.idempotencyKey, effect.operation);
    const event = {
      schema_version: 1,
      event_id: eventId,
      occurred_at: effect.now.toISOString(),
      tenant_id: effect.tenantId,
      request_id: context.requestId,
      trace_id: context.traceId,
      correlation_id: derivedId("correlation_entitlement", effect.idempotencyKey),
      causation_id: derivedId("causation_entitlement", effect.idempotencyKey),
      ...(effect.profileId === undefined ? {} : { profile_id: effect.profileId }),
      event_type: effect.eventType,
      payload: effect.eventPayload,
    } as unknown as ProductEventWithoutSequence;
    await appendProductEvents(
      { tenantId: effect.tenantId, trx },
      { streamId: effect.resourceId, deliveryTarget: "internal_event_stream", events: [event] },
    );
  }

  if (effect.reconcilePayloadRef !== undefined) {
    const jobId = derivedId("job_entitlement", effect.idempotencyKey, effect.operation);
    await trx.insertInto("worker_jobs").values({
      tenant_id: effect.tenantId,
      job_id: jobId,
      job_kind: "reconcile_capability_projection",
      status: "queued",
      attempt_count: 0,
      max_attempts: 5,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: effect.now,
      payload_ref: effect.reconcilePayloadRef,
      runtime_command: null,
      target_command_version: null,
      effect_state: "pre_effect",
      last_error_summary: null,
      run_id: null,
      container_id: null,
      created_at: effect.now,
      updated_at: effect.now,
    }).onConflict((conflict) => conflict.columns(["tenant_id", "job_id"]).doNothing()).execute();
  }
}
