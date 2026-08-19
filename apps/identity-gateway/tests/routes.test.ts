import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import * as Contracts from "@core-agent/contracts";
import { canonicalPayloadHash } from "@core-agent/runtime-core";
import Fastify, { type FastifyInstance } from "fastify";
import Schema from "typebox/schema";

import { ProviderFailure } from "../src/providers/provider-errors.js";
import { assertInvitationAcceptancePayloadHash } from "../src/security.js";

const host = "identity.example.test";
const origin = "https://app.example.test";
const redirect = `${origin}/auth/apple/callback`;
const alternateRedirect = `${origin}/auth/apple/callback-alternate`;
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

function emailSignInPayload<T extends {
  schema_version: 1; idempotency_key: string; email: string; password: string;
  client_kind: "web" | "iphone" | "macos"; device_label?: string;
}>(facts: T): T & { payload_hash: string } {
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      normalized_email: facts.email.toLowerCase(),
      sign_in_proof_digest: digest(facts.password),
      client_kind: facts.client_kind,
      ...(facts.device_label === undefined ? {} : { device_label: facts.device_label }),
    }),
  };
}

function appleCallbackPayload<T extends {
  schema_version: 1; idempotency_key: string; client_kind: "web" | "iphone" | "macos";
  transaction_id: string; authorization_code: string; state: string;
  nonce?: string; pkce_code_verifier?: string;
}>(flowKind: "apple_sign_in" | "apple_link", facts: T): T & { payload_hash: string } {
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      flow_kind: flowKind,
      idempotency_key: facts.idempotency_key,
      client_kind: facts.client_kind,
      transaction_id: facts.transaction_id,
      code_proof_digest: digest(facts.authorization_code),
      state_proof_digest: digest(facts.state),
      ...(facts.nonce === undefined ? {} : { nonce_proof_digest: digest(facts.nonce) }),
      ...(facts.pkce_code_verifier === undefined ? {} : { pkce_proof_digest: digest(facts.pkce_code_verifier) }),
    }),
  };
}

function invitationAcceptancePayload<T extends {
  schema_version: 1; idempotency_key: string; expected_resource_version: number;
  invitation_secret: string; authentication_proof?: Record<string, unknown>;
  client_kind?: "web" | "iphone" | "macos"; device_label?: string;
}>(facts: T): T & { payload_hash: string } {
  const proof = facts.authentication_proof;
  const canonicalProof = proof === undefined
    ? { kind: "core_session", client_kind: facts.client_kind }
    : proof.kind === "apple"
      ? {
        kind: proof.kind,
        client_kind: proof.client_kind,
        callback_proof_digest: canonicalPayloadHash({
          kind: proof.kind,
          client_kind: proof.client_kind,
          transaction_id: proof.transaction_id,
          code_proof_digest: digest(String(proof.authorization_code)),
          state_proof_digest: digest(String(proof.state)),
          ...(proof.nonce === undefined ? {} : { nonce_proof_digest: digest(String(proof.nonce)) }),
          ...(proof.pkce_code_verifier === undefined ? {} : {
            pkce_proof_digest: digest(String(proof.pkce_code_verifier)),
          }),
        }),
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
      authentication: canonicalProof,
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
    readonly failEmailVerificationUnknown?: boolean;
    readonly failAuthentication?: boolean;
    readonly failPasswordResetAuthority?: boolean;
    readonly rateLimitAfter?: number;
    readonly rateLimit?: (input: {
      readonly bucketKind?: unknown;
      readonly accountIdentifier?: unknown;
      readonly clientIdentifier?: unknown;
    }) => number | null;
    readonly trustedProxyAddresses?: ReadonlySet<string>;
    readonly invitationSessionClientKind?: "web" | "iphone" | "macos";
    readonly appleStartResponse?: (input: unknown) => unknown;
    readonly appleLinkStartResponse?: (input: unknown) => unknown;
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
    config: { publicOrigins: new Set([origin]), cookieHost: host, publicBaseUrl: `https://${host}`, providerUrl: "https://apple.example.test", appleWebRedirectUris: new Set([redirect, alternateRedirect]), appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback", "coreagent://auth/apple/callback-alternate"]), passwordResetRedirectUri: `${origin}/auth/password/reset/callback`, publicAuthEnabled: true, trustedProxyAddresses: options.trustedProxyAddresses ?? new Set() },
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
        if (options.failEmailVerificationUnknown === true) {
          providerEmailVerified = true;
          throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        }
        if (providerEmailVerified) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        providerEmailVerified = true;
        return subject;
      },
      async signInEmail(input: unknown) { calls.push({ name: "signInEmail", input }); return subject; },
      async beginApple(input: unknown) { calls.push({ name: "beginApple", input }); return (options.appleStartResponse?.(input) ?? { transaction_id: "oauth_01", authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_01&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`, expires_at: "2026-08-17T00:05:00.000Z" }) as never; },
      async reauthenticateAndBeginAppleLink(input: unknown) { calls.push({ name: "reauthenticateAndBeginAppleLink", input }); return (options.appleLinkStartResponse?.(input) ?? { transaction_id: "oauth_link", authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_link&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`, expires_at: "2026-08-17T00:05:00.000Z" }) as never; },
      async completeApple(input: unknown) { calls.push({ name: "completeApple", input }); return subject; }, async linkApple(input: unknown) { calls.push({ name: "linkApple", input }); return subject; },
      async beginPasswordReset(input: unknown) { calls.push({ name: "beginPasswordReset", input }); return { transaction_id: "reset_01", state: "state_reset", expires_at: "2026-08-17T00:05:00.000Z" }; },
      async completePasswordReset(input: unknown) { calls.push({ name: "completePasswordReset", input }); return subject; }, async verifyCurrentSubject() { return subject; },
      async reauthenticatePassword() { return subject; }, async revokeCurrentProviderSession() {}, async deleteProviderSubject() {},
    },
    operations: {
      async consumeRateLimit(input: unknown) {
        calls.push({ name: "consumeRateLimit", input });
        if (options.rateLimit !== undefined) return options.rateLimit(input as never);
        rateLimitCalls += 1;
        return options.rateLimitAfter !== undefined && rateLimitCalls > options.rateLimitAfter ? 60_000 : null;
      },
      async preparePasswordReset(input: string) {
        calls.push({ name: "preparePasswordReset", input });
        return subject;
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
      async authenticateDeletionRecoverySession(input: unknown) {
        calls.push({ name: "authenticateDeletionRecoverySession", input });
        return {
          actorId: "actor_server", authSubjectId: "auth_server", deletionRecovery: true as const,
          session: { session_id: "session_01", client_kind: "web", session_resource_version: 2 },
        };
      },
      async requireRecentReauthentication(input: unknown) { calls.push({ name: "requireRecentReauthentication", input }); },
      async loadNormalizedEmail(input: unknown) { calls.push({ name: "loadNormalizedEmail", input }); return "current@example.test"; },
      async readAppleLinkSettlement(input: unknown) {
        calls.push({ name: "readAppleLinkSettlement", input });
        return "2026-08-17T00:30:00.000Z";
      },
      async executeAuthorityCommand(input: unknown) {
        calls.push({ name: "executeAuthorityCommand", input });
        const kind = (input as { kind?: unknown }).kind;
        if (kind === "password_reset_completed" && options.failPasswordResetAuthority === true) throw new Error("forced Core revocation rollback");
        if (kind === "reauthenticate") return { schema_version: 1, reauthenticated_at: "2026-08-17T00:00:00.000Z", valid_until: "2026-08-17T00:10:00.000Z", session_resource_version: 2 };
        if (kind === "account_deletion_cancel") return {
          schema_version: 1, account_deletion_id: "deletion_01", status: "cancelled", resource_version: 2,
        };
        if (kind === "invitation_inspect" || kind === "invitation_rate_identity") return {
          schema_version: 1, invitation_id: "invitation_01", tenant_id: "tenant_01", role: "admin",
          status: "pending", expires_at: "2026-08-18T00:00:00.000Z", resource_version: 1,
        };
        if (kind === "invitation_accept") return {
          schema_version: 1, tenant_id: "tenant_01", invitation_resource_version: 2,
          membership_id: "membership_01", membership_resource_version: 1, role: "admin",
          issuedSession: {
            session: { schema_version: 1, actor_id: "actor_server", actor_resource_version: 1, session_id: "session_invitation", session_resource_version: 1, client_kind: options.invitationSessionClientKind ?? "web", idle_expires_at: "2026-08-18T00:00:00.000Z", absolute_expires_at: "2026-09-16T00:00:00.000Z", reauthentication_required: false },
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
        if (kind === "account_deletion_request") return {
          schema_version: 1, account_deletion_id: "deletion_01", status: "deletion_pending",
          scheduled_for: "2026-09-16T00:00:00.000Z", resource_version: 1,
        };
        return { schema_version: 1 };
      },
      async beginEmailVerification(input: unknown) {
        calls.push({ name: "beginEmailVerification", input });
        const kind = emailVerificationState === undefined || emailVerificationState === "failed"
          ? "reserved" as const
          : emailVerificationState === "finalized" ? "finalized_replay" as const : "in_progress" as const;
        if (kind === "reserved") emailVerificationState = "reserved";
        return { verificationId: "verification_01", kind, ...(kind === "reserved" ? { providerStartAttempt: emailStartCalls + 1 } : {}) };
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
        return kind === "started" ? { kind, expectedProviderSubject: "subject_01" } : { kind };
      },
      async releaseEmailVerificationProviderAttempt(input: unknown) {
        calls.push({ name: "releaseEmailVerificationProviderAttempt", input });
        providerAttemptStarted = false;
      },
      async terminalizeEmailVerificationProviderAttempt(input: unknown) {
        calls.push({ name: "terminalizeEmailVerificationProviderAttempt", input });
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
  const payload = emailSignInPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, email: "STUDENT@EXAMPLE.TEST", password: "correct-horse", client_kind: "web" });
  const response = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { host, origin, "content-type": "application/json" }, payload });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "signInEmail", "issueSession"]);
  assert.equal((calls[1]?.input as { email?: unknown }).email, "student@example.test");
  assert.deepEqual((calls[2]?.input as { idempotency?: unknown }).idempotency, {
    idempotencyKey: idem.idempotency_key, payloadHash: payload.payload_hash, operation: "email_sign_in",
    secretProof: Buffer.alloc(Buffer.byteLength("correct-horse")),
  });
  await app.close();
});

