import type { CoreSession } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

export interface ReauthenticationDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

const recentReauthenticationMs = 10 * 60 * 1_000;

function requireReauthentication(): never {
  throw new DomainError("UNAUTHENTICATED", "Recent reauthentication is required");
}

async function readDatabaseNow(
  dependencies: ReauthenticationDependencies,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const now = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Reauthentication database clock is invalid");
  }
  return now;
}

export async function requireRecentReauthentication(
  dependencies: ReauthenticationDependencies,
  session: CoreSession,
): Promise<void> {
  if (session.status !== "active" || session.reauthenticated_at === undefined) requireReauthentication();
  const reauthenticatedAt = Date.parse(session.reauthenticated_at);
  if (!Number.isFinite(reauthenticatedAt)) requireReauthentication();
  const now = await dependencies.db.transaction().execute(async (trx) => readDatabaseNow(dependencies, trx));
  const age = now.getTime() - reauthenticatedAt;
  if (age < 0 || age >= recentReauthenticationMs) requireReauthentication();
}
