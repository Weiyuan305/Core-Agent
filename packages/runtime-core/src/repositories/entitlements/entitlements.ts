import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export function lockEntitlement(trx: Transaction<RuntimeDatabase>, entitlementId: string) {
  return trx.selectFrom("entitlements")
    .selectAll()
    .where("entitlement_id", "=", entitlementId)
    .forUpdate()
    .executeTakeFirst();
}

export function claimDueEntitlements(
  trx: Transaction<RuntimeDatabase>,
  now: Date,
  limit = 100,
) {
  return trx.selectFrom("entitlements")
    .selectAll()
    .where("status", "=", "active")
    .where("expires_at", "is not", null)
    .where("expires_at", "<=", now)
    .orderBy("expires_at", "asc")
    .orderBy("tenant_id", "asc")
    .orderBy("entitlement_id", "asc")
    .limit(limit)
    .forUpdate()
    .skipLocked()
    .execute();
}
