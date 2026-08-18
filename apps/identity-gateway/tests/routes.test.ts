import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { ProviderFailure } from "../src/providers/provider-errors.js";

const host = "identity.example.test";
const origin = "https://app.example.test";
const redirect = `${origin}/auth/apple/callback`;
const secret = "s".repeat(43);
const csrf = "c".repeat(43);
const idem = { schema_version: 1, idempotency_key: "idem_01", payload_hash: `sha256:${"a".repeat(64)}` };

async function buildApp(
  calls: Array<{ name: string; input: unknown }>,
  options: { readonly failFirstEmailStart?: boolean; readonly failFinalizedCompletion?: boolean } = {},
): Promise<FastifyInstance> {
  const path = "../src/app.ts";
  const module = await import(path).catch(() => undefined) as undefined | { buildIdentityGatewayApp(input: Record<string, unknown>): Promise<FastifyInstance> };
  if (module === undefined) return Fastify();
  const subject = { provider: "supabase" as const, providerSubject: "subject_01", identityKind: "email_password" as const, normalizedEmail: "current@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
  let emailVerificationState: "reserved" | "finalized" | "failed" | undefined;
  let emailStartCalls = 0;
  return module.buildIdentityGatewayApp({
    config: { publicOrigins: new Set([origin]), cookieHost: host, publicBaseUrl: `https://${host}`, providerUrl: "https://apple.example.test", appleWebRedirectUris: new Set([redirect]), appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]), passwordResetRedirectUri: `${origin}/auth/password/reset/callback`, publicAuthEnabled: true },
    flowCookieKey: Buffer.alloc(32, 0x34),
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    provider: {
      async signUpEmail(input: unknown) {
        calls.push({ name: "signUpEmail", input });
        emailStartCalls += 1;
        if (options.failFirstEmailStart === true && emailStartCalls === 1) throw new ProviderFailure("AUTH_INVALID");
        return { kind: "verification_pending" as const };
      },
      async verifyEmail(input: unknown) { calls.push({ name: "verifyEmail", input }); return subject; },
      async signInEmail(input: unknown) { calls.push({ name: "signInEmail", input }); return subject; },
      async beginApple(input: unknown) { calls.push({ name: "beginApple", input }); return { transaction_id: "oauth_01", authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_01&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`, expires_at: "2026-08-17T00:05:00.000Z" }; },
      async reauthenticateAndBeginAppleLink(input: unknown) { calls.push({ name: "reauthenticateAndBeginAppleLink", input }); return { transaction_id: "oauth_link", authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_link&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`, expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completeApple(input: unknown) { calls.push({ name: "completeApple", input }); return subject; }, async linkApple() { return subject; },
      async beginPasswordReset(input: unknown) { calls.push({ name: "beginPasswordReset", input }); return { transaction_id: "reset_01", state: "state_reset", expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completePasswordReset() { return subject; }, async verifyCurrentSubject() { return subject; },
      async reauthenticatePassword() { return subject; }, async revokeCurrentProviderSession() {}, async deleteProviderSubject() {},
    },
    operations: {
      async consumeRateLimit(input: unknown) { calls.push({ name: "consumeRateLimit", input }); return null; },
      async issueSession(_subject: unknown, clientKind: "web" | "iphone" | "macos", deviceLabel?: string, idempotency?: unknown) { calls.push({ name: "issueSession", input: { clientKind, deviceLabel, idempotency } }); return { session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_01", session_resource_version: 1, client_kind: clientKind, idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false }, sessionSecret: secret, csrfSecret: csrf }; },
      async authenticateSession(input: unknown) { calls.push({ name: "authenticateSession", input }); return { actorId: "actor_server", authSubjectId: "auth_server", session: { session_id: "session_01" } }; },
      async requireRecentReauthentication(input: unknown) { calls.push({ name: "requireRecentReauthentication", input }); },
      async loadNormalizedEmail(input: unknown) { calls.push({ name: "loadNormalizedEmail", input }); return "current@example.test"; },
      async executeAuthorityCommand(input: unknown) {
        calls.push({ name: "executeAuthorityCommand", input });
        const kind = (input as { kind?: unknown }).kind;
        if (kind === "reauthenticate") return { schema_version: 1, reauthenticated_at: "2026-08-17T00:00:00.000Z", valid_until: "2026-08-17T00:10:00.000Z", session_resource_version: 2 };
        if (kind === "invitation_accept") return {
          schema_version: 1, tenant_id: "tenant_01", invitation_resource_version: 2,
          membership_id: "membership_01", membership_resource_version: 1, role: "admin",
          issuedSession: {
            session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_invitation", session_resource_version: 1, client_kind: "web", idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false },
            sessionSecret: secret, csrfSecret: csrf,
          },
        };
        return { schema_version: 1 };
      },
      async executeProtectedAuthorityCommand(input: unknown) {
        calls.push({ name: "executeProtectedAuthorityCommand", input });
        const kind = (input as { kind?: unknown }).kind;
        if (kind === "invitation_revoke") return { schema_version: 1, invitation_id: "invitation_01", status: "revoked", resource_version: 2 };
        if (kind === "apple_identity_link") return { schema_version: 1, auth_subject_id: "auth_apple", linked: true };
        return { schema_version: 1 };
      },
      async beginEmailVerification(input: unknown) {
        calls.push({ name: "beginEmailVerification", input });
        const kind = emailVerificationState === undefined || emailVerificationState === "failed"
          ? "reserved" as const
          : emailVerificationState === "finalized" ? "finalized_replay" as const : "in_progress" as const;
        if (kind === "reserved") emailVerificationState = "reserved";
        return { verificationId: "verification_01", kind };
      },
      async finalizeEmailVerificationStart(input: unknown) {
        calls.push({ name: "finalizeEmailVerificationStart", input });
        const outcome = (input as { outcome: "finalized" | "failed" }).outcome;
        if (options.failFinalizedCompletion === true && outcome === "finalized") {
          throw new Error("unknown finalization outcome");
        }
        emailVerificationState = outcome;
      },
      async prepareEmailVerification(input: unknown) {
        calls.push({ name: "prepareEmailVerification", input });
        return { clientKind: "web" as const, deviceLabel: "Browser" };
      },
      async completeEmailVerification(input: unknown) {
        calls.push({ name: "completeEmailVerification", input });
        return {
          actorId: "actor_server",
          authSubjectId: "auth_server",
          clientKind: "web" as const,
          deviceLabel: "Browser",
          issuedSession: {
            session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_01", session_resource_version: 1, client_kind: "web" as const, idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false },
            sessionSecret: secret,
            csrfSecret: csrf,
          },
        };
      },
    },
  });
}

test("route sequencing rate-limits before provider and issues Session after provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { host, origin, "content-type": "application/json" }, payload: { ...idem, email: "STUDENT@EXAMPLE.TEST", password: "correct-horse", client_kind: "web" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "signInEmail", "issueSession"]);
  assert.equal((calls[1]?.input as { email?: unknown }).email, "student@example.test");
  assert.deepEqual((calls[2]?.input as { idempotency?: unknown }).idempotency, {
    idempotencyKey: idem.idempotency_key, payloadHash: idem.payload_hash, operation: "email_sign_in",
  });
  await app.close();
});

test("password reset normalizes one account identifier for rate limit and provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/password/reset/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, email: "STUDENT@EXAMPLE.TEST" },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "beginPasswordReset"]);
  assert.equal((calls[0]?.input as { accountIdentifier?: unknown }).accountIdentifier, "student@example.test");
  assert.deepEqual(calls[1]?.input, {
    email: "student@example.test",
    idempotencyKey: idem.idempotency_key,
    payloadHash: idem.payload_hash,
  });
  await app.close();
});

test("email signup reserves one durable idempotent binding before its provider effect", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const payload = { ...idem, email: "STUDENT@EXAMPLE.TEST", password: "correct-horse", client_kind: "web", device_label: "Browser" };
  const first = await app.inject({ method: "POST", url: "/auth/v1/email/sign-up", headers: { host, origin, "content-type": "application/json" }, payload });
  const replay = await app.inject({ method: "POST", url: "/auth/v1/email/sign-up", headers: { host, origin, "content-type": "application/json" }, payload });
  assert.equal(first.statusCode, 202);
  assert.equal(replay.statusCode, 202);
  assert.deepEqual(first.json(), replay.json());
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "beginEmailVerification", "signUpEmail", "finalizeEmailVerificationStart",
    "consumeRateLimit", "beginEmailVerification",
  ]);
  const binding = calls.find(({ name }) => name === "beginEmailVerification")?.input as Record<string, unknown>;
  assert.equal(binding.normalizedEmail, "student@example.test");
  assert.equal(binding.clientKind, "web");
  assert.equal(binding.deviceLabel, "Browser");
  await app.close();
});

