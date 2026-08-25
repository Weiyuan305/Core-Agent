import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export async function loadPolicyDecisionForToolCall(
  trx: Transaction<RuntimeDatabase>, tenantId: string, policySessionId: string, toolCallId: string,
) {
  return trx.selectFrom("policy_decisions").selectAll().where("tenant_id", "=", tenantId)
    .where("policy_session_id", "=", policySessionId).where("tool_call_id", "=", toolCallId)
    .forUpdate().executeTakeFirst();
}
