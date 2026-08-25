import assert from "node:assert/strict";
import test from "node:test";

import { createSyntheticMcpInvocationPort, createUnavailableRemoteMcpInvocationPort } from "../src/policy/mcp-invocation-port.js";

const request = {
  binding: {
    mcpToolBindingId: "binding", capabilityVersionId: "cv", capabilityId: "cap", capabilityVersion: "1.0.0",
    publicToolName: "core_agent.synthetic_profile", downstreamToolName: "synthetic_profile",
    title: "Synthetic", description: "Synthetic", inputSchema: Object.freeze({}), inputSchemaHash: `sha256:${"0".repeat(64)}`,
    outputContractRef: "gateway-tool-result@0.9.0", status: "reviewed" as const,
    server: { mcpServerVersionId: "server", mcpServerId: "server", version: "1.0.0", adapterKind: "synthetic" as const,
      protocolVersion: "2025-03-26" as const, connectTimeoutMs: 100, requestTimeoutMs: 100, maximumResponseBytes: 8192, status: "reviewed" as const },
  },
  arguments: Object.freeze({ profile_id: "fixture" }), requestId: "request", traceId: "trace", timeoutMs: 100,
};

test("synthetic MCP adapter returns deterministic safe text only", async () => {
  const result = await createSyntheticMcpInvocationPort().invoke(request);
  assert.deepEqual(result, { content: [{ type: "text", text: '{"fixture":"synthetic_profile","status":"available","profile_id":"fixture"}' }], isError: false });
});

test("remote MCP adapter remains unavailable in v1", async () => {
  await assert.rejects(createUnavailableRemoteMcpInvocationPort().invoke(request), /unavailable/u);
});
