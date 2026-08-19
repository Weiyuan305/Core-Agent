import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { CoreSession } from "@core-agent/contracts";

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
import { appendAuditEvent, appendProductEvents } from "../../repositories/events.js";
import { readAccountDeletionFinalizationFacts } from "../../repositories/identity/account-deletions.js";
import {
  discoverCoreSessionBySecret,
  lockCoreSessionCredential,
} from "../../repositories/identity/core-sessions.js";
import { deriveIdentityCommandId } from "../../repositories/identity/invitations.js";
import { revokeCoreSessionsInTransaction } from "./core-session.js";
import { requireRecentReauthentication, type CurrentCoreSessionAuthorityInput } from "./reauthentication.js";
import type { VerifiedAuthSubjectInput } from "./register-b2c.js";

const requestOperation = "identity.account-deletion.request";
const cancelOperation = "identity.account-deletion.cancel";
const dayMs = 24 * 60 * 60 * 1_000;
const recoveryMs = 30 * dayMs;
const recentReauthenticationMs = 10 * 60 * 1_000;

export interface AccountDeletionEntitlementRevocationPort {
  revokeInTransaction(input: {
    readonly trx: Transaction<RuntimeDatabase>;
    readonly actorId: string;
    readonly accountDeletionId: string;
  }): Promise<void>;
}

export interface AccountDeletionRuntimeStopIntentPort {
  stopInTransaction(input: {
    readonly trx: Transaction<RuntimeDatabase>;
    readonly tenantId: string;
    readonly accountDeletionId: string;
    readonly now: Date;
  }): Promise<void>;
}

export interface AccountDeletionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly transaction?: Transaction<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
  readonly entitlementRevocation: AccountDeletionEntitlementRevocationPort;
  readonly runtimeStopIntent: AccountDeletionRuntimeStopIntentPort;
}

export interface AccountDeletionCommandContext extends CurrentCoreSessionAuthorityInput {
  readonly requestId: string;
  readonly traceId: string;
}

export type AccountDeletionCancellationContext = AccountDeletionCommandContext;

export interface AuthenticateAccountDeletionRecoveryInput {
  readonly sessionSecret: string;
  readonly csrfSecret?: string;
  readonly requireCsrf?: boolean;
  /** Internal route binding used only to replay a committed cancellation. */
  readonly allowCancelled?: boolean;
}

export interface AuthenticatedAccountDeletionRecovery {
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly actorResourceVersion: number;
  readonly session: CoreSession;
}

export interface EstablishAccountDeletionRecoveryReauthenticationInput extends CurrentCoreSessionAuthorityInput {
  readonly verifiedPasswordSubject: VerifiedAuthSubjectInput;
  readonly expectedResourceVersion: number;
}

export interface AccountDeletionRequestResult {
  readonly schema_version: 1;
  readonly account_deletion_id: string;
  readonly status: "deletion_pending";
  readonly scheduled_for: string;
  readonly resource_version: number;
}

export interface AccountDeletionCancellationResult {
  readonly schema_version: 1;
  readonly account_deletion_id: string;
  readonly status: "cancelled";
  readonly resource_version: number;
}

export interface AccountDeletionFinalizationFacts {
  readonly kind: "due" | "not_due" | "cancelled" | "deleted" | "not_found";
  readonly providerSubjects: readonly string[];
  readonly nextCursor: string | null;
  readonly done: boolean;
}

export interface AccountDeletionFinalizationResult {
  readonly kind: "deleted" | "already_terminal" | "not_due";
  readonly providerSubjects: readonly string[];
}

interface AccountDeletionRequestCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly expected_resource_version: number;
  readonly reason_code: "user_requested";
}

interface AccountDeletionCancelCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly expected_resource_version: number;
  readonly account_deletion_id: string;
}

interface OrdinaryMembershipRow {
  readonly tenant_id: string;
  readonly tenant_mode: string;
  readonly membership_id: string;
  readonly status: string;
  readonly roles: string[];
  readonly resource_version: string;
  readonly updated_at: Date;
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
  if (!/^\d+$/u.test(value)) throw new DomainError("INTERNAL_ERROR", "Stored identity resource version is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed >= Number.MAX_SAFE_INTEGER) {
    throw new DomainError("INTERNAL_ERROR", "Stored identity resource version is invalid");
  }
  return parsed;
}

