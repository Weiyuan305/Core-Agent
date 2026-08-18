import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalPayloadHash } from "@core-agent/runtime-core";
import Fastify, { type FastifyInstance } from "fastify";

import { readRecoveryCookie, sealRecoveryCookie } from "../src/security.js";

const origin = "https://app.example.test";
const host = "identity.example.test";
const webRedirect = `${origin}/auth/apple/callback`;
const nativeRedirect = "coreagent://auth/apple/callback";
const sessionSecret = "s".repeat(43);
const csrfSecret = "c".repeat(43);
const flowKey = Buffer.alloc(32, 0x31);

const session = Object.freeze({
  schema_version: 1 as const,
  actor_id: "actor_01",
  actor_resource_version: 1,
  session_id: "session_01",
  session_resource_version: 1,
  client_kind: "web" as const,
  idle_expires_at: "2026-08-18T00:00:00.000Z",
  absolute_expires_at: "2026-09-16T00:00:00.000Z",
  reauthentication_required: false,
});

function provider() {
  return {
    async signUpEmail() { return { kind: "verification_pending" as const }; },
    async verifyEmail() { throw new Error("not used"); },
    async signInEmail() {
      return { provider: "supabase" as const, providerSubject: "provider_subject", identityKind: "email_password" as const, normalizedEmail: "student@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
    },
    async beginApple(input: Record<string, unknown>) {
      return { transaction_id: "oauth_01", authorization_url: `https://apple.example.test/auth/v1/authorize?state=oauth_state_01&redirect_uri=${encodeURIComponent(String(input.redirect_uri))}`, expires_at: "2026-08-17T00:05:00.000Z" };
    },
    async completeApple() {
      return { provider: "supabase" as const, providerSubject: "apple_subject", identityKind: "apple" as const, normalizedEmail: "relay@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
    },
    async reauthenticateAndBeginAppleLink(input: Record<string, unknown>) {
      return { transaction_id: "oauth_link_01", authorization_url: `https://apple.example.test/auth/v1/authorize?state=oauth_link_state&redirect_to=${encodeURIComponent(String(input.redirect_uri))}`, expires_at: "2026-08-17T00:05:00.000Z" };
    },
    async linkApple() {
      return { provider: "supabase" as const, providerSubject: "apple_subject", identityKind: "apple" as const, normalizedEmail: "relay@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
    },
    async beginPasswordReset() {
      return { transaction_id: "reset_01", state: "reset_state_01", expires_at: "2026-08-17T00:05:00.000Z" };
    },
    async completePasswordReset() {
      return { provider: "supabase" as const, providerSubject: "provider_subject", identityKind: "email_password" as const, normalizedEmail: "student@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
    },
    async verifyCurrentSubject() { throw new Error("not used"); },
    async reauthenticatePassword() { throw new Error("not used"); },
    async revokeCurrentProviderSession() {},
    async deleteProviderSubject() {},
  };
}

function operations() {
  return {
    async consumeRateLimit() { return null; },
    async preparePasswordReset(normalizedEmail: string) {
      return {
        provider: "supabase" as const, providerSubject: "provider_subject",
        identityKind: "email_password" as const, normalizedEmail,
        verifiedAt: "2026-08-17T00:00:00.000Z",
      };
    },
    async issueSession(_subject: unknown, clientKind: "web" | "iphone" | "macos") {
      return {
        session: { ...session, client_kind: clientKind },
        sessionSecret,
        csrfSecret,
      };
    },
    async authenticateSession(input: { requireCsrf?: boolean } = {}) {
      return {
        session: { ...session, client_kind: input.requireCsrf === false ? "iphone" as const : "web" as const },
        actorId: "actor_01", authSubjectId: "auth_01",
      };
    },
    async requireRecentReauthentication() {},
    async loadNormalizedEmail() { return "student@example.test"; },
    async executeAuthorityCommand() { return { schema_version: 1 }; },
    async executeProtectedAuthorityCommand() { return { schema_version: 1 }; },
  };
}

async function buildApp(overrides: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const path = "../src/app.ts";
  const module = await import(path).catch(() => undefined) as undefined | {
    buildIdentityGatewayApp: (input: Record<string, unknown>) => Promise<FastifyInstance>;
  };
  if (module === undefined) return Fastify();
  return module.buildIdentityGatewayApp({
    config: {
      publicOrigins: new Set([origin]),
      cookieHost: host,
      publicBaseUrl: `https://${host}`,
      providerUrl: "https://apple.example.test",
      appleWebRedirectUris: new Set([webRedirect]),
      appleNativeRedirectUris: new Set([nativeRedirect]),
      passwordResetRedirectUri: `${origin}/auth/password/reset/callback`,
      publicAuthEnabled: true,
    },
    provider: provider(),
    operations: operations(),
    flowCookieKey: flowKey,
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    ...overrides,
  });
}

const idem = { schema_version: 1, idempotency_key: "idem_01", payload_hash: `sha256:${"a".repeat(64)}` };

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function emailSignInPayload() {
  const facts = { schema_version: 1 as const, idempotency_key: idem.idempotency_key, email: "student@example.test", password: "correct-horse", client_kind: "web" as const };
  return { ...facts, payload_hash: canonicalPayloadHash({
    schema_version: facts.schema_version, idempotency_key: facts.idempotency_key,
    normalized_email: facts.email, sign_in_proof_digest: digest(facts.password), client_kind: facts.client_kind,
  }) };
}

function appleCallbackPayload<T extends {
  schema_version: 1; idempotency_key: string; client_kind: "web" | "iphone" | "macos";
  transaction_id: string; authorization_code: string; state: string; nonce?: string; pkce_code_verifier?: string;
}>(facts: T): T & { payload_hash: string } {
  return { ...facts, payload_hash: canonicalPayloadHash({
    schema_version: facts.schema_version, flow_kind: "apple_sign_in", idempotency_key: facts.idempotency_key,
    client_kind: facts.client_kind, transaction_id: facts.transaction_id,
    code_proof_digest: digest(facts.authorization_code), state_proof_digest: digest(facts.state),
    ...(facts.nonce === undefined ? {} : { nonce_proof_digest: digest(facts.nonce) }),
    ...(facts.pkce_code_verifier === undefined ? {} : { pkce_proof_digest: digest(facts.pkce_code_verifier) }),
  }) };
}
const jsonHeaders = { host, origin, "content-type": "application/json" };

test("security rejects non-exact host/origin and duplicate sensitive headers", async () => {
  const app = await buildApp();
  for (const response of [
    await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { ...jsonHeaders, host: "evil.example.test" }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } }),
    await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { ...jsonHeaders, origin: "https://evil.example.test" }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } }),
    await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { ...jsonHeaders, host: [host, host] as unknown as string }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } }),
    await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { ...jsonHeaders, origin: [origin, origin] as unknown as string }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } }),
    await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { ...jsonHeaders, cookie: ["a=1", "b=2"] as unknown as string }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } }),
    await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { ...jsonHeaders, authorization: ["Bearer a", "Bearer b"] as unknown as string }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } }),
  ]) {
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-allow-credentials"], undefined);
  }
  await app.close();
});

