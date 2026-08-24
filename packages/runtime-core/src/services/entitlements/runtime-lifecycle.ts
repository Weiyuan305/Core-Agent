import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { queueRuntimeLifecycleCommand } from "../../repositories/entitlements/runtime-activity.js";
import { acquireRuntimeTransactionAdvisoryLock } from "../../repositories/runtime-lock.js";
import { safeContractInteger } from "../../repositories/resources.js";

export async function ensureRuntimeWakeIntent(
  trx: Transaction<RuntimeDatabase>,
  input: { tenantId: string; runtimeId: string },
): Promise<"ready" | "preparing" | "not_found"> {
  const ready = await trx.selectFrom("runtime_containers")
    .select("container_id")
    .where("tenant_id", "=", input.tenantId)
    .where("container_id", "=", input.runtimeId)
    .where("desired_state", "=", "running")
    .where("observed_state", "=", "ready")
    .where("health_status", "=", "healthy")
    .forShare()
    .executeTakeFirst();
  if (ready !== undefined) return "ready";
  await acquireRuntimeTransactionAdvisoryLock(trx, input.tenantId, input.runtimeId);
  const runtime = await trx.selectFrom("runtime_containers")
    .select(["generation", "command_version", "desired_state", "observed_state", "health_status"])
    .where("tenant_id", "=", input.tenantId)
    .where("container_id", "=", input.runtimeId)
    .forUpdate()
    .executeTakeFirst();
  if (runtime === undefined) return "not_found";
  if (runtime.desired_state === "running" && runtime.observed_state === "ready" && runtime.health_status === "healthy") {
    return "ready";
  }
  if (runtime.desired_state === "stopped") {
    const updated = await trx.updateTable("runtime_containers").set({
      desired_state: "running",
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
      command: "start",
      targetCommandVersion: safeContractInteger(updated.command_version),
    });
  } else if (runtime.observed_state === "stopped") {
    await queueRuntimeLifecycleCommand(trx, {
      tenantId: input.tenantId,
      runtimeId: input.runtimeId,
      generation: runtime.generation,
      command: "start",
      targetCommandVersion: safeContractInteger(runtime.command_version),
    });
  }
  return "preparing";
}
