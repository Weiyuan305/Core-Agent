import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { canonicalizeToolArguments } from "../../policy/canonical-json.js";
import { loadReviewedToolBinding } from "../../repositories/policy/catalog.js";
import { lockExecutionProofByDigest } from "../../repositories/policy/proofs.js";
import { lockPolicySession } from "../../repositories/policy/sessions.js";
import { loadCurrentSnapshotAuthority } from "../entitlements/current-authority.js";
import { executionProofDigest, proofDigestMatches, type PolicyProofKey } from "./proof-crypto.js";

export type ConsumeExecutionProofResult = Readonly<
  | { allowed: true; policySessionId: string; decisionId: string; proofId: string; binding: NonNullable<Awaited<ReturnType<typeof loadReviewedToolBinding>>>; arguments: Readonly<Record<string, unknown>> }
  | { allowed: false; reason: "PROOF_INVALID" | "PROOF_EXPIRED" | "PROOF_REPLAYED" | "CURRENT_AUTHORITY_CHANGED" | "SESSION_NOT_ACTIVE" }
>;

export async function consumeExecutionProof(
  dependencies: { readonly db: Kysely<RuntimeDatabase>; readonly proofKey: PolicyProofKey },
  input: { readonly tenantId: string; readonly proof: unknown; readonly toolName: string; readonly arguments: unknown },
): Promise<ConsumeExecutionProofResult> {
  let canonical;
  try { canonical = canonicalizeToolArguments(input.arguments); } catch { return { allowed: false, reason: "PROOF_INVALID" }; }
  const digest = executionProofDigest(dependencies.proofKey, input.proof);
  if (digest === undefined) return { allowed: false, reason: "PROOF_INVALID" };
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const proof = await lockExecutionProofByDigest(trx, input.tenantId, digest);
    if (proof === undefined || !proofDigestMatches(proof.proof_digest, digest) || proof.arguments_hash !== canonical.hash) return { allowed: false, reason: "PROOF_INVALID" };
    if (proof.state === "consumed") return { allowed: false, reason: "PROOF_REPLAYED" };
    if (proof.state !== "issued" || proof.expires_at <= now) return { allowed: false, reason: "PROOF_EXPIRED" };
    const session = await lockPolicySession(trx, input.tenantId, proof.policy_session_id);
    if (session?.state !== "active" || session.expires_at <= now) return { allowed: false, reason: "SESSION_NOT_ACTIVE" };
    const decision = await trx.selectFrom("policy_decisions").selectAll().where("tenant_id", "=", input.tenantId)
      .where("decision_id", "=", proof.decision_id).executeTakeFirst();
    if (decision?.decision !== "allow" || decision.public_tool_name !== input.toolName || decision.arguments_hash !== canonical.hash
      || decision.capability_version_id === null) return { allowed: false, reason: "PROOF_INVALID" };
    const authority = await loadCurrentSnapshotAuthority({ trx, tenantId: input.tenantId, profileId: session.profile_id, now });
    const currentCapability = authority.current ? await trx.selectFrom("entitlement_snapshot_capabilities")
      .select("capability_version_id").where("tenant_id", "=", input.tenantId).where("profile_id", "=", session.profile_id)
      .where("snapshot_id", "=", session.snapshot_id).where("capability_version_id", "=", decision.capability_version_id).executeTakeFirst() : undefined;
    if (!authority.current || authority.snapshotRef.snapshot_id !== session.snapshot_id
      || authority.snapshotRef.version !== Number(session.snapshot_version)
      || authority.snapshotRef.evaluated_at !== session.snapshot_evaluated_at.toISOString() || currentCapability === undefined) {
      await trx.updateTable("policy_execution_proofs").set({ state: "invalidated", invalidated_at: now, resource_version: sql`resource_version + 1`, updated_at: now })
        .where("tenant_id", "=", input.tenantId).where("proof_id", "=", proof.proof_id).where("state", "=", "issued").execute();
      return { allowed: false, reason: "CURRENT_AUTHORITY_CHANGED" };
    }
    const binding = await loadReviewedToolBinding(trx, input.toolName);
    if (binding === undefined || binding.mcpToolBindingId !== decision.mcp_tool_binding_id) return { allowed: false, reason: "PROOF_INVALID" };
    const updated = await trx.updateTable("policy_execution_proofs").set({
      state: "consumed", consumed_at: now, resource_version: sql`resource_version + 1`, updated_at: now,
    }).where("tenant_id", "=", input.tenantId).where("proof_id", "=", proof.proof_id)
      .where("state", "=", "issued").returning("proof_id").executeTakeFirst();
    if (updated === undefined) return { allowed: false, reason: "PROOF_REPLAYED" };
    return { allowed: true, policySessionId: session.policy_session_id, decisionId: decision.decision_id, proofId: proof.proof_id, binding, arguments: canonical.value };
  });
}