test("security rejects duplicate sensitive cookie names inside one Cookie header before authentication", async () => {
  let authenticationCalls = 0;
  const base = operations();
  const app = await buildApp({ operations: { ...base, async authenticateSession() { authenticationCalls += 1; return base.authenticateSession(); } } });
  for (const cookie of [
    `core_agent_session=${sessionSecret}; core_agent_session=${"x".repeat(43)}; core_agent_csrf=${csrfSecret}`,
    `core_agent_session=${sessionSecret}; core_agent_csrf=${csrfSecret}; core_agent_csrf=${"x".repeat(43)}`,
    "core_agent_apple_flow=one; core_agent_apple_flow=two",
    "core_agent_recovery=one; core_agent_recovery=two",
  ]) {
    const response = await app.inject({ method: "POST", url: "/auth/v1/reauthenticate", headers: { ...jsonHeaders, cookie, "x-core-agent-csrf": csrfSecret }, payload: { ...idem, expected_resource_version: 1, password: "correct-horse" } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(authenticationCalls, 0);
  await app.close();
});

test("security requires JSON mutations and enforces the 64 KiB boundary", async () => {
  const app = await buildApp();
  const notJson = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { host, origin, "content-type": "text/plain" }, payload: "not-json" });
  const tooLarge = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: jsonHeaders, payload: { ...idem, email: "student@example.test", password: "x".repeat(70_000), client_kind: "web" } });
  assert.equal(notJson.statusCode, 400);
  assert.equal(tooLarge.statusCode, 400);
  await app.close();
});

