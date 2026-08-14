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

export interface MembershipRoleCommandContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface MembershipRoleCommandDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly consultantProfile: {
    readonly providerConfigId: string;
    readonly modelId: string;
  };
  readonly now?: () => Date;
}

export interface ChangeMembershipRolesCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly membership_id: string;
  readonly expected_resource_version: number;
  readonly roles: readonly ("admin" | "consultant")[];
}

export interface SuspendMembershipCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly membership_id: string;
  readonly expected_resource_version: number;
}

export interface MembershipMutationResult {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly membership_id: string;
  readonly actor_id: string;
  readonly roles: readonly ("admin" | "consultant")[];
  readonly status: "active" | "suspended";
  readonly resource_version: number;
  readonly profile_id?: string;
}

const dayMs = 24 * 60 * 60 * 1_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function validateBase(value: Record<string, unknown>): boolean {
  return value.schema_version === 1 && validId(value.idempotency_key) && validId(value.tenant_id)
    && validId(value.membership_id) && typeof value.payload_hash === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(value.payload_hash)
    && Number.isSafeInteger(value.expected_resource_version) && Number(value.expected_resource_version) >= 1;
}

function assertContext(context: MembershipRoleCommandContext, tenantId: string): void {
  if (!validId(context.actorId) || !validId(context.tenantId) || !validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("INTERNAL_ERROR", "Membership command context is invalid");
  }
  if (context.tenantId !== tenantId) throw new DomainError("UNAUTHENTICATED", "Membership Tenant authority is invalid");
}

function assertPayloadHash(command: { payload_hash: string }): void {
  const { payload_hash: _payloadHash, ...payload } = command;
  if (command.payload_hash !== canonicalPayloadHash(payload)) {
    throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical Membership command");
  }
}

function normalizeRoles(value: unknown): readonly ("admin" | "consultant")[] {
  if (!Array.isArray(value)) throw new DomainError("INVALID_REQUEST", "Membership roles are invalid");
  const roles = [...value];
  if (
    roles.length < 1 || roles.length > 2 || new Set(roles).size !== roles.length
    || roles.some((role) => role !== "admin" && role !== "consultant")
  ) throw new DomainError("INVALID_REQUEST", "Membership roles are invalid");
  roles.sort((left, right) => left === right ? 0 : left === "admin" ? -1 : 1);
  if (roles.some((role, index) => role !== value[index])) {
    throw new DomainError("INVALID_REQUEST", "Membership roles must use canonical order");
  }
  return Object.freeze(roles as ("admin" | "consultant")[]);
}

function profileId(actorId: string, tenantId: string): string {
  return `profile_consultant_${createHash("sha256")
    .update(`${actorId}:${tenantId}`, "utf8").digest("hex").slice(0, 32)}`;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored Membership version is invalid");
  }
  return version;
}

