import { HermesStreamError } from "./client.js";

export const MAX_HERMES_SSE_LINE_BYTES = 64 * 1024;
export const MAX_HERMES_ASSISTANT_CHARACTERS = 4_000;

function parseData(value: string): { readonly done: true } | { readonly done: false; readonly delta?: string } {
  if (value === "[DONE]") return { done: true };
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new HermesStreamError("INVALID_STREAM_JSON", false); }
  if (typeof parsed !== "object" || parsed === null) return { done: false };
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { done: false };
  const first = choices[0];
  if (typeof first !== "object" || first === null) return { done: false };
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return { done: false };
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" && content.length > 0 ? { done: false, delta: content } : { done: false };
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

  const consume = (bytes: Uint8Array): string | undefined => {
    let line = decodeLine(bytes);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0 || line.startsWith(":")) return undefined;
    if (!line.startsWith("data:")) throw new HermesStreamError("INVALID_STREAM_FIELD", false);
    const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
    const parsed = parseData(value);
    if (parsed.done) { done = true; return undefined; }
    if (parsed.delta === undefined) return undefined;
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
  } finally {
    try { await reader.cancel(); } catch { /* bounded parser cleanup */ }
    reader.releaseLock();
  }
}
