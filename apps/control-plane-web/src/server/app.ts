import { resolve } from "node:path";

import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import {
  CLIENT_FRAME_MAX_BYTES,
  decodeClientFrame,
  encodeClientFrame,
  isValidClientMessage,
  type ClientErrorEnvelope,
  type ClientFrame,
  type ClientPublicErrorCode,
} from "../shared/protocol.js";
import {
  BROWSER_SESSION_COOKIE_NAME,
  createBrowserSessionStore,
  issueBrowserSession,
  validateBrowserRequest,
  verifyMutationSession,
} from "./security.js";
import {
  isExplicitRetryReason,
  mapAgentRunFailureCode,
} from "./failure-reasons.js";
import { createRetryStore } from "./retry-store.js";
import type { ManagedChatPort } from "./runtime-chat-port.js";
import { createClientConversationStore } from "./session-store.js";

const MAX_STREAM_BYTES = 4 * 1_024 * 1_024;
const MAX_STREAM_FRAMES = 2_048;
const csrfHeaderName = "x-core-agent-csrf";
const publicMessages: Readonly<Record<ClientPublicErrorCode, string>> = Object.freeze({
  CLIENT_CONFIGURATION_INVALID: "Web client configuration is invalid.",
  CLIENT_CONVERSATION_FAILED: "Conversation could not be created.",
  CLIENT_FRAME_INVALID: "Agent response stream is invalid.",
  CLIENT_HOST_INVALID: "Web client host is invalid.",
  CLIENT_INPUT_INVALID: "Message input is invalid.",
  CLIENT_ORIGIN_INVALID: "Web client origin is invalid.",
  CLIENT_RESTART_FAILED: "Services could not be restarted.",
  CLIENT_RETRY_UNAVAILABLE: "This reply cannot be retried.",
  CLIENT_RUN_BUSY: "This conversation already has an active run.",
  CLIENT_RUN_FAILED: "Agent run failed.",
  CLIENT_SESSION_INVALID: "Web client session is invalid.",
});

class ClientGatewayError extends Error {
  readonly statusCode: number;

  constructor(readonly code: ClientPublicErrorCode, statusCode: number) {
    super(code);
    this.statusCode = statusCode;
  }
}

export interface BuildClientGatewayAppOptions {
  readonly port?: ManagedChatPort;
  readonly authProxy?: IdentityGatewayProxyOptions;
  readonly staticRoot: string;
}

export interface IdentityGatewayProxyOptions {
  readonly origin: string;
  readonly publicOrigin: string;
  readonly fetchImpl?: typeof fetch;
}

const MAX_AUTH_BODY_BYTES = 64 * 1_024;

function exactOrigin(value: string, allowPublic: boolean): URL | undefined {
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (
      (!allowPublic && (parsed.protocol !== "http:" || !loopback))
      || (allowPublic && parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || (!allowPublic && parsed.port === "")
    ) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function validChatPort(value: ManagedChatPort | undefined): value is ManagedChatPort {
  return value !== undefined
    && typeof value.createConversation === "function"
    && typeof value.runPrompt === "function"
    && typeof value.restartApiWorker === "function";
}

function validAuthProxy(value: IdentityGatewayProxyOptions | undefined): value is IdentityGatewayProxyOptions {
  return value !== undefined
    && exactOrigin(value.origin, false) !== undefined
    && exactOrigin(value.publicOrigin, true) !== undefined
    && (value.fetchImpl === undefined || typeof value.fetchImpl === "function");
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/u.test(declared) || Number(declared) > MAX_AUTH_BODY_BYTES)) {
    throw new ClientGatewayError("CLIENT_CONFIGURATION_INVALID", 502);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_AUTH_BODY_BYTES) {
        await reader.cancel();
        throw new ClientGatewayError("CLIENT_CONFIGURATION_INVALID", 502);
      }
      chunks.push(result.value);
    }
    const bounded = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bounded.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bounded;
  } finally {
    reader.releaseLock();
  }
}

