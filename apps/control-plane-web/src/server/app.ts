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
  readonly port: ManagedChatPort;
  readonly staticRoot: string;
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
  if (
    typeof options?.port?.createConversation !== "function"
    || typeof options.port.runPrompt !== "function"
    || typeof options.port.restartApiWorker !== "function"
    || typeof options.staticRoot !== "string"
    || options.staticRoot.length < 1
    || options.staticRoot.length > 4_096
    || resolve(options.staticRoot) !== options.staticRoot
  ) throw new Error("CLIENT_CONFIGURATION_INVALID");

  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1_024,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  await app.register(cookie);
  const sessionStore = createBrowserSessionStore();
  const conversationStore = createClientConversationStore();
  const retryStore = createRetryStore();
  const activeRuns = new Set<string>();
  let restarting = false;

  let initialConversation;
  try {
    initialConversation = conversationStore.add(await options.port.createConversation());
  } catch {
    await app.close();
    throw new Error("CLIENT_CONVERSATION_FAILED");
  }

  app.addHook("onRequest", async (request) => {
    const decision = validateBrowserRequest(request.raw.rawHeaders);
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
      const conversation = conversationStore.add(await options.port.createConversation());
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
        const result = await options.port.runPrompt(internalConversationId, message, {
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
            const result = await options.port.runPrompt(
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
      await options.port.restartApiWorker();
      return Object.freeze({ state: "ready" as const });
    } catch {
      throw new ClientGatewayError("CLIENT_RESTART_FAILED", 502);
    } finally {
      restarting = false;
    }
  });

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
