import assert from "node:assert/strict";
import test from "node:test";

import { HttpHermesReadinessClient } from "../src/hermes-readiness-client.js";

test("Hermes readiness uses multiplexed Profile route and fixed bounded synthetic request", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const client = new HttpHermesReadinessClient(async (input, init) => {
    captured = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await client.probe({ origin: "http://172.30.0.4:8642", profileRef: "consultant/a", sessionId: "readiness-runtime_a-1", ingressKey: "synthetic-key", modelId: "model_a" }, new AbortController().signal);
  assert.equal(captured?.url, "http://172.30.0.4:8642/p/consultant%2Fa/v1/chat/completions");
  const headers = new Headers(captured?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer synthetic-key");
  assert.equal(headers.get("x-hermes-session-id"), "readiness-runtime_a-1");
  assert.deepEqual(JSON.parse(String(captured?.init.body)), { model: "model_a", messages: [{ role: "user", content: "Reply with exactly READY." }], stream: false, max_tokens: 8 });
});
