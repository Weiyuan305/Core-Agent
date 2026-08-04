import { sql, type Kysely } from "kysely";
import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId } from "../db/transaction.js";

const runtimeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export async function withRuntimeAdvisoryLock<T>(db: Kysely<RuntimeDatabase>, tenantId: string, runtimeId: string, work: () => Promise<T>): Promise<T> {
  assertTenantId(tenantId);
  if (!runtimeIdPattern.test(runtimeId)) throw new Error("Invalid runtime ID");
  const key = `${tenantId}:${runtimeId}`;
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(hashtextextended(${key}, 0))`.execute(connection);
    try { return await work(); }
    finally { await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(connection); }
  });
}
