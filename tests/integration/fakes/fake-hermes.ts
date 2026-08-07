import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import { MAX_HERMES_SSE_LINE_BYTES } from "@core-agent/runtime-core";

const fakeExternalTimeoutMs = 1_500;

export type HermesFailureScript =
  | "success"
  | "managed_model_busy"
  | "managed_model_service_unavailable"
  | "managed_model_response_timeout"
  | "managed_model_access_denied"
  | "managed_model_not_available"
  | "managed_model_response_invalid"
  | "managed_unknown_error"
  | "empty_response"
  | "pre_delta_timeout"
  | "post_delta_disconnect"
  | "invalid_json"
  | "overlong_line"
  | "non_event_stream";

interface HoldScript {
  readonly kind: "hold_success";
  readonly released: Promise<void>;
}

type HermesScript = HermesFailureScript | HoldScript;

export const HERMES_CONVERSATION_SCENARIOS = Object.freeze({
  happy_path: "success",
  busy: "managed_model_busy",
  unavailable: "managed_model_service_unavailable",
  timeout: "managed_model_response_timeout",
  denied: "managed_model_access_denied",
  missing_model: "managed_model_not_available",
  malformed_response: "invalid_json",
  mid_stream_interruption: "post_delta_disconnect",
  empty_response: "empty_response",
  unknown_error: "managed_unknown_error",
} as const satisfies Readonly<Record<string, HermesFailureScript>>);

const managedFailureByScript = Object.freeze({
  managed_model_busy: { errorCode: "model_busy", retryable: true },
  managed_model_service_unavailable: {
    errorCode: "model_service_unavailable",
    retryable: true,
  },
  managed_model_response_timeout: {
    errorCode: "model_response_timeout",
    retryable: true,
  },
  managed_model_access_denied: {
    errorCode: "model_access_denied",
    retryable: false,
  },
  managed_model_not_available: {
    errorCode: "model_not_available",
    retryable: false,
  },
  managed_model_response_invalid: {
    errorCode: "model_response_invalid",
    retryable: true,
  },
} as const);

type ManagedFailureScript = keyof typeof managedFailureByScript;

function isManagedFailureScript(value: string): value is ManagedFailureScript {
  return Object.hasOwn(managedFailureByScript, value);
}

