import { sql, type Kysely, type Transaction } from "kysely";

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
import {
  deriveIdentityCommandId,
  invitationEmailHmac,
  issueInvitationSecret,
  publicInvitationNotFound,
  readInvitationBySecret,
  type InvitationRandomBytes,
} from "../../repositories/identity/invitations.js";

export interface InvitationCommandContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface InvitationCommandDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly emailHmacKey: Uint8Array;
  readonly now?: () => Date;
  readonly randomBytes?: InvitationRandomBytes;
}

export interface CreateInvitationCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly invitation_id: string;
  readonly membership_id: string;
  readonly normalized_email: string;
  readonly role: "admin" | "consultant";
}

export interface ReplaceInvitationCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly invitation_id: string;
  readonly replacement_invitation_id: string;
  readonly expected_resource_version: number;
}

export interface RevokeInvitationCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly invitation_id: string;
  readonly expected_resource_version: number;
}

export interface InvitationCommandResult {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly invitation_id: string;
  readonly membership_id: string;
  readonly status: "pending" | "revoked";
  readonly resource_version: number;
  readonly invitation_secret?: string;
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

function validEnvelope(value: Record<string, unknown>): boolean {
  return value.schema_version === 1
    && validId(value.idempotency_key)
    && typeof value.payload_hash === "string"
    && /^sha256:[a-f0-9]{64}$/u.test(value.payload_hash)
    && validId(value.tenant_id);
}

function assertContext(context: InvitationCommandContext, tenantId: string): void {
  if (
    !validId(context.actorId) || !validId(context.tenantId)
    || !validId(context.requestId) || !validId(context.traceId)
  ) throw new DomainError("INTERNAL_ERROR", "Invitation command context is invalid");
  if (context.tenantId !== tenantId) throw new DomainError("UNAUTHENTICATED", "Invitation Tenant authority is invalid");
}

function assertPayloadHash(command: { payload_hash: string }): void {
  const { payload_hash: _payloadHash, ...payload } = command;
  if (command.payload_hash !== canonicalPayloadHash(payload)) {
    throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical invitation command");
  }
}

async function lockCompanyAdmin(
  trx: Transaction<RuntimeDatabase>, context: InvitationCommandContext,
): Promise<string> {
  const actor = await trx.selectFrom("actors").select("status")
    .where("actor_id", "=", context.actorId).forUpdate().executeTakeFirst();
  if (actor?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
  const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
    .where("tenant_id", "=", context.tenantId).forUpdate().executeTakeFirst();
  if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") {
    throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
  }
  const authority = await loadActorIdentityAuthority(trx, context.actorId);
  const membership = authority.memberships.find((candidate) => (
    candidate.tenantId === context.tenantId
    && candidate.source === "company"
    && candidate.status === "active"
    && candidate.roles.includes("admin")
  ));
  if (membership === undefined) {
    throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
  }
  return membership.membershipId;
}

async function databaseNow(trx: Transaction<RuntimeDatabase>): Promise<Date> {
  return (await sql<{ now: Date }>`select now() as now`.execute(trx)).rows[0]!.now;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored invitation version is invalid");
  }
  return version;
}

function assertReplay(value: unknown, expected: InvitationCommandResult): void {
  if (!isPlainObject(value) || Object.entries(expected).some(([key, item]) => value[key] !== item)) {
    throw new DomainError("INTERNAL_ERROR", "Stored invitation command response is invalid");
  }
}

async function appendInvitationCreated(
  tenantTransaction: TenantTransaction,
  context: InvitationCommandContext,
  input: { invitationId: string; membershipId: string; adminMembershipId: string; idempotencyKey: string; now: Date; action: string },
): Promise<void> {
  await appendProductEvents(tenantTransaction, {
    streamId: input.invitationId,
    deliveryTarget: "internal_event_stream",
    events: [{
      schema_version: 1,
      event_id: deriveIdentityCommandId("event_invitation", input.idempotencyKey),
      occurred_at: input.now.toISOString(),
      tenant_id: context.tenantId,
      request_id: context.requestId,
      trace_id: context.traceId,
      correlation_id: deriveIdentityCommandId("correlation_invitation", input.idempotencyKey),
      causation_id: deriveIdentityCommandId("causation_invitation", input.idempotencyKey),
      event_type: "invitation.created",
      payload: {
        invitation_id: input.invitationId,
        membership_id: input.membershipId,
        status: "pending",
        resource_version: 1,
      },
    }],
  });
  await appendAuditEvent(tenantTransaction, {
    schema_version: 1,
    audit_event_id: deriveIdentityCommandId("audit_invitation", input.idempotencyKey),
    occurred_at: input.now.toISOString(),
    tenant_id: context.tenantId,
    actor_id: context.actorId,
    membership_id: input.adminMembershipId,
    effective_role: "admin",
    action: input.action,
    resource_type: "identity_invitation",
    resource_id: input.invitationId,
    decision: "allowed",
    outcome: "succeeded",
    request_id: context.requestId,
    trace_id: context.traceId,
    reason_summary: "Created a versioned B2B identity invitation",
    resource_version: 1,
  });
}