test("email sign-in binds normalized email password client and device before provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const original = {
    schema_version: 1 as const,
    idempotency_key: "idem_email_signin_hash",
    email: "STUDENT@EXAMPLE.TEST",
    password: "correct-horse",
    client_kind: "web" as const,
    device_label: "Browser",
  };
  const payloadHash = canonicalPayloadHash({
    schema_version: original.schema_version,
    idempotency_key: original.idempotency_key,
    normalized_email: "student@example.test",
    sign_in_proof_digest: digest(original.password),
    client_kind: original.client_kind,
    device_label: original.device_label,
  });
  const response = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-in",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...original, password: "changed-horse", payload_hash: payloadHash },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(calls.some(({ name }) => name === "signInEmail" || name === "issueSession"), false);
  await app.close();
});

test("client rate identity ignores X-Forwarded-For by default and honors only an explicit trusted proxy", async () => {
  const directCalls: Array<{ name: string; input: unknown }> = [];
  const direct = await buildApp(directCalls);
  for (const forwarded of ["203.0.113.10", "203.0.113.11"]) {
    await direct.inject({
      method: "POST", url: "/auth/v1/email/sign-in",
      remoteAddress: "127.0.0.1",
      headers: { host, origin, "content-type": "application/json", "x-forwarded-for": forwarded },
      payload: emailSignInPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, email: "student@example.test", password: "correct-horse", client_kind: "web" }),
    });
  }
  const directIdentifiers = directCalls.filter(({ name }) => name === "consumeRateLimit")
    .map(({ input }) => (input as { clientIdentifier?: unknown }).clientIdentifier);
  assert.deepEqual(directIdentifiers, ["127.0.0.1", "127.0.0.1"]);
  assert.equal(directIdentifiers.includes("untrusted-forwarded-address"), false);
  await direct.close();

  const proxiedCalls: Array<{ name: string; input: unknown }> = [];
  const proxied = await buildApp(proxiedCalls, { trustedProxyAddresses: new Set(["127.0.0.1"]) });
  await proxied.inject({
    method: "POST", url: "/auth/v1/email/sign-in", remoteAddress: "127.0.0.1",
    headers: { host, origin, "content-type": "application/json", "x-forwarded-for": "198.51.100.25" },
    payload: emailSignInPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, email: "student@example.test", password: "correct-horse", client_kind: "web" }),
  });
  const proxiedRate = proxiedCalls.find(({ name }) => name === "consumeRateLimit")?.input as {
    readonly clientIdentifier?: unknown;
  };
  assert.equal(proxiedRate.clientIdentifier, "198.51.100.25");
  await proxied.close();
});

test("password reset normalizes one account identifier for rate limit and provider", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const facts = {
    schema_version: 1 as const, idempotency_key: idem.idempotency_key,
    expected_resource_version: 1, invitation_id: "invitation_01", reason_code: "administrator_revoked",
  };
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/password/reset/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, email: "STUDENT@EXAMPLE.TEST" },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "preparePasswordReset", "beginPasswordReset"]);
  assert.equal((calls[0]?.input as { accountIdentifier?: unknown }).accountIdentifier, "student@example.test");
  assert.equal(calls[1]?.input, "student@example.test");
  assert.deepEqual(calls[2]?.input, {
    email: "student@example.test",
    idempotencyKey: idem.idempotency_key,
    payloadHash: idem.payload_hash,
    expectedSubject: {
      provider: "supabase", providerSubject: "subject_01", identityKind: "email_password",
      normalizedEmail: "current@example.test", verifiedAt: "2026-08-17T00:00:00.000Z",
    },
  });
  await app.close();
});

