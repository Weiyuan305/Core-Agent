import type { GatewayToolResult } from "@core-agent/contracts";

import type { ReviewedMcpBinding } from "../services/policy/catalog-validation.js";

export interface McpInvocationRequest {
  readonly binding: ReviewedMcpBinding;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly traceId: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface McpInvocationPort {
  invoke(request: McpInvocationRequest): Promise<GatewayToolResult>;
}

export function createSyntheticMcpInvocationPort(): McpInvocationPort {
  return Object.freeze({
    async invoke(request: McpInvocationRequest): Promise<GatewayToolResult> {
      if (request.binding.server.adapterKind !== "synthetic" || request.binding.downstreamToolName !== "synthetic_profile") {
        throw new Error("Synthetic MCP binding is unavailable");
      }
      if (request.signal?.aborted) throw new Error("Synthetic MCP invocation was cancelled");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ fixture: "synthetic_profile", status: "available", profile_id: request.arguments.profile_id }) }],
        isError: false,
      };
    },
  });
}

export function createUnavailableRemoteMcpInvocationPort(): McpInvocationPort {
  return Object.freeze({ async invoke(): Promise<never> { throw new Error("Remote MCP adapter is unavailable"); } });
}