test("a definite email provider-start failure is marked failed and one retry performs the provider start again", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failFirstEmailStart: true });
  const payload = { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" };
  const failed = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-up",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  const retried = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-up",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  assert.equal(failed.statusCode, 401);
  assert.equal(retried.statusCode, 202);
  assert.deepEqual(calls.filter(({ name }) => name === "signUpEmail").length, 2);
  assert.deepEqual(calls.filter(({ name }) => name === "finalizeEmailVerificationStart").map(({ input }) => (
    (input as { outcome: string }).outcome
  )), ["failed", "finalized"]);
  await app.close();
});

test("an unknown email start-finalization outcome stays reserved and never repeats the provider effect", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failFinalizedCompletion: true });
  const payload = { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" };
  const first = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-up",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  const retry = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-up",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  assert.equal(first.statusCode, 500);
  assert.equal(retry.statusCode, 409);
  assert.equal(calls.filter(({ name }) => name === "signUpEmail").length, 1);
  assert.deepEqual(calls.filter(({ name }) => name === "finalizeEmailVerificationStart").map(({ input }) => (
    (input as { outcome: string }).outcome
  )), ["finalized"]);
  await app.close();
});

test("invitation email registration reserves its provider start idempotently", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const payload = {
    ...idem,
    invitation_secret: "i".repeat(43),
    email: "INVITED@EXAMPLE.TEST",
    password: "correct-horse",
    client_kind: "web",
    device_label: "Invitation Browser",
  };
  const first = await app.inject({ method: "POST", url: "/auth/v1/invitations/register", headers: { host, origin, "content-type": "application/json" }, payload });
  const replay = await app.inject({ method: "POST", url: "/auth/v1/invitations/register", headers: { host, origin, "content-type": "application/json" }, payload });
  assert.equal(first.statusCode, 202);
  assert.equal(replay.statusCode, 202);
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "beginEmailVerification", "signUpEmail", "finalizeEmailVerificationStart",
    "consumeRateLimit", "beginEmailVerification",
  ]);
  const binding = calls.find(({ name }) => name === "beginEmailVerification")?.input as Record<string, unknown>;
  assert.equal(binding.normalizedEmail, "invited@example.test");
  assert.equal(binding.clientKind, "web");
  assert.equal(binding.deviceLabel, "Invitation Browser");
  assert.equal(binding.invitationSecret, "i".repeat(43));
  assert.equal(first.json().verification_id, "verification_01");
  await app.close();
});

