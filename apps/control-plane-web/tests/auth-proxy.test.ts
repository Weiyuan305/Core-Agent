import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildClientGatewayApp } from "../src/server/app.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function staticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "core-agent-web-auth-proxy-"));
  roots.push(root);
  await writeFile(join(root, "index.html"), "<!doctype html><title>Core Agent</title>", "utf8");
  return root;
}

describe("Identity Gateway same-origin proxy", () => {
  it("runs public-auth mode without constructing a synthetic Conversation or Session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1,
      error_id: "error_unauthenticated",
      code: "AUTH_INVALID",
      category: "authentication",
      message: "无法完成验证，请检查信息后重试。",
      retryable: false,
      request_id: "request_proxy",
      trace_id: "trace_proxy",
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const app = await buildClientGatewayApp({
      authProxy: {
        origin: "http://127.0.0.1:4910",
        publicOrigin: "https://app.example.com",
        fetchImpl,
      },
      staticRoot: await staticRoot(),
    });
    const config = await app.inject({ method: "GET", url: "/client/v1/config", headers: { host: "app.example.com" } });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({ schema_version: 1, mode: "public_auth" });
    const bootstrap = await app.inject({ method: "GET", url: "/client/v1/bootstrap", headers: { host: "app.example.com" } });
    expect(bootstrap.statusCode).toBe(404);
    expect(bootstrap.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("forwards only bounded auth transport and streams every Set-Cookie unchanged", async () => {
    const headers = new Headers({ "content-type": "application/json", "retry-after": "3" });
    headers.append("set-cookie", "core_agent_session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/");
    headers.append("set-cookie", "core_agent_csrf=readable; Secure; SameSite=Lax; Path=/");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ schema_version: 1, accepted: true }), { status: 200, headers }));
    const app = await buildClientGatewayApp({
      authProxy: {
        origin: "http://127.0.0.1:4910",
        publicOrigin: "https://app.example.com",
        fetchImpl,
      },
      staticRoot: await staticRoot(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/auth/v1/account/deletion/request",
      headers: {
        host: "app.example.com",
        origin: "https://app.example.com",
        cookie: "core_agent_session=opaque; core_agent_csrf=readable",
        "content-type": "application/json",
        "x-core-agent-csrf": "readable",
        "x-forwarded-for": "attacker-controlled",
        "x-private-debug": "must-not-forward",
      },
      payload: { schema_version: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schema_version: 1, accepted: true });
    expect(response.headers["set-cookie"]).toEqual([
      "core_agent_session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/",
      "core_agent_csrf=readable; Secure; SameSite=Lax; Path=/",
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4910/auth/v1/account/deletion/request");
    const forwarded = init.headers as Headers;
    expect(forwarded.get("host")).toBe("app.example.com");
    expect(forwarded.get("origin")).toBe("https://app.example.com");
    expect(forwarded.get("cookie")).toBe("core_agent_session=opaque; core_agent_csrf=readable");
    expect(forwarded.get("x-core-agent-csrf")).toBe("readable");
    expect(forwarded.get("x-forwarded-for")).toBe("127.0.0.1");
    expect(forwarded.has("x-private-debug")).toBe(false);
    expect(String(init.body)).toBe('{"schema_version":1}');
    await app.close();
  });

  it("fails closed on invalid mode combinations, non-loopback upstreams, and oversized upstream bodies", async () => {
    const root = await staticRoot();
    await expect(buildClientGatewayApp({ staticRoot: root })).rejects.toThrowError("CLIENT_CONFIGURATION_INVALID");
    await expect(buildClientGatewayApp({
      authProxy: { origin: "https://identity.example.com", publicOrigin: "https://app.example.com" },
      staticRoot: root,
    })).rejects.toThrowError("CLIENT_CONFIGURATION_INVALID");
    const app = await buildClientGatewayApp({
      authProxy: {
        origin: "http://127.0.0.1:4910",
        publicOrigin: "https://app.example.com",
        fetchImpl: async () => new Response("x".repeat(70_000), { status: 200, headers: { "content-type": "application/json" } }),
      },
      staticRoot: root,
    });
    const response = await app.inject({ method: "GET", url: "/auth/v1/session", headers: { host: "app.example.com" } });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("x".repeat(100));
    await app.close();
  });

  it("cancels a chunked upstream response as soon as its bound is crossed", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(32_768));
      },
    });
    const app = await buildClientGatewayApp({
      authProxy: {
        origin: "http://127.0.0.1:4910",
        publicOrigin: "https://app.example.com",
        fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }),
      },
      staticRoot: await staticRoot(),
    });
    const response = await app.inject({ method: "GET", url: "/auth/v1/session", headers: { host: "app.example.com" } });
    expect(response.statusCode).toBe(502);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(4);
    await app.close();
  });
});
