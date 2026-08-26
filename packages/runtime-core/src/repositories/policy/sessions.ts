import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export async function lockPolicySessionByHermesRef(
  trx: Transaction<RuntimeDatabase>, tenantId: string, hermesSessionRef: string,
) {
  return trx.selectFrom("policy_sessions").selectAll().where("tenant_id", "=", tenantId)
    .where("hermes_session_ref", "=", hermesSessionRef).forUpdate().executeTakeFirst();
}

export async function lockPolicySession(
  trx: Transaction<RuntimeDatabase>, tenantId: string, policySessionId: string,
) {
  return trx.selectFrom("policy_sessions").selectAll().where("tenant_id", "=", tenantId)
    .where("policy_session_id", "=", policySessionId).forUpdate().executeTakeFirst();
}

export async function invalidateIssuedProofs(
  trx: Transaction<RuntimeDatabase>, tenantId: string, policySessionId: string, now: Date,
): Promise<void> {
  await trx.updateTable("policy_execution_proofs").set({
    state: "invalidated", invalidated_at: now, resource_version: sql`resource_version + 1`, updated_at: now,
  }).where("tenant_id", "=", tenantId).where("policy_session_id", "=", policySessionId)
    .where("state", "=", "issued").execute();
}
