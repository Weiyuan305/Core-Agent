import { sql, type Kysely } from "kysely";
import type { RuntimeDatabase } from "../db/database.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";
import type { JobLeaseResult } from "./jobs.js";
import { safeContractInteger } from "./resources.js";

export interface ClaimedOutboxWakeup { readonly tenantId: string; readonly outboxId: string; readonly streamId: string; readonly lastSequence: number; readonly attemptCount: number }
export interface ClaimOutboxInput { readonly workerId: string; readonly limit: number; readonly leaseMs: number }

export async function claimOutboxWakeups(db: Kysely<RuntimeDatabase>, input: ClaimOutboxInput): Promise<ClaimedOutboxWakeup[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError("limit must be bounded");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new RangeError("leaseMs must be bounded");
  return db.transaction().execute(async (trx) => {
    // @platform-worker-cross-tenant-claim reviewed Outbox dispatcher authority
    const candidates = await trx.selectFrom("outbox").innerJoin("product_events", (join) => join.onRef("product_events.tenant_id", "=", "outbox.tenant_id").onRef("product_events.event_id", "=", "outbox.event_id"))
      .innerJoin("stream_sequences", (join) => join.onRef("stream_sequences.tenant_id", "=", "product_events.tenant_id").onRef("stream_sequences.stream_id", "=", "product_events.stream_id"))
      .select(["outbox.tenant_id", "outbox.outbox_id", "product_events.stream_id", "stream_sequences.last_sequence"])
      .where("outbox.delivery_target", "=", "internal_event_stream").where("outbox.next_attempt_at", "<=", sql<Date>`now()`)
      .where("outbox.attempt_count", "<", 10)
      .where((expression) => expression.or([expression("outbox.status", "=", "pending"), expression.and([expression("outbox.status", "=", "pending"), expression("outbox.lease_expires_at", "<", sql<Date>`now()`)] )]))
      .where((expression) => expression.or([expression("outbox.lease_owner", "is", null), expression("outbox.lease_expires_at", "<", sql<Date>`now()`)]))
      .orderBy("outbox.created_at").limit(input.limit).forUpdate("outbox").skipLocked().execute();
    const rows: ClaimedOutboxWakeup[] = [];
    for (const candidate of candidates) {
      const updated = await trx.updateTable("outbox").set({ lease_owner: input.workerId, lease_expires_at: sql<Date>`now() + ${input.leaseMs} * interval '1 millisecond'`, attempt_count: sql<number>`attempt_count + 1`, updated_at: sql<Date>`now()` })
        .where("tenant_id", "=", candidate.tenant_id).where("outbox_id", "=", candidate.outbox_id).returning("attempt_count").executeTakeFirstOrThrow();
      rows.push({ tenantId: candidate.tenant_id, outboxId: candidate.outbox_id, streamId: candidate.stream_id, lastSequence: safeContractInteger(candidate.last_sequence), attemptCount: updated.attempt_count });
    }
    return rows;
  });
}

async function ownedUpdate(db: Kysely<RuntimeDatabase>, input: { tenantId: string; outboxId: string; workerId: string }, update: Record<string, unknown>): Promise<JobLeaseResult> {
  const result = await db.updateTable("outbox").set({ ...update, updated_at: sql<Date>`now()` }).where("tenant_id", "=", input.tenantId).where("outbox_id", "=", input.outboxId).where("lease_owner", "=", input.workerId).where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst();
  return Number(result.numUpdatedRows) === 1 ? { kind: "updated" } : { kind: "lease_lost" };
}
export function markOutboxDelivered(db: Kysely<RuntimeDatabase>, input: { tenantId: string; outboxId: string; workerId: string }): Promise<JobLeaseResult> {
  return ownedUpdate(db, input, { status: "delivered", delivered_at: sql<Date>`now()`, lease_owner: null, lease_expires_at: null, last_error_summary: null });
}
export function rescheduleOutbox(db: Kysely<RuntimeDatabase>, input: { tenantId: string; outboxId: string; workerId: string; nextAttemptAt: Date; lastErrorSummary: string; redactor: Redactor }): Promise<JobLeaseResult> {
  return ownedUpdate(db, input, { status: "pending", next_attempt_at: input.nextAttemptAt, lease_owner: null, lease_expires_at: null, last_error_summary: redactSummary(input.lastErrorSummary, 1000, input.redactor) });
}
export function failOutbox(db: Kysely<RuntimeDatabase>, input: { tenantId: string; outboxId: string; workerId: string; lastErrorSummary: string; redactor: Redactor }): Promise<JobLeaseResult> {
  return ownedUpdate(db, input, { status: "failed", lease_owner: null, lease_expires_at: null, last_error_summary: redactSummary(input.lastErrorSummary, 1000, input.redactor) });
}
