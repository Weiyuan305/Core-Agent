import { createHash } from "node:crypto";

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
  constantTimeDigestMatches,
  deriveIdentityCommandId,
  invitationEmailHmac,
  lockInvitationByDigest,
  lockInvitationBySecret,
  publicInvitationNotFound,
} from "../../repositories/identity/invitations.js";

export interface AcceptInvitationCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly invitation_code: string;
  readonly expected_resource_version: number;
}

export interface AcceptInvitationContext {
  readonly actorId: string;
  readonly normalizedEmail: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface AcceptInvitationDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  /** Caller-owned transaction composes acceptance with registration and Session issuance. */
  readonly transaction?: Transaction<RuntimeDatabase>;
  /** Exact credential already verified and encrypted by the email-verification transaction. */
  readonly verifiedInvitationBinding?: {
    readonly invitationId: string;
    readonly secretDigest: Uint8Array;
    readonly tenantId: string;
    readonly expectedResourceVersion: number;
    readonly role: "admin" | "consultant";
  };
  readonly emailHmacKey: Uint8Array;
  readonly consultantProfile: {
    readonly providerConfigId: string;
    readonly modelId: string;
  };
  readonly now?: () => Date;
}

export interface AcceptInvitationResult {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly invitation_id: string;
  readonly membership_id: string;
  readonly actor_id: string;
  readonly invitation_resource_version: number;
  readonly membership_resource_version: number;
  readonly profile_id?: string;
}

const operation = "identity.invitation.accept";
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

function assertCommand(value: unknown): asserts value is AcceptInvitationCommand {
  if (!isPlainObject(value) || !exactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "invitation_code", "expected_resource_version",
  ]) || value.schema_version !== 1 || !validId(value.idempotency_key) || !validId(value.tenant_id)
    || typeof value.payload_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.payload_hash)
    || typeof value.invitation_code !== "string" || value.invitation_code.length > 128
    || !Number.isSafeInteger(value.expected_resource_version) || Number(value.expected_resource_version) < 1) {
    throw new DomainError("INVALID_REQUEST", "Accept invitation command does not satisfy its contract");
  }
}

function consultantProfileId(actorId: string, tenantId: string): string {
  return `profile_consultant_${createHash("sha256")
    .update(`${actorId}:${tenantId}`, "utf8").digest("hex").slice(0, 32)}`;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored invitation acceptance version is invalid");
  }
  return version;
}

function resultFor(
  command: AcceptInvitationCommand,
  actorId: string,
  invitationId: string,
  membershipId: string,
  role: "admin" | "consultant",
): AcceptInvitationResult {
  return Object.freeze({
    schema_version: 1,
    tenant_id: command.tenant_id,
    invitation_id: invitationId,
    membership_id: membershipId,
    actor_id: actorId,
    invitation_resource_version: command.expected_resource_version + 1,
    membership_resource_version: 1,
    ...(role === "consultant" ? { profile_id: consultantProfileId(actorId, command.tenant_id) } : {}),
  });
}

function assertReplay(value: unknown, expected: AcceptInvitationResult): void {
  if (!isPlainObject(value) || !exactKeys(value, Object.keys(expected))
    || Object.entries(expected).some(([key, item]) => value[key] !== item)) {
    throw new DomainError("INTERNAL_ERROR", "Stored invitation acceptance response is invalid");
  }
}