test("email verification verifies the provider subject, registers Task 3, and issues the bound Task 6 Session", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, verification_id: "verification_01", verification_code: "opaque-email-token-hash" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().transport, "web_cookie");
  assert.deepEqual(calls.map(({ name }) => name), ["prepareEmailVerification", "verifyEmail", "completeEmailVerification"]);
  const providerInput = calls[1]?.input as Record<string, unknown>;
  assert.deepEqual(providerInput, { verificationCode: "opaque-email-token-hash" });
  const completion = calls[2]?.input as { idempotencyKey?: unknown; payloadHash?: unknown };
  assert.equal(completion.idempotencyKey, idem.idempotency_key);
  assert.equal(completion.payloadHash, idem.payload_hash);
  await app.close();
});

test("email verification rejects a cross-mode request before any provider effect and remains retryable", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const nativeAttempt = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: { host, "content-type": "application/json" },
    payload: { ...idem, verification_id: "verification_01", verification_code: "opaque-email-token-hash" },
  });
  assert.equal(nativeAttempt.statusCode, 400);
  assert.deepEqual(calls.map(({ name }) => name), ["prepareEmailVerification"]);
  calls.length = 0;
  const webRetry = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, verification_id: "verification_01", verification_code: "opaque-email-token-hash" },
  });
  assert.equal(webRetry.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["prepareEmailVerification", "verifyEmail", "completeEmailVerification"]);
  await app.close();
});