test("cookie security issues separate exact Core Session and readable CSRF cookies", async () => {
  const app = await buildApp();
  const response = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-in", headers: jsonHeaders,
    payload: emailSignInPayload(),
  });
  assert.equal(response.statusCode, 200);
  const cookies = response.headers["set-cookie"] as string[];
  assert.equal(Array.isArray(cookies), true);
  const core = cookies.find((value) => value.startsWith("core_agent_session="));
  const csrf = cookies.find((value) => value.startsWith("core_agent_csrf="));
  assert.match(core ?? "", /Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000/u);
  assert.match(csrf ?? "", /Secure; SameSite=Lax; Path=\/; Max-Age=2592000/u);
  assert.doesNotMatch(csrf ?? "", /HttpOnly/u);
  assert.equal(response.body.includes(sessionSecret), false);
  assert.equal(response.body.includes(csrfSecret), false);
  assert.deepEqual(response.json(), { schema_version: 1, transport: "web_cookie", session });
  await app.close();
});

test("csrf requires the dedicated cookie/header match for authenticated mutations", async () => {
  const app = await buildApp();
  const payload = { ...idem, password: "correct-horse", client_kind: "web", redirect_uri: webRedirect };
  const cookie = `core_agent_session=${sessionSecret}; core_agent_csrf=${csrfSecret}`;
  for (const headers of [
    { ...jsonHeaders, cookie },
    { ...jsonHeaders, cookie, "x-core-agent-csrf": "wrong" },
    { ...jsonHeaders, cookie: `core_agent_session=${sessionSecret}`, "x-core-agent-csrf": csrfSecret },
  ]) {
    const response = await app.inject({ method: "POST", url: "/auth/v1/apple/link/start", headers, payload });
    assert.equal(response.statusCode, 401);
  }
  const accepted = await app.inject({ method: "POST", url: "/auth/v1/apple/link/start", headers: { ...jsonHeaders, cookie, "x-core-agent-csrf": csrfSecret }, payload });
  assert.equal(accepted.statusCode, 200);
  await app.close();
});

test("redirect security rejects every URI outside the exact Web/native allowlists", async () => {
  const app = await buildApp();
  const common = { ...idem, client_kind: "web" as const };
  for (const redirect_uri of [`${webRedirect}?next=https://evil.example`, `${origin}/auth/apple/callback/`, "https://evil.example.test/callback"]) {
    const response = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: jsonHeaders, payload: { ...common, redirect_uri } });
    assert.equal(response.statusCode, 400);
  }
  const nativeFromWeb = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: jsonHeaders, payload: { ...idem, client_kind: "web", redirect_uri: nativeRedirect } });
  assert.equal(nativeFromWeb.statusCode, 400);
  await app.close();
});

test("redirect security rejects an adapter authorization URL outside the configured provider origin", async () => {
  const unsafeProvider = provider();
  unsafeProvider.beginApple = async () => ({ transaction_id: "oauth_01", authorization_url: "https://evil.example.test/open-redirect?state=state_01", expires_at: "2026-08-17T00:05:00.000Z" });
  const app = await buildApp({ provider: unsafeProvider });
  const response = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: jsonHeaders, payload: { ...idem, client_kind: "web", redirect_uri: webRedirect } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes("evil.example.test"), false);
  assert.equal(response.headers.location, undefined);
  await app.close();
});

test("redirect security accepts only the exact provider authorization endpoint and approved callback parameter", async () => {
  for (const authorization_url of [
    `https://apple.example.test/evil?state=oauth_state_01&redirect_to=${encodeURIComponent(webRedirect)}`,
    `https://apple.example.test/auth/v1/authorize/extra?state=oauth_state_01&redirect_to=${encodeURIComponent(webRedirect)}`,
    "https://apple.example.test/auth/v1/authorize?state=oauth_state_01&redirect_to=https%3A%2F%2Fevil.example.test%2Fcallback",
    `https://apple.example.test/auth/v1/authorize?state=oauth_state_01&redirect_to=${encodeURIComponent(webRedirect)}&next=https%3A%2F%2Fevil.example.test`,
  ]) {
    const unsafeProvider = provider();
    unsafeProvider.beginApple = async () => ({ transaction_id: "oauth_01", authorization_url, expires_at: "2026-08-17T00:05:00.000Z" });
    const app = await buildApp({ provider: unsafeProvider });
    const response = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: jsonHeaders, payload: { ...idem, client_kind: "web", redirect_uri: webRedirect } });
    assert.equal(response.statusCode, 503, authorization_url);
    await app.close();
  }
});

