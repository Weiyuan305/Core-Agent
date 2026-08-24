import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export function lockEntitlementAssignments(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  entitlementId: string,
) {
  return trx.selectFrom("entitlement_assignments")
    .selectAll()
    .where("tenant_id", "=", tenantId)
    .where("entitlement_id", "=", entitlementId)
    .orderBy("profile_id", "asc")
    .orderBy("assignment_id", "asc")
    .forUpdate()
    .execute();
}

export function discoverAssignment(trx: Transaction<RuntimeDatabase>, assignmentId: string) {
  return trx.selectFrom("entitlement_assignments")
    .select(["tenant_id", "entitlement_id", "profile_id"])
    .where("assignment_id", "=", assignmentId)
    .executeTakeFirst();
}
