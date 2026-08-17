import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import { lockCoreSessionById } from "../../repositories/identity/core-sessions.js";

export interface ReauthenticationContext {
  readonly trx: Transaction<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface RequireRecentReauthenticationInput {
  readonly actorId: string;
  readonly sessionId: string;
}

const recentReauthenticationMs = 10 * 60 * 1_000;

function requireReauthentication(): never {
  throw new DomainError("UNAUTHENTICATED", "Recent reauthentication is required");
}

async function readDatabaseNow(
  context: ReauthenticationContext,
): Promise<Date> {
  const now = context.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(context.trx)).rows[0]?.now
    : await context.databaseNow(context.trx);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Reauthentication database clock is invalid");
  }
  return now;
}

/**
 * Locks and verifies current Session authority. The protected mutation must use
 * the same transaction so this row lock remains held through the mutation.
 */
export async function requireRecentReauthentication(
  context: ReauthenticationContext,
  input: RequireRecentReauthenticationInput,
): Promise<void> {
  if (
    typeof input.actorId !== "string"
    || input.actorId.length < 1
    || typeof input.sessionId !== "string"
    || input.sessionId.length < 1
  ) requireReauthentication();

  const stored = await lockCoreSessionById(context.trx, input.actorId, input.sessionId);
  if (stored?.session.status !== "active" || stored.session.reauthenticated_at === undefined) {
    requireReauthentication();
  }
  const now = await readDatabaseNow(context);
  const idleExpiresAt = Date.parse(stored.session.idle_expires_at);
  const absoluteExpiresAt = Date.parse(stored.session.absolute_expires_at);
  const reauthenticatedAt = Date.parse(stored.session.reauthenticated_at);
  if (
    !Number.isFinite(idleExpiresAt)
    || !Number.isFinite(absoluteExpiresAt)
    || !Number.isFinite(reauthenticatedAt)
    || now.getTime() >= idleExpiresAt
    || now.getTime() >= absoluteExpiresAt
  ) requireReauthentication();
  const age = now.getTime() - reauthenticatedAt;
  if (age < 0 || age >= recentReauthenticationMs) requireReauthentication();
}
