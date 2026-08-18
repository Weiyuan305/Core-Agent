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
  readonly transaction?: Transaction<RuntimeDatabase>;
  readonly consultantProfile: {
    readonly providerConfigId: string;
    readonly modelId: string;
  };
  readonly now?: () => Date;
}

interface CommandEnvelope {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly membership_id: string;
  readonly expected_membership_resource_version: number;
}

export type GrantConsultantRoleCommand = CommandEnvelope & (
  | { readonly grant_mode: "create_profile" }
  | {
    readonly grant_mode: "reactivate_profile";
    readonly profile_id: string;
    readonly expected_profile_resource_version: number;
  }
);

export interface RemoveConsultantRoleCommand extends CommandEnvelope {
  readonly profile_id: string;
  readonly expected_profile_resource_version: number;
}

export interface ConsultantRoleGrantResult {
  readonly schema_version: 1;
  readonly membership_id: string;
  readonly roles: readonly ["admin", "consultant"];
  readonly membership_resource_version: number;
  readonly profile_id: string;
  readonly profile_resource_version: number;
  readonly profile_status: "active";
}

export interface ConsultantRoleRemoveResult {
  readonly schema_version: 1;
  readonly membership_id: string;
  readonly roles: readonly ["admin"];
  readonly membership_resource_version: number;
  readonly profile_id: string;
  readonly profile_resource_version: number;
  readonly profile_status: "suspended";
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
  readonly status: "suspended";
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

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function assertContext(context: MembershipRoleCommandContext): void {
  if (!validId(context.actorId) || !validId(context.tenantId) || !validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("INTERNAL_ERROR", "Membership command context is invalid");
  }
}

function assertPayloadHash(command: { readonly payload_hash: string }): void {
  const { payload_hash: _payloadHash, ...payload } = command;
  if (command.payload_hash !== canonicalPayloadHash(payload)) {
    throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical Membership command");
  }
}

function assertGrantCommand(value: unknown): asserts value is GrantConsultantRoleCommand {
  if (!isPlainObject(value)) throw new DomainError("INVALID_REQUEST", "Consultant grant command does not satisfy its contract");
  const mode = value.grant_mode;
  const keys = mode === "create_profile"
    ? ["schema_version", "idempotency_key", "payload_hash", "membership_id", "expected_membership_resource_version", "grant_mode"]
    : ["schema_version", "idempotency_key", "payload_hash", "membership_id", "expected_membership_resource_version", "grant_mode", "profile_id", "expected_profile_resource_version"];
  if (!exactKeys(value, keys) || value.schema_version !== 1 || !validId(value.idempotency_key)
    || !validHash(value.payload_hash) || !validId(value.membership_id)
    || !validVersion(value.expected_membership_resource_version)
    || (mode !== "create_profile" && mode !== "reactivate_profile")
    || (mode === "reactivate_profile" && (!validId(value.profile_id) || !validVersion(value.expected_profile_resource_version)))) {
    throw new DomainError("INVALID_REQUEST", "Consultant grant command does not satisfy its contract");
  }
  assertPayloadHash(value as unknown as GrantConsultantRoleCommand);
}

function assertRemoveCommand(value: unknown): asserts value is RemoveConsultantRoleCommand {
  if (!isPlainObject(value) || !exactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "membership_id",
    "expected_membership_resource_version", "profile_id", "expected_profile_resource_version",
  ]) || value.schema_version !== 1 || !validId(value.idempotency_key) || !validHash(value.payload_hash)
    || !validId(value.membership_id) || !validVersion(value.expected_membership_resource_version)
    || !validId(value.profile_id) || !validVersion(value.expected_profile_resource_version)) {
    throw new DomainError("INVALID_REQUEST", "Consultant remove command does not satisfy its contract");
  }
  assertPayloadHash(value as unknown as RemoveConsultantRoleCommand);
}

