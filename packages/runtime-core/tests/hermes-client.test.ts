import assert from "node:assert/strict";
import test from "node:test";

import {
  HermesClient,
  HermesStreamError,
  type SecretMaterial,
} from "../src/index.js";

function material(value = "synthetic-ingress-key-00000001") {
  let releases = 0;
  const secret: SecretMaterial = {
    reference: { reference_id: "ingress_test", version: 1, purpose: "hermes_ingress" },
    text: () => value,
    release: () => { releases += 1; },
  };
  return { secret, releases: () => releases };
}

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function sseResponse(chunks: readonly Uint8Array[], init: ResponseInit = {}): Response {
  return new Response(byteStream(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    ...init,
  });
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

const baseInput = {
  origin: "http://core-agent-runtime-example:8642",
  profileRef: "consultant_a",
  sessionRef: "hermes_session_1",
  modelId: "cywx/gpt-5.6-sol",
  timeoutMs: 90_000,
  content: "Synthetic hello",
} as const;

function managedFailurePayload(errorCode: string, retryable: boolean, partial = false): Uint8Array {
  return new TextEncoder().encode([
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      hermes: {
        completed: false,
        partial,
        failed: true,
        error_code: errorCode,
        retryable,
      },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""));
}

test("Hermes client maps every managed terminal failure to one internal Run code", async () => {
  const cases = [
    ["model_busy", "MODEL_BUSY", true],
    ["model_service_unavailable", "MODEL_SERVICE_UNAVAILABLE", true],
    ["model_response_timeout", "MODEL_RESPONSE_TIMEOUT", true],
    ["model_access_denied", "MODEL_ACCESS_DENIED", false],
    ["model_not_available", "MODEL_NOT_AVAILABLE", false],
    ["model_response_invalid", "MODEL_RESPONSE_INVALID", true],
  ] as const;

  for (const [managedCode, failureCode, retryable] of cases) {
    const ingress = material();
    const client = new HermesClient({
      fetch: async () => sseResponse([managedFailurePayload(managedCode, retryable)]),
    });
    await assert.rejects(
      collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })),
      (error: unknown) => {
        assert.equal(error instanceof HermesStreamError, true);
        if (!(error instanceof HermesStreamError)) return false;
        assert.equal(error.failureCode, failureCode);
        assert.equal(error.retryable, retryable);
        return true;
      },
    );
    assert.equal(ingress.releases(), 1);
  }
});

test("Hermes client rejects malformed and legacy error terminals without reflecting raw diagnostics", async () => {
  const canary = "raw-provider-token-canary";
  const cases = [
    managedFailurePayload("provider_503", true),
    new TextEncoder().encode([
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        error: { message: canary, body: canary },
        hermes: { error: canary, error_code: "agent_error" },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")),
    new TextEncoder().encode([
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        hermes: {
          completed: false,
          partial: false,
          failed: true,
          error_code: "model_service_unavailable",
          retryable: true,
          message: canary,
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")),
  ];

  for (const payload of cases) {
    const ingress = material();
    const client = new HermesClient({ fetch: async () => sseResponse([payload]) });
    await assert.rejects(
      collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })),
      (error: unknown) => {
        assert.equal(error instanceof HermesStreamError, true);
        if (!(error instanceof HermesStreamError)) return false;
        assert.equal(error.failureCode, "MODEL_RESPONSE_INVALID");
        assert.doesNotMatch(`${String(error)} ${JSON.stringify(error)}`, new RegExp(canary));
        return true;
      },
    );
    assert.equal(ingress.releases(), 1);
  }
});

test("Hermes client rejects duplicate terminals and data after a terminal", async () => {
  const terminal = JSON.stringify({
    choices: [{ index: 0, delta: {}, finish_reason: "error" }],
    hermes: {
      completed: false,
      partial: false,
      failed: true,
      error_code: "model_busy",
      retryable: true,
    },
  });
  for (const body of [
    `data: ${terminal}\n\ndata: ${terminal}\n\ndata: [DONE]\n\n`,
    `data: ${terminal}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "late" } }] })}\n\ndata: [DONE]\n\n`,
  ]) {
    const ingress = material();
    const client = new HermesClient({ fetch: async () => sseResponse([new TextEncoder().encode(body)]) });
    await assert.rejects(
      collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })),
      (error: unknown) => error instanceof HermesStreamError
        && error.failureCode === "MODEL_RESPONSE_INVALID",
    );
  }
});

test("Hermes client decodes split SSE frames and UTF-8 boundaries, sends the bounded request, and releases material", async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode([
    "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\r\n",
    "\r\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\"好\"},\"usage\":{\"hidden\":1}}],\"reasoning\":\"hidden\"}\n\n",
    "data: [DONE]\n\n",
  ].join(""));
  const chunks = [bytes.slice(0, 11), bytes.slice(11, 47), bytes.slice(47, 49), bytes.slice(49, 103), bytes.slice(103)];
  const captured: { url?: string; init?: RequestInit } = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    captured.url = String(input); captured.init = init;
    return sseResponse(chunks);
  };
  const ingress = material();
  const client = new HermesClient({ fetch: fetchImpl });

  assert.deepEqual(await collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })), ["你", "好"]);
  assert.equal(captured.url, "http://core-agent-runtime-example:8642/p/consultant_a/v1/chat/completions");
  assert.deepEqual(captured.init?.headers, {
    authorization: "Bearer synthetic-ingress-key-00000001",
    "content-type": "application/json",
    "x-hermes-session-id": "hermes_session_1",
  });
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    model: "cywx/gpt-5.6-sol",
    messages: [{ role: "user", content: "Synthetic hello" }],
    stream: true,
  });
  assert.equal(captured.init?.redirect, "error");
  assert.equal(ingress.releases(), 1);
});

