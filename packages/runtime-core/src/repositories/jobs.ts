import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";

interface ClaimedJobBase {
  tenantId: string;
  jobId: string;
  attemptCount: number;
  maxAttempts: number;
  payloadRef: string;
  recoveryOnly: boolean;
  leaseExpiresAt: Date;
}

export const workerJobKinds = ["provision_runtime", "reconcile_runtime", "execute_agent_run", "dispatch_outbox"] as const;
export type WorkerJobKind = (typeof workerJobKinds)[number];
export const runtimeCommandIntents = ["start", "stop", "restart", "delete"] as const;
export type RuntimeCommandIntent = (typeof runtimeCommandIntents)[number];
export const workerEffectStates = ["pre_effect", "unsafe_to_replay"] as const;
export type WorkerEffectState = (typeof workerEffectStates)[number];
export type ReconcileEffectState = WorkerEffectState;
export type AgentRunEffectState = WorkerEffectState;
export type ClaimedJob =
  | (ClaimedJobBase & { jobKind: "reconcile_runtime"; runtimeCommand: RuntimeCommandIntent; targetCommandVersion: number; effectState: ReconcileEffectState })
  | (ClaimedJobBase & { jobKind: "execute_agent_run"; runtimeCommand: null; targetCommandVersion: null; effectState: AgentRunEffectState })
  | (ClaimedJobBase & { jobKind: "provision_runtime" | "dispatch_outbox"; runtimeCommand: null; targetCommandVersion: null; effectState: "pre_effect" });

function workerEffectState(value: string): WorkerEffectState {
  if (!workerEffectStates.includes(value as WorkerEffectState)) throw new Error("Stored worker job effect state is invalid");
  return value as WorkerEffectState;
}

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

export interface PlatformWorkerClaimInput {
  workerId: string;
  limit: number;
  leaseMs: number;
  jobKinds?: readonly WorkerJobKind[];
}

export type JobLeaseResult = { kind: "updated" } | { kind: "lease_lost" };

function assertClaimInput(input: ClaimJobsInput): void {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError("limit must be 1 through 100");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new RangeError("leaseMs must be bounded");
}

function platformJobKinds(input: PlatformWorkerClaimInput): readonly WorkerJobKind[] {
  const kinds = input.jobKinds ?? workerJobKinds;
  if (kinds.length < 1 || new Set(kinds).size !== kinds.length || kinds.some((kind) => !workerJobKinds.includes(kind))) {
    throw new RangeError("jobKinds must be a non-empty unique Worker job-kind allowlist");
  }
  return kinds;
}

function isRecoveryOnly(candidate: { status: string; attempt_count: number; max_attempts: number }): boolean {
  if (candidate.attempt_count > candidate.max_attempts) throw new Error("Stored worker job attempt count exceeds its maximum");
  return candidate.status === "running" && candidate.attempt_count === candidate.max_attempts;
}

export async function claimJobs(db: Kysely<RuntimeDatabase>, input: ClaimJobsInput): Promise<ClaimedJob[]> {
  assertClaimInput(input);
  const databaseNow = sql<Date>`now()`;
  const leaseExpiresAt = sql<Date>`now() + ${input.leaseMs} * interval '1 millisecond'`;
  return db.transaction().execute(async (trx) => {
    const candidates = await trx.selectFrom("worker_jobs").select(["job_id", "status", "attempt_count", "max_attempts"])
      .where("tenant_id", "=", input.tenantId)
      .where((expression) => expression.or([
        expression.and([
          expression("status", "in", ["queued", "retrying"]),
          expression("attempt_count", "<", expression.ref("max_attempts")),
          expression("next_attempt_at", "<=", databaseNow),
        ]),
        expression.and([expression("status", "=", "running"), expression("lease_expires_at", "<", databaseNow)]),
      ]))
      .orderBy("created_at")
      .limit(input.limit)
      .forUpdate().skipLocked().execute();
    if (candidates.length === 0) return [];
    const recoveryByJobId = new Map(candidates.map((candidate) => [candidate.job_id, isRecoveryOnly(candidate)]));
    const jobIds = candidates.map((candidate) => candidate.job_id);
    const claimed = await trx.updateTable("worker_jobs").set({
      status: "running",
      attempt_count: sql<number>`case when attempt_count < max_attempts then attempt_count + 1 else attempt_count end`,
      lease_owner: input.workerId,
      lease_expires_at: leaseExpiresAt,
      updated_at: databaseNow,
    }).where("tenant_id", "=", input.tenantId).where("job_id", "in", jobIds)
      .returning(["tenant_id", "job_id", "job_kind", "attempt_count", "max_attempts", "payload_ref", "runtime_command", "target_command_version", "effect_state", "lease_expires_at"])
      .execute();
    return claimed.map((job): ClaimedJob => {
      const base: ClaimedJobBase = {
        tenantId: job.tenant_id,
        jobId: job.job_id,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        payloadRef: job.payload_ref,
        recoveryOnly: recoveryByJobId.get(job.job_id) ?? false,
        leaseExpiresAt: job.lease_expires_at!,
      };
      const effectState = workerEffectState(job.effect_state);
      if (job.job_kind === "reconcile_runtime") {
        if (job.target_command_version === null) throw new Error("Stored reconcile target command version is invalid");
        return { ...base, jobKind: "reconcile_runtime", runtimeCommand: runtimeCommandIntent(job.runtime_command), targetCommandVersion: safeTargetVersion(job.target_command_version), effectState };
      }
      if (job.runtime_command !== null) throw new Error("Stored worker job command intent is invalid");
      if (job.target_command_version !== null) throw new Error("Stored worker job target command version is invalid");
      const jobKind = nonReconcileJobKind(job.job_kind);
      if (jobKind === "execute_agent_run") return { ...base, jobKind, runtimeCommand: null, targetCommandVersion: null, effectState };
      if (effectState !== "pre_effect") throw new Error("Stored worker job effect state is invalid for job kind");
      return { ...base, jobKind, runtimeCommand: null, targetCommandVersion: null, effectState };
    });
  });
}