test("email verification and password-reset completion consume stable client route buckets before provider effects", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { rateLimitAfter: 0 });
  const verification = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" },
    payload: emailVerificationPayload("idem_completion_rate"),
  });
  assert.equal(verification.statusCode, 429, verification.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit"]);
  assert.equal((calls[0]?.input as { bucketKind?: unknown }).bucketKind, "email_verification");
  assert.equal((calls[0]?.input as { accountIdentifier?: unknown }).accountIdentifier, "route:email_verification");
  assert.equal((calls[0]?.input as { dimensions?: unknown }).dimensions, "client");
  assert.match(String((calls[0]?.input as { clientIdentifier?: unknown }).clientIdentifier), /./u);
  await app.close();

  const resetCalls: Array<{ name: string; input: unknown }> = [];
  const resetApp = await buildApp(resetCalls, { rateLimitAfter: 1 });
  const start = await resetApp.inject({
    method: "POST", url: "/auth/v1/password/reset/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, email: "student@example.test" },
  });
  const recoveryCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_recovery="))?.split(";", 1)[0];
  assert.notEqual(recoveryCookie, undefined);
  resetCalls.length = 0;
  const resetFacts = {
    schema_version: 1 as const, idempotency_key: "idem_reset_completion_rate",
    authorization_code: "one-time-authorization-code", new_password: "updated-correct-horse",
  };
  const resetPayloadHash = canonicalPayloadHash({
    schema_version: resetFacts.schema_version, idempotency_key: resetFacts.idempotency_key,
    reset_code_digest: digest(resetFacts.authorization_code),
    new_value_digest: digest(resetFacts.new_password),
  });
  const completion = await resetApp.inject({
    method: "POST", url: "/auth/v1/password/reset/complete",
    headers: { host, origin, "content-type": "application/json", cookie: recoveryCookie! },
    payload: { ...resetFacts, payload_hash: resetPayloadHash },
  });
  assert.equal(completion.statusCode, 429, completion.body);
  assert.deepEqual(resetCalls.map(({ name }) => name), ["consumeRateLimit"]);
  assert.equal((resetCalls[0]?.input as { bucketKind?: unknown }).bucketKind, "reset_complete");
  await resetApp.close();
});

test("password-reset completion retains its recovery cookie when the Core revocation phase rolls back", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failPasswordResetAuthority: true });
  const start = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, email: "student@example.test" },
  });
  const recoveryCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_recovery="))?.split(";", 1)[0];
  const facts = {
    schema_version: 1 as const, idempotency_key: "idem_reset_retryable",
    authorization_code: "one-time-authorization-code", new_password: "updated-correct-horse",
  };
  const payloadHash = canonicalPayloadHash({
    schema_version: facts.schema_version, idempotency_key: facts.idempotency_key,
    reset_code_digest: digest(facts.authorization_code),
    new_value_digest: digest(facts.new_password),
  });
  const completion = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/complete",
    headers: { host, origin, "content-type": "application/json", cookie: recoveryCookie! },
    payload: { ...facts, payload_hash: payloadHash },
  });
  assert.equal(completion.statusCode, 500, completion.body);
  assert.doesNotMatch(String(completion.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
  assert.deepEqual(calls.slice(-2).map(({ name }) => name), ["completePasswordReset", "executeAuthorityCommand"]);
  assert.equal((calls.at(-2)?.input as { payloadHash?: unknown }).payloadHash, payloadHash);
  await app.close();
});

test("password-reset completion preserves its recovery cookie on 429 and clears it after retry or terminal failure", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  let completionRates = 0;
  const app = await buildApp(calls, {
    rateLimit(input) {
      if (input.bucketKind !== "reset_complete") return null;
      completionRates += 1;
      return completionRates === 1 ? 1_000 : null;
    },
  });
  const start = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, email: "student@example.test" },
  });
  const recoveryCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_recovery="))?.split(";", 1)[0];
  assert.notEqual(recoveryCookie, undefined);
  const facts = {
    schema_version: 1 as const, idempotency_key: "idem_reset_rate_retry",
    authorization_code: "one-time-authorization-code", new_password: "updated-correct-horse",
  };
  const payloadHash = canonicalPayloadHash({
    schema_version: facts.schema_version, idempotency_key: facts.idempotency_key,
    reset_code_digest: digest(facts.authorization_code), new_value_digest: digest(facts.new_password),
  });
  const headers = { host, origin, "content-type": "application/json", cookie: recoveryCookie! };
  const limited = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/complete", headers,
    payload: { ...facts, payload_hash: payloadHash },
  });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.doesNotMatch(String(limited.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
  const retried = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/complete", headers,
    payload: { ...facts, payload_hash: payloadHash },
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.match(String(retried.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);

  const terminalStart = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { schema_version: 1, idempotency_key: "idem_terminal_start", payload_hash: `sha256:${"f".repeat(64)}`, email: "student@example.test" },
  });
  const terminalCookie = ([] as string[]).concat(terminalStart.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_recovery="))?.split(";", 1)[0];
  const terminal = await app.inject({
    method: "POST", url: "/auth/v1/password/reset/complete",
    headers: { ...headers, cookie: terminalCookie! },
    payload: { ...facts, idempotency_key: "idem_terminal_completion", payload_hash: `sha256:${"e".repeat(64)}` },
  });
  assert.equal(terminal.statusCode, 400, terminal.body);
  assert.match(String(terminal.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
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
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "consumeRateLimit", "beginApple"]);
  assert.equal((calls[0]?.input as { bucketKind?: unknown }).bucketKind, "apple_start");
  assert.deepEqual(calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => {
    const rate = input as { dimensions?: unknown; accountIdentifier?: unknown; policy?: unknown };
    return [rate.dimensions, rate.accountIdentifier, rate.policy];
  }), [
    ["client", "route:apple_start:web", undefined],
    ["account", "global-circuit-breaker:anonymous-apple-start", "anonymous_apple_start_global_circuit_breaker"],
  ]);
  calls.length = 0;
  const flowCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_apple_flow="));
  const state = new URL(start.json().authorization_url).searchParams.get("state");
  const callback = await app.inject({
    method: "POST", url: "/auth/v1/apple/callback",
    headers: { host, origin, "content-type": "application/json", cookie: flowCookie!.split(";", 1)[0]! },
    payload: appleCallbackPayload("apple_sign_in", { schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque-code", state: state! }),
  });
  assert.equal(callback.statusCode, 200, callback.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "consumeRateLimit", "completeApple", "issueSession"]);
  assert.equal((calls[0]?.input as { bucketKind?: unknown }).bucketKind, "apple_callback");
  assert.deepEqual(calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => {
    const rate = input as { dimensions?: unknown; accountIdentifier?: unknown };
    return [rate.dimensions, rate.accountIdentifier];
  }), [["client", "route:apple_sign_in_callback"], ["account", "oauth_01"]]);
  await app.close();
});