function profileId(actorId: string, tenantId: string): string {
  return `profile_consultant_${createHash("sha256").update(`${actorId}:${tenantId}`, "utf8").digest("hex").slice(0, 32)}`;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored identity resource version is invalid");
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
  const membership = authority.memberships.find((candidate) => candidate.tenantId === context.tenantId
    && candidate.source === "company" && candidate.status === "active" && candidate.roles.includes("admin"));
  if (membership === undefined) throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
  return membership.membershipId;
}

function assertStoredRoleResponse(
  value: unknown, status: "active" | "suspended",
): asserts value is ConsultantRoleGrantResult | ConsultantRoleRemoveResult {
  if (!isPlainObject(value) || !exactKeys(value, [
    "schema_version", "membership_id", "roles", "membership_resource_version",
    "profile_id", "profile_resource_version", "profile_status",
  ]) || value.schema_version !== 1 || !validId(value.membership_id) || !validId(value.profile_id)
    || !validVersion(value.membership_resource_version) || !validVersion(value.profile_resource_version)
    || value.profile_status !== status || !Array.isArray(value.roles)) {
    throw new DomainError("INTERNAL_ERROR", "Stored consultant role response is invalid");
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

async function prepareRoleMutation(
  dependencies: MembershipRoleCommandDependencies,
  context: MembershipRoleCommandContext,
  membershipId: string,
  work: (input: {
    trx: Transaction<RuntimeDatabase>; now: Date; adminMembershipId: string;
    membership: {
      actor_id: string; membership_source: "self" | "company" | "platform";
      status: string;
      roles: string[]; resource_version: string;
    };
  }) => Promise<ConsultantRoleGrantResult | ConsultantRoleRemoveResult>,
): Promise<ConsultantRoleGrantResult | ConsultantRoleRemoveResult> {
  const discoveryDb = dependencies.transaction ?? dependencies.db;
  const discovered = await discoveryDb.selectFrom("memberships").select("actor_id")
    .where("tenant_id", "=", context.tenantId).where("membership_id", "=", membershipId).executeTakeFirst();
  if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
  const execute = async (trx: Transaction<RuntimeDatabase>) => {
    const now = dependencies.now?.() ?? new Date();
    await lockActors(trx, [context.actorId, discovered.actor_id]);
    const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
      .where("tenant_id", "=", context.tenantId).forUpdate().executeTakeFirst();
    if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") {
      throw new DomainError("UNAUTHENTICATED", "Active B2B Tenant is required");
    }
    const adminMembershipId = await assertCompanyAdmin(trx, context);
    const membership = await trx.selectFrom("memberships").selectAll()
      .where("tenant_id", "=", context.tenantId).where("membership_id", "=", membershipId)
      .forUpdate().executeTakeFirst();
    if (membership === undefined || membership.actor_id !== discovered.actor_id) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
    }
    if (membership.membership_source !== "company") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Platform Memberships are management-only");
    }
    if (membership.status !== "active") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only active Membership roles may change");
    }
    return work({ trx, now, adminMembershipId, membership });
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}

