import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export async function lockExecutionProofByDigest(
  trx: Transaction<RuntimeDatabase>, tenantId: string, proofDigest: Uint8Array,
) {
  return trx.selectFrom("policy_execution_proofs").selectAll().where("tenant_id", "=", tenantId)
    .where("proof_digest", "=", proofDigest).forUpdate().executeTakeFirst();
}

export async function loadExecutionProofForDecision(
  trx: Transaction<RuntimeDatabase>, tenantId: string, decisionId: string,
) {
  return trx.selectFrom("policy_execution_proofs").selectAll().where("tenant_id", "=", tenantId)
    .where("decision_id", "=", decisionId).executeTakeFirst();
}
