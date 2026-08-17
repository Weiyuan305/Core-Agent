import assert from "node:assert/strict";
import test from "node:test";

async function loadMapper(): Promise<(error: unknown, identifiers?: { requestId: string; traceId: string }) => { statusCode: number; envelope: Record<string, unknown> }> {
  const path = "../src/errors.ts";
  const module = await import(path).catch(() => undefined) as undefined | { mapIdentityGatewayError: (error: unknown, identifiers?: { requestId: string; traceId: string }) => { statusCode: number; envelope: Record<string, unknown> } };
  if (module !== undefined) return module.mapIdentityGatewayError;
  return () => ({ statusCode: 500, envelope: { code: "INTERNAL_ERROR", message: "missing" } });
}

test("enumeration failures have the same calm public status and body shape", async () => {
  const map = await loadMapper();
  const failures = [
    Object.assign(new Error("provider says user missing"), { code: "AUTH_INVALID" }),
    Object.assign(new Error("unknown session row"), { code: "UNAUTHENTICATED" }),
    Object.assign(new Error("unknown invitation"), { code: "RESOURCE_NOT_FOUND" }),
    Object.assign(new Error("unknown account"), { code: "AUTH_CALLBACK_INVALID" }),
  ].map((error) => map(error, { requestId: "request_01", traceId: "trace_01" }));
  assert.deepEqual(new Set(failures.map(({ statusCode }) => statusCode)), new Set([401]));
  assert.deepEqual(new Set(failures.map(({ envelope }) => JSON.stringify({ ...envelope, error_id: "opaque" }))), new Set([
    JSON.stringify({ schema_version: 1, error_id: "opaque", code: "AUTH_INVALID", category: "authentication", message: "无法完成验证，请检查信息后重试。", retryable: false, request_id: "request_01", trace_id: "trace_01" }),
  ]));
});

test("rate limit and provider outage use the exact calm Chinese copy", async () => {
  const map = await loadMapper();
  const limited = map(Object.assign(new Error("too many"), { code: "AUTH_RATE_LIMITED", retryAfterMs: 1234 }), { requestId: "request_01", traceId: "trace_01" });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.envelope.message, "尝试次数较多，请稍后再试。");
  assert.equal(limited.envelope.retry_after_ms, 1234);
  const outage = map(Object.assign(new Error("internal provider host"), { code: "AUTH_PROVIDER_UNAVAILABLE" }), { requestId: "request_01", traceId: "trace_01" });
  assert.equal(outage.statusCode, 503);
  assert.equal(outage.envelope.message, "登录服务暂时不可用，请稍后再试。");
});

test("public errors never contain provider, cookie, key, database, or internal details", async () => {
  const map = await loadMapper();
  const sentinels = ["Supabase", "Hermes", "provider-token", "core_agent_session", "key_id", "postgresql://identity:secret@db"];
  for (const sentinel of sentinels) {
    const mapped = map(new Error(sentinel), { requestId: "request_01", traceId: "trace_01" });
    assert.equal(JSON.stringify(mapped.envelope).includes(sentinel), false);
  }
});