function managedTerminal(errorCode: string, retryable: boolean): string {
  return [
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      hermes: {
        completed: false,
        partial: false,
        failed: true,
        error_code: errorCode,
        retryable,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

export interface SanitizedHermesRequest {
  readonly kind: "readiness" | "execution";
  readonly route: string;
  readonly profileRef: string;
  readonly sessionId: string;
  readonly modelId: string;
  readonly authorizationAccepted: true;
  readonly bodyClosed: true;
}

export interface SanitizedHermesRejection {
  readonly category: "request" | "route_query";
}

interface FakeHermesOptions {
  readonly ingressKey: string;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function parseBody(value: unknown): {
  readonly kind: "readiness" | "execution";
  readonly modelId: string;
} | undefined {
  if (!exactRecord(value, ["model", "messages", "stream"])) {
    if (!exactRecord(value, ["model", "messages", "stream", "max_tokens"])) {
      return undefined;
    }
  }
  if (typeof value.model !== "string" || !Array.isArray(value.messages) || value.messages.length !== 1) {
    return undefined;
  }
  const message = value.messages[0];
  if (
    !exactRecord(message, ["role", "content"])
    || message.role !== "user"
    || typeof message.content !== "string"
  ) return undefined;
  if (value.stream === true && !Object.hasOwn(value, "max_tokens")) {
    return { kind: "execution", modelId: value.model };
  }
  if (
    value.stream === false
    && value.max_tokens === 8
    && message.content === "Reply with exactly READY."
  ) return { kind: "readiness", modelId: value.model };
  return undefined;
}

async function readClosedBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 64 * 1024) throw new Error("body limit");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
}

export class FakeHermes {
  readonly #options: FakeHermesOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #scripts: HermesScript[] = [];
  readonly #requests: SanitizedHermesRequest[] = [];
  readonly #rejections: SanitizedHermesRejection[] = [];
  #origin: string | undefined;

  public constructor(options: FakeHermesOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
  }

  public get origin(): string {
    if (this.#origin === undefined) throw new Error("Fake Hermes is not listening");
    return this.#origin;
  }

  public get requests(): readonly SanitizedHermesRequest[] {
    return this.#requests;
  }

  public get executionCallCount(): number {
    return this.#requests.filter((request) => request.kind === "execution").length;
  }

  public get rejections(): readonly SanitizedHermesRejection[] {
    return this.#rejections;
  }

  public enqueue(...scripts: readonly HermesFailureScript[]): void {
    this.#scripts.push(...scripts);
  }

  public holdNextSuccess(): () => void {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#scripts.push({ kind: "hold_success", released });
    return release;
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#server.off("error", onError);
        try { this.#server.close(() => undefined); }
        catch { /* The bounded caller still receives only the stage category. */ }
        reject(new Error("Fake Hermes start failed"));
      }, fakeExternalTimeoutMs);
      const onError = (): void => {
        clearTimeout(timer);
        reject(new Error("Fake Hermes start failed"));
      };
      this.#server.once("error", onError);
      this.#server.listen(0, "127.0.0.1", () => {
        clearTimeout(timer);
        this.#server.off("error", onError);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Fake Hermes did not bind an IP port"));
          return;
        }
        this.#origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  public async refuseConnections(): Promise<void> {
    await this.closeListening();
  }

  public async closeListening(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Fake Hermes close failed")),
          fakeExternalTimeoutMs,
        );
        this.#server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  public async close(): Promise<void> {
    await this.closeListening();
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let rejectionCategory: SanitizedHermesRejection["category"] = "request";
    try {
      if (request.method !== "POST") throw new Error("method");
      const target = new URL(request.url ?? "", "http://fake.invalid");
      if (target.search.length > 0 || target.hash.length > 0) {
        rejectionCategory = "route_query";
        throw new Error("route query");
      }
      const route = target.pathname;
      const match = /^\/p\/([A-Za-z0-9_.%-]+)\/v1\/chat\/completions$/.exec(route);
      if (match === null) throw new Error("route");
      const profileRef = decodeURIComponent(match[1]!);
      const authorization = request.headers.authorization;
      const sessionId = request.headers["x-hermes-session-id"];
      if (
        authorization !== `Bearer ${this.#options.ingressKey}`
        || typeof sessionId !== "string"
        || sessionId.length < 1
        || request.headers["content-type"] !== "application/json"
      ) throw new Error("headers");
      const parsed = parseBody(await readClosedBody(request));
      if (parsed === undefined) throw new Error("body");
      this.#requests.push(Object.freeze({
        kind: parsed.kind,
        route,
        profileRef,
        sessionId,
        modelId: parsed.modelId,
        authorizationAccepted: true,
        bodyClosed: true,
      }));

      if (parsed.kind === "readiness") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "READY" } }] }));
        return;
      }

      const script = this.#scripts.shift() ?? "success";
      if (typeof script === "object") await script.released;
      const kind = typeof script === "string" ? script : "success";
      if (kind === "pre_delta_timeout") return;
      if (kind === "non_event_stream") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (isManagedFailureScript(kind)) {
        const failure = managedFailureByScript[kind];
        response.end(managedTerminal(failure.errorCode, failure.retryable));
        return;
      }
      if (kind === "managed_unknown_error") {
        response.end(managedTerminal("future_provider_failure", false));
        return;
      }
      if (kind === "empty_response") {
        response.end("data: [DONE]\n\n");
        return;
      }
      if (kind === "invalid_json") {
        response.end("data: {invalid-json}\n\n");
        return;
      }
      if (kind === "overlong_line") {
        response.end(`data: ${"x".repeat(MAX_HERMES_SSE_LINE_BYTES + 1)}\n\n`);
        return;
      }
      if (kind === "post_delta_disconnect") response.flushHeaders();
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Synthetic " } }] })}\n\n`,
      );
      if (kind === "post_delta_disconnect") {
        const socket = response.socket;
        setTimeout(() => socket?.destroy(), 10);
        return;
      }
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "response" } }] })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
    } catch {
      this.#rejections.push(Object.freeze({ category: rejectionCategory }));
      response.writeHead(400, { "content-type": "application/json" });
      response.end("{}");
    }
  }
}
