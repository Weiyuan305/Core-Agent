import type { Kysely } from "kysely";

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
  type InvitationRandomBytes,
} from "../../repositories/identity/invitations.js";
import { platformMembershipId } from "../../repositories/identity/platform-roles.js";

export interface CreateB2bCompanyCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly display_name: string;
  readonly invitation: {
    readonly invitation_id: string;
    readonly membership_id: string;
    readonly normalized_email: string;
  };
}

export interface CreateB2bCompanyContext {
  readonly actorId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface CreateB2bCompanyDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly emailHmacKey: Uint8Array;
  readonly now?: () => Date;
  readonly randomBytes?: InvitationRandomBytes;
}

export interface CreateB2bCompanyResult {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly invitation_id: string;
  readonly membership_id: string;
  readonly resource_version: 1;
  readonly invitation_secret?: string;
}

const operation = "identity.create-b2b-company";
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

function assertCommand(value: unknown): asserts value is CreateB2bCompanyCommand {
  if (!isPlainObject(value) || !exactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "display_name", "invitation",
  ])) throw new DomainError("INVALID_REQUEST", "B2B company command does not satisfy its contract");
  const invitation = value.invitation;
  if (!isPlainObject(invitation) || !exactKeys(invitation, [
    "invitation_id", "membership_id", "normalized_email",
  ])) throw new DomainError("INVALID_REQUEST", "B2B company command does not satisfy its contract");
  if (
    value.schema_version !== 1
    || !validId(value.idempotency_key)
    || typeof value.payload_hash !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(value.payload_hash)
    || !validId(value.tenant_id)
    || typeof value.display_name !== "string"
    || value.display_name.length < 1
    || value.display_name.length > 200
    || !validId(invitation.invitation_id)
    || !validId(invitation.membership_id)
    || typeof invitation.normalized_email !== "string"
  ) throw new DomainError("INVALID_REQUEST", "B2B company command does not satisfy its contract");
}

function payloadWithoutHash(command: CreateB2bCompanyCommand): Omit<CreateB2bCompanyCommand, "payload_hash"> {
  const { payload_hash: _payloadHash, ...payload } = command;
  return payload;
}

function baseResult(command: CreateB2bCompanyCommand): CreateB2bCompanyResult {
  return Object.freeze({
    schema_version: 1,
    tenant_id: command.tenant_id,
    invitation_id: command.invitation.invitation_id,
    membership_id: command.invitation.membership_id,
    resource_version: 1,
  });
}

function assertStoredResult(value: unknown, expected: CreateB2bCompanyResult): void {
  if (!isPlainObject(value) || Object.entries(expected).some(([key, item]) => value[key] !== item)) {
    throw new DomainError("INTERNAL_ERROR", "Stored B2B company response is invalid");
  }
}

