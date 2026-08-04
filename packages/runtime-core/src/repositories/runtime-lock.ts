import { sql, type Kysely, type Transaction } from "kysely";
import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId } from "../db/transaction.js";

const runtimeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function runtimeAdvisoryLockKey(tenantId: string, runtimeId: string): string {
  assertTenantId(tenantId);
  if (!runtimeIdPattern.test(runtimeId)) throw new Error("Invalid runtime ID");
  return `${tenantId}:${runtimeId}`;
}

export async function acquireRuntimeTransactionAdvisoryLock(
  trx: Transaction<RuntimeDatabase>, tenantId: string, runtimeId: string,
): Promise<void> {
  const key = runtimeAdvisoryLockKey(tenantId, runtimeId);
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

export async function withRuntimeAdvisoryLock<T>(db: Kysely<RuntimeDatabase>, tenantId: string, runtimeId: string, work: () => Promise<T>): Promise<T> {
  const key = runtimeAdvisoryLockKey(tenantId, runtimeId);
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(${key}, 0))`.execute(connection);
    try { return await work(); }
    finally { await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection); }
  });
}