async function appendInvitationChanged(
  tenantTransaction: TenantTransaction,
  context: InvitationCommandContext,
  input: {
    invitationId: string; membershipId: string; idempotencyKey: string; now: Date;
    status: "revoked" | "replaced" | "expired"; resourceVersion: number;
    replacementInvitationId?: string;
  },
): Promise<void> {
  const envelope = {
    schema_version: 1 as const,
    event_id: deriveIdentityCommandId("event_invitation_change", `${input.idempotencyKey}:${input.invitationId}`),
    occurred_at: input.now.toISOString(), tenant_id: context.tenantId,
    request_id: context.requestId, trace_id: context.traceId,
    correlation_id: deriveIdentityCommandId("correlation_invitation", input.idempotencyKey),
    causation_id: deriveIdentityCommandId("causation_invitation", input.idempotencyKey),
    event_type: "invitation.changed" as const,
  };
  const event = input.status === "replaced"
    ? { ...envelope, payload: {
      invitation_id: input.invitationId, membership_id: input.membershipId, status: "replaced" as const,
      replacement_invitation_id: input.replacementInvitationId!, resource_version: input.resourceVersion,
    } }
    : input.status === "revoked"
      ? { ...envelope, payload: {
        invitation_id: input.invitationId, membership_id: input.membershipId, status: "revoked" as const,
        resource_version: input.resourceVersion,
      } }
      : { ...envelope, payload: {
        invitation_id: input.invitationId, membership_id: input.membershipId, status: "expired" as const,
        resource_version: input.resourceVersion,
      } };
  await appendProductEvents(tenantTransaction, {
    streamId: input.invitationId,
    deliveryTarget: "internal_event_stream",
    events: [event],
  });
}

async function appendInvitationTransitionAudit(
  tenantTransaction: TenantTransaction,
  context: InvitationCommandContext,
  input: {
    invitationId: string; adminMembershipId: string; idempotencyKey: string; now: Date;
    action: string; resourceVersion: number; summary: string;
  },
): Promise<void> {
  await appendAuditEvent(tenantTransaction, {
    schema_version: 1,
    audit_event_id: deriveIdentityCommandId("audit_invitation_change", `${input.idempotencyKey}:${input.invitationId}`),
    occurred_at: input.now.toISOString(), tenant_id: context.tenantId, actor_id: context.actorId,
    membership_id: input.adminMembershipId, effective_role: "admin", action: input.action,
    resource_type: "identity_invitation", resource_id: input.invitationId,
    decision: "allowed", outcome: "succeeded", request_id: context.requestId, trace_id: context.traceId,
    reason_summary: input.summary, resource_version: input.resourceVersion,
  });
}

