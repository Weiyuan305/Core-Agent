import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

const host = "identity.example.test";
const origin = "https://app.example.test";
const redirect = `${origin}/auth/apple/callback`;
const secret = "s".repeat(43);
const csrf = "c".repeat(43);
const idem = { schema_version: 1, idempotency_key: "idem_01", payload_hash: `sha256:${"a".repeat(64)}` };

async function buildApp(calls: Array<{ name: string; input: unknown }>): Promise<FastifyInstance> {
  const path = "../src/app.ts";
  const module = await import(path).catch(() => undefined) as undefined | { buildIdentityGatewayApp(input: Record<string, unknown>): Promise<FastifyInstance> };
  if (module === undefined) return Fastify();
  const subject = { provider: "supabase" as const, providerSubject: "subject_01", identityKind: "email_password" as const, normalizedEmail: "current@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
  return module.buildIdentityGatewayApp({
    config: { publicOrigins: new Set([origin]), cookieHost: host, publicBaseUrl: `https://${host}`, providerUrl: "https://apple.example.test", appleWebRedirectUris: new Set([redirect]), appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]), passwordResetRedirectUri: `${origin}/auth/password/reset/callback`, publicAuthEnabled: true },
    flowCookieKey: Buffer.alloc(32, 0x34),
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    provider: {
      async signUpEmail(input: unknown) { calls.push({ name: "signUpEmail", input }); return { kind: "verification_pending" as const }; },
      async signInEmail(input: unknown) { calls.push({ name: "signInEmail", input }); return subject; },
      async beginApple(input: unknown) { calls.push({ name: "beginApple", input }); return { transaction_id: "oauth_01", authorization_url: "https://apple.example.test/authorize?state=state_01", expires_at: "2026-08-17T00:05:00.000Z" }; },
      async reauthenticateAndBeginAppleLink(input: unknown) { calls.push({ name: "reauthenticateAndBeginAppleLink", input }); return { transaction_id: "oauth_link", authorization_url: "https://apple.example.test/authorize?state=state_link", expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completeApple() { return subject; }, async linkApple() { return subject; },
      async beginPasswordReset() { return { transaction_id: "reset_01", state: "state_reset", expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completePasswordReset() { return subject; }, async verifyCurrentSubject() { return subject; },
      async reauthenticatePassword() { return subject; }, async revokeCurrentProviderSession() {}, async deleteProviderSubject() {},
    },
    operations: {
      async consumeRateLimit(input: unknown) { calls.push({ name: "consumeRateLimit", input }); return null; },
      async issueSession(_subject: unknown, clientKind: "web" | "iphone" | "macos") { calls.push({ name: "issueSession", input: { clientKind } }); return { session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_01", session_resource_version: 1, client_kind: clientKind, idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false }, sessionSecret: secret, csrfSecret: csrf }; },
      async authenticateSession(input: unknown) { calls.push({ name: "authenticateSession", input }); return { actorId: "actor_server", authSubjectId: "auth_server", session: { session_id: "session_01" } }; },
      async requireRecentReauthentication(input: unknown) { calls.push({ name: "requireRecentReauthentication", input }); },
      async loadNormalizedEmail(input: unknown) { calls.push({ name: "loadNormalizedEmail", input }); return "current@example.test"; },
      async executeAuthorityCommand(input: unknown) {
        calls.push({ name: "executeAuthorityCommand", input });
        const kind = (input as { kind?: unknown }).kind;
        if (kind === "reauthenticate") return { schema_version: 1, reauthenticated_at: "2026-08-17T00:00:00.000Z", valid_until: "2026-08-17T00:10:00.000Z", session_resource_version: 2 };
        if (kind === "invitation_accept") return { schema_version: 1, tenant_id: "tenant_01", invitation_resource_version: 2, membership_id: "membership_01", membership_resource_version: 1, role: "admin" };
        return { schema_version: 1 };
      },
      async executeProtectedAuthorityCommand(input: unknown) {
        calls.push({ name: "executeProtectedAuthorityCommand", input });
        const kind = (input as { kind?: unknown }).kind;
        if (kind === "invitation_revoke") return { schema_version: 1, invitation_id: "invitation_01", status: "revoked", resource_version: 2 };
        return { schema_version: 1 };
      },
    },
  });
}

test("route sequencing rate-limits before provider and issues Session after provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { host, origin, "content-type": "application/json" }, payload: { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "signInEmail", "issueSession"]);
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
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "requireRecentReauthentication", "loadNormalizedEmail", "reauthenticateAndBeginAppleLink"]);
  const providerInput = calls.at(-1)?.input as Record<string, unknown>;
  assert.equal(providerInput.authenticatedActorId, "actor_server");
  assert.equal(providerInput.email, "current@example.test");
  assert.equal(providerInput.password, "correct-horse");
  assert.equal("accessToken" in providerInput, false);
  assert.equal("provider_proof" in providerInput, false);
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
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "requireRecentReauthentication", "loadNormalizedEmail", "reauthenticateAndBeginAppleLink"]);
  const authentication = calls[0]?.input as Record<string, unknown>;
  assert.equal(authentication.sessionSecret, secret);
  assert.equal(authentication.requireCsrf, false);
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
    },
  });
  assert.equal(acceptance.statusCode, 200);
  const acceptanceCommand = calls.find(({ name, input }) => name === "executeAuthorityCommand" && (input as { kind?: unknown }).kind === "invitation_accept")?.input as { payload?: unknown; verifiedSubject?: unknown };
  assert.equal(JSON.stringify(acceptanceCommand.payload).includes(proof), false);
  assert.equal(acceptanceCommand.verifiedSubject === undefined, false);
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
