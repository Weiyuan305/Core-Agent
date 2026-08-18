import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import { canonicalPayloadHash } from "@core-agent/runtime-core";
import Fastify, { type FastifyInstance } from "fastify";

import { ProviderFailure } from "../src/providers/provider-errors.js";

const host = "identity.example.test";
const origin = "https://app.example.test";
const redirect = `${origin}/auth/apple/callback`;
const secret = "s".repeat(43);
const csrf = "c".repeat(43);
const idem = { schema_version: 1, idempotency_key: "idem_01", payload_hash: `sha256:${"a".repeat(64)}` };

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function emailVerificationPayload(idempotencyKey = idem.idempotency_key) {
  const facts = {
    schema_version: 1 as const,
    idempotency_key: idempotencyKey,
    verification_id: "verification_01",
    verification_code: "opaque-email-token-hash",
  };
  return { ...facts, payload_hash: canonicalPayloadHash(facts) };
}

function invitationAcceptancePayload<T extends {
  schema_version: 1; idempotency_key: string; expected_resource_version: number;
  invitation_secret: string; authentication_proof: Record<string, unknown>; device_label?: string;
}>(facts: T): T & { payload_hash: string } {
  const proof = facts.authentication_proof;
  const canonicalProof = proof.kind === "email_password"
    ? {
      kind: proof.kind, client_kind: proof.client_kind,
      verification_proof_digest: digest(String(proof.verification_proof)),
    }
    : {
      kind: proof.kind, client_kind: proof.client_kind,
      callback_proof_digest: digest(JSON.stringify(proof)),
    };
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version,
      invitation_digest: digest(facts.invitation_secret),
      authentication_proof: canonicalProof,
      ...(facts.device_label === undefined ? {} : { device_label: facts.device_label }),
    }),
  };
}

