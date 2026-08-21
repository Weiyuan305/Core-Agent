import type { Transaction } from "kysely";
import { Buffer } from "node:buffer";

import type { RuntimeDatabase } from "../../db/database.js";
import { appendProductEvents, type ProductEventWithoutSequence } from "../events.js";

export async function lockCapabilityVersion(trx: Transaction<RuntimeDatabase>, capabilityVersionId: string) {
  return trx.selectFrom("capability_versions").selectAll().where("capability_version_id", "=", capabilityVersionId).forUpdate().executeTakeFirst();
}
function compareUtf8(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
/** Acquires Capability Version row locks one-by-one in exact UTF-8 byte order. */
export async function lockCapabilityVersions(trx: Transaction<RuntimeDatabase>, capabilityVersionIds: readonly string[]) {
  const locked = [];
  for (const capabilityVersionId of [...new Set(capabilityVersionIds)].sort(compareUtf8)) {
    const row = await lockCapabilityVersion(trx, capabilityVersionId);
    if (row !== undefined) locked.push(row);
  }
  return locked;
}
export async function lockPackVersion(trx: Transaction<RuntimeDatabase>, packVersionId: string) {
  return trx.selectFrom("pack_versions").selectAll().where("pack_version_id", "=", packVersionId).forUpdate().executeTakeFirst();
}
export async function lockPackMembersAndCapabilities(trx: Transaction<RuntimeDatabase>, packVersionId: string) {
  const members = await trx.selectFrom("pack_members").selectAll().where("pack_version_id", "=", packVersionId)
    .orderBy("capability_version_id", "asc").orderBy("capability_id", "asc").orderBy("version", "asc").forUpdate().execute();
  const identifiers = members.map((member) => member.capability_version_id);
  const capabilities = await lockCapabilityVersions(trx, identifiers);
  return { members, capabilities };
}

/** Writes one closed catalog lifecycle ProductEvent and transactional outbox wakeup. */
export async function appendCatalogLifecycleEvent(
  trx: Transaction<RuntimeDatabase>,
  input: { tenantId: string; eventId: string; streamId: string; eventType: string; resourceType: string; resourceId: string; resourceVersion: number; requestId: string; traceId: string; occurredAt: Date; capabilityId?: string; packProductId?: string },
): Promise<void> {
  const status = input.eventType.endsWith(".created") ? "draft" : input.eventType.split(".").at(-1);
  const payload = input.capabilityId === undefined
    ? { pack_version_id: input.resourceId, pack_product_id: input.packProductId!, status, resource_version: input.resourceVersion }
    : { capability_version_id: input.resourceId, capability_id: input.capabilityId, status, resource_version: input.resourceVersion };
  const event: ProductEventWithoutSequence = {
    schema_version: 1,
    event_id: input.eventId,
    occurred_at: input.occurredAt.toISOString(),
    tenant_id: input.tenantId,
    request_id: input.requestId,
    trace_id: input.traceId,
    correlation_id: input.eventId,
    causation_id: input.eventId,
    event_type: input.eventType,
    payload,
  } as ProductEventWithoutSequence;
  await appendProductEvents(
    { tenantId: input.tenantId, trx },
    { streamId: input.streamId, deliveryTarget: "internal_event_stream", events: [event] },
  );
}
