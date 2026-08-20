import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { TenantTransaction } from "../../db/transaction.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../../domain/idempotency.js";
import { strictUtcTimestampMilliseconds } from "../../domain/utc-timestamp.js";
import { appendAuditEvent, appendProductEvents } from "../../repositories/events.js";

const operation = "identity.auth-subject.replace";
const dayMs = 24 * 60 * 60 * 1_000;

export interface ReplacementAuthSubjectInput {
  readonly provider: "supabase";
  readonly provider_subject: string;
  readonly provider_identity_kind: "email_password" | "apple" | "email_password_apple";
  readonly verified_at: string;
}

export interface ReplaceAuthProviderSubjectCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly old_auth_subject_id: string;
  readonly expected_resource_version: number;
  readonly new_auth_subject: ReplacementAuthSubjectInput;
}

export interface ReplaceAuthProviderSubjectContext {
  readonly requestId: string;
  readonly traceId: string;
}

export interface ReplaceAuthProviderSubjectDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface ReplaceAuthProviderSubjectResult {
  readonly schema_version: 1;
  readonly actor_id: string;
  readonly old_auth_subject_id: string;
  readonly new_auth_subject_id: string;
  readonly old_auth_subject_resource_version: number;
  readonly new_auth_subject_resource_version: 1;
  readonly revoked_session_count: number;
}

interface MembershipAuthority {
  readonly tenantId: string;
  readonly membershipId: string;
  readonly effectiveRole: "admin" | "consultant" | "student";
}

function invalid(message: string): never {
  throw new DomainError("INVALID_REQUEST", message);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/u.test(value);
}

function safeVersion(value: string): number {
  if (!/^\d+$/u.test(value)) throw new DomainError("INTERNAL_ERROR", "Stored authentication subject version is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError("INTERNAL_ERROR", "Stored authentication subject version is invalid");
  }
  return parsed;
}

function assertCommand(value: unknown): asserts value is ReplaceAuthProviderSubjectCommand {
  if (!plainObject(value) || !exactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "old_auth_subject_id",
    "expected_resource_version", "new_auth_subject",
  ])) invalid("Provider replacement command does not satisfy its contract");
  const replacement = value.new_auth_subject;
  if (!plainObject(replacement) || !exactKeys(replacement, [
    "provider", "provider_subject", "provider_identity_kind", "verified_at",
  ])) invalid("Provider replacement command does not satisfy its contract");
  if (value.schema_version !== 1 || !validId(value.idempotency_key) || !validId(value.old_auth_subject_id)
    || typeof value.payload_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.payload_hash)
    || typeof value.expected_resource_version !== "number"
    || !Number.isSafeInteger(value.expected_resource_version) || value.expected_resource_version < 1
    || replacement.provider !== "supabase"
    || typeof replacement.provider_subject !== "string" || replacement.provider_subject.length < 1
    || replacement.provider_subject.length > 255 || /[\u0000-\u001f\u007f]/u.test(replacement.provider_subject)
    || (replacement.provider_identity_kind !== "email_password" && replacement.provider_identity_kind !== "apple"
      && replacement.provider_identity_kind !== "email_password_apple")
    || typeof replacement.verified_at !== "string"
    || strictUtcTimestampMilliseconds(replacement.verified_at) === undefined) {
    invalid("Provider replacement command does not satisfy its contract");
  }
}

function assertContext(context: ReplaceAuthProviderSubjectContext): void {
  if (!plainObject(context) || !exactKeys(context as unknown as Record<string, unknown>, ["requestId", "traceId"])
    || !validId(context.requestId) || !validId(context.traceId)) {
    invalid("Provider replacement context does not satisfy its contract");
  }
}

function payloadWithoutHash(command: ReplaceAuthProviderSubjectCommand): Omit<ReplaceAuthProviderSubjectCommand, "payload_hash"> {
  return {
    schema_version: command.schema_version,
    idempotency_key: command.idempotency_key,
    old_auth_subject_id: command.old_auth_subject_id,
    expected_resource_version: command.expected_resource_version,
    new_auth_subject: {
      provider: command.new_auth_subject.provider,
      provider_subject: command.new_auth_subject.provider_subject,
      provider_identity_kind: command.new_auth_subject.provider_identity_kind,
      verified_at: command.new_auth_subject.verified_at,
    },
  };
}

