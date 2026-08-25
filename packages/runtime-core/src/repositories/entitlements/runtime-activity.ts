import { createHash } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { acquireRuntimeTransactionAdvisoryLock } from "../runtime-lock.js";
import { safeContractInteger } from "../resources.js";

const idleInterval = sql`interval '30 minutes'`;
type RuntimeCommand = "start" | "stop";

function lifecycleJobId(prefix: string, tenantId: string, generation: number): string {
  const digest = createHash("sha256")
    .update(`${tenantId}:${generation}:${prefix}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `job_${prefix}_${digest}`;
}

async function queueReusableJob(
  trx: Transaction<RuntimeDatabase>,
  input: {
    tenantId: string;
    jobId: string;
    jobKind: "reconcile_runtime" | "stop_idle_b2c_runtime";
    payloadRef: string;
    runtimeCommand: RuntimeCommand | null;
    targetCommandVersion: number | null;
    containerId: string | null;
  },
): Promise<boolean> {
  const existing = await trx.selectFrom("worker_jobs")
    .select("status")
    .where("tenant_id", "=", input.tenantId)
    .where("job_id", "=", input.jobId)
    .forUpdate()
    .executeTakeFirst();
  if (existing !== undefined && ["queued", "running", "retrying"].includes(existing.status)) return false;
  const values = {
    job_kind: input.jobKind,
    status: "queued",
    attempt_count: 0,
    max_attempts: 5,
    lease_owner: null,
    lease_expires_at: null,
    next_attempt_at: sql<Date>`clock_timestamp()`,
    payload_ref: input.payloadRef,
    runtime_command: input.runtimeCommand,
    target_command_version: input.targetCommandVersion,
    effect_state: "pre_effect",
    last_error_summary: null,
    run_id: null,
    container_id: input.containerId,
    updated_at: sql<Date>`clock_timestamp()`,
  } as const;
  if (existing === undefined) {
    await trx.insertInto("worker_jobs").values({
      tenant_id: input.tenantId,
      job_id: input.jobId,
      ...values,
      created_at: sql<Date>`clock_timestamp()`,
    }).execute();
  } else {
    await trx.updateTable("worker_jobs").set(values)
      .where("tenant_id", "=", input.tenantId)
      .where("job_id", "=", input.jobId)
      .executeTakeFirstOrThrow();
  }
  return true;
}

export async function queueRuntimeLifecycleCommand(
  trx: Transaction<RuntimeDatabase>,
  input: {
    tenantId: string;
    runtimeId: string;
    generation: number;
    command: RuntimeCommand;
    targetCommandVersion: number;
  },
): Promise<boolean> {
  return queueReusableJob(trx, {
    tenantId: input.tenantId,
    jobId: lifecycleJobId(`lifecycle_${input.command}`, input.tenantId, input.generation),
    jobKind: "reconcile_runtime",
    payloadRef: input.runtimeId,
    runtimeCommand: input.command,
    targetCommandVersion: input.targetCommandVersion,
    containerId: input.runtimeId,
  });
}

export async function touchRuntimeActivity(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
): Promise<void> {
  const runtime = await trx.selectFrom("runtime_containers")
    .select("generation")
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();
  if (runtime === undefined) return;
  await trx.insertInto("runtime_activity").values({
    tenant_id: tenantId,
    runtime_generation: runtime.generation,
    last_work_at: sql<Date>`clock_timestamp()`,
    active_conversation_count: 0,
    active_run_count: 0,
    resource_version: 1,
  }).onConflict((conflict) => conflict
    .columns(["tenant_id", "runtime_generation"])
    .doUpdateSet({
      last_work_at: sql<Date>`clock_timestamp()`,
      resource_version: sql`runtime_activity.resource_version + 1`,
      updated_at: sql<Date>`clock_timestamp()`,
    }))
    .execute();
}

export async function enqueueIdleB2cRuntimeStopJobs(
  db: Kysely<RuntimeDatabase>,
  limit: number,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be 1 through 100");
  return withDatabaseTransactionRetry(db, async (trx) => {
    await sql`
      insert into runtime_activity (
        tenant_id, runtime_generation, last_work_at, active_conversation_count,
        active_run_count, resource_version, created_at, updated_at
      )
      select runtime.tenant_id, runtime.generation, runtime.updated_at, 0, 0, 1,
        clock_timestamp(), clock_timestamp()
      from runtime_containers as runtime
      join tenants as tenant on tenant.tenant_id = runtime.tenant_id
      where tenant.tenant_mode = 'b2c'
        and tenant.status = 'active'
        and runtime.desired_state = 'running'
        and not exists (
          select 1 from runtime_activity as existing
          where existing.tenant_id = runtime.tenant_id
            and existing.runtime_generation = runtime.generation
        )
      order by runtime.updated_at, runtime.tenant_id, runtime.generation
      limit ${limit}
      on conflict (tenant_id, runtime_generation) do nothing
    `.execute(trx);
    const candidates = await sql<{
      tenant_id: string;
      runtime_generation: number;
      container_id: string;
    }>`
      select activity.tenant_id, activity.runtime_generation, runtime.container_id
      from runtime_activity as activity
      join tenants as tenant on tenant.tenant_id = activity.tenant_id
      join runtime_containers as runtime
        on runtime.tenant_id = activity.tenant_id
       and runtime.generation = activity.runtime_generation
      where tenant.tenant_mode = 'b2c'
        and tenant.status = 'active'
        and runtime.desired_state = 'running'
        and not exists (
          select 1 from worker_jobs as start_job
          where start_job.tenant_id = runtime.tenant_id
            and start_job.container_id = runtime.container_id
            and start_job.job_kind = 'reconcile_runtime'
            and start_job.runtime_command = 'start'
            and start_job.target_command_version = runtime.command_version
            and start_job.status in ('queued', 'running', 'retrying')
        )
        and activity.last_work_at <= clock_timestamp() - ${idleInterval}
        and not exists (
          select 1 from agent_runs as run
          where run.tenant_id = activity.tenant_id
            and run.status in ('queued', 'running', 'waiting_approval')
        )
      order by activity.last_work_at, activity.tenant_id, activity.runtime_generation
      for update of activity skip locked
      limit ${limit}
    `.execute(trx);
    let queued = 0;
    for (const candidate of candidates.rows) {
      if (await queueReusableJob(trx, {
        tenantId: candidate.tenant_id,
        jobId: lifecycleJobId("idle_stop", candidate.tenant_id, candidate.runtime_generation),
        jobKind: "stop_idle_b2c_runtime",
        payloadRef: candidate.container_id,
        runtimeCommand: null,
        targetCommandVersion: null,
        containerId: candidate.container_id,
      })) queued += 1;
    }
    return queued;
  }, { isolationLevel: "serializable" });
}

export type StopIdleRuntimeResult = { readonly kind: "stopped" | "superseded" | "lease_lost" };

export class RuntimeActivityRepository {
  public constructor(private readonly db: Kysely<RuntimeDatabase>) {}

  public async stopIdle(input: {
    tenantId: string;
    jobId: string;
    workerId: string;
    attemptCount: number;
    runtimeId: string;
  }): Promise<StopIdleRuntimeResult> {
    return withDatabaseTransactionRetry(this.db, async (trx) => {
      await acquireRuntimeTransactionAdvisoryLock(trx, input.tenantId, input.runtimeId);
      const job = await trx.selectFrom("worker_jobs")
        .select(["job_kind", "status", "attempt_count", "payload_ref"])
        .where("tenant_id", "=", input.tenantId)
        .where("job_id", "=", input.jobId)
        .where("status", "=", "running")
        .where("lease_owner", "=", input.workerId)
        .where("attempt_count", "=", input.attemptCount)
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (job?.job_kind !== "stop_idle_b2c_runtime" || job.payload_ref !== input.runtimeId) {
        return { kind: "lease_lost" } as const;
      }
      const runtime = await trx.selectFrom("runtime_containers")
        .select(["container_id", "generation", "command_version", "desired_state"])
        .where("tenant_id", "=", input.tenantId)
        .where("container_id", "=", input.runtimeId)
        .forUpdate()
        .executeTakeFirst();
      const activity = runtime === undefined ? undefined : await trx.selectFrom("runtime_activity")
        .select("last_work_at")
        .where("tenant_id", "=", input.tenantId)
        .where("runtime_generation", "=", String(runtime.generation))
        .forUpdate()
        .executeTakeFirst();
      const tenant = await trx.selectFrom("tenants")
        .select(["tenant_mode", "status"])
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirst();
      const activeRun = await trx.selectFrom("agent_runs")
        .select("run_id")
        .where("tenant_id", "=", input.tenantId)
        .where("status", "in", ["queued", "running", "waiting_approval"])
        .limit(1)
        .executeTakeFirst();
      const activeStart = runtime === undefined ? undefined : await trx.selectFrom("worker_jobs")
        .select("job_id")
        .where("tenant_id", "=", input.tenantId)
        .where("container_id", "=", runtime.container_id)
        .where("job_kind", "=", "reconcile_runtime")
        .where("runtime_command", "=", "start")
        .where("target_command_version", "=", String(runtime.command_version))
        .where("status", "in", ["queued", "running", "retrying"])
        .limit(1)
        .executeTakeFirst();
      const due = activity === undefined ? false : await sql<{ due: boolean }>`
        select ${activity.last_work_at} <= clock_timestamp() - ${idleInterval} as due
      `.execute(trx).then((result) => result.rows[0]?.due === true);
      const eligible = runtime !== undefined
        && tenant?.tenant_mode === "b2c"
        && tenant.status === "active"
        && runtime.desired_state === "running"
        && activeRun === undefined
        && activeStart === undefined
        && due;
      if (!eligible) {
        await this.completeOwnedJob(trx, input);
        return { kind: "superseded" } as const;
      }
      const updated = await trx.updateTable("runtime_containers").set({
        desired_state: "stopped",
        command_version: sql`command_version + 1`,
        resource_version: sql`resource_version + 1`,
        updated_at: sql<Date>`clock_timestamp()`,
      }).where("tenant_id", "=", input.tenantId)
        .where("container_id", "=", input.runtimeId)
        .returning("command_version")
        .executeTakeFirstOrThrow();
      await queueRuntimeLifecycleCommand(trx, {
        tenantId: input.tenantId,
        runtimeId: input.runtimeId,
        generation: runtime.generation,
        command: "stop",
        targetCommandVersion: safeContractInteger(updated.command_version),
      });
      await this.completeOwnedJob(trx, input);
      return { kind: "stopped" } as const;
    }, { isolationLevel: "serializable" });
  }

  private async completeOwnedJob(
    trx: Transaction<RuntimeDatabase>,
    input: { tenantId: string; jobId: string; workerId: string; attemptCount: number },
  ): Promise<void> {
    const result = await trx.updateTable("worker_jobs").set({
      status: "succeeded",
      lease_owner: null,
      lease_expires_at: null,
      last_error_summary: null,
      updated_at: sql<Date>`clock_timestamp()`,
    }).where("tenant_id", "=", input.tenantId)
      .where("job_id", "=", input.jobId)
      .where("status", "=", "running")
      .where("lease_owner", "=", input.workerId)
      .where("attempt_count", "=", input.attemptCount)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) !== 1) throw new Error("Idle Runtime stop Worker lease was lost");
  }
}
