import type { CoreSession } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import {
  lockCoreSessionById,
  updateCoreSessionReauthentication,
} from "../../repositories/identity/core-sessions.js";
import type { VerifiedAuthSubjectInput } from "./register-b2c.js";

export interface ReauthenticationDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface CurrentCoreSessionAuthorityInput {
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly sessionId: string;
}

export interface EstablishRecentReauthenticationInput extends CurrentCoreSessionAuthorityInput {
  readonly verifiedPasswordSubject: VerifiedAuthSubjectInput;
}

export interface EstablishedReauthentication {
  readonly schema_version: 1;
  readonly reauthenticated_at: string;
  readonly valid_until: string;
  readonly session_resource_version: number;
}

export interface RecentReauthenticationContext {
  readonly trx: Transaction<RuntimeDatabase>;
  readonly session: CoreSession;
  readonly actor: {
    readonly actorId: string;
    readonly status: "active";
  };
  readonly authSubject: {
    readonly authSubjectId: string;
    readonly actorId: string;
    readonly provider: "supabase";
    readonly providerSubject: string;
    readonly identityKind: "email_password" | "apple";
    readonly status: "active";
  };
  readonly reauthenticatedAt: string;
  readonly validUntil: string;
}

export type ProtectedReauthenticatedMutation<T> = (
  context: RecentReauthenticationContext,
) => Promise<T>;

interface LockedCurrentAuthority {
  readonly session: CoreSession;
  readonly actor: RecentReauthenticationContext["actor"];
  readonly authSubject: RecentReauthenticationContext["authSubject"];
  readonly now: Date;
}

const recentReauthenticationMs = 10 * 60 * 1_000;

function requireReauthentication(): never {
  throw new DomainError("UNAUTHENTICATED", "Recent reauthentication is required");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function validDate(value: Date | undefined, message: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", message);
  }
  return new Date(value);
}

async function readDatabaseNow(
  dependencies: ReauthenticationDependencies,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const now = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  return validDate(now, "Reauthentication database clock is invalid");
}

function assertAuthorityInput(input: CurrentCoreSessionAuthorityInput): void {
  if (!validId(input.actorId) || !validId(input.authSubjectId) || !validId(input.sessionId)) {
    requireReauthentication();
  }
}

function sessionExpiry(session: CoreSession): { idle: number; absolute: number } {
  const idle = Date.parse(session.idle_expires_at);
  const absolute = Date.parse(session.absolute_expires_at);
  if (!Number.isFinite(idle) || !Number.isFinite(absolute)) {
    throw new DomainError("INTERNAL_ERROR", "Stored Core Session lifetime is invalid");
  }
  return { idle, absolute };
}

function validityBoundary(session: CoreSession, reauthenticatedAt: number): number {
  const expiry = sessionExpiry(session);
  return Math.min(reauthenticatedAt + recentReauthenticationMs, expiry.idle, expiry.absolute);
}

/** Locks current authority in the canonical Actor -> AuthSubject -> Session order. */
async function lockCurrentCoreSessionAuthority(
  dependencies: ReauthenticationDependencies,
  trx: Transaction<RuntimeDatabase>,
  input: CurrentCoreSessionAuthorityInput,
): Promise<LockedCurrentAuthority> {
  assertAuthorityInput(input);
  const actorRow = await trx.selectFrom("actors").select(["actor_id", "status"])
    .where("actor_id", "=", input.actorId)
    .forShare()
    .executeTakeFirst();
  if (actorRow?.status !== "active") requireReauthentication();

  const subjectRow = await trx.selectFrom("auth_subjects").select([
    "auth_subject_id", "actor_id", "provider", "provider_subject", "provider_identity_kind", "status",
  ]).where("auth_subject_id", "=", input.authSubjectId)
    .where("actor_id", "=", input.actorId)
    .forShare()
    .executeTakeFirst();
  if (subjectRow?.status !== "active") requireReauthentication();

  const stored = await lockCoreSessionById(trx, input.actorId, input.sessionId);
  if (
    stored?.session.status !== "active"
    || stored.session.auth_subject_id !== input.authSubjectId
  ) requireReauthentication();

  const now = await readDatabaseNow(dependencies, trx);
  const expiry = sessionExpiry(stored.session);
  if (now.getTime() >= expiry.idle || now.getTime() >= expiry.absolute) requireReauthentication();

  return {
    session: stored.session,
    actor: Object.freeze({ actorId: actorRow.actor_id, status: "active" }),
    authSubject: Object.freeze({
      authSubjectId: subjectRow.auth_subject_id,
      actorId: subjectRow.actor_id,
      provider: subjectRow.provider,
      providerSubject: subjectRow.provider_subject,
      identityKind: subjectRow.provider_identity_kind,
      status: "active",
    }),
    now,
  };
}