test("email and invitation Session delivery fail closed when issued mode differs from validated mode", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const base = await buildApp(calls);
  await base.close();
  const appModule = await import("../src/app.js");
  const app = await appModule.buildIdentityGatewayApp({
    config: { publicOrigins: new Set([origin]), cookieHost: host, publicBaseUrl: `https://${host}`, providerUrl: "https://apple.example.test", appleWebRedirectUris: new Set([redirect]), appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]), passwordResetRedirectUri: `${origin}/auth/password/reset/callback`, publicAuthEnabled: true },
    flowCookieKey: Buffer.alloc(32, 0x34),
    provider: {
      async signInEmail() { return { provider: "supabase" as const, providerSubject: "subject_01", identityKind: "email_password" as const, normalizedEmail: "current@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" }; },
    } as never,
    operations: {
      async consumeRateLimit() { return null; },
      async issueSession() { return { session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_native", session_resource_version: 1, client_kind: "iphone", idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false }, sessionSecret: secret }; },
    } as never,
  });
  const response = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { host, origin, "content-type": "application/json" }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes(secret), false);
  assert.equal(response.headers["set-cookie"], undefined);
  await app.close();
});

test("Apple link start derives actor/email server-side after Session and recent reauthentication", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST", url: "/auth/v1/apple/link/start",
    headers: { host, origin, "content-type": "application/json", cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf },
    payload: { ...idem, password: "correct-horse", client_kind: "web", redirect_uri: redirect },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "consumeRateLimit", "requireRecentReauthentication", "loadNormalizedEmail", "reauthenticateAndBeginAppleLink"]);
  const providerInput = calls.at(-1)?.input as Record<string, unknown>;
  assert.equal(providerInput.authenticatedActorId, "actor_server");
  assert.equal(providerInput.email, "current@example.test");
  assert.equal(providerInput.password, "correct-horse");
  assert.equal("accessToken" in providerInput, false);
  assert.equal("provider_proof" in providerInput, false);
  await app.close();
});

test("Apple link callback consumes its independent callback rate limit before provider effect", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST", url: "/auth/v1/apple/link/callback",
    headers: { host, "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: { ...idem, client_kind: "iphone", transaction_id: "oauth_link", authorization_code: "opaque-code", state: "state-link", nonce: "nonce-link", pkce_code_verifier: "v".repeat(43) },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "consumeRateLimit", "requireRecentReauthentication", "executeProtectedAuthorityCommand"]);
  const rate = calls[1]?.input as Record<string, unknown>;
  assert.equal(rate.bucketKind, "apple_callback");
  const durable = calls.at(-1)?.input as { payload?: unknown };
  assert.deepEqual(durable.payload, idem);
  await app.close();
});

test("closed link-start input rejects forged authority, email, token, and provider proof", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const base = { ...idem, password: "correct-horse", client_kind: "web", redirect_uri: redirect };
  for (const forged of [
    { actor_id: "actor_forged" }, { email: "forged@example.test" }, { access_token: "provider-token" }, { provider_proof: "proof" },
  ]) {
    const response = await app.inject({ method: "POST", url: "/auth/v1/apple/link/start", headers: { host, origin, "content-type": "application/json", cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf }, payload: { ...base, ...forged } });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(calls.some(({ name }) => name === "reauthenticateAndBeginAppleLink"), false);
  await app.close();
});

test("native Apple link start authenticates with one opaque bearer and never sets a flow cookie", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/apple/link/start",
    headers: { host, "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: { ...idem, password: "correct-horse", client_kind: "iphone", redirect_uri: "coreagent://auth/apple/callback", nonce: "native_nonce_01", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "consumeRateLimit", "requireRecentReauthentication", "loadNormalizedEmail", "reauthenticateAndBeginAppleLink"]);
  const authentication = calls[0]?.input as Record<string, unknown>;
  assert.equal(authentication.sessionSecret, secret);
  assert.equal(authentication.requireCsrf, false);
  await app.close();
});

test("Web Apple invitation acceptance reconstructs provider authority from the flow cookie and clears it", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const start = await app.inject({ method: "POST", url: "/auth/v1/apple/start", headers: { host, origin, "content-type": "application/json" }, payload: { ...idem, client_kind: "web", redirect_uri: redirect } });
  const flowCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? []).find((value) => value.startsWith("core_agent_apple_flow="));
  assert.match(flowCookie ?? "", /Path=\/auth\/v1(?:;|$)/u);
  const state = new URL(start.json().authorization_url).searchParams.get("state");
  assert.equal(typeof state, "string");
  calls.length = 0;
  const response = await app.inject({
    method: "POST", url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json", cookie: flowCookie!.split(";", 1)[0]! },
    payload: { ...idem, expected_resource_version: 1, invitation_secret: "i".repeat(43), device_label: "Invitation Browser", authentication_proof: { kind: "apple", client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state } },
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["set-cookie"]), /core_agent_apple_flow=;[^\n]*Max-Age=0/u);
  const providerInput = calls.find(({ name }) => name === "completeApple")?.input as Record<string, unknown>;
  assert.equal(providerInput.transaction_id, "oauth_01");
  assert.equal(providerInput.state, state);
  assert.equal((providerInput as { authorization_code?: unknown }).authorization_code, "opaque_code");
  await app.close();
});

