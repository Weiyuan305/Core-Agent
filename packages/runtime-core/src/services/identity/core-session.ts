import type { CoreSession } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import {
  discoverCoreSessionBySecret,
  expireCoreSession,
  insertCoreSession,
  issueOpaqueCoreSessionCredential,
  lockCoreSessionById,
  lockCoreSessionCredential,
  publicCoreSessionInvalid,
  revokeCoreSessionsByScope,
  revokeLockedCoreSession,
  updateCoreSessionActivity,
  type CoreSessionRandomBytes,
} from "../../repositories/identity/core-sessions.js";
import {
  loadActorIdentityAuthority,
  type ActorIdentityAuthority,
} from "../../repositories/identity/identity-authority.js";

export interface CoreSessionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly randomBytes?: CoreSessionRandomBytes;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface IssueCoreSessionInput {
  readonly sessionId: string;
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly clientKind: "web" | "iphone" | "macos";
  readonly deviceLabel?: string;
}

export interface IssuedCoreSession {
  readonly session: CoreSession;
  readonly sessionSecret: string;
  readonly csrfSecret?: string;
}

export interface AuthenticateCoreSessionInput {
  readonly sessionSecret: string;
  readonly csrfSecret?: string;
  readonly requireCsrf?: boolean;
}

export interface CoreSessionAuthSubjectAuthority {
  readonly authSubjectId: string;
  readonly actorId: string;
  readonly provider: "supabase";
  readonly identityKind: "email_password" | "apple";
  readonly status: "active" | "unlinked" | "revoked";
}

export interface AuthenticatedCoreSession {
  readonly session: CoreSession;
  readonly authority: ActorIdentityAuthority;
  readonly authSubject: CoreSessionAuthSubjectAuthority;
}

export interface RevokeCoreSessionInput {
  readonly actorId: string;
  readonly sessionId: string;
  readonly reason: "user_sign_out" | "administrator_revoked";
}

export type RevokeCoreSessionsInput =
  | {
    readonly actorId: string;
    readonly reason: "password_reset" | "actor_disabled" | "account_deletion_requested" | "administrator_revoked";
  }
  | {
    readonly actorId: string;
    readonly authSubjectId: string;
    readonly reason: "provider_unlinked";
  };

const dayMs = 24 * 60 * 60 * 1_000;

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function validClock(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Core Session database clock is invalid");
  }
  return new Date(value);
}

async function databaseNow(
  dependencies: Pick<CoreSessionDependencies, "databaseNow">,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  if (dependencies.databaseNow !== undefined) return validClock(await dependencies.databaseNow(trx));
  const row = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0];
  if (row === undefined) throw new DomainError("INTERNAL_ERROR", "Core Session database clock is unavailable");
  return validClock(row.now);
}

function assertIssueInput(input: IssueCoreSessionInput): void {
  if (
    !validId(input.sessionId)
    || !validId(input.actorId)
    || !validId(input.authSubjectId)
    || (input.clientKind !== "web" && input.clientKind !== "iphone" && input.clientKind !== "macos")
    || (input.deviceLabel !== undefined && (
      typeof input.deviceLabel !== "string"
      || input.deviceLabel.length < 1
      || input.deviceLabel.length > 80
    ))
  ) throw new DomainError("INVALID_REQUEST", "Core Session issuance input is invalid");
}