test("native Apple link accepts only Apple's exact endpoint with the provider callback", async () => {
  const nativeProvider = provider();
  nativeProvider.reauthenticateAndBeginAppleLink = async () => ({
    transaction_id: "oauth_native_link",
    authorization_url: `https://appleid.apple.com/auth/authorize?state=provider_state&redirect_uri=${encodeURIComponent("https://apple.example.test/auth/v1/callback")}`,
    expires_at: "2026-08-17T00:05:00.000Z",
  });
  const app = await buildApp({ provider: nativeProvider });
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/apple/link/start",
    headers: { host, "content-type": "application/json", authorization: `Bearer ${sessionSecret}` },
    payload: {
      ...idem,
      password: "correct-horse",
      client_kind: "iphone",
      redirect_uri: nativeRedirect,
      nonce: "native-nonce-proof",
      pkce_code_challenge: "a".repeat(43),
      pkce_code_challenge_method: "S256",
    },
  });
  assert.equal(response.statusCode, 200);
  await app.close();

  for (const authorizationUrl of [
    `https://appleid.apple.com/auth/authorize/extra?state=provider_state&redirect_uri=${encodeURIComponent("https://apple.example.test/auth/v1/callback")}`,
    `https://appleid.apple.com/auth/authorize?state=provider_state&redirect_uri=${encodeURIComponent("https://evil.example.test/callback")}`,
    `https://appleid.apple.com/auth/authorize?state=provider_state&redirect_uri=${encodeURIComponent("https://apple.example.test/auth/v1/callback")}&next=${encodeURIComponent("https://evil.example.test")}`,
  ]) {
    const unsafeProvider = provider();
    unsafeProvider.reauthenticateAndBeginAppleLink = async () => ({
      transaction_id: "oauth_native_link",
      authorization_url: authorizationUrl,
      expires_at: "2026-08-17T00:05:00.000Z",
    });
    const unsafeApp = await buildApp({ provider: unsafeProvider });
    const unsafe = await unsafeApp.inject({
      method: "POST",
      url: "/auth/v1/apple/link/start",
      headers: { host, "content-type": "application/json", authorization: `Bearer ${sessionSecret}` },
      payload: {
        ...idem,
        password: "correct-horse",
        client_kind: "iphone",
        redirect_uri: nativeRedirect,
        nonce: "native-nonce-proof",
        pkce_code_challenge: "a".repeat(43),
        pkce_code_challenge_method: "S256",
      },
    });
    assert.equal(unsafe.statusCode, 503, authorizationUrl);
    await unsafeApp.close();
  }
});

test("recovery cookie is dedicated, HttpOnly, and never exposes its binding or changes the configured redirect", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "POST", url: "/auth/v1/password/reset/start", headers: jsonHeaders, payload: { ...idem, email: "student@example.test" } });
  assert.equal(response.statusCode, 202);
  const cookie = ([] as string[]).concat(response.headers["set-cookie"] ?? []).find((value) => value.startsWith("core_agent_recovery="));
  assert.match(cookie ?? "", /Secure; HttpOnly; SameSite=Lax; Path=\/auth\/v1\/password\/reset\/complete; Max-Age=2100/u);
  assert.equal(response.body.includes("reset_01"), false);
  assert.equal(response.body.includes("reset_state_01"), false);
  assert.deepEqual(response.json(), { schema_version: 1, accepted: true });
  await app.close();
});

