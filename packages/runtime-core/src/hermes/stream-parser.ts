import { HermesStreamError } from "./client.js";

import type { AgentRunFailureCode } from "@core-agent/contracts";

export const MAX_HERMES_SSE_LINE_BYTES = 64 * 1024;
export const MAX_HERMES_ASSISTANT_CHARACTERS = 4_000;

type ParsedData =
  | { readonly kind: "done" }
  | { readonly kind: "ignore" }
  | { readonly kind: "delta"; readonly delta: string }
  | { readonly kind: "failure"; readonly error: HermesStreamError };

const managedFailures: Readonly<Record<string, Readonly<{
  failureCode: AgentRunFailureCode;
  retryable: boolean;
}>>> = Object.freeze({
  model_busy: { failureCode: "MODEL_BUSY", retryable: true },
  model_service_unavailable: { failureCode: "MODEL_SERVICE_UNAVAILABLE", retryable: true },
  model_response_timeout: { failureCode: "MODEL_RESPONSE_TIMEOUT", retryable: true },
  model_access_denied: { failureCode: "MODEL_ACCESS_DENIED", retryable: false },
  model_not_available: { failureCode: "MODEL_NOT_AVAILABLE", retryable: false },
  model_response_invalid: { failureCode: "MODEL_RESPONSE_INVALID", retryable: true },
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function invalidManagedTerminal(): never {
  throw new HermesStreamError("INVALID_STREAM_FIELD", false, "MODEL_RESPONSE_INVALID");
}

function managedTerminal(parsed: Record<string, unknown>): HermesStreamError | undefined {
  const choices = parsed.choices;
  const first = Array.isArray(choices) && choices.length === 1 ? choices[0] : undefined;
  const firstRecord = record(first) ? first : undefined;
  const claimsFailure = Object.hasOwn(parsed, "hermes")
    || Object.hasOwn(parsed, "error")
    || firstRecord?.finish_reason === "error";
  if (!claimsFailure) return undefined;
  if (!hasExactKeys(parsed, ["choices", "hermes"]) || firstRecord === undefined) return invalidManagedTerminal();
  if (!hasExactKeys(firstRecord, ["delta", "finish_reason", "index"])) return invalidManagedTerminal();
  if (firstRecord.index !== 0 || firstRecord.finish_reason !== "error" || !record(firstRecord.delta)) return invalidManagedTerminal();
  if (Object.keys(firstRecord.delta).length !== 0) return invalidManagedTerminal();
  const hermes = parsed.hermes;
  if (!record(hermes) || !hasExactKeys(hermes, ["completed", "error_code", "failed", "partial", "retryable"])) {
    return invalidManagedTerminal();
  }
  if (hermes.completed !== false || hermes.failed !== true || typeof hermes.partial !== "boolean") {
    return invalidManagedTerminal();
  }
  const classification = typeof hermes.error_code === "string" ? managedFailures[hermes.error_code] : undefined;
  if (classification === undefined || hermes.retryable !== classification.retryable) return invalidManagedTerminal();
  return new HermesStreamError("MANAGED_TERMINAL_FAILURE", classification.retryable, classification.failureCode);
}

function parseData(value: string): ParsedData {
  if (value === "[DONE]") return { kind: "done" };
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new HermesStreamError("INVALID_STREAM_JSON", false); }
  if (!record(parsed)) return { kind: "ignore" };
  const failure = managedTerminal(parsed);
  if (failure !== undefined) return { kind: "failure", error: failure };
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: "ignore" };
  const first = choices[0];
  if (!record(first)) return { kind: "ignore" };
  const delta = first.delta;
  if (!record(delta)) return { kind: "ignore" };
  const content = delta.content;
  return typeof content === "string" && content.length > 0
    ? { kind: "delta", delta: content }
    : { kind: "ignore" };
}

function decodeLine(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new HermesStreamError("INVALID_STREAM_UTF8", false); }
}

export async function* parseHermesEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  let pending: number[] = [];
  let aggregateLength = 0;
  let done = false;
  let terminalFailure: HermesStreamError | undefined;

  const consume = (bytes: Uint8Array): string | undefined => {
    let line = decodeLine(bytes);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0 || line.startsWith(":")) return undefined;
    if (!line.startsWith("data:")) throw new HermesStreamError("INVALID_STREAM_FIELD", false);
    const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
    const parsed = parseData(value);
    if (parsed.kind === "done") {
      done = true;
      if (terminalFailure !== undefined) throw terminalFailure;
      return undefined;
    }
    if (terminalFailure !== undefined) throw new HermesStreamError("INVALID_STREAM_FIELD", false, "MODEL_RESPONSE_INVALID");
    if (parsed.kind === "failure") {
      terminalFailure = parsed.error;
      return undefined;
    }
    if (parsed.kind !== "delta") return undefined;
    aggregateLength += parsed.delta.length;
    if (aggregateLength > MAX_HERMES_ASSISTANT_CHARACTERS) throw new HermesStreamError("ASSISTANT_CONTENT_LIMIT", false);
    return parsed.delta;
  };

  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      for (const byte of next.value) {
        if (byte === 0x0a) {
          const delta = consume(Uint8Array.from(pending));
          pending = [];
          if (delta !== undefined) yield delta;
          if (done) break;
        } else {
          pending.push(byte);
          if (pending.length > MAX_HERMES_SSE_LINE_BYTES) throw new HermesStreamError("SSE_LINE_LIMIT", false);
        }
      }
    }
    if (!done && pending.length > 0) {
      const delta = consume(Uint8Array.from(pending));
      if (delta !== undefined) yield delta;
    }
    if (!done) throw new HermesStreamError("STREAM_ENDED_BEFORE_DONE", true);
    if (aggregateLength === 0) throw new HermesStreamError("EMPTY_ASSISTANT_OUTPUT", false);
  } catch (error) {
    if (error instanceof HermesStreamError) throw error;
    throw new HermesStreamError(
      aggregateLength > 0 ? "STREAM_ENDED_BEFORE_DONE" : "DEPENDENCY_UNAVAILABLE",
      true,
    );
  } finally {
    try { await reader.cancel(); } catch { /* bounded parser cleanup */ }
    reader.releaseLock();
  }
}