async function lockActors(trx: Transaction<RuntimeDatabase>, actorIds: readonly string[]): Promise<void> {
  for (const actorId of [...new Set(actorIds)].sort()) {
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", actorId).forUpdate().executeTakeFirst();
    if (actor?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active Membership Actor authority is required");
  }
}

async function assertCompanyAdmin(
  trx: Transaction<RuntimeDatabase>, context: MembershipRoleCommandContext,
): Promise<string> {
  const authority = await loadActorIdentityAuthority(trx, context.actorId);
  const membership = authority.memberships.find((candidate) => (
    candidate.tenantId === context.tenantId && candidate.source === "company"
    && candidate.status === "active" && candidate.roles.includes("admin")
  ));
  if (membership === undefined) throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
  return membership.membershipId;
}

function assertReplay(value: unknown, expected: MembershipMutationResult): void {
  if (!isPlainObject(value) || !exactKeys(value, Object.keys(expected))) {
    throw new DomainError("INTERNAL_ERROR", "Stored Membership command response is invalid");
  }
  for (const [key, item] of Object.entries(expected)) {
    const candidate = value[key];
    if (Array.isArray(item)) {
      if (!Array.isArray(candidate) || item.length !== candidate.length
        || item.some((role, index) => role !== candidate[index])) {
        throw new DomainError("INTERNAL_ERROR", "Stored Membership command response is invalid");
      }
    } else if (candidate !== item) {
      throw new DomainError("INTERNAL_ERROR", "Stored Membership command response is invalid");
    }
  }
}

async function appendMembershipMutation(
  tenantTransaction: TenantTransaction,
  context: MembershipRoleCommandContext,
  input: {
    idempotencyKey: string; adminMembershipId: string; targetMembershipId: string; targetActorId: string;
    status: "active" | "suspended"; reason: "consultant_role_granted" | "consultant_role_revoked" | "administrator_suspended";
    resourceVersion: number; now: Date; operation: string;
  },
): Promise<void> {
  await appendProductEvents(tenantTransaction, {
    streamId: input.targetMembershipId, deliveryTarget: "internal_event_stream", events: [{
      schema_version: 1, event_id: deriveIdentityCommandId("event_membership", input.idempotencyKey),
      occurred_at: input.now.toISOString(), tenant_id: context.tenantId,
      request_id: context.requestId, trace_id: context.traceId,
      correlation_id: deriveIdentityCommandId("correlation_membership", input.idempotencyKey),
      causation_id: deriveIdentityCommandId("causation_membership", input.idempotencyKey),
      event_type: "membership.changed",
      payload: {
        membership_id: input.targetMembershipId, actor_id: input.targetActorId,
        status: input.status, reason_code: input.reason, resource_version: input.resourceVersion,
      },
    }],
  });
  await appendAuditEvent(tenantTransaction, {
    schema_version: 1, audit_event_id: deriveIdentityCommandId("audit_membership", input.idempotencyKey),
    occurred_at: input.now.toISOString(), tenant_id: context.tenantId, actor_id: context.actorId,
    membership_id: input.adminMembershipId, effective_role: "admin", action: input.operation,
    resource_type: "membership", resource_id: input.targetMembershipId,
    decision: "allowed", outcome: "succeeded", request_id: context.requestId, trace_id: context.traceId,
    reason_summary: "Applied a versioned customer Membership authority change",
    resource_version: input.resourceVersion,
  });
}

export async function changeMembershipRoles(
  dependencies: MembershipRoleCommandDependencies,
  context: MembershipRoleCommandContext,
  input: unknown,
): Promise<MembershipMutationResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "membership_id",
    "expected_resource_version", "roles",
  ]) || !validateBase(input)) throw new DomainError("INVALID_REQUEST", "Change Membership roles command does not satisfy its contract");
  const roles = normalizeRoles(input.roles);
  const command = input as unknown as ChangeMembershipRolesCommand;
  assertContext(context, command.tenant_id);
  assertPayloadHash(command);
  const discovered = await dependencies.db.selectFrom("memberships").select("actor_id")
    .where("tenant_id", "=", command.tenant_id).where("membership_id", "=", command.membership_id)
    .executeTakeFirst();
  if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
  const operation = "identity.membership.change-roles";
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    await lockActors(trx, [context.actorId, discovered.actor_id]);
    const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
      .where("tenant_id", "=", context.tenantId).forUpdate().executeTakeFirst();
    if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active B2B Tenant is required");
    const adminMembershipId = await assertCompanyAdmin(trx, context);
    const membership = await trx.selectFrom("memberships").selectAll()
      .where("tenant_id", "=", context.tenantId).where("membership_id", "=", command.membership_id)
      .forUpdate().executeTakeFirst();
    if (membership === undefined || membership.actor_id !== discovered.actor_id) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
    if (membership.membership_source !== "company") throw new DomainError("INVALID_STATE_TRANSITION", "Platform Memberships are management-only");
    if (membership.status !== "active") throw new DomainError("INVALID_STATE_TRANSITION", "Only active Membership roles may change");
    const hasConsultant = roles.includes("consultant");
    const consultantProfileId = profileId(membership.actor_id, context.tenantId);
    const nextVersion = command.expected_resource_version + 1;
    const result: MembershipMutationResult = Object.freeze({
      schema_version: 1, tenant_id: context.tenantId, membership_id: command.membership_id,
      actor_id: membership.actor_id, roles, status: "active", resource_version: nextVersion,
      ...(hasConsultant ? { profile_id: consultantProfileId } : {}),
    });
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const admission = await beginIdempotentCommand<MembershipMutationResult>(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertReplay(admission.response, result);
      return result;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Membership command is already in progress");
    const version = safeVersion(membership.resource_version);
    if (version !== command.expected_resource_version) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Membership version changed");
    const hadConsultant = membership.roles.includes("consultant");
    if (membership.roles.length === roles.length && membership.roles.every((role, index) => role === roles[index])) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Membership roles did not change");
    }
    const profile = await trx.selectFrom("profiles").select(["status", "resource_version"])
      .where("tenant_id", "=", context.tenantId).where("profile_id", "=", consultantProfileId)
      .forUpdate().executeTakeFirst();
    await trx.updateTable("memberships").set({ roles: [...roles], resource_version: nextVersion, updated_at: now })
      .where("tenant_id", "=", context.tenantId).where("membership_id", "=", command.membership_id).execute();
    if (!hadConsultant && hasConsultant) {
      if (profile === undefined) {
        await trx.insertInto("profiles").values({
          tenant_id: context.tenantId, profile_id: consultantProfileId, schema_version: 1, resource_version: 1,
          owner_actor_id: membership.actor_id, profile_kind: "consultant", hermes_profile_ref: `hermes_${consultantProfileId}`,
          description: "Company consultant profile", status: "active",
          provider_config_id: dependencies.consultantProfile.providerConfigId,
          model_id: dependencies.consultantProfile.modelId, created_at: now, updated_at: now,
        }).execute();
      } else if (profile.status === "suspended") {
        await trx.updateTable("profiles").set({
          status: "active", resource_version: safeVersion(profile.resource_version) + 1, updated_at: now,
        }).where("tenant_id", "=", context.tenantId).where("profile_id", "=", consultantProfileId).execute();
      } else throw new DomainError("INVALID_STATE_TRANSITION", "Consultant Profile lifecycle conflicts");
    }
    if (hadConsultant && !hasConsultant) {
      if (profile?.status !== "active") throw new DomainError("INVALID_STATE_TRANSITION", "Active consultant Profile was not found");
      await trx.updateTable("profiles").set({
        status: "suspended", resource_version: safeVersion(profile.resource_version) + 1, updated_at: now,
      }).where("tenant_id", "=", context.tenantId).where("profile_id", "=", consultantProfileId).execute();
    }
    await appendMembershipMutation(tenantTransaction, context, {
      idempotencyKey: command.idempotency_key, adminMembershipId, targetMembershipId: command.membership_id,
      targetActorId: membership.actor_id, status: "active",
      reason: hasConsultant ? "consultant_role_granted" : "consultant_role_revoked",
      resourceVersion: nextVersion, now, operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation,
      resultRef: command.membership_id, response: result, updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}

export async function suspendMembership(
  dependencies: MembershipRoleCommandDependencies,
  context: MembershipRoleCommandContext,
  input: unknown,
): Promise<MembershipMutationResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "membership_id", "expected_resource_version",
  ]) || !validateBase(input)) throw new DomainError("INVALID_REQUEST", "Suspend Membership command does not satisfy its contract");
  const command = input as unknown as SuspendMembershipCommand;
  assertContext(context, command.tenant_id);
  assertPayloadHash(command);
  const discovered = await dependencies.db.selectFrom("memberships").select("actor_id")
    .where("tenant_id", "=", command.tenant_id).where("membership_id", "=", command.membership_id)
    .executeTakeFirst();
  if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
  const operation = "identity.membership.suspend";
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    await lockActors(trx, [context.actorId, discovered.actor_id]);
    await trx.selectFrom("tenants").select("tenant_id").where("tenant_id", "=", context.tenantId).forUpdate().executeTakeFirstOrThrow();
    const adminMembershipId = await assertCompanyAdmin(trx, context);
    const membership = await trx.selectFrom("memberships").selectAll()
      .where("tenant_id", "=", context.tenantId).where("membership_id", "=", command.membership_id)
      .forUpdate().executeTakeFirst();
    if (membership === undefined || membership.actor_id !== discovered.actor_id) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
    if (membership.membership_source !== "company") throw new DomainError("INVALID_STATE_TRANSITION", "Platform Memberships are management-only");
    const consultantProfileId = profileId(membership.actor_id, context.tenantId);
    const nextVersion = command.expected_resource_version + 1;
    const roles = Object.freeze(membership.roles as ("admin" | "consultant")[]);
    const result: MembershipMutationResult = Object.freeze({
      schema_version: 1, tenant_id: context.tenantId, membership_id: command.membership_id,
      actor_id: membership.actor_id, roles, status: "suspended", resource_version: nextVersion,
      ...(membership.roles.includes("consultant") ? { profile_id: consultantProfileId } : {}),
    });
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const admission = await beginIdempotentCommand<MembershipMutationResult>(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertReplay(admission.response, result);
      return result;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Membership command is already in progress");
    const version = safeVersion(membership.resource_version);
    if (version !== command.expected_resource_version || membership.status !== "active") {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Membership version changed");
    }
    const profile = await trx.selectFrom("profiles").select(["status", "resource_version"])
      .where("tenant_id", "=", context.tenantId).where("profile_id", "=", consultantProfileId)
      .forUpdate().executeTakeFirst();
    await trx.updateTable("memberships").set({ status: "suspended", resource_version: nextVersion, updated_at: now })
      .where("tenant_id", "=", context.tenantId).where("membership_id", "=", command.membership_id).execute();
    if (membership.roles.includes("consultant")) {
      if (profile?.status !== "active") throw new DomainError("INVALID_STATE_TRANSITION", "Active consultant Profile was not found");
      await trx.updateTable("profiles").set({
        status: "suspended", resource_version: safeVersion(profile.resource_version) + 1, updated_at: now,
      }).where("tenant_id", "=", context.tenantId).where("profile_id", "=", consultantProfileId).execute();
    }
    await appendMembershipMutation(tenantTransaction, context, {
      idempotencyKey: command.idempotency_key, adminMembershipId, targetMembershipId: command.membership_id,
      targetActorId: membership.actor_id, status: "suspended", reason: "administrator_suspended",
      resourceVersion: nextVersion, now, operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation,
      resultRef: command.membership_id, response: result, updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}