test("Apple sign-in and link start serialize exact mode-specific Contracts", async () => {
  const responseSchemas = Contracts as unknown as Record<string, unknown>;
  const signIn = Schema.Compile(responseSchemas.AppleAuthorizationStartResponseSchema as never);
  assert.notEqual(responseSchemas.AppleIdentityLinkStartResponseSchema, undefined,
    "AppleIdentityLinkStartResponseSchema must be exported");
  const link = Schema.Compile(responseSchemas.AppleIdentityLinkStartResponseSchema as never);
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, {
    appleStartResponse(input) {
      return {
        transaction_id: "oauth_01",
        authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_01&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`,
        expires_at: "2026-08-17T00:05:00.000Z",
        provider_token: "must-not-serialize",
      };
    },
    appleLinkStartResponse(input) {
      return {
        transaction_id: "oauth_link",
        authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_link&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`,
        expires_at: "2026-08-17T00:05:00.000Z",
        provider_token: "must-not-serialize",
      };
    },
  });
  const cases = [
    {
      name: "sign-in Web", schema: signIn, url: "/auth/v1/apple/start",
      headers: { host, origin, "content-type": "application/json" },
      payload: { ...idem, client_kind: "web", redirect_uri: redirect },
      expectedKeys: ["authorization_url", "schema_version"],
    },
    {
      name: "sign-in native", schema: signIn, url: "/auth/v1/apple/start",
      headers: { host, "content-type": "application/json" },
      payload: { ...idem, client_kind: "iphone", redirect_uri: "coreagent://auth/apple/callback", nonce: "native_nonce_01", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" },
      expectedKeys: ["authorization_url", "expires_at", "schema_version", "transaction_id"],
    },
    {
      name: "link Web", schema: link, url: "/auth/v1/apple/link/start",
      headers: { host, origin, "content-type": "application/json", cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf },
      payload: { ...idem, password: "correct-horse", client_kind: "web", redirect_uri: redirect },
      expectedKeys: ["authorization_url", "schema_version"],
    },
    {
      name: "link native", schema: link, url: "/auth/v1/apple/link/start",
      headers: { host, authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: { ...idem, password: "correct-horse", client_kind: "iphone", redirect_uri: "coreagent://auth/apple/callback", nonce: "native_nonce_01", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" },
      expectedKeys: ["authorization_url", "expires_at", "schema_version", "transaction_id"],
    },
  ] as const;
  for (const scenario of cases) {
    const response = await app.inject({
      method: "POST", url: scenario.url, headers: scenario.headers, payload: scenario.payload,
    });
    assert.equal(response.statusCode, 200, `${scenario.name}: ${response.body}`);
    const body: unknown = response.json();
    assert.equal(scenario.schema.Check(body), true, scenario.name);
    assert.deepEqual(Object.keys(body as object).sort(), scenario.expectedKeys, scenario.name);
    assert.equal(response.body.includes("must-not-serialize"), false, scenario.name);
  }
  await app.close();
});

test("Apple start response schemas reject missing native fields from both provider paths", async () => {
  for (const [url, option] of [
    ["/auth/v1/apple/start", "appleStartResponse"],
    ["/auth/v1/apple/link/start", "appleLinkStartResponse"],
  ] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls, {
      [option](input: unknown) {
        return {
          transaction_id: "oauth_missing_expiry",
          authorization_url: `https://apple.example.test/auth/v1/authorize?state=state_01&redirect_to=${encodeURIComponent((input as { redirect_uri: string }).redirect_uri)}`,
        };
      },
    });
    const link = url.includes("/link/");
    const response = await app.inject({
      method: "POST", url,
      headers: { host, authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: {
        ...idem, ...(link ? { password: "correct-horse" } : {}), client_kind: "iphone",
        redirect_uri: "coreagent://auth/apple/callback", nonce: "native_nonce_01",
        pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256",
      },
    });
    assert.equal(response.statusCode, 500, `${url}: ${response.body}`);
    assert.equal(response.body.includes("oauth_missing_expiry"), false);
    await app.close();
  }
});

test("Apple start routes reject provider authorization URLs above the 2048 contract bound", async () => {
  const oversizedAuthorizationUrl = (redirectUri: string): string => (
    `https://apple.example.test/auth/v1/authorize?state=state_01&redirect_to=${encodeURIComponent(redirectUri)}&padding=${"x".repeat(2_048)}`
  );
  for (const [url, option] of [
    ["/auth/v1/apple/start", "appleStartResponse"],
    ["/auth/v1/apple/link/start", "appleLinkStartResponse"],
  ] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls, {
      [option](input: unknown) {
        return {
          transaction_id: "oauth_oversized_url",
          authorization_url: oversizedAuthorizationUrl((input as { redirect_uri: string }).redirect_uri),
          expires_at: "2026-08-17T00:05:00.000Z",
        };
      },
    });
    const link = url.includes("/link/");
    const response = await app.inject({
      method: "POST", url,
      headers: { host, authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: {
        ...idem, ...(link ? { password: "correct-horse" } : {}), client_kind: "iphone",
        redirect_uri: "coreagent://auth/apple/callback", nonce: "native_nonce_01",
        pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256",
      },
    });
    assert.equal(response.statusCode, 503, `${url}: ${response.body}`);
    assert.equal(response.body.includes("oauth_oversized_url"), false);
    await app.close();
  }
});

test("Apple sign-in start account limiting precedes every provider and durable start effect", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, {
    rateLimit(input) {
      return input.bucketKind === "apple_start" && input.accountIdentifier === "global-circuit-breaker:anonymous-apple-start"
        ? 60_000 : null;
    },
  });
  const response = await app.inject({
    method: "POST", url: "/auth/v1/apple/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, client_kind: "web", redirect_uri: redirect },
  });
  assert.equal(response.statusCode, 429, response.body);
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "consumeRateLimit"]);
  assert.equal(calls.some(({ name }) => name === "beginApple"), false);
  await app.close();
});

test("anonymous Apple starts share one server-owned global circuit breaker while client buckets stay independent", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const requests = [
    {
      remoteAddress: "198.51.100.10",
      headers: { host, origin, "content-type": "application/json" },
      payload: { ...idem, idempotency_key: "idem_apple_rotate_1", client_kind: "web", redirect_uri: redirect, device_label: "Browser A" },
    },
    {
      remoteAddress: "198.51.100.11",
      headers: { host, origin, "content-type": "application/json" },
      payload: { ...idem, idempotency_key: "idem_apple_rotate_2", client_kind: "web", redirect_uri: alternateRedirect, device_label: "Browser B" },
    },
    {
      remoteAddress: "198.51.100.12",
      headers: { host, "content-type": "application/json" },
      payload: {
        ...idem, idempotency_key: "idem_apple_rotate_3", client_kind: "iphone",
        redirect_uri: "coreagent://auth/apple/callback", nonce: "nonce_apple_rotate_3",
        pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256",
      },
    },
    {
      remoteAddress: "198.51.100.13",
      headers: { host, "content-type": "application/json" },
      payload: {
        ...idem, idempotency_key: "idem_apple_rotate_4", client_kind: "iphone",
        redirect_uri: "coreagent://auth/apple/callback-alternate", nonce: "nonce_apple_rotate_4",
        pkce_code_challenge: "b".repeat(43), pkce_code_challenge_method: "S256",
      },
    },
  ] as const;
  for (const request of requests) {
    const response = await app.inject({ method: "POST", url: "/auth/v1/apple/start", ...request });
    assert.equal(response.statusCode, 200, response.body);
  }
  const rates = calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => input as {
    dimensions?: unknown; accountIdentifier?: unknown; clientIdentifier?: unknown; policy?: unknown;
  });
  const global = rates.filter(({ dimensions }) => dimensions === "account");
  assert.equal(global.length, requests.length);
  assert.deepEqual(new Set(global.map(({ accountIdentifier }) => accountIdentifier)), new Set(["global-circuit-breaker:anonymous-apple-start"]));
  assert.deepEqual(new Set(global.map(({ policy }) => policy)), new Set(["anonymous_apple_start_global_circuit_breaker"]));
  const clients = rates.filter(({ dimensions }) => dimensions === "client");
  assert.equal(new Set(clients.map(({ clientIdentifier }) => clientIdentifier)).size, requests.length);
  await app.close();
});

