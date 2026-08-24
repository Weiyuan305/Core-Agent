import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export function lockTenantPackReleases(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  packProductId: string,
) {
  return trx.selectFrom("tenant_pack_releases")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("pack_product_id", "=", packProductId)
    .orderBy("generation", "asc")
    .forUpdate()
    .execute();
}

export function lockCurrentTenantPackRelease(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  packProductId: string,
) {
  return trx.selectFrom("tenant_pack_releases")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("pack_product_id", "=", packProductId)
    .where("status", "=", "current")
    .forUpdate()
    .executeTakeFirst();
}

export function tenantHasActivePackAuthority(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  packProductId: string,
  now: Date,
) {
  return trx.selectFrom("entitlements")
    .select("entitlement_id")
    .where("tenant_id", "=", tenantId)
    .where("pack_product_id", "=", packProductId)
    .where("status", "=", "active")
    .where("valid_from", "<=", now)
    .where((expression) => expression.or([
      expression("expires_at", "is", null),
      expression("expires_at", ">", now),
    ]))
    .forUpdate()
    .executeTakeFirst();
}
