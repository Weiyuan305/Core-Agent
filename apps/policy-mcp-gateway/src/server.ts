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
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import Schema from "typebox/schema";

import { bearerToken } from "./auth.js";
import { parseJsonWithoutDuplicateKeys } from "./json.js";

const openValidator = Schema.Compile(OpenPolicySessionRequestSchema);
const closeValidator = Schema.Compile(ClosePolicySessionRequestSchema);
const decisionValidator = Schema.Compile(ToolPolicyDecisionRequestSchema);

export interface PolicyMcpGatewayOperations {
  readonly authenticateWorker: (token: string) => Promise<boolean> | boolean;
  readonly authenticatePlugin: (token: string) => Promise<GatewayPluginIdentity | undefined> | GatewayPluginIdentity | undefined;
  readonly authenticateRuntime: (token: string) => Promise<GatewayRuntimeIdentity | undefined> | GatewayRuntimeIdentity | undefined;
  readonly openSession: (request: OpenPolicySessionRequest) => Promise<OpenPolicySessionResponse>;
  readonly closeSession: (tenantId: string, request: ClosePolicySessionRequest) => Promise<{ schema_version: 1; policy_session_id: string; state: "closed" }>;
  readonly decide: (identity: GatewayPluginIdentity, request: ToolPolicyDecisionRequest) => Promise<ToolPolicyDecisionResponse>;
  readonly resolveSession: (identity: GatewayRuntimeIdentity) => Promise<{ policySessionId: string } | undefined>;
  readonly listTools: (identity: GatewayRuntimeIdentity, policySessionId: string) => Promise<readonly GatewayToolDescriptor[]>;
  readonly callTool: (input: { identity: GatewayRuntimeIdentity; policySessionId: string; toolName: string; proof: string; arguments: Record<string, unknown>; signal: AbortSignal }) => Promise<GatewayToolResult>;
  readonly ready: () => Promise<boolean>;
}

export interface GatewayPluginIdentity {
  readonly tenantId: string;
  readonly runtimeContainerId: string;
  readonly runtimeGeneration: number;
}
export interface GatewayRuntimeIdentity extends GatewayPluginIdentity { readonly profileId: string }

function unsafeTransportHeaders(request: FastifyRequest): boolean {
  return request.headers.cookie !== undefined || request.headers.origin !== undefined
    || request.headers["x-forwarded-for"] !== undefined || request.headers["x-forwarded-host"] !== undefined
    || request.headers["x-forwarded-proto"] !== undefined;
}

