import type { HermesReadinessClient } from "./main.js";

export class HermesReadinessError extends Error {
  public constructor(message: string, public readonly retryable: boolean) { super(message); }
}

export class HttpHermesReadinessClient implements HermesReadinessClient {
  public constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError("Hermes readiness timeout must be bounded");
  }

  public async probe(input: { origin: string; profileRef: string; sessionId: string; ingressKey: string; modelId: string }, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const url = new URL(`/p/${encodeURIComponent(input.profileRef)}/v1/chat/completions`, input.origin);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST", signal: combined,
        headers: { authorization: `Bearer ${input.ingressKey}`, "content-type": "application/json", "x-hermes-session-id": input.sessionId },
        body: JSON.stringify({ model: input.modelId, messages: [{ role: "user", content: "Reply with exactly READY." }], stream: false, max_tokens: 8 }),
      });
    } catch {
      throw new HermesReadinessError("Hermes readiness dependency is unavailable", true);
    }
    if (!response.ok) throw new HermesReadinessError("Hermes readiness request was rejected", response.status >= 500 || response.status === 429);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HermesReadinessError("Hermes readiness response type is invalid", false);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 65_536) throw new HermesReadinessError("Hermes readiness response is too large", false);
    try {
      const parsed = JSON.parse(text) as { choices?: unknown[] };
      if (!Array.isArray(parsed.choices) || parsed.choices.length < 1) throw new Error();
    } catch {
      throw new HermesReadinessError("Hermes readiness response is invalid", false);
    }
  }
}
