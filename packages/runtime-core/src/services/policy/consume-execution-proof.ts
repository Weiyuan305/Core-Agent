import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { PolicySessionTable } from "../../db/policy-mcp-tables.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { canonicalizeToolArguments } from "../../policy/canonical-json.js";
import { loadReviewedToolBinding } from "../../repositories/policy/catalog.js";
import { lockExecutionProofByDigest } from "../../repositories/policy/proofs.js";
import { lockPolicySession } from "../../repositories/policy/sessions.js";
import { executionProofDigest, proofDigestMatches, type PolicyProofKey } from "./proof-crypto.js";
import { appendPolicyProofConsumedAudit, terminatePolicySession } from "./policy-effects.js";
import { loadCurrentPolicySessionAuthority, type PolicyRuntimeIdentity } from "./session-authority.js";

export type ConsumeExecutionProofResult = Readonly<
  | { allowed: true; policySessionId: string; decisionId: string; proofId: string; toolCallId: string;
      binding: NonNullable<Awaited<ReturnType<typeof loadReviewedToolBinding>>>; arguments: Readonly<Record<string, unknown>>;
      argumentsHash: string; session: Selectable<PolicySessionTable>; effectiveRole: "admin" | "consultant" | "student" }
  | { allowed: false; reason: "PROOF_INVALID" | "PROOF_EXPIRED" | "PROOF_REPLAYED" | "CURRENT_AUTHORITY_CHANGED" | "SESSION_NOT_ACTIVE" }
>;

export interface ConsumeExecutionProofInput {
  readonly identity: PolicyRuntimeIdentity;
  readonly policySessionId: string;
  readonly proof: unknown;
  readonly toolName: string;
  readonly arguments: unknown;
}

/** Caller-owned transaction variant used to atomically consume a proof and record the requested Tool call. */
export async function consumeExecutionProofInTransaction(
  trx: Transaction<RuntimeDatabase>, proofKey: PolicyProofKey, input: ConsumeExecutionProofInput,
): Promise<ConsumeExecutionProofResult> {
  let canonical;
  try { canonical = canonicalizeToolArguments(input.arguments); } catch { return { allowed: false, reason: "PROOF_INVALID" }; }
  const digest = executionProofDigest(proofKey, input.proof);
  if (digest === undefined) return { allowed: false, reason: "PROOF_INVALID" };
  const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
  const proof = await lockExecutionProofByDigest(trx, input.identity.tenantId, digest);
  if (proof === undefined || !proofDigestMatches(proof.proof_digest, digest)
    || proof.policy_session_id !== input.policySessionId || proof.arguments_hash !== canonical.hash) {
    return { allowed: false, reason: "PROOF_INVALID" };
  }
  if (proof.state === "consumed") return { allowed: false, reason: "PROOF_REPLAYED" };
  if (proof.state !== "issued") return { allowed: false, reason: "PROOF_EXPIRED" };
  if (proof.expires_at <= now) {
    await trx.updateTable("policy_execution_proofs").set({
      state: "expired", invalidated_at: now, resource_version: sql`resource_version + 1`, updated_at: now,
    }).where("tenant_id", "=", input.identity.tenantId).where("proof_id", "=", proof.proof_id)
      .where("state", "=", "issued").execute();
    return { allowed: false, reason: "PROOF_EXPIRED" };
  }
  const session = await lockPolicySession(trx, input.identity.tenantId, proof.policy_session_id);
  if (session === undefined || session.policy_session_id !== input.policySessionId) return { allowed: false, reason: "SESSION_NOT_ACTIVE" };
  if (session.runtime_container_id !== input.identity.runtimeContainerId
    || session.runtime_generation !== input.identity.runtimeGeneration || session.profile_id !== input.identity.profileId) {
    return { allowed: false, reason: "SESSION_NOT_ACTIVE" };
  }
  const currentSession = await loadCurrentPolicySessionAuthority(trx, session, now, input.identity);
  if (!currentSession.current) {
    if (session.state === "active") await terminatePolicySession(trx, session, now,
      session.expires_at <= now ? "expired" : "closed", session.expires_at <= now ? "run_expired" : "authority_changed");
    return { allowed: false, reason: "CURRENT_AUTHORITY_CHANGED" };
  }
  const decision = await trx.selectFrom("policy_decisions").selectAll().where("tenant_id", "=", input.identity.tenantId)
    .where("decision_id", "=", proof.decision_id).executeTakeFirst();
  if (decision?.decision !== "allow" || decision.policy_session_id !== session.policy_session_id
    || decision.public_tool_name !== input.toolName || decision.arguments_hash !== canonical.hash
    || decision.capability_version_id === null) return { allowed: false, reason: "PROOF_INVALID" };
  const currentCapability = await trx.selectFrom("entitlement_snapshot_capabilities")
    .select("capability_version_id").where("tenant_id", "=", input.identity.tenantId)
    .where("profile_id", "=", session.profile_id).where("snapshot_id", "=", session.snapshot_id)
    .where("capability_version_id", "=", decision.capability_version_id).executeTakeFirst();
  if (currentCapability === undefined) return { allowed: false, reason: "CURRENT_AUTHORITY_CHANGED" };
  const binding = await loadReviewedToolBinding(trx, input.toolName);
  if (binding === undefined || binding.mcpToolBindingId !== decision.mcp_tool_binding_id) return { allowed: false, reason: "PROOF_INVALID" };
  const updated = await trx.updateTable("policy_execution_proofs").set({
    state: "consumed", consumed_at: now, resource_version: sql`resource_version + 1`, updated_at: now,
  }).where("tenant_id", "=", input.identity.tenantId).where("proof_id", "=", proof.proof_id)
    .where("state", "=", "issued").returning(["proof_id", "resource_version"]).executeTakeFirst();
  if (updated === undefined) return { allowed: false, reason: "PROOF_REPLAYED" };
  await appendPolicyProofConsumedAudit(trx, session, now, {
    proofId: proof.proof_id, decisionId: decision.decision_id,
    resourceVersion: Number(updated.resource_version),
  });
  return { allowed: true, policySessionId: session.policy_session_id, decisionId: decision.decision_id,
    proofId: proof.proof_id, toolCallId: decision.tool_call_id, binding, arguments: canonical.value,
    argumentsHash: canonical.hash, session, effectiveRole: currentSession.effectiveRole };
}

export async function consumeExecutionProof(
  dependencies: { readonly db: Kysely<RuntimeDatabase>; readonly proofKey: PolicyProofKey },
  input: ConsumeExecutionProofInput,
): Promise<ConsumeExecutionProofResult> {
  return withDatabaseTransactionRetry(dependencies.db,
    (trx) => consumeExecutionProofInTransaction(trx, dependencies.proofKey, input));
}
