import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyMigrations,
  canonicalEmailVerificationStartPayloadHash,
  canonicalPayloadHash,
  createRuntimeDatabase,
  issueCoreSession,
} from "@core-agent/runtime-core";
import { Pool } from "pg";

import { buildIdentityGatewayApp } from "../../src/app.js";
import {
  canonicalProviderStartPayloadHash,
  type AuthProviderAdapter,
  type VerifiedProviderSubject,
} from "../../src/providers/auth-provider.js";
import { ProviderFailure } from "../../src/providers/provider-errors.js";
import { SupabaseAuthProvider, type SupabaseClientFactory } from "../../src/providers/supabase-auth-provider.js";
import { sealRecoveryCookie } from "../../src/security.js";
import { buildProductionIdentityGateway, identityGatewayServerTestInternals } from "../../src/server.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/runtime-core/migrations");

function sensitiveDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function emailVerificationRequest(facts: {
  readonly schema_version: 1; readonly idempotency_key: string;
  readonly verification_id: string; readonly verification_code: string;
}) {
  return { ...facts, payload_hash: canonicalPayloadHash(facts) };
}

function invitationAcceptanceHash(facts: {
  readonly schema_version: 1; readonly idempotency_key: string; readonly expected_resource_version: number;
  readonly invitation_secret: string; readonly device_label?: string;
  readonly authentication_proof: { readonly kind: "email_password"; readonly client_kind: "web"; readonly verification_proof: string };
}): string {
  return canonicalPayloadHash({
    schema_version: facts.schema_version,
    idempotency_key: facts.idempotency_key,
    expected_resource_version: facts.expected_resource_version,
    invitation_digest: sensitiveDigest(facts.invitation_secret),
    authentication_proof: {
      kind: facts.authentication_proof.kind,
      client_kind: facts.authentication_proof.client_kind,
      verification_proof_digest: sensitiveDigest(facts.authentication_proof.verification_proof),
    },
    ...(facts.device_label === undefined ? {} : { device_label: facts.device_label }),
  });
}

function appleInvitationAcceptancePayload<T extends {
  readonly schema_version: 1; readonly idempotency_key: string; readonly expected_resource_version: number;
  readonly invitation_secret: string; readonly device_label?: string;
  readonly authentication_proof: Record<string, unknown>;
}>(facts: T): T & { readonly payload_hash: string } {
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version,
      invitation_digest: sensitiveDigest(facts.invitation_secret),
      authentication_proof: {
        kind: facts.authentication_proof.kind,
        client_kind: facts.authentication_proof.client_kind,
        callback_proof_digest: sensitiveDigest(JSON.stringify(facts.authentication_proof)),
      },
      ...(facts.device_label === undefined ? {} : { device_label: facts.device_label }),
    }),
  };
}

function reauthenticationRequest(facts: {
  readonly schema_version: 1; readonly idempotency_key: string;
  readonly expected_resource_version: number; readonly password: string;
  readonly client_kind?: "iphone" | "macos";
}) {
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version,
      ...(facts.client_kind === undefined ? {} : { client_kind: facts.client_kind }),
      reauthentication_proof_digest: sensitiveDigest(facts.password),
    }),
  };
}

