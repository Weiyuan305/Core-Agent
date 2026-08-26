import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { loadCurrentPolicySessionAuthority } from "./session-authority.js";
import { terminatePolicySession } from "./policy-effects.js";

/** Bounded expiry transition for issued proofs that were never presented. */
export async function sweepExpiredPolicyProofs(db: Kysely<RuntimeDatabase>, limit = 500): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Policy proof sweep limit is invalid");
  return withDatabaseTransactionRetry(db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const proofs = await trx.selectFrom("policy_execution_proofs").select(["tenant_id", "proof_id"])
      .where("state", "=", "issued").where("expires_at", "<=", now)
      .orderBy("expires_at", "asc").limit(limit).forUpdate().skipLocked().execute();
    if (proofs.length === 0) return 0;
    let count = 0;
    for (const proof of proofs) {
      const updated = await trx.updateTable("policy_execution_proofs").set({
        state: "expired", invalidated_at: now,
        resource_version: sql`resource_version + 1`, updated_at: now,
      }).where("tenant_id", "=", proof.tenant_id).where("proof_id", "=", proof.proof_id)
        .where("state", "=", "issued").executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 1) count += 1;
    }
    return count;
  });
}

/** Bounded repair for expiry, terminal Runs, revoked identity, and replaced Runtime generations. */
export async function sweepStalePolicySessions(db: Kysely<RuntimeDatabase>, limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Policy Session sweep limit is invalid");
  return withDatabaseTransactionRetry(db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const sessions = await trx.selectFrom("policy_sessions").selectAll().where("state", "=", "active")
      .orderBy("expires_at", "asc").limit(limit).forUpdate().skipLocked().execute();
    let count = 0;
    for (const session of sessions) {
      const authority = await loadCurrentPolicySessionAuthority(trx, session, now);
      if (authority.current) continue;
      const expired = session.expires_at <= now;
      if (await terminatePolicySession(trx, session, now, expired ? "expired" : "closed",
        expired ? "run_expired" : "authority_changed")) count += 1;
    }
    return count;
  });
}
