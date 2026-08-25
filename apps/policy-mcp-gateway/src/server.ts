import {
  ClosePolicySessionRequestSchema,
  CORE_AGENT_POLICY_PROOF_FIELD,
  OpenPolicySessionRequestSchema,
  ToolPolicyDecisionRequestSchema,
  type ClosePolicySessionRequest,
  type GatewayToolDescriptor,
  type GatewayToolResult,
  type OpenPolicySessionRequest,
  type OpenPolicySessionResponse,
  type ToolPolicyDecisionRequest,
  type ToolPolicyDecisionResponse,
} from "@core-agent/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import Schema from "typebox/schema";

import { bearerToken } from "./auth.js";
import { parseJsonWithoutDuplicateKeys } from "./json.js";

const openValidator = Schema.Compile(OpenPolicySessionRequestSchema);
const closeValidator = Schema.Compile(ClosePolicySessionRequestSchema);
const decisionValidator = Schema.Compile(ToolPolicyDecisionRequestSchema);

export interface PolicyMcpGatewayOperations {
  readonly authenticateWorker: (token: string) => Promise<boolean> | boolean;
  readonly authenticatePlugin: (token: string) => Promise<{ tenantId: string } | undefined> | { tenantId: string } | undefined;
  readonly authenticateRuntime: (token: string) => Promise<{ tenantId: string; profileId: string } | undefined> | { tenantId: string; profileId: string } | undefined;
  readonly openSession: (request: OpenPolicySessionRequest) => Promise<OpenPolicySessionResponse>;
  readonly closeSession: (tenantId: string, request: ClosePolicySessionRequest) => Promise<{ schema_version: 1; policy_session_id: string; state: "closed" }>;
  readonly decide: (tenantId: string, request: ToolPolicyDecisionRequest) => Promise<ToolPolicyDecisionResponse>;
  readonly listTools: (tenantId: string, profileId: string) => Promise<readonly GatewayToolDescriptor[]>;
  readonly callTool: (input: { tenantId: string; profileId: string; toolName: string; proof: string; arguments: Record<string, unknown>; signal: AbortSignal }) => Promise<GatewayToolResult>;
  readonly ready: () => Promise<boolean>;
}

function unsafeTransportHeaders(request: FastifyRequest): boolean {
  return request.headers.cookie !== undefined || request.headers.origin !== undefined
    || request.headers["x-forwarded-for"] !== undefined || request.headers["x-forwarded-host"] !== undefined
    || request.headers["x-forwarded-proto"] !== undefined;
}

function errorBody(code = "INVALID_REQUEST") { return { error: { code, message: "Request was rejected." } }; }
const idValue = (value: unknown): string | number | null => typeof value === "string" || typeof value === "number" || value === null ? value : null;
const jsonRpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export function buildPolicyMcpGatewayApp(operations: PolicyMcpGatewayOperations): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (_request, body, done) => {
    try {
      if (typeof body !== "string") throw new Error("JSON body is invalid");
      done(null, parseJsonWithoutDuplicateKeys(body));
    } catch (error) { done(error as Error); }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => (await operations.ready()) ? { status: "ready" } : reply.code(503).send({ status: "not_ready" }));

  app.post("/v1/policy/sessions/open", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !await operations.authenticateWorker(token)) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    if (!openValidator.Check(request.body)) return reply.code(400).send(errorBody());
    return operations.openSession(request.body as OpenPolicySessionRequest);
  });
  app.post("/v1/policy/sessions/close", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !await operations.authenticateWorker(token)) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    const tenantId = request.headers["x-core-agent-tenant-id"];
    if (typeof tenantId !== "string" || !closeValidator.Check(request.body)) return reply.code(400).send(errorBody());
    return operations.closeSession(tenantId, request.body as ClosePolicySessionRequest);
  });
  app.post("/v1/policy/decisions", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    const identity = token === undefined ? undefined : await operations.authenticatePlugin(token);
    if (identity === undefined) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    if (!decisionValidator.Check(request.body)) return reply.code(400).send(errorBody());
    return operations.decide(identity.tenantId, request.body as ToolPolicyDecisionRequest);
  });
  app.post("/mcp", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    const identity = token === undefined ? undefined : await operations.authenticateRuntime(token);
    if (identity === undefined) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    const body = request.body as Record<string, unknown>;
    const id = idValue(body?.id);
    if (body === null || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return reply.code(400).send(jsonRpcError(id, -32600, "Invalid Request"));
    if (body.method === "initialize") {
      const params = body.params as Record<string, unknown> | undefined;
      if (id === null || params?.protocolVersion !== "2025-03-26") return reply.code(400).send(jsonRpcError(id, -32602, "Unsupported protocol"));
      reply.header("mcp-session-id", `mcp-${identity.tenantId}-${identity.profileId}`);
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "core-agent-policy-mcp-gateway", version: "1.0.0" } } };
    }
    if (body.method === "notifications/initialized") return reply.code(202).send();
    if (body.method === "tools/list") {
      if (id === null) return reply.code(400).send(jsonRpcError(id, -32600, "Invalid Request"));
      return { jsonrpc: "2.0", id, result: { tools: await operations.listTools(identity.tenantId, identity.profileId) } };
    }
    if (body.method === "tools/call") {
      if (id === null) return reply.code(400).send(jsonRpcError(id, -32600, "Invalid Request"));
      const params = body.params as Record<string, unknown> | undefined;
      const args = params?.arguments;
      if (typeof params?.name !== "string" || args === null || typeof args !== "object" || Array.isArray(args)) return reply.code(400).send(jsonRpcError(id, -32602, "Invalid parameters"));
      const proof = (args as Record<string, unknown>)[CORE_AGENT_POLICY_PROOF_FIELD];
      if (typeof proof !== "string") return reply.code(200).send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "PROOF_INVALID" }], isError: true } });
      const clean = { ...(args as Record<string, unknown>) };
      delete clean[CORE_AGENT_POLICY_PROOF_FIELD];
      const abort = new AbortController();
      request.raw.once("close", () => abort.abort());
      const result = await operations.callTool({ tenantId: identity.tenantId, profileId: identity.profileId, toolName: params.name, proof, arguments: clean, signal: abort.signal });
      return { jsonrpc: "2.0", id, result };
    }
    return reply.code(200).send(jsonRpcError(id, -32601, "Method not found"));
  });
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(errorBody("RESOURCE_NOT_FOUND")));
  app.setErrorHandler(async (_error, _request, reply) => reply.code(400).send(errorBody()));
  return app;
}