function matchesVerifiedPasswordSubject(
  authority: LockedCurrentAuthority["authSubject"],
  verified: VerifiedAuthSubjectInput,
): boolean {
  return verified !== null
    && typeof verified === "object"
    && verified.provider === "supabase"
    && verified.identityKind === "email_password"
    && typeof verified.providerSubject === "string"
    && verified.providerSubject === authority.providerSubject
    && verified.provider === authority.provider
    && typeof verified.normalizedEmail === "string"
    && verified.normalizedEmail.length >= 1
    && typeof verified.verifiedAt === "string"
    && Number.isFinite(Date.parse(verified.verifiedAt));
}

/** Persists a verified password reauthentication against current Core authority. */
export async function establishRecentReauthentication(
  dependencies: ReauthenticationDependencies,
  input: EstablishRecentReauthenticationInput,
): Promise<EstablishedReauthentication> {
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const locked = await lockCurrentCoreSessionAuthority(dependencies, trx, input);
    if (!matchesVerifiedPasswordSubject(locked.authSubject, input.verifiedPasswordSubject)) {
      requireReauthentication();
    }
    const updated = await updateCoreSessionReauthentication(trx, {
      sessionId: locked.session.session_id,
      now: locked.now,
      expectedResourceVersion: locked.session.resource_version,
    });
    const reauthenticatedAt = locked.now.getTime();
    return Object.freeze({
      schema_version: 1,
      reauthenticated_at: locked.now.toISOString(),
      valid_until: new Date(validityBoundary(updated.session, reauthenticatedAt)).toISOString(),
      session_resource_version: updated.session.resource_version,
    });
  });
}

/** Executes the protected mutation while retaining all current-authority locks. */
export async function requireRecentReauthentication<T>(
  dependencies: ReauthenticationDependencies,
  input: CurrentCoreSessionAuthorityInput,
  mutation: ProtectedReauthenticatedMutation<T>,
): Promise<T> {
  if (typeof mutation !== "function") requireReauthentication();
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const locked = await lockCurrentCoreSessionAuthority(dependencies, trx, input);
    if (locked.session.reauthenticated_at === undefined) requireReauthentication();
    const reauthenticatedAt = Date.parse(locked.session.reauthenticated_at);
    if (!Number.isFinite(reauthenticatedAt)) {
      throw new DomainError("INTERNAL_ERROR", "Stored Core Session reauthentication is invalid");
    }
    const validUntil = validityBoundary(locked.session, reauthenticatedAt);
    const age = locked.now.getTime() - reauthenticatedAt;
    if (age < 0 || age >= recentReauthenticationMs || locked.now.getTime() >= validUntil) {
      requireReauthentication();
    }
    return mutation(Object.freeze({
      trx,
      session: locked.session,
      actor: locked.actor,
      authSubject: locked.authSubject,
      reauthenticatedAt: locked.session.reauthenticated_at,
      validUntil: new Date(validUntil).toISOString(),
    }));
  });
}
