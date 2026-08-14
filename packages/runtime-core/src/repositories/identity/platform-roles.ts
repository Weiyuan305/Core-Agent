import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";

export interface PlatformRoleWriteResult {
  readonly assignment_id: string;
  readonly actor_id: string;
  readonly status: "active" | "revoked";
  readonly resource_version: number;
}

export function platformMembershipId(actorId: string, tenantId: string): string {
  return `membership_platform_${createHash("sha256")
    .update(`${actorId}:${tenantId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function platformJobId(assignmentId: string, resourceVersion: number): string {
  return `job_platform_${createHash("sha256")
    .update(`${assignmentId}:${resourceVersion}`, "utf8").digest("hex").slice(0, 32)}`;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored platform role version is invalid");
  }
  return version;
}

async function enqueueProjection(
  trx: Transaction<RuntimeDatabase>, assignmentId: string, resourceVersion: number, now: Date,
): Promise<void> {
  const scope = await trx.selectFrom("tenants").select("tenant_id")
    .where("tenant_mode", "=", "b2b").orderBy("tenant_id").limit(1).executeTakeFirst();
  if (scope === undefined) throw new DomainError("INVALID_STATE_TRANSITION", "Platform role projection requires a B2B Tenant");
  await trx.insertInto("worker_jobs").values({
    tenant_id: scope.tenant_id,
    job_id: platformJobId(assignmentId, resourceVersion),
    job_kind: "project_platform_memberships",
    status: "queued",
    attempt_count: 0,
    max_attempts: 5,
    lease_owner: null,
    lease_expires_at: null,
    next_attempt_at: now,
    payload_ref: assignmentId,
    runtime_command: null,
    target_command_version: null,
    effect_state: "pre_effect",
    last_error_summary: null,
    run_id: null,
    container_id: null,
    created_at: now,
    updated_at: now,
  }).execute();
}

export async function grantPlatformRole(
  db: Kysely<RuntimeDatabase>,
  input: { readonly assignmentId: string; readonly actorId: string; readonly expectedResourceVersion?: number; readonly now?: Date },
): Promise<PlatformRoleWriteResult> {
  return withDatabaseTransactionRetry(db, async (trx) => {
    const now = input.now ?? new Date();
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", input.actorId).forUpdate().executeTakeFirst();
    if (actor?.status !== "active") throw new DomainError("RESOURCE_NOT_FOUND", "Platform role Actor was not found");
    const existing = await trx.selectFrom("platform_role_assignments").selectAll()
      .where("platform_role_assignment_id", "=", input.assignmentId).forUpdate().executeTakeFirst();
    if (existing !== undefined) {
      const version = safeVersion(existing.resource_version);
      if (existing.actor_id !== input.actorId || existing.role !== "platform_super_admin") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Platform role assignment identity conflicts");
      }
      if (existing.status === "active" && input.expectedResourceVersion === undefined) {
        return Object.freeze({ assignment_id: input.assignmentId, actor_id: input.actorId, status: "active", resource_version: version });
      }
      if (input.expectedResourceVersion !== version) {
        throw new DomainError("RESOURCE_VERSION_CONFLICT", "Platform role version changed");
      }
      const nextVersion = version + 1;
      await trx.updateTable("platform_role_assignments").set({
        status: "active", resource_version: nextVersion, updated_at: now,
      }).where("platform_role_assignment_id", "=", input.assignmentId).execute();
      await enqueueProjection(trx, input.assignmentId, nextVersion, now);
      return Object.freeze({ assignment_id: input.assignmentId, actor_id: input.actorId, status: "active", resource_version: nextVersion });
    }
    if (input.expectedResourceVersion !== undefined) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Platform role assignment was not found");
    }
    await trx.insertInto("platform_role_assignments").values({
      platform_role_assignment_id: input.assignmentId,
      actor_id: input.actorId,
      role: "platform_super_admin",
      status: "active",
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    await enqueueProjection(trx, input.assignmentId, 1, now);
    return Object.freeze({ assignment_id: input.assignmentId, actor_id: input.actorId, status: "active", resource_version: 1 });
  }, { isolationLevel: "serializable" });
}

export async function revokePlatformRole(
  db: Kysely<RuntimeDatabase>,
  input: {
    readonly assignmentId: string; readonly actorId: string;
    readonly expectedResourceVersion: number; readonly now?: Date;
  },
): Promise<PlatformRoleWriteResult> {
  return withDatabaseTransactionRetry(db, async (trx) => {
    const now = input.now ?? new Date();
    await trx.selectFrom("actors").select("actor_id")
      .where("actor_id", "=", input.actorId).forUpdate().executeTakeFirstOrThrow();
    const existing = await trx.selectFrom("platform_role_assignments").selectAll()
      .where("platform_role_assignment_id", "=", input.assignmentId).forUpdate().executeTakeFirst();
    if (existing === undefined || existing.actor_id !== input.actorId) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Platform role assignment was not found");
    }
    const version = safeVersion(existing.resource_version);
    if (version !== input.expectedResourceVersion || existing.status !== "active") {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Platform role version changed");
    }
    const nextVersion = version + 1;
    await trx.updateTable("platform_role_assignments").set({
      status: "revoked", resource_version: nextVersion, updated_at: now,
    }).where("platform_role_assignment_id", "=", input.assignmentId).execute();
    await enqueueProjection(trx, input.assignmentId, nextVersion, now);
    return Object.freeze({ assignment_id: input.assignmentId, actor_id: input.actorId, status: "revoked", resource_version: nextVersion });
  }, { isolationLevel: "serializable" });
}
