import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClientGatewayApp } from "../src/server/app.js";
import type { ManagedChatPort } from "../src/server/runtime-chat-port.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function staticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "core-agent-web-test-"));
  roots.push(root);
  await writeFile(join(root, "index.html"), "<!doctype html><title>Core Agent</title>", "utf8");
  return root;
}

function fakePort(overrides: Partial<ManagedChatPort> = {}): ManagedChatPort {
  return {
    createConversation: vi.fn(async () => "conversation_internal_1"),
    runPrompt: vi.fn(async (_id, _content, sink) => {
      sink.onStarted();
      sink.onDelta("Hello ");
      sink.onDelta("consultant");
      return { status: "succeeded", runId: "run_internal_success" } as const;
    }),
    restartApiWorker: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function bootstrapBrowser(app: Awaited<ReturnType<typeof buildClientGatewayApp>>) {
  const response = await app.inject({
    method: "GET",
    url: "/client/v1/bootstrap",
    headers: { host: "127.0.0.1:4173", "sec-fetch-site": "same-origin" },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  const setCookie = response.headers["set-cookie"];
  expect(typeof setCookie).toBe("string");
  const cookie = (setCookie as string).split(";", 1)[0];
  return {
    body,
    conversationId: body.selectedConversationId as string,
    mutationHeaders: {
      host: "127.0.0.1:4173",
      origin: "http://127.0.0.1:4173",
      "sec-fetch-site": "same-origin",
      cookie,
      "x-core-agent-csrf": body.csrf as string,
    },
  };
}

describe("Client Gateway", () => {
  it("bootstraps one public Conversation and never returns the internal identity", async () => {
    const port = fakePort();
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    expect(session.body).toMatchObject({
      runtimeState: "ready",
      student: { id: "demo_student", name: "演示学生" },
      conversations: [{ id: session.conversationId, title: "演示空间" }],
    });
    expect(session.conversationId).toMatch(/^chat_[a-f0-9]{32}$/u);
    expect(JSON.stringify(session.body)).not.toContain("conversation_internal_1");
    expect(port.createConversation).toHaveBeenCalledOnce();
    await app.close();
  });

  it("streams allowlisted frames without an internal identity", async () => {
    const port = fakePort();
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const response = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "synthetic prompt" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('data: {"type":"run.started"}');
    expect(response.body).toContain('data: {"type":"message.delta","delta":"Hello "}');
    expect(response.body).toContain('data: {"type":"run.completed"}');
    expect(response.body).not.toContain("conversation_internal_1");
    expect(port.runPrompt).toHaveBeenCalledWith(
      "conversation_internal_1",
      "synthetic prompt",
      expect.any(Object),
    );
    await app.close();
  });

  it.each([
    [{ message: "" }, "CLIENT_INPUT_INVALID"],
    [{ message: "bad\u0000input" }, "CLIENT_INPUT_INVALID"],
    [{ message: "synthetic", extra: true }, "CLIENT_INPUT_INVALID"],
  ])("rejects invalid input without invoking a Run", async (payload, code) => {
    const port = fakePort();
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const response = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code } });
    expect(port.runPrompt).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a missing CSRF header before invoking a mutation", async () => {
    const port = fakePort();
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const { "x-core-agent-csrf": _csrf, ...headers } = session.mutationHeaders;
    const response = await app.inject({ method: "POST", url: "/client/v1/conversations", headers, payload: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "CLIENT_SESSION_INVALID" } });
    expect(port.createConversation).toHaveBeenCalledOnce();
    await app.close();
  });

  it("creates a distinct public Conversation", async () => {
    let index = 0;
    const port = fakePort({ createConversation: vi.fn(async () => `conversation_internal_${index += 1}`) });
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const response = await app.inject({
      method: "POST",
      url: "/client/v1/conversations",
      headers: session.mutationHeaders,
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().id).toMatch(/^chat_[a-f0-9]{32}$/u);
    expect(response.json().id).not.toBe(session.conversationId);
    expect(JSON.stringify(response.json())).not.toContain("conversation_internal_2");
    await app.close();
  });

  it("restarts the exact managed port once", async () => {
    const port = fakePort();
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const response = await app.inject({
      method: "POST",
      url: "/client/v1/runtime/restart",
      headers: session.mutationHeaders,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: "ready" });
    expect(port.restartApiWorker).toHaveBeenCalledOnce();
    await app.close();
  });

  it("maps raw managed errors to a stable public code", async () => {
    const port = fakePort({ runPrompt: vi.fn(async () => { throw new Error("provider secret body"); }) });
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const response = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "synthetic prompt" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: "CLIENT_RUN_FAILED" } });
    expect(response.body).not.toContain("provider secret body");
    await app.close();
  });

  it("emits only a public failure reason and retries from server-held Run state", async () => {
    let callCount = 0;
    const runPrompt = vi.fn(async (_id, content, sink, retry) => {
      callCount += 1;
      sink.onStarted();
      expect(content).toBe("server held message");
      if (callCount === 1) {
        expect(retry).toBeUndefined();
        return { status: "failed" as const, runId: "run_internal_parent", failureCode: "MODEL_BUSY" as const };
      }
      expect(retry).toEqual({ parentRunId: "run_internal_parent" });
      sink.onDelta("retry succeeded");
      return { status: "succeeded" as const, runId: "run_internal_child" };
    });
    const app = await buildClientGatewayApp({
      port: fakePort({ runPrompt }),
      staticRoot: await staticRoot(),
    });
    const session = await bootstrapBrowser(app);
    const failed = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "server held message" },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toContain('data: {"type":"run.failed","reason":"BUSY"}');
    for (const forbidden of ["MODEL_BUSY", "run_internal_parent", "server held message"]) {
      expect(failed.body).not.toContain(forbidden);
    }

    const retried = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/retries`,
      headers: session.mutationHeaders,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toContain('data: {"type":"message.delta","delta":"retry succeeded"}');
    expect(retried.body).toContain('data: {"type":"run.completed"}');
    expect(runPrompt).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("coalesces concurrent retry clicks and replays one successful child", async () => {
    let callCount = 0;
    let childStarted!: () => void;
    let releaseChild!: () => void;
    const childIsStarted = new Promise<void>((resolve) => { childStarted = resolve; });
    const holdChild = new Promise<void>((resolve) => { releaseChild = resolve; });
    const runPrompt = vi.fn(async (_id, _content, sink, retry) => {
      callCount += 1;
      sink.onStarted();
      if (callCount === 1) {
        return { status: "failed" as const, runId: "run_failed_parent", failureCode: "MODEL_RESPONSE_TIMEOUT" as const };
      }
      expect(retry).toEqual({ parentRunId: "run_failed_parent" });
      childStarted();
      await holdChild;
      sink.onDelta("one child");
      return { status: "succeeded" as const, runId: "run_child_once" };
    });
    const app = await buildClientGatewayApp({ port: fakePort({ runPrompt }), staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "original message" },
    });
    const retryRequest = {
      method: "POST" as const,
      url: `/client/v1/conversations/${session.conversationId}/retries`,
      headers: session.mutationHeaders,
    };
    const first = app.inject(retryRequest);
    await childIsStarted;
    const second = app.inject(retryRequest);
    releaseChild();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.body).toContain("one child");
    expect(secondResponse.body).toContain("one child");
    expect(runPrompt).toHaveBeenCalledTimes(2);

    const replay = await app.inject(retryRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain("one child");
    expect(runPrompt).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it.each([
    ["MODEL_ACCESS_DENIED", "SERVICE_UNAVAILABLE"],
    ["MODEL_NOT_AVAILABLE", "SERVICE_UNAVAILABLE"],
  ] as const)("does not offer child Run admission for %s", async (failureCode, reason) => {
    const port = fakePort({
      runPrompt: vi.fn(async (_id, _content, sink) => {
        sink.onStarted();
        return { status: "failed" as const, runId: "run_not_retryable", failureCode };
      }),
    });
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const failed = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "synthetic" },
    });
    expect(failed.body).toContain(`\"reason\":\"${reason}\"`);
    const retry = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/retries`,
      headers: session.mutationHeaders,
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: { code: "CLIENT_RETRY_UNAVAILABLE" } });
    expect(retry.body).not.toContain("run_not_retryable");
    expect(port.runPrompt).toHaveBeenCalledOnce();
    await app.close();
  });

  it("requires no retry body and rejects unknown or successful Conversations", async () => {
    const port = fakePort();
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const successful = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "synthetic" },
    });
    expect(successful.statusCode).toBe(200);

    const bodyRejected = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/retries`,
      headers: session.mutationHeaders,
      payload: {},
    });
    expect(bodyRejected.statusCode).toBe(400);
    expect(bodyRejected.json()).toMatchObject({ error: { code: "CLIENT_INPUT_INVALID" } });

    const unavailable = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/retries`,
      headers: session.mutationHeaders,
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({ error: { code: "CLIENT_RETRY_UNAVAILABLE" } });

    const unknown = await app.inject({
      method: "POST",
      url: "/client/v1/conversations/chat_00000000000000000000000000000000/retries",
      headers: session.mutationHeaders,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).not.toContain("conversation_internal");
    expect(port.runPrompt).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects retry while a newer Run is active", async () => {
    let callCount = 0;
    let newerStarted!: () => void;
    let releaseNewer!: () => void;
    const newerIsStarted = new Promise<void>((resolve) => { newerStarted = resolve; });
    const holdNewer = new Promise<void>((resolve) => { releaseNewer = resolve; });
    const runPrompt = vi.fn(async (_id, _content, sink) => {
      callCount += 1;
      sink.onStarted();
      if (callCount === 1) {
        return { status: "failed" as const, runId: "run_old_failed", failureCode: "MODEL_BUSY" as const };
      }
      newerStarted();
      await holdNewer;
      return { status: "succeeded" as const, runId: "run_new_success" };
    });
    const app = await buildClientGatewayApp({ port: fakePort({ runPrompt }), staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const runRequest = {
      method: "POST" as const,
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "newer turn" },
    };
    await app.inject(runRequest);
    const newer = app.inject(runRequest);
    await newerIsStarted;
    const retry = await app.inject({
      method: "POST",
      url: `/client/v1/conversations/${session.conversationId}/retries`,
      headers: session.mutationHeaders,
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: { code: "CLIENT_RUN_BUSY" } });
    expect(runPrompt).toHaveBeenCalledTimes(2);
    releaseNewer();
    await newer;
    await app.close();
  });

  it("admits only one active Run per public Conversation", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let callCount = 0;
    const port = fakePort({
      runPrompt: vi.fn(async (_id, _content, sink) => {
        callCount += 1;
        sink.onStarted();
        if (callCount === 1) {
          markStarted();
          await holdFirst;
        }
      }),
    });
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const request = {
      method: "POST" as const,
      url: `/client/v1/conversations/${session.conversationId}/runs`,
      headers: session.mutationHeaders,
      payload: { message: "synthetic prompt" },
    };
    const first = app.inject(request);
    await firstStarted;
    const second = await app.inject(request);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "CLIENT_RUN_BUSY" } });
    releaseFirst();
    await first;
    expect(port.runPrompt).toHaveBeenCalledOnce();
    await app.close();
  });

  it("admits only one API and Worker restart at a time", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let restartCount = 0;
    const port = fakePort({
      restartApiWorker: vi.fn(async () => {
        restartCount += 1;
        if (restartCount === 1) {
          markStarted();
          await holdFirst;
        }
      }),
    });
    const app = await buildClientGatewayApp({ port, staticRoot: await staticRoot() });
    const session = await bootstrapBrowser(app);
    const request = {
      method: "POST" as const,
      url: "/client/v1/runtime/restart",
      headers: session.mutationHeaders,
      payload: {},
    };
    const first = app.inject(request);
    await firstStarted;
    const second = await app.inject(request);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "CLIENT_RUN_BUSY" } });
    releaseFirst();
    await first;
    expect(port.restartApiWorker).toHaveBeenCalledOnce();
    await app.close();
  });
});
