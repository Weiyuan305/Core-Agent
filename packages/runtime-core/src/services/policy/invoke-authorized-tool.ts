import { randomUUID } from "node:crypto";

import { GatewayToolResultSchema, type GatewayToolResult } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";
import Schema from "typebox/schema";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import type { McpInvocationPort } from "../../policy/mcp-invocation-port.js";
import { recordRequestedToolCall, transitionToolCall } from "../../repositories/policy/tool-calls.js";
import { consumeExecutionProofInTransaction } from "./consume-execution-proof.js";
import type { PolicyProofKey } from "./proof-crypto.js";
import type { PolicyRuntimeIdentity } from "./session-authority.js";

const resultValidator = Schema.Compile(GatewayToolResultSchema);
const safeFailure = (): GatewayToolResult => ({ content: [{ type: "text", text: "Tool invocation was unavailable." }], isError: true });

export interface InvokeAuthorizedToolDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly proofKey: PolicyProofKey;
  readonly invocationPort: McpInvocationPort;
}

export async function invokeAuthorizedTool(dependencies: InvokeAuthorizedToolDependencies, input: {
  readonly identity: PolicyRuntimeIdentity; readonly policySessionId: string; readonly toolName: string; readonly proof: unknown;
  readonly arguments: unknown; readonly signal?: AbortSignal;
}): Promise<GatewayToolResult> {
  const mcpToolCallId = `mcp-call-${randomUUID()}`;
  const consumed = await withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const result = await consumeExecutionProofInTransaction(trx, dependencies.proofKey, {
      identity: input.identity, policySessionId: input.policySessionId, proof: input.proof,
      toolName: input.toolName, arguments: input.arguments,
    });
    if (!result.allowed) return result;
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    await recordRequestedToolCall(trx, {
      tenantId: input.identity.tenantId, mcpToolCallId, policySessionId: result.session.policy_session_id,
      decisionId: result.decisionId, proofId: result.proofId, bindingId: result.binding.mcpToolBindingId,
      toolCallId: result.toolCallId, toolName: input.toolName, argumentsHash: result.argumentsHash,
      now, runId: result.session.run_id, profileId: result.session.profile_id, requestId: result.session.request_id,
      traceId: result.session.trace_id, correlationId: result.session.correlation_id,
    });
    return result;
  });
  if (!consumed.allowed) return { content: [{ type: "text", text: consumed.reason }], isError: true };
  const facts = { session: consumed.session, effectiveRole: consumed.effectiveRole, mcpToolCallId };
  const transition = async (from: "requested" | "started", to: "started" | "succeeded" | "failed", reason: string | null, summary: string | null) => dependencies.db.transaction().execute(async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    return transitionToolCall(trx, {
      tenantId: input.identity.tenantId, mcpToolCallId: facts.mcpToolCallId, from, to, now, reasonCode: reason, summary,
      runId: facts.session.run_id, profileId: facts.session.profile_id, actorId: facts.session.actor_id,
      membershipId: facts.session.membership_id, effectiveRole: facts.effectiveRole, requestId: facts.session.request_id,
      traceId: facts.session.trace_id, correlationId: facts.session.correlation_id, toolCallId: consumed.toolCallId,
      toolName: input.toolName, policyVersion: facts.session.policy_version_id,
      entitlementSnapshotRef: {
        snapshot_id: facts.session.snapshot_id, version: Number(facts.session.snapshot_version),
        evaluated_at: facts.session.snapshot_evaluated_at.toISOString(),
      },
    });
  });
  if (!await transition("requested", "started", null, null)) {
    throw new DomainError("INTERNAL_ERROR", "MCP Tool call start transition was rejected");
  }
  try {
    const result = await dependencies.invocationPort.invoke({
      binding: consumed.binding, arguments: consumed.arguments, requestId: facts.session.request_id,
      traceId: facts.session.trace_id, timeoutMs: consumed.binding.server.requestTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!resultValidator.Check(result)) {
      if (!await transition("started", "failed", "DOWNSTREAM_CONTRACT_INVALID", "Downstream result did not satisfy the reviewed contract")) {
        throw new DomainError("INTERNAL_ERROR", "MCP Tool call terminal transition was rejected");
      }
      return safeFailure();
    }
    if (!await transition("started", "succeeded", null, "Read-only Tool invocation succeeded")) {
      throw new DomainError("INTERNAL_ERROR", "MCP Tool call terminal transition was rejected");
    }
    return result;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (!await transition("started", "failed", "DOWNSTREAM_UNAVAILABLE", "Read-only Tool invocation was unavailable")) {
      throw new DomainError("INTERNAL_ERROR", "MCP Tool call failure transition was rejected");
    }
    return safeFailure();
  }
}