test("recovery cookie authenticates separate authorization and bounded settlement deadlines", () => {
  const sealed = sealRecoveryCookie(flowKey, {
    transactionId: "reset_settlement_01", state: "reset_settlement_state",
    expiresAt: "2026-08-17T00:05:00.000Z",
  });
  const atAuthorizationBoundary = readRecoveryCookie(flowKey, sealed, new Date("2026-08-17T00:05:00.000Z"));
  assert.deepEqual(atAuthorizationBoundary, {
    transactionId: "reset_settlement_01", state: "reset_settlement_state",
    expiresAt: "2026-08-17T00:05:00.000Z", settlementNotAfter: "2026-08-17T00:35:00.000Z",
  });
  assert.deepEqual(
    readRecoveryCookie(flowKey, sealed, new Date("2026-08-17T00:34:59.999Z")),
    atAuthorizationBoundary,
  );
  assert.deepEqual(
    readRecoveryCookie(flowKey, sealed, new Date("2026-08-17T00:35:00.000Z")),
    atAuthorizationBoundary,
  );
  assert.deepEqual(
    readRecoveryCookie(flowKey, sealed, new Date("2026-08-18T00:00:00.000Z")),
    atAuthorizationBoundary,
  );
});

test("Apple Web flow uses a distinct short-lived cookie and clears every terminal callback", async () => {
  const app = await buildApp();
  const start = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: jsonHeaders, payload: { ...idem, client_kind: "web", redirect_uri: webRedirect } });
  assert.equal(start.statusCode, 200);
  assert.deepEqual(start.json(), { schema_version: 1, authorization_url: `https://apple.example.test/auth/v1/authorize?state=oauth_state_01&redirect_uri=${encodeURIComponent(webRedirect)}` });
  const appleCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? []).find((value) => value.startsWith("core_agent_apple_flow="));
  assert.match(appleCookie ?? "", /Secure; HttpOnly; SameSite=Lax; Path=\/auth\/v1(?:;|$)/u);
  assert.doesNotMatch(appleCookie ?? "", /core_agent_recovery/u);

  const cookiePair = appleCookie?.split(";", 1)[0] ?? "";
  const success = await app.inject({ method: "POST", url: "/auth/v1/apple/callback", headers: { ...jsonHeaders, cookie: cookiePair }, payload: appleCallbackPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "oauth_state_01" }) });
  assert.equal(success.statusCode, 200);
  assert.match(String(success.headers["set-cookie"]), /core_agent_apple_flow=;[^\n]*Max-Age=0/u);

  const mismatch = await app.inject({ method: "POST", url: "/auth/v1/apple/callback", headers: { ...jsonHeaders, cookie: cookiePair }, payload: appleCallbackPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "web", transaction_id: "oauth_other", authorization_code: "opaque_code", state: "oauth_state_01" }) });
  assert.equal(mismatch.statusCode, 401);
  assert.match(String(mismatch.headers["set-cookie"]), /core_agent_apple_flow=;[^\n]*Max-Age=0/u);

  const recovery = await app.inject({ method: "POST", url: "/auth/v1/apple/callback", headers: { ...jsonHeaders, cookie: "core_agent_recovery=opaque" }, payload: appleCallbackPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "oauth_state_01" }) });
  assert.equal(recovery.statusCode, 401);
  await app.close();
});

test("Apple link cookie authenticates separate authorization and settlement deadlines", async () => {
  const { readAppleFlowCookie, sealAppleFlowCookie } = await import("../src/security.js");
  const authorizationOnly = sealAppleFlowCookie(flowKey, {
    transactionId: "oauth_link_deadline", state: "state_link_deadline",
    expiresAt: "2026-08-17T00:05:00.000Z", flowKind: "link",
  });
  assert.throws(() => readAppleFlowCookie(
    flowKey, authorizationOnly, new Date("2026-08-17T00:05:00.000Z"),
  ), /AUTH_INVALID/u);
  const settlement = sealAppleFlowCookie(flowKey, {
    transactionId: "oauth_link_deadline", state: "state_link_deadline",
    expiresAt: "2026-08-17T00:05:00.000Z", flowKind: "link",
    settlementNotAfter: "2026-08-17T00:35:00.000Z",
  });
  assert.deepEqual(readAppleFlowCookie(
    flowKey, settlement, new Date("2026-08-17T00:35:00.000Z"),
  ), {
    transactionId: "oauth_link_deadline", state: "state_link_deadline",
    expiresAt: "2026-08-17T00:05:00.000Z", flowKind: "link",
    settlementNotAfter: "2026-08-17T00:35:00.000Z",
  });
  const wrongSettlement = sealAppleFlowCookie(flowKey, {
    transactionId: "oauth_link_deadline", state: "state_link_deadline",
    expiresAt: "2026-08-17T00:05:00.000Z", flowKind: "link",
    settlementNotAfter: "2026-08-17T00:34:59.999Z",
  });
  assert.throws(() => readAppleFlowCookie(
    flowKey, wrongSettlement, new Date("2026-08-17T00:06:00.000Z"),
  ), /AUTH_INVALID/u);
});