test("Apple sign-in and link callbacks bind every closed proof fact before provider", async () => {
  for (const flowKind of ["apple_sign_in", "apple_link"] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls);
    const facts = {
      schema_version: 1 as const,
      idempotency_key: `idem_${flowKind}_callback_hash`,
      client_kind: "iphone" as const,
      transaction_id: `oauth_${flowKind}_hash`,
      authorization_code: "original-authorization-code",
      state: "original-state-proof",
      nonce: "original-nonce-proof",
      pkce_code_verifier: "v".repeat(43),
    };
    const payloadHash = canonicalPayloadHash({
      schema_version: facts.schema_version,
      flow_kind: flowKind,
      idempotency_key: facts.idempotency_key,
      client_kind: facts.client_kind,
      transaction_id: facts.transaction_id,
      code_proof_digest: digest(facts.authorization_code),
      state_proof_digest: digest(facts.state),
      nonce_proof_digest: digest(facts.nonce),
      pkce_proof_digest: digest(facts.pkce_code_verifier),
    });
    const response = await app.inject({
      method: "POST",
      url: flowKind === "apple_sign_in" ? "/auth/v1/apple/callback" : "/auth/v1/apple/link/callback",
      headers: {
        host, "content-type": "application/json",
        ...(flowKind === "apple_link" ? { authorization: `Bearer ${secret}` } : {}),
      },
      payload: { ...facts, authorization_code: "changed-authorization-code", payload_hash: payloadHash },
    });
    assert.equal(response.statusCode, 400, `${flowKind}: ${response.body}`);
    assert.equal(calls.some(({ name }) => name === "completeApple" || name === "linkApple"
      || name === "issueSession" || name === "executeProtectedAuthorityCommand"), false);
    await app.close();
  }
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
    payload: appleCallbackPayload("apple_sign_in", {
      schema_version: 1, idempotency_key: idem.idempotency_key,
      client_kind: "web", transaction_id: transactionId,
      authorization_code: "opaque-code", state: "state-rotated",
    }),
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
      payload: appleCallbackPayload(route.includes("/link/") ? "apple_link" : "apple_sign_in", {
        schema_version: 1, idempotency_key: idem.idempotency_key,
        client_kind: "iphone", transaction_id: transactionId,
        authorization_code: "opaque-code", state: "state-native",
        nonce: "native-nonce-12345678", pkce_code_verifier: "v".repeat(43),
      }),
    });

    const first = await request("attacker-native-1", "203.0.113.20");
    const limited = await request("attacker-native-2", "203.0.113.20");
    const independent = await request("attacker-native-3", "203.0.113.21");
    assert.equal(first.statusCode, 200, `${route}: ${first.body}`);
    assert.equal(limited.statusCode, 429, `${route}: ${limited.body}`);
    assert.equal(independent.statusCode, 200, `${route}: ${independent.body}`);
    const rates = calls.filter(({ name, input }) => name === "consumeRateLimit"
      && (input as { bucketKind?: unknown; dimensions?: unknown }).bucketKind === "apple_callback"
      && (input as { dimensions?: unknown }).dimensions === "client")
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
  calls.length = 0;
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
  assert.deepEqual(calls.slice(0, 5).map(({ name }) => name), [
    "consumeRateLimit", "consumeRateLimit", "executeAuthorityCommand", "consumeRateLimit", "completeApple",
  ]);
  const firstRates = calls.slice(0, 5).filter(({ name }) => name === "consumeRateLimit")
    .map(({ input }) => {
      const rate = input as { bucketKind: string; dimensions: string; accountIdentifier: string };
      return [rate.bucketKind, rate.dimensions, rate.accountIdentifier];
    });
  assert.deepEqual(firstRates, [
    ["apple_callback", "client", "route:apple_invitation_callback"],
    ["apple_callback", "account", "oauth_01"],
    ["invitation_accept", "account", "invitation_01"],
  ]);
  assert.equal(calls.filter(({ name, input }) => name === "consumeRateLimit"
    && (input as { dimensions?: unknown }).dimensions === "client").length, 2,
  "each request consumes exactly one stable client bucket");
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
  assert(binding.passwordProof instanceof Uint8Array);
  assert.equal([...binding.passwordProof].every((byte) => byte === 0), true);
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

test("an unknown email start-finalization outcome is retryable during its durable lease", async () => {
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
  assert.equal(retry.statusCode, 503);
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
    "consumeRateLimit", "executeAuthorityCommand", "consumeRateLimit", "beginEmailVerification", "signUpEmail", "finalizeEmailVerificationStart",
    "consumeRateLimit", "executeAuthorityCommand", "consumeRateLimit", "beginEmailVerification",
  ]);
  const rates = calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => input as {
    accountIdentifier: string; dimensions?: string;
  });
  assert.deepEqual(rates.map(({ accountIdentifier, dimensions }) => ({ accountIdentifier, dimensions })), [
    { accountIdentifier: "route:invitation_register", dimensions: "client" },
    { accountIdentifier: "invitation_01", dimensions: "account" },
    { accountIdentifier: "route:invitation_register", dimensions: "client" },
    { accountIdentifier: "invitation_01", dimensions: "account" },
  ]);
  assert.equal(JSON.stringify(rates).includes("invited@example.test"), false);
  assert.equal(JSON.stringify(rates).includes("i".repeat(43)), false);
  const binding = calls.find(({ name }) => name === "beginEmailVerification")?.input as Record<string, unknown>;
  assert.equal(binding.normalizedEmail, "invited@example.test");
  assert.equal(binding.clientKind, "web");
  assert.equal(binding.deviceLabel, "Invitation Browser");
  assert(binding.passwordProof instanceof Uint8Array);
  assert.equal([...binding.passwordProof].every((byte) => byte === 0), true);
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
    "consumeRateLimit", "prepareEmailVerification", "consumeRateLimit", "admitEmailVerificationProviderAttempt", "verifyEmail",
    "checkpointEmailVerification", "completeEmailVerification",
  ]);
  const providerInput = calls[4]?.input as Record<string, unknown>;
  assert.deepEqual(providerInput, {
    verificationCode: "opaque-email-token-hash", expectedProviderSubject: "subject_01",
  });
  const completion = calls[6]?.input as { idempotencyKey?: unknown; payloadHash?: unknown };
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
  assert.deepEqual(calls.map(({ name }) => name), ["consumeRateLimit", "prepareEmailVerification"]);
  calls.length = 0;
  const webRetry = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" },
    payload: emailVerificationPayload(),
  });
  assert.equal(webRetry.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "prepareEmailVerification", "consumeRateLimit", "admitEmailVerificationProviderAttempt", "verifyEmail",
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

test("email verification terminalizes an OTP consumed before its durable checkpoint without inspection", async () => {
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
  assert.equal(retry.statusCode, 401, retry.body);
  assert.equal(calls.filter(({ name }) => name === "verifyEmail").length, 1);
  assert.equal(calls.filter(({ name }) => name === "terminalizeEmailVerificationProviderAttempt").length, 1);
  assert.equal(calls.filter(({ name }) => name === "completeEmailVerification").length, 0);
  await app.close();
});

test("email verification unknown provider outcome terminalizes without cross-clock inspection", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failEmailVerificationUnknown: true });
  const response = await app.inject({
    method: "POST", url: "/auth/v1/email/verification",
    headers: { host, origin, "content-type": "application/json" },
    payload: emailVerificationPayload("idem_email_unknown_outcome"),
  });
  assert.equal(response.statusCode, 401, response.body);
  assert.equal(calls.filter(({ name }) => name === "verifyEmail").length, 1);
  assert.equal(calls.filter(({ name }) => name === "terminalizeEmailVerificationProviderAttempt").length, 1);
  assert.equal(calls.some(({ name }) => name === "checkpointEmailVerification" || name === "completeEmailVerification"), false);
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
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "authenticateSession", "authenticateDeletionRecoverySession", "consumeRateLimit",
  ]);
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