async function proxyIdentityRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: IdentityGatewayProxyOptions,
): Promise<FastifyReply> {
  if (request.method !== "GET" && request.method !== "POST") {
    throw new ClientGatewayError("CLIENT_INPUT_INVALID", 405);
  }
  const parsed = new URL(request.url, "http://gateway.invalid");
  const pathname = parsed.pathname;
  const authPath = pathname.startsWith("/auth/v1/") && parsed.search.length === 0;
  const appPath = pathname === "/app/v1/platform/catalog"
    || pathname === "/app/v1/platform/entitlements"
    || pathname === "/app/v1/student/services";
  const companyPath = pathname === "/app/v1/company/services" || pathname === "/app/v1/company/assignments";
  let targetPath = pathname;
  if (companyPath) {
    const entries = [...parsed.searchParams.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== "tenant_id" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(entries[0][1])) {
      throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
    }
    targetPath = `${pathname}?tenant_id=${encodeURIComponent(entries[0][1])}`;
  } else if (parsed.search.length > 0) {
    throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
  }
  if (!authPath && !appPath && !companyPath) {
    throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
  }
  let body: string | undefined;
  if (request.method === "POST") {
    body = JSON.stringify(request.body);
    if (Buffer.byteLength(body, "utf8") > MAX_AUTH_BODY_BYTES) {
      throw new ClientGatewayError("CLIENT_INPUT_INVALID", 413);
    }
  }
  const headers = new Headers({ accept: "application/json", host: new URL(options.publicOrigin).host });
  const origin = rawHeader(request, "origin");
  const cookieHeader = rawHeader(request, "cookie");
  const csrf = rawHeader(request, csrfHeaderName);
  if (origin !== undefined) headers.set("origin", origin);
  if (cookieHeader !== undefined) headers.set("cookie", cookieHeader);
  if (csrf !== undefined) headers.set(csrfHeaderName, csrf);
  if (body !== undefined) headers.set("content-type", "application/json");
  headers.set("x-forwarded-for", request.ip);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const requestInit: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    };
    if (body !== undefined) requestInit.body = body;
    const response = await (options.fetchImpl ?? fetch)(`${options.origin}${targetPath}`, requestInit);
    const responseBytes = await readBoundedResponse(response);
    const contentType = response.headers.get("content-type");
    if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      throw new ClientGatewayError("CLIENT_CONFIGURATION_INVALID", 502);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null && /^\d{1,5}$/u.test(retryAfter)) reply.header("retry-after", retryAfter);
    reply.type("application/json");
    return reply.code(response.status).send(Buffer.from(responseBytes));
  } catch (error) {
    if (error instanceof ClientGatewayError) throw error;
    throw new ClientGatewayError("CLIENT_CONFIGURATION_INVALID", 502);
  } finally {
    clearTimeout(timeout);
  }
}

function envelope(code: ClientPublicErrorCode): ClientErrorEnvelope {
  return Object.freeze({
    error: Object.freeze({ code, message: publicMessages[code] }),
  });
}

function exactEmptyRecord(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 0;
}

function messageBody(value: unknown): string {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== 1
  ) throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
  const descriptor = Object.getOwnPropertyDescriptor(value, "message");
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || descriptor.enumerable !== true
    || !isValidClientMessage(descriptor.value)
  ) throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
  return descriptor.value;
}

function rawHeader(request: FastifyRequest, name: string): string | undefined {
  const values: string[] = [];
  const rawHeaders = request.raw.rawHeaders;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
  }
  return values.length === 1 ? values[0] : undefined;
}

function assertMutationSession(request: FastifyRequest, sessionStore: ReturnType<typeof createBrowserSessionStore>): void {
  const cookieHeader = rawHeader(request, "cookie");
  const csrf = rawHeader(request, csrfHeaderName);
  const cookieValue = cookieHeader === undefined
    ? undefined
    : request.cookies[BROWSER_SESSION_COOKIE_NAME];
  if (!verifyMutationSession(sessionStore, cookieValue, csrf)) {
    throw new ClientGatewayError("CLIENT_SESSION_INVALID", 401);
  }
}

function streamHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
}

interface ClientStreamWriter {
  readonly begin: () => void;
  readonly end: () => void;
  readonly isStarted: () => boolean;
  readonly write: (frame: ClientFrame) => void;
}

function createStreamWriter(reply: FastifyReply): ClientStreamWriter {
  let started = false;
  let frameCount = 0;
  let aggregateBytes = 0;
  return Object.freeze({
    begin(): void {
      if (started) throw new ClientGatewayError("CLIENT_FRAME_INVALID", 502);
      reply.hijack();
      streamHeaders(reply);
      started = true;
    },
    isStarted(): boolean {
      return started;
    },
    write(frame: ClientFrame): void {
      if (!started) throw new ClientGatewayError("CLIENT_FRAME_INVALID", 502);
      const serialized = encodeClientFrame(frame);
      decodeClientFrame(serialized);
      const chunk = `data: ${serialized}\n\n`;
      const bytes = Buffer.byteLength(chunk, "utf8");
      frameCount += 1;
      aggregateBytes += bytes;
      if (
        bytes > CLIENT_FRAME_MAX_BYTES + 8
        || frameCount > MAX_STREAM_FRAMES
        || aggregateBytes > MAX_STREAM_BYTES
      ) throw new ClientGatewayError("CLIENT_FRAME_INVALID", 502);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(chunk);
    },
    end(): void {
      if (started && !reply.raw.writableEnded) reply.raw.end();
    },
  });
}