function deriveId(prefix: string, identity: string): string {
  const digest = createHash("sha256").update(`identity.auth-subject.replace:${identity}`, "utf8").digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function replacementAuthSubjectId(command: ReplaceAuthProviderSubjectCommand): string {
  return deriveId("auth_subject", `${command.old_auth_subject_id}:${command.idempotency_key}`);
}

function result(input: {
  readonly command: ReplaceAuthProviderSubjectCommand;
  readonly actorId: string;
  readonly revokedSessionCount: number;
}): ReplaceAuthProviderSubjectResult {
  return Object.freeze({
    schema_version: 1,
    actor_id: input.actorId,
    old_auth_subject_id: input.command.old_auth_subject_id,
    new_auth_subject_id: replacementAuthSubjectId(input.command),
    old_auth_subject_resource_version: input.command.expected_resource_version + 1,
    new_auth_subject_resource_version: 1,
    revoked_session_count: input.revokedSessionCount,
  });
}

function replayResult(value: unknown, command: ReplaceAuthProviderSubjectCommand, actorId: string): ReplaceAuthProviderSubjectResult {
  if (!plainObject(value) || !exactKeys(value, [
    "schema_version", "actor_id", "old_auth_subject_id", "new_auth_subject_id",
    "old_auth_subject_resource_version", "new_auth_subject_resource_version", "revoked_session_count",
  ]) || value.schema_version !== 1 || value.actor_id !== actorId
    || value.old_auth_subject_id !== command.old_auth_subject_id
    || value.new_auth_subject_id !== replacementAuthSubjectId(command)
    || value.old_auth_subject_resource_version !== command.expected_resource_version + 1
    || value.new_auth_subject_resource_version !== 1
    || !Number.isSafeInteger(value.revoked_session_count) || Number(value.revoked_session_count) < 0) {
    throw new DomainError("INTERNAL_ERROR", "Stored provider replacement response is invalid");
  }
  return result({ command, actorId, revokedSessionCount: Number(value.revoked_session_count) });
}

async function databaseClock(
  dependencies: ReplaceAuthProviderSubjectDependencies,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const value = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Provider replacement database clock is invalid");
  }
  return new Date(value);
}

function effectiveRole(roles: readonly string[]): "admin" | "consultant" | "student" {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("consultant")) return "consultant";
  if (roles.includes("student")) return "student";
  throw new DomainError("INVALID_STATE_TRANSITION", "Actor has no auditable active Membership role");
}

async function lockMembershipAuthority(
  trx: Transaction<RuntimeDatabase>,
  actorId: string,
): Promise<readonly MembershipAuthority[]> {
  const discovered = await trx.selectFrom("memberships")
    .select(["tenant_id", "membership_id"])
    .where("actor_id", "=", actorId)
    .where("status", "=", "active")
    .orderBy("tenant_id").orderBy("membership_id").execute();
  if (discovered.length === 0) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Actor has no active Membership authority");
  }
  const tenantIds = [...new Set(discovered.map((row) => row.tenant_id))].sort();
  const tenants = await trx.selectFrom("tenants").select(["tenant_id", "status", "created_at"])
    .where("tenant_id", "in", tenantIds).orderBy("tenant_id").forUpdate().execute();
  if (tenants.length !== tenantIds.length || tenants.some((tenant) => tenant.status !== "active")) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Provider replacement requires active Tenant authority");
  }
  const tenantCreatedAt = new Map(tenants.map((tenant) => [tenant.tenant_id, tenant.created_at.getTime()]));
  const memberships = await trx.selectFrom("memberships")
    .select(["tenant_id", "membership_id", "roles", "status", "created_at"])
    .where("actor_id", "=", actorId)
    .where("tenant_id", "in", tenantIds)
    .orderBy("tenant_id").orderBy("membership_id").forUpdate().execute();
  const active = memberships.filter((membership) => membership.status === "active").map((membership) => ({
    tenantId: membership.tenant_id,
    membershipId: membership.membership_id,
    effectiveRole: effectiveRole(membership.roles),
    tenantCreatedAt: tenantCreatedAt.get(membership.tenant_id) ?? Number.MAX_SAFE_INTEGER,
    membershipCreatedAt: membership.created_at.getTime(),
  })).sort((left, right) => left.tenantCreatedAt - right.tenantCreatedAt
    || left.tenantId.localeCompare(right.tenantId)
    || left.membershipCreatedAt - right.membershipCreatedAt
    || left.membershipId.localeCompare(right.membershipId));
  if (active.length !== discovered.length) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Provider replacement Membership authority changed during admission");
  }
  return Object.freeze(active.map(({ tenantId, membershipId, effectiveRole: role }) => Object.freeze({
    tenantId, membershipId, effectiveRole: role,
  })));
}