export async function grantConsultantRole(
  dependencies: MembershipRoleCommandDependencies,
  context: MembershipRoleCommandContext,
  input: unknown,
): Promise<ConsultantRoleGrantResult> {
  assertGrantCommand(input);
  assertContext(context);
  return prepareRoleMutation(dependencies, context, input.membership_id, async ({ trx, now, adminMembershipId, membership }) => {
    const expectedProfileId = profileId(membership.actor_id, context.tenantId);
    const profile = await trx.selectFrom("profiles").select(["profile_id", "status", "resource_version"])
      .where("tenant_id", "=", context.tenantId).where("profile_id", "=", expectedProfileId)
      .forUpdate().executeTakeFirst();
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const operation = "identity.membership.grant-consultant";
    const admission = await beginIdempotentCommand<ConsultantRoleGrantResult>(tenantTransaction, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertStoredRoleResponse(admission.response, "active");
      return admission.response as ConsultantRoleGrantResult;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Membership command is already in progress");
    if (safeVersion(membership.resource_version) !== input.expected_membership_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Membership version changed");
    }
    if (membership.roles.length !== 1 || membership.roles[0] !== "admin") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Consultant role may only be granted to an administrator");
    }
    let profileResourceVersion: number;
    if (input.grant_mode === "create_profile") {
      if (profile !== undefined) throw new DomainError("INVALID_STATE_TRANSITION", "Consultant Profile already exists");
      profileResourceVersion = 1;
      await trx.insertInto("profiles").values({
        tenant_id: context.tenantId, profile_id: expectedProfileId, schema_version: 1, resource_version: 1,
        owner_actor_id: membership.actor_id, profile_kind: "consultant", hermes_profile_ref: `hermes_${expectedProfileId}`,
        description: "Company consultant profile", status: "active",
        provider_config_id: dependencies.consultantProfile.providerConfigId,
        model_id: dependencies.consultantProfile.modelId, created_at: now, updated_at: now,
      }).execute();
    } else {
      if (input.profile_id !== expectedProfileId || profile?.profile_id !== input.profile_id
        || profile.status !== "suspended") {
        throw new DomainError("INVALID_STATE_TRANSITION", "Suspended consultant Profile was not found");
      }
      const currentProfileVersion = safeVersion(profile.resource_version);
      if (currentProfileVersion !== input.expected_profile_resource_version) {
        throw new DomainError("RESOURCE_VERSION_CONFLICT", "Profile version changed");
      }
      profileResourceVersion = currentProfileVersion + 1;
      await trx.updateTable("profiles").set({
        status: "active", resource_version: profileResourceVersion, updated_at: now,
      }).where("tenant_id", "=", context.tenantId).where("profile_id", "=", expectedProfileId).execute();
    }
    const membershipResourceVersion = input.expected_membership_resource_version + 1;
    await trx.updateTable("memberships").set({
      roles: ["admin", "consultant"], resource_version: membershipResourceVersion, updated_at: now,
    }).where("tenant_id", "=", context.tenantId).where("membership_id", "=", input.membership_id).execute();
    const result: ConsultantRoleGrantResult = Object.freeze({
      schema_version: 1, membership_id: input.membership_id,
      roles: Object.freeze(["admin", "consultant"] as const),
      membership_resource_version: membershipResourceVersion, profile_id: expectedProfileId,
      profile_resource_version: profileResourceVersion, profile_status: "active",
    });
    await appendMembershipMutation(tenantTransaction, context, {
      idempotencyKey: input.idempotency_key, adminMembershipId, targetMembershipId: input.membership_id,
      targetActorId: membership.actor_id, status: "active", reason: "consultant_role_granted",
      resourceVersion: membershipResourceVersion, now, operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation,
      resultRef: input.membership_id, response: result, updatedAt: now,
    });
    return result;
  }) as Promise<ConsultantRoleGrantResult>;
}