export async function buildClientGatewayApp(options: BuildClientGatewayAppOptions): Promise<FastifyInstance> {
  const chatPort = options?.port;
  const authProxy = options?.authProxy;
  if (
    validChatPort(chatPort) === validAuthProxy(authProxy)
    || typeof options.staticRoot !== "string"
    || options.staticRoot.length < 1
    || options.staticRoot.length > 4_096
    || resolve(options.staticRoot) !== options.staticRoot
  ) throw new Error("CLIENT_CONFIGURATION_INVALID");

  const app = Fastify({
    logger: false,
    bodyLimit: authProxy === undefined ? 8 * 1_024 : MAX_AUTH_BODY_BYTES,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  await app.register(cookie);

  app.addHook("onRequest", async (request) => {
    const decision = validateBrowserRequest(request.raw.rawHeaders, authProxy?.publicOrigin);
    if (!decision.ok) throw new ClientGatewayError(decision.code, 400);
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    const gatewayError = error instanceof ClientGatewayError
      ? error
      : new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
    void reply.code(gatewayError.statusCode).send(envelope(gatewayError.code));
  });

  app.get("/client/v1/config", async () => Object.freeze({
    schema_version: 1 as const,
    mode: authProxy === undefined ? "synthetic_demo" as const : "public_auth" as const,
  }));

  if (authProxy !== undefined) {
    app.all("/auth/v1/*", async (request, reply) => proxyIdentityRequest(request, reply, authProxy));
    app.all("/app/v1/*", async (request, reply) => proxyIdentityRequest(request, reply, authProxy));
  }

  if (chatPort !== undefined) {
    const sessionStore = createBrowserSessionStore();
    const conversationStore = createClientConversationStore();
    const retryStore = createRetryStore();
    const activeRuns = new Set<string>();
    let restarting = false;
    let initialConversation;
    try {
      initialConversation = conversationStore.add(await chatPort.createConversation());
    } catch {
      await app.close();
      throw new Error("CLIENT_CONVERSATION_FAILED");
    }

    app.get("/client/v1/bootstrap", async (_request, reply) => {
    const session = issueBrowserSession(sessionStore);
    reply.header("set-cookie", session.setCookie);
    return Object.freeze({
      csrf: session.csrf,
      runtimeState: "ready" as const,
      student: Object.freeze({ id: "demo_student" as const, name: "演示学生" as const }),
      conversations: conversationStore.list(),
      selectedConversationId: initialConversation.id,
    });
    });

    app.get("/client/v1/health", async () => Object.freeze({ state: "ready" as const }));

    app.post("/client/v1/conversations", async (request, reply) => {
    assertMutationSession(request, sessionStore);
    if (!exactEmptyRecord(request.body)) throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
    try {
      const conversation = conversationStore.add(await chatPort.createConversation());
      return reply.code(201).send(conversation);
    } catch {
      throw new ClientGatewayError("CLIENT_CONVERSATION_FAILED", 502);
    }
    });

  app.post<{ Params: { conversationId: string } }>(
    "/client/v1/conversations/:conversationId/runs",
    async (request, reply) => {
      assertMutationSession(request, sessionStore);
      const publicConversationId = request.params.conversationId;
      const internalConversationId = conversationStore.resolve(publicConversationId);
      if (internalConversationId === undefined) throw new ClientGatewayError("CLIENT_CONVERSATION_FAILED", 404);
      const message = messageBody(request.body);
      if (activeRuns.has(publicConversationId)) throw new ClientGatewayError("CLIENT_RUN_BUSY", 409);
      activeRuns.add(publicConversationId);
      retryStore.clear(publicConversationId);
      const stream = createStreamWriter(reply);

      try {
        const result = await chatPort.runPrompt(internalConversationId, message, {
          onStarted() {
            stream.begin();
            stream.write({ type: "run.started" });
          },
          onDelta(delta) {
            stream.write({ type: "message.delta", delta });
          },
        });
        if (!stream.isStarted()) throw new ClientGatewayError("CLIENT_RUN_FAILED", 502);
        if (result.status === "succeeded") {
          stream.write({ type: "message.completed" });
          stream.write({ type: "run.completed" });
        } else {
          const reason = mapAgentRunFailureCode(result.failureCode);
          retryStore.recordFailure({
            conversationId: publicConversationId,
            failedRunId: result.runId,
            originalMessage: message,
            publicReason: reason,
          });
          stream.write({ type: "run.failed", reason });
        }
        stream.end();
        return reply;
      } catch {
        if (stream.isStarted()) {
          try { stream.write({ type: "run.failed", reason: "UNKNOWN" }); }
          finally { stream.end(); }
          return reply;
        }
        throw new ClientGatewayError("CLIENT_RUN_FAILED", 502);
      } finally {
        activeRuns.delete(publicConversationId);
      }
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    "/client/v1/conversations/:conversationId/retries",
    async (request, reply) => {
      assertMutationSession(request, sessionStore);
      if (request.body !== undefined) throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
      const publicConversationId = request.params.conversationId;
      const internalConversationId = conversationStore.resolve(publicConversationId);
      if (internalConversationId === undefined) {
        throw new ClientGatewayError("CLIENT_CONVERSATION_FAILED", 404);
      }
      const existingAdmission = retryStore.hasAdmission(publicConversationId);
      if (activeRuns.has(publicConversationId) && !existingAdmission) {
        throw new ClientGatewayError("CLIENT_RUN_BUSY", 409);
      }
      const failure = retryStore.failure(publicConversationId);
      if (failure === undefined || !isExplicitRetryReason(failure.publicReason)) {
        throw new ClientGatewayError("CLIENT_RETRY_UNAVAILABLE", 409);
      }

      const stream = createStreamWriter(reply);
      let admission;
      try {
        admission = retryStore.admit(publicConversationId, async (parent) => {
          activeRuns.add(publicConversationId);
          const frames: ClientFrame[] = [];
          const emit = (frame: ClientFrame): void => {
            frames.push(frame);
            stream.write(frame);
          };
          try {
            const result = await chatPort.runPrompt(
              internalConversationId,
              parent.originalMessage,
              {
                onStarted() {
                  stream.begin();
                  emit({ type: "run.started" });
                },
                onDelta(delta) {
                  emit({ type: "message.delta", delta });
                },
              },
              { parentRunId: parent.failedRunId },
            );
            if (!stream.isStarted()) throw new ClientGatewayError("CLIENT_RUN_FAILED", 502);
            if (result.status === "succeeded") {
              emit({ type: "message.completed" });
              emit({ type: "run.completed" });
            } else {
              const reason = mapAgentRunFailureCode(result.failureCode);
              emit({ type: "run.failed", reason });
              retryStore.advanceFailure(
                publicConversationId,
                parent.failedRunId,
                {
                  conversationId: publicConversationId,
                  failedRunId: result.runId,
                  originalMessage: parent.originalMessage,
                  publicReason: reason,
                },
              );
            }
            stream.end();
            return Object.freeze({ result, frames: Object.freeze([...frames]) });
          } finally {
            activeRuns.delete(publicConversationId);
          }
        });
      } catch {
        throw new ClientGatewayError("CLIENT_RETRY_UNAVAILABLE", 409);
      }

      try {
        const execution = await admission.promise;
        if (!admission.owner) {
          stream.begin();
          for (const frame of execution.frames) stream.write(frame);
          stream.end();
        }
        return reply;
      } catch {
        if (stream.isStarted()) {
          try { stream.write({ type: "run.failed", reason: "UNKNOWN" }); }
          finally { stream.end(); }
          return reply;
        }
        throw new ClientGatewayError("CLIENT_RUN_FAILED", 502);
      }
    },
  );

  app.post("/client/v1/runtime/restart", async (request) => {
    assertMutationSession(request, sessionStore);
    if (!exactEmptyRecord(request.body)) throw new ClientGatewayError("CLIENT_INPUT_INVALID", 400);
    if (restarting) throw new ClientGatewayError("CLIENT_RUN_BUSY", 409);
    restarting = true;
    try {
      await chatPort.restartApiWorker();
      return Object.freeze({ state: "ready" as const });
    } catch {
      throw new ClientGatewayError("CLIENT_RESTART_FAILED", 502);
    } finally {
      restarting = false;
    }
    });
  }

  await app.register(fastifyStatic, {
    root: options.staticRoot,
    decorateReply: true,
    dotfiles: "deny",
    index: false,
  });
  app.get("/", async (_request, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler(async () => {
    throw new ClientGatewayError("CLIENT_INPUT_INVALID", 404);
  });
  return app;
}
