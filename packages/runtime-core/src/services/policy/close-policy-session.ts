import type { ClosePolicySessionRequest, ClosePolicySessionResponse } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import { lockPolicySession } from "../../repositories/policy/sessions.js";
import { terminatePolicySession } from "./policy-effects.js";

export async function closePolicySession(
  db: Kysely<RuntimeDatabase>, tenantId: string, request: ClosePolicySessionRequest,
): Promise<ClosePolicySessionResponse> {
  return withDatabaseTransactionRetry(db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const session = await lockPolicySession(trx, tenantId, request.policy_session_id);
    if (session === undefined || session.run_id !== request.run_id) throw new DomainError("RESOURCE_NOT_FOUND", "Policy session is unavailable");
    if (session.state !== "active") {
      if (session.state === "closed" && session.close_reason === request.reason) {
        return { schema_version: 1, policy_session_id: session.policy_session_id, state: "closed" };
      }
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Policy session close conflicts with terminal state");
    }
    if (!await terminatePolicySession(trx, session, now, "closed", request.reason)) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Policy session close lost its transition fence");
    }
    return { schema_version: 1, policy_session_id: session.policy_session_id, state: "closed" };
  });
}
