import { isIP } from "node:net";

import type { AgentRunFailureCode } from "@core-agent/contracts";

import type { SecretMaterial } from "../secrets/secret-store.js";

export type HermesStreamErrorCode =
  | "INVALID_MANAGED_ORIGIN"
  | "INVALID_PROFILE_REF"
  | "INVALID_REQUEST"
  | "DEPENDENCY_UNAVAILABLE"
  | "DEPENDENCY_TIMEOUT"
  | "CALLER_ABORTED"
  | "INVALID_RESPONSE_STATUS"
  | "INVALID_RESPONSE_CONTENT_TYPE"
  | "INVALID_RESPONSE_BODY"
  | "INVALID_STREAM_FIELD"
  | "INVALID_STREAM_JSON"
  | "INVALID_STREAM_UTF8"
  | "SSE_LINE_LIMIT"
  | "ASSISTANT_CONTENT_LIMIT"
  | "EMPTY_ASSISTANT_OUTPUT"
  | "STREAM_ENDED_BEFORE_DONE"
  | "MANAGED_TERMINAL_FAILURE";

const messages: Record<HermesStreamErrorCode, string> = {
  INVALID_MANAGED_ORIGIN: "Hermes managed origin is invalid",
  INVALID_PROFILE_REF: "Hermes Profile reference is invalid",
  INVALID_REQUEST: "Hermes request is invalid",
  DEPENDENCY_UNAVAILABLE: "Hermes dependency is unavailable",
  DEPENDENCY_TIMEOUT: "Hermes dependency timed out",
  CALLER_ABORTED: "Hermes operation was aborted",
  INVALID_RESPONSE_STATUS: "Hermes returned an invalid status",
  INVALID_RESPONSE_CONTENT_TYPE: "Hermes returned an invalid content type",
  INVALID_RESPONSE_BODY: "Hermes returned an invalid streaming body",
  INVALID_STREAM_FIELD: "Hermes stream contains an invalid field",
  INVALID_STREAM_JSON: "Hermes stream contains invalid JSON",
  INVALID_STREAM_UTF8: "Hermes stream contains invalid UTF-8",
  SSE_LINE_LIMIT: "Hermes stream exceeded the line limit",
  ASSISTANT_CONTENT_LIMIT: "Hermes stream exceeded the content limit",
  EMPTY_ASSISTANT_OUTPUT: "Hermes stream returned empty assistant output",
  STREAM_ENDED_BEFORE_DONE: "Hermes stream ended before DONE",
  MANAGED_TERMINAL_FAILURE: "Hermes managed terminal reported a failure",
};

function defaultFailureCode(code: HermesStreamErrorCode): AgentRunFailureCode {
  if (code === "DEPENDENCY_TIMEOUT") return "MODEL_RESPONSE_TIMEOUT";
  if (code === "DEPENDENCY_UNAVAILABLE") return "AGENT_RUNTIME_NOT_READY";
  if (code === "EMPTY_ASSISTANT_OUTPUT") return "MODEL_EMPTY_RESPONSE";
  if (code === "STREAM_ENDED_BEFORE_DONE") return "MODEL_STREAM_INTERRUPTED";
  if (
    code === "INVALID_RESPONSE_STATUS"
    || code === "INVALID_RESPONSE_CONTENT_TYPE"
    || code === "INVALID_RESPONSE_BODY"
    || code === "INVALID_STREAM_FIELD"
    || code === "INVALID_STREAM_JSON"
    || code === "INVALID_STREAM_UTF8"
    || code === "SSE_LINE_LIMIT"
    || code === "ASSISTANT_CONTENT_LIMIT"
    || code === "MANAGED_TERMINAL_FAILURE"
  ) return "MODEL_RESPONSE_INVALID";
  return "RUN_INTERNAL_ERROR";
}

export class HermesStreamError extends Error {
  public constructor(
    public readonly code: HermesStreamErrorCode,
    public readonly retryable: boolean,
    public readonly failureCode: AgentRunFailureCode = defaultFailureCode(code),
  ) {
    super(messages[code]);
    this.name = "HermesStreamError";
  }
}