function ownStringData(value: unknown, key: string): string | undefined {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function mapCollision(error: unknown): never {
  if (ownStringData(error, "code") === "23505"
    && ["auth_subjects_pkey", "auth_subjects_provider_provider_subject_key"].includes(ownStringData(error, "constraint") ?? "")) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "Replacement authentication subject conflicts with existing authority");
  }
  throw error;
}

async function revokeProviderReplacementSessions(
  trx: Transaction<RuntimeDatabase>,
  actorId: string,
  now: Date,
): Promise<number> {
  const update = await trx.updateTable("core_sessions").set({
    status: "revoked",
    revocation_reason: "provider_replaced",
    reauthenticated_at: null,
    resource_version: sql<string>`resource_version + 1`,
    updated_at: now,
  }).where("actor_id", "=", actorId).where("status", "!=", "revoked").executeTakeFirst();
  const count = Number(update.numUpdatedRows);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DomainError("INTERNAL_ERROR", "Provider replacement Session revocation count is invalid");
  }
  return count;
}

export async function replaceAuthProviderSubject(
  dependencies: ReplaceAuthProviderSubjectDependencies,
  context: ReplaceAuthProviderSubjectContext,
  command: ReplaceAuthProviderSubjectCommand,
): Promise<ReplaceAuthProviderSubjectResult> {
  assertCommand(command);
  assertContext(context);
  if (command.payload_hash !== canonicalPayloadHash(payloadWithoutHash(command))) {
    invalid("Provider replacement payload hash does not match the canonical command");
  }

  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const discovered = await trx.selectFrom("auth_subjects").select("actor_id")
      .where("auth_subject_id", "=", command.old_auth_subject_id).executeTakeFirst();
    if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Authentication subject was not found");
    const actor = await trx.selectFrom("actors").select(["actor_id", "status"])
      .where("actor_id", "=", discovered.actor_id).forUpdate().executeTakeFirst();
    if (actor === undefined || actor.status !== "active") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Provider replacement requires an active Actor");
    }
    const oldSubject = await trx.selectFrom("auth_subjects")
      .select(["auth_subject_id", "actor_id", "provider_subject", "status", "resource_version"])
      .where("auth_subject_id", "=", command.old_auth_subject_id).forUpdate().executeTakeFirst();
    if (oldSubject === undefined || oldSubject.actor_id !== actor.actor_id) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Authentication subject was not found");
    }
    const memberships = await lockMembershipAuthority(trx, actor.actor_id);
    const primary = memberships[0]!;
    const primaryContext: TenantTransaction = { tenantId: primary.tenantId, trx };
    const now = await databaseClock(dependencies, trx);
    const admission = await beginIdempotentCommand<ReplaceAuthProviderSubjectResult>(primaryContext, {
      key: command.idempotency_key,
      payloadHash: command.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + 7 * dayMs),
    });
    if (admission.kind === "replay") return replayResult(admission.response, command, actor.actor_id);
    if (admission.kind === "in_progress") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Provider replacement is already in progress");
    }

    const currentVersion = safeVersion(oldSubject.resource_version);
    if (currentVersion !== command.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Authentication subject version changed");
    }
    if (oldSubject.status !== "active") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Only an active authentication subject can be replaced");
    }
    if (oldSubject.provider_subject === command.new_auth_subject.provider_subject) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Replacement authentication subject must be distinct");
    }
    const otherActive = await trx.selectFrom("auth_subjects").select("auth_subject_id")
      .where("actor_id", "=", actor.actor_id).where("status", "=", "active")
      .where("auth_subject_id", "!=", oldSubject.auth_subject_id).forUpdate().executeTakeFirst();
    if (otherActive !== undefined) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Actor already has another active authentication subject");
    }

    const newAuthSubjectId = replacementAuthSubjectId(command);
    await trx.insertInto("auth_subjects").values({
      auth_subject_id: newAuthSubjectId,
      actor_id: actor.actor_id,
      provider: command.new_auth_subject.provider,
      provider_subject: command.new_auth_subject.provider_subject,
      provider_identity_kind: command.new_auth_subject.provider_identity_kind,
      verified_at: new Date(strictUtcTimestampMilliseconds(command.new_auth_subject.verified_at)!),
      status: "active",
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    const revoked = await trx.updateTable("auth_subjects").set({
      status: "revoked",
      resource_version: currentVersion + 1,
      updated_at: now,
    }).where("auth_subject_id", "=", oldSubject.auth_subject_id)
      .where("actor_id", "=", actor.actor_id)
      .where("status", "=", "active")
      .where("resource_version", "=", String(currentVersion)).executeTakeFirst();
    if (Number(revoked.numUpdatedRows) !== 1) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Authentication subject version changed");
    }
    const revokedSessionCount = await revokeProviderReplacementSessions(trx, actor.actor_id, now);

    for (const membership of memberships) {
      const tenantContext: TenantTransaction = { tenantId: membership.tenantId, trx };
      const eventId = deriveId("event_auth_subject_replaced", `${membership.tenantId}:${command.old_auth_subject_id}:${command.idempotency_key}`);
      await appendProductEvents(tenantContext, {
        streamId: actor.actor_id,
        deliveryTarget: "internal_event_stream",
        events: [{
          schema_version: 1,
          event_id: eventId,
          occurred_at: now.toISOString(),
          tenant_id: membership.tenantId,
          request_id: context.requestId,
          trace_id: context.traceId,
          correlation_id: deriveId("correlation_auth_subject", `${actor.actor_id}:${command.idempotency_key}`),
          causation_id: deriveId("causation_auth_subject", `${command.old_auth_subject_id}:${command.idempotency_key}`),
          event_type: "auth_subject.replaced",
          payload: {
            actor_id: actor.actor_id,
            old_auth_subject_id: command.old_auth_subject_id,
            new_auth_subject_id: newAuthSubjectId,
            old_status: "revoked",
            new_status: "active",
            resource_version: currentVersion + 1,
          },
        }],
      });
      await appendAuditEvent(tenantContext, {
        schema_version: 1,
        audit_event_id: deriveId("audit_auth_subject_replaced", `${membership.tenantId}:${command.old_auth_subject_id}:${command.idempotency_key}`),
        occurred_at: now.toISOString(),
        tenant_id: membership.tenantId,
        actor_id: actor.actor_id,
        membership_id: membership.membershipId,
        effective_role: membership.effectiveRole,
        action: operation,
        resource_type: "auth_subject",
        resource_id: command.old_auth_subject_id,
        decision: "allowed",
        outcome: "succeeded",
        request_id: context.requestId,
        trace_id: context.traceId,
        reason_summary: "Replaced authentication subject and revoked existing Core Sessions",
        change_summary: `Authentication authority replaced; ${revokedSessionCount} Core Session(s) revoked`,
        resource_version: currentVersion + 1,
      });
    }

    const response = result({ command, actorId: actor.actor_id, revokedSessionCount });
    await completeIdempotentCommand(primaryContext, {
      key: command.idempotency_key,
      payloadHash: command.payload_hash,
      operation,
      resultRef: newAuthSubjectId,
      response,
      updatedAt: now,
    });
    return response;
  }, { isolationLevel: "serializable" }).catch(mapCollision);
}