function requestPayloadWithoutHash(command: AccountDeletionRequestCommand): Omit<AccountDeletionRequestCommand, "payload_hash"> {
  return {
    schema_version: command.schema_version,
    idempotency_key: command.idempotency_key,
    expected_resource_version: command.expected_resource_version,
    reason_code: command.reason_code,
  };
}

function cancelPayloadWithoutHash(command: AccountDeletionCancelCommand): Omit<AccountDeletionCancelCommand, "payload_hash"> {
  return {
    schema_version: command.schema_version,
    idempotency_key: command.idempotency_key,
    expected_resource_version: command.expected_resource_version,
    account_deletion_id: command.account_deletion_id,
  };
}

function assertRequest(value: unknown): asserts value is AccountDeletionRequestCommand {
  if (!plainObject(value) || !exactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "expected_resource_version", "reason_code",
  ]) || value.schema_version !== 1 || !validId(value.idempotency_key)
    || typeof value.payload_hash !== "string" || value.reason_code !== "user_requested"
    || !Number.isSafeInteger(value.expected_resource_version) || Number(value.expected_resource_version) < 1) {
    throw new DomainError("INVALID_REQUEST", "Account deletion request does not satisfy its contract");
  }
  const command = value as unknown as AccountDeletionRequestCommand;
  if (command.payload_hash !== canonicalPayloadHash(requestPayloadWithoutHash(command))) {
    throw new DomainError("INVALID_REQUEST", "Account deletion payload hash does not match the canonical request");
  }
}

function assertCancellation(value: unknown): asserts value is AccountDeletionCancelCommand {
  if (!plainObject(value) || !exactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "expected_resource_version", "account_deletion_id",
  ]) || value.schema_version !== 1 || !validId(value.idempotency_key) || !validId(value.account_deletion_id)
    || typeof value.payload_hash !== "string"
    || !Number.isSafeInteger(value.expected_resource_version) || Number(value.expected_resource_version) < 1) {
    throw new DomainError("INVALID_REQUEST", "Account deletion cancellation does not satisfy its contract");
  }
  const command = value as unknown as AccountDeletionCancelCommand;
  if (command.payload_hash !== canonicalPayloadHash(cancelPayloadWithoutHash(command))) {
    throw new DomainError("INVALID_REQUEST", "Account deletion payload hash does not match the canonical request");
  }
}

function assertContext(context: AccountDeletionCommandContext): void {
  if (!validId(context.actorId) || !validId(context.authSubjectId) || !validId(context.sessionId)
    || !validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("UNAUTHENTICATED", "Current account deletion authority is required");
  }
}

async function databaseClock(
  dependencies: Pick<AccountDeletionDependencies, "databaseNow">,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const value = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Account deletion database clock is invalid");
  }
  return new Date(value);
}

function accountDeletionId(actorId: string, idempotencyKey: string): string {
  return deriveIdentityCommandId("account_deletion", `${actorId}:${idempotencyKey}`);
}

export function accountDeletionPseudonym(actorId: string): string {
  return `Deleted account ${createHash("sha256").update(actorId, "utf8").digest("hex").slice(0, 16)}`;
}

async function ordinaryMemberships(
  trx: Transaction<RuntimeDatabase>,
  actorId: string,
): Promise<readonly OrdinaryMembershipRow[]> {
  const candidates = await trx.selectFrom("memberships")
    .innerJoin("tenants", "tenants.tenant_id", "memberships.tenant_id")
    .select([
      "memberships.tenant_id", "tenants.tenant_mode", "memberships.membership_id",
      "memberships.status", "memberships.roles", "memberships.resource_version", "memberships.updated_at",
    ])
    .where("memberships.actor_id", "=", actorId)
    .where("memberships.membership_source", "!=", "platform")
    .orderBy("memberships.created_at")
    .orderBy("memberships.tenant_id")
    .execute();
  if (candidates.length === 0) throw new DomainError("INVALID_STATE_TRANSITION", "Account has no durable ordinary identity authority");
  const tenantIds = candidates.map((row) => row.tenant_id);
  await trx.selectFrom("tenants").select("tenant_id").where("tenant_id", "in", tenantIds)
    .orderBy("tenant_id").forUpdate().execute();
  return trx.selectFrom("memberships")
    .innerJoin("tenants", "tenants.tenant_id", "memberships.tenant_id")
    .select([
      "memberships.tenant_id", "tenants.tenant_mode", "memberships.membership_id",
      "memberships.status", "memberships.roles", "memberships.resource_version", "memberships.updated_at",
    ])
    .where("memberships.actor_id", "=", actorId)
    .where("memberships.membership_source", "!=", "platform")
    .orderBy("memberships.created_at")
    .orderBy("memberships.tenant_id")
    .forUpdate("memberships")
    .execute();
}