export async function issueCoreSession(
  dependencies: CoreSessionDependencies,
  input: IssueCoreSessionInput,
): Promise<IssuedCoreSession> {
  assertIssueInput(input);
  const sessionCredential = issueOpaqueCoreSessionCredential(dependencies.randomBytes);
  let csrfCredential: ReturnType<typeof issueOpaqueCoreSessionCredential> | undefined;
  try {
    csrfCredential = input.clientKind === "web"
      ? issueOpaqueCoreSessionCredential(dependencies.randomBytes)
      : undefined;
    const session = await withDatabaseTransactionRetry(dependencies.db, async (trx) => {
      const now = await databaseNow(dependencies, trx);
      const actor = await trx.selectFrom("actors").select("status")
        .where("actor_id", "=", input.actorId)
        .forShare()
        .executeTakeFirst();
      if (actor?.status !== "active") {
        throw new DomainError("UNAUTHENTICATED", "Active Actor authority is required for Core Session issuance");
      }
      const authSubject = await trx.selectFrom("auth_subjects")
        .select(["actor_id", "status"])
        .where("auth_subject_id", "=", input.authSubjectId)
        .forShare()
        .executeTakeFirst();
      if (authSubject?.actor_id !== input.actorId || authSubject.status !== "active") {
        throw new DomainError("UNAUTHENTICATED", "Active AuthSubject authority is required for Core Session issuance");
      }
      const absoluteExpiresAt = new Date(now.getTime() + 30 * dayMs);
      const stored = await insertCoreSession(trx, {
        sessionId: input.sessionId,
        secretDigest: sessionCredential.digest,
        csrfDigest: csrfCredential?.digest ?? null,
        actorId: input.actorId,
        authSubjectId: input.authSubjectId,
        clientKind: input.clientKind,
        deviceLabel: input.deviceLabel ?? null,
        now,
        idleExpiresAt: new Date(now.getTime() + 7 * dayMs),
        absoluteExpiresAt,
      });
      return stored.session;
    });
    return Object.freeze({
      session,
      sessionSecret: sessionCredential.secret,
      ...(csrfCredential === undefined ? {} : { csrfSecret: csrfCredential.secret }),
    });
  } finally {
    sessionCredential.clear();
    csrfCredential?.clear();
  }
}

export async function authenticateCoreSession(
  dependencies: CoreSessionDependencies,
  input: AuthenticateCoreSessionInput,
): Promise<AuthenticatedCoreSession> {
  if (typeof input.sessionSecret !== "string" || input.requireCsrf !== undefined && typeof input.requireCsrf !== "boolean") {
    publicCoreSessionInvalid();
  }
  const authenticated = await withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const discovered = await discoverCoreSessionBySecret(trx, input.sessionSecret);
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", discovered.actorId)
      .forShare()
      .executeTakeFirst();
    if (actor?.status !== "active") return undefined;

    const preliminarySession = await trx.selectFrom("core_sessions")
      .select("auth_subject_id")
      .where("session_id", "=", discovered.sessionId)
      .where("actor_id", "=", discovered.actorId)
      .executeTakeFirst();
    if (preliminarySession === undefined) return undefined;
    const subjectRow = await trx.selectFrom("auth_subjects")
      .select(["auth_subject_id", "actor_id", "provider", "provider_identity_kind", "status"])
      .where("auth_subject_id", "=", preliminarySession.auth_subject_id)
      .forShare()
      .executeTakeFirst();
    if (subjectRow?.actor_id !== discovered.actorId || subjectRow.status !== "active") return undefined;

    const stored = await lockCoreSessionCredential(trx, {
      sessionId: discovered.sessionId,
      actorId: discovered.actorId,
      sessionSecret: input.sessionSecret,
      ...(input.csrfSecret === undefined ? {} : { csrfSecret: input.csrfSecret }),
      ...(input.requireCsrf === undefined ? {} : { requireCsrf: input.requireCsrf }),
    });
    if (stored.session.status !== "active") return undefined;
    const now = await databaseNow(dependencies, trx);
    const idleExpiry = Date.parse(stored.session.idle_expires_at);
    const absoluteExpiry = Date.parse(stored.session.absolute_expires_at);
    if (now.getTime() >= idleExpiry || now.getTime() >= absoluteExpiry) {
      await expireCoreSession(trx, stored.session.session_id, now, stored.session.resource_version);
      return undefined;
    }
    const authority = await loadActorIdentityAuthority(trx, discovered.actorId);
    if (authority.actorStatus !== "active") return undefined;
    const nextIdleExpiry = new Date(Math.min(now.getTime() + 7 * dayMs, absoluteExpiry));
    const updated = await updateCoreSessionActivity(trx, {
      sessionId: stored.session.session_id,
      now,
      idleExpiresAt: nextIdleExpiry,
      expectedResourceVersion: stored.session.resource_version,
    });
    const authSubject: CoreSessionAuthSubjectAuthority = Object.freeze({
      authSubjectId: subjectRow.auth_subject_id,
      actorId: subjectRow.actor_id,
      provider: subjectRow.provider,
      identityKind: subjectRow.provider_identity_kind,
      status: subjectRow.status,
    });
    return Object.freeze({ session: updated.session, authority, authSubject });
  });
  if (authenticated === undefined) publicCoreSessionInvalid();
  return authenticated;
}