export async function removeConsultantRole(
  dependencies: MembershipRoleCommandDependencies,
  context: MembershipRoleCommandContext,
  input: unknown,
): Promise<ConsultantRoleRemoveResult> {
  assertRemoveCommand(input);
  assertContext(context);
  return prepareRoleMutation(dependencies, context, input.membership_id, async ({ trx, now, adminMembershipId, membership }) => {
    const expectedProfileId = profileId(membership.actor_id, context.tenantId);
    const profile = await trx.selectFrom("profiles").select(["profile_id", "status", "resource_version"])
      .where("tenant_id", "=", context.tenantId).where("profile_id", "=", input.profile_id)
      .forUpdate().executeTakeFirst();
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const operation = "identity.membership.remove-consultant";
    const admission = await beginIdempotentCommand<ConsultantRoleRemoveResult>(tenantTransaction, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertStoredRoleResponse(admission.response, "suspended");
      return admission.response as ConsultantRoleRemoveResult;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Membership command is already in progress");
    if (safeVersion(membership.resource_version) !== input.expected_membership_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Membership version changed");
    }
    if (membership.roles.length !== 2 || membership.roles[0] !== "admin" || membership.roles[1] !== "consultant") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Consultant role is not active");
    }
    if (input.profile_id !== expectedProfileId || profile?.profile_id !== expectedProfileId || profile.status !== "active") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Active consultant Profile was not found");
    }
    const currentProfileVersion = safeVersion(profile.resource_version);
    if (currentProfileVersion !== input.expected_profile_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Profile version changed");
    }
    const membershipResourceVersion = input.expected_membership_resource_version + 1;
    const profileResourceVersion = currentProfileVersion + 1;
    await trx.updateTable("memberships").set({
      roles: ["admin"], resource_version: membershipResourceVersion, updated_at: now,
    }).where("tenant_id", "=", context.tenantId).where("membership_id", "=", input.membership_id).execute();
    await trx.updateTable("profiles").set({
      status: "suspended", resource_version: profileResourceVersion, updated_at: now,
    }).where("tenant_id", "=", context.tenantId).where("profile_id", "=", expectedProfileId).execute();
    const result: ConsultantRoleRemoveResult = Object.freeze({
      schema_version: 1, membership_id: input.membership_id, roles: Object.freeze(["admin"] as const),
      membership_resource_version: membershipResourceVersion, profile_id: expectedProfileId,
      profile_resource_version: profileResourceVersion, profile_status: "suspended",
    });
    await appendMembershipMutation(tenantTransaction, context, {
      idempotencyKey: input.idempotency_key, adminMembershipId, targetMembershipId: input.membership_id,
      targetActorId: membership.actor_id, status: "active", reason: "consultant_role_revoked",
      resourceVersion: membershipResourceVersion, now, operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation,
      resultRef: input.membership_id, response: result, updatedAt: now,
    });
    return result;
  }) as Promise<ConsultantRoleRemoveResult>;
}

export async function suspendMembership(
  dependencies: MembershipRoleCommandDependencies,
  context: MembershipRoleCommandContext,
  input: unknown,
): Promise<MembershipMutationResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "membership_id", "expected_resource_version",
  ]) || input.schema_version !== 1 || !validId(input.idempotency_key) || !validHash(input.payload_hash)
    || !validId(input.tenant_id) || !validId(input.membership_id) || !validVersion(input.expected_resource_version)) {
    throw new DomainError("INVALID_REQUEST", "Suspend Membership command does not satisfy its contract");
  }
  const command = input as unknown as SuspendMembershipCommand;
  assertContext(context);
  if (context.tenantId !== command.tenant_id) throw new DomainError("UNAUTHENTICATED", "Membership Tenant authority is invalid");
  assertPayloadHash(command);
  const discoveryDb = dependencies.transaction ?? dependencies.db;
  const discovered = await discoveryDb.selectFrom("memberships").select("actor_id")
    .where("tenant_id", "=", command.tenant_id).where("membership_id", "=", command.membership_id).executeTakeFirst();
  if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Membership was not found");
  const operation = "identity.membership.suspend";
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<MembershipMutationResult> => {
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
    const consultantProfileId = profileId(membership.actor_id, context.tenantId);
    const profile = membership.roles.includes("consultant")
      ? await trx.selectFrom("profiles").select(["status", "resource_version"])
        .where("tenant_id", "=", context.tenantId).where("profile_id", "=", consultantProfileId)
        .forUpdate().executeTakeFirst()
      : undefined;
    const roles = Object.freeze(membership.roles as ("admin" | "consultant")[]);
    const result: MembershipMutationResult = Object.freeze({
      schema_version: 1, tenant_id: context.tenantId, membership_id: command.membership_id,
      actor_id: membership.actor_id, roles, status: "suspended",
      resource_version: command.expected_resource_version + 1,
      ...(membership.roles.includes("consultant") ? { profile_id: consultantProfileId } : {}),
    });
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const admission = await beginIdempotentCommand<MembershipMutationResult>(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") return admission.response;
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Membership command is already in progress");
    const version = safeVersion(membership.resource_version);
    if (version !== command.expected_resource_version || membership.status !== "active") {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Membership version changed");
    }
    await trx.updateTable("memberships").set({ status: "suspended", resource_version: version + 1, updated_at: now })
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
      resourceVersion: version + 1, now, operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation,
      resultRef: command.membership_id, response: result, updatedAt: now,
    });
    return result;
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}