function auditRole(row: OrdinaryMembershipRow): "admin" | "consultant" | "student" {
  return row.roles.includes("admin") ? "admin" : row.roles.includes("consultant") ? "consultant" : "student";
}

async function appendDeletionEvent(
  tenantTransaction: TenantTransaction,
  context: AccountDeletionCommandContext,
  input: {
    readonly accountDeletionId: string;
    readonly idempotencyKey: string;
    readonly membership: OrdinaryMembershipRow;
    readonly now: Date;
    readonly status: "deletion_pending" | "cancelled" | "deleted";
    readonly resourceVersion: number;
  },
): Promise<void> {
  const seed = `${input.accountDeletionId}:${input.status}:${input.idempotencyKey}`;
  const eventBase = {
    schema_version: 1 as const,
    event_id: deriveIdentityCommandId("event_account_deletion", seed),
    occurred_at: input.now.toISOString(),
    tenant_id: input.membership.tenant_id,
    request_id: context.requestId,
    trace_id: context.traceId,
    correlation_id: deriveIdentityCommandId("correlation_account_deletion", input.accountDeletionId),
    causation_id: deriveIdentityCommandId("causation_account_deletion", input.idempotencyKey),
  };
  const event = input.status === "deletion_pending"
    ? {
        ...eventBase,
        event_type: "account.deletion_requested" as const,
        payload: {
          account_deletion_id: input.accountDeletionId,
          actor_id: context.actorId,
          status: "deletion_pending" as const,
          resource_version: input.resourceVersion,
        },
      }
    : input.status === "cancelled"
      ? {
          ...eventBase,
          event_type: "account.deletion_cancelled" as const,
          payload: {
            account_deletion_id: input.accountDeletionId,
            actor_id: context.actorId,
            status: "cancelled" as const,
            resource_version: input.resourceVersion,
          },
        }
      : {
          ...eventBase,
          event_type: "account.deleted" as const,
          payload: {
            account_deletion_id: input.accountDeletionId,
            actor_id: context.actorId,
            status: "deleted" as const,
            resource_version: input.resourceVersion,
          },
        };
  await appendProductEvents(tenantTransaction, {
    streamId: input.accountDeletionId,
    deliveryTarget: "internal_event_stream",
    events: [event],
  });
  await appendAuditEvent(tenantTransaction, {
    schema_version: 1,
    audit_event_id: deriveIdentityCommandId("audit_account_deletion", seed),
    occurred_at: input.now.toISOString(),
    tenant_id: input.membership.tenant_id,
    actor_id: context.actorId,
    membership_id: input.membership.membership_id,
    effective_role: auditRole(input.membership),
    action: input.status === "deletion_pending" ? requestOperation
      : input.status === "cancelled" ? cancelOperation : "identity.account-deletion.finalize",
    resource_type: "account_deletion",
    resource_id: input.accountDeletionId,
    decision: "allowed",
    outcome: "succeeded",
    request_id: context.requestId,
    trace_id: context.traceId,
    reason_summary: input.status === "deletion_pending"
      ? "Requested recoverable account deletion"
      : input.status === "cancelled" ? "Cancelled recoverable account deletion" : "Finalized account deletion",
    resource_version: input.resourceVersion,
  });
}

