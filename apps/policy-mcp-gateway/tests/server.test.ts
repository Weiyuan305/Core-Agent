import assert from "node:assert/strict";
import test from "node:test";

import { buildPolicyMcpGatewayApp, type PolicyMcpGatewayOperations } from "../src/server.js";

const workerToken = "worker-token-0123456789";
const pluginToken = "plugin-token-0123456789";
const runtimeToken = "runtime-token-0123456789";

function operations(): PolicyMcpGatewayOperations {
  return {
    authenticateWorker: (token) => token === workerToken,
    authenticatePlugin: (token) => token === pluginToken ? { tenantId: "tenant", runtimeContainerId: "runtime", runtimeGeneration: 7 } : undefined,
    authenticateRuntime: (token) => token === runtimeToken ? { tenantId: "tenant", profileId: "profile", runtimeContainerId: "runtime", runtimeGeneration: 7 } : undefined,
    openSession: async () => ({ schema_version: 1, policy_session_id: "policy-session", state: "active", policy_version: "core-agent-read-mcp-v1", expires_at: "2026-08-25T12:00:00.000Z" }),
    closeSession: async (_tenant, request) => ({ schema_version: 1, policy_session_id: request.policy_session_id, state: "closed" }),
    decide: async () => ({ schema_version: 1, decision_id: "decision", decision: "allow", reason: "POLICY_ALLOWED", execution_proof: "a".repeat(43), expires_at: "2026-08-25T12:00:00.000Z" }),
    resolveSession: async () => ({ policySessionId: "policy-session" }),
    listTools: async () => [{ name: "core_agent.synthetic_profile", title: "Synthetic", description: "Synthetic fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }],
    callTool: async ({ arguments: args }) => ({ content: [{ type: "text", text: JSON.stringify(args) }], isError: false }),
    ready: async () => true,
  };
}

test("private Gateway rejects missing auth forwarded identity cookies and duplicate JSON keys", async () => {
  const app = buildPolicyMcpGatewayApp(operations());
  try {
    assert.equal((await app.inject({ method: "POST", url: "/v1/policy-decisions", payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/v1/policy-decisions", headers: { authorization: `Bearer ${pluginToken}`, cookie: "x=y" }, payload: {} })).statusCode, 400);
    const duplicate = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" }, payload: '{"jsonrpc":"2.0","method":"tools/list","method":"tools/call","id":1}' });
    assert.equal(duplicate.statusCode, 400);
    assert.equal(duplicate.body.includes("tools/call"), false);
  } finally { await app.close(); }
});

test("MCP initialize list and proof-stripped call negotiate 2025-03-26", async () => {
  const app = buildPolicyMcpGatewayApp(operations());
  const auth = { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" };
  try {
    const initialized = await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hermes", version: "1" } } } });
    assert.equal(initialized.statusCode, 200);
    assert.equal(initialized.json().result.protocolVersion, "2025-03-26");
    const sessionId = String(initialized.headers["mcp-session-id"]);
    assert.match(sessionId, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } })).statusCode, 401);
    const sessionAuth = { ...auth, "mcp-session-id": sessionId };
    assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: sessionAuth, payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} } })).statusCode, 202);
    assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: sessionAuth, payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} } })).statusCode, 409);
    const listed = await app.inject({ method: "POST", url: "/mcp", headers: sessionAuth, payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
    assert.equal(listed.json().result.tools[0].annotations.readOnlyHint, true);
    const called = await app.inject({ method: "POST", url: "/mcp", headers: sessionAuth, payload: { jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture", __core_agent_policy: "a".repeat(43) } } } });
    assert.deepEqual(JSON.parse(called.json().result.content[0].text), { profile_id: "fixture" });
    assert.equal(called.body.includes("__core_agent_policy"), false);
  } finally { await app.close(); }
});

test("MCP initialized notification rejects explicit null ids and open params", async () => {
  const app = buildPolicyMcpGatewayApp(operations());
  const auth = { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" };
  try {
    const initialized = await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: {
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" },
    } });
    const sessionAuth = { ...auth, "mcp-session-id": String(initialized.headers["mcp-session-id"]) };
    assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: sessionAuth, payload: {
      jsonrpc: "2.0", id: null, method: "notifications/initialized", params: {},
    } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/mcp", headers: sessionAuth, payload: {
      jsonrpc: "2.0", method: "notifications/initialized", params: { extra: true },
    } })).statusCode, 400);
  } finally { await app.close(); }
});

test("Gateway health is liveness-only and unknown methods are closed", async () => {
  const app = buildPolicyMcpGatewayApp(operations());
  try {
    assert.deepEqual((await app.inject({ method: "GET", url: "/health" })).json(), { status: "ok" });
    assert.deepEqual((await app.inject({ method: "GET", url: "/ready" })).json(), { status: "ready" });
    const initialized = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${runtimeToken}` }, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } } });
    const headers = { authorization: `Bearer ${runtimeToken}`, "mcp-session-id": String(initialized.headers["mcp-session-id"]) };
    await app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} } });
    const unknown = await app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} } });
    assert.equal(unknown.json().error.code, -32601);
  } finally { await app.close(); }
});

test("Gateway maps operation failures to a retryable generic dependency response", async () => {
  const failing = operations();
  const app = buildPolicyMcpGatewayApp({
    ...failing,
    decide: async () => { throw new Error("private database diagnostic"); },
  });
  try {
    const response = await app.inject({
      method: "POST", url: "/v1/policy-decisions",
      headers: { authorization: `Bearer ${pluginToken}` },
      payload: {
        schema_version: 1, hermes_session_ref: "session", tool_call_id: "call",
        tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
      },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: { code: "DEPENDENCY_UNAVAILABLE", message: "Request was rejected." } });
    assert.equal(response.body.includes("private database diagnostic"), false);
  } finally { await app.close(); }
});