test("existing invitation acceptance uses Core Session authority and rejects provider access tokens", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const facts = {
    schema_version: 1 as const,
    idempotency_key: "idem_existing_invitee",
    expected_resource_version: 1,
    invitation_secret: "i".repeat(43),
    client_kind: "web" as const,
    device_label: "Existing Browser",
  };
  const payload = {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version,
      invitation_digest: digest(facts.invitation_secret),
      authentication: { kind: "core_session", client_kind: facts.client_kind },
      device_label: facts.device_label,
    }),
  };
  const accepted = await app.inject({
    method: "POST", url: "/auth/v1/invitations/accept",
    headers: {
      host, origin, "content-type": "application/json", "x-core-agent-csrf": csrf,
      cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`,
    },
    payload,
  });
  assert.equal(accepted.statusCode, 200, `${accepted.body}\n${JSON.stringify(calls)}`);
  assert.equal(calls.some(({ name }) => name === "verifyCurrentSubject"), false);
  assert.equal(calls.some(({ name }) => name === "completeApple"), false);
  assert.equal(calls.some(({ name }) => name === "authenticateSession"), true);
  const command = calls.filter(({ name }) => name === "executeAuthorityCommand").at(-1)?.input as {
    readonly authority?: { readonly actorId?: unknown };
    readonly verifiedSubject?: unknown;
  };
  assert.equal(command.authority?.actorId, "actor_server");
  assert.equal(command.verifiedSubject, undefined);
  assert.deepEqual(calls.map(({ name }) => name).slice(0, 4), [
    "consumeRateLimit", "executeAuthorityCommand", "consumeRateLimit", "authenticateSession",
  ]);
  const rates = calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => input as {
    readonly accountIdentifier?: unknown; readonly dimensions?: unknown;
  });
  assert.deepEqual(rates.map(({ dimensions }) => dimensions), ["client", "account"]);
  assert.deepEqual(rates.map(({ accountIdentifier }) => accountIdentifier), [
    "route:invitation_accept", "invitation_01",
  ]);
  assert.equal(JSON.stringify(rates).includes(facts.invitation_secret), false);

  const callsBeforeForbidden = calls.length;
  const forbidden = await app.inject({
    method: "POST", url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json" },
    payload: {
      schema_version: facts.schema_version,
      idempotency_key: "idem_legacy_provider_proof",
      expected_resource_version: facts.expected_resource_version,
      invitation_secret: facts.invitation_secret,
      device_label: facts.device_label,
      authentication_proof: {
        kind: "email_password", client_kind: "web", verification_proof: "provider-access-token",
      },
      payload_hash: canonicalPayloadHash({
        schema_version: facts.schema_version,
        idempotency_key: "idem_legacy_provider_proof",
        expected_resource_version: facts.expected_resource_version,
        invitation_digest: digest(facts.invitation_secret),
        authentication: {
          kind: "email_password", client_kind: "web",
          callback_proof_digest: digest(JSON.stringify({
            kind: "email_password", client_kind: "web", verification_proof: "provider-access-token",
          })),
        },
        device_label: facts.device_label,
      }),
    },
  });
  assert.equal(forbidden.statusCode, 400, forbidden.body);
  assert.equal(calls.length, callsBeforeForbidden, "legacy provider proof is rejected before rate, Session, provider, or database effects");
  assert.equal(JSON.stringify(calls).includes("provider-access-token"), false);
  await app.close();
});

test("protected company and invitation writes reject malformed or changed public hashes before authority effects", async () => {
  const cases = [
    ["/auth/v1/companies", {
      schema_version: 1, idempotency_key: "hash-company-create", display_name: "Hash Company",
      administrator_email: "admin@hash-company.test",
    }],
    ["/auth/v1/companies/members", {
      schema_version: 1, idempotency_key: "hash-company-invite", tenant_id: "tenant_hash",
      email: "member@hash-company.test", role: "consultant",
    }],
    ["/auth/v1/companies/members/consultant/grant", {
      schema_version: 1, idempotency_key: "hash-consultant-grant", membership_id: "membership_hash",
      expected_membership_resource_version: 1, grant_mode: "create_profile",
    }],
    ["/auth/v1/companies/members/consultant/remove", {
      schema_version: 1, idempotency_key: "hash-consultant-remove", membership_id: "membership_hash",
      expected_membership_resource_version: 2, profile_id: "profile_hash", expected_profile_resource_version: 1,
    }],
    ["/auth/v1/companies/members/suspend", {
      schema_version: 1, idempotency_key: "hash-member-suspend", membership_id: "membership_hash",
      expected_resource_version: 1, reason_code: "administrator_suspended",
    }],
    ["/auth/v1/companies/members/revoke", {
      schema_version: 1, idempotency_key: "hash-member-revoke", membership_id: "membership_hash",
      expected_resource_version: 1, reason_code: "administrator_revoked",
    }],
    ["/auth/v1/invitations/revoke", {
      schema_version: 1, idempotency_key: "hash-invitation-revoke", invitation_id: "invitation_hash",
      expected_resource_version: 1, reason_code: "administrator_revoked",
    }],
  ] as const;
  for (const [url, facts] of cases) {
    for (const payloadHash of [`sha256:${"f".repeat(64)}`, "not-a-payload-hash"]) {
      const calls: Array<{ name: string; input: unknown }> = [];
      const app = await buildApp(calls);
      const response = await app.inject({
        method: "POST", url,
        headers: {
          host, origin, "content-type": "application/json", "x-core-agent-csrf": csrf,
          cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`,
        },
        payload: { ...facts, payload_hash: payloadHash },
      });
      assert.equal(response.statusCode, 400, `${url}: ${response.body}`);
      assert.deepEqual(calls, [], `${url} must reject before Session or durable authority effects`);
      await app.close();
    }
  }
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
  const response = await app.inject({ method: "POST", url: "/auth/v1/email/sign-in", headers: { host, origin, "content-type": "application/json" }, payload: emailSignInPayload({ schema_version: 1, idempotency_key: idem.idempotency_key, email: "student@example.test", password: "correct-horse", client_kind: "web" }) });
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
  assert.deepEqual(calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => {
    const rate = input as { dimensions?: unknown; accountIdentifier?: unknown };
    return [rate.dimensions, rate.accountIdentifier];
  }), [["client", "route:apple_link:web"], ["account", "actor_server"]]);
  assert.equal("accessToken" in providerInput, false);
  assert.equal("provider_proof" in providerInput, false);
  const flowCookie = ([] as string[]).concat(response.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_apple_flow="));
  assert.match(flowCookie ?? "", /Max-Age=2100/u);
  const { readAppleFlowCookie } = await import("../src/security.js");
  assert.equal(readAppleFlowCookie(
    Buffer.alloc(32, 0x34), flowCookie!.split(";", 1)[0]!.split("=", 2)[1]!,
    new Date("2026-08-17T00:06:00.000Z"),
  ).settlementNotAfter, "2026-08-17T00:35:00.000Z");
  await app.close();
});

