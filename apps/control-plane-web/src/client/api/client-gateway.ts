import {
  CLIENT_FRAME_MAX_BYTES,
  decodeClientFrame,
  type ClientBootstrap,
  type ClientConversation,
  type ClientFrame,
  type ClientPublicErrorCode,
} from "../../shared/protocol.js";

const MAX_STREAM_BYTES = 4 * 1_024 * 1_024;
const MAX_STREAM_FRAMES = 2_048;
const csrfHeaderName = "x-core-agent-csrf";
const conversationIdPattern = /^chat_[a-f0-9]{32}$/u;
const csrfPattern = /^[a-f0-9]{64}$/u;
const publicCodes = new Set<ClientPublicErrorCode>([
  "CLIENT_CONFIGURATION_INVALID",
  "CLIENT_CONVERSATION_FAILED",
  "CLIENT_FRAME_INVALID",
  "CLIENT_HOST_INVALID",
  "CLIENT_INPUT_INVALID",
  "CLIENT_ORIGIN_INVALID",
  "CLIENT_RESTART_FAILED",
  "CLIENT_RETRY_UNAVAILABLE",
  "CLIENT_RUN_BUSY",
  "CLIENT_RUN_FAILED",
  "CLIENT_SESSION_INVALID",
]);

export interface ClientGatewayPort {
  readonly bootstrap: () => Promise<ClientBootstrap>;
  readonly createConversation: () => Promise<ClientConversation>;
  readonly runConversation: (conversationId: string, message: string) => AsyncIterable<ClientFrame>;
  readonly retryConversation: (conversationId: string) => AsyncIterable<ClientFrame>;
  readonly restartApiWorker: () => Promise<void>;
  readonly health: () => Promise<{ readonly state: "ready" }>;
}

function publicError(code: ClientPublicErrorCode): Error {
  return new Error(code);
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(record);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function parseConversation(value: unknown): ClientConversation {
  const record = plainRecord(value);
  if (
    record === undefined
    || !exactKeys(record, ["id", "title"])
    || typeof record.id !== "string"
    || !conversationIdPattern.test(record.id)
    || typeof record.title !== "string"
    || record.title.length < 1
    || record.title.length > 80
    || /[\u0000-\u001f\u007f]/u.test(record.title)
  ) throw publicError("CLIENT_CONFIGURATION_INVALID");
  return Object.freeze({ id: record.id, title: record.title });
}

function parseBootstrap(value: unknown): ClientBootstrap {
  const record = plainRecord(value);
  const student = record === undefined ? undefined : plainRecord(record.student);
  if (
    record === undefined
    || !exactKeys(record, ["conversations", "csrf", "runtimeState", "selectedConversationId", "student"])
    || typeof record.csrf !== "string"
    || !csrfPattern.test(record.csrf)
    || record.runtimeState !== "ready"
    || student === undefined
    || !exactKeys(student, ["id", "name"])
    || student.id !== "demo_student"
    || student.name !== "演示学生"
    || !Array.isArray(record.conversations)
    || record.conversations.length < 1
    || record.conversations.length > 100
    || typeof record.selectedConversationId !== "string"
  ) throw publicError("CLIENT_CONFIGURATION_INVALID");
  const conversations = Object.freeze(record.conversations.map(parseConversation));
  if (!conversations.some(({ id }) => id === record.selectedConversationId)) {
    throw publicError("CLIENT_CONFIGURATION_INVALID");
  }
  return Object.freeze({
    csrf: record.csrf,
    runtimeState: "ready",
    student: Object.freeze({ id: "demo_student", name: "演示学生" }),
    conversations,
    selectedConversationId: record.selectedConversationId,
  });
}

async function responseJson(response: Response, fallback: ClientPublicErrorCode): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw publicError(fallback);
  }
}

async function assertResponse(response: Response, fallback: ClientPublicErrorCode): Promise<Response> {
  if (response.ok) return response;
  const body = await responseJson(response, fallback).catch(() => undefined);
  const record = plainRecord(body);
  const error = record === undefined ? undefined : plainRecord(record.error);
  const code = error?.code;
  if (typeof code === "string" && publicCodes.has(code as ClientPublicErrorCode)) {
    throw publicError(code as ClientPublicErrorCode);
  }
  throw publicError(fallback);
}

function invalidStream(): never {
  throw publicError("CLIENT_FRAME_INVALID");
}

type StreamCursor = "awaiting-start" | "streaming" | "message-completed" | "terminal";

function advanceCursor(cursor: StreamCursor, frame: ClientFrame): StreamCursor {
  if (cursor === "awaiting-start" && frame.type === "run.started") return "streaming";
  if (cursor === "streaming" && frame.type === "message.delta") return cursor;
  if (cursor === "streaming" && frame.type === "message.completed") return "message-completed";
  if ((cursor === "streaming" || cursor === "message-completed") && frame.type === "run.failed") return "terminal";
  if (cursor === "message-completed" && frame.type === "run.completed") return "terminal";
  return invalidStream();
}

function parseSseEvent(event: string): ClientFrame {
  if (event.length < 7 || event.length > CLIENT_FRAME_MAX_BYTES + 6 || event.includes("\r")) invalidStream();
  const lines = event.split("\n");
  if (lines.length !== 1 || !lines[0]?.startsWith("data: ")) invalidStream();
  return decodeClientFrame(lines[0].slice(6));
}