function assertRevokeIdentity(actorId: string, sessionId?: string): void {
  if (!validId(actorId) || sessionId !== undefined && !validId(sessionId)) {
    throw new DomainError("INVALID_REQUEST", "Core Session revocation input is invalid");
  }
}

export async function revokeCoreSession(
  dependencies: CoreSessionDependencies,
  input: RevokeCoreSessionInput,
): Promise<CoreSession> {
  assertRevokeIdentity(input.actorId, input.sessionId);
  if (input.reason !== "user_sign_out" && input.reason !== "administrator_revoked") {
    throw new DomainError("INVALID_REQUEST", "Core Session revocation reason is invalid");
  }
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const actor = await trx.selectFrom("actors").select("actor_id")
      .where("actor_id", "=", input.actorId)
      .forUpdate()
      .executeTakeFirst();
    if (actor === undefined) publicCoreSessionInvalid();
    const stored = await lockCoreSessionById(trx, input.actorId, input.sessionId);
    if (stored === undefined) publicCoreSessionInvalid();
    if (stored.session.status === "revoked") return stored.session;
    const now = await databaseNow(dependencies, trx);
    const revoked = await revokeLockedCoreSession(trx, {
      sessionId: input.sessionId,
      reason: input.reason,
      now,
      expectedResourceVersion: stored.session.resource_version,
    });
    return revoked.session;
  });
}

export async function revokeCoreSessions(
  dependencies: CoreSessionDependencies,
  input: RevokeCoreSessionsInput,
): Promise<number> {
  assertRevokeIdentity(input.actorId);
  const hasAuthSubjectId = Object.hasOwn(input, "authSubjectId");
  const actorScopedReason = input.reason === "password_reset"
    || input.reason === "actor_disabled"
    || input.reason === "account_deletion_requested"
    || input.reason === "administrator_revoked";
  if (
    input.reason === "provider_unlinked"
      ? !hasAuthSubjectId || !validId(input.authSubjectId)
      : !actorScopedReason || hasAuthSubjectId
  ) {
    throw new DomainError("INVALID_REQUEST", "Core Session revocation input is invalid");
  }
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const actor = await trx.selectFrom("actors").select("actor_id")
      .where("actor_id", "=", input.actorId)
      .forUpdate()
      .executeTakeFirst();
    if (actor === undefined) publicCoreSessionInvalid();
    if (input.reason === "provider_unlinked") {
      const subject = await trx.selectFrom("auth_subjects").select("actor_id")
        .where("auth_subject_id", "=", input.authSubjectId)
        .forUpdate()
        .executeTakeFirst();
      if (subject?.actor_id !== input.actorId) publicCoreSessionInvalid();
    }
    const now = await databaseNow(dependencies, trx);
    return revokeCoreSessionsByScope(trx, {
      actorId: input.actorId,
      ...(input.reason === "provider_unlinked" ? { authSubjectId: input.authSubjectId } : {}),
      reason: input.reason,
      now,
    });
  });
}