async function waitForBlockedLocks(pool: Pool, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = Number((await pool.query(
      "select count(*)::int as count from pg_stat_activity where datname = current_database() and cardinality(pg_blocking_pids(pid)) > 0",
    )).rows[0]?.count);
    if (blocked >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${minimum} blocked PostgreSQL locks`);
}

test("production composition atomically verifies email, registers Task 3, issues Task 6, and protects Task 4", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createRuntimeDatabase(pool);
  await pool.query("drop schema public cascade; create schema public");
  await applyMigrations(pool, migrations);
  const key = Buffer.alloc(32, 0x5a);
  const protector = identityGatewayServerTestInternals.aesProtector(key, "composition-private-pii");
  const oauthProtector = identityGatewayServerTestInternals.aesProtector(key, "composition-oauth-transaction");
  const operations = identityGatewayServerTestInternals.productionOperations(db, key, protector, oauthProtector);
  try {
    const providerStarts = identityGatewayServerTestInternals.oauthStore(db);
    const providerStartRecord = {
      oauth_transaction_id: "oauth_composition_idempotent_start", provider: "supabase" as const,
      flow_kind: "apple_sign_in" as const, actor_id: null, client_kind: "web" as const,
      state_digest: Buffer.alloc(32, 0x11), nonce_digest: Buffer.alloc(32, 0x22),
      pkce_verifier_ciphertext: Buffer.alloc(33, 0x33),
      redirect_uri: "https://app.example.test/auth/apple/callback", status: "pending" as const,
      expires_at: new Date(Date.now() + 5 * 60 * 1_000).toISOString(),
    };
    assert.equal(await providerStarts.reserveStart!(providerStartRecord), true);
    assert.equal(await providerStarts.reserveStart!(providerStartRecord), false);
    await providerStarts.completeStart!({ ...providerStartRecord, pkce_verifier_ciphertext: Buffer.alloc(34, 0x44) });
    assert.equal((await providerStarts.loadStart!(providerStartRecord.oauth_transaction_id))?.pkce_verifier_ciphertext.byteLength, 34);

    const begun = await operations.beginEmailVerification({
      idempotencyKey: "composition-email-start",
      payloadHash: canonicalEmailVerificationStartPayloadHash({
        idempotencyKey: "composition-email-start", normalizedEmail: "composition@example.test",
        clientKind: "web", deviceLabel: "Composition Browser", flowKind: "b2c",
      }),
      normalizedEmail: "composition@example.test", clientKind: "web", deviceLabel: "Composition Browser",
    });
    await operations.finalizeEmailVerificationStart({
      verificationId: begun.verificationId, outcome: "finalized",
      expectedProviderSubject: "composition-provider-subject",
    });
    assert.equal((await operations.admitEmailVerificationProviderAttempt({
      verificationId: begun.verificationId,
      verificationProofDigest: `sha256:${"d".repeat(64)}`,
    })).kind, "started");
    const providerConfirmedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    const verifiedSubject = {
      provider: "supabase" as const, providerSubject: "composition-provider-subject",
      identityKind: "email_password" as const, normalizedEmail: "composition@example.test",
      verifiedAt: providerConfirmedAt.toISOString(),
    };
    const sessionIdempotency = {
      idempotencyKey: "composition-session-issue", payloadHash: `sha256:${"c".repeat(64)}`,
      operation: "email_verification" as const,
    };
    await operations.checkpointEmailVerification({ verificationId: begun.verificationId, verifiedSubject });
    const registered = await operations.completeEmailVerification({
      verificationId: begun.verificationId,
      idempotencyKey: sessionIdempotency.idempotencyKey,
      payloadHash: sessionIdempotency.payloadHash,
    });
    const issued = registered.issuedSession;
    assert.equal(typeof issued.csrfSecret, "string");
    const authority = await operations.authenticateSession({ sessionSecret: issued.sessionSecret, csrfSecret: issued.csrfSecret!, requireCsrf: true });
    assert.equal(authority.actorId, registered.actorId);
    assert.equal(issued.session.client_kind, "web");
    await assert.rejects(operations.executeAuthorityCommand({
      kind: "session_inspect", authority,
      payload: { schema_version: 1, session_id: "session_not_owned_by_authority" },
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "RESOURCE_NOT_FOUND");
    assert.equal((await pool.query("select status from email_verification_transactions where email_verification_transaction_id = $1", [begun.verificationId])).rows[0]?.status, "consumed");
    assert.equal((await pool.query("select count(*)::int as count from auth_subjects where actor_id = $1", [registered.actorId])).rows[0]?.count, 1);
    await assert.rejects(operations.completeEmailVerification({
      verificationId: begun.verificationId,
      idempotencyKey: sessionIdempotency.idempotencyKey,
      payloadHash: sessionIdempotency.payloadHash,
    }), /IDEMPOTENCY_CONFLICT/u);
    assert.equal((await pool.query("select count(*)::int as count from core_sessions where actor_id = $1", [registered.actorId])).rows[0]?.count, 1);

    let nativePasswordCalls = 0;
    let nativeLinkStartCalls = 0;
    let existingAppleStarts = 0;
    const nativeProvider: AuthProviderAdapter = {
      async reauthenticatePassword(input) {
        nativePasswordCalls += 1;
        assert.equal(input.email, verifiedSubject.normalizedEmail);
        assert.equal(input.password, "native-current-password");
        return verifiedSubject;
      },
      async reauthenticateAndBeginAppleLink(input) {
        nativeLinkStartCalls += 1;
        return {
          transaction_id: `native-link-${input.client_kind}`,
          authorization_url: `https://provider.example.test/auth/v1/authorize?state=native-link-state&redirect_to=${encodeURIComponent(input.redirect_uri)}`,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
      },
      signUpEmail: async () => { throw new Error("unused provider method"); },
      recoverVerifiedEmailSubject: async () => { throw new Error("unused provider method"); },
      verifyEmail: async () => { throw new Error("unused provider method"); },
      async signInEmail() { return verifiedSubject; },
      async beginApple() {
        existingAppleStarts += 1;
        return {
          transaction_id: `composition-existing-apple-${existingAppleStarts}`,
          authorization_url: "https://provider.example.test/auth/v1/authorize?state=composition-existing-apple-state&redirect_to=https%3A%2F%2Fapp.example.test%2Fauth%2Fapple%2Fcallback",
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
      },
      async completeApple() { return { ...verifiedSubject, identityKind: "apple" }; },
      verifyCurrentSubject: async () => { throw new Error("unused provider method"); },
      beginPasswordReset: async () => { throw new Error("unused provider method"); },
      completePasswordReset: async () => { throw new Error("unused provider method"); },
      async linkApple(input) {
        assert.equal(input.authenticatedActorId, registered.actorId);
        return { ...verifiedSubject, identityKind: "apple" };
      },
      revokeCurrentProviderSession: async () => { throw new Error("unused provider method"); },
      deleteProviderSubject: async () => { throw new Error("unused provider method"); },
    };
    const nativeApp = await buildIdentityGatewayApp({
      config: {
        publicOrigins: new Set(["https://app.example.test"]), cookieHost: "identity.example.test",
        publicBaseUrl: "https://identity.example.test", providerUrl: "https://provider.example.test",
        appleWebRedirectUris: new Set(["https://app.example.test/auth/apple/callback"]),
        appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]),
        passwordResetRedirectUri: "https://app.example.test/auth/password/reset/callback",
        publicAuthEnabled: true,
      },
      flowCookieKey: key,
      provider: nativeProvider,
      operations,
    });
    const appleSignIn = async (idempotencyKey: string) => {
      const start = await nativeApp.inject({
        method: "POST", url: "/auth/v1/apple/start",
        headers: { host: "identity.example.test", origin: "https://app.example.test", "content-type": "application/json" },
        payload: {
          schema_version: 1, idempotency_key: `${idempotencyKey}-start`, payload_hash: `sha256:${"1".repeat(64)}`,
          client_kind: "web", redirect_uri: "https://app.example.test/auth/apple/callback",
        },
      });
      assert.equal(start.statusCode, 200, start.body);
      const cookie = ([] as string[]).concat(start.headers["set-cookie"] ?? [])
        .find((value) => value.startsWith("core_agent_apple_flow="))!.split(";", 1)[0]!;
      return nativeApp.inject({
        method: "POST", url: "/auth/v1/apple/callback",
        headers: { host: "identity.example.test", origin: "https://app.example.test", "content-type": "application/json", cookie },
        payload: {
          schema_version: 1, idempotency_key: `${idempotencyKey}-callback`, payload_hash: `sha256:${"2".repeat(64)}`,
          client_kind: "web", transaction_id: `composition-existing-apple-${existingAppleStarts}`,
          authorization_code: "composition-existing-apple-code", state: "composition-existing-apple-state",
        },
      });
    };
    const appleBeforeLink = await appleSignIn("composition-apple-before-link");
    assert.equal(appleBeforeLink.statusCode, 401, appleBeforeLink.body);
    assert.equal((await pool.query("select count(*)::int as count from core_sessions where actor_id = $1", [registered.actorId])).rows[0]?.count, 1);
    const webAsNative = await nativeApp.inject({
      method: "POST", url: "/auth/v1/reauthenticate",
      headers: {
        host: "identity.example.test", authorization: `Bearer ${issued.sessionSecret}`,
        "content-type": "application/json",
      },
      payload: reauthenticationRequest({
        schema_version: 1, idempotency_key: "composition-web-secret-as-native",
        expected_resource_version: Number(issued.session.session_resource_version),
        password: "native-current-password", client_kind: "iphone",
      }),
    });
    assert.equal(webAsNative.statusCode, 401, webAsNative.body);
    assert.equal(nativePasswordCalls, 0);
    for (const clientKind of ["iphone", "macos"] as const) {
      const nativeSession = await issueCoreSession({ db }, {
        sessionId: `session_composition_native_${clientKind}`, actorId: registered.actorId,
        authSubjectId: registered.authSubjectId, clientKind,
      });
      const mismatchKind = clientKind === "iphone" ? "macos" as const : "iphone" as const;
      const mismatched = await nativeApp.inject({
        method: "POST", url: "/auth/v1/reauthenticate",
        headers: {
          host: "identity.example.test", authorization: `Bearer ${nativeSession.sessionSecret}`,
          "content-type": "application/json",
        },
        payload: reauthenticationRequest({
          schema_version: 1, idempotency_key: `composition-native-mismatch-${clientKind}`,
          expected_resource_version: 1, password: "native-current-password", client_kind: mismatchKind,
        }),
      });
      assert.equal(mismatched.statusCode, 401, mismatched.body);
      assert.equal(nativePasswordCalls, clientKind === "iphone" ? 0 : 1);
      const reauthentication = await nativeApp.inject({
        method: "POST", url: "/auth/v1/reauthenticate",
        headers: {
          host: "identity.example.test", authorization: `Bearer ${nativeSession.sessionSecret}`,
          "content-type": "application/json",
        },
        payload: reauthenticationRequest({
          schema_version: 1, idempotency_key: `composition-native-reauth-${clientKind}`,
          expected_resource_version: 1, password: "native-current-password", client_kind: clientKind,
        }),
      });
      assert.equal(reauthentication.statusCode, 200, reauthentication.body);
      assert.equal(nativePasswordCalls, clientKind === "iphone" ? 1 : 2);
      const mismatchedLink = await nativeApp.inject({
        method: "POST", url: "/auth/v1/apple/link/start",
        headers: {
          host: "identity.example.test", authorization: `Bearer ${nativeSession.sessionSecret}`,
          "content-type": "application/json",
        },
        payload: {
          schema_version: 1, idempotency_key: `composition-native-link-mismatch-${clientKind}`,
          payload_hash: `sha256:${"8".repeat(64)}`, client_kind: mismatchKind,
          redirect_uri: "coreagent://auth/apple/callback", password: "native-current-password",
          nonce: "native-link-mismatch-nonce", pkce_code_challenge: "q".repeat(43),
          pkce_code_challenge_method: "S256",
        },
      });
      assert.equal(mismatchedLink.statusCode, 401, mismatchedLink.body);
      assert.equal(nativeLinkStartCalls, clientKind === "iphone" ? 0 : 1);
      const link = await nativeApp.inject({
        method: "POST", url: "/auth/v1/apple/link/start",
        headers: {
          host: "identity.example.test", authorization: `Bearer ${nativeSession.sessionSecret}`,
          "content-type": "application/json",
        },
        payload: {
          schema_version: 1, idempotency_key: `composition-native-link-${clientKind}`,
          payload_hash: `sha256:${"9".repeat(64)}`, client_kind: clientKind,
          redirect_uri: "coreagent://auth/apple/callback", password: "native-current-password",
          nonce: "native-link-nonce", pkce_code_challenge: "p".repeat(43),
          pkce_code_challenge_method: "S256",
        },
      });
      assert.equal(link.statusCode, 200, link.body);
      assert.equal(link.headers["set-cookie"], undefined);
      assert.equal(nativeLinkStartCalls, clientKind === "iphone" ? 1 : 2);
      if (clientKind === "iphone") {
        const callback = await nativeApp.inject({
          method: "POST", url: "/auth/v1/apple/link/callback",
          headers: {
            host: "identity.example.test", authorization: `Bearer ${nativeSession.sessionSecret}`,
            "content-type": "application/json",
          },
          payload: {
            schema_version: 1, idempotency_key: "composition-native-link-callback-iphone",
            payload_hash: `sha256:${"a".repeat(64)}`, client_kind: "iphone",
            transaction_id: "native-link-iphone", authorization_code: "composition-link-code",
            state: "native-link-state", nonce: "composition-link-nonce",
            pkce_code_verifier: "x".repeat(43),
          },
        });
        assert.equal(callback.statusCode, 200, callback.body);
        assert.equal(callback.json().auth_subject_id, registered.authSubjectId);
        assert.deepEqual((await pool.query(
          "select count(*)::int as count, min(provider_identity_kind) as provider_identity_kind from auth_subjects where actor_id = $1",
          [registered.actorId],
        )).rows[0], { count: 1, provider_identity_kind: "email_password_apple" });
      }
    }
    const appleAfterLink = await appleSignIn("composition-apple-after-link");
    assert.equal(appleAfterLink.statusCode, 200, appleAfterLink.body);
    const passwordAfterLink = await nativeApp.inject({
      method: "POST", url: "/auth/v1/email/sign-in",
      headers: { host: "identity.example.test", origin: "https://app.example.test", "content-type": "application/json" },
      payload: {
        schema_version: 1, idempotency_key: "composition-password-after-link", payload_hash: `sha256:${"3".repeat(64)}`,
        email: verifiedSubject.normalizedEmail, password: "composition-password", client_kind: "web",
      },
    });
    assert.equal(passwordAfterLink.statusCode, 200, passwordAfterLink.body);
    await nativeApp.close();

    const reauthenticationPayload = {
      schema_version: 1 as const,
      idempotency_key: "composition-reauthentication",
      expected_resource_version: Number(authority.session.session_resource_version),
      reauthentication_proof_digest: sensitiveDigest("direct-operation-proof"),
    };
    const reauthenticationCommand = {
      ...reauthenticationPayload,
      payload_hash: canonicalPayloadHash(reauthenticationPayload),
    };
    const reauthenticated = await operations.executeAuthorityCommand({
      kind: "reauthenticate", authority, verifiedSubject, payload: reauthenticationCommand,
    });
    const reauthenticationReplay = await operations.executeAuthorityCommand({
      kind: "reauthenticate", authority, verifiedSubject, payload: reauthenticationCommand,
    });
    assert.deepEqual(reauthenticationReplay, reauthenticated);
    await assert.rejects(operations.executeAuthorityCommand({
      kind: "reauthenticate", authority, verifiedSubject,
      payload: { ...reauthenticationCommand, expected_resource_version: reauthenticationPayload.expected_resource_version + 1 },
    }), /INVALID_REQUEST|IDEMPOTENCY_CONFLICT/u);

    const concurrentReauthenticationSession = await issueCoreSession({ db }, {
      sessionId: "session_composition_concurrent_reauthentication", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "web",
    });
    const concurrentReauthenticationAuthority = await operations.authenticateSession({
      sessionSecret: concurrentReauthenticationSession.sessionSecret,
      csrfSecret: concurrentReauthenticationSession.csrfSecret!, requireCsrf: true,
    });
    const concurrentReauthenticationPayload = {
      schema_version: 1 as const, idempotency_key: "composition-concurrent-reauthentication",
      expected_resource_version: 1,
      reauthentication_proof_digest: sensitiveDigest("direct-concurrent-proof"),
    };
    const concurrentReauthenticationCommand = {
      ...concurrentReauthenticationPayload,
      payload_hash: canonicalPayloadHash(concurrentReauthenticationPayload),
    };
    const concurrentReauthentication = await Promise.all([
      operations.executeAuthorityCommand({
        kind: "reauthenticate", authority: concurrentReauthenticationAuthority,
        verifiedSubject, payload: concurrentReauthenticationCommand,
      }),
      operations.executeAuthorityCommand({
        kind: "reauthenticate", authority: concurrentReauthenticationAuthority,
        verifiedSubject, payload: concurrentReauthenticationCommand,
      }),
    ]);
    assert.deepEqual(concurrentReauthentication[1], concurrentReauthentication[0]);

    await pool.query(`insert into platform_role_assignments (
      platform_role_assignment_id, actor_id, role, status, resource_version, created_at, updated_at
    ) values ($1, $2, 'platform_super_admin', 'active', 1, now(), now())`, ["platform_role_composition", registered.actorId]);
    const refreshed = await operations.authenticateSession({ sessionSecret: issued.sessionSecret, csrfSecret: issued.csrfSecret!, requireCsrf: true });
    const revokeTarget = await issueCoreSession({ db }, {
      sessionId: "session_composition_revoke_target", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "iphone",
    });
    const staleRevokePayload = {
      schema_version: 1 as const, idempotency_key: "composition-session-revoke",
      expected_resource_version: 2, session_id: revokeTarget.session.session_id,
      reason_code: "administrator_revoked" as const,
    };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "session_revoke", authority: refreshed,
      payload: { ...staleRevokePayload, payload_hash: canonicalPayloadHash(staleRevokePayload) },
    }), /RESOURCE_VERSION_CONFLICT/u);
    const revokePayload = { ...staleRevokePayload, expected_resource_version: 1 };
    const revokeCommand = { ...revokePayload, payload_hash: canonicalPayloadHash(revokePayload) };
    const revokedTarget = await operations.executeProtectedAuthorityCommand({
      kind: "session_revoke", authority: refreshed, payload: revokeCommand,
    });
    assert.deepEqual(await operations.executeProtectedAuthorityCommand({
      kind: "session_revoke", authority: refreshed, payload: revokeCommand,
    }), revokedTarget);
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "session_revoke", authority: refreshed,
      payload: { ...revokeCommand, reason_code: "user_sign_out" },
    }), /INVALID_REQUEST|IDEMPOTENCY_CONFLICT/u);
    const concurrentRevokeTarget = await issueCoreSession({ db }, {
      sessionId: "session_composition_concurrent_revoke_target", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "macos",
    });
    const concurrentRevokePayload = {
      schema_version: 1 as const, idempotency_key: "composition-concurrent-session-revoke",
      expected_resource_version: 1, session_id: concurrentRevokeTarget.session.session_id,
      reason_code: "administrator_revoked" as const,
    };
    const concurrentRevokeCommand = {
      ...concurrentRevokePayload, payload_hash: canonicalPayloadHash(concurrentRevokePayload),
    };
    const concurrentRevocations = await Promise.all([
      operations.executeProtectedAuthorityCommand({
        kind: "session_revoke", authority: refreshed, payload: concurrentRevokeCommand,
      }),
      operations.executeProtectedAuthorityCommand({
        kind: "session_revoke", authority: refreshed, payload: concurrentRevokeCommand,
      }),
    ]);
    assert.deepEqual(concurrentRevocations[1], concurrentRevocations[0]);

    const appleLinkPayload = {
      schema_version: 1, idempotency_key: "composition-apple-link", payload_hash: `sha256:${"d".repeat(64)}`,
    };
    await operations.executeProtectedAuthorityCommand({
      kind: "apple_identity_link", authority: refreshed, payload: appleLinkPayload,
      verifiedSubject: { ...verifiedSubject, identityKind: "apple" },
    });
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "apple_identity_link", authority: refreshed, payload: appleLinkPayload,
      verifiedSubject: { ...verifiedSubject, providerSubject: "composition-other-apple-subject", identityKind: "apple" },
    }), /IDEMPOTENCY_CONFLICT/u);
    assert.deepEqual((await pool.query(
      "select count(*)::int as count, min(provider_identity_kind) as provider_identity_kind from auth_subjects where actor_id = $1",
      [registered.actorId],
    )).rows[0], { count: 1, provider_identity_kind: "email_password_apple" });
    const company = await operations.executeProtectedAuthorityCommand({
      kind: "company_create", authority: refreshed,
      payload: { schema_version: 1, idempotency_key: "composition-company", payload_hash: `sha256:${"b".repeat(64)}`, display_name: "Composition Company", administrator_email: "admin@example.test" },
    }) as { tenant_id: string };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "company_create", authority: refreshed,
      payload: { schema_version: 1, idempotency_key: "composition-company", payload_hash: `sha256:${"b".repeat(64)}`, display_name: "Composition Company", administrator_email: "admin@example.test" },
    }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "IDEMPOTENCY_CONFLICT", String(error));
      return true;
    });
    assert.equal((await pool.query("select count(*)::int as count from tenants where tenant_id = $1 and tenant_mode = 'b2b'", [company.tenant_id])).rows[0]?.count, 1);
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "company_member_list", authority: refreshed,
      payload: { schema_version: 1, tenant_id: company.tenant_id, limit: 20 },
    }), /UNAUTHENTICATED/u, "platform projection must not become company-admin list authority");

    const timestamp = new Date("2026-08-18T02:00:00.000Z");
    await db.insertInto("actors").values([
      { actor_id: "actor_composition_admin", schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Composition admin", status: "active", created_at: timestamp, updated_at: timestamp },
      { actor_id: "actor_composition_invitee", schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Composition invitee", status: "active", created_at: timestamp, updated_at: timestamp },
      { actor_id: "actor_composition_lock_invitee", schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Composition lock invitee", status: "active", created_at: timestamp, updated_at: timestamp },
    ]).execute();
    await db.insertInto("auth_subjects").values([
      { auth_subject_id: "auth_composition_admin", actor_id: "actor_composition_admin", provider: "supabase", provider_subject: "provider_composition_admin", provider_identity_kind: "email_password", verified_at: timestamp, status: "active", resource_version: 1, created_at: timestamp, updated_at: timestamp },
      { auth_subject_id: "auth_composition_invitee", actor_id: "actor_composition_invitee", provider: "supabase", provider_subject: "provider_composition_invitee", provider_identity_kind: "email_password", verified_at: timestamp, status: "active", resource_version: 1, created_at: timestamp, updated_at: timestamp },
      { auth_subject_id: "auth_composition_lock_invitee", actor_id: "actor_composition_lock_invitee", provider: "supabase", provider_subject: "provider_composition_lock_invitee", provider_identity_kind: "email_password", verified_at: timestamp, status: "active", resource_version: 1, created_at: timestamp, updated_at: timestamp },
    ]).execute();
    const adminEmail = "company-admin@example.test";
    const inviteeEmail = "company-invitee@example.test";
    const lockInviteeEmail = "company-lock-invitee@example.test";
    await db.insertInto("private_identity_pii").values([
      { actor_id: "actor_composition_admin", normalized_email_hmac: createHmac("sha256", key).update(adminEmail).digest(), encrypted_email: Buffer.from("encrypted-admin"), encryption_key_ref: "composition", created_at: timestamp, updated_at: timestamp },
      { actor_id: "actor_composition_invitee", normalized_email_hmac: createHmac("sha256", key).update(inviteeEmail).digest(), encrypted_email: Buffer.from("encrypted-invitee"), encryption_key_ref: "composition", created_at: timestamp, updated_at: timestamp },
      { actor_id: "actor_composition_lock_invitee", normalized_email_hmac: createHmac("sha256", key).update(lockInviteeEmail).digest(), encrypted_email: Buffer.from("encrypted-lock-invitee"), encryption_key_ref: "composition", created_at: timestamp, updated_at: timestamp },
    ]).execute();
    await db.insertInto("memberships").values({
      tenant_id: company.tenant_id, membership_id: "membership_composition_admin", actor_id: "actor_composition_admin",
      schema_version: 1, resource_version: 1, roles: ["admin"], membership_source: "company", seat_ref: null,
      status: "active", created_at: timestamp, updated_at: timestamp,
    }).execute();
    const adminIssued = await issueCoreSession({ db }, {
      sessionId: "session_composition_admin", actorId: "actor_composition_admin",
      authSubjectId: "auth_composition_admin", clientKind: "web",
    });
    await pool.query("update core_sessions set reauthenticated_at = now(), updated_at = now() where session_id = $1", [adminIssued.session.session_id]);
    const adminAuthority = await operations.authenticateSession({ sessionSecret: adminIssued.sessionSecret, csrfSecret: adminIssued.csrfSecret!, requireCsrf: true });
    const invitation = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_invite", authority: adminAuthority,
      payload: { schema_version: 1, idempotency_key: "composition-member-invite", payload_hash: `sha256:${"e".repeat(64)}`, tenant_id: company.tenant_id, email: inviteeEmail, role: "consultant" },
    }) as { invitation_id: string; invitation_secret: string; membership_id: string };

    const newInviteeEmail = "new-composition-invitee@example.test";
    const onboardingInvitation = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_invite", authority: adminAuthority,
      payload: {
        schema_version: 1, idempotency_key: "composition-onboarding-invite",
        payload_hash: `sha256:${"1".repeat(64)}`, tenant_id: company.tenant_id,
        email: newInviteeEmail, role: "consultant",
      },
    }) as { invitation_id: string; invitation_secret: string; membership_id: string };
    const appleAdminInvitation = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_invite", authority: adminAuthority,
      payload: {
        schema_version: 1, idempotency_key: "composition-apple-admin-invite",
        payload_hash: `sha256:${"2".repeat(64)}`, tenant_id: company.tenant_id,
        email: "apple-invited-admin@example.test", role: "admin",
      },
    }) as { invitation_id: string; invitation_secret: string; membership_id: string };
    const appleConsultantInvitation = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_invite", authority: adminAuthority,
      payload: {
        schema_version: 1, idempotency_key: "composition-apple-consultant-invite",
        payload_hash: `sha256:${"3".repeat(64)}`, tenant_id: company.tenant_id,
        email: "apple-invited-consultant@example.test", role: "consultant",
      },
    }) as { invitation_id: string; invitation_secret: string; membership_id: string };
    let signUpCalls = 0;
    let verificationCalls = 0;
    const onboardingSubject = {
      provider: "supabase" as const, providerSubject: "provider_new_composition_invitee",
      identityKind: "email_password" as const, normalizedEmail: newInviteeEmail,
      verifiedAt: timestamp.toISOString(),
    };
    const concurrentInviteeEmail = "concurrent-composition-invitee@example.test";
    const concurrentOnboardingSubject = {
      provider: "supabase" as const, providerSubject: "provider_concurrent_composition_invitee",
      identityKind: "email_password" as const, normalizedEmail: concurrentInviteeEmail,
      verifiedAt: timestamp.toISOString(),
    };
    const concurrentCallbackSubject = {
      ...onboardingSubject,
      providerSubject: "provider_concurrent_callback",
      normalizedEmail: "concurrent-callback@example.test",
    };
    const checkpointRecoverySubject = {
      ...onboardingSubject,
      providerSubject: "provider_checkpoint_recovery",
      normalizedEmail: "checkpoint-recovery@example.test",
    };
    const domainRetrySubject = {
      ...onboardingSubject,
      providerSubject: "provider_domain_retry",
      normalizedEmail: "domain-retry@example.test",
    };
    const preconfirmedSubject = {
      ...onboardingSubject,
      providerSubject: "provider_preconfirmed_before_attempt",
      normalizedEmail: "preconfirmed-before-attempt@example.test",
      verifiedAt: "2026-08-17T02:00:00.000Z",
    };
    const appleSubjects = new Map<string, VerifiedProviderSubject>([
      ["apple-b2c-web-code", {
        ...onboardingSubject, providerSubject: "provider_apple_b2c_web",
        identityKind: "apple", normalizedEmail: "apple-b2c-web@example.test",
      }],
      ["apple-b2c-native-code", {
        ...onboardingSubject, providerSubject: "provider_apple_b2c_native",
        identityKind: "apple", normalizedEmail: "apple-b2c-native@example.test",
      }],
      ["apple-b2c-retry-code", {
        ...onboardingSubject, providerSubject: "provider_apple_b2c_retry",
        identityKind: "apple", normalizedEmail: "apple-b2c-retry@example.test",
      }],
      ["apple-invited-admin-code", {
        ...onboardingSubject, providerSubject: "provider_apple_invited_admin",
        identityKind: "apple", normalizedEmail: "apple-invited-admin@example.test",
      }],
      ["apple-invited-consultant-code", {
        ...onboardingSubject, providerSubject: "provider_apple_invited_consultant",
        identityKind: "apple", normalizedEmail: "apple-invited-consultant@example.test",
      }],
    ]);
    const lateInvalidStatuses = ["wrong-binding", "revoked", "replaced", "expired"] as const;
    const lateInvalidSubjects = new Map<string, typeof onboardingSubject>(lateInvalidStatuses.map((status) => {
      const normalizedEmail = `late-${status}-composition-invitee@example.test`;
      return [`late-${status}-verification-code`, {
        provider: "supabase" as const,
        providerSubject: `provider_late_${status.replace("-", "_")}_composition_invitee`,
        identityKind: "email_password" as const,
        normalizedEmail,
        verifiedAt: timestamp.toISOString(),
      }] as const;
    }));
    const unavailableProvider = async (): Promise<never> => { throw new Error("unused provider method"); };
    const knownEmailSubjects = new Map<string, typeof onboardingSubject>([
      [onboardingSubject.normalizedEmail, onboardingSubject],
      [concurrentOnboardingSubject.normalizedEmail, concurrentOnboardingSubject],
      [concurrentCallbackSubject.normalizedEmail, concurrentCallbackSubject],
      [checkpointRecoverySubject.normalizedEmail, checkpointRecoverySubject],
      [domainRetrySubject.normalizedEmail, domainRetrySubject],
      [preconfirmedSubject.normalizedEmail, preconfirmedSubject],
      ...[...lateInvalidSubjects.values()].map((subject) => [subject.normalizedEmail, subject] as const),
    ]);
    const confirmedSubjects = new Map<string, typeof onboardingSubject>([
      [preconfirmedSubject.providerSubject, preconfirmedSubject],
    ]);
    const usedVerificationCodes = new Set<string>();
    const appleCompletionCalls = new Map<string, number>();
    const provider: AuthProviderAdapter = {
      async signUpEmail(input) {
        signUpCalls += 1;
        const subject = knownEmailSubjects.get(input.email) ?? {
          ...onboardingSubject,
          providerSubject: `provider_${createHash("sha256").update(input.email).digest("hex").slice(0, 24)}`,
          normalizedEmail: input.email,
        };
        knownEmailSubjects.set(input.email, subject);
        return { kind: "verification_pending", expectedProviderSubject: subject.providerSubject };
      },
      async recoverVerifiedEmailSubject(input) {
        const subject = confirmedSubjects.get(input.expectedProviderSubject);
        if (subject === undefined) throw new ProviderFailure("AUTH_EMAIL_UNVERIFIED");
        const recovery = input as unknown as {
          expectedNormalizedEmail?: string;
          verificationStartedAt?: string;
          recoveryNotAfter?: string;
        };
        if (subject.normalizedEmail !== recovery.expectedNormalizedEmail
          || Date.parse(subject.verifiedAt) < Date.parse(String(recovery.verificationStartedAt))
          || Date.parse(subject.verifiedAt) > Date.parse(String(recovery.recoveryNotAfter))) {
          throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        }
        return subject;
      },
      async verifyEmail(input) {
        verificationCalls += 1;
        if (usedVerificationCodes.has(input.verificationCode)) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        const subject = lateInvalidSubjects.get(input.verificationCode)
          ?? (input.verificationCode === "concurrent-verification-code" ? concurrentOnboardingSubject
            : input.verificationCode === "concurrent-callback-code" ? concurrentCallbackSubject
            : input.verificationCode === "checkpoint-recovery-code" ? checkpointRecoverySubject
              : input.verificationCode === "domain-retry-code" ? domainRetrySubject
                : onboardingSubject);
        if (subject.providerSubject !== input.expectedProviderSubject) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        const confirmedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
        const verifiedSubject = { ...subject, verifiedAt: confirmedAt.toISOString() };
        usedVerificationCodes.add(input.verificationCode);
        confirmedSubjects.set(subject.providerSubject, verifiedSubject);
        return verifiedSubject;
      },
      async signInEmail(input) {
        const appleSubject = [...appleSubjects.values()].find((subject) => subject.normalizedEmail === input.email);
        if (appleSubject === undefined) return unavailableProvider();
        return { ...appleSubject, identityKind: "email_password" };
      },
      async beginApple(input) {
        const clientKind = (input as { client_kind: string }).client_kind;
        const deviceLabel = (input as { device_label?: string }).device_label ?? "default";
        const suffix = createHash("sha256").update(`${clientKind}:${deviceLabel}`).digest("hex").slice(0, 16);
        const state = `composition-apple-state-${suffix}`;
        const redirectUri = (input as { redirect_uri: string }).redirect_uri;
        return {
          transaction_id: `oauth_composition_apple_${suffix}`,
          authorization_url: `https://provider.example.test/auth/v1/authorize?state=${state}&redirect_to=${encodeURIComponent(redirectUri)}`,
          expires_at: new Date(timestamp.getTime() + 5 * 60_000).toISOString(),
        };
      },
      reauthenticateAndBeginAppleLink: unavailableProvider,
      async completeApple(input) {
        appleCompletionCalls.set(input.authorization_code, (appleCompletionCalls.get(input.authorization_code) ?? 0) + 1);
        const subject = appleSubjects.get(input.authorization_code);
        if (subject === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        return subject;
      },
      async verifyCurrentSubject(input) {
        if (input.accessToken === "opaque-lock-order-proof") {
          return {
            provider: "supabase", providerSubject: "provider_composition_lock_invitee",
            identityKind: "email_password", normalizedEmail: lockInviteeEmail,
            verifiedAt: timestamp.toISOString(),
          };
        }
        return {
          provider: "supabase", providerSubject: "provider_composition_invitee",
          identityKind: "email_password", normalizedEmail: inviteeEmail,
          verifiedAt: timestamp.toISOString(),
        };
      },
      reauthenticatePassword: unavailableProvider,
      beginPasswordReset: unavailableProvider,
      completePasswordReset: unavailableProvider,
      linkApple: unavailableProvider,
      revokeCurrentProviderSession: unavailableProvider,
      deleteProviderSubject: unavailableProvider,
    };
    const onboardingConfig = {
      publicOrigins: new Set(["https://app.example.test"]), cookieHost: "identity.example.test",
      publicBaseUrl: "https://identity.example.test", providerUrl: "https://provider.example.test",
      appleWebRedirectUris: new Set(["https://app.example.test/auth/apple/callback"]),
      appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]),
      passwordResetRedirectUri: "https://app.example.test/auth/password/reset/callback",
      publicAuthEnabled: true,
    };
    const onboardingApp = await buildIdentityGatewayApp({
      config: onboardingConfig,
      provider,
      operations,
      flowCookieKey: Buffer.alloc(32, 0x37),
      now: () => timestamp,
    });
    const publicHeaders = {
      host: "identity.example.test", origin: "https://app.example.test", "content-type": "application/json",
    };
    const managementHeaders = {
      ...publicHeaders,
      cookie: `core_agent_session=${issued.sessionSecret}; core_agent_csrf=${issued.csrfSecret!}`,
      "x-core-agent-csrf": issued.csrfSecret!,
    };
    const appleStart = async (clientKind: "web" | "iphone", deviceLabel: string) => {
      const payload = {
        schema_version: 1 as const,
        idempotency_key: `composition-apple-start-${clientKind}-${deviceLabel.toLowerCase().replaceAll(" ", "-")}`,
        payload_hash: `sha256:${clientKind === "web" ? "4".repeat(64) : "5".repeat(64)}`,
        client_kind: clientKind,
        redirect_uri: clientKind === "web" ? "https://app.example.test/auth/apple/callback" : "coreagent://auth/apple/callback",
        device_label: deviceLabel,
        ...(clientKind === "web" ? {} : {
          nonce: `composition-${deviceLabel}-nonce`, pkce_code_challenge: "p".repeat(43),
          pkce_code_challenge_method: "S256" as const,
        }),
      };
      // Preserve a strict 64-hex public hash without making this fixture exercise provider-start hashing.
      const response = await onboardingApp.inject({
        method: "POST", url: "/auth/v1/apple/start",
        headers: clientKind === "web" ? publicHeaders : { host: "identity.example.test", "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response;
    };

    const webB2cStart = await appleStart("web", "Apple B2C Web");
    const webB2cCookie = ([] as string[]).concat(webB2cStart.headers["set-cookie"] ?? [])
      .find((value) => value.startsWith("core_agent_apple_flow="))!.split(";", 1)[0]!;
    const webB2cState = new URL(webB2cStart.json().authorization_url).searchParams.get("state")!;
    const webB2cSuffix = createHash("sha256").update("web:Apple B2C Web").digest("hex").slice(0, 16);
    const webB2c = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/apple/callback",
      headers: { ...publicHeaders, cookie: webB2cCookie },
      payload: {
        schema_version: 1, idempotency_key: "composition-apple-b2c-web-complete",
        payload_hash: `sha256:${"6".repeat(64)}`, client_kind: "web",
        transaction_id: `oauth_composition_apple_${webB2cSuffix}`,
        authorization_code: "apple-b2c-web-code", state: webB2cState,
      },
    });
    assert.equal(webB2c.statusCode, 200, webB2c.body);
    assert.equal(webB2c.json().transport, "web_cookie");
    const passwordAgainstAppleOnly = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/sign-in", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-password-against-apple-only",
        payload_hash: `sha256:${"7".repeat(64)}`, email: "apple-b2c-web@example.test",
        password: "composition-password", client_kind: "web",
      },
    });
    assert.equal(passwordAgainstAppleOnly.statusCode, 401, passwordAgainstAppleOnly.body);

    const nativeB2cStart = await appleStart("iphone", "Apple B2C Native");
    const nativeB2c = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/apple/callback",
      headers: { host: "identity.example.test", "content-type": "application/json" },
      payload: {
        schema_version: 1, idempotency_key: "composition-apple-b2c-native-complete",
        payload_hash: `sha256:${"7".repeat(64)}`, client_kind: "iphone",
        transaction_id: nativeB2cStart.json().transaction_id,
        authorization_code: "apple-b2c-native-code",
        state: new URL(nativeB2cStart.json().authorization_url).searchParams.get("state"),
        nonce: "composition-Apple B2C Native-nonce", pkce_code_verifier: "v".repeat(43),
      },
    });
    assert.equal(nativeB2c.statusCode, 200, nativeB2c.body);
    assert.equal(nativeB2c.json().transport, "native");
    assert.match(String(nativeB2c.json().session_secret), /^[A-Za-z0-9_-]{43}$/u);

    await pool.query("create sequence composition_apple_retry_once_seq start 1");
    await pool.query(`create function composition_fail_apple_registration_once() returns trigger language plpgsql as $$
      begin
        if new.provider_subject = 'provider_apple_b2c_retry'
          and nextval('composition_apple_retry_once_seq') = 1 then
          raise exception 'forced serializable retry' using errcode = '40001';
        end if;
        return new;
      end
    $$`);
    await pool.query(`create trigger composition_fail_apple_registration_once
      before insert on auth_subjects for each row execute function composition_fail_apple_registration_once()`);
    const retryB2cStart = await appleStart("iphone", "Apple B2C Retry");
    const retryB2c = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/apple/callback",
      headers: { host: "identity.example.test", "content-type": "application/json" },
      payload: {
        schema_version: 1, idempotency_key: "composition-apple-b2c-retry-complete",
        payload_hash: `sha256:${"c".repeat(64)}`, client_kind: "iphone",
        transaction_id: retryB2cStart.json().transaction_id,
        authorization_code: "apple-b2c-retry-code",
        state: new URL(retryB2cStart.json().authorization_url).searchParams.get("state"),
        nonce: "composition-Apple B2C Retry-nonce", pkce_code_verifier: "y".repeat(43),
      },
    });
    assert.equal(retryB2c.statusCode, 200, retryB2c.body);
    assert.equal(appleCompletionCalls.get("apple-b2c-retry-code"), 1, "provider effect must remain outside the retried DB phase");
    assert.equal(Number((await pool.query("select last_value from composition_apple_retry_once_seq")).rows[0]?.last_value), 2);

    const webAdminStart = await appleStart("web", "Apple Invited Admin");
    const webAdminCookie = ([] as string[]).concat(webAdminStart.headers["set-cookie"] ?? [])
      .find((value) => value.startsWith("core_agent_apple_flow="))!.split(";", 1)[0]!;
    const webAdminState = new URL(webAdminStart.json().authorization_url).searchParams.get("state")!;
    const webAdminSuffix = createHash("sha256").update("web:Apple Invited Admin").digest("hex").slice(0, 16);
    const webAdminProof = {
      kind: "apple", client_kind: "web", transaction_id: `oauth_composition_apple_${webAdminSuffix}`,
      authorization_code: "apple-invited-admin-code", state: webAdminState,
    };
    const webAdminAcceptance = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/accept",
      headers: { ...publicHeaders, cookie: webAdminCookie },
      payload: appleInvitationAcceptancePayload({
        schema_version: 1, idempotency_key: "composition-apple-admin-accept",
        expected_resource_version: 1, invitation_secret: appleAdminInvitation.invitation_secret,
        device_label: "Apple Invited Admin", authentication_proof: webAdminProof,
      }),
    });
    assert.equal(webAdminAcceptance.statusCode, 200, webAdminAcceptance.body);
    assert.equal(webAdminAcceptance.json().role, "admin");
    assert.equal(webAdminAcceptance.json().membership_id, appleAdminInvitation.membership_id);

    const nativeConsultantStart = await appleStart("iphone", "Apple Invited Consultant");
    const nativeConsultantProof = {
      kind: "apple", client_kind: "iphone", transaction_id: nativeConsultantStart.json().transaction_id,
      authorization_code: "apple-invited-consultant-code",
      state: new URL(nativeConsultantStart.json().authorization_url).searchParams.get("state"),
      nonce: "composition-Apple Invited Consultant-nonce", pkce_code_verifier: "w".repeat(43),
    };
    const nativeConsultantAcceptance = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/accept",
      headers: { host: "identity.example.test", "content-type": "application/json" },
      payload: appleInvitationAcceptancePayload({
        schema_version: 1, idempotency_key: "composition-apple-consultant-accept",
        expected_resource_version: 1, invitation_secret: appleConsultantInvitation.invitation_secret,
        device_label: "Apple Invited Consultant", authentication_proof: nativeConsultantProof,
      }),
    });
    assert.equal(nativeConsultantAcceptance.statusCode, 200, nativeConsultantAcceptance.body);
    assert.equal(nativeConsultantAcceptance.json().role, "consultant");
    assert.equal(nativeConsultantAcceptance.json().membership_id, appleConsultantInvitation.membership_id);
    assert.equal(nativeConsultantAcceptance.json().transport, "native");
    assert.equal((await pool.query(`select count(*)::int as count
      from auth_subjects subject
      join actors actor on actor.actor_id = subject.actor_id
      join memberships membership on membership.actor_id = actor.actor_id
      where subject.provider_identity_kind = 'apple'
        and subject.provider_subject = any($1::text[])
        and membership.status = 'active'`, [[...appleSubjects.values()].map((subject) => subject.providerSubject)])).rows[0]?.count, 5);
    const routeCompanyPayload = {
      schema_version: 1, idempotency_key: "composition-route-company-once",
      payload_hash: `sha256:${"9".repeat(64)}`, display_name: "Route One-Time Company",
      administrator_email: "route-company-admin@example.test",
    };
    const routeCompanyFirst = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/companies", headers: managementHeaders,
      payload: routeCompanyPayload,
    });
    assert.equal(routeCompanyFirst.statusCode, 200, routeCompanyFirst.body);
    assert.match(String(routeCompanyFirst.json().administrator_invitation_secret), /^[A-Za-z0-9_-]{43}$/u);
    const routeCompanyReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/companies", headers: managementHeaders,
      payload: routeCompanyPayload,
    });
    assert.equal(routeCompanyReplay.statusCode, 409, routeCompanyReplay.body);
    const companySecretReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/companies", headers: managementHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-company",
        payload_hash: `sha256:${"b".repeat(64)}`, display_name: "Composition Company",
        administrator_email: "admin@example.test",
      },
    });
    assert.equal(companySecretReplay.statusCode, 409, companySecretReplay.body);
    const routeInvitationHeaders = {
      ...publicHeaders,
      cookie: `core_agent_session=${adminIssued.sessionSecret}; core_agent_csrf=${adminIssued.csrfSecret!}`,
      "x-core-agent-csrf": adminIssued.csrfSecret!,
    };
    const routeInvitationPayload = {
      schema_version: 1, idempotency_key: "composition-route-invitation-once",
      payload_hash: `sha256:${"a".repeat(64)}`, tenant_id: company.tenant_id,
      email: "route-invitee@example.test", role: "consultant",
    };
    const routeInvitationFirst = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/companies/members", headers: routeInvitationHeaders,
      payload: routeInvitationPayload,
    });
    assert.equal(routeInvitationFirst.statusCode, 200, routeInvitationFirst.body);
    assert.match(String(routeInvitationFirst.json().invitation_secret), /^[A-Za-z0-9_-]{43}$/u);
    const routeInvitationReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/companies/members", headers: routeInvitationHeaders,
      payload: routeInvitationPayload,
    });
    assert.equal(routeInvitationReplay.statusCode, 409, routeInvitationReplay.body);
    const invitationSecretReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/companies/members", headers: {
        ...routeInvitationHeaders,
      },
      payload: {
        schema_version: 1, idempotency_key: "composition-member-invite",
        payload_hash: `sha256:${"e".repeat(64)}`, tenant_id: company.tenant_id,
        email: inviteeEmail, role: "consultant",
      },
    });
    assert.equal(invitationSecretReplay.statusCode, 409, invitationSecretReplay.body);

    const invalidInvitationStates = ["revoked", "expired", "replaced"] as const;
    const invalidInvitations: Array<{ email: string; secret: string }> = [];
    for (const [index, status] of invalidInvitationStates.entries()) {
      const email = `${status}-composition-invitee@example.test`;
      const created = await operations.executeProtectedAuthorityCommand({
        kind: "company_member_invite", authority: adminAuthority,
        payload: {
          schema_version: 1, idempotency_key: `composition-${status}-invite-${index}`,
          payload_hash: `sha256:${String(index + 5).repeat(64)}`,
          tenant_id: company.tenant_id, email, role: "consultant",
        },
      }) as { invitation_id: string; invitation_secret: string };
      await pool.query(`update identity_invitations set status = $1,
        expires_at = case when $1 = 'expired' then now() - interval '1 second' else expires_at end,
        updated_at = now() where invitation_id = $2`, [status, created.invitation_id]);
      invalidInvitations.push({ email, secret: created.invitation_secret });
    }
    const invalidCases = [
      { name: "wrong", email: "wrong-secret@example.test", secret: "A".repeat(43) },
      { name: "email-mismatch", email: "mismatched@example.test", secret: onboardingInvitation.invitation_secret },
      ...invalidInvitations.map((entry, index) => ({ name: invalidInvitationStates[index]!, ...entry })),
    ];
    const transactionsBeforeInvalidStarts = Number((await pool.query(
      "select count(*)::int as count from email_verification_transactions",
    )).rows[0]?.count);
    for (const tenantState of ["closed", "b2c"] as const) {
      await pool.query(
        `update tenants set status = $1, tenant_mode = $2, updated_at = now() where tenant_id = $3`,
        [tenantState === "closed" ? "closed" : "active", tenantState === "b2c" ? "b2c" : "b2b", company.tenant_id],
      );
      const idempotencyKey = `composition-invalid-tenant-${tenantState}`;
      const tenantPreflight = await onboardingApp.inject({
        method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
        payload: {
          schema_version: 1, idempotency_key: idempotencyKey,
          payload_hash: canonicalEmailVerificationStartPayloadHash({
            idempotencyKey, normalizedEmail: newInviteeEmail, clientKind: "web",
            flowKind: "invitation", invitationDigest: createHash("sha256")
              .update(Buffer.from(onboardingInvitation.invitation_secret, "base64url")).digest("base64url"),
          }),
          invitation_secret: onboardingInvitation.invitation_secret, email: newInviteeEmail,
          password: "correct-horse-battery", client_kind: "web",
        },
      });
      assert.equal(tenantPreflight.statusCode, 401, `${tenantState}: ${tenantPreflight.body}`);
      assert.equal(signUpCalls, 0, `${tenantState} Tenant must reject before provider`);
      assert.equal(Number((await pool.query(
        "select count(*)::int as count from email_verification_transactions",
      )).rows[0]?.count), transactionsBeforeInvalidStarts);
    }
    await pool.query(
      "update tenants set status = 'active', tenant_mode = 'b2b', updated_at = now() where tenant_id = $1",
      [company.tenant_id],
    );
    for (const invalidCase of invalidCases) {
      const idempotencyKey = `composition-invalid-${invalidCase.name}-start`;
      const invalidStart = await onboardingApp.inject({
        method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
        payload: {
          schema_version: 1, idempotency_key: idempotencyKey,
          payload_hash: canonicalEmailVerificationStartPayloadHash({
            idempotencyKey, normalizedEmail: invalidCase.email, clientKind: "web",
            flowKind: "invitation", invitationDigest: createHash("sha256")
              .update(Buffer.from(invalidCase.secret, "base64url")).digest("base64url"),
          }),
          invitation_secret: invalidCase.secret, email: invalidCase.email,
          password: "correct-horse-battery", client_kind: "web",
        },
      });
      assert.equal(invalidStart.statusCode >= 400, true, `${invalidCase.name}: ${invalidStart.body}`);
    }
    assert.equal(signUpCalls, 0, "invalid invitation authority must reject before provider signup");
    assert.equal(Number((await pool.query(
      "select count(*)::int as count from email_verification_transactions",
    )).rows[0]?.count), transactionsBeforeInvalidStarts);
    const onboardingStartPayloadHash = canonicalEmailVerificationStartPayloadHash({
      idempotencyKey: "composition-invited-email-start", normalizedEmail: newInviteeEmail,
      clientKind: "web", deviceLabel: "Invitation Browser", flowKind: "invitation",
      invitationDigest: createHash("sha256")
        .update(Buffer.from(onboardingInvitation.invitation_secret, "base64url")).digest("base64url"),
    });
    const start = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-invited-email-start",
        payload_hash: onboardingStartPayloadHash,
        invitation_secret: onboardingInvitation.invitation_secret,
        email: newInviteeEmail, password: "correct-horse-battery", client_kind: "web",
        device_label: "Invitation Browser",
      },
    });
    assert.equal(start.statusCode, 202, start.body);
    assert.equal(signUpCalls, 1);
    const changedStartReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-invited-email-start",
        payload_hash: onboardingStartPayloadHash,
        invitation_secret: onboardingInvitation.invitation_secret,
        email: newInviteeEmail, password: "correct-horse-battery", client_kind: "web",
        device_label: "Changed Browser",
      },
    });
    assert.equal(changedStartReplay.statusCode, 400, changedStartReplay.body);
    assert.equal(signUpCalls, 1, "payload conflict must reject before provider signup");
    const verificationId = String(start.json().verification_id);
    const verifyPayload = emailVerificationRequest({
      schema_version: 1, idempotency_key: "composition-invited-email-complete",
      verification_id: verificationId,
      verification_code: "opaque-verification-code",
    });
    const verified = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders, payload: verifyPayload,
    });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(verified.json().transport, "web_cookie");
    assert.equal(verified.headers["set-cookie"]?.length !== 0, true);
    const replayedVerification = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders, payload: verifyPayload,
    });
    assert.equal(replayedVerification.statusCode, 409, replayedVerification.body);
    assert.equal(verificationCalls, 1, "consumed verification must reject before another provider effect");
    const expiredEmail = "expired-composition@example.test";
    const expiredStart = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-expired-email-start",
        payload_hash: canonicalEmailVerificationStartPayloadHash({
          idempotencyKey: "composition-expired-email-start", normalizedEmail: expiredEmail,
          clientKind: "web", flowKind: "b2c",
        }),
        email: expiredEmail, password: "correct-horse-battery", client_kind: "web",
      },
    });
    assert.equal(expiredStart.statusCode, 202, expiredStart.body);
    const expiredVerificationId = String(expiredStart.json().verification_id);
    await pool.query(`update email_verification_transactions
      set expires_at = created_at + interval '1 millisecond'
      where email_verification_transaction_id = $1`, [expiredVerificationId]);
    const expiredVerify = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: emailVerificationRequest({
        schema_version: 1, idempotency_key: "composition-expired-email-complete",
        verification_id: expiredVerificationId,
        verification_code: "opaque-expired-code",
      }),
    });
    assert.equal(expiredVerify.statusCode, 401, expiredVerify.body);
    assert.equal(verificationCalls, 1, "expired binding must reject before provider verification");
    assert.equal((await pool.query(
      "select status from email_verification_transactions where email_verification_transaction_id = $1",
      [expiredVerificationId],
    )).rows[0]?.status, "expired");

    const attemptLimitEmail = "attempt-limit-composition@example.test";
    const attemptLimitStartKey = "composition-attempt-limit-start";
    const attemptLimitStart = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: attemptLimitStartKey,
        payload_hash: canonicalEmailVerificationStartPayloadHash({
          idempotencyKey: attemptLimitStartKey, normalizedEmail: attemptLimitEmail,
          clientKind: "web", flowKind: "b2c",
        }),
        email: attemptLimitEmail, password: "correct-horse-battery", client_kind: "web",
      },
    });
    assert.equal(attemptLimitStart.statusCode, 202, attemptLimitStart.body);
    const attemptLimitVerificationId = String(attemptLimitStart.json().verification_id);
    const callsBeforeAttemptLimit = verificationCalls;
    for (let index = 1; index <= 6; index += 1) {
      const invalidAttempt = await onboardingApp.inject({
        method: "POST", url: "/auth/v1/email/verification", remoteAddress: "203.0.113.70",
        headers: publicHeaders,
        payload: emailVerificationRequest({
          schema_version: 1, idempotency_key: `composition-attempt-limit-${index}`,
          verification_id: attemptLimitVerificationId,
          verification_code: `invalid-attempt-proof-${index}`,
        }),
      });
      assert.equal(invalidAttempt.statusCode, 401, `${index}: ${invalidAttempt.body}`);
    }
    assert.equal(verificationCalls - callsBeforeAttemptLimit, 5, "the sixth invalid OTP must fail before the provider");
    assert.equal(Number((await pool.query(
      "select provider_verification_attempt_count from email_verification_transactions where email_verification_transaction_id = $1",
      [attemptLimitVerificationId],
    )).rows[0]?.provider_verification_attempt_count), 5);

    const preconfirmedStartKey = "composition-preconfirmed-before-attempt-start";
    const preconfirmedStart = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: preconfirmedStartKey,
        payload_hash: canonicalEmailVerificationStartPayloadHash({
          idempotencyKey: preconfirmedStartKey, normalizedEmail: preconfirmedSubject.normalizedEmail,
          clientKind: "web", flowKind: "b2c",
        }),
        email: preconfirmedSubject.normalizedEmail, password: "correct-horse-battery", client_kind: "web",
      },
    });
    assert.equal(preconfirmedStart.statusCode, 202, preconfirmedStart.body);
    const preconfirmedVerificationId = String(preconfirmedStart.json().verification_id);
    const preconfirmedAttempt = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: emailVerificationRequest({
        schema_version: 1, idempotency_key: "composition-preconfirmed-before-attempt-complete",
        verification_id: preconfirmedVerificationId, verification_code: "arbitrary-unrelated-code",
      }),
    });
    assert.equal(preconfirmedAttempt.statusCode, 401, preconfirmedAttempt.body);
    assert.deepEqual((await pool.query(
      `select provider_verification_status, provider_verification_started_at,
        provider_verification_attempt_expires_at, provider_verification_proof_hmac
       from email_verification_transactions where email_verification_transaction_id = $1`,
      [preconfirmedVerificationId],
    )).rows[0], {
      provider_verification_status: "pending",
      provider_verification_started_at: null,
      provider_verification_attempt_expires_at: null,
      provider_verification_proof_hmac: null,
    });
    assert.equal((await pool.query(
      "select count(*)::int as count from auth_subjects where provider_subject = $1",
      [preconfirmedSubject.providerSubject],
    )).rows[0]?.count, 0);

    let checkpointAttempts = 0;
    const checkpointRecoveryApp = await buildIdentityGatewayApp({
      config: onboardingConfig, provider, flowCookieKey: Buffer.alloc(32, 0x38), now: () => timestamp,
      operations: {
        ...operations,
        async checkpointEmailVerification(input) {
          checkpointAttempts += 1;
          if (checkpointAttempts === 1) throw new Error("simulated checkpoint commit failure");
          return operations.checkpointEmailVerification(input);
        },
      },
    });
    const checkpointStartKey = "composition-checkpoint-recovery-start";
    const checkpointStart = await checkpointRecoveryApp.inject({
      method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: checkpointStartKey,
        payload_hash: canonicalEmailVerificationStartPayloadHash({
          idempotencyKey: checkpointStartKey, normalizedEmail: checkpointRecoverySubject.normalizedEmail,
          clientKind: "web", flowKind: "b2c",
        }),
        email: checkpointRecoverySubject.normalizedEmail, password: "correct-horse-battery", client_kind: "web",
      },
    });
    assert.equal(checkpointStart.statusCode, 202, checkpointStart.body);
    const checkpointVerificationId = String(checkpointStart.json().verification_id);
    const checkpointVerification = emailVerificationRequest({
      schema_version: 1, idempotency_key: "composition-checkpoint-recovery-complete",
      verification_id: checkpointVerificationId, verification_code: "checkpoint-recovery-code",
    });
    const verificationCallsBeforeCheckpointRecovery = verificationCalls;
    const failedCheckpoint = await checkpointRecoveryApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: checkpointVerification,
    });
    assert.equal(failedCheckpoint.statusCode, 500, failedCheckpoint.body);
    assert.equal((await pool.query(
      "select provider_verification_status from email_verification_transactions where email_verification_transaction_id = $1",
      [checkpointVerificationId],
    )).rows[0]?.provider_verification_status, "pending");
    await checkpointRecoveryApp.close();
    await pool.query(`update email_verification_transactions
      set provider_verification_attempt_expires_at = clock_timestamp() - interval '1 millisecond'
      where email_verification_transaction_id = $1`, [checkpointVerificationId]);
    const checkpointRestartApp = await buildIdentityGatewayApp({
      config: onboardingConfig, provider, flowCookieKey: Buffer.alloc(32, 0x38), now: () => timestamp,
      operations,
    });
    const recoveredCheckpoint = await checkpointRestartApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: checkpointVerification,
    });
    assert.equal(recoveredCheckpoint.statusCode, 200, recoveredCheckpoint.body);
    assert.equal(verificationCalls, verificationCallsBeforeCheckpointRecovery + 2, "restart recovery must retry the one-use OTP before exact inspection");
    assert.equal((await pool.query(
      "select count(*)::int as count from auth_subjects where provider_subject = $1",
      [checkpointRecoverySubject.providerSubject],
    )).rows[0]?.count, 1);
    await checkpointRestartApp.close();

    const concurrentCallbackStartKey = "composition-concurrent-callback-start";
    const concurrentCallbackStart = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: concurrentCallbackStartKey,
        payload_hash: canonicalEmailVerificationStartPayloadHash({
          idempotencyKey: concurrentCallbackStartKey,
          normalizedEmail: concurrentCallbackSubject.normalizedEmail,
          clientKind: "web", flowKind: "b2c",
        }),
        email: concurrentCallbackSubject.normalizedEmail,
        password: "correct-horse-battery", client_kind: "web",
      },
    });
    assert.equal(concurrentCallbackStart.statusCode, 202, concurrentCallbackStart.body);
    const concurrentCallbackPayload = emailVerificationRequest({
      schema_version: 1, idempotency_key: "composition-concurrent-callback-complete",
      verification_id: String(concurrentCallbackStart.json().verification_id),
      verification_code: "concurrent-callback-code",
    });
    const callsBeforeConcurrentCallback = verificationCalls;
    const concurrentCallbacks = await Promise.all([
      onboardingApp.inject({
        method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
        payload: concurrentCallbackPayload,
      }),
      onboardingApp.inject({
        method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
        payload: concurrentCallbackPayload,
      }),
    ]);
    assert.deepEqual(concurrentCallbacks.map(({ statusCode }) => statusCode).sort(), [200, 409]);
    assert.equal(verificationCalls, callsBeforeConcurrentCallback + 1);
    assert.equal((await pool.query(
      "select count(*)::int as count from auth_subjects where provider_subject = $1",
      [concurrentCallbackSubject.providerSubject],
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      `select count(*)::int as count from core_sessions where actor_id =
        (select actor_id from auth_subjects where provider_subject = $1)`,
      [concurrentCallbackSubject.providerSubject],
    )).rows[0]?.count, 1);

    let domainCompletionAttempts = 0;
    const domainRetryApp = await buildIdentityGatewayApp({
      config: onboardingConfig, provider, flowCookieKey: Buffer.alloc(32, 0x39), now: () => timestamp,
      operations: {
        ...operations,
        async completeEmailVerification(input) {
          domainCompletionAttempts += 1;
          if (domainCompletionAttempts === 1) throw new Error("simulated domain transaction rollback");
          return operations.completeEmailVerification(input);
        },
      },
    });
    const domainStartKey = "composition-domain-retry-start";
    const domainStart = await domainRetryApp.inject({
      method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: domainStartKey,
        payload_hash: canonicalEmailVerificationStartPayloadHash({
          idempotencyKey: domainStartKey, normalizedEmail: domainRetrySubject.normalizedEmail,
          clientKind: "web", flowKind: "b2c",
        }),
        email: domainRetrySubject.normalizedEmail, password: "correct-horse-battery", client_kind: "web",
      },
    });
    assert.equal(domainStart.statusCode, 202, domainStart.body);
    const domainVerificationId = String(domainStart.json().verification_id);
    const domainVerification = emailVerificationRequest({
      schema_version: 1, idempotency_key: "composition-domain-retry-complete",
      verification_id: domainVerificationId, verification_code: "domain-retry-code",
    });
    const verificationCallsBeforeDomainRetry = verificationCalls;
    const failedDomain = await domainRetryApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: domainVerification,
    });
    assert.equal(failedDomain.statusCode, 500, failedDomain.body);
    assert.equal((await pool.query(
      "select provider_verification_status, status from email_verification_transactions where email_verification_transaction_id = $1",
      [domainVerificationId],
    )).rows[0]?.provider_verification_status, "verified");
    const recoveredDomain = await domainRetryApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: domainVerification,
    });
    assert.equal(recoveredDomain.statusCode, 200, recoveredDomain.body);
    assert.equal(verificationCalls, verificationCallsBeforeDomainRetry + 1, "durable checkpoint retry must skip OTP");
    assert.equal((await pool.query(
      "select count(*)::int as count from core_sessions where actor_id = (select actor_id from auth_subjects where provider_subject = $1)",
      [domainRetrySubject.providerSubject],
    )).rows[0]?.count, 1);
    await domainRetryApp.close();

    const concurrentFirstEmail = "concurrent-first-start@example.test";
    const concurrentFirstKey = "composition-concurrent-first-start";
    const concurrentFirstPayload = {
      schema_version: 1 as const, idempotency_key: concurrentFirstKey,
      payload_hash: canonicalEmailVerificationStartPayloadHash({
        idempotencyKey: concurrentFirstKey, normalizedEmail: concurrentFirstEmail,
        clientKind: "web", flowKind: "b2c",
      }),
      email: concurrentFirstEmail, password: "correct-horse-battery", client_kind: "web" as const,
    };
    const startsBeforeConcurrentFirst = signUpCalls;
    const concurrentFirstStarts = await Promise.all([
      onboardingApp.inject({
        method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
        payload: concurrentFirstPayload,
      }),
      onboardingApp.inject({
        method: "POST", url: "/auth/v1/email/sign-up", headers: publicHeaders,
        payload: concurrentFirstPayload,
      }),
    ]);
    const concurrentFirstStatuses = concurrentFirstStarts.map(({ statusCode }) => statusCode);
    assert.equal(concurrentFirstStatuses.includes(202), true);
    assert.equal(concurrentFirstStatuses.every((statusCode) => statusCode === 202 || statusCode === 409), true);
    assert.equal(signUpCalls, startsBeforeConcurrentFirst + 1, "concurrent first start must invoke provider once");
    assert.equal((await pool.query(
      "select count(*)::int as count from email_verification_transactions where start_idempotency_key = $1",
      [concurrentFirstKey],
    )).rows[0]?.count, 1);

    const invitedGraph = await pool.query(`select
      (select count(*)::int from auth_subjects where provider_subject = $1) as subjects,
      (select count(*)::int from memberships where membership_id = $2 and status = 'active') as memberships,
      (select count(*)::int from profiles where owner_actor_id = (
        select actor_id from auth_subjects where provider_subject = $1
      ) and profile_kind = 'consultant' and status = 'active') as profiles,
      (select count(*)::int from core_sessions where actor_id = (
        select actor_id from auth_subjects where provider_subject = $1
      )) as sessions,
      (select count(*)::int from memberships where actor_id = (
        select actor_id from auth_subjects where provider_subject = $1
      ) and membership_id <> $2) as extra_memberships`, [onboardingSubject.providerSubject, onboardingInvitation.membership_id]);
    assert.deepEqual(invitedGraph.rows, [{ subjects: 1, memberships: 1, profiles: 1, sessions: 1, extra_memberships: 0 }]);
    const concurrentInvitation = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_invite", authority: adminAuthority,
      payload: {
        schema_version: 1, idempotency_key: "composition-concurrent-onboarding-invite",
        payload_hash: `sha256:${"7".repeat(64)}`, tenant_id: company.tenant_id,
        email: concurrentInviteeEmail, role: "consultant",
      },
    }) as { invitation_id: string; invitation_secret: string; membership_id: string };
    const concurrentStartKey = "composition-concurrent-invited-email-start";
    const concurrentInvitationDigest = createHash("sha256")
      .update(Buffer.from(concurrentInvitation.invitation_secret, "base64url")).digest("base64url");
    const concurrentStartPayload = {
      schema_version: 1 as const, idempotency_key: concurrentStartKey,
      payload_hash: canonicalEmailVerificationStartPayloadHash({
        idempotencyKey: concurrentStartKey, normalizedEmail: concurrentInviteeEmail,
        clientKind: "web", flowKind: "invitation", invitationDigest: concurrentInvitationDigest,
      }),
      invitation_secret: concurrentInvitation.invitation_secret, email: concurrentInviteeEmail,
      password: "correct-horse-battery", client_kind: "web" as const,
    };
    const concurrentStart = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
      payload: concurrentStartPayload,
    });
    assert.equal(concurrentStart.statusCode, 202, concurrentStart.body);
    const concurrentVerificationPayload = emailVerificationRequest({
      schema_version: 1, idempotency_key: "composition-concurrent-invited-email-complete",
      verification_id: String(concurrentStart.json().verification_id),
      verification_code: "concurrent-verification-code",
    });
    const [settledStartReplay, settledVerification] = await (async () => {
      const invitationBarrier = await pool.connect();
      try {
        await invitationBarrier.query("begin");
        await invitationBarrier.query(
          "select invitation_id from identity_invitations where invitation_id = $1 for update",
          [concurrentInvitation.invitation_id],
        );
        const concurrentStartReplay = onboardingApp.inject({
          method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
          payload: concurrentStartPayload,
        });
        const concurrentVerification = onboardingApp.inject({
          method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
          payload: concurrentVerificationPayload,
        });
        await waitForBlockedLocks(pool, 1);
        await invitationBarrier.query("commit");
        return Promise.all([concurrentStartReplay, concurrentVerification]);
      } finally {
        await invitationBarrier.query("rollback").catch(() => undefined);
        invitationBarrier.release();
      }
    })();
    assert.equal(settledStartReplay.statusCode, 202, settledStartReplay.body);
    assert.equal(settledVerification.statusCode, 200, settledVerification.body);
    const concurrentConsumedReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: concurrentVerificationPayload,
    });
    assert.equal(concurrentConsumedReplay.statusCode, 409, concurrentConsumedReplay.body);
    const concurrentGraph = await pool.query(`select
      (select count(*)::int from auth_subjects where provider_subject = $1) as subjects,
      (select count(*)::int from memberships where membership_id = $2 and status = 'active') as memberships,
      (select count(*)::int from profiles where owner_actor_id = (
        select actor_id from auth_subjects where provider_subject = $1
      ) and profile_kind = 'consultant' and status = 'active') as profiles,
      (select count(*)::int from core_sessions where actor_id = (
        select actor_id from auth_subjects where provider_subject = $1
      )) as sessions`, [concurrentOnboardingSubject.providerSubject, concurrentInvitation.membership_id]);
    assert.deepEqual(concurrentGraph.rows, [{ subjects: 1, memberships: 1, profiles: 1, sessions: 1 }]);
    for (const status of lateInvalidStatuses) {
      const subject = lateInvalidSubjects.get(`late-${status}-verification-code`)!;
      const invitation = await operations.executeProtectedAuthorityCommand({
        kind: "company_member_invite", authority: adminAuthority,
        payload: {
          schema_version: 1, idempotency_key: `composition-late-${status}-invite`,
          payload_hash: `sha256:${createHash("sha256").update(status).digest("hex")}`,
          tenant_id: company.tenant_id, email: subject.normalizedEmail, role: "consultant",
        },
      }) as { invitation_id: string; invitation_secret: string; membership_id: string };
      const idempotencyKey = `composition-late-${status}-start`;
      const invitationDigest = createHash("sha256")
        .update(Buffer.from(invitation.invitation_secret, "base64url")).digest("base64url");
      const lateStart = await onboardingApp.inject({
        method: "POST", url: "/auth/v1/invitations/register", headers: publicHeaders,
        payload: {
          schema_version: 1, idempotency_key: idempotencyKey,
          payload_hash: canonicalEmailVerificationStartPayloadHash({
            idempotencyKey, normalizedEmail: subject.normalizedEmail, clientKind: "web",
            flowKind: "invitation", invitationDigest,
          }),
          invitation_secret: invitation.invitation_secret, email: subject.normalizedEmail,
          password: "correct-horse-battery", client_kind: "web",
        },
      });
      assert.equal(lateStart.statusCode, 202, `${status}: ${lateStart.body}`);
      if (status === "wrong-binding") {
        await pool.query(`update identity_invitations set secret_digest = decode(repeat('77', 32), 'hex'),
          updated_at = now() where invitation_id = $1`, [invitation.invitation_id]);
      } else if (status === "expired") {
        await pool.query("update identity_invitations set expires_at = now() - interval '1 second', updated_at = now() where invitation_id = $1", [invitation.invitation_id]);
      } else {
        await pool.query("update identity_invitations set status = $1, updated_at = now() where invitation_id = $2", [status, invitation.invitation_id]);
      }
      const lateVerify = await onboardingApp.inject({
        method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
        payload: emailVerificationRequest({
          schema_version: 1, idempotency_key: `composition-late-${status}-complete`,
          verification_id: String(lateStart.json().verification_id),
          verification_code: `late-${status}-verification-code`,
        }),
      });
      assert.equal(lateVerify.statusCode >= 400, true, `${status}: ${lateVerify.body}`);
      assert.equal((await pool.query(
        "select count(*)::int as count from auth_subjects where provider_subject = $1",
        [subject.providerSubject],
      )).rows[0]?.count, 0, `${status} must roll back invited identity registration`);
      assert.equal((await pool.query(
        "select status from email_verification_transactions where email_verification_transaction_id = $1",
        [String(lateStart.json().verification_id)],
      )).rows[0]?.status, "pending", `${status} must roll back one-time consumption`);
      assert.equal((await pool.query(
        "select count(*)::int as count from core_sessions where session_id like $1",
        [`%${status}%`],
      )).rows[0]?.count, 0);
    }
    const lockOrderInvitation = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_invite", authority: adminAuthority,
      payload: {
        schema_version: 1, idempotency_key: "composition-existing-accept-lock-order-invite",
        payload_hash: `sha256:${"8".repeat(64)}`, tenant_id: company.tenant_id,
        email: lockInviteeEmail, role: "consultant",
      },
    }) as { invitation_id: string; invitation_secret: string };
    const lockOrderFacts = {
      schema_version: 1 as const, idempotency_key: "composition-existing-accept-lock-order",
      invitation_secret: lockOrderInvitation.invitation_secret,
      expected_resource_version: 1, device_label: "Lock Order Browser",
      authentication_proof: {
        kind: "email_password" as const, client_kind: "web" as const,
        verification_proof: "opaque-lock-order-proof",
      },
    };
    const actorLock = await pool.connect();
    let lockOrderAcceptance: Promise<{ readonly statusCode: number; readonly body: string }> | undefined;
    try {
      await actorLock.query("begin");
      await actorLock.query("select actor_id from actors where actor_id = $1 for update", ["actor_composition_lock_invitee"]);
      lockOrderAcceptance = onboardingApp.inject({
        method: "POST", url: "/auth/v1/invitations/accept", headers: publicHeaders,
        payload: { ...lockOrderFacts, payload_hash: invitationAcceptanceHash(lockOrderFacts) },
      });
      await waitForBlockedLocks(pool, 1);
      const revokeWithoutHash = {
        schema_version: 1 as const, idempotency_key: "composition-existing-accept-lock-order-revoke",
        invitation_id: lockOrderInvitation.invitation_id, expected_resource_version: 1,
        reason_code: "administrator_revoked" as const,
      };
      const revokeResult = await Promise.race([
        operations.executeProtectedAuthorityCommand({
          kind: "invitation_revoke", authority: adminAuthority,
          payload: { ...revokeWithoutHash, payload_hash: canonicalPayloadHash(revokeWithoutHash) },
        }).then(() => "settled" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]);
      assert.equal(revokeResult, "settled", "revoke must not wait behind an acceptance that is blocked on its Actor lock");
      await actorLock.query("commit");
    } finally {
      await actorLock.query("rollback").catch(() => undefined);
      actorLock.release();
    }
    const lockOrderAcceptanceResult = await lockOrderAcceptance!;
    assert.equal(lockOrderAcceptanceResult.statusCode >= 400, true, lockOrderAcceptanceResult.body);
    const acceptanceFacts = {
      schema_version: 1 as const, idempotency_key: "composition-invitation-accept",
      invitation_secret: invitation.invitation_secret,
      expected_resource_version: 1, device_label: "Existing Invitation Browser",
      authentication_proof: {
        kind: "email_password" as const, client_kind: "web" as const, verification_proof: "opaque-existing-proof",
      },
    };
    const acceptancePayload = { ...acceptanceFacts, payload_hash: invitationAcceptanceHash(acceptanceFacts) };
    const accepted = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/accept", headers: publicHeaders, payload: acceptancePayload,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().membership_id, invitation.membership_id);
    assert.equal(accepted.json().role, "consultant");
    const acceptanceReplay = await onboardingApp.inject({
      method: "POST", url: "/auth/v1/invitations/accept", headers: publicHeaders, payload: acceptancePayload,
    });
    assert.equal(acceptanceReplay.statusCode, 409, acceptanceReplay.body);
    assert.equal((await pool.query(
      "select count(*)::int as count from core_sessions where actor_id = 'actor_composition_invitee'",
    )).rows[0]?.count, 1);
    const activityBefore = (await pool.query<{ resource_version: string; absolute_expires_at: Date }>(
      `update core_sessions set last_seen_at = clock_timestamp() - interval '10 minutes',
        idle_expires_at = clock_timestamp() + interval '20 minutes', updated_at = clock_timestamp()
       where session_id = $1 returning resource_version, absolute_expires_at`,
      [issued.session.session_id],
    )).rows[0]!;
    const inspectedActivity = await onboardingApp.inject({
      method: "GET", url: "/auth/v1/session",
      headers: { host: "identity.example.test", origin: "https://app.example.test", cookie: `core_agent_session=${issued.sessionSecret}` },
    });
    assert.equal(inspectedActivity.statusCode, 200, inspectedActivity.body);
    const activityAfter = (await pool.query<{ resource_version: string; idle_expires_at: Date; absolute_expires_at: Date }>(
      "select resource_version, idle_expires_at, absolute_expires_at from core_sessions where session_id = $1",
      [issued.session.session_id],
    )).rows[0]!;
    assert.equal(Number(activityAfter.resource_version), Number(activityBefore.resource_version) + 1);
    assert.equal(activityAfter.absolute_expires_at.toISOString(), activityBefore.absolute_expires_at.toISOString());
    assert.equal(activityAfter.idle_expires_at.getTime() <= activityAfter.absolute_expires_at.getTime(), true);
    await onboardingApp.close();
    const listed = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_list", authority: adminAuthority,
      payload: { schema_version: 1, tenant_id: company.tenant_id, limit: 20 },
    }) as { members: Array<{ source: string; membership_id: string; profile_id?: string }> };
    assert.equal(listed.members.every((member) => member.source === "company"), true);
    assert.equal(listed.members.some((member) => member.membership_id === invitation.membership_id && typeof member.profile_id === "string"), true);
    const revokeWithoutHash = {
      schema_version: 1 as const, idempotency_key: "composition-member-revoke", expected_resource_version: 1,
      membership_id: invitation.membership_id, reason_code: "administrator_revoked",
    };
    const revoked = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_revoke", authority: adminAuthority,
      payload: { ...revokeWithoutHash, payload_hash: canonicalPayloadHash(revokeWithoutHash) },
    });
    const revokeReplay = await operations.executeProtectedAuthorityCommand({
      kind: "company_member_revoke", authority: adminAuthority,
      payload: { ...revokeWithoutHash, payload_hash: canonicalPayloadHash(revokeWithoutHash) },
    });
    assert.deepEqual(revokeReplay, revoked);

    const resetSiblingSession = await issueCoreSession({ db }, {
      sessionId: "session_composition_password_reset_sibling", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "macos",
    });
    let providerPasswordUpdates = 0;
    let resetProviderFailure: string | undefined;
    let resetGatewayNow = new Date();
    let resetAuthorizationExpiresAt = "";
    const resetTransactionId = "oauth_composition_password_reset";
    const resetState = "composition-password-reset-state";
    const resetProvider: AuthProviderAdapter = {
      ...provider,
      async beginPasswordReset() {
        const now = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
        await pool.query(`insert into oauth_transactions (
          oauth_transaction_id, provider, flow_kind, actor_id, client_kind, state_digest, nonce_digest,
          pkce_verifier_ciphertext, redirect_uri, status, expires_at, consumed_at, created_at, updated_at,
          provider_completion_status, provider_completion_started_at, expected_provider_subject_ciphertext,
          provider_subject_ciphertext, provider_completion_payload_hash, provider_settlement_expires_at,
          provider_completed_at, provider_evidence_at
        ) values ($1, 'supabase', 'password_reset', null, 'web', $2, $3, $4, $5, 'pending',
          $6, null, $7, $7, 'pending', null, $8, null, null, null, null, null)`, [
          resetTransactionId, Buffer.alloc(32, 0x61), Buffer.alloc(32, 0x62),
          Buffer.alloc(33, 0x63), onboardingConfig.passwordResetRedirectUri,
          new Date(now.getTime() + 5 * 60_000), now, Buffer.alloc(33, 0x64),
        ]);
        resetGatewayNow = now;
        resetAuthorizationExpiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
        return { transaction_id: resetTransactionId, state: resetState, expires_at: resetAuthorizationExpiresAt };
      },
      async completePasswordReset(input) {
        try {
          const current = (await pool.query<{ provider_completion_status: string }>(
            "select provider_completion_status from oauth_transactions where oauth_transaction_id = $1",
            [resetTransactionId],
          )).rows[0];
          if (current?.provider_completion_status === "pending") {
            const startedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
            await pool.query(`update oauth_transactions set provider_completion_status = 'provider_started',
              provider_completion_started_at = $2, provider_subject_ciphertext = expected_provider_subject_ciphertext,
              provider_completion_payload_hash = $3, provider_settlement_expires_at = $2::timestamptz + interval '30 minutes',
              updated_at = $2 where oauth_transaction_id = $1`, [resetTransactionId, startedAt, input.payloadHash]);
            providerPasswordUpdates += 1;
            const completedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
            await pool.query(`update oauth_transactions set provider_completion_status = 'provider_completed',
              provider_completed_at = $2, provider_evidence_at = $2, updated_at = $2
              where oauth_transaction_id = $1`, [resetTransactionId, completedAt]);
          }
        } catch (error) {
          resetProviderFailure = error instanceof Error ? error.message : String(error);
          throw error;
        }
        return verifiedSubject;
      },
    };
    let failResetCoreOnce = true;
    const resetApp = await buildIdentityGatewayApp({
      config: onboardingConfig, provider: resetProvider, flowCookieKey: Buffer.alloc(32, 0x6a),
      operations: {
        ...operations,
        async executeAuthorityCommand(input) {
          if (input.kind === "password_reset_completed" && failResetCoreOnce) {
            failResetCoreOnce = false;
            throw new Error("simulated post-provider Core rollback");
          }
          return operations.executeAuthorityCommand(input);
        },
      },
      now: () => resetGatewayNow,
    });
    const resetStart = await resetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/start", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-password-reset-start",
        payload_hash: `sha256:${"8".repeat(64)}`, email: verifiedSubject.normalizedEmail,
      },
    });
    assert.equal(resetStart.statusCode, 202, resetStart.body);
    const recoveryCookie = ([] as string[]).concat(resetStart.headers["set-cookie"] ?? [])
      .find((value) => value.startsWith("core_agent_recovery="))!.split(";", 1)[0]!;
    const resetFacts = {
      schema_version: 1 as const, idempotency_key: "composition-password-reset-complete",
      authorization_code: "composition-reset-code", new_password: "replacement-password-value",
    };
    const resetPayload = {
      ...resetFacts,
      payload_hash: canonicalPayloadHash({
        schema_version: resetFacts.schema_version, idempotency_key: resetFacts.idempotency_key,
        reset_code_digest: sensitiveDigest(resetFacts.authorization_code),
        new_value_digest: sensitiveDigest(resetFacts.new_password),
      }),
    };
    const failedReset = await resetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...publicHeaders, cookie: recoveryCookie }, payload: resetPayload,
    });
    assert.equal(failedReset.statusCode, 500, failedReset.body);
    assert.doesNotMatch(String(failedReset.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerPasswordUpdates, 1, resetProviderFailure ?? "provider password update did not run");
    assert.equal((await pool.query(
      "select status from core_sessions where session_id = $1", [resetSiblingSession.session.session_id],
    )).rows[0]?.status, "active");
    resetGatewayNow = new Date(Date.parse(resetAuthorizationExpiresAt) + 1);
    const completedReset = await resetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...publicHeaders, cookie: recoveryCookie }, payload: resetPayload,
    });
    assert.equal(completedReset.statusCode, 200, completedReset.body);
    assert.match(String(completedReset.headers["set-cookie"]), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerPasswordUpdates, 1, "Core retry must resume the provider-completed checkpoint");
    assert.equal((await pool.query(
      "select status from core_sessions where session_id = any($1::text[]) order by session_id",
      [[issued.session.session_id, resetSiblingSession.session.session_id]],
    )).rows.every((row) => row.status === "revoked"), true);
    assert.equal((await pool.query(
      "select status from oauth_transactions where oauth_transaction_id = $1", [resetTransactionId],
    )).rows[0]?.status, "consumed");
    await resetApp.close();

    const expiredResetTransactionId = "oauth_composition_password_reset_expired_settlement";
    const expiredResetState = "composition-password-reset-expired-state";
    const expiredResetNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    const expiredAuthorizationAt = new Date(expiredResetNow.getTime() - 31 * 60_000);
    const expiredProviderCompletedAt = new Date(expiredAuthorizationAt.getTime() + 60_000);
    const expiredResetFacts = {
      schema_version: 1 as const, idempotency_key: "composition-password-reset-expired-complete",
      authorization_code: "composition-expired-reset-code", new_password: "expired-replacement-password-value",
    };
    const expiredResetPayload = {
      ...expiredResetFacts,
      payload_hash: canonicalPayloadHash({
        schema_version: expiredResetFacts.schema_version, idempotency_key: expiredResetFacts.idempotency_key,
        reset_code_digest: sensitiveDigest(expiredResetFacts.authorization_code),
        new_value_digest: sensitiveDigest(expiredResetFacts.new_password),
      }),
    };
    await pool.query(`insert into oauth_transactions (
      oauth_transaction_id, provider, flow_kind, actor_id, client_kind, state_digest, nonce_digest,
      pkce_verifier_ciphertext, redirect_uri, status, expires_at, consumed_at, created_at, updated_at,
      provider_completion_status, provider_completion_started_at, expected_provider_subject_ciphertext,
      provider_subject_ciphertext, provider_completion_payload_hash, provider_settlement_expires_at,
      provider_completed_at, provider_evidence_at
    ) values ($1, 'supabase', 'password_reset', null, 'web', $2, $3, $4, $5, 'pending',
      $6, null, $6, $7, 'provider_completed', $6, $8, $9, $10, $6::timestamptz + interval '30 minutes',
      $7, $7)`, [
      expiredResetTransactionId, createHash("sha256").update(expiredResetState, "utf8").digest(),
      Buffer.alloc(32, 0x71), Buffer.alloc(33, 0x72), onboardingConfig.passwordResetRedirectUri,
      expiredAuthorizationAt, expiredProviderCompletedAt, Buffer.alloc(33, 0x73), Buffer.alloc(33, 0x74),
      expiredResetPayload.payload_hash,
    ]);
    const expiredFlowKey = Buffer.alloc(32, 0x75);
    const expiredRecoveryCookie = sealRecoveryCookie(expiredFlowKey, {
      transactionId: expiredResetTransactionId, state: expiredResetState,
      expiresAt: expiredAuthorizationAt.toISOString(),
    });
    let expiredProviderCalls = 0;
    const expiredResetApp = await buildIdentityGatewayApp({
      config: onboardingConfig,
      provider: {
        ...provider,
        async completePasswordReset() {
          expiredProviderCalls += 1;
          return verifiedSubject;
        },
      },
      operations, flowCookieKey: expiredFlowKey, now: () => expiredResetNow,
    });
    const expiredSettlement = await expiredResetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...publicHeaders, cookie: `core_agent_recovery=${expiredRecoveryCookie}` },
      payload: expiredResetPayload,
    });
    assert.equal(expiredSettlement.statusCode, 401, expiredSettlement.body);
    assert.equal(expiredProviderCalls, 1, "signed expired settlement must reach durable Core terminalization");
    assert.match(String(expiredSettlement.headers["set-cookie"]), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.deepEqual((await pool.query(`select status, provider_completion_status,
      provider_completion_started_at, expected_provider_subject_ciphertext,
      provider_subject_ciphertext, provider_completion_payload_hash,
      provider_settlement_expires_at, provider_completed_at, provider_evidence_at
      from oauth_transactions where oauth_transaction_id = $1`, [expiredResetTransactionId])).rows[0], {
      status: "expired", provider_completion_status: "pending", provider_completion_started_at: null,
      expected_provider_subject_ciphertext: null, provider_subject_ciphertext: null,
      provider_completion_payload_hash: null, provider_settlement_expires_at: null,
      provider_completed_at: null, provider_evidence_at: null,
    });
    await expiredResetApp.close();

    const concurrentSession = await issueCoreSession({ db }, {
      sessionId: "session_composition_password_reset_concurrent", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "iphone",
    });
    const concurrentTransactionId = "oauth_composition_password_reset_concurrent";
    const concurrentState = "composition-password-reset-concurrent-state";
    let concurrentNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    let releaseWinner!: () => void;
    let markWinnerStarted!: () => void;
    const winnerRelease = new Promise<void>((resolve) => { releaseWinner = resolve; });
    const winnerStarted = new Promise<void>((resolve) => { markWinnerStarted = resolve; });
    let concurrentProviderEffects = 0;
    const concurrentProvider: AuthProviderAdapter = {
      ...provider,
      async beginPasswordReset() {
        const expiresAt = new Date(concurrentNow.getTime() + 5 * 60_000);
        await pool.query(`insert into oauth_transactions (
          oauth_transaction_id, provider, flow_kind, actor_id, client_kind, state_digest, nonce_digest,
          pkce_verifier_ciphertext, redirect_uri, status, expires_at, consumed_at, created_at, updated_at,
          provider_completion_status, provider_completion_started_at, expected_provider_subject_ciphertext,
          provider_subject_ciphertext, provider_completion_payload_hash, provider_settlement_expires_at,
          provider_completed_at, provider_evidence_at
        ) values ($1, 'supabase', 'password_reset', null, 'web', $2, $3, $4, $5, 'pending',
          $6, null, $7, $7, 'pending', null, $8, null, null, null, null, null)`, [
          concurrentTransactionId, createHash("sha256").update(concurrentState, "utf8").digest(),
          Buffer.alloc(32, 0x76), Buffer.alloc(33, 0x77), onboardingConfig.passwordResetRedirectUri,
          expiresAt, concurrentNow, Buffer.alloc(33, 0x78),
        ]);
        return { transaction_id: concurrentTransactionId, state: concurrentState, expires_at: expiresAt.toISOString() };
      },
      async completePasswordReset(input) {
        const client = await pool.connect();
        let disposition: "winner" | "in_progress" | "completed";
        try {
          await client.query("begin");
          const row = (await client.query<{ provider_completion_status: string }>(
            "select provider_completion_status from oauth_transactions where oauth_transaction_id = $1 for update",
            [concurrentTransactionId],
          )).rows[0];
          if (row?.provider_completion_status === "pending") {
            const startedAt = (await client.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
            await client.query(`update oauth_transactions set provider_completion_status = 'provider_started',
              provider_completion_started_at = $2, provider_subject_ciphertext = expected_provider_subject_ciphertext,
              provider_completion_payload_hash = $3, provider_settlement_expires_at = $2::timestamptz + interval '30 minutes',
              updated_at = $2 where oauth_transaction_id = $1`, [concurrentTransactionId, startedAt, input.payloadHash]);
            disposition = "winner";
          } else if (row?.provider_completion_status === "provider_started") {
            disposition = "in_progress";
          } else if (row?.provider_completion_status === "provider_completed") {
            disposition = "completed";
          } else {
            throw new ProviderFailure("AUTH_CALLBACK_INVALID");
          }
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
        if (disposition === "in_progress") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        if (disposition === "completed") return verifiedSubject;
        markWinnerStarted();
        await winnerRelease;
        concurrentProviderEffects += 1;
        const completedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
        await pool.query(`update oauth_transactions set provider_completion_status = 'provider_completed',
          provider_completed_at = $2, provider_evidence_at = $2, updated_at = $2
          where oauth_transaction_id = $1`, [concurrentTransactionId, completedAt]);
        return verifiedSubject;
      },
    };
    let failConcurrentCoreOnce = true;
    const concurrentResetApp = await buildIdentityGatewayApp({
      config: onboardingConfig, provider: concurrentProvider, flowCookieKey: Buffer.alloc(32, 0x79),
      operations: {
        ...operations,
        async executeAuthorityCommand(input) {
          if (input.kind === "password_reset_completed" && failConcurrentCoreOnce) {
            failConcurrentCoreOnce = false;
            throw new Error("simulated concurrent winner Core rollback");
          }
          return operations.executeAuthorityCommand(input);
        },
      },
      now: () => concurrentNow,
    });
    const concurrentResetStartResponse = await concurrentResetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/start", headers: publicHeaders,
      payload: {
        schema_version: 1, idempotency_key: "composition-password-reset-concurrent-start",
        payload_hash: `sha256:${"9".repeat(64)}`, email: verifiedSubject.normalizedEmail,
      },
    });
    assert.equal(concurrentResetStartResponse.statusCode, 202, concurrentResetStartResponse.body);
    const concurrentCookie = ([] as string[]).concat(concurrentResetStartResponse.headers["set-cookie"] ?? [])
      .find((value) => value.startsWith("core_agent_recovery="))!.split(";", 1)[0]!;
    const concurrentFacts = {
      schema_version: 1 as const, idempotency_key: "composition-password-reset-concurrent-complete",
      authorization_code: "composition-concurrent-reset-code", new_password: "concurrent-replacement-password-value",
    };
    const concurrentPayload = {
      ...concurrentFacts,
      payload_hash: canonicalPayloadHash({
        schema_version: concurrentFacts.schema_version, idempotency_key: concurrentFacts.idempotency_key,
        reset_code_digest: sensitiveDigest(concurrentFacts.authorization_code),
        new_value_digest: sensitiveDigest(concurrentFacts.new_password),
      }),
    };
    const winnerRequest = concurrentResetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...publicHeaders, cookie: concurrentCookie }, payload: concurrentPayload,
    });
    await winnerStarted;
    const loserResponse = await concurrentResetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...publicHeaders, cookie: concurrentCookie }, payload: concurrentPayload,
    });
    assert.equal(loserResponse.statusCode, 503, loserResponse.body);
    assert.doesNotMatch(String(loserResponse.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(concurrentProviderEffects, 0);
    releaseWinner();
    const winnerResponse = await winnerRequest;
    assert.equal(winnerResponse.statusCode, 500, winnerResponse.body);
    assert.doesNotMatch(String(winnerResponse.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(concurrentProviderEffects, 1);
    assert.equal((await pool.query("select status from core_sessions where session_id = $1",
      [concurrentSession.session.session_id])).rows[0]?.status, "active");
    concurrentNow = new Date(concurrentNow.getTime() + 1_000);
    const loserRetry = await concurrentResetApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...publicHeaders, cookie: concurrentCookie }, payload: concurrentPayload,
    });
    assert.equal(loserRetry.statusCode, 200, loserRetry.body);
    assert.equal(concurrentProviderEffects, 1);
    assert.equal((await pool.query("select status from core_sessions where session_id = $1",
      [concurrentSession.session.session_id])).rows[0]?.status, "revoked");
    assert.equal((await pool.query("select status from oauth_transactions where oauth_transaction_id = $1",
      [concurrentTransactionId])).rows[0]?.status, "consumed");
    await concurrentResetApp.close();

    const secretDirectory = await mkdtemp(join(tmpdir(), "identity-gateway-secrets-"));
    try {
      const writeSecret = async (name: string, value: string) => {
        const path = join(secretDirectory, name);
        await writeFile(path, value, { mode: 0o600 });
        await chmod(path, 0o600);
        return path;
      };
      const environment = {
        IDENTITY_DATABASE_URL: databaseUrl,
        IDENTITY_PUBLIC_ORIGINS: "https://app.example.test",
        IDENTITY_COOKIE_HOST: "identity.example.test",
        IDENTITY_PUBLIC_BASE_URL: "https://identity.example.test",
        IDENTITY_PROVIDER_URL: "https://provider.example.test",
        IDENTITY_PROVIDER_PUBLISHABLE_KEY_REF: await writeSecret("publishable", "publishable-test-key"),
        IDENTITY_PROVIDER_SERVICE_ROLE_KEY_REF: await writeSecret("service", "service-role-test-key"),
        IDENTITY_APPLE_WEB_REDIRECT_URIS: "https://app.example.test/auth/apple/callback",
        IDENTITY_APPLE_NATIVE_REDIRECT_URIS: "coreagent://auth/apple/callback",
        IDENTITY_PASSWORD_RESET_REDIRECT_URI: "https://app.example.test/auth/password/reset/callback",
        IDENTITY_EMAIL_VERIFICATION_REDIRECT_URI: "https://identity.example.test/auth/v1/email/verification",
        IDENTITY_SESSION_HMAC_KEY_REF: await writeSecret("session", "s".repeat(32)),
        IDENTITY_PII_HMAC_KEY_REF: await writeSecret("pii", "p".repeat(32)),
        IDENTITY_SIGNING_KEY_REF: await writeSecret("signing", "k".repeat(32)),
        IDENTITY_GATEWAY_PORT: "18080",
        IDENTITY_PUBLIC_AUTH_ENABLED: "1",
      } satisfies NodeJS.ProcessEnv;
      const app = await buildProductionIdentityGateway({ environment });
      const response = await app.inject({ method: "GET", url: "/auth/v1/session", headers: { host: "identity.example.test", origin: "https://app.example.test" } });
      assert.equal(response.statusCode, 401);
      await app.close();
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  } finally {
    await db.destroy();
  }
});