test("management mutation delegates one transaction-scoped reauth plus durable command", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/invitations/revoke",
    headers: { host, origin, "content-type": "application/json", cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf },
    payload: { ...idem, expected_resource_version: 1, invitation_id: "invitation_01", reason_code: "administrator_revoked" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "executeProtectedAuthorityCommand"]);
  const protectedInput = calls[1]?.input as { authority?: { actorId?: unknown; authSubjectId?: unknown; session?: { session_id?: unknown } } };
  assert.deepEqual(protectedInput.authority, {
    actorId: "actor_server",
    authSubjectId: "auth_server",
    session: { session_id: "session_01" },
  });
  await app.close();
});

test("durable commands receive verified facts but never passwords or provider proofs", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const headers = { host, origin, "content-type": "application/json", cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf };
  const reauthentication = await app.inject({
    method: "POST",
    url: "/auth/v1/reauthenticate",
    headers,
    payload: { ...idem, expected_resource_version: 1, password: "correct-horse" },
  });
  assert.equal(reauthentication.statusCode, 200);
  const reauthenticationCommand = calls.find(({ name, input }) => name === "executeAuthorityCommand" && (input as { kind?: unknown }).kind === "reauthenticate")?.input as { payload?: Record<string, unknown>; verifiedSubject?: unknown };
  assert.deepEqual(reauthenticationCommand.payload, { ...idem, expected_resource_version: 1 });
  assert.equal(reauthenticationCommand.verifiedSubject === undefined, false);

  calls.length = 0;
  const proof = "opaque-provider-proof";
  const acceptance = await app.inject({
    method: "POST",
    url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json" },
    payload: {
      ...idem,
      expected_resource_version: 1,
      invitation_secret: "i".repeat(43),
      authentication_proof: { kind: "email_password", client_kind: "web", verification_proof: proof },
      device_label: "Invitation Browser",
    },
  });
  assert.equal(acceptance.statusCode, 200);
  const acceptanceCommand = calls.find(({ name, input }) => name === "executeAuthorityCommand" && (input as { kind?: unknown }).kind === "invitation_accept")?.input as { payload?: unknown; verifiedSubject?: unknown };
  assert.equal(JSON.stringify(acceptanceCommand.payload).includes(proof), false);
  assert.equal(acceptanceCommand.verifiedSubject === undefined, false);
  assert.equal(calls.some(({ name }) => name === "issueSession"), false,
    "acceptance and its one-time Session secret must be one atomic authority operation");
  assert.equal(acceptance.json().issuedSession, undefined);
  await app.close();
});

test("all approved route families are registered only below /auth/v1", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const paths = [
    "/auth/v1/email/sign-up", "/auth/v1/email/sign-in", "/auth/v1/password/reset/start",
    "/auth/v1/apple/start", "/auth/v1/apple/callback", "/auth/v1/apple/link/start", "/auth/v1/apple/link/callback",
    "/auth/v1/session", "/auth/v1/session/sign-out", "/auth/v1/sessions/revoke", "/auth/v1/reauthenticate",
    "/auth/v1/invitations/inspect", "/auth/v1/invitations/register", "/auth/v1/invitations/accept", "/auth/v1/invitations/revoke",
    "/auth/v1/companies", "/auth/v1/companies/members", "/auth/v1/account/deletion/request", "/auth/v1/account/deletion/cancel",
  ];
  for (const path of paths) assert.equal(app.hasRoute({ method: path === "/auth/v1/session" ? "GET" : "POST", url: path }), true, path);
  const outside = await app.inject({ method: "POST", url: "/email/sign-in", headers: { host, origin, "content-type": "application/json" }, payload: {} });
  assert.equal(outside.statusCode, 404);
  await app.close();
});
