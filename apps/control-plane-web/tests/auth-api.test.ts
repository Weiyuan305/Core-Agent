// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthClientError,
  canonicalPublicPayloadHash,
  createAuthApi,
} from "../src/client/features/auth/auth-api.js";

const session = Object.freeze({
  schema_version: 1 as const,
  actor_id: "actor_web_test",
  actor_resource_version: 3,
  session_id: "session_web_test",
  session_resource_version: 4,
  client_kind: "web" as const,
  idle_expires_at: "2026-08-20T00:00:00.000Z",
  absolute_expires_at: "2026-09-18T00:00:00.000Z",
  reauthentication_required: false,
});

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

afterEach(() => {
  document.cookie = "core_agent_csrf=; Max-Age=0; Path=/";
  document.cookie = "core_agent_session=; Max-Age=0; Path=/";
  vi.restoreAllMocks();
});

describe("same-origin auth API", () => {
  it("uses credentials+Accept for reads and strictly parses the public Session view", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ schema_version: 1, session }));
    const api = createAuthApi(fetchImpl);
    await expect(api.inspectSession()).resolves.toEqual(session);
    expect(fetchImpl).toHaveBeenCalledWith("/auth/v1/session", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      headers: expect.any(Headers),
    }));
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("x-core-agent-csrf")).toBe(false);

    fetchImpl.mockResolvedValueOnce(jsonResponse({ schema_version: 1, session: { ...session, provider: "supabase" } }));
    await expect(api.inspectSession()).rejects.toMatchObject({ reason: "unavailable" });
    fetchImpl.mockResolvedValueOnce(jsonResponse({ schema_version: 1, session: { ...session, idle_expires_at: "2026-02-31T00:00:00.000Z" } }));
    await expect(api.inspectSession()).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("reads only the CSRF Cookie for mutations and never reflects a Session secret", async () => {
    document.cookie = "core_agent_csrf=csrf-readable-value; Path=/";
    document.cookie = "core_agent_session=session-secret-must-remain-http-only-to-code; Path=/";
    const fetchImpl = vi.fn(async () => jsonResponse({ schema_version: 1, transport: "web_cookie", session }));
    const api = createAuthApi(fetchImpl, { idempotencyKey: () => "idem_sign_in" });
    await api.signIn({ email: "Student@Example.com", password: "correct horse battery staple" });

    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe("/auth/v1/email/sign-in");
    expect(init.credentials).toBe("same-origin");
    const headers = init.headers as Headers;
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-core-agent-csrf")).toBe("csrf-readable-value");
    expect(JSON.stringify(init)).not.toContain("session-secret-must-remain-http-only-to-code");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      schema_version: 1,
      idempotency_key: "idem_sign_in",
      email: "student@example.com",
      client_kind: "web",
    });
    expect(body.payload_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(body.payload_hash).toBe(await canonicalPublicPayloadHash({
      schema_version: 1,
      idempotency_key: "idem_sign_in",
      normalized_email: "student@example.com",
      sign_in_proof_digest: await canonicalPublicPayloadHash.rawDigest("correct horse battery staple"),
      client_kind: "web",
    }));
  });

  it("does not send a CSRF header on reads or when no readable CSRF Cookie exists", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      schema_version: 1,
      verification_id: "verification_public_test",
      status: "verification_pending",
    }, 202));
    const api = createAuthApi(fetchImpl, { idempotencyKey: () => "idem_signup" });
    await api.signUp({ email: "student@example.com", password: "password-long-enough" });
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Headers;
    expect(headers.has("x-core-agent-csrf")).toBe(false);
  });

  it("maps only closed error facts and never exposes raw messages or identifiers", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      schema_version: 1,
      error_id: "error_private",
      code: "AUTH_PROVIDER_UNAVAILABLE",
      category: "unavailable",
      message: "supabase.internal:5432 leaked provider subject",
      retryable: true,
      request_id: "request_private",
      trace_id: "trace_private",
    }, 503));
    const api = createAuthApi(fetchImpl);
    let observed: unknown;
    try {
      await api.inspectSession();
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AuthClientError);
    expect(observed).toMatchObject({ reason: "unavailable", retryable: true });
    expect(String(observed)).not.toMatch(/(?:supabase|5432|provider subject|request_private|trace_private)/u);
  });

  it("rejects duplicate/oversized/non-JSON responses and aborts a bounded request", async () => {
    const api = createAuthApi(async () => new Response("x".repeat(70_000), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(api.inspectSession()).rejects.toMatchObject({ reason: "unavailable" });

    let cancelled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const chunked = createAuthApi(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1_024));
        closeTimer = setTimeout(() => controller.close(), 100);
      },
      cancel() {
        cancelled = true;
        if (closeTimer !== undefined) clearTimeout(closeTimer);
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(chunked.inspectSession()).rejects.toMatchObject({ reason: "unavailable" });
    expect(cancelled).toBe(true);

    const wrongType = createAuthApi(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    await expect(wrongType.inspectSession()).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("strictly validates mutation responses and can revoke the current Session", async () => {
    document.cookie = "core_agent_csrf=csrf-readable-value; Path=/";
    const malformed = createAuthApi(async () => jsonResponse({ schema_version: 1, accepted: true }), {
      idempotencyKey: () => "idem_member_invite",
    });
    await expect(malformed.inviteCompanyMember({
      tenantId: "tenant_web_test", email: "member@example.com", role: "consultant",
    })).rejects.toMatchObject({ reason: "unavailable" });

    const fetchImpl = vi.fn(async () => jsonResponse({
      schema_version: 1,
      session_id: session.session_id,
      status: "revoked",
      resource_version: 5,
    }));
    const api = createAuthApi(fetchImpl, { idempotencyKey: () => "idem_session_revoke" });
    await api.revokeCurrentSession({ sessionId: session.session_id, expectedResourceVersion: 4 });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/auth/v1/sessions/revoke");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      schema_version: 1,
      idempotency_key: "idem_session_revoke",
      session_id: session.session_id,
      expected_resource_version: 4,
      reason_code: "user_sign_out",
    });
  });

  it("rejects a company member response whose role, lifecycle, and Profile facts contradict the public contract", async () => {
    const api = createAuthApi(async () => jsonResponse({
      schema_version: 1,
      tenant_id: "tenant_web_test",
      members: [{
        schema_version: 1,
        membership_id: "membership_web_test",
        actor_id: "actor_web_test",
        membership_resource_version: 2,
        source: "company",
        status: "active",
        roles: ["admin"],
        profile_id: "profile_web_test",
        profile_resource_version: 3,
        profile_status: "active",
      }],
      page_info: { schema_version: 1, has_more: false },
    }));
    await expect(api.listCompanyMembers("tenant_web_test")).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("reuses one in-memory idempotency key after an unknown result and rotates it after success", async () => {
    const observed: string[] = [];
    let attempt = 0;
    const api = createAuthApi(async (_path, init) => {
      observed.push((JSON.parse(String(init?.body)) as { idempotency_key: string }).idempotency_key);
      attempt += 1;
      if (attempt === 1) throw new TypeError("synthetic network loss");
      return jsonResponse({ schema_version: 1, verification_id: `verification_${attempt}`, status: "verification_pending" }, 202);
    }, { idempotencyKey: () => `idem_${observed.length + 1}` });

    await expect(api.signUp({ email: "student@example.com", password: "password-long-enough" }))
      .rejects.toMatchObject({ reason: "unavailable", retryable: true });
    await expect(api.signUp({ email: "student@example.com", password: "password-long-enough" })).resolves.toMatchObject({ status: "verification_pending" });
    await expect(api.signUp({ email: "student@example.com", password: "different-password" })).resolves.toMatchObject({ status: "verification_pending" });
    expect(observed).toEqual(["idem_1", "idem_1", "idem_3"]);
  });
});
