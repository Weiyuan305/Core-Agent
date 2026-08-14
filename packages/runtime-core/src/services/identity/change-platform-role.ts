import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import type { TenantTransaction } from "../../db/transaction.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../../domain/idempotency.js";
import { appendAuditEvent, appendProductEvents } from "../../repositories/events.js";
import { loadActorIdentityAuthority } from "../../repositories/identity/identity-authority.js";
import { deriveIdentityCommandId } from "../../repositories/identity/invitations.js";
import { platformMembershipId, platformRoleAssignmentId } from "../../repositories/identity/platform-roles.js";

export interface PlatformRoleCommandDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly now?: () => Date;
}

export interface PlatformRoleCommandContext {
  readonly performingActorId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface PlatformRoleCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly platform_role_assignment_id: string;
  readonly target_actor_id: string;
  readonly expected_resource_version: number | null;
}

export interface PlatformRoleWriteResult {
  readonly schema_version: 1;
  readonly platform_role_assignment_id: string;
  readonly actor_id: string;
  readonly status: "active" | "revoked";
  readonly resource_version: number;
}

const dayMs = 24 * 60 * 60 * 1_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function assertCommand(input: unknown, operation: "grant" | "revoke"): asserts input is PlatformRoleCommand {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "platform_role_assignment_id",
    "target_actor_id", "expected_resource_version",
  ]) || input.schema_version !== 1 || !validId(input.idempotency_key)
    || !validId(input.platform_role_assignment_id) || !validId(input.target_actor_id)
    || typeof input.payload_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.payload_hash)
    || (input.expected_resource_version !== null
      && (!Number.isSafeInteger(input.expected_resource_version) || Number(input.expected_resource_version) < 1))
    || (operation === "revoke" && input.expected_resource_version === null)) {
    throw new DomainError("INVALID_REQUEST", `Platform role ${operation} command does not satisfy its contract`);
  }
  const { payload_hash: _payloadHash, ...payload } = input;
  if (input.payload_hash !== canonicalPayloadHash(payload)) {
    throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical platform role command");
  }
  if (input.platform_role_assignment_id !== platformRoleAssignmentId(input.target_actor_id)) {
    throw new DomainError("INVALID_REQUEST", "Platform role assignment identity is not canonical");
  }
}

function assertContext(context: PlatformRoleCommandContext): void {
  if (!validId(context.performingActorId) || !validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("INTERNAL_ERROR", "Platform role command context is invalid");
  }
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored platform role version is invalid");
  }
  return version;
}

function projectionJobId(assignmentId: string, resourceVersion: number): string {
  return `job_platform_${createHash("sha256").update(`${assignmentId}:${resourceVersion}`, "utf8").digest("hex").slice(0, 32)}`;
}

async function lockCommandActors(
  trx: Transaction<RuntimeDatabase>, performingActorId: string, targetActorId: string,
  desiredStatus: "active" | "revoked",
): Promise<void> {
  const statuses = new Map<string, "active" | "disabled" | "deletion_pending" | "deleted">();
  for (const actorId of [...new Set([performingActorId, targetActorId])].sort()) {
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", actorId).forUpdate().executeTakeFirst();
    if (actor !== undefined) statuses.set(actorId, actor.status);
  }
  if (statuses.get(performingActorId) !== "active") {
    throw new DomainError("UNAUTHENTICATED", "Active platform Actor authority is required");
  }
  const targetStatus = statuses.get(targetActorId);
  if (targetStatus === undefined || (desiredStatus === "active" && targetStatus !== "active")) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Platform role target Actor was not found");
  }
}

function assertReplay(value: unknown): asserts value is PlatformRoleWriteResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    "schema_version", "platform_role_assignment_id", "actor_id", "status", "resource_version",
  ]) || value.schema_version !== 1 || !validId(value.platform_role_assignment_id) || !validId(value.actor_id)
    || (value.status !== "active" && value.status !== "revoked")
    || !Number.isSafeInteger(value.resource_version) || Number(value.resource_version) < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored platform role response is invalid");
  }
}