test("native Apple delivery returns the opaque secret once without any cookie", async () => {
  const app = await buildApp();
  const verifier = "v".repeat(43);
  const start = await app.inject({
    method: "POST", url: "/auth/v1/apple/start", headers: { host, "content-type": "application/json" },
    payload: { ...idem, client_kind: "iphone", redirect_uri: nativeRedirect, nonce: "native_nonce_01", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" },
  });
  assert.equal(start.statusCode, 200);
  assert.equal(start.headers["set-cookie"], undefined);
  const callback = await app.inject({
    method: "POST", url: "/auth/v1/apple/callback", headers: { host, "content-type": "application/json" },
    payload: appleCallbackPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "iphone", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "oauth_state_01", nonce: "native_nonce_01", pkce_code_verifier: verifier }),
  });
  assert.equal(callback.statusCode, 200);
  assert.equal(callback.headers["set-cookie"], undefined);
  assert.equal(callback.json().transport, "native");
  assert.equal(callback.json().session_secret, sessionSecret);
  await app.close();
});

test("native Apple callback failures never emit Set-Cookie", async () => {
  const failingProvider = provider();
  failingProvider.completeApple = async () => { throw Object.assign(new Error("invalid callback"), { code: "AUTH_CALLBACK_INVALID" }); };
  const app = await buildApp({ provider: failingProvider });
  const response = await app.inject({
    method: "POST", url: "/auth/v1/apple/callback", headers: { host, "content-type": "application/json" },
    payload: appleCallbackPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "iphone", transaction_id: "oauth_missing", authorization_code: "opaque_code", state: "wrong_state", nonce: "native_nonce_01", pkce_code_verifier: "v".repeat(43) }),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers["set-cookie"], undefined);
  await app.close();
});

test("flow cookies reject non-strict UTC, invalid, and non-finite expiry timestamps", async () => {
  const { readAppleFlowCookie, sealAppleFlowCookie } = await import("../src/security.js");
  for (const expiresAt of ["2026-08-17", "2026-08-17T00:05:00+00:00", "not-a-date", "+275760-09-13T00:00:00.000Z"]) {
    const sealed = sealAppleFlowCookie(flowKey, { transactionId: "oauth_01", state: "state_01", expiresAt, flowKind: "sign_in" });
    assert.throws(() => readAppleFlowCookie(flowKey, sealed, new Date("2026-08-17T00:00:00.000Z")), /AUTH_INVALID/u, expiresAt);
  }
});

