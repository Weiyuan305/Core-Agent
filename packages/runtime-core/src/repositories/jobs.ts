import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";
import { agentRunConversationLockKey } from "./agent-run-conversation-lock.js";

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
    const nonExecuteKinds = allowedJobKinds.filter((kind) => kind !== "execute_agent_run");
    const nonExecuteCandidates = nonExecuteKinds.length === 0 ? [] : await (
      // @platform-worker-cross-tenant-claim reviewed scheduler authority
      trx.selectFrom("worker_jobs").select(["tenant_id", "job_id", "status", "attempt_count", "max_attempts", "created_at"])
        .where("job_kind", "in", nonExecuteKinds)
        .where((expression) => expression.or([
          expression.and([
            expression("status", "in", ["queued", "retrying"]),
            expression("attempt_count", "<", expression.ref("max_attempts")),
            expression("next_attempt_at", "<=", databaseNow),
          ]),
          expression.and([expression("status", "=", "running"), expression("lease_expires_at", "<", databaseNow)]),
        ])).orderBy("created_at").limit(input.limit).forUpdate().skipLocked().execute()
    );
    const executeDiscoveryLimit = Math.min(100, input.limit * 4);
    const executeCandidates = !allowedJobKinds.includes("execute_agent_run") ? [] : await (
      // @platform-worker-cross-tenant-claim reviewed scheduler authority
      trx.with((cte) => cte("active_execute_conversations").materialized(), (database) =>
        // @platform-worker-cross-tenant-claim reviewed scheduler authority
        database.selectFrom("worker_jobs as active_jobs")
          .innerJoin("agent_runs as active_runs", (join) => join
            .onRef("active_runs.tenant_id", "=", "active_jobs.tenant_id")
            .onRef("active_runs.run_id", "=", "active_jobs.run_id"))
          .select(["active_jobs.tenant_id", "active_runs.conversation_id"])
          .where("active_jobs.job_kind", "=", "execute_agent_run")
          .where("active_jobs.status", "=", "running")
          .where("active_jobs.lease_expires_at", ">", databaseNow)
          .distinct()
      )
        // @platform-worker-cross-tenant-claim reviewed scheduler authority
        .selectFrom("worker_jobs as jobs")
        .innerJoin("agent_runs as runs", (join) => join
          .onRef("runs.tenant_id", "=", "jobs.tenant_id")
          .onRef("runs.run_id", "=", "jobs.run_id"))
        .leftJoin("active_execute_conversations as active_conversations", (join) => join
          .onRef("active_conversations.tenant_id", "=", "jobs.tenant_id")
          .onRef("active_conversations.conversation_id", "=", "runs.conversation_id"))
        .select([
          "jobs.tenant_id", "runs.conversation_id",
          sql<Date>`min(${sql.ref("jobs.created_at")})`.as("oldest_created_at"),
        ])
        .where("jobs.job_kind", "=", "execute_agent_run")
        .where((expression) => expression.or([
          expression.and([
            expression("jobs.status", "in", ["queued", "retrying"]),
            expression("jobs.attempt_count", "<", expression.ref("jobs.max_attempts")),
            expression("jobs.next_attempt_at", "<=", databaseNow),
          ]),
          expression.and([expression("jobs.status", "=", "running"), expression("jobs.lease_expires_at", "<", databaseNow)]),
        ]))
        .where("active_conversations.tenant_id", "is", null)
        .groupBy(["jobs.tenant_id", "runs.conversation_id"])
        .orderBy("oldest_created_at")
        .orderBy("jobs.tenant_id")
        .orderBy("runs.conversation_id")
        .limit(executeDiscoveryLimit)
        .execute()
    );
    const candidates = [
      ...nonExecuteCandidates.map((candidate) => ({ ...candidate, conversation_id: null })),
      ...executeCandidates.map((candidate) => ({
        tenant_id: candidate.tenant_id,
        conversation_id: candidate.conversation_id,
        created_at: candidate.oldest_created_at,
        job_id: candidate.conversation_id,
        status: "conversation_candidate",
        attempt_count: 0,
        max_attempts: 0,
      })),
    ].sort((left, right) => left.created_at.getTime() - right.created_at.getTime() || left.job_id.localeCompare(right.job_id));
    const claimed: ClaimedJob[] = [];
    const seenConversations = new Set<string>();
    for (const candidate of candidates) {
      if (claimed.length >= input.limit) break;
      let selected: {
        tenant_id: string; job_id: string; status: string; attempt_count: number; max_attempts: number;
      } | undefined = candidate.conversation_id === null ? candidate : undefined;
      if (candidate.conversation_id !== null) {
        const conversationKey = agentRunConversationLockKey(candidate.tenant_id, candidate.conversation_id);
        if (seenConversations.has(conversationKey)) continue;
        seenConversations.add(conversationKey);
        const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${conversationKey}, 0)) as acquired`.execute(trx);
        if (lock.rows[0]?.acquired !== true) continue;
        const earliest = await trx.selectFrom("worker_jobs as jobs")
          .innerJoin("agent_runs as runs", (join) => join
            .onRef("runs.tenant_id", "=", "jobs.tenant_id")
            .onRef("runs.run_id", "=", "jobs.run_id"))
          .select("jobs.job_id")
          .where("jobs.tenant_id", "=", candidate.tenant_id)
          .where("runs.conversation_id", "=", candidate.conversation_id)
          .where("jobs.job_kind", "=", "execute_agent_run")
          .where((expression) => expression.or([
            expression.and([
              expression("jobs.status", "in", ["queued", "retrying"]),
              expression("jobs.attempt_count", "<", expression.ref("jobs.max_attempts")),
              expression("jobs.next_attempt_at", "<=", databaseNow),
            ]),
            expression.and([expression("jobs.status", "=", "running"), expression("jobs.lease_expires_at", "<", databaseNow)]),
          ]))
          .orderBy("jobs.created_at")
          .orderBy("jobs.job_id")
          .limit(1)
          .executeTakeFirst();
        if (earliest === undefined) continue;
        const locked = await trx.selectFrom("worker_jobs")
          .select(["tenant_id", "job_id", "status", "attempt_count", "max_attempts"])
          .where("tenant_id", "=", candidate.tenant_id)
          .where("job_id", "=", earliest.job_id)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (locked === undefined) continue;
        const eligible = await trx.selectFrom("worker_jobs")
          .select("job_id")
          .where("tenant_id", "=", candidate.tenant_id)
          .where("job_id", "=", locked.job_id)
          .where("job_kind", "=", "execute_agent_run")
          .where((expression) => expression.or([
            expression.and([
              expression("status", "in", ["queued", "retrying"]),
              expression("attempt_count", "<", expression.ref("max_attempts")),
              expression("next_attempt_at", "<=", databaseNow),
            ]),
            expression.and([expression("status", "=", "running"), expression("lease_expires_at", "<", databaseNow)]),
          ]))
          .executeTakeFirst();
        if (eligible === undefined) continue;
        const active = await trx.selectFrom("worker_jobs as active_jobs")
          .innerJoin("agent_runs as active_runs", (join) => join
            .onRef("active_runs.tenant_id", "=", "active_jobs.tenant_id")
            .onRef("active_runs.run_id", "=", "active_jobs.run_id"))
          .select("active_jobs.job_id")
          .where("active_jobs.tenant_id", "=", candidate.tenant_id)
          .where("active_runs.conversation_id", "=", candidate.conversation_id)
          .where("active_jobs.job_kind", "=", "execute_agent_run")
          .where("active_jobs.status", "=", "running")
          .where("active_jobs.lease_expires_at", ">", databaseNow)
          .limit(1)
          .executeTakeFirst();
        if (active !== undefined) continue;
        selected = locked;
      }
      if (selected === undefined) continue;
      const recoveryOnly = isRecoveryOnly(selected);
      const row = await trx.updateTable("worker_jobs").set({ status: "running", attempt_count: sql<number>`case when attempt_count < max_attempts then attempt_count + 1 else attempt_count end`, lease_owner: input.workerId, lease_expires_at: leaseExpiresAt, updated_at: databaseNow })
        .where("tenant_id", "=", selected.tenant_id).where("job_id", "=", selected.job_id)
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
