import { randomUUID } from "node:crypto";

import { GatewayToolResultSchema, type GatewayToolResult } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";
import Schema from "typebox/schema";

import type { RuntimeDatabase } from "../../db/database.js";
import type { McpInvocationPort } from "../../policy/mcp-invocation-port.js";
import { canonicalizeToolArguments } from "../../policy/canonical-json.js";
import { recordRequestedToolCall, transitionToolCall } from "../../repositories/policy/tool-calls.js";
import { consumeExecutionProof } from "./consume-execution-proof.js";
import type { PolicyProofKey } from "./proof-crypto.js";

const resultValidator = Schema.Compile(GatewayToolResultSchema);
const safeFailure = (): GatewayToolResult => ({ content: [{ type: "text", text: "Tool invocation was unavailable." }], isError: true });

export interface InvokeAuthorizedToolDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly proofKey: PolicyProofKey;
  readonly invocationPort: McpInvocationPort;
}

export async function invokeAuthorizedTool(dependencies: InvokeAuthorizedToolDependencies, input: {
  readonly tenantId: string; readonly toolName: string; readonly proof: unknown;
  readonly arguments: unknown; readonly signal?: AbortSignal;
}): Promise<GatewayToolResult> {
  const consumed = await consumeExecutionProof(dependencies, {
    tenantId: input.tenantId, proof: input.proof, toolName: input.toolName, arguments: input.arguments,
  });
  if (!consumed.allowed) return { content: [{ type: "text", text: consumed.reason }], isError: true };
  const facts = await dependencies.db.transaction().execute(async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const session = await trx.selectFrom("policy_sessions").selectAll().where("tenant_id", "=", input.tenantId)
      .where("policy_session_id", "=", consumed.policySessionId)
      .executeTakeFirstOrThrow();
    const membership = await trx.selectFrom("memberships").select("roles").where("tenant_id", "=", input.tenantId)
      .where("membership_id", "=", session.membership_id).executeTakeFirstOrThrow();
    const effectiveRole = (["admin", "consultant", "student"] as const).find((role) => membership.roles.includes(role)) ?? "student";
    const mcpToolCallId = `mcp-call-${randomUUID()}`;
    await recordRequestedToolCall(trx, {
      tenantId: input.tenantId, mcpToolCallId, policySessionId: session.policy_session_id,
      decisionId: consumed.decisionId, proofId: consumed.proofId, bindingId: consumed.binding.mcpToolBindingId,
      toolCallId: consumed.toolCallId, toolName: input.toolName, argumentsHash: canonicalizeToolArguments(input.arguments).hash,
      now, runId: session.run_id, profileId: session.profile_id, requestId: session.request_id,
      traceId: session.trace_id, correlationId: session.correlation_id,
    });
    return { session, effectiveRole, mcpToolCallId };
  });
  const transition = async (from: "requested" | "started", to: "started" | "succeeded" | "failed", reason: string | null, summary: string | null) => dependencies.db.transaction().execute(async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    return transitionToolCall(trx, {
      tenantId: input.tenantId, mcpToolCallId: facts.mcpToolCallId, from, to, now, reasonCode: reason, summary,
      runId: facts.session.run_id, profileId: facts.session.profile_id, actorId: facts.session.actor_id,
      membershipId: facts.session.membership_id, effectiveRole: facts.effectiveRole, requestId: facts.session.request_id,
      traceId: facts.session.trace_id, correlationId: facts.session.correlation_id, toolCallId: consumed.toolCallId,
      toolName: input.toolName, policyVersion: facts.session.policy_version_id,
    });
  });
  await transition("requested", "started", null, null);
  try {
    const result = await dependencies.invocationPort.invoke({
      binding: consumed.binding, arguments: consumed.arguments, requestId: facts.session.request_id,
      traceId: facts.session.trace_id, timeoutMs: consumed.binding.server.requestTimeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!resultValidator.Check(result)) {
      await transition("started", "failed", "DOWNSTREAM_CONTRACT_INVALID", "Downstream result did not satisfy the reviewed contract");
      return safeFailure();
    }
    await transition("started", "succeeded", null, "Read-only Tool invocation succeeded");
    return result;
  } catch {
    await transition("started", "failed", "DOWNSTREAM_UNAVAILABLE", "Read-only Tool invocation was unavailable");
    return safeFailure();
  }
}