export async function requestAccountDeletion(
  dependencies: AccountDeletionDependencies,
  context: AccountDeletionCommandContext,
  value: unknown,
): Promise<AccountDeletionRequestResult> {
  assertRequest(value);
  assertContext(context);
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<AccountDeletionRequestResult> => {
    const actor = await trx.selectFrom("actors").select(["status", "resource_version"])
      .where("actor_id", "=", context.actorId).forUpdate().executeTakeFirstOrThrow();
    if (actor.status === "active") {
      await requireRecentReauthentication({
        trx,
        ...(dependencies.databaseNow === undefined ? {} : { databaseNow: dependencies.databaseNow }),
      }, context);
    } else if (actor.status === "deletion_pending") {
      await lockDeletionRecoveryAuthority(dependencies, trx, context);
    } else {
      throw new DomainError("INVALID_STATE_TRANSITION", "Account deletion is not available in the current Actor state");
    }
    const memberships = await ordinaryMemberships(trx, context.actorId);
    const activeMemberships = memberships.filter((membership) => membership.status === "active");
    const scope = memberships[0]!;
    const now = await databaseClock(dependencies, trx);
    const deletionId = accountDeletionId(context.actorId, value.idempotency_key);
    const scheduledFor = new Date(now.getTime() + recoveryMs);
    const response: AccountDeletionRequestResult = Object.freeze({
      schema_version: 1,
      account_deletion_id: deletionId,
      status: "deletion_pending",
      scheduled_for: scheduledFor.toISOString(),
      resource_version: 1,
    });
    const tenantTransaction: TenantTransaction = { tenantId: scope.tenant_id, trx };
    const admission = await beginIdempotentCommand<AccountDeletionRequestResult>(tenantTransaction, {
      key: value.idempotency_key,
      payloadHash: value.payload_hash,
      operation: requestOperation,
      now,
      expiresAt: scheduledFor,
    });
    if (admission.kind === "replay") return admission.response;
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Account deletion request is already in progress");
    if (actor.status !== "active" || activeMemberships.length !== 1) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Account authority cannot enter deletion");
    }
    if (safeVersion(actor.resource_version) !== value.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Actor version changed");
    }

    await trx.insertInto("account_deletions").values({
      account_deletion_id: deletionId,
      actor_id: context.actorId,
      status: "deletion_pending",
      requested_at: now,
      scheduled_for: scheduledFor,
      cancelled_at: null,
      deleted_at: null,
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    await trx.updateTable("actors").set({
      status: "deletion_pending",
      resource_version: value.expected_resource_version + 1,
      updated_at: now,
    }).where("actor_id", "=", context.actorId).where("resource_version", "=", actor.resource_version).executeTakeFirstOrThrow();
    await revokeCoreSessionsInTransaction(dependencies, trx, {
      actorId: context.actorId,
      reason: "account_deletion_requested",
    });
    await trx.updateTable("core_sessions").set({ reauthenticated_at: null })
      .where("actor_id", "=", context.actorId)
      .where("status", "=", "revoked")
      .where("revocation_reason", "=", "account_deletion_requested")
      .execute();
    for (const membership of activeMemberships) {
      await trx.updateTable("memberships").set({
        status: "revoked",
        resource_version: safeVersion(membership.resource_version) + 1,
        updated_at: now,
      }).where("tenant_id", "=", membership.tenant_id)
        .where("membership_id", "=", membership.membership_id)
        .where("resource_version", "=", membership.resource_version)
        .executeTakeFirstOrThrow();
    }
    await dependencies.entitlementRevocation.revokeInTransaction({
      trx,
      actorId: context.actorId,
      accountDeletionId: deletionId,
    });
    for (const membership of activeMemberships) {
      if (membership.tenant_mode === "b2c") {
        await dependencies.runtimeStopIntent.stopInTransaction({
          trx,
          tenantId: membership.tenant_id,
          accountDeletionId: deletionId,
          now,
        });
      }
    }
    await trx.insertInto("worker_jobs").values({
      tenant_id: scope.tenant_id,
      job_id: deriveIdentityCommandId("job_finalize_account_deletion", deletionId),
      job_kind: "finalize_account_deletion",
      status: "queued",
      attempt_count: 0,
      max_attempts: 5,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: scheduledFor,
      payload_ref: deletionId,
      runtime_command: null,
      target_command_version: null,
      effect_state: "pre_effect",
      last_error_summary: null,
      run_id: null,
      container_id: null,
      created_at: now,
      updated_at: now,
    }).execute();
    await appendDeletionEvent(tenantTransaction, context, {
      accountDeletionId: deletionId,
      idempotencyKey: value.idempotency_key,
      membership: scope,
      now,
      status: "deletion_pending",
      resourceVersion: 1,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: value.idempotency_key,
      payloadHash: value.payload_hash,
      operation: requestOperation,
      resultRef: deletionId,
      response,
      updatedAt: now,
    });
    return response;
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}

function validVerifiedPasswordSubject(subject: VerifiedAuthSubjectInput, storedProviderSubject: string): boolean {
  return plainObject(subject)
    && subject.provider === "supabase"
    && subject.providerSubject === storedProviderSubject
    && subject.identityKind === "email_password"
    && typeof subject.normalizedEmail === "string"
    && subject.normalizedEmail.length >= 1
    && typeof subject.verifiedAt === "string"
    && Number.isFinite(Date.parse(subject.verifiedAt));
}

async function lockDeletionRecoveryAuthority(
  dependencies: Pick<AccountDeletionDependencies, "databaseNow">,
  trx: Transaction<RuntimeDatabase>,
  input: CurrentCoreSessionAuthorityInput & {
    readonly sessionSecret?: string;
    readonly csrfSecret?: string;
    readonly requireCsrf?: boolean;
    readonly allowCancelled?: boolean;
  },
): Promise<{
  readonly actorResourceVersion: number;
  readonly providerSubject: string;
  readonly session: CoreSession;
  readonly now: Date;
}> {
  const actor = await trx.selectFrom("actors").select(["status", "resource_version"])
    .where("actor_id", "=", input.actorId).forUpdate().executeTakeFirst();
  if (actor === undefined || (actor.status !== "deletion_pending"
    && !(input.allowCancelled === true && actor.status === "active"))) {
    throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is required");
  }
  const subject = await trx.selectFrom("auth_subjects")
    .select(["actor_id", "provider_subject", "status"])
    .where("auth_subject_id", "=", input.authSubjectId)
    .where("actor_id", "=", input.actorId).forUpdate().executeTakeFirst();
  if (subject?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is required");
  const stored = input.sessionSecret === undefined
    ? await trx.selectFrom("core_sessions").selectAll()
      .where("session_id", "=", input.sessionId).where("actor_id", "=", input.actorId)
      .forUpdate().executeTakeFirst()
    : (await lockCoreSessionCredential(trx, {
        sessionId: input.sessionId,
        actorId: input.actorId,
        sessionSecret: input.sessionSecret,
        ...(input.csrfSecret === undefined ? {} : { csrfSecret: input.csrfSecret }),
        requireCsrf: input.requireCsrf === true,
      })).session;
  const session = stored === undefined ? undefined : "schema_version" in stored
    ? stored as CoreSession
    : {
        schema_version: 1 as const,
        session_id: stored.session_id,
        actor_id: stored.actor_id,
        auth_subject_id: stored.auth_subject_id,
        client_kind: stored.client_kind,
        status: stored.status,
        ...(stored.device_label === null ? {} : { device_label: stored.device_label }),
        created_at: stored.created_at.toISOString(),
        last_seen_at: stored.last_seen_at.toISOString(),
        idle_expires_at: stored.idle_expires_at.toISOString(),
        absolute_expires_at: stored.absolute_expires_at.toISOString(),
        ...(stored.reauthenticated_at === null ? {} : { reauthenticated_at: stored.reauthenticated_at.toISOString() }),
        ...(stored.revocation_reason === null ? {} : { revocation_reason_code: stored.revocation_reason as "account_deletion_requested" }),
        resource_version: safeVersion(stored.resource_version),
        updated_at: stored.updated_at.toISOString(),
      };
  if (session === undefined || session.auth_subject_id !== input.authSubjectId
    || session.status !== "revoked" || session.revocation_reason_code !== "account_deletion_requested") {
    throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is required");
  }
  const deletion = await trx.selectFrom("account_deletions").select(["status", "scheduled_for"])
    .where("actor_id", "=", input.actorId)
    .forUpdate().executeTakeFirst();
  const now = await databaseClock(dependencies, trx);
  if (deletion === undefined || (deletion.status !== "deletion_pending"
    && !(input.allowCancelled === true && deletion.status === "cancelled"))
    || now.getTime() >= deletion.scheduled_for.getTime()) {
    throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is unavailable");
  }
  return {
    actorResourceVersion: safeVersion(actor.resource_version),
    providerSubject: subject.provider_subject,
    session,
    now,
  };
}

export async function authenticateAccountDeletionRecoverySession(
  dependencies: Pick<AccountDeletionDependencies, "db" | "databaseNow">,
  input: AuthenticateAccountDeletionRecoveryInput,
): Promise<AuthenticatedAccountDeletionRecovery> {
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const discovered = await discoverCoreSessionBySecret(trx, input.sessionSecret);
    const sessionRef = await trx.selectFrom("core_sessions").select("auth_subject_id")
      .where("session_id", "=", discovered.sessionId).where("actor_id", "=", discovered.actorId).executeTakeFirst();
    if (sessionRef === undefined) throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is required");
    const locked = await lockDeletionRecoveryAuthority(dependencies, trx, {
      actorId: discovered.actorId,
      authSubjectId: sessionRef.auth_subject_id,
      sessionId: discovered.sessionId,
      sessionSecret: input.sessionSecret,
      ...(input.csrfSecret === undefined ? {} : { csrfSecret: input.csrfSecret }),
      requireCsrf: input.requireCsrf === true,
      allowCancelled: input.allowCancelled === true,
    });
    return Object.freeze({
      actorId: discovered.actorId,
      authSubjectId: sessionRef.auth_subject_id,
      actorResourceVersion: locked.actorResourceVersion,
      session: locked.session,
    });
  }, { isolationLevel: "serializable" });
}

export async function establishAccountDeletionRecoveryReauthentication(
  dependencies: Pick<AccountDeletionDependencies, "db" | "transaction" | "databaseNow">,
  input: EstablishAccountDeletionRecoveryReauthenticationInput,
): Promise<{
  readonly schema_version: 1;
  readonly reauthenticated_at: string;
  readonly valid_until: string;
  readonly session_resource_version: number;
}> {
  const execute = async (trx: Transaction<RuntimeDatabase>) => {
    const locked = await lockDeletionRecoveryAuthority(dependencies, trx, input);
    if (!validVerifiedPasswordSubject(input.verifiedPasswordSubject, locked.providerSubject)) {
      throw new DomainError("UNAUTHENTICATED", "Deletion recovery provider authority is invalid");
    }
    const version = locked.session.resource_version + 1;
    const row = await trx.updateTable("core_sessions").set({
      reauthenticated_at: locked.now,
      resource_version: version,
      updated_at: locked.now,
    }).where("session_id", "=", input.sessionId)
      .where("status", "=", "revoked")
      .where("revocation_reason", "=", "account_deletion_requested")
      .where("resource_version", "=", locked.session.resource_version.toString())
      .returning("session_id").executeTakeFirst();
    if (row === undefined) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Core Session version changed");
    return Object.freeze({
      schema_version: 1 as const,
      reauthenticated_at: locked.now.toISOString(),
      valid_until: new Date(locked.now.getTime() + recentReauthenticationMs).toISOString(),
      session_resource_version: version,
    });
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}

export async function cancelAccountDeletion(
  dependencies: Pick<AccountDeletionDependencies, "db" | "transaction" | "databaseNow">,
  context: AccountDeletionCancellationContext,
  value: unknown,
): Promise<AccountDeletionCancellationResult> {
  assertCancellation(value);
  assertContext(context);
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<AccountDeletionCancellationResult> => {
    const actor = await trx.selectFrom("actors").select(["status", "resource_version"])
      .where("actor_id", "=", context.actorId).forUpdate().executeTakeFirst();
    if (actor === undefined || (actor.status !== "deletion_pending" && actor.status !== "active")) {
      throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is required");
    }
    const subject = await trx.selectFrom("auth_subjects")
      .select(["actor_id", "provider_subject", "status"])
      .where("auth_subject_id", "=", context.authSubjectId)
      .where("actor_id", "=", context.actorId)
      .forUpdate().executeTakeFirst();
    if (subject?.status !== "active") {
      throw new DomainError("UNAUTHENTICATED", "Deletion recovery authority is required");
    }
    const session = await trx.selectFrom("core_sessions")
      .select(["actor_id", "auth_subject_id", "status", "revocation_reason", "reauthenticated_at"])
      .where("session_id", "=", context.sessionId)
      .where("actor_id", "=", context.actorId)
      .forUpdate().executeTakeFirst();
    const now = await databaseClock(dependencies, trx);
    if (session?.auth_subject_id !== context.authSubjectId || session.status !== "revoked"
      || session.revocation_reason !== "account_deletion_requested" || session.reauthenticated_at === null
      || now.getTime() - session.reauthenticated_at.getTime() < 0
      || now.getTime() - session.reauthenticated_at.getTime() >= recentReauthenticationMs) {
      throw new DomainError("UNAUTHENTICATED", "Recent deletion recovery reauthentication is required");
    }
    const deletion = await trx.selectFrom("account_deletions").selectAll()
      .where("account_deletion_id", "=", value.account_deletion_id)
      .where("actor_id", "=", context.actorId)
      .forUpdate().executeTakeFirst();
    if (deletion === undefined || (deletion.status !== "deletion_pending" && deletion.status !== "cancelled")) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Account deletion is not recoverable");
    }
    if (now.getTime() >= deletion.scheduled_for.getTime()) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Account deletion recovery period has ended");
    }
    const memberships = await ordinaryMemberships(trx, context.actorId);
    const scope = memberships[0]!;
    const tenantTransaction: TenantTransaction = { tenantId: scope.tenant_id, trx };
    const response: AccountDeletionCancellationResult = Object.freeze({
      schema_version: 1,
      account_deletion_id: deletion.account_deletion_id,
      status: "cancelled",
      resource_version: safeVersion(deletion.resource_version) + 1,
    });
    const admission = await beginIdempotentCommand<AccountDeletionCancellationResult>(tenantTransaction, {
      key: value.idempotency_key,
      payloadHash: value.payload_hash,
      operation: cancelOperation,
      now,
      expiresAt: deletion.scheduled_for,
    });
    if (admission.kind === "replay") return admission.response;
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Account deletion cancellation is already in progress");
    if (actor.status !== "deletion_pending" || deletion.status !== "deletion_pending") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Account deletion is not pending");
    }
    if (safeVersion(deletion.resource_version) !== value.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Account deletion version changed");
    }
    await trx.updateTable("actors").set({
      status: "active",
      resource_version: safeVersion(actor.resource_version) + 1,
      updated_at: now,
    }).where("actor_id", "=", context.actorId).where("resource_version", "=", actor.resource_version).executeTakeFirstOrThrow();
    for (const membership of memberships) {
      if (membership.status === "revoked" && membership.updated_at.getTime() === deletion.requested_at.getTime()) {
        await trx.updateTable("memberships").set({
          status: "active",
          resource_version: safeVersion(membership.resource_version) + 1,
          updated_at: now,
        }).where("tenant_id", "=", membership.tenant_id)
          .where("membership_id", "=", membership.membership_id)
          .where("resource_version", "=", membership.resource_version)
          .executeTakeFirstOrThrow();
      }
    }
    await trx.updateTable("account_deletions").set({
      status: "cancelled",
      cancelled_at: now,
      resource_version: response.resource_version,
      updated_at: now,
    }).where("account_deletion_id", "=", deletion.account_deletion_id)
      .where("resource_version", "=", deletion.resource_version).executeTakeFirstOrThrow();
    await appendDeletionEvent(tenantTransaction, context, {
      accountDeletionId: deletion.account_deletion_id,
      idempotencyKey: value.idempotency_key,
      membership: scope,
      now,
      status: "cancelled",
      resourceVersion: response.resource_version,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: value.idempotency_key,
      payloadHash: value.payload_hash,
      operation: cancelOperation,
      resultRef: deletion.account_deletion_id,
      response,
      updatedAt: now,
    });
    return response;
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}