export async function createB2bCompany(
  dependencies: CreateB2bCompanyDependencies,
  context: CreateB2bCompanyContext,
  input: unknown,
): Promise<CreateB2bCompanyResult> {
  assertCommand(input);
  if (!validId(context.actorId) || !validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("INTERNAL_ERROR", "B2B company context is invalid");
  }
  if (input.payload_hash !== canonicalPayloadHash(payloadWithoutHash(input))) {
    throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical B2B company command");
  }
  const normalizedEmailHmac = invitationEmailHmac(
    dependencies.emailHmacKey,
    input.invitation.normalized_email,
  );
  const issuedSecret = issueInvitationSecret(dependencies.randomBytes);
  const storedResult = baseResult(input);

  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "B2B company clock is invalid");
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", context.actorId).forUpdate().executeTakeFirst();
    if (actor?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active platform authority is required");
    const authority = await loadActorIdentityAuthority(trx, context.actorId);
    if (!authority.platformRoles.includes("platform_super_admin")) {
      throw new DomainError("UNAUTHENTICATED", "Active platform authority is required");
    }
    const insertedTenant = await trx.insertInto("tenants").values({
      tenant_id: input.tenant_id,
      schema_version: 1,
      resource_version: 1,
      tenant_mode: "b2b",
      status: "active",
      display_name: input.display_name,
      created_at: now,
      updated_at: now,
    }).onConflict((conflict) => conflict.column("tenant_id").doNothing())
      .returning("tenant_id").executeTakeFirst();
    const tenantTransaction: TenantTransaction = { tenantId: input.tenant_id, trx };
    const admission = await beginIdempotentCommand<CreateB2bCompanyResult>(tenantTransaction, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      if (admission.resultRef !== input.tenant_id) {
        throw new DomainError("INTERNAL_ERROR", "B2B company replay result reference is invalid");
      }
      assertStoredResult(admission.response, storedResult);
      return storedResult;
    }
    if (admission.kind === "in_progress") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "B2B company command is already in progress");
    }
    if (insertedTenant === undefined) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "B2B Tenant already exists");
    }

    const assignments = await trx.selectFrom("platform_role_assignments")
      .innerJoin("actors", "actors.actor_id", "platform_role_assignments.actor_id")
      .select(["platform_role_assignments.actor_id", "platform_role_assignments.platform_role_assignment_id"])
      .where("platform_role_assignments.role", "=", "platform_super_admin")
      .where("platform_role_assignments.status", "=", "active")
      .where("actors.status", "=", "active")
      .orderBy("platform_role_assignments.actor_id")
      .execute();
    for (const assignment of assignments) {
      const membershipId = platformMembershipId(assignment.actor_id, input.tenant_id);
      await trx.insertInto("memberships").values({
        tenant_id: input.tenant_id,
        membership_id: membershipId,
        actor_id: assignment.actor_id,
        schema_version: 1,
        resource_version: 1,
        roles: ["admin"],
        membership_source: "platform",
        seat_ref: null,
        status: "active",
        created_at: now,
        updated_at: now,
      }).execute();
      const seed = `${input.idempotency_key}:${membershipId}`;
      const eventId = deriveIdentityCommandId("event_platform_membership", seed);
      await appendProductEvents(tenantTransaction, {
        streamId: membershipId,
        deliveryTarget: "internal_event_stream",
        events: [{
          schema_version: 1,
          event_id: eventId,
          occurred_at: now.toISOString(),
          tenant_id: input.tenant_id,
          request_id: context.requestId,
          trace_id: context.traceId,
          correlation_id: deriveIdentityCommandId("correlation_company", input.idempotency_key),
          causation_id: deriveIdentityCommandId("causation_company", input.idempotency_key),
          event_type: "membership.changed",
          payload: {
            membership_id: membershipId,
            actor_id: assignment.actor_id,
            status: "active",
            reason_code: "platform_role_projected",
            resource_version: 1,
          },
        }],
      });
      await appendAuditEvent(tenantTransaction, {
        schema_version: 1,
        audit_event_id: deriveIdentityCommandId("audit_platform_membership", seed),
        occurred_at: now.toISOString(),
        tenant_id: input.tenant_id,
        actor_id: assignment.actor_id,
        membership_id: membershipId,
        effective_role: "admin",
        action: "identity.platform-membership.project",
        resource_type: "membership",
        resource_id: membershipId,
        decision: "allowed",
        outcome: "succeeded",
        request_id: context.requestId,
        trace_id: context.traceId,
        reason_summary: "Projected platform administrator into new B2B Tenant",
        resource_version: 1,
      });
    }
    const callerMembershipId = platformMembershipId(context.actorId, input.tenant_id);
    if (!assignments.some((assignment) => assignment.actor_id === context.actorId)) {
      throw new DomainError("UNAUTHENTICATED", "Active platform authority changed");
    }
    await trx.insertInto("identity_invitations").values({
      invitation_id: input.invitation.invitation_id,
      tenant_id: input.tenant_id,
      membership_id: input.invitation.membership_id,
      invited_by_actor_id: context.actorId,
      role: "admin",
      secret_digest: issuedSecret.digest,
      normalized_email_hmac: normalizedEmailHmac,
      status: "pending",
      expires_at: new Date(now.getTime() + 7 * dayMs),
      accepted_actor_id: null,
      accepted_at: null,
      replaced_by_invitation_id: null,
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    const invitationEventId = deriveIdentityCommandId("event_invitation", input.idempotency_key);
    await appendProductEvents(tenantTransaction, {
      streamId: input.invitation.invitation_id,
      deliveryTarget: "internal_event_stream",
      events: [{
        schema_version: 1,
        event_id: invitationEventId,
        occurred_at: now.toISOString(),
        tenant_id: input.tenant_id,
        request_id: context.requestId,
        trace_id: context.traceId,
        correlation_id: deriveIdentityCommandId("correlation_company", input.idempotency_key),
        causation_id: deriveIdentityCommandId("causation_company", input.idempotency_key),
        event_type: "invitation.created",
        payload: {
          invitation_id: input.invitation.invitation_id,
          membership_id: input.invitation.membership_id,
          status: "pending",
          resource_version: 1,
        },
      }],
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1,
      audit_event_id: deriveIdentityCommandId("audit_invitation", input.idempotency_key),
      occurred_at: now.toISOString(),
      tenant_id: input.tenant_id,
      actor_id: context.actorId,
      membership_id: callerMembershipId,
      effective_role: "admin",
      action: operation,
      resource_type: "identity_invitation",
      resource_id: input.invitation.invitation_id,
      decision: "allowed",
      outcome: "succeeded",
      request_id: context.requestId,
      trace_id: context.traceId,
      reason_summary: "Created B2B Tenant and first customer administrator invitation",
      resource_version: 1,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      resultRef: input.tenant_id,
      response: storedResult,
      updatedAt: now,
    });
    return Object.freeze({ ...storedResult, invitation_secret: issuedSecret.secret });
  }, { isolationLevel: "serializable" });
}