/** Narrow scheduler authority for the platform Worker; all returned tenant IDs
 * are read from committed rows and every later operation must restore scope. */
export async function claimPlatformWorkerJobs(
  db: Kysely<RuntimeDatabase>, input: PlatformWorkerClaimInput,
): Promise<ClaimedJob[]> {
  assertClaimInput({ ...input, tenantId: "platform_scheduler" });
  const allowedJobKinds = platformJobKinds(input);
  const databaseNow = sql<Date>`now()`;
  const leaseExpiresAt = sql<Date>`now() + ${input.leaseMs} * interval '1 millisecond'`;
  return db.transaction().execute(async (trx) => {
    // @platform-worker-cross-tenant-claim reviewed scheduler authority
    const candidates = await trx.selectFrom("worker_jobs").select(["tenant_id", "job_id", "status", "attempt_count", "max_attempts"])
      .where("job_kind", "in", allowedJobKinds)
      .where((expression) => expression.or([
        expression.and([
          expression("status", "in", ["queued", "retrying"]),
          expression("attempt_count", "<", expression.ref("max_attempts")),
          expression("next_attempt_at", "<=", databaseNow),
        ]),
        expression.and([expression("status", "=", "running"), expression("lease_expires_at", "<", databaseNow)]),
      ])).orderBy("created_at").limit(input.limit).forUpdate().skipLocked().execute();
    const claimed: ClaimedJob[] = [];
    for (const candidate of candidates) {
      const recoveryOnly = isRecoveryOnly(candidate);
      const row = await trx.updateTable("worker_jobs").set({ status: "running", attempt_count: sql<number>`case when attempt_count < max_attempts then attempt_count + 1 else attempt_count end`, lease_owner: input.workerId, lease_expires_at: leaseExpiresAt, updated_at: databaseNow })
        .where("tenant_id", "=", candidate.tenant_id).where("job_id", "=", candidate.job_id)
        .returning(["tenant_id", "job_id", "job_kind", "attempt_count", "max_attempts", "payload_ref", "runtime_command", "target_command_version", "effect_state", "lease_expires_at"]).executeTakeFirstOrThrow();
      const base: ClaimedJobBase = { tenantId: row.tenant_id, jobId: row.job_id, attemptCount: row.attempt_count, maxAttempts: row.max_attempts, payloadRef: row.payload_ref, recoveryOnly, leaseExpiresAt: row.lease_expires_at! };
      const effectState = workerEffectState(row.effect_state);
      if (row.job_kind === "reconcile_runtime") {
        if (row.target_command_version === null) throw new Error("Stored reconcile target command version is invalid");
        claimed.push({ ...base, jobKind: "reconcile_runtime", runtimeCommand: runtimeCommandIntent(row.runtime_command), targetCommandVersion: safeTargetVersion(row.target_command_version), effectState });
      }
      else {
        if (row.runtime_command !== null) throw new Error("Stored worker job command intent is invalid");
        if (row.target_command_version !== null) throw new Error("Stored worker job target command version is invalid");
        const jobKind = nonReconcileJobKind(row.job_kind);
        if (jobKind === "execute_agent_run") claimed.push({ ...base, jobKind, runtimeCommand: null, targetCommandVersion: null, effectState });
        else {
          if (effectState !== "pre_effect") throw new Error("Stored worker job effect state is invalid for job kind");
          claimed.push({ ...base, jobKind, runtimeCommand: null, targetCommandVersion: null, effectState });
        }
      }
    }
    return claimed;
  });
}

function safeTargetVersion(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Stored reconcile target command version is invalid");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Stored reconcile target command version is invalid");
  return number;
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