function errorBody(code = "INVALID_REQUEST") { return { error: { code, message: "Request was rejected." } }; }
const idValue = (value: unknown): string | number | null => typeof value === "string" || typeof value === "number" || value === null ? value : null;
const jsonRpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
function ownErrorValue(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

export function buildPolicyMcpGatewayApp(operations: PolicyMcpGatewayOperations): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  const transportSessions = new Map<string, {
    readonly identity: GatewayRuntimeIdentity; initialized: boolean; policySessionId?: string; expiresAt: number;
  }>();
  const transportSessionTtlMs = 10 * 60_000;
  const sameIdentity = (left: GatewayRuntimeIdentity, right: GatewayRuntimeIdentity) => left.tenantId === right.tenantId
    && left.profileId === right.profileId && left.runtimeContainerId === right.runtimeContainerId
    && left.runtimeGeneration === right.runtimeGeneration;
  const transportSession = (request: FastifyRequest, identity: GatewayRuntimeIdentity) => {
    const value = request.headers["mcp-session-id"];
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
    const stored = transportSessions.get(value);
    if (stored === undefined) return undefined;
    if (stored.expiresAt <= Date.now()) {
      transportSessions.delete(value);
      return undefined;
    }
    if (!sameIdentity(stored.identity, identity)) return undefined;
    stored.expiresAt = Date.now() + transportSessionTtlMs;
    return { id: value, stored };
  };
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 64 * 1024 }, (_request, body, done) => {
    try {
      if (typeof body !== "string") throw new Error("JSON body is invalid");
      done(null, parseJsonWithoutDuplicateKeys(body));
    } catch {
      const failure = new Error("JSON body is invalid") as Error & { statusCode: number };
      failure.statusCode = 400;
      done(failure);
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => (await operations.ready()) ? { status: "ready" } : reply.code(503).send({ status: "not_ready" }));

  app.post("/v1/policy-sessions/open", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !await operations.authenticateWorker(token)) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    if (!openValidator.Check(request.body)) return reply.code(400).send(errorBody());
    return operations.openSession(request.body as OpenPolicySessionRequest);
  });
  app.post("/v1/policy-sessions/:policy_session_id/close", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    if (token === undefined || !await operations.authenticateWorker(token)) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    const tenantId = request.headers["x-core-agent-tenant-id"];
    const pathId = (request.params as { policy_session_id?: unknown }).policy_session_id;
    if (typeof tenantId !== "string" || !closeValidator.Check(request.body)
      || pathId !== (request.body as ClosePolicySessionRequest).policy_session_id) return reply.code(400).send(errorBody());
    return operations.closeSession(tenantId, request.body as ClosePolicySessionRequest);
  });
  app.post("/v1/policy-decisions", async (request, reply) => {
    if (unsafeTransportHeaders(request)) return reply.code(400).send(errorBody());
    const token = bearerToken(request.headers.authorization);
    const identity = token === undefined ? undefined : await operations.authenticatePlugin(token);
    if (identity === undefined) return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    if (!decisionValidator.Check(request.body)) return reply.code(400).send(errorBody());
    return operations.decide(identity, request.body as ToolPolicyDecisionRequest);
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
      if (id === null || params?.protocolVersion !== "2025-03-26" || request.headers["mcp-session-id"] !== undefined) {
        return reply.code(400).send(jsonRpcError(id, -32602, "Unsupported protocol"));
      }
      for (const [key, value] of transportSessions) if (value.expiresAt <= Date.now()) transportSessions.delete(key);
      if (transportSessions.size >= 10_000) return reply.code(503).send(jsonRpcError(id, -32000, "Session capacity unavailable"));
      const sessionId = randomBytes(32).toString("base64url");
      transportSessions.set(sessionId, { identity, initialized: false, expiresAt: Date.now() + transportSessionTtlMs });
      reply.header("mcp-session-id", sessionId);
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "core-agent-policy-mcp-gateway", version: "1.0.0" } } };
    }
    const transport = transportSession(request, identity);
    if (transport === undefined) return reply.code(401).send(jsonRpcError(id, -32001, "MCP session is unavailable"));
    if (body.method === "notifications/initialized") {
      const params = body.params;
      if (Object.hasOwn(body, "id") || params === null || typeof params !== "object" || Array.isArray(params)
        || Object.getPrototypeOf(params) !== Object.prototype || Reflect.ownKeys(params).length !== 0) {
        return reply.code(400).send(jsonRpcError(id, -32600, "Invalid Request"));
      }
      if (transport.stored.initialized) {
        return reply.code(409).send(jsonRpcError(null, -32002, "MCP session is already initialized"));
      }
      transport.stored.initialized = true;
      return reply.code(202).send();
    }
    if (!transport.stored.initialized) return reply.code(409).send(jsonRpcError(id, -32002, "MCP session is not initialized"));
    const bindPolicySession = async () => {
      if (transport.stored.policySessionId !== undefined) return transport.stored.policySessionId;
      const resolved = await operations.resolveSession(identity);
      if (resolved === undefined) return undefined;
      transport.stored.policySessionId = resolved.policySessionId;
      return resolved.policySessionId;
    };
    if (body.method === "tools/list") {
      if (id === null) return reply.code(400).send(jsonRpcError(id, -32600, "Invalid Request"));
      const policySessionId = await bindPolicySession();
      return { jsonrpc: "2.0", id, result: { tools: policySessionId === undefined ? [] : await operations.listTools(identity, policySessionId) } };
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
      const policySessionId = await bindPolicySession();
      if (policySessionId === undefined) return reply.code(200).send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "SESSION_NOT_ACTIVE" }], isError: true } });
      const abort = new AbortController();
      request.raw.once("close", () => abort.abort());
      const result = await operations.callTool({ identity, policySessionId, toolName: params.name, proof, arguments: clean, signal: abort.signal });
      return { jsonrpc: "2.0", id, result };
    }
    return reply.code(200).send(jsonRpcError(id, -32601, "Method not found"));
  });
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send(errorBody("RESOURCE_NOT_FOUND")));
  app.setErrorHandler(async (error, _request, reply) => {
    const code = ownErrorValue(error, "code");
    const statusCode = ownErrorValue(error, "statusCode");
    if (statusCode === 400 || statusCode === 413 || code === "INVALID_REQUEST") {
      return reply.code(400).send(errorBody());
    }
    if (code === "UNAUTHENTICATED") return reply.code(401).send(errorBody("UNAUTHENTICATED"));
    if (code === "POLICY_DENIED") return reply.code(403).send(errorBody("POLICY_DENIED"));
    if (code === "IDEMPOTENCY_CONFLICT") return reply.code(409).send(errorBody("IDEMPOTENCY_CONFLICT"));
    return reply.code(503).send(errorBody("DEPENDENCY_UNAVAILABLE"));
  });
  return app;
}