async function buildApp(
  calls: Array<{ name: string; input: unknown }>,
  options: {
    readonly failFirstEmailStart?: boolean;
    readonly failFinalizedCompletion?: boolean;
    readonly failFirstCheckpoint?: boolean;
    readonly failFirstEmailCompletion?: boolean;
    readonly failAuthentication?: boolean;
    readonly rateLimitAfter?: number;
    readonly rateLimit?: (input: {
      readonly bucketKind?: unknown;
      readonly accountIdentifier?: unknown;
      readonly clientIdentifier?: unknown;
    }) => number | null;
  } = {},
): Promise<FastifyInstance> {
  const path = "../src/app.ts";
  const module = await import(path).catch(() => undefined) as undefined | { buildIdentityGatewayApp(input: Record<string, unknown>): Promise<FastifyInstance> };
  if (module === undefined) return Fastify();
  const subject = { provider: "supabase" as const, providerSubject: "subject_01", identityKind: "email_password" as const, normalizedEmail: "current@example.test", verifiedAt: "2026-08-17T00:00:00.000Z" };
  let emailVerificationState: "reserved" | "finalized" | "failed" | undefined;
  let emailStartCalls = 0;
  let providerEmailVerified = false;
  let checkpointedSubject: typeof subject | undefined;
  let checkpointCalls = 0;
  let completionCalls = 0;
  let rateLimitCalls = 0;
  let providerAttemptStarted = false;
  return module.buildIdentityGatewayApp({
    config: { publicOrigins: new Set([origin]), cookieHost: host, publicBaseUrl: `https://${host}`, providerUrl: "https://apple.example.test", appleWebRedirectUris: new Set([redirect]), appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]), passwordResetRedirectUri: `${origin}/auth/password/reset/callback`, publicAuthEnabled: true },
    flowCookieKey: Buffer.alloc(32, 0x34),
    now: () => new Date("2026-08-17T00:00:00.000Z"),
    provider: {
      async signUpEmail(input: unknown) {
        calls.push({ name: "signUpEmail", input });
        emailStartCalls += 1;
        if (options.failFirstEmailStart === true && emailStartCalls === 1) throw new ProviderFailure("AUTH_INVALID");
        return { kind: "verification_pending" as const, expectedProviderSubject: "subject_01" };
      },
      async verifyEmail(input: unknown) {
        calls.push({ name: "verifyEmail", input });
        if (providerEmailVerified) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        providerEmailVerified = true;
        return subject;
      },
      async recoverVerifiedEmailSubject(input: unknown) {
        calls.push({ name: "recoverVerifiedEmailSubject", input });
        if (!providerEmailVerified) throw new ProviderFailure("AUTH_EMAIL_UNVERIFIED");
        return subject;
      },
      async signInEmail(input: unknown) { calls.push({ name: "signInEmail", input }); return subject; },
      async beginApple(input: unknown) { calls.push({ name: "beginApple", input }); return { transaction_id: "oauth_01", authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_01&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`, expires_at: "2026-08-17T00:05:00.000Z" }; },
      async reauthenticateAndBeginAppleLink(input: unknown) { calls.push({ name: "reauthenticateAndBeginAppleLink", input }); return { transaction_id: "oauth_link", authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_link&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`, expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completeApple(input: unknown) { calls.push({ name: "completeApple", input }); return subject; }, async linkApple() { return subject; },
      async beginPasswordReset(input: unknown) { calls.push({ name: "beginPasswordReset", input }); return { transaction_id: "reset_01", state: "state_reset", expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completePasswordReset() { return subject; }, async verifyCurrentSubject() { return subject; },
      async reauthenticatePassword() { return subject; }, async revokeCurrentProviderSession() {}, async deleteProviderSubject() {},
    },
    operations: {
      async consumeRateLimit(input: unknown) {
        calls.push({ name: "consumeRateLimit", input });
        if (options.rateLimit !== undefined) return options.rateLimit(input as never);
        rateLimitCalls += 1;
        return options.rateLimitAfter !== undefined && rateLimitCalls > options.rateLimitAfter ? 60_000 : null;
      },
      async issueSession(_subject: unknown, clientKind: "web" | "iphone" | "macos", deviceLabel?: string, idempotency?: unknown) { calls.push({ name: "issueSession", input: { clientKind, deviceLabel, idempotency } }); return { session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_01", session_resource_version: 1, client_kind: clientKind, idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false }, sessionSecret: secret, csrfSecret: csrf }; },
      async authenticateSession(input: unknown) {
        calls.push({ name: "authenticateSession", input });
        if (options.failAuthentication === true) throw new ProviderFailure("AUTH_INVALID");
        const credential = input as { sessionSecret?: unknown; requireCsrf?: unknown };
        const clientKind = credential.requireCsrf === true
          ? "web"
          : credential.sessionSecret === "m".repeat(43) ? "macos" : "iphone";
        return { actorId: "actor_server", authSubjectId: "auth_server", session: { session_id: "session_01", client_kind: clientKind, session_resource_version: 1 } };
      },
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
        return {
          clientKind: "web" as const,
          deviceLabel: "Browser",
          providerVerification: checkpointedSubject === undefined
            ? { kind: "pending" as const, expectedProviderSubject: "subject_01" }
            : { kind: "verified" as const, subject: checkpointedSubject },
        };
      },
      async admitEmailVerificationProviderAttempt(input: unknown) {
        calls.push({ name: "admitEmailVerificationProviderAttempt", input });
        const kind = providerAttemptStarted ? "recovery" as const : "started" as const;
        providerAttemptStarted = true;
        return {
          kind,
          expectedProviderSubject: "subject_01",
          expectedNormalizedEmail: "current@example.test",
          verificationStartedAt: "2026-08-17T00:00:00.000Z",
          recoveryNotAfter: "2026-08-17T00:01:00.000Z",
        };
      },
      async readEmailVerificationProviderRecovery(input: unknown) {
        calls.push({ name: "readEmailVerificationProviderRecovery", input });
        return {
          kind: "recovery" as const,
          expectedProviderSubject: "subject_01",
          expectedNormalizedEmail: "current@example.test",
          verificationStartedAt: "2026-08-17T00:00:00.000Z",
          recoveryNotAfter: "2026-08-17T00:01:00.000Z",
        };
      },
      async releaseEmailVerificationProviderAttempt(input: unknown) {
        calls.push({ name: "releaseEmailVerificationProviderAttempt", input });
        providerAttemptStarted = false;
      },
      async checkpointEmailVerification(input: unknown) {
        calls.push({ name: "checkpointEmailVerification", input });
        checkpointCalls += 1;
        if (options.failFirstCheckpoint === true && checkpointCalls === 1) throw new Error("checkpoint unavailable");
        checkpointedSubject = (input as { verifiedSubject: typeof subject }).verifiedSubject;
      },
      async completeEmailVerification(input: unknown) {
        calls.push({ name: "completeEmailVerification", input });
        completionCalls += 1;
        if (options.failFirstEmailCompletion === true && completionCalls === 1) throw new Error("domain transaction rolled back");
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

test("Apple sign-in start and callback consume route buckets before provider effects", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const start = await app.inject({
    method: "POST", url: "/auth/v1/apple/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, client_kind: "web", redirect_uri: redirect },
  });
  assert.equal(start.statusCode, 200, start.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "beginApple"]);
  assert.equal((calls[0]?.input as { bucketKind?: unknown }).bucketKind, "apple_start");
  calls.length = 0;
  const flowCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_apple_flow="));
  const state = new URL(start.json().authorization_url).searchParams.get("state");
  const callback = await app.inject({
    method: "POST", url: "/auth/v1/apple/callback",
    headers: { host, origin, "content-type": "application/json", cookie: flowCookie!.split(";", 1)[0]! },
    payload: { ...idem, client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque-code", state },
  });
  assert.equal(callback.statusCode, 200, callback.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "completeApple", "issueSession"]);
  assert.equal((calls[0]?.input as { bucketKind?: unknown }).bucketKind, "apple_callback");
  await app.close();
});

function callbackLimiter(after: number): (input: {
  readonly bucketKind?: unknown;
  readonly accountIdentifier?: unknown;
  readonly clientIdentifier?: unknown;
}) => number | null {
  const counts = new Map<string, number>();
  return (input) => {
    if (input.bucketKind !== "apple_callback") return null;
    const key = `${String(input.accountIdentifier)}\u0000${String(input.clientIdentifier)}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > after ? 60_000 : null;
  };
}

test("rotating Apple Web callback transactions cannot bypass one stable client route bucket", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { rateLimit: callbackLimiter(1) });
  const callback = (transactionId: string, remoteAddress: string) => app.inject({
    method: "POST" as const, url: "/auth/v1/apple/callback", remoteAddress,
    headers: { host, origin, "content-type": "application/json" },
    payload: {
      ...idem, client_kind: "web", transaction_id: transactionId,
      authorization_code: "opaque-code", state: "state-rotated",
    },
  });

  const first = await callback("attacker-transaction-1", "203.0.113.10");
  const limited = await callback("attacker-transaction-2", "203.0.113.10");
  const independent = await callback("attacker-transaction-3", "203.0.113.11");
  assert.equal(first.statusCode, 401, first.body);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(independent.statusCode, 401, independent.body);
  assert.equal(calls.some(({ name }) => name === "completeApple"), false);
  const rates = calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => input as {
    accountIdentifier: string; clientIdentifier: string;
  });
  assert.equal(rates.length, 3);
  assert.equal(new Set(rates.map(({ accountIdentifier }) => accountIdentifier)).size, 1);
  assert.notEqual(rates[0]?.clientIdentifier, rates[2]?.clientIdentifier);
  await app.close();
});

test("native Apple sign-in and link callbacks use stable route buckets before provider or Session effects", async () => {
  for (const route of ["/auth/v1/apple/callback", "/auth/v1/apple/link/callback"] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls, { rateLimit: callbackLimiter(1) });
    const request = (transactionId: string, remoteAddress: string) => app.inject({
      method: "POST" as const, url: route, remoteAddress,
      headers: {
        host, "content-type": "application/json",
        ...(route.includes("/link/") ? { authorization: `Bearer ${secret}` } : {}),
      },
      payload: {
        ...idem, client_kind: "iphone", transaction_id: transactionId,
        authorization_code: "opaque-code", state: "state-native",
        nonce: "native-nonce-12345678", pkce_code_verifier: "v".repeat(43),
      },
    });

    const first = await request("attacker-native-1", "203.0.113.20");
    const limited = await request("attacker-native-2", "203.0.113.20");
    const independent = await request("attacker-native-3", "203.0.113.21");
    assert.equal(first.statusCode, 200, `${route}: ${first.body}`);
    assert.equal(limited.statusCode, 429, `${route}: ${limited.body}`);
    assert.equal(independent.statusCode, 200, `${route}: ${independent.body}`);
    const rates = calls.filter(({ name, input }) => name === "consumeRateLimit"
      && (input as { bucketKind?: unknown }).bucketKind === "apple_callback")
      .map(({ input }) => input as { accountIdentifier: string; clientIdentifier: string });
    assert.equal(new Set(rates.map(({ accountIdentifier }) => accountIdentifier)).size, 1);
    assert.notEqual(rates[0]?.clientIdentifier, rates[2]?.clientIdentifier);
    const providerOrAuth = calls.filter(({ name }) => name === "completeApple" || name === "authenticateSession");
    assert.equal(providerOrAuth.length, 2, route);
    await app.close();
  }
});

test("Apple invitation callback rotation hits one stable route bucket before provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { rateLimit: callbackLimiter(1) });
  const start = await app.inject({
    method: "POST", url: "/auth/v1/apple/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, client_kind: "web", redirect_uri: redirect },
  });
  const flowCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_apple_flow="))!.split(";", 1)[0]!;
  const state = new URL(start.json().authorization_url).searchParams.get("state")!;
  const request = (transactionId: string) => app.inject({
    method: "POST" as const, url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json", cookie: flowCookie },
    payload: invitationAcceptancePayload({
      schema_version: 1, idempotency_key: idem.idempotency_key,
      expected_resource_version: 1, invitation_secret: "i".repeat(43),
      authentication_proof: {
        kind: "apple", client_kind: "web", transaction_id: transactionId,
        authorization_code: "opaque-code", state,
      },
    }),
  });

  const first = await request("oauth_01");
  const limited = await request("attacker-invitation-rotated");
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(calls.filter(({ name }) => name === "completeApple").length, 1);
  const rates = calls.filter(({ name, input }) => name === "consumeRateLimit"
    && (input as { bucketKind?: unknown }).bucketKind === "apple_callback")
    .map(({ input }) => (input as { accountIdentifier: string }).accountIdentifier);
  assert.equal(new Set(rates).size, 1);
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
  assert.equal((calls.find(({ name }) => name === "finalizeEmailVerificationStart")?.input as Record<string, unknown>)
    .expectedProviderSubject, "subject_01");
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
    payload: emailVerificationPayload(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().transport, "web_cookie");
  assert.deepEqual(calls.map(({ name }) => name), [
    "prepareEmailVerification", "admitEmailVerificationProviderAttempt", "verifyEmail",
    "checkpointEmailVerification", "completeEmailVerification",
  ]);
  const providerInput = calls[2]?.input as Record<string, unknown>;
  assert.deepEqual(providerInput, {
    verificationCode: "opaque-email-token-hash", expectedProviderSubject: "subject_01",
  });
  const completion = calls[4]?.input as { idempotencyKey?: unknown; payloadHash?: unknown };
  assert.equal(completion.idempotencyKey, idem.idempotency_key);
  assert.equal(completion.payloadHash, emailVerificationPayload().payload_hash);
  await app.close();
});

test("email verification rejects a cross-mode request before any provider effect and remains retryable", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const nativeAttempt = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: { host, "content-type": "application/json" },
    payload: emailVerificationPayload(),
  });
  assert.equal(nativeAttempt.statusCode, 400);
  assert.deepEqual(calls.map(({ name }) => name), ["prepareEmailVerification"]);
  calls.length = 0;
  const webRetry = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" },
    payload: emailVerificationPayload(),
  });
  assert.equal(webRetry.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), [
    "prepareEmailVerification", "admitEmailVerificationProviderAttempt", "verifyEmail",
    "checkpointEmailVerification", "completeEmailVerification",
  ]);
  await app.close();
});

test("email verification rejects a changed code under the same canonical hash before any effect", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const original = {
    schema_version: 1 as const,
    idempotency_key: "idem_email_verify_hash",
    verification_id: "verification_01",
    verification_code: "opaque-email-token-hash",
  };
  const payload = { ...original, payload_hash: canonicalPayloadHash(original), verification_code: "changed-email-token-hash" };
  const response = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(calls, []);
  await app.close();
});

test("email verification recovers an OTP consumed before its durable checkpoint", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failFirstCheckpoint: true });
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "idem_email_checkpoint_recovery",
    verification_id: "verification_01",
    verification_code: "one-use-email-token-hash",
  };
  const payload = { ...facts, payload_hash: canonicalPayloadHash(facts) };
  const first = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  const retry = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  assert.equal(first.statusCode, 500);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(calls.filter(({ name }) => name === "verifyEmail").length, 2);
  assert.equal(calls.filter(({ name }) => name === "recoverVerifiedEmailSubject").length, 1);
  const recovery = calls.find(({ name }) => name === "recoverVerifiedEmailSubject")?.input;
  assert.deepEqual(recovery, {
    expectedProviderSubject: "subject_01",
    expectedNormalizedEmail: "current@example.test",
    verificationStartedAt: "2026-08-17T00:00:00.000Z",
    recoveryNotAfter: "2026-08-17T00:01:00.000Z",
  });
  assert.equal(calls.filter(({ name }) => name === "completeEmailVerification").length, 1);
  await app.close();
});

test("email verification skips its one-use provider proof after a durable checkpoint and domain rollback", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failFirstEmailCompletion: true });
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "idem_email_domain_retry",
    verification_id: "verification_01",
    verification_code: "one-use-email-token-hash",
  };
  const payload = { ...facts, payload_hash: canonicalPayloadHash(facts) };
  const first = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  const retry = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  assert.equal(first.statusCode, 500);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(calls.filter(({ name }) => name === "verifyEmail").length, 1);
  assert.equal(calls.filter(({ name }) => name === "recoverVerifiedEmailSubject").length, 0);
  assert.equal(calls.filter(({ name }) => name === "checkpointEmailVerification").length, 1);
  assert.equal(calls.filter(({ name }) => name === "completeEmailVerification").length, 2);
  await app.close();
});

test("reauthentication accepts exact native bearer transport and unlocks native Apple link start", async () => {
  for (const [clientKind, sessionSecret] of [["iphone", "i".repeat(43)], ["macos", "m".repeat(43)]] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls);
    const reauthentication = {
      schema_version: 1 as const,
      idempotency_key: `idem_native_reauth_${clientKind}`,
      expected_resource_version: 1,
      password: "correct-horse",
      client_kind: clientKind,
    };
    const reauthenticationPayload = {
      ...reauthentication,
      payload_hash: canonicalPayloadHash({
        schema_version: reauthentication.schema_version,
        idempotency_key: reauthentication.idempotency_key,
        expected_resource_version: reauthentication.expected_resource_version,
        client_kind: reauthentication.client_kind,
        reauthentication_proof_digest: digest(reauthentication.password),
      }),
    };
    const response = await app.inject({
      method: "POST", url: "/auth/v1/reauthenticate",
      headers: { host, authorization: `Bearer ${sessionSecret}`, "content-type": "application/json" },
      payload: reauthenticationPayload,
    });
    assert.equal(response.statusCode, 200, `${clientKind} reauthentication`);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.body.includes(sessionSecret), false);
    const start = {
      schema_version: 1 as const,
      idempotency_key: `idem_native_link_${clientKind}`,
      payload_hash: `sha256:${"c".repeat(64)}`,
      client_kind: clientKind,
      redirect_uri: "coreagent://auth/apple/callback",
      password: "correct-horse",
      nonce: "native-nonce-12345678",
      pkce_code_challenge: "p".repeat(43),
      pkce_code_challenge_method: "S256" as const,
    };
    const link = await app.inject({
      method: "POST", url: "/auth/v1/apple/link/start",
      headers: { host, authorization: `Bearer ${sessionSecret}`, "content-type": "application/json" },
      payload: start,
    });
    assert.equal(link.statusCode, 200, `${clientKind} Apple link start`);
    assert.equal(link.headers["set-cookie"], undefined);
    assert.deepEqual(calls.filter(({ name }) => name === "executeAuthorityCommand").length, 1);
    await app.close();
  }
});

test("native Session transport rejects Web and cross-native stored modes before authority or provider effects", async () => {
  for (const [requestedKind, sessionSecret] of [
    ["iphone", "m".repeat(43)],
    ["macos", "i".repeat(43)],
  ] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls);
    const facts = {
      schema_version: 1 as const,
      idempotency_key: `idem_native_mode_mismatch_${requestedKind}`,
      expected_resource_version: 1,
      password: "correct-horse",
      client_kind: requestedKind,
    };
    const response = await app.inject({
      method: "POST", url: "/auth/v1/reauthenticate",
      headers: { host, authorization: `Bearer ${sessionSecret}`, "content-type": "application/json" },
      payload: {
        ...facts,
        payload_hash: canonicalPayloadHash({
          schema_version: facts.schema_version,
          idempotency_key: facts.idempotency_key,
          expected_resource_version: facts.expected_resource_version,
          client_kind: facts.client_kind,
          reauthentication_proof_digest: digest(facts.password),
        }),
      },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "authenticateSession"]);
    await app.close();
  }

  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const link = await app.inject({
    method: "POST", url: "/auth/v1/apple/link/start",
    headers: { host, authorization: `Bearer ${"m".repeat(43)}`, "content-type": "application/json" },
    payload: {
      ...idem, password: "correct-horse", client_kind: "iphone",
      redirect_uri: "coreagent://auth/apple/callback", nonce: "native_nonce_01",
      pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256",
    },
  });
  assert.equal(link.statusCode, 401, link.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "authenticateSession"]);
  await app.close();
});

test("pre-auth route rate limits count invalid Sessions before authentication and provider effects", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failAuthentication: true, rateLimitAfter: 1 });
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "idem_invalid_native_rate",
    expected_resource_version: 1,
    password: "correct-horse",
    client_kind: "iphone" as const,
  };
  const payload = {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version,
      client_kind: facts.client_kind,
      reauthentication_proof_digest: digest(facts.password),
    }),
  };
  const first = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate",
    headers: { host, authorization: `Bearer ${"i".repeat(43)}`, "content-type": "application/json" }, payload,
  });
  const limited = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate",
    headers: { host, authorization: `Bearer ${"i".repeat(43)}`, "content-type": "application/json" }, payload,
  });
  assert.equal(first.statusCode, 401, first.body);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "authenticateSession", "consumeRateLimit"]);
  await app.close();
});

test("reauthentication rejects changed password before authentication or provider and native cookie mixing", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const original = {
    schema_version: 1 as const,
    idempotency_key: "idem_native_reauth_hash",
    expected_resource_version: 1,
    password: "correct-horse",
  };
  const payloadHash = canonicalPayloadHash({
    schema_version: original.schema_version,
    idempotency_key: original.idempotency_key,
    expected_resource_version: original.expected_resource_version,
    reauthentication_proof_digest: digest(original.password),
  });
  const changed = { ...original, payload_hash: payloadHash, password: "changed-horse" };
  const forged = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate",
    headers: {
      host, origin, "content-type": "application/json",
      cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf,
    },
    payload: changed,
  });
  assert.equal(forged.statusCode, 400);
  assert.deepEqual(calls, []);
  const mixed = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate",
    headers: { host, authorization: `Bearer ${"i".repeat(43)}`, cookie: `core_agent_session=${secret}`, "content-type": "application/json" },
    payload: { ...original, payload_hash: payloadHash },
  });
  assert.equal(mixed.statusCode, 400);
  assert.deepEqual(calls, []);
  const nativeWithOrigin = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate",
    headers: { host, origin, authorization: `Bearer ${"i".repeat(43)}`, "content-type": "application/json" },
    payload: {
      schema_version: 1, idempotency_key: "idem_native_origin_reauth", expected_resource_version: 1,
      password: "correct-horse", client_kind: "iphone",
      payload_hash: canonicalPayloadHash({
        schema_version: 1, idempotency_key: "idem_native_origin_reauth", expected_resource_version: 1,
        client_kind: "iphone", reauthentication_proof_digest: digest("correct-horse"),
      }),
    },
  });
  assert.equal(nativeWithOrigin.statusCode, 400);
  assert.deepEqual(calls, []);
  await app.close();
});

test("invitation acceptance rejects changed proof facts under the same hash before provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const original = {
    schema_version: 1 as const,
    idempotency_key: "idem_invitation_accept_hash",
    expected_resource_version: 1,
    invitation_secret: "i".repeat(43),
    authentication_proof: { kind: "email_password" as const, client_kind: "web" as const, verification_proof: "correct-proof" },
  };
  const payloadHash = canonicalPayloadHash({
    schema_version: original.schema_version,
    idempotency_key: original.idempotency_key,
    expected_resource_version: original.expected_resource_version,
    invitation_digest: digest(original.invitation_secret),
    authentication_proof: {
      kind: original.authentication_proof.kind,
      client_kind: original.authentication_proof.client_kind,
      verification_proof_digest: digest(original.authentication_proof.verification_proof),
    },
  });
  const payload = {
    ...original,
    payload_hash: payloadHash,
    authentication_proof: { ...original.authentication_proof, verification_proof: "changed-proof" },
  };
  const response = await app.inject({
    method: "POST", url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json" }, payload,
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(calls, []);
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
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "authenticateSession", "consumeRateLimit",
    "requireRecentReauthentication", "loadNormalizedEmail", "reauthenticateAndBeginAppleLink",
  ]);
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
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "authenticateSession", "requireRecentReauthentication", "executeProtectedAuthorityCommand"]);
  const rate = calls[0]?.input as Record<string, unknown>;
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
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "authenticateSession", "consumeRateLimit",
    "requireRecentReauthentication", "loadNormalizedEmail", "reauthenticateAndBeginAppleLink",
  ]);
  const authentication = calls[1]?.input as Record<string, unknown>;
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
    payload: invitationAcceptancePayload({
      schema_version: 1, idempotency_key: idem.idempotency_key,
      expected_resource_version: 1, invitation_secret: "i".repeat(43), device_label: "Invitation Browser",
      authentication_proof: { kind: "apple", client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state },
    }),
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
    session: { session_id: "session_01", client_kind: "web", session_resource_version: 1 },
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
    payload: {
      schema_version: 1, idempotency_key: idem.idempotency_key, expected_resource_version: 1,
      password: "correct-horse",
      payload_hash: canonicalPayloadHash({
        schema_version: 1, idempotency_key: idem.idempotency_key, expected_resource_version: 1,
        reauthentication_proof_digest: digest("correct-horse"),
      }),
    },
  });
  assert.equal(reauthentication.statusCode, 200);
  const reauthenticationCommand = calls.find(({ name, input }) => name === "executeAuthorityCommand" && (input as { kind?: unknown }).kind === "reauthenticate")?.input as { payload?: Record<string, unknown>; verifiedSubject?: unknown };
  assert.deepEqual(reauthenticationCommand.payload, {
    schema_version: 1, idempotency_key: idem.idempotency_key, expected_resource_version: 1,
    reauthentication_proof_digest: digest("correct-horse"),
    payload_hash: canonicalPayloadHash({
      schema_version: 1, idempotency_key: idem.idempotency_key, expected_resource_version: 1,
      reauthentication_proof_digest: digest("correct-horse"),
    }),
  });
  assert.equal(reauthenticationCommand.verifiedSubject === undefined, false);

  calls.length = 0;
  const proof = "opaque-provider-proof";
  const acceptance = await app.inject({
    method: "POST",
    url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json" },
    payload: invitationAcceptancePayload({
      schema_version: 1,
      idempotency_key: idem.idempotency_key,
      expected_resource_version: 1,
      invitation_secret: "i".repeat(43),
      authentication_proof: { kind: "email_password", client_kind: "web", verification_proof: proof },
      device_label: "Invitation Browser",
    }),
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