export async function loadAccountDeletionFinalization(
  db: Kysely<RuntimeDatabase>,
  accountDeletionIdValue: string,
  cursor: string | null = null,
  limit = 50,
): Promise<AccountDeletionFinalizationFacts> {
  return readAccountDeletionFinalizationFacts(db, accountDeletionIdValue, cursor, limit);
}

export async function finalizeAccountDeletion(
  dependencies: Pick<AccountDeletionDependencies, "db" | "transaction" | "databaseNow">,
  input: { readonly accountDeletionId: string },
): Promise<AccountDeletionFinalizationResult> {
  if (!validId(input.accountDeletionId)) throw new DomainError("INVALID_REQUEST", "Account deletion ID is invalid");
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<AccountDeletionFinalizationResult> => {
    const deletionReference = await trx.selectFrom("account_deletions").select("actor_id")
      .where("account_deletion_id", "=", input.accountDeletionId).executeTakeFirst();
    if (deletionReference === undefined) {
      return { kind: "already_terminal", providerSubjects: [] };
    }
    const actor = await trx.selectFrom("actors").select(["status", "resource_version"])
      .where("actor_id", "=", deletionReference.actor_id).forUpdate().executeTakeFirstOrThrow();
    const deletion = await trx.selectFrom("account_deletions").selectAll()
      .where("account_deletion_id", "=", input.accountDeletionId)
      .where("actor_id", "=", deletionReference.actor_id).forUpdate().executeTakeFirst();
    if (deletion === undefined || deletion.status === "cancelled" || deletion.status === "deleted") {
      return { kind: "already_terminal", providerSubjects: [] };
    }
    const now = await databaseClock(dependencies, trx);
    if (now.getTime() < deletion.scheduled_for.getTime()) return { kind: "not_due", providerSubjects: [] };
    if (actor.status !== "deletion_pending") throw new DomainError("INVALID_STATE_TRANSITION", "Actor deletion authority changed");
    const memberships = await ordinaryMemberships(trx, deletion.actor_id);
    const scope = memberships[0]!;
    const subjects = await trx.selectFrom("auth_subjects")
      .select(["auth_subject_id", "provider_subject"])
      .where("actor_id", "=", deletion.actor_id)
      .orderBy("provider_subject")
      .forUpdate().execute();
    await trx.updateTable("core_sessions").set({
      status: "revoked",
      revocation_reason: "account_deletion_requested",
      resource_version: sql`resource_version + 1`,
      updated_at: now,
    }).where("actor_id", "=", deletion.actor_id).where("status", "!=", "revoked").execute();
    await trx.deleteFrom("core_sessions").where("actor_id", "=", deletion.actor_id).execute();
    await trx.deleteFrom("auth_subjects").where("actor_id", "=", deletion.actor_id).execute();
    await trx.deleteFrom("private_identity_pii").where("actor_id", "=", deletion.actor_id).execute();
    const deletionVersion = safeVersion(deletion.resource_version) + 1;
    await trx.updateTable("actors").set({
      status: "deleted",
      display_name: accountDeletionPseudonym(deletion.actor_id),
      resource_version: safeVersion(actor.resource_version) + 1,
      updated_at: now,
    }).where("actor_id", "=", deletion.actor_id).where("resource_version", "=", actor.resource_version).executeTakeFirstOrThrow();
    await trx.updateTable("account_deletions").set({
      status: "deleted",
      deleted_at: now,
      resource_version: deletionVersion,
      updated_at: now,
    }).where("account_deletion_id", "=", deletion.account_deletion_id)
      .where("resource_version", "=", deletion.resource_version).executeTakeFirstOrThrow();
    const context: AccountDeletionCommandContext = {
      actorId: deletion.actor_id,
      authSubjectId: subjects[0]?.auth_subject_id ?? "deleted_auth_subject",
      sessionId: "deleted_core_session",
      requestId: deriveIdentityCommandId("request_account_deleted", deletion.account_deletion_id),
      traceId: deriveIdentityCommandId("trace_account_deleted", deletion.account_deletion_id),
    };
    await appendDeletionEvent({ tenantId: scope.tenant_id, trx }, context, {
      accountDeletionId: deletion.account_deletion_id,
      idempotencyKey: deletion.account_deletion_id,
      membership: scope,
      now,
      status: "deleted",
      resourceVersion: deletionVersion,
    });
    return Object.freeze({
      kind: "deleted" as const,
      providerSubjects: Object.freeze(subjects.map((subject) => subject.provider_subject)),
    });
  };
  return dependencies.transaction === undefined
    ? withDatabaseTransactionRetry(dependencies.db, execute, { isolationLevel: "serializable" })
    : execute(dependencies.transaction);
}