test("Hermes client requires an exact DONE marker and rejects malformed JSON, invalid UTF-8, and premature EOF without reflection", async () => {
  const cases = [
    [new TextEncoder().encode("data: {not-json}\n\ndata: [DONE]\n\n"), "invalid JSON"],
    [Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]), "invalid UTF-8"],
    [new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"), "before DONE"],
    [new TextEncoder().encode("data: [DONE] \n\n"), "invalid JSON"],
  ] as const;
  for (const [bytes, expected] of cases) {
    const ingress = material();
    const client = new HermesClient({ fetch: async () => sseResponse([bytes]) });
    await assert.rejects(collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })), (error: unknown) => {
      assert.match(String(error), new RegExp(expected, "i"));
      assert.doesNotMatch(String(error), /partial|not-json|synthetic-ingress-key/);
      return true;
    });
    assert.equal(ingress.releases(), 1);
  }
});

test("Hermes client rejects overlong lines and aggregate assistant content over 4000 characters", async () => {
  const line = `data: ${"x".repeat(65_537)}\n\n`;
  const aggregate = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(4_000) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "y" } }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  for (const [payload, expected] of [[line, /line limit/i], [aggregate, /content limit/i]] as const) {
    const ingress = material();
    const client = new HermesClient({ fetch: async () => sseResponse([new TextEncoder().encode(payload)]) });
    await assert.rejects(collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })), expected);
    assert.equal(ingress.releases(), 1);
  }
});

test("Hermes client rejects status and content type without exposing provider bodies or headers", async () => {
  for (const response of [
    new Response("provider-token=hidden", { status: 503, headers: { "x-provider-secret": "hidden" } }),
    new Response("provider-token=hidden", { status: 200, headers: { "content-type": "application/json", "x-provider-secret": "hidden" } }),
  ]) {
    const ingress = material();
    const client = new HermesClient({ fetch: async () => response });
    await assert.rejects(collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })), (error: unknown) => {
      assert.doesNotMatch(String(error), /provider-token|x-provider-secret|hidden/);
      return true;
    });
    assert.equal(ingress.releases(), 1);
  }
});

test("Hermes client redacts a raw transport disconnect after a parsed delta and releases material", async () => {
  const ingress = material();
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`));
      else controller.error(new Error("socket raw-provider-token"));
    },
  }, { highWaterMark: 0 });
  const client = new HermesClient({ fetch: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }) });
  const seen: string[] = [];
  await assert.rejects((async () => {
    for await (const delta of client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })) seen.push(delta);
  })(), (error: unknown) => {
    assert.equal(error instanceof HermesStreamError && error.failureCode === "MODEL_STREAM_INTERRUPTED", true);
    assert.doesNotMatch(String(error), /raw-provider-token|socket/);
    return true;
  });
  assert.deepEqual(seen, ["partial"]);
  assert.equal(ingress.releases(), 1);
});

test("Hermes client accepts only the managed private http origin and one validated Profile segment", async () => {
  const invalid = [
    { origin: "https://core-agent-runtime-example:8642" },
    { origin: "http://public.example:8642" },
    { origin: "http://user:pass@core-agent-runtime-example:8642" },
    { origin: "http://core-agent-runtime-example:8643" },
    { origin: "http://core-agent-runtime-example:8642/prefix" },
    { origin: "http://core-agent-runtime-example:8642/?query=1" },
    { origin: "http://core-agent-runtime-example:8642/#fragment" },
    { origin: "http://127.0.0.1:8642" },
    { profileRef: "../admin" },
    { profileRef: "consultant A" },
    { profileRef: "%2fadmin" },
    { profileRef: "\u0000admin" },
    { sessionRef: "session\tadmin" },
    { modelId: "model\u007fadmin" },
  ];
  for (const change of invalid) {
    const ingress = material(); let calls = 0;
    const client = new HermesClient({ fetch: async () => { calls += 1; return sseResponse([new TextEncoder().encode("data: [DONE]\n\n")]); } });
    await assert.rejects(collect(client.streamChat({ ...baseInput, ...change, ingressMaterial: ingress.secret })));
    assert.equal(calls, 0);
    assert.equal(ingress.releases(), 1);
  }
});

test("Hermes client rejects DONE without any non-empty assistant content", async () => {
  const ingress = material();
  const client = new HermesClient({ fetch: async () => sseResponse([new TextEncoder().encode("data: [DONE]\n\n")]) });
  await assert.rejects(
    collect(client.streamChat({ ...baseInput, ingressMaterial: ingress.secret })),
    (error: unknown) => error instanceof HermesStreamError
      && error.failureCode === "MODEL_EMPTY_RESPONSE"
      && /empty assistant output/i.test(String(error)),
  );
  assert.equal(ingress.releases(), 1);
});

test("Hermes client composes timeout and caller abort and releases material on every exit", async () => {
  for (const abortBy of ["timeout", "caller"] as const) {
    const ingress = material();
    const caller = new AbortController();
    const client = new HermesClient({ fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }) });
    const pending = collect(client.streamChat({ ...baseInput, timeoutMs: 5, signal: caller.signal, ingressMaterial: ingress.secret }));
    if (abortBy === "caller") caller.abort(new Error("caller-private-reason"));
    await assert.rejects(pending, (error: unknown) => {
      assert.equal(
        error instanceof HermesStreamError && error.failureCode === (
          abortBy === "timeout" ? "MODEL_RESPONSE_TIMEOUT" : "RUN_INTERNAL_ERROR"
        ),
        true,
      );
      assert.doesNotMatch(String(error), /caller-private-reason/);
      return true;
    });
    assert.equal(ingress.releases(), 1);
  }
});
