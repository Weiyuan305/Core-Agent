import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "./database.js";

const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface TenantTransaction {
  readonly tenantId: string;
  readonly trx: Transaction<RuntimeDatabase>;
}

export interface TenantDatabaseContext {
  readonly tenantId: string;
  readonly db: Kysely<RuntimeDatabase>;
}

export function assertTenantId(tenantId: string): void {
  if (!tenantIdPattern.test(tenantId)) throw new Error("Invalid tenant ID");
}

export async function withTenantTransaction<T>(
  db: Kysely<RuntimeDatabase>,
  tenantId: string,
  work: (context: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  return db.transaction().execute(async (trx) => work({ tenantId, trx }));
}
