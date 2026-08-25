import { randomBytes, randomUUID } from "node:crypto";

import type { PolicyDecisionReason, ToolPolicyDecisionRequest, ToolPolicyDecisionResponse } from "@core-agent/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { PolicySessionTable } from "../../db/policy-mcp-tables.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import { canonicalizeToolArguments } from "../../policy/canonical-json.js";
import { evaluateReadMcp } from "../../policy/evaluate-read-mcp.js";
import { loadPolicyDecisionForToolCall } from "../../repositories/policy/decisions.js";
import { loadExecutionProofForDecision } from "../../repositories/policy/proofs.js";
import { lockPolicySessionByHermesRef } from "../../repositories/policy/sessions.js";
import { loadReviewedToolBinding } from "../../repositories/policy/catalog.js";
import { deriveExecutionProof, executionProofDigest, type PolicyProofKey } from "./proof-crypto.js";
import { appendPolicyAuthenticationDenialAudit, appendPolicyDecisionEffect, terminatePolicySession } from "./policy-effects.js";
import { loadCurrentPolicySessionAuthority, type PolicyPluginIdentity } from "./session-authority.js";

export interface IssueToolDecisionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly proofKey: PolicyProofKey;
  readonly maximumProofTtlMs?: number;
}

const denyResponse = (decisionId: string, reason: Exclude<PolicyDecisionReason, "POLICY_ALLOWED">): ToolPolicyDecisionResponse => ({
  schema_version: 1, decision_id: decisionId, decision: "deny", reason,
});

async function recordMatchedSessionDenial(
  trx: Transaction<RuntimeDatabase>, session: Selectable<PolicySessionTable>, now: Date,
  request: ToolPolicyDecisionRequest, argumentsHash: string,
  reason: "SESSION_NOT_ACTIVE" | "CURRENT_AUTHORITY_CHANGED",
): Promise<ToolPolicyDecisionResponse> {
  const existing = await loadPolicyDecisionForToolCall(
    trx, session.tenant_id, session.policy_session_id, request.tool_call_id,
  );
  if (existing !== undefined) {
    await appendPolicyAuthenticationDenialAudit(trx, session, now, reason);
    return denyResponse(`decision-${randomUUID()}`, reason);
  }
  const decisionId = `decision-${randomUUID()}`;
  await trx.insertInto("policy_decisions").values({
    tenant_id: session.tenant_id, decision_id: decisionId, policy_session_id: session.policy_session_id,
    tool_call_id: request.tool_call_id, public_tool_name: request.tool_name,
    capability_version_id: null, mcp_tool_binding_id: null, arguments_hash: argumentsHash,
    decision: "deny", reason_code: reason, policy_version_id: session.policy_version_id,
    resource_version: 1,
  }).execute();
  await appendPolicyDecisionEffect(trx, session, now, {
    decisionId, toolCallId: request.tool_call_id, decision: "deny", reason, resourceVersion: 1,
  });
  return denyResponse(decisionId, reason);
}