async function appendPlatformRoleArtifacts(
  trx: Transaction<RuntimeDatabase>,
  context: PlatformRoleCommandContext,
  command: PlatformRoleCommand,
  tenantIds: readonly string[],
  result: PlatformRoleWriteResult,
  now: Date,
  operation: string,
): Promise<void> {
  for (const tenantId of tenantIds) {
    const membershipId = platformMembershipId(context.performingActorId, tenantId);
    const membership = await trx.selectFrom("memberships").select(["status", "membership_source"])
      .where("tenant_id", "=", tenantId).where("membership_id", "=", membershipId)
      .forUpdate().executeTakeFirst();
    if (membership?.status !== "active" || membership.membership_source !== "platform") {
      throw new DomainError("INTERNAL_ERROR", "Platform administrator projection is missing");
    }
    const seed = `${command.idempotency_key}:${tenantId}`;
    const tenantTransaction: TenantTransaction = { tenantId, trx };
    await appendProductEvents(tenantTransaction, {
      streamId: result.platform_role_assignment_id,
      deliveryTarget: "internal_event_stream",
      events: [{
        schema_version: 1,
        event_id: deriveIdentityCommandId("event_platform_role", seed),
        occurred_at: now.toISOString(), tenant_id: tenantId,
        request_id: context.requestId, trace_id: context.traceId,
        correlation_id: deriveIdentityCommandId("correlation_platform_role", command.idempotency_key),
        causation_id: deriveIdentityCommandId("causation_platform_role", command.idempotency_key),
        event_type: "platform_role.changed",
        payload: {
          platform_role_assignment_id: result.platform_role_assignment_id,
          actor_id: result.actor_id,
          status: result.status,
          resource_version: result.resource_version,
        },
      }],
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1,
      audit_event_id: deriveIdentityCommandId("audit_platform_role", seed),
      occurred_at: now.toISOString(), tenant_id: tenantId,
      actor_id: context.performingActorId, membership_id: membershipId, effective_role: "admin",
      action: operation, resource_type: "platform_role_assignment",
      resource_id: result.platform_role_assignment_id, decision: "allowed", outcome: "succeeded",
      request_id: context.requestId, trace_id: context.traceId,
      reason_summary: result.status === "active"
        ? "Granted versioned platform administrator authority"
        : "Revoked versioned platform administrator authority",
      resource_version: result.resource_version,
    });
  }
}

async function enqueueProjection(
  trx: Transaction<RuntimeDatabase>, tenantId: string, result: PlatformRoleWriteResult, now: Date,
): Promise<void> {
  await trx.insertInto("worker_jobs").values({
    tenant_id: tenantId, job_id: projectionJobId(result.platform_role_assignment_id, result.resource_version),
    job_kind: "project_platform_memberships", status: "queued", attempt_count: 0, max_attempts: 5,
    lease_owner: null, lease_expires_at: null, next_attempt_at: now,
    payload_ref: result.platform_role_assignment_id, runtime_command: null, target_command_version: null,
    effect_state: "pre_effect", last_error_summary: null, run_id: null, container_id: null,
    created_at: now, updated_at: now,
  }).execute();
}