export async function createInvitation(
  dependencies: InvitationCommandDependencies,
  context: InvitationCommandContext,
  input: unknown,
): Promise<InvitationCommandResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "invitation_id", "membership_id",
    "normalized_email", "role",
  ]) || !validEnvelope(input) || !validId(input.invitation_id) || !validId(input.membership_id)
    || typeof input.normalized_email !== "string" || (input.role !== "admin" && input.role !== "consultant")) {
    throw new DomainError("INVALID_REQUEST", "Create invitation command does not satisfy its contract");
  }
  const command = input as unknown as CreateInvitationCommand;
  assertContext(context, command.tenant_id);
  assertPayloadHash(command);
  const emailHmac = invitationEmailHmac(dependencies.emailHmacKey, command.normalized_email);
  const issued = issueInvitationSecret(dependencies.randomBytes);
  const storedResult: InvitationCommandResult = Object.freeze({
    schema_version: 1, tenant_id: command.tenant_id, invitation_id: command.invitation_id,
    membership_id: command.membership_id, status: "pending", resource_version: 1,
  });
  const operation = "identity.invitation.create";
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    const adminMembershipId = await lockCompanyAdmin(trx, context);
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const admission = await beginIdempotentCommand<InvitationCommandResult>(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertReplay(admission.response, storedResult);
      return storedResult;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Invitation command is already in progress");
    const databaseTimestamp = await databaseNow(trx);
    const expired = await trx.selectFrom("identity_invitations").selectAll()
      .where("tenant_id", "=", context.tenantId)
      .where("normalized_email_hmac", "=", emailHmac)
      .where("status", "=", "pending")
      .where("expires_at", "<=", databaseTimestamp)
      .forUpdate().executeTakeFirst();
    if (expired !== undefined) {
      const expiredVersion = safeVersion(expired.resource_version) + 1;
      await trx.updateTable("identity_invitations").set({
        status: "expired", resource_version: expiredVersion, updated_at: databaseTimestamp,
      }).where("tenant_id", "=", context.tenantId).where("invitation_id", "=", expired.invitation_id).execute();
      await appendInvitationChanged(tenantTransaction, context, {
        invitationId: expired.invitation_id, membershipId: expired.membership_id,
        idempotencyKey: command.idempotency_key, now: databaseTimestamp,
        status: "expired", resourceVersion: expiredVersion,
      });
      await appendInvitationTransitionAudit(tenantTransaction, context, {
        invitationId: expired.invitation_id, adminMembershipId, idempotencyKey: command.idempotency_key,
        now: databaseTimestamp, action: "identity.invitation.expire", resourceVersion: expiredVersion,
        summary: "Expired a pending B2B identity invitation using database time",
      });
    }
    await trx.insertInto("identity_invitations").values({
      invitation_id: command.invitation_id,
      tenant_id: command.tenant_id,
      membership_id: command.membership_id,
      invited_by_actor_id: context.actorId,
      role: command.role,
      secret_digest: issued.digest,
      normalized_email_hmac: emailHmac,
      status: "pending",
      expires_at: new Date(now.getTime() + 7 * dayMs),
      accepted_actor_id: null,
      accepted_at: null,
      replaced_by_invitation_id: null,
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    await appendInvitationCreated(tenantTransaction, context, {
      invitationId: command.invitation_id, membershipId: command.membership_id,
      adminMembershipId, idempotencyKey: command.idempotency_key, now, action: operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation,
      resultRef: command.invitation_id, response: storedResult, updatedAt: now,
    });
    return Object.freeze({ ...storedResult, invitation_secret: issued.secret });
  }, { isolationLevel: "serializable" });
}

export async function inspectInvitation(
  dependencies: Pick<InvitationCommandDependencies, "db">,
  invitationSecret: string,
): Promise<Readonly<{ schema_version: 1; tenant_id: string; invitation_id: string; membership_id: string; role: "admin" | "consultant"; expires_at: string }>> {
  return dependencies.db.transaction().execute(async (trx) => {
    const invitation = await readInvitationBySecret(trx, invitationSecret);
    const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
      .where("tenant_id", "=", invitation.tenantId).executeTakeFirst();
    const now = await databaseNow(trx);
    if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active"
      || invitation.status !== "pending" || invitation.expiresAt.getTime() <= now.getTime()) publicInvitationNotFound();
    return Object.freeze({
      schema_version: 1,
      tenant_id: invitation.tenantId,
      invitation_id: invitation.invitationId,
      membership_id: invitation.membershipId,
      role: invitation.role,
      expires_at: invitation.expiresAt.toISOString(),
    });
  });
}