test("security config rejects dynamic recovery redirects and unsafe production bind/origins", async () => {
  const configModulePath = "../src/config.ts";
  const { loadIdentityGatewayConfig } = await import(configModulePath);
  const valid = {
    NODE_ENV: "production",
    IDENTITY_DATABASE_URL: "postgresql://identity.example.test/core_agent",
    IDENTITY_PUBLIC_ORIGINS: origin,
    IDENTITY_COOKIE_HOST: host,
    IDENTITY_PUBLIC_BASE_URL: `https://${host}`,
    IDENTITY_PROVIDER_URL: "https://provider.example.test",
    IDENTITY_PROVIDER_PUBLISHABLE_KEY_REF: "secret/provider-publishable",
    IDENTITY_PROVIDER_SERVICE_ROLE_KEY_REF: "secret/provider-service",
    IDENTITY_APPLE_WEB_REDIRECT_URIS: webRedirect,
    IDENTITY_APPLE_NATIVE_REDIRECT_URIS: nativeRedirect,
    IDENTITY_PASSWORD_RESET_REDIRECT_URI: `${origin}/auth/password/reset/callback`,
    IDENTITY_EMAIL_VERIFICATION_REDIRECT_URI: `https://${host}/auth/v1/email/verification`,
    IDENTITY_SESSION_HMAC_KEY_REF: "secret/session-hmac",
    IDENTITY_PII_HMAC_KEY_REF: "secret/pii-hmac",
    IDENTITY_SIGNING_KEY_REF: "secret/signing-key",
    IDENTITY_GATEWAY_PORT: "8080",
    IDENTITY_PUBLIC_AUTH_ENABLED: "1",
  } satisfies NodeJS.ProcessEnv;
  assert.equal(loadIdentityGatewayConfig(valid).host, "127.0.0.1");
  assert.deepEqual([...loadIdentityGatewayConfig({
    ...valid, IDENTITY_TRUSTED_PROXY_ADDRESSES: "127.0.0.1,2001:db8::1",
  }).trustedProxyAddresses], ["127.0.0.1", "2001:db8::1"]);
  for (const environment of [
    { ...valid, IDENTITY_PASSWORD_RESET_REDIRECT_URI: `${valid.IDENTITY_PASSWORD_RESET_REDIRECT_URI}?transaction=forged` },
    { ...valid, IDENTITY_EMAIL_VERIFICATION_REDIRECT_URI: `${origin}/auth/v1/email/verification` },
    { ...valid, IDENTITY_PUBLIC_ORIGINS: "http://app.example.test" },
    { ...valid, IDENTITY_GATEWAY_HOST: "0.0.0.0" },
    { ...valid, IDENTITY_GATEWAY_HOST: "0.0.0.0", IDENTITY_GATEWAY_CONTAINER_BIND: "0" },
    { ...valid, IDENTITY_TRUSTED_PROXY_ADDRESSES: "127.0.0.1, attacker.example.test" },
    { ...valid, IDENTITY_TRUSTED_PROXY_ADDRESSES: "127.0.0.1,127.0.0.1" },
    { ...valid, IDENTITY_UNPLANNED_SETTING: "1" },
  ]) assert.throws(() => loadIdentityGatewayConfig(environment), /configuration is invalid/u);
  const container = loadIdentityGatewayConfig({ ...valid, IDENTITY_GATEWAY_HOST: "0.0.0.0", IDENTITY_GATEWAY_CONTAINER_BIND: "1" });
  assert.equal(container.host, "0.0.0.0");
});

test("enumeration responses for unknown account, invitation, and tenant share one bounded HTTP class", async () => {
  const rejectDistinctLookup = async (kind: string, delayMs: number): Promise<never> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    throw Object.assign(new Error(`private ${kind} lookup failed`), { code: "RESOURCE_NOT_FOUND" });
  };
  const baseOperations = operations();
  const app = await buildApp({
    operations: {
      ...baseOperations,
      async executeAuthorityCommand(input: { readonly kind: string }) {
        return rejectDistinctLookup(input.kind, input.kind === "invitation_inspect" ? 7 : 13);
      },
      async executeProtectedAuthorityCommand(input: { readonly kind: string }) { return rejectDistinctLookup(input.kind, 19); },
    },
  });
  const authenticatedHeaders = {
    ...jsonHeaders,
    cookie: `core_agent_session=${sessionSecret}; core_agent_csrf=${csrfSecret}`,
    "x-core-agent-csrf": csrfSecret,
  };
  const requests = [
    { method: "POST" as const, url: "/auth/v1/invitations/inspect", headers: jsonHeaders, payload: { schema_version: 1, invitation_secret: "i".repeat(43) } },
    { method: "POST" as const, url: "/auth/v1/account/deletion/request", headers: authenticatedHeaders, payload: { ...idem, expected_resource_version: 1, reason_code: "user_requested" } },
    { method: "POST" as const, url: "/auth/v1/companies/members/list", headers: authenticatedHeaders, payload: { schema_version: 1, tenant_id: "tenant_missing", cursor: "member_cursor", limit: 20 } },
  ];
  for (const options of requests) await app.inject(options);
  const observed: Array<{ statusCode: number; shape: string; elapsedMs: number }> = [];
  for (const options of requests) {
    const startedAt = performance.now();
    const response = await app.inject(options);
    const elapsedMs = performance.now() - startedAt;
    const body = response.json<Record<string, unknown>>();
    observed.push({
      statusCode: response.statusCode,
      shape: JSON.stringify({ ...body, error_id: "opaque", request_id: "opaque", trace_id: "opaque" }),
      elapsedMs,
    });
    assert.equal(response.statusCode, 401, `${options.url}: ${response.body}`);
  }
  assert.deepEqual(new Set(observed.map(({ statusCode }) => statusCode)), new Set([401]));
  assert.equal(new Set(observed.map(({ shape }) => shape)).size, 1);
  const timings = observed.map(({ elapsedMs }) => elapsedMs);
  assert.ok(Math.max(...timings) < 250, `enumeration response escaped bounded class: ${timings.join(",")}`);
  assert.ok(Math.max(...timings) - Math.min(...timings) < 100, `enumeration timing classes diverged: ${timings.join(",")}`);
  await app.close();
});