async function changePlatformRole(
  dependencies: PlatformRoleCommandDependencies,
  context: PlatformRoleCommandContext,
  input: unknown,
  desiredStatus: "active" | "revoked",
): Promise<PlatformRoleWriteResult> {
  const operationKind = desiredStatus === "active" ? "grant" : "revoke";
  assertCommand(input, operationKind);
  assertContext(context);
  const operation = `identity.platform-role.${operationKind}`;
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    await lockCommandActors(trx, context.performingActorId, input.target_actor_id, desiredStatus);
    const authority = await loadActorIdentityAuthority(trx, context.performingActorId);
    if (authority.actorStatus !== "active" || !authority.platformRoles.includes("platform_super_admin")) {
      throw new DomainError("UNAUTHENTICATED", "Active platform_super_admin authority is required");
    }
    const tenantRows = await trx.selectFrom("tenants").select(["tenant_id", "created_at"])
      .where("tenant_mode", "=", "b2b")
      .orderBy("created_at", "asc").orderBy("tenant_id", "asc").execute();
    const tenantIds = tenantRows.map((row) => row.tenant_id);
    const scopeTenantId = tenantIds[0];
    if (scopeTenantId !== undefined) {
      const admission = await beginIdempotentCommand<PlatformRoleWriteResult>({ tenantId: scopeTenantId, trx }, {
        key: input.idempotency_key, payloadHash: input.payload_hash, operation, now,
        expiresAt: new Date(now.getTime() + dayMs),
      });
      if (admission.kind === "replay") {
        assertReplay(admission.response);
        return Object.freeze(admission.response);
      }
      if (admission.kind === "in_progress") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Platform role command is already in progress");
      }
    }

    const existing = await trx.selectFrom("platform_role_assignments").selectAll()
      .where("platform_role_assignment_id", "=", input.platform_role_assignment_id)
      .forUpdate().executeTakeFirst();
    let result: PlatformRoleWriteResult;
    if (existing === undefined) {
      if (desiredStatus !== "active" || input.expected_resource_version !== null) {
        throw new DomainError("RESOURCE_VERSION_CONFLICT", "Platform role assignment version changed");
      }
      await trx.insertInto("platform_role_assignments").values({
        platform_role_assignment_id: input.platform_role_assignment_id,
        actor_id: input.target_actor_id, role: "platform_super_admin", status: "active",
        resource_version: 1, created_at: now, updated_at: now,
      }).execute();
      result = Object.freeze({
        schema_version: 1, platform_role_assignment_id: input.platform_role_assignment_id,
        actor_id: input.target_actor_id, status: "active", resource_version: 1,
      });
    } else {
      const version = safeVersion(existing.resource_version);
      if (existing.actor_id !== input.target_actor_id || existing.role !== "platform_super_admin") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Platform role assignment identity conflicts");
      }
      if (scopeTenantId === undefined && existing.status === desiredStatus) {
        const naturallyReplayed = input.expected_resource_version === version - 1
          || (desiredStatus === "active" && version === 1 && input.expected_resource_version === null);
        if (naturallyReplayed) {
          return Object.freeze({
            schema_version: 1, platform_role_assignment_id: input.platform_role_assignment_id,
            actor_id: input.target_actor_id, status: desiredStatus, resource_version: version,
          });
        }
      }
      if (input.expected_resource_version !== version || existing.status === desiredStatus) {
        throw new DomainError("RESOURCE_VERSION_CONFLICT", "Platform role assignment version changed");
      }
      const nextVersion = version + 1;
      await trx.updateTable("platform_role_assignments").set({
        status: desiredStatus, resource_version: nextVersion, updated_at: now,
      }).where("platform_role_assignment_id", "=", input.platform_role_assignment_id).execute();
      result = Object.freeze({
        schema_version: 1, platform_role_assignment_id: input.platform_role_assignment_id,
        actor_id: input.target_actor_id, status: desiredStatus, resource_version: nextVersion,
      });
    }

    if (scopeTenantId === undefined) return result;
    await appendPlatformRoleArtifacts(trx, context, input, tenantIds, result, now, operation);
    await enqueueProjection(trx, scopeTenantId, result, now);
    await completeIdempotentCommand({ tenantId: scopeTenantId, trx }, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation,
      resultRef: result.platform_role_assignment_id, response: result, updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}

export async function grantPlatformRole(
  dependencies: PlatformRoleCommandDependencies,
  context: PlatformRoleCommandContext,
  input: unknown,
): Promise<PlatformRoleWriteResult> {
  return changePlatformRole(dependencies, context, input, "active");
}

export async function revokePlatformRole(
  dependencies: PlatformRoleCommandDependencies,
  context: PlatformRoleCommandContext,
  input: unknown,
): Promise<PlatformRoleWriteResult> {
  return changePlatformRole(dependencies, context, input, "revoked");
}