export async function replaceInvitation(
  dependencies: InvitationCommandDependencies,
  context: InvitationCommandContext,
  input: unknown,
): Promise<InvitationCommandResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "invitation_id",
    "replacement_invitation_id", "expected_resource_version",
  ]) || !validEnvelope(input) || !validId(input.invitation_id) || !validId(input.replacement_invitation_id)
    || !Number.isSafeInteger(input.expected_resource_version) || Number(input.expected_resource_version) < 1) {
    throw new DomainError("INVALID_REQUEST", "Replace invitation command does not satisfy its contract");
  }
  const command = input as unknown as ReplaceInvitationCommand;
  assertContext(context, command.tenant_id);
  assertPayloadHash(command);
  const issued = issueInvitationSecret(dependencies.randomBytes);
  const operation = "identity.invitation.replace";
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    const adminMembershipId = await lockCompanyAdmin(trx, context);
    const old = await trx.selectFrom("identity_invitations").selectAll()
      .where("tenant_id", "=", context.tenantId).where("invitation_id", "=", command.invitation_id)
      .forUpdate().executeTakeFirst();
    if (old === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Invitation was not found");
    const storedResult: InvitationCommandResult = Object.freeze({
      schema_version: 1, tenant_id: context.tenantId, invitation_id: command.replacement_invitation_id,
      membership_id: old.membership_id, status: "pending", resource_version: 1,
    });
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const admission = await beginIdempotentCommand<InvitationCommandResult>(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertReplay(admission.response, storedResult);
      return storedResult;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Invitation command is already in progress");
    const oldVersion = safeVersion(old.resource_version);
    if (oldVersion !== command.expected_resource_version) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Invitation version changed");
    if (old.status !== "pending" || old.expires_at.getTime() <= (await databaseNow(trx)).getTime()) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Invitation cannot be replaced");
    }
    await trx.insertInto("identity_invitations").values({
      invitation_id: command.replacement_invitation_id, tenant_id: context.tenantId,
      membership_id: old.membership_id, invited_by_actor_id: context.actorId, role: old.role,
      secret_digest: issued.digest, normalized_email_hmac: old.normalized_email_hmac,
      status: "revoked", expires_at: new Date(now.getTime() + 7 * dayMs), accepted_actor_id: null,
      accepted_at: null, replaced_by_invitation_id: null, resource_version: 1, created_at: now, updated_at: now,
    }).execute();
    await trx.updateTable("identity_invitations").set({
      status: "replaced", replaced_by_invitation_id: command.replacement_invitation_id,
      resource_version: oldVersion + 1, updated_at: now,
    }).where("invitation_id", "=", command.invitation_id).execute();
    await trx.updateTable("identity_invitations").set({ status: "pending" })
      .where("invitation_id", "=", command.replacement_invitation_id).execute();
    await appendInvitationChanged(tenantTransaction, context, {
      invitationId: command.invitation_id, membershipId: old.membership_id,
      idempotencyKey: command.idempotency_key, now, status: "replaced",
      resourceVersion: oldVersion + 1, replacementInvitationId: command.replacement_invitation_id,
    });
    await appendInvitationCreated(tenantTransaction, context, {
      invitationId: command.replacement_invitation_id, membershipId: old.membership_id,
      adminMembershipId, idempotencyKey: command.idempotency_key, now, action: operation,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation,
      resultRef: command.replacement_invitation_id, response: storedResult, updatedAt: now,
    });
    return Object.freeze({ ...storedResult, invitation_secret: issued.secret });
  }, { isolationLevel: "serializable" });
}

export async function revokeInvitation(
  dependencies: InvitationCommandDependencies,
  context: InvitationCommandContext,
  input: unknown,
): Promise<InvitationCommandResult> {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "invitation_id", "expected_resource_version",
  ]) || !validEnvelope(input) || !validId(input.invitation_id)
    || !Number.isSafeInteger(input.expected_resource_version) || Number(input.expected_resource_version) < 1) {
    throw new DomainError("INVALID_REQUEST", "Revoke invitation command does not satisfy its contract");
  }
  const command = input as unknown as RevokeInvitationCommand;
  assertContext(context, command.tenant_id);
  assertPayloadHash(command);
  const operation = "identity.invitation.revoke";
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    const adminMembershipId = await lockCompanyAdmin(trx, context);
    const invitation = await trx.selectFrom("identity_invitations").selectAll()
      .where("tenant_id", "=", context.tenantId).where("invitation_id", "=", command.invitation_id)
      .forUpdate().executeTakeFirst();
    if (invitation === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Invitation was not found");
    const result: InvitationCommandResult = Object.freeze({
      schema_version: 1, tenant_id: context.tenantId, invitation_id: command.invitation_id,
      membership_id: invitation.membership_id, status: "revoked", resource_version: command.expected_resource_version + 1,
    });
    const tenantTransaction: TenantTransaction = { tenantId: context.tenantId, trx };
    const admission = await beginIdempotentCommand<InvitationCommandResult>(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") return admission.response;
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Invitation command is already in progress");
    const version = safeVersion(invitation.resource_version);
    if (version !== command.expected_resource_version) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Invitation version changed");
    if (invitation.status !== "pending") throw new DomainError("RESOURCE_VERSION_CONFLICT", "Invitation is no longer pending");
    await trx.updateTable("identity_invitations").set({
      status: "revoked", resource_version: version + 1, updated_at: now,
    }).where("invitation_id", "=", command.invitation_id).execute();
    await appendInvitationChanged(tenantTransaction, context, {
      invitationId: command.invitation_id, membershipId: invitation.membership_id,
      idempotencyKey: command.idempotency_key, now, status: "revoked", resourceVersion: version + 1,
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1, audit_event_id: deriveIdentityCommandId("audit_invitation_revoke", command.idempotency_key),
      occurred_at: now.toISOString(), tenant_id: context.tenantId, actor_id: context.actorId,
      membership_id: adminMembershipId, effective_role: "admin", action: operation,
      resource_type: "identity_invitation", resource_id: command.invitation_id,
      decision: "allowed", outcome: "succeeded", request_id: context.requestId, trace_id: context.traceId,
      reason_summary: "Revoked a pending B2B identity invitation", resource_version: version + 1,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: command.idempotency_key, payloadHash: command.payload_hash, operation,
      resultRef: command.invitation_id, response: result, updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}