export async function acceptInvitation(
  dependencies: AcceptInvitationDependencies,
  context: AcceptInvitationContext,
  input: unknown,
): Promise<AcceptInvitationResult> {
  assertCommand(input);
  if (!validId(context.actorId) || !validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("INTERNAL_ERROR", "Invitation acceptance context is invalid");
  }
  const { payload_hash: _payloadHash, ...payload } = input;
  if (input.payload_hash !== canonicalPayloadHash(payload)) {
    throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical invitation acceptance command");
  }
  const observedEmailHmac = invitationEmailHmac(dependencies.emailHmacKey, context.normalizedEmail);
  if (
    dependencies.consultantProfile.providerConfigId.length < 1
    || dependencies.consultantProfile.providerConfigId.length > 255
    || dependencies.consultantProfile.modelId.length < 1
    || dependencies.consultantProfile.modelId.length > 255
  ) throw new DomainError("INTERNAL_ERROR", "Consultant Profile configuration is invalid");

  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<AcceptInvitationResult> => {
    const now = dependencies.now?.() ?? new Date();
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", context.actorId).forUpdate().executeTakeFirst();
    if (actor?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active invitation Actor is required");
    const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
      .where("tenant_id", "=", input.tenant_id).forUpdate().executeTakeFirst();
    if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") publicInvitationNotFound();
    const invitation = dependencies.verifiedInvitationBinding === undefined
      ? await lockInvitationBySecret(trx, input.invitation_code)
      : await lockInvitationByDigest(trx, dependencies.verifiedInvitationBinding.secretDigest);
    if (dependencies.verifiedInvitationBinding !== undefined && (
      invitation.invitationId !== dependencies.verifiedInvitationBinding.invitationId
      || invitation.tenantId !== dependencies.verifiedInvitationBinding.tenantId
      || invitation.resourceVersion !== dependencies.verifiedInvitationBinding.expectedResourceVersion
      || invitation.role !== dependencies.verifiedInvitationBinding.role
    )) publicInvitationNotFound();
    if (invitation.tenantId !== input.tenant_id) publicInvitationNotFound();
    const privatePii = await trx.selectFrom("private_identity_pii").select("normalized_email_hmac")
      .where("actor_id", "=", context.actorId).executeTakeFirst();
    if (
      privatePii === undefined
      || !constantTimeDigestMatches(observedEmailHmac, invitation.normalizedEmailHmac)
      || !constantTimeDigestMatches(observedEmailHmac, privatePii.normalized_email_hmac)
    ) {
      if (invitation.status === "accepted") {
        throw new DomainError("INVALID_STATE_TRANSITION", "Invitation was accepted by different identity authority");
      }
      publicInvitationNotFound();
    }
    if (invitation.status === "accepted" && invitation.acceptedActorId !== context.actorId) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Invitation was accepted by a different Actor");
    }
    const expected = resultFor(input, context.actorId, invitation.invitationId, invitation.membershipId, invitation.role);
    const tenantTransaction: TenantTransaction = { tenantId: input.tenant_id, trx };
    const admission = await beginIdempotentCommand<AcceptInvitationResult>(tenantTransaction, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation, now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      assertReplay(admission.response, expected);
      return expected;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Invitation acceptance is already in progress");
    if (invitation.status === "accepted") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Invitation was already accepted");
    }
    const databaseTimestamp = (await sql<{ now: Date }>`select now() as now`.execute(trx)).rows[0]!.now;
    if (invitation.status !== "pending" || invitation.expiresAt.getTime() <= databaseTimestamp.getTime()) {
      publicInvitationNotFound();
    }
    if (invitation.resourceVersion !== input.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Invitation version changed");
    }
    const authority = await loadActorIdentityAuthority(trx, context.actorId);
    if (authority.memberships.some((membership) => (
      membership.source !== "platform" && (membership.status === "active" || membership.status === "invited")
    ))) throw new DomainError("INVALID_STATE_TRANSITION", "Actor already has ordinary Membership authority");
    const existingMembership = await trx.selectFrom("memberships").select("membership_id")
      .where("tenant_id", "=", input.tenant_id).where("membership_id", "=", invitation.membershipId)
      .forUpdate().executeTakeFirst();
    if (existingMembership !== undefined) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Invitation Membership already exists");
    }
    const profileId = consultantProfileId(context.actorId, input.tenant_id);
    if (invitation.role === "consultant") {
      const existingProfile = await trx.selectFrom("profiles").select("profile_id")
        .where("tenant_id", "=", input.tenant_id).where("profile_id", "=", profileId)
        .forUpdate().executeTakeFirst();
      if (existingProfile !== undefined) throw new DomainError("INVALID_STATE_TRANSITION", "Consultant Profile already exists");
    }
    await trx.insertInto("memberships").values({
      tenant_id: input.tenant_id, membership_id: invitation.membershipId, actor_id: context.actorId,
      schema_version: 1, resource_version: 1, roles: [invitation.role], membership_source: "company",
      seat_ref: null, status: "active", created_at: now, updated_at: now,
    }).execute();
    if (invitation.role === "consultant") {
      await trx.insertInto("profiles").values({
        tenant_id: input.tenant_id, profile_id: profileId, schema_version: 1, resource_version: 1,
        owner_actor_id: context.actorId, profile_kind: "consultant", hermes_profile_ref: `hermes_${profileId}`,
        description: "Company consultant profile", status: "active",
        provider_config_id: dependencies.consultantProfile.providerConfigId,
        model_id: dependencies.consultantProfile.modelId, created_at: now, updated_at: now,
      }).execute();
    }
    await trx.updateTable("identity_invitations").set({
      status: "accepted", accepted_actor_id: context.actorId, accepted_at: now,
      resource_version: invitation.resourceVersion + 1, updated_at: now,
    }).where("invitation_id", "=", invitation.invitationId).execute();
    await loadActorIdentityAuthority(trx, context.actorId);
    const eventId = deriveIdentityCommandId("event_invitation_accept", input.idempotency_key);
    await appendProductEvents(tenantTransaction, {
      streamId: invitation.invitationId,
      deliveryTarget: "internal_event_stream",
      events: [{
        schema_version: 1, event_id: eventId, occurred_at: now.toISOString(), tenant_id: input.tenant_id,
        request_id: context.requestId, trace_id: context.traceId,
        correlation_id: deriveIdentityCommandId("correlation_accept", input.idempotency_key),
        causation_id: deriveIdentityCommandId("causation_accept", input.idempotency_key),
        ...(invitation.role === "consultant" ? { profile_id: profileId } : {}),
        event_type: "invitation.accepted",
        payload: {
          invitation_id: invitation.invitationId, membership_id: invitation.membershipId,
          actor_id: context.actorId, status: "accepted", resource_version: invitation.resourceVersion + 1,
        },
      }],
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1, audit_event_id: deriveIdentityCommandId("audit_invitation_accept", input.idempotency_key),
      occurred_at: now.toISOString(), tenant_id: input.tenant_id, actor_id: context.actorId,
      membership_id: invitation.membershipId, effective_role: invitation.role, action: operation,
      resource_type: "identity_invitation", resource_id: invitation.invitationId,
      decision: "allowed", outcome: "succeeded", request_id: context.requestId, trace_id: context.traceId,
      reason_summary: "Accepted a single-use B2B identity invitation",
      resource_version: invitation.resourceVersion + 1,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: input.idempotency_key, payloadHash: input.payload_hash, operation,
      resultRef: invitation.membershipId, response: expected, updatedAt: now,
    });
    return expected;
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}