test("production Fastify and Supabase adapter defer provider-started reset settlement to the PostgreSQL clock", async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = createRuntimeDatabase(pool);
  await pool.query("drop schema public cascade; create schema public");
  await applyMigrations(pool, migrations);
  const key = Buffer.alloc(32, 0x7a);
  const piiProtector = identityGatewayServerTestInternals.aesProtector(key, "round-nine-private-pii");
  const providerStore = identityGatewayServerTestInternals.oauthStore(db);
  const providerProtector = identityGatewayServerTestInternals.aesProtector(Buffer.alloc(32, 0x7b), "oauth-transaction");
  const operations = identityGatewayServerTestInternals.productionOperations(db, key, piiProtector, providerProtector);
  const flowCookieKey = Buffer.alloc(32, 0x7c);
  const normalizedEmail = "round-nine-reset@example.test";
  const providerSubject = "provider_round_nine_reset";
  let gatewayNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
  let observedProviderSubject = providerSubject;
  let observedProviderEmail = normalizedEmail;
  let providerEvidenceAt: unknown = "2020-01-01T00:00:00.000Z";
  let providerUpdates = 0;
  let providerInspections = 0;
  let providerExchanges = 0;
  let failResetCheckpointOnce = false;
  let inspectionOverrides: Array<{ readonly providerSubject?: string; readonly normalizedEmail?: string; readonly updatedAt?: unknown }> = [];
  let blockExchange = false;
  let releaseExchange!: () => void;
  let signalExchangeStarted!: () => void;
  let exchangeRelease = Promise.resolve();
  let exchangeStarted = Promise.resolve();
  const resetBarrier = () => {
    blockExchange = true;
    exchangeRelease = new Promise<void>((resolve) => { releaseExchange = resolve; });
    exchangeStarted = new Promise<void>((resolve) => { signalExchangeStarted = resolve; });
  };
  const providerUser = (updatedAt: unknown) => ({
    id: observedProviderSubject,
    email: observedProviderEmail,
    email_confirmed_at: "2026-08-01T00:00:00.000Z",
    updated_at: updatedAt,
    app_metadata: { provider: "email" },
  });
  const clientFactory: SupabaseClientFactory = (_url, _key, options) => {
    const authOptions = (options as { readonly auth: {
      readonly storageKey: string;
      readonly storage: {
        getItem(key: string): Promise<string | null> | string | null;
        setItem(key: string, value: string): Promise<void> | void;
      };
    } }).auth;
    return { auth: {
      async resetPasswordForEmail() {
        await authOptions.storage.setItem(`${authOptions.storageKey}-flows-code-verifier`, JSON.stringify(["roundnineflow"]));
        await authOptions.storage.setItem(
          `${authOptions.storageKey}-flow-roundnineflow-code-verifier`, JSON.stringify(`${"r".repeat(43)}/recovery`),
        );
        return { data: {}, error: null };
      },
      async exchangeCodeForSession() {
        providerExchanges += 1;
        if (blockExchange) {
          signalExchangeStarted();
          await exchangeRelease;
          blockExchange = false;
        }
        return { data: {
          user: providerUser(providerEvidenceAt),
          session: { access_token: "provider-access-not-returned", refresh_token: "provider-refresh-not-returned" },
        }, error: null };
      },
      admin: {
        async updateUserById() {
          providerUpdates += 1;
          observedProviderSubject = providerSubject;
          observedProviderEmail = normalizedEmail;
          const updatedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now.toISOString();
          providerEvidenceAt = updatedAt;
          gatewayNow = new Date(updatedAt);
          return { data: { user: providerUser(providerEvidenceAt) }, error: null };
        },
        async getUserById() {
          providerInspections += 1;
          const override = inspectionOverrides.shift();
          return { data: { user: {
            ...providerUser(override?.updatedAt ?? providerEvidenceAt),
            ...(override?.providerSubject === undefined ? {} : { id: override.providerSubject }),
            ...(override?.normalizedEmail === undefined ? {} : { email: override.normalizedEmail }),
          } }, error: null };
        },
      },
    } } as never;
  };
  const providerTransactionStore = {
    ...providerStore,
    async checkpointPasswordResetCompletion(input: { readonly transactionId: string; readonly providerEvidenceAt: string }) {
      if (failResetCheckpointOnce) {
        failResetCheckpointOnce = false;
        throw new Error("forced provider checkpoint failure");
      }
      return providerStore.checkpointPasswordResetCompletion!(input);
    },
  };
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://provider.example.test",
    publishableKey: "round-nine-publishable-key",
    serviceRoleKey: "round-nine-service-role-key",
    appleRedirectUris: ["https://app.example.test/auth/apple/callback", "coreagent://auth/apple/callback"],
    passwordResetRedirectUri: "https://app.example.test/auth/password/reset/callback",
    emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: providerTransactionStore,
    transactionProtector: providerProtector,
    createClient: clientFactory,
    now: () => new Date(gatewayNow),
    randomBytes: (length) => Uint8Array.from({ length }, (_, index) => (index + 17) % 256),
  });
  const config = {
    publicOrigins: new Set(["https://app.example.test"]), cookieHost: "identity.example.test",
    publicBaseUrl: "https://identity.example.test", providerUrl: "https://provider.example.test",
    appleWebRedirectUris: new Set(["https://app.example.test/auth/apple/callback"]),
    appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]),
    passwordResetRedirectUri: "https://app.example.test/auth/password/reset/callback",
    publicAuthEnabled: true,
  };
  const headers = {
    host: "identity.example.test", origin: "https://app.example.test", "content-type": "application/json",
  };
  const completionPayload = (idempotencyKey: string) => {
    const facts = {
      schema_version: 1 as const, idempotency_key: idempotencyKey,
      authorization_code: "round-nine-one-time-code", new_password: "round-nine-replacement-password",
    };
    return {
      ...facts,
      payload_hash: canonicalPayloadHash({
        schema_version: facts.schema_version, idempotency_key: facts.idempotency_key,
        reset_code_digest: sensitiveDigest(facts.authorization_code),
        new_value_digest: sensitiveDigest(facts.new_password),
      }),
    };
  };
  const startProviderReset = async (idempotencyKey: string) => {
    const expectedSubject = await operations.preparePasswordReset(normalizedEmail);
    const binding = await provider.beginPasswordReset({
      email: normalizedEmail, idempotencyKey,
      payloadHash: canonicalProviderStartPayloadHash({ flowKind: "password_reset", idempotencyKey, normalizedEmail }),
      expectedSubject,
    });
    return {
      binding,
      cookie: `core_agent_recovery=${sealRecoveryCookie(flowCookieKey, {
        transactionId: binding.transaction_id, state: binding.state, expiresAt: binding.expires_at,
      })}`,
    };
  };
  try {
    const verification = await operations.beginEmailVerification({
      idempotencyKey: "round-nine-registration", payloadHash: canonicalEmailVerificationStartPayloadHash({
        idempotencyKey: "round-nine-registration", normalizedEmail, clientKind: "web", flowKind: "b2c",
      }), normalizedEmail, clientKind: "web",
    });
    await operations.finalizeEmailVerificationStart({
      verificationId: verification.verificationId, outcome: "finalized", expectedProviderSubject: providerSubject,
    });
    await operations.admitEmailVerificationProviderAttempt({
      verificationId: verification.verificationId, verificationProofDigest: `sha256:${"d".repeat(64)}`,
    });
    gatewayNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    const verifiedSubject = {
      provider: "supabase" as const, providerSubject, identityKind: "email_password" as const,
      normalizedEmail, verifiedAt: gatewayNow.toISOString(),
    };
    await operations.checkpointEmailVerification({ verificationId: verification.verificationId, verifiedSubject });
    const registered = await operations.completeEmailVerification({
      verificationId: verification.verificationId,
      idempotencyKey: "round-nine-registration-session", payloadHash: `sha256:${"e".repeat(64)}`,
    });

    const concurrentSession = await issueCoreSession({ db }, {
      sessionId: "session_round_nine_concurrent", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "iphone",
    });
    const concurrentPayload = completionPayload("round-nine-concurrent-completion");
    const concurrentStart = await startProviderReset("round-nine-concurrent-start");
    let failCoreOnce = true;
    const concurrentApp = await buildIdentityGatewayApp({
      config, provider, flowCookieKey, now: () => new Date(gatewayNow),
      operations: {
        ...operations,
        async executeAuthorityCommand(input) {
          if (input.kind === "password_reset_completed" && failCoreOnce) {
            failCoreOnce = false;
            throw new Error("forced round-nine post-provider Core rollback");
          }
          return operations.executeAuthorityCommand(input);
        },
      },
    });
    resetBarrier();
    const winnerRequest = concurrentApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...headers, cookie: concurrentStart.cookie }, payload: concurrentPayload,
    });
    await exchangeStarted;
    gatewayNow = new Date((await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now.getTime() + 30_001);
    const loser = await concurrentApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...headers, cookie: concurrentStart.cookie }, payload: concurrentPayload,
    });
    assert.equal(loser.statusCode, 503, loser.body);
    assert.doesNotMatch(String(loser.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerUpdates, 0);
    releaseExchange();
    const winner = await winnerRequest;
    assert.equal(winner.statusCode, 500, winner.body);
    assert.doesNotMatch(String(winner.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerExchanges, 1);
    assert.equal(providerUpdates, 1);
    assert.equal((await pool.query("select status from core_sessions where session_id = $1", [concurrentSession.session.session_id])).rows[0]?.status, "active");
    const loserRetry = await concurrentApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete",
      headers: { ...headers, cookie: concurrentStart.cookie }, payload: concurrentPayload,
    });
    assert.equal(loserRetry.statusCode, 200, loserRetry.body);
    assert.equal(providerExchanges, 1);
    assert.equal(providerUpdates, 1);
    assert.equal((await pool.query("select status from core_sessions where session_id = $1", [concurrentSession.session.session_id])).rows[0]?.status, "revoked");
    assert.equal((await pool.query("select status from oauth_transactions where oauth_transaction_id = $1", [concurrentStart.binding.transaction_id])).rows[0]?.status, "consumed");
    assert.equal(providerInspections >= 1, true);
    await concurrentApp.close();

    const exactRaceSession = await issueCoreSession({ db }, {
      sessionId: "session_round_twelve_exact_race", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "iphone",
    });
    gatewayNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    const exactRacePayload = completionPayload("round-twelve-exact-race-completion");
    const exactRaceStart = await startProviderReset("round-twelve-exact-race-start");
    const exactEffectsBefore = { exchanges: providerExchanges, updates: providerUpdates };
    failResetCheckpointOnce = true;
    const exactPrimeApp = await buildIdentityGatewayApp({ config, provider, operations, flowCookieKey, now: () => new Date(gatewayNow) });
    const exactPrime = await exactPrimeApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete", remoteAddress: "198.51.100.41",
      headers: { ...headers, cookie: exactRaceStart.cookie }, payload: exactRacePayload,
    });
    assert.equal(exactPrime.statusCode, 503, exactPrime.body);
    assert.doesNotMatch(String(exactPrime.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerExchanges, exactEffectsBefore.exchanges + 1);
    assert.equal(providerUpdates, exactEffectsBefore.updates + 1);
    assert.equal((await pool.query(
      "select provider_completion_status from oauth_transactions where oauth_transaction_id = $1",
      [exactRaceStart.binding.transaction_id],
    )).rows[0]?.provider_completion_status, "provider_started");
    await exactPrimeApp.close();

    let exactObservationArrivals = 0;
    let releaseFirstExactObservation!: () => void;
    const bothExactObservations = new Promise<void>((resolve) => { releaseFirstExactObservation = resolve; });
    let releaseExactLoser!: () => void;
    const exactWinnerCoreFailed = new Promise<void>((resolve) => { releaseExactLoser = resolve; });
    let failExactWinnerCore = true;
    const exactRaceApp = await buildIdentityGatewayApp({
      config, provider, flowCookieKey, now: () => new Date(gatewayNow),
      operations: {
        ...operations,
        async executeAuthorityCommand(input) {
          if (input.kind === "password_reset_provider_observation") {
            exactObservationArrivals += 1;
            if (exactObservationArrivals === 1) {
              await bothExactObservations;
              return operations.executeAuthorityCommand(input);
            }
            releaseFirstExactObservation();
            await exactWinnerCoreFailed;
            return operations.executeAuthorityCommand(input);
          }
          if (input.kind === "password_reset_completed" && failExactWinnerCore) {
            failExactWinnerCore = false;
            releaseExactLoser();
            throw new Error("forced round-twelve exact winner Core rollback");
          }
          return operations.executeAuthorityCommand(input);
        },
      },
    });
    const exactRaceResponses = await Promise.all([
      exactRaceApp.inject({
        method: "POST", url: "/auth/v1/password/reset/complete", remoteAddress: "198.51.100.41",
        headers: { ...headers, cookie: exactRaceStart.cookie }, payload: exactRacePayload,
      }),
      exactRaceApp.inject({
        method: "POST", url: "/auth/v1/password/reset/complete", remoteAddress: "198.51.100.41",
        headers: { ...headers, cookie: exactRaceStart.cookie }, payload: exactRacePayload,
      }),
    ]);
    assert.deepEqual(exactRaceResponses.map((response) => response.statusCode).sort(), [200, 500]);
    const exactWinner = exactRaceResponses.find((response) => response.statusCode === 500)!;
    const exactLoser = exactRaceResponses.find((response) => response.statusCode === 200)!;
    assert.doesNotMatch(String(exactWinner.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.match(String(exactLoser.headers["set-cookie"]), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerExchanges, exactEffectsBefore.exchanges + 1);
    assert.equal(providerUpdates, exactEffectsBefore.updates + 1);
    assert.equal((await pool.query("select status from core_sessions where session_id = $1", [exactRaceSession.session.session_id])).rows[0]?.status, "revoked");
    assert.equal((await pool.query("select status from oauth_transactions where oauth_transaction_id = $1", [exactRaceStart.binding.transaction_id])).rows[0]?.status, "consumed");
    await exactRaceApp.close();

    const invalidRaceSession = await issueCoreSession({ db }, {
      sessionId: "session_round_twelve_invalid_race", actorId: registered.actorId,
      authSubjectId: registered.authSubjectId, clientKind: "iphone",
    });
    gatewayNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
    const invalidRacePayload = completionPayload("round-twelve-invalid-race-completion");
    const invalidRaceStart = await startProviderReset("round-twelve-invalid-race-start");
    const invalidEffectsBefore = { exchanges: providerExchanges, updates: providerUpdates };
    failResetCheckpointOnce = true;
    const invalidPrimeApp = await buildIdentityGatewayApp({ config, provider, operations, flowCookieKey, now: () => new Date(gatewayNow) });
    const invalidPrime = await invalidPrimeApp.inject({
      method: "POST", url: "/auth/v1/password/reset/complete", remoteAddress: "198.51.100.42",
      headers: { ...headers, cookie: invalidRaceStart.cookie }, payload: invalidRacePayload,
    });
    assert.equal(invalidPrime.statusCode, 503, invalidPrime.body);
    assert.equal(providerExchanges, invalidEffectsBefore.exchanges + 1);
    assert.equal(providerUpdates, invalidEffectsBefore.updates + 1);
    await invalidPrimeApp.close();

    inspectionOverrides = [{}, { providerSubject: "mismatched-concurrent-provider-subject" }];
    let invalidObservationArrived!: () => void;
    const waitForInvalidObservation = new Promise<void>((resolve) => { invalidObservationArrived = resolve; });
    let releaseInvalidObservation!: () => void;
    const invalidWinnerCoreFailed = new Promise<void>((resolve) => { releaseInvalidObservation = resolve; });
    let failInvalidWinnerCore = true;
    const invalidRaceApp = await buildIdentityGatewayApp({
      config, provider, flowCookieKey, now: () => new Date(gatewayNow),
      operations: {
        ...operations,
        async executeAuthorityCommand(input) {
          if (input.kind === "password_reset_provider_observation" && input.passwordResetObservation?.outcome === "exact") {
            await waitForInvalidObservation;
            return operations.executeAuthorityCommand(input);
          }
          if (input.kind === "password_reset_provider_observation" && input.passwordResetObservation?.outcome === "invalid") {
            invalidObservationArrived();
            await invalidWinnerCoreFailed;
            return operations.executeAuthorityCommand(input);
          }
          if (input.kind === "password_reset_completed" && failInvalidWinnerCore) {
            failInvalidWinnerCore = false;
            releaseInvalidObservation();
            throw new Error("forced round-twelve invalid winner Core rollback");
          }
          return operations.executeAuthorityCommand(input);
        },
      },
    });
    const invalidRaceResponses = await Promise.all([
      invalidRaceApp.inject({
        method: "POST", url: "/auth/v1/password/reset/complete", remoteAddress: "198.51.100.42",
        headers: { ...headers, cookie: invalidRaceStart.cookie }, payload: invalidRacePayload,
      }),
      invalidRaceApp.inject({
        method: "POST", url: "/auth/v1/password/reset/complete", remoteAddress: "198.51.100.42",
        headers: { ...headers, cookie: invalidRaceStart.cookie }, payload: invalidRacePayload,
      }),
    ]);
    assert.deepEqual(invalidRaceResponses.map((response) => response.statusCode).sort(), [401, 500]);
    assert.match(String(invalidRaceResponses.find((response) => response.statusCode === 401)!.headers["set-cookie"]), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.doesNotMatch(String(invalidRaceResponses.find((response) => response.statusCode === 500)!.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
    assert.equal(providerExchanges, invalidEffectsBefore.exchanges + 1);
    assert.equal(providerUpdates, invalidEffectsBefore.updates + 1);
    assert.equal((await pool.query("select status from core_sessions where session_id = $1", [invalidRaceSession.session.session_id])).rows[0]?.status, "active");
    assert.deepEqual((await pool.query(
      "select status, provider_completion_status from oauth_transactions where oauth_transaction_id = $1",
      [invalidRaceStart.binding.transaction_id],
    )).rows[0], { status: "pending", provider_completion_status: "provider_completed" });
    await invalidRaceApp.close();

    const observationCases = [
      { name: "valid", expired: false, observation: "valid", statusCode: 200, rowStatus: "consumed" },
      { name: "old", expired: false, observation: "old", statusCode: 503, rowStatus: "pending" },
      { name: "future", expired: false, observation: "future", statusCode: 401, rowStatus: "pending" },
      { name: "malformed", expired: false, observation: "malformed", statusCode: 401, rowStatus: "pending" },
      { name: "subject-mismatch", expired: false, observation: "subject-mismatch", statusCode: 401, rowStatus: "pending" },
      { name: "email-mismatch", expired: false, observation: "email-mismatch", statusCode: 401, rowStatus: "pending" },
      { name: "expired-valid", expired: true, observation: "valid", statusCode: 401, rowStatus: "expired" },
      { name: "expired-old", expired: true, observation: "old", statusCode: 401, rowStatus: "expired" },
      { name: "expired-future", expired: true, observation: "future", statusCode: 401, rowStatus: "expired" },
      { name: "expired-malformed", expired: true, observation: "malformed", statusCode: 401, rowStatus: "expired" },
      { name: "expired-subject-mismatch", expired: true, observation: "subject-mismatch", statusCode: 401, rowStatus: "expired" },
      { name: "expired-email-mismatch", expired: true, observation: "email-mismatch", statusCode: 401, rowStatus: "expired" },
    ] as const;
    for (const testCase of observationCases) {
      gatewayNow = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
      observedProviderSubject = providerSubject;
      observedProviderEmail = normalizedEmail;
      const payload = completionPayload(`round-eleven-${testCase.name}-completion`);
      const start = await startProviderReset(`round-eleven-${testCase.name}-start`);
      await providerStore.beginPasswordResetCompletion!({
        transactionId: start.binding.transaction_id,
        payloadHash: payload.payload_hash,
        settlementNotAfter: new Date(Date.parse(start.binding.expires_at) + 30 * 60_000).toISOString(),
      });
      if (testCase.expired) {
        await pool.query(`with bounds as (select clock_timestamp() - interval '31 minutes' as started_at)
          update oauth_transactions set provider_completion_started_at = bounds.started_at,
            provider_settlement_expires_at = bounds.started_at + interval '30 minutes', updated_at = bounds.started_at
          from bounds where oauth_transaction_id = $1`, [start.binding.transaction_id]);
      }
      const clock = (await pool.query<{
        provider_completion_started_at: Date; provider_settlement_expires_at: Date; now: Date;
      }>(`select provider_completion_started_at, provider_settlement_expires_at,
        clock_timestamp() as now from oauth_transactions where oauth_transaction_id = $1`,
      [start.binding.transaction_id])).rows[0]!;
      if (testCase.observation === "old") {
        providerEvidenceAt = new Date(clock.provider_completion_started_at.getTime() - 1).toISOString();
      } else if (testCase.observation === "future") {
        providerEvidenceAt = new Date(clock.now.getTime() + 60 * 60_000).toISOString();
      } else if (testCase.observation === "malformed") {
        providerEvidenceAt = "not-a-timestamp";
      } else {
        providerEvidenceAt = clock.now.toISOString();
      }
      if (testCase.observation === "subject-mismatch") observedProviderSubject = "different-provider-subject";
      if (testCase.observation === "email-mismatch") observedProviderEmail = "different@example.test";
      gatewayNow = new Date(clock.now.getTime() - 60 * 60_000);
      const app = await buildIdentityGatewayApp({ config, provider, operations, flowCookieKey, now: () => new Date(gatewayNow) });
      try {
        const response = await app.inject({
          method: "POST", url: "/auth/v1/password/reset/complete",
          headers: { ...headers, cookie: start.cookie }, payload,
        });
        assert.equal(response.statusCode, testCase.statusCode, `${testCase.name}: ${response.body}`);
        if (testCase.statusCode === 503) {
          assert.doesNotMatch(String(response.headers["set-cookie"] ?? ""), /core_agent_recovery=;[^\n]*Max-Age=0/u);
        } else {
          assert.match(String(response.headers["set-cookie"]), /core_agent_recovery=;[^\n]*Max-Age=0/u);
        }
        const row = (await pool.query(`select status, provider_completion_status,
          provider_completion_started_at, expected_provider_subject_ciphertext, provider_subject_ciphertext,
          provider_completion_payload_hash, provider_settlement_expires_at, provider_completed_at, provider_evidence_at
          from oauth_transactions where oauth_transaction_id = $1`, [start.binding.transaction_id])).rows[0];
        assert.equal(row.status, testCase.rowStatus, testCase.name);
        if (testCase.rowStatus === "expired") {
          assert.deepEqual(row, {
            status: "expired", provider_completion_status: "pending", provider_completion_started_at: null,
            expected_provider_subject_ciphertext: null, provider_subject_ciphertext: null,
            provider_completion_payload_hash: null, provider_settlement_expires_at: null,
            provider_completed_at: null, provider_evidence_at: null,
          }, testCase.name);
        } else if (testCase.rowStatus === "pending") {
          assert.equal(row.provider_completion_status, "provider_started", testCase.name);
          assert(row.provider_subject_ciphertext instanceof Buffer, testCase.name);
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    await db.destroy();
  }
});