export interface HermesChatInput {
  readonly origin: string;
  readonly profileRef: string;
  readonly sessionRef: string;
  readonly ingressMaterial: SecretMaterial;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly content: string;
  readonly signal?: AbortSignal;
}

export interface HermesClientOptions { readonly fetch?: typeof fetch }

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^core-agent-runtime-[a-z0-9]{4,64}$/.test(host)) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168);
  }
  return isIP(host) === 6 && /^(fc|fd)/i.test(host);
}

export function validateManagedHermesOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HermesStreamError("INVALID_MANAGED_ORIGIN", false); }
  if (
    url.protocol !== "http:" || url.port !== "8642" || url.username !== "" || url.password !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== "" || !privateHost(url.hostname)
  ) throw new HermesStreamError("INVALID_MANAGED_ORIGIN", false);
  return url.origin;
}

function profileSegment(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === "." || value === ".."
  ) throw new HermesStreamError("INVALID_PROFILE_REF", false);
  return encodeURIComponent(value);
}

function validateInput(input: HermesChatInput): { readonly url: string; readonly timeoutMs: number } {
  const origin = validateManagedHermesOrigin(input.origin);
  const profile = profileSegment(input.profileRef);
  if (
    input.sessionRef.length < 1 || input.sessionRef.length > 255 || /[\u0000-\u001f\u007f]/.test(input.sessionRef)
    || input.modelId.length < 1 || input.modelId.length > 255 || /[\u0000-\u001f\u007f]/.test(input.modelId)
    || input.content.length < 1 || input.content.length > 4_000
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000
  ) throw new HermesStreamError("INVALID_REQUEST", false);
  return { url: `${origin}/p/${profile}/v1/chat/completions`, timeoutMs: input.timeoutMs };
}

function contentType(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

export class HermesClient {
  readonly #fetch: typeof fetch;
  public constructor(options: HermesClientOptions = {}) { this.#fetch = options.fetch ?? fetch; }

  public async *streamChat(input: HermesChatInput): AsyncGenerator<string> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(new HermesStreamError("CALLER_ABORTED", false));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const validated = validateInput(input);
      if (input.signal?.aborted) throw new HermesStreamError("CALLER_ABORTED", false);
      input.signal?.addEventListener("abort", onCallerAbort, { once: true });
      timeout = setTimeout(() => controller.abort(new HermesStreamError("DEPENDENCY_TIMEOUT", true)), validated.timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(validated.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.ingressMaterial.text()}`,
            "content-type": "application/json",
            "x-hermes-session-id": input.sessionRef,
          },
          body: JSON.stringify({ model: input.modelId, messages: [{ role: "user", content: input.content }], stream: true }),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        if (input.signal?.aborted) throw new HermesStreamError("CALLER_ABORTED", false);
        if (controller.signal.aborted) throw new HermesStreamError("DEPENDENCY_TIMEOUT", true);
        throw new HermesStreamError("DEPENDENCY_UNAVAILABLE", true);
      }
      if (response.status < 200 || response.status >= 300) throw new HermesStreamError("INVALID_RESPONSE_STATUS", false);
      if (!contentType(response)) throw new HermesStreamError("INVALID_RESPONSE_CONTENT_TYPE", false);
      if (response.body === null) throw new HermesStreamError("INVALID_RESPONSE_BODY", false);
      const { parseHermesEventStream } = await import("./stream-parser.js");
      try {
        for await (const delta of parseHermesEventStream(response.body)) yield delta;
      } catch (error) {
        if (error instanceof HermesStreamError) throw error;
        if (input.signal?.aborted) throw new HermesStreamError("CALLER_ABORTED", false);
        if (controller.signal.aborted) throw new HermesStreamError("DEPENDENCY_TIMEOUT", true);
        throw new HermesStreamError("DEPENDENCY_UNAVAILABLE", true);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onCallerAbort);
      input.ingressMaterial.release();
    }
  }
}
