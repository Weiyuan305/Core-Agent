import type { Transaction } from "kysely";
import { sql } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { enqueueOutbox } from "../events.js";

export async function lockCapabilityVersion(trx: Transaction<RuntimeDatabase>, capabilityVersionId: string) {
  return trx.selectFrom("capability_versions").selectAll().where("capability_version_id", "=", capabilityVersionId).forUpdate().executeTakeFirst();
}
export async function lockPackVersion(trx: Transaction<RuntimeDatabase>, packVersionId: string) {
  return trx.selectFrom("pack_versions").selectAll().where("pack_version_id", "=", packVersionId).forUpdate().executeTakeFirst();
}
export async function lockPackMembersAndCapabilities(trx: Transaction<RuntimeDatabase>, packVersionId: string) {
  const members = await trx.selectFrom("pack_members").selectAll().where("pack_version_id", "=", packVersionId)
    .orderBy("capability_version_id", "asc").orderBy("capability_id", "asc").orderBy("version", "asc").forUpdate().execute();
  const identifiers = [...new Set(members.map((member) => member.capability_version_id))].sort();
  const capabilities = identifiers.length === 0 ? [] : await trx.selectFrom("capability_versions").selectAll()
    .where("capability_version_id", "in", identifiers).orderBy("capability_version_id", "asc").forUpdate().execute();
  return { members, capabilities };
}

/** Writes the safe extensible catalog lifecycle envelope and its transactional outbox wakeup. */
export async function appendCatalogLifecycleEvent(
  trx: Transaction<RuntimeDatabase>,
  input: { tenantId: string; eventId: string; streamId: string; eventType: string; resourceType: string; resourceId: string; resourceVersion: number; requestId: string; traceId: string; occurredAt: Date },
): Promise<void> {
  const allocation = await trx.insertInto("stream_sequences").values({ tenant_id: input.tenantId, stream_id: input.streamId, last_sequence: 1 }).onConflict((conflict) => conflict.columns(["tenant_id", "stream_id"]).doUpdateSet({ last_sequence: sql`stream_sequences.last_sequence + 1` })).returning("last_sequence").executeTakeFirstOrThrow();
  const sequence = Number(allocation.last_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Stored catalog stream sequence is invalid");
  const lifecycleState = input.eventType.endsWith(".created") ? "draft" : input.eventType.split(".").at(-1);
  const payload = Object.freeze({ resource_type: input.resourceType, resource_id: input.resourceId, status: lifecycleState, resource_version: input.resourceVersion });
  const event = Object.freeze({ schema_version: 1, event_id: input.eventId, occurred_at: input.occurredAt.toISOString(), sequence, tenant_id: input.tenantId, request_id: input.requestId, trace_id: input.traceId, correlation_id: input.eventId, causation_id: input.eventId, event_type: input.eventType, payload });
  await trx.insertInto("product_events").values({ tenant_id: input.tenantId, event_id: input.eventId, stream_id: input.streamId, schema_version: 1, sequence, event_type: input.eventType, occurred_at: input.occurredAt, request_id: input.requestId, trace_id: input.traceId, correlation_id: input.eventId, causation_id: input.eventId, profile_id: null, conversation_id: null, run_id: null, task_id: null, approval_id: null, student_ref: null, case_ref: null, capability_id: null, payload, }).execute();
  await enqueueOutbox({ tenantId: input.tenantId, trx }, { outboxId: `outbox_${input.eventId}`, eventId: input.eventId, deliveryTarget: "internal_event_stream", now: input.occurredAt });
}