test("successful authority responses serialize only the closed public contract", async () => {
  const baseOperations = operations();
  const app = await buildApp({
    operations: {
      ...baseOperations,
      async executeAuthorityCommand() {
        return {
          schema_version: 1,
          invitation_id: "invitation_01",
          tenant_id: "tenant_01",
          role: "admin",
          status: "pending",
          expires_at: "2026-08-20T00:00:00.000Z",
          resource_version: 1,
          provider_token: "must-not-leave-the-gateway",
          database_detail: "private-row",
        };
      },
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/invitations/inspect",
    headers: jsonHeaders,
    payload: { schema_version: 1, invitation_secret: "i".repeat(43) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    schema_version: 1,
    invitation_id: "invitation_01",
    tenant_id: "tenant_01",
    role: "admin",
    status: "pending",
    expires_at: "2026-08-20T00:00:00.000Z",
    resource_version: 1,
  });
  await app.close();
});

test("native Apple start copies only allowlisted adapter fields", async () => {
  const unsafeProvider = provider();
  unsafeProvider.beginApple = async () => ({
    transaction_id: "oauth_01",
    authorization_url: `https://apple.example.test/auth/v1/authorize?state=oauth_state_01&redirect_to=${encodeURIComponent(nativeRedirect)}`,
    expires_at: "2026-08-17T00:05:00.000Z",
    provider_token: "must-not-leave-the-gateway",
  });
  const app = await buildApp({ provider: unsafeProvider });
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/apple/start",
    headers: { host, "content-type": "application/json" },
    payload: { ...idem, client_kind: "iphone", redirect_uri: nativeRedirect, nonce: "native_nonce_01", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    schema_version: 1,
    transaction_id: "oauth_01",
    authorization_url: `https://apple.example.test/auth/v1/authorize?state=oauth_state_01&redirect_to=${encodeURIComponent(nativeRedirect)}`,
    expires_at: "2026-08-17T00:05:00.000Z",
  });
  await app.close();
});

test("cookie security clears dedicated flow cookies even when callback JSON validation terminates first", async () => {
  const app = await buildApp();
  const appleStart = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: jsonHeaders, payload: { ...idem, client_kind: "web", redirect_uri: webRedirect } });
  const appleCookie = ([] as string[]).concat(appleStart.headers["set-cookie"] ?? []).find((value) => value.startsWith("core_agent_apple_flow="))?.split(";", 1)[0];
  const invalidApple = await app.inject({ method: "POST", url: "/auth/v1/apple/callback", headers: { ...jsonHeaders, cookie: appleCookie! }, payload: { schema_version: 1 } });
  assert.equal(invalidApple.statusCode, 400);
  assert.match(String(invalidApple.headers["set-cookie"]), /core_agent_apple_flow=;[^\n]*Max-Age=0/u);

  const recoveryStart = await app.inject({ method: "POST", url: "/auth/v1/password/reset/start", headers: jsonHeaders, payload: { ...idem, email: "student@example.test" } });
  const recoveryCookie = ([] as string[]).concat(recoveryStart.headers["set-cookie"] ?? []).find((value) => value.startsWith("core_agent_recovery="))?.split(";", 1)[0];
  const invalidRecovery = await app.inject({ method: "POST", url: "/auth/v1/password/reset/complete", headers: { ...jsonHeaders, cookie: recoveryCookie! }, payload: { schema_version: 1 } });
  assert.equal(invalidRecovery.statusCode, 400);
  assert.match(String(invalidRecovery.headers["set-cookie"]), /core_agent_recovery=;[^\n]*Max-Age=0/u);
  await app.close();
});