export async function* parseClientEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ClientFrame, void, undefined> {
  if (!(stream instanceof ReadableStream)) invalidStream();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let aggregateBytes = 0;
  let frameCount = 0;
  let buffer = "";
  let cursor: StreamCursor = "awaiting-start";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) invalidStream();
      aggregateBytes += result.value.byteLength;
      if (aggregateBytes > MAX_STREAM_BYTES) invalidStream();
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        invalidStream();
      }
      if (new TextEncoder().encode(buffer).byteLength > CLIENT_FRAME_MAX_BYTES + 8 && !buffer.includes("\n\n")) {
        invalidStream();
      }
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        frameCount += 1;
        if (frameCount > MAX_STREAM_FRAMES) invalidStream();
        const frame = parseSseEvent(event);
        cursor = advanceCursor(cursor, frame);
        yield frame;
        boundary = buffer.indexOf("\n\n");
      }
    }
    try {
      buffer += decoder.decode();
    } catch {
      invalidStream();
    }
    if (buffer.length !== 0 || cursor !== "terminal") invalidStream();
  } catch (error) {
    if (error instanceof Error && error.message === "CLIENT_FRAME_INVALID") throw error;
    invalidStream();
  } finally {
    reader.releaseLock();
  }
}

export function createClientGatewayPort(fetchImpl: typeof fetch = fetch): ClientGatewayPort {
  if (typeof fetchImpl !== "function") throw publicError("CLIENT_CONFIGURATION_INVALID");
  let csrf: string | undefined;

  async function request(
    path: string,
    init: RequestInit,
    fallback: ClientPublicErrorCode,
  ): Promise<Response> {
    try {
      return await assertResponse(await fetchImpl(path, { credentials: "same-origin", ...init }), fallback);
    } catch (error) {
      if (error instanceof Error && publicCodes.has(error.message as ClientPublicErrorCode)) throw error;
      throw publicError(fallback);
    }
  }

  function mutationHeaders(contentType = true): Headers {
    if (csrf === undefined) throw publicError("CLIENT_SESSION_INVALID");
    return new Headers({
      ...(contentType ? { "content-type": "application/json" } : {}),
      [csrfHeaderName]: csrf,
    });
  }

  async function streamRequest(
    path: string,
    init: RequestInit,
  ): Promise<Response & { readonly body: ReadableStream<Uint8Array> }> {
    const response = await request(path, init, "CLIENT_RUN_FAILED");
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || response.body === null) {
      throw publicError("CLIENT_RUN_FAILED");
    }
    return response as Response & { readonly body: ReadableStream<Uint8Array> };
  }

  return Object.freeze({
    async bootstrap(): Promise<ClientBootstrap> {
      const response = await request("/client/v1/bootstrap", { method: "GET" }, "CLIENT_CONFIGURATION_INVALID");
      const result = parseBootstrap(await responseJson(response, "CLIENT_CONFIGURATION_INVALID"));
      csrf = result.csrf;
      return result;
    },
    async createConversation(): Promise<ClientConversation> {
      const response = await request("/client/v1/conversations", {
        method: "POST",
        headers: mutationHeaders(),
        body: "{}",
      }, "CLIENT_CONVERSATION_FAILED");
      return parseConversation(await responseJson(response, "CLIENT_CONVERSATION_FAILED"));
    },
    async *runConversation(conversationId: string, message: string): AsyncGenerator<ClientFrame, void, undefined> {
      if (!conversationIdPattern.test(conversationId)) throw publicError("CLIENT_CONVERSATION_FAILED");
      const response = await streamRequest(`/client/v1/conversations/${conversationId}/runs`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({ message }),
      });
      for await (const frame of parseClientEventStream(response.body)) yield frame;
    },
    async *retryConversation(conversationId: string): AsyncGenerator<ClientFrame, void, undefined> {
      if (!conversationIdPattern.test(conversationId)) throw publicError("CLIENT_CONVERSATION_FAILED");
      const response = await streamRequest(`/client/v1/conversations/${conversationId}/retries`, {
        method: "POST",
        headers: mutationHeaders(false),
      });
      for await (const frame of parseClientEventStream(response.body)) yield frame;
    },
    async restartApiWorker(): Promise<void> {
      const response = await request("/client/v1/runtime/restart", {
        method: "POST",
        headers: mutationHeaders(),
        body: "{}",
      }, "CLIENT_RESTART_FAILED");
      const result = plainRecord(await responseJson(response, "CLIENT_RESTART_FAILED"));
      if (result === undefined || !exactKeys(result, ["state"]) || result.state !== "ready") {
        throw publicError("CLIENT_RESTART_FAILED");
      }
    },
    async health(): Promise<{ readonly state: "ready" }> {
      const response = await request("/client/v1/health", { method: "GET" }, "CLIENT_CONFIGURATION_INVALID");
      const result = plainRecord(await responseJson(response, "CLIENT_CONFIGURATION_INVALID"));
      if (result === undefined || !exactKeys(result, ["state"]) || result.state !== "ready") {
        throw publicError("CLIENT_CONFIGURATION_INVALID");
      }
      return Object.freeze({ state: "ready" });
    },
  });
}
