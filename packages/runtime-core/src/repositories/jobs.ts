import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";

interface ClaimedJobBase {
  tenantId: string;
  jobId: string;
  attemptCount: number;
  maxAttempts: number;
  payloadRef: string;
  effectState: string;
  leaseExpiresAt: Date;
}

export const workerJobKinds = ["provision_runtime", "reconcile_runtime", "execute_agent_run", "dispatch_outbox"] as const;
export type WorkerJobKind = (typeof workerJobKinds)[number];
export const runtimeCommandIntents = ["start", "stop", "restart", "delete"] as const;
export type RuntimeCommandIntent = (typeof runtimeCommandIntents)[number];
export type ClaimedJob =
  | (ClaimedJobBase & { jobKind: "reconcile_runtime"; runtimeCommand: RuntimeCommandIntent })
  | (ClaimedJobBase & { jobKind: Exclude<WorkerJobKind, "reconcile_runtime">; runtimeCommand: null });

function runtimeCommandIntent(value: string | null): RuntimeCommandIntent {
  if (value === null) throw new Error("Stored worker job command intent is invalid");
  if (!runtimeCommandIntents.includes(value as RuntimeCommandIntent)) throw new Error("Stored runtime command intent is invalid");
  return value as RuntimeCommandIntent;
}

function nonReconcileJobKind(value: string): Exclude<WorkerJobKind, "reconcile_runtime"> {
  if (value === "provision_runtime" || value === "execute_agent_run" || value === "dispatch_outbox") return value;
  throw new Error("Stored worker job kind is invalid");
}

export interface ClaimJobsInput {
  tenantId: string;
  workerId: string;
  limit: number;
  leaseMs: number;
}

export type JobLeaseResult = { kind: "updated" } | { kind: "lease_lost" };

function assertClaimInput(input: ClaimJobsInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError("limit must be 1 through 100");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new RangeError("leaseMs must be bounded");
}

export async function claimJobs(db: Kysely<RuntimeDatabase>, input: ClaimJobsInput): Promise<ClaimedJob[]> {
  assertClaimInput(input);
  const databaseNow = sql<Date>`now()`;
  const leaseExpiresAt = sql<Date>`now() + ${input.leaseMs} * interval '1 millisecond'`;
  return db.transaction().execute(async (trx) => {
    const candidates = await trx.selectFrom("worker_jobs").select("job_id")
      .where("tenant_id", "=", input.tenantId)
      .where("next_attempt_at", "<=", databaseNow)
      .whereRef("attempt_count", "<", "max_attempts")
      .where((expression) => expression.or([
        expression("status", "in", ["queued", "retrying"]),
        expression.and([expression("status", "=", "running"), expression("lease_expires_at", "<", databaseNow)]),
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
      updated_at: databaseNow,
    }).where("tenant_id", "=", input.tenantId).where("job_id", "in", jobIds)
      .returning(["tenant_id", "job_id", "job_kind", "attempt_count", "max_attempts", "payload_ref", "runtime_command", "effect_state", "lease_expires_at"])
      .execute();
    return claimed.map((job): ClaimedJob => {
      const base: ClaimedJobBase = {
        tenantId: job.tenant_id,
        jobId: job.job_id,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        payloadRef: job.payload_ref,
        effectState: job.effect_state,
        leaseExpiresAt: job.lease_expires_at!,
      };
      if (job.job_kind === "reconcile_runtime") {
        return { ...base, jobKind: "reconcile_runtime", runtimeCommand: runtimeCommandIntent(job.runtime_command) };
      }
      if (job.runtime_command !== null) throw new Error("Stored worker job command intent is invalid");
      return { ...base, jobKind: nonReconcileJobKind(job.job_kind), runtimeCommand: null };
    });
  });
}

async function updateOwnedLease(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string },
  update: Record<string, unknown>,
): Promise<JobLeaseResult> {
  const databaseNow = sql<Date>`now()`;
  const result = await db.updateTable("worker_jobs").set({ ...update, updated_at: databaseNow })
    .where("tenant_id", "=", input.tenantId).where("job_id", "=", input.jobId)
    .where("lease_owner", "=", input.workerId).where("lease_expires_at", ">", databaseNow)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1 ? { kind: "updated" } : { kind: "lease_lost" };
}

export async function heartbeatJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; leaseMs: number },
): Promise<JobLeaseResult> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new RangeError("leaseMs must be bounded");
  return updateOwnedLease(db, input, {
    lease_expires_at: sql<Date>`now() + ${input.leaseMs} * interval '1 millisecond'`,
  });
}

export async function completeJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string },
): Promise<JobLeaseResult> {
  return updateOwnedLease(db, input, { status: "succeeded", lease_owner: null, lease_expires_at: null });
}

export async function rescheduleJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; nextAttemptAt: Date; lastErrorSummary: string; redactor: Redactor },
): Promise<JobLeaseResult> {
  return updateOwnedLease(db, input, {
    status: "retrying", lease_owner: null, lease_expires_at: null,
    next_attempt_at: input.nextAttemptAt, last_error_summary: redactSummary(input.lastErrorSummary, 1000, input.redactor),
  });
}

export async function failJob(
  db: Kysely<RuntimeDatabase>,
  input: { tenantId: string; jobId: string; workerId: string; lastErrorSummary: string; redactor: Redactor },
): Promise<JobLeaseResult> {
  return updateOwnedLease(db, input, {
    status: "failed", lease_owner: null, lease_expires_at: null,
    last_error_summary: redactSummary(input.lastErrorSummary, 1000, input.redactor),
  });
}