export async function issueToolDecision(
  dependencies: IssueToolDecisionDependencies, identity: PolicyPluginIdentity, request: ToolPolicyDecisionRequest,
): Promise<ToolPolicyDecisionResponse> {
  const tenantId = identity.tenantId;
  let canonical;
  try { canonical = canonicalizeToolArguments(request.arguments); } catch { canonical = undefined; }
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const session = await lockPolicySessionByHermesRef(trx, tenantId, request.hermes_session_ref);
    if (session === undefined) return denyResponse(`decision-${randomUUID()}`, "SESSION_NOT_ACTIVE");
    if (session.runtime_container_id !== identity.runtimeContainerId || session.runtime_generation !== identity.runtimeGeneration) {
      await appendPolicyAuthenticationDenialAudit(trx, session, now, "SESSION_NOT_ACTIVE");
      return denyResponse(`decision-${randomUUID()}`, "SESSION_NOT_ACTIVE");
    }
    if (session.state !== "active" || session.expires_at <= now) {
      if (session.state === "active") await terminatePolicySession(trx, session, now, "expired", "run_expired");
      return recordMatchedSessionDenial(trx, session, now, request,
        canonical?.hash ?? `sha256:${"0".repeat(64)}`, "SESSION_NOT_ACTIVE");
    }
    const currentSession = await loadCurrentPolicySessionAuthority(trx, session, now, identity);
    if (!currentSession.current) {
      await terminatePolicySession(trx, session, now, session.expires_at <= now ? "expired" : "closed",
        session.expires_at <= now ? "run_expired" : "authority_changed");
      return recordMatchedSessionDenial(trx, session, now, request,
        canonical?.hash ?? `sha256:${"0".repeat(64)}`, "CURRENT_AUTHORITY_CHANGED");
    }
    const existing = await loadPolicyDecisionForToolCall(trx, tenantId, session.policy_session_id, request.tool_call_id);
    if (existing !== undefined) {
      if (canonical === undefined || existing.public_tool_name !== request.tool_name || existing.arguments_hash !== canonical.hash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Policy decision replay conflicts with reviewed facts");
      }
      if (existing.decision === "deny") return denyResponse(existing.decision_id, existing.reason_code as Exclude<PolicyDecisionReason, "POLICY_ALLOWED">);
      const storedProof = await loadExecutionProofForDecision(trx, tenantId, existing.decision_id);
      if (storedProof?.state !== "issued" || storedProof.expires_at <= now) return denyResponse(existing.decision_id, storedProof?.state === "consumed" ? "PROOF_REPLAYED" : "PROOF_EXPIRED");
      return {
        schema_version: 1, decision_id: existing.decision_id, decision: "allow", reason: "POLICY_ALLOWED",
        execution_proof: deriveExecutionProof(dependencies.proofKey, {
          tenantId, policySessionId: session.policy_session_id, decisionId: existing.decision_id,
          proofId: storedProof.proof_id, argumentsHash: storedProof.arguments_hash,
        }), expires_at: storedProof.expires_at.toISOString(),
      };
    }
    const decisionId = `decision-${randomUUID()}`;
    const binding = await loadReviewedToolBinding(trx, request.tool_name);
    const authority = currentSession.snapshot;
    const capabilityVersions = await trx.selectFrom("entitlement_snapshot_capabilities")
      .select(["capability_version_id", "capability_id"]).where("tenant_id", "=", tenantId)
      .where("profile_id", "=", session.profile_id).where("snapshot_id", "=", session.snapshot_id).execute();
    const selected = binding === undefined ? undefined : capabilityVersions.find((row) => row.capability_version_id === binding.capabilityVersionId);
    const result = canonical === undefined ? { decision: "deny" as const, reason: "ARGUMENTS_INVALID" as const } : evaluateReadMcp({
      session: {
        active: session.state === "active" && session.expires_at > now,
        snapshotMatches: authority.current && authority.snapshotRef.snapshot_id === session.snapshot_id
          && authority.snapshotRef.version === Number(session.snapshot_version)
          && authority.snapshotRef.evaluated_at === session.snapshot_evaluated_at.toISOString(),
      },
      authority: { current: authority.current, capabilityVersionIds: capabilityVersions.map((row) => row.capability_version_id) },
      capability: selected === undefined || binding === undefined ? null : {
        capabilityVersionId: binding.capabilityVersionId, kind: "mcp", riskClass: "read", approvalRequirement: "none", status: "reviewed",
      },
      binding: binding === undefined ? null : {
        present: true, capabilityVersionId: binding.capabilityVersionId, status: binding.status, inputSchema: binding.inputSchema,
      },
      arguments: canonical.value,
    });
    await trx.insertInto("policy_decisions").values({
      tenant_id: tenantId, decision_id: decisionId, policy_session_id: session.policy_session_id,
      tool_call_id: request.tool_call_id, public_tool_name: request.tool_name,
      capability_version_id: result.decision === "allow" ? binding!.capabilityVersionId : null,
      mcp_tool_binding_id: result.decision === "allow" ? binding!.mcpToolBindingId : null,
      arguments_hash: canonical?.hash ?? `sha256:${"0".repeat(64)}`, decision: result.decision,
      reason_code: result.reason, policy_version_id: session.policy_version_id, resource_version: 1,
    }).execute();
    await appendPolicyDecisionEffect(trx, session, now, {
      decisionId, toolCallId: request.tool_call_id, decision: result.decision, reason: result.reason, resourceVersion: 1,
    });
    if (result.decision === "deny") return denyResponse(decisionId, result.reason);
    const ttl = dependencies.maximumProofTtlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 30_000) throw new DomainError("INTERNAL_ERROR", "Policy proof lifetime is invalid");
    const proofId = `proof-${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Math.min(session.expires_at.getTime(), now.getTime() + ttl));
    const proof = deriveExecutionProof(dependencies.proofKey, {
      tenantId, policySessionId: session.policy_session_id, decisionId, proofId, argumentsHash: canonical!.hash,
    });
    const digest = executionProofDigest(dependencies.proofKey, proof)!;
    await trx.insertInto("policy_execution_proofs").values({
      tenant_id: tenantId, proof_id: proofId, decision_id: decisionId, policy_session_id: session.policy_session_id,
      proof_digest: digest, arguments_hash: canonical!.hash, state: "issued", expires_at: expiresAt,
      consumed_at: null, invalidated_at: null, resource_version: 1,
    }).execute();
    return { schema_version: 1, decision_id: decisionId, decision: "allow", reason: "POLICY_ALLOWED", execution_proof: proof, expires_at: expiresAt.toISOString() };
  });
}
