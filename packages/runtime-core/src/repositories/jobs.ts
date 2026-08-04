import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { redactSummary } from "../domain/redaction.js";

export interface ClaimedJob {
  tenantId: string;
  jobId: string;
  jobKind: string;
  attemptCount: number;
  maxAttempts: number;
  payloadRef: string;
  effectState: string;
  leaseExpiresAt: Date;
}

export interface ClaimJobsInput {
  tenantId: string;
  workerId: string;
  limit: number;
  leaseMs: number;
  now?: Date;
}

export type JobLeaseResult = { kind: "updated" } | { kind: "lease_lost" };

function assertClaimInput(input: ClaimJobsInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError("limit must be 1 through 100");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new RangeError("leaseMs must be bounded");
}

export async function claimJobs(db: Kysely<RuntimeDatabase>, input: ClaimJobsInput): Promise<ClaimedJob[]> {
  assertClaimInput(input);
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
  return db.transaction().execute(async (trx) => {
    const candidates = await trx.selectFrom("worker_jobs").select("job_id")
      .where("tenant_id", "=", input.tenantId)
      .where("next_attempt_at", "<=", now)
      .whereRef("attempt_count", "<", "max_attempts")
      .where((expression) => expression.or([
        expression("status", "in", ["queued", "retrying"]),
        expression.and([expression("status", "=", "running"), expression("lease_expires_at", "<", now)]),
      ]))
      .orderBy("created_at")
      .limit(input.limit)
      .forUpdate().skipLocked().execute();
    if (candidates.length === 0) return [];
    const jobIds = candidates.map((candidate) => candidate.job_id);
    const claimed = await trx.updateTable("worker_jobs").set({
      status: "running",
      attempt_count: sql<number>`attempt_count + 1`,
      lease_owner: input.workerId,
      lease_expires_at: leaseExpiresAt,
      updated_at: now,
    }).where("tenant_id", "=", input.tenantId).where("job_id", "in", jobIds)
      .returning(["tenant_id", "job_id", "job_kind", "attempt_count", "max_attempts", "payload_ref", "effect_state", "lease_expires_at"])
      .execute();
    return claimed.map((job) => ({
      tenantId: job.tenant_id,
      jobId: job.job_id,
      jobKind: job.job_kind,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      payloadRef: job.payload_ref,
      effectState: job.effect_state,
      leaseExpiresAt: job.lease_expires_at!,
    }));
  });
}

async function updateOwnedLease(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; now?: Date },
  update: Record<string, unknown>,
): Promise<JobLeaseResult> {
  const now = input.now ?? new Date();
  const result = await db.updateTable("worker_jobs").set({ ...update, updated_at: now })
    .where("tenant_id", "=", input.tenantId).where("job_id", "=", input.jobId)
    .where("lease_owner", "=", input.workerId).where("lease_expires_at", ">", now)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1 ? { kind: "updated" } : { kind: "lease_lost" };
}

export async function heartbeatJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; leaseMs: number; now?: Date },
): Promise<JobLeaseResult> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new RangeError("leaseMs must be bounded");
  const now = input.now ?? new Date();
  return updateOwnedLease(db, { ...input, now }, { lease_expires_at: new Date(now.getTime() + input.leaseMs) });
}

export async function completeJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; now?: Date },
): Promise<JobLeaseResult> {
  return updateOwnedLease(db, input, { status: "succeeded", lease_owner: null, lease_expires_at: null });
}

export async function rescheduleJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; nextAttemptAt: Date; lastErrorSummary: string; now?: Date },
): Promise<JobLeaseResult> {
  return updateOwnedLease(db, input, {
    status: "retrying", lease_owner: null, lease_expires_at: null,
    next_attempt_at: input.nextAttemptAt, last_error_summary: redactSummary(input.lastErrorSummary, 1000),
  });
}

export async function failJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; lastErrorSummary: string; now?: Date },
): Promise<JobLeaseResult> {
  return updateOwnedLease(db, input, {
    status: "failed", lease_owner: null, lease_expires_at: null,
    last_error_summary: redactSummary(input.lastErrorSummary, 1000),
  });
}