test("Apple link callback consumes its independent callback rate limit before provider effect", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const response = await app.inject({
    method: "POST", url: "/auth/v1/apple/link/callback",
    headers: { host, "content-type": "application/json", authorization: `Bearer ${secret}` },
    payload: appleCallbackPayload("apple_link", { schema_version: 1, idempotency_key: idem.idempotency_key, client_kind: "iphone", transaction_id: "oauth_link", authorization_code: "opaque-code", state: "state-link", nonce: "nonce-link", pkce_code_verifier: "v".repeat(43) }),
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(({ name }) => name), [
    "consumeRateLimit", "authenticateSession", "consumeRateLimit", "requireRecentReauthentication",
    "linkApple", "readAppleLinkSettlement", "executeProtectedAuthorityCommand",
  ]);
  const rate = calls[0]?.input as Record<string, unknown>;
  assert.equal(rate.bucketKind, "apple_callback");
  assert.equal(rate.dimensions, "client");
  assert.deepEqual(calls.filter(({ name }) => name === "consumeRateLimit").map(({ input }) => {
    const value = input as { dimensions?: unknown; accountIdentifier?: unknown };
    return [value.dimensions, value.accountIdentifier];
  }), [["client", "route:apple_link_callback"], ["account", "actor_server"]]);
  const durable = calls.at(-1)?.input as { payload?: unknown };
  assert.deepEqual(durable.payload, {
    schema_version: 1, idempotency_key: idem.idempotency_key,
    payload_hash: (calls.find(({ name }) => name === "linkApple")?.input as { payload_hash: string }).payload_hash,
    transaction_id: "oauth_link",
  });
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

test("Apple invitation proof hashing is canonical and rejects non-closed proof objects before effects", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const start = await app.inject({
    method: "POST", url: "/auth/v1/apple/start",
    headers: { host, origin, "content-type": "application/json" },
    payload: { ...idem, idempotency_key: "idem_canonical_invitation_start", client_kind: "web", redirect_uri: redirect },
  });
  const flowCookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
    .find((value) => value.startsWith("core_agent_apple_flow="))?.split(";", 1)[0];
  const state = new URL(start.json().authorization_url).searchParams.get("state")!;
  calls.length = 0;
  const reorderedProof = {
    state,
    authorization_code: "opaque_canonical_code",
    transaction_id: "oauth_01",
    client_kind: "web",
    kind: "apple",
  };
  const payload = invitationAcceptancePayload({
    schema_version: 1, idempotency_key: "idem_canonical_invitation_accept", expected_resource_version: 1,
    invitation_secret: "i".repeat(43), authentication_proof: reorderedProof,
  });
  const canonicalOrderPayload = invitationAcceptancePayload({
    schema_version: 1, idempotency_key: "idem_canonical_invitation_accept", expected_resource_version: 1,
    invitation_secret: "i".repeat(43),
    authentication_proof: {
      kind: "apple", client_kind: "web", transaction_id: "oauth_01",
      authorization_code: "opaque_canonical_code", state,
    },
  });
  assert.equal(payload.payload_hash, canonicalOrderPayload.payload_hash);
  assert.doesNotThrow(() => assertInvitationAcceptancePayloadHash(payload));
  assert.doesNotThrow(() => assertInvitationAcceptancePayloadHash(canonicalOrderPayload));
  const accepted = await app.inject({
    method: "POST", url: "/auth/v1/invitations/accept",
    headers: { host, origin, "content-type": "application/json", cookie: flowCookie! }, payload,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(calls.some(({ name }) => name === "completeApple"), true);
  calls.length = 0;
  for (const invalidProof of [
    { ...reorderedProof, attacker_controlled: "extra" },
    { kind: "apple", client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_canonical_code" },
  ]) {
    const invalid = await app.inject({
      method: "POST", url: "/auth/v1/invitations/accept",
      headers: { host, origin, "content-type": "application/json", cookie: flowCookie! },
      payload: { ...payload, authentication_proof: invalidProof },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.deepEqual(calls, []);
  await app.close();
});

test("Apple invitation proof preflight matches the exact 4096-character OAuth bounds", () => {
  for (const proofLength of [2_049, 4_096]) {
    const proofValue = "o".repeat(proofLength);
    const webProof = {
      kind: "apple", client_kind: "web", transaction_id: "oauth_boundary",
      authorization_code: proofValue, state: proofValue,
    };
    const reorderedWebProof = {
      state: proofValue, authorization_code: proofValue,
      transaction_id: "oauth_boundary", client_kind: "web", kind: "apple",
    };
    const webPayload = invitationAcceptancePayload({
      schema_version: 1, idempotency_key: `idem_web_boundary_${proofLength}`,
      expected_resource_version: 1, invitation_secret: "i".repeat(43),
      authentication_proof: webProof,
    });
    const reorderedWebPayload = invitationAcceptancePayload({
      schema_version: 1, idempotency_key: `idem_web_boundary_${proofLength}`,
      expected_resource_version: 1, invitation_secret: "i".repeat(43),
      authentication_proof: reorderedWebProof,
    });
    assert.equal(webPayload.payload_hash, reorderedWebPayload.payload_hash);
    assert.doesNotThrow(() => assertInvitationAcceptancePayloadHash(webPayload));
    assert.doesNotThrow(() => assertInvitationAcceptancePayloadHash(reorderedWebPayload));

    const nativePayload = invitationAcceptancePayload({
      schema_version: 1, idempotency_key: `idem_native_boundary_${proofLength}`,
      expected_resource_version: 1, invitation_secret: "i".repeat(43),
      authentication_proof: {
        kind: "apple", client_kind: "macos", transaction_id: "oauth_boundary",
        authorization_code: proofValue, state: proofValue, nonce: proofValue,
        pkce_code_verifier: "v".repeat(43),
      },
    });
    assert.doesNotThrow(() => assertInvitationAcceptancePayloadHash(nativePayload));
  }

  const unicodeProof = "😀".repeat(4_096);
  const unicodePayload = invitationAcceptancePayload({
    schema_version: 1, idempotency_key: "idem_native_unicode_boundary",
    expected_resource_version: 1, invitation_secret: "i".repeat(43),
    authentication_proof: {
      kind: "apple", client_kind: "iphone", transaction_id: "oauth_boundary",
      authorization_code: unicodeProof, state: unicodeProof, nonce: unicodeProof,
      pkce_code_verifier: "v".repeat(43),
    },
  });
  assert.doesNotThrow(() => assertInvitationAcceptancePayloadHash(unicodePayload));

  const oversized = "o".repeat(4_097);
  for (const authenticationProof of [
    { kind: "apple", client_kind: "web", transaction_id: "oauth_boundary", authorization_code: oversized, state: "opaque_state" },
    { kind: "apple", client_kind: "web", transaction_id: "oauth_boundary", authorization_code: "opaque_code", state: oversized },
    { kind: "apple", client_kind: "iphone", transaction_id: "oauth_boundary", authorization_code: "opaque_code", state: "opaque_state", nonce: oversized, pkce_code_verifier: "v".repeat(43) },
  ]) {
    const payload = invitationAcceptancePayload({
      schema_version: 1, idempotency_key: "idem_oversized_oauth_proof",
      expected_resource_version: 1, invitation_secret: "i".repeat(43), authentication_proof: authenticationProof,
    });
    assert.throws(() => assertInvitationAcceptancePayloadHash(payload), /INVALID_REQUEST/u);
  }
  const oversizedUnicodePayload = invitationAcceptancePayload({
    schema_version: 1, idempotency_key: "idem_oversized_unicode_oauth_proof",
    expected_resource_version: 1, invitation_secret: "i".repeat(43),
    authentication_proof: {
      kind: "apple", client_kind: "web", transaction_id: "oauth_boundary",
      authorization_code: "opaque_code", state: "😀".repeat(4_097),
    },
  });
  assert.throws(() => assertInvitationAcceptancePayloadHash(oversizedUnicodePayload), /INVALID_REQUEST/u);
});

test("native Apple route families accept Unicode OAuth proofs and RFC 7636 verifier lengths", async () => {
  const unicodeProof = "😀".repeat(4_096);
  const nativeRedirect = "coreagent://auth/apple/callback";

  for (const [url, extra] of [
    ["/auth/v1/apple/start", {}],
    ["/auth/v1/apple/link/start", { password: "correct-horse" }],
  ] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls);
    const response = await app.inject({
      method: "POST", url,
      headers: {
        host, "content-type": "application/json",
        ...(url.includes("/link/") ? { authorization: `Bearer ${secret}` } : {}),
      },
      payload: {
        ...idem, ...extra, client_kind: "iphone", redirect_uri: nativeRedirect,
        nonce: unicodeProof, pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256",
      },
    });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.equal(calls.some(({ name }) => name === (url.includes("/link/")
      ? "reauthenticateAndBeginAppleLink" : "beginApple")), true);
    await app.close();
  }

  for (const [url, verifierLength] of [
    ["/auth/v1/apple/callback", 44],
    ["/auth/v1/apple/link/callback", 128],
  ] as const) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls);
    const facts = {
      schema_version: 1 as const,
      idempotency_key: `idem_native_route_${verifierLength}`,
      client_kind: "iphone" as const,
      transaction_id: url.includes("/link/") ? "oauth_link" : "oauth_native",
      authorization_code: "opaque-native-authorization-code",
      state: unicodeProof,
      nonce: unicodeProof,
      pkce_code_verifier: "v".repeat(verifierLength),
    };
    const response = await app.inject({
      method: "POST", url,
      headers: {
        host, "content-type": "application/json",
        ...(url.includes("/link/") ? { authorization: `Bearer ${secret}` } : {}),
      },
      payload: appleCallbackPayload(url.includes("/link/") ? "apple_link" : "apple_sign_in", facts),
    });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    assert.equal(calls.some(({ name }) => name === (url.includes("/link/") ? "linkApple" : "completeApple")), true);
    await app.close();
  }

  const invitationCalls: Array<{ name: string; input: unknown }> = [];
  const invitationApp = await buildApp(invitationCalls, { invitationSessionClientKind: "macos" });
  const invitation = await invitationApp.inject({
    method: "POST", url: "/auth/v1/invitations/accept",
    headers: { host, "content-type": "application/json" },
    payload: invitationAcceptancePayload({
      schema_version: 1, idempotency_key: "idem_native_invitation_boundary",
      expected_resource_version: 1, invitation_secret: "i".repeat(43),
      authentication_proof: {
        kind: "apple", client_kind: "macos", transaction_id: "oauth_invitation_native",
        authorization_code: unicodeProof, state: unicodeProof, nonce: unicodeProof,
        pkce_code_verifier: "v".repeat(44),
      },
    }),
  });
  assert.equal(invitation.statusCode, 200, invitation.body);
  assert.equal(invitationCalls.some(({ name }) => name === "completeApple"), true);
  await invitationApp.close();

  for (const invalidVerifier of ["v".repeat(42), "v".repeat(129), `${"v".repeat(42)}!`]) {
    const calls: Array<{ name: string; input: unknown }> = [];
    const app = await buildApp(calls);
    const facts = {
      schema_version: 1 as const, idempotency_key: "idem_invalid_verifier_route", client_kind: "iphone" as const,
      transaction_id: "oauth_invalid_verifier", authorization_code: "opaque-native-authorization-code",
      state: "opaque-native-state", nonce: "opaque-native-nonce", pkce_code_verifier: invalidVerifier,
    };
    const response = await app.inject({
      method: "POST", url: "/auth/v1/apple/callback",
      headers: { host, "content-type": "application/json" },
      payload: appleCallbackPayload("apple_sign_in", facts),
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(calls.some(({ name }) => name === "completeApple"), false);
    await app.close();
  }
});

test("management mutation delegates one transaction-scoped reauth plus durable command", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const facts = {
    schema_version: 1 as const, idempotency_key: idem.idempotency_key,
    expected_resource_version: 1, invitation_id: "invitation_01", reason_code: "administrator_revoked",
  };
  const response = await app.inject({
    method: "POST",
    url: "/auth/v1/invitations/revoke",
    headers: { host, origin, "content-type": "application/json", cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`, "x-core-agent-csrf": csrf },
    payload: { ...facts, payload_hash: canonicalPayloadHash(facts) },
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

test("durable commands receive server authority but never passwords or provider proofs", async () => {
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
  const acceptance = await app.inject({
    method: "POST",
    url: "/auth/v1/invitations/accept",
    headers,
    payload: invitationAcceptancePayload({
      schema_version: 1,
      idempotency_key: idem.idempotency_key,
      expected_resource_version: 1,
      invitation_secret: "i".repeat(43),
      client_kind: "web",
      device_label: "Invitation Browser",
    }),
  });
  assert.equal(acceptance.statusCode, 200);
  const acceptanceCommand = calls.find(({ name, input }) => name === "executeAuthorityCommand" && (input as { kind?: unknown }).kind === "invitation_accept")?.input as { payload?: unknown; verifiedSubject?: unknown };
  assert.equal(acceptanceCommand.verifiedSubject, undefined);
  assert.equal((acceptanceCommand as { authority?: { actorId?: unknown } }).authority?.actorId, "actor_server");
  assert.equal(calls.some(({ name }) => name === "issueSession"), false,
    "acceptance and its one-time Session secret must be one atomic authority operation");
  assert.equal(acceptance.json().issuedSession, undefined);
  await app.close();
});

test("account deletion validates commands before authority and cancellation uses only deletion recovery authority", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls);
  const headers = {
    host, origin, "content-type": "application/json",
    cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`,
    "x-core-agent-csrf": csrf,
  };
  const requestFacts = {
    schema_version: 1 as const, idempotency_key: "idem_deletion_request",
    expected_resource_version: 1, reason_code: "user_requested" as const,
  };
  const malformed = await app.inject({
    method: "POST", url: "/auth/v1/account/deletion/request", headers,
    payload: { ...requestFacts, payload_hash: canonicalPayloadHash({ ...requestFacts, reason_code: "changed" }) },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(calls.length, 0, "invalid public hash must fail before Session authority");

  const requested = await app.inject({
    method: "POST", url: "/auth/v1/account/deletion/request", headers,
    payload: { ...requestFacts, payload_hash: canonicalPayloadHash(requestFacts) },
  });
  assert.equal(requested.statusCode, 200, requested.body);
  assert.deepEqual(calls.map(({ name }) => name), ["authenticateSession", "executeProtectedAuthorityCommand"]);

  calls.length = 0;
  const cancelFacts = {
    schema_version: 1 as const, idempotency_key: "idem_deletion_cancel",
    expected_resource_version: 1, account_deletion_id: "deletion_01",
  };
  const cancelled = await app.inject({
    method: "POST", url: "/auth/v1/account/deletion/cancel", headers,
    payload: { ...cancelFacts, payload_hash: canonicalPayloadHash(cancelFacts) },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual(calls.map(({ name }) => name), [
    "authenticateDeletionRecoverySession", "executeAuthorityCommand",
  ]);
  assert.equal((calls[1]?.input as { authority?: { deletionRecovery?: unknown } }).authority?.deletionRecovery, true);
  await app.close();
});

test("password reauthentication can recover only through the deletion-revoked Session boundary", async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const app = await buildApp(calls, { failAuthentication: true });
  const facts = {
    schema_version: 1 as const, idempotency_key: "idem_deletion_reauth",
    expected_resource_version: 1,
    reauthentication_proof_digest: digest("correct-horse"),
  };
  const response = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate",
    headers: {
      host, origin, "content-type": "application/json",
      cookie: `core_agent_session=${secret}; core_agent_csrf=${csrf}`,
      "x-core-agent-csrf": csrf,
    },
    payload: {
      schema_version: facts.schema_version, idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version, password: "correct-horse",
      payload_hash: canonicalPayloadHash(facts),
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(calls.some(({ name }) => name === "authenticateDeletionRecoverySession"), true);
  const command = calls.find(({ name }) => name === "executeAuthorityCommand")?.input as {
    authority?: { deletionRecovery?: unknown };
  };
  assert.equal(command.authority?.deletionRecovery, true);
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
