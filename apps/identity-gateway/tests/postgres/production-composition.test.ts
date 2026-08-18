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
import type { AuthProviderAdapter } from "../../src/providers/auth-provider.js";
import { ProviderFailure } from "../../src/providers/provider-errors.js";
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

function reauthenticationRequest(facts: {
  readonly schema_version: 1; readonly idempotency_key: string;
  readonly expected_resource_version: number; readonly password: string;
}) {
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: facts.schema_version,
      idempotency_key: facts.idempotency_key,
      expected_resource_version: facts.expected_resource_version,
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
  const operations = identityGatewayServerTestInternals.productionOperations(db, key, protector);
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
    const verifiedSubject = {
      provider: "supabase" as const, providerSubject: "composition-provider-subject",
      identityKind: "email_password" as const, normalizedEmail: "composition@example.test",
      verifiedAt: "2026-08-18T00:00:00.000Z",
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

    const nativeProvider: AuthProviderAdapter = {
      async reauthenticatePassword(input) {
        assert.equal(input.email, verifiedSubject.normalizedEmail);
        assert.equal(input.password, "native-current-password");
        return verifiedSubject;
      },
      async reauthenticateAndBeginAppleLink(input) {
        return {
          transaction_id: `native-link-${input.client_kind}`,
          authorization_url: `https://provider.example.test/auth/v1/authorize?state=native-link-state&redirect_to=${encodeURIComponent(input.redirect_uri)}`,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
      },
      signUpEmail: async () => { throw new Error("unused provider method"); },
      recoverVerifiedEmailSubject: async () => { throw new Error("unused provider method"); },
      verifyEmail: async () => { throw new Error("unused provider method"); },
      signInEmail: async () => { throw new Error("unused provider method"); },
      beginApple: async () => { throw new Error("unused provider method"); },
      completeApple: async () => { throw new Error("unused provider method"); },
      verifyCurrentSubject: async () => { throw new Error("unused provider method"); },
      beginPasswordReset: async () => { throw new Error("unused provider method"); },
      completePasswordReset: async () => { throw new Error("unused provider method"); },
      linkApple: async () => { throw new Error("unused provider method"); },
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
    for (const clientKind of ["iphone", "macos"] as const) {
      const nativeSession = await issueCoreSession({ db }, {
        sessionId: `session_composition_native_${clientKind}`, actorId: registered.actorId,
        authSubjectId: registered.authSubjectId, clientKind,
      });
      const reauthentication = await nativeApp.inject({
        method: "POST", url: "/auth/v1/reauthenticate",
        headers: {
          host: "identity.example.test", authorization: `Bearer ${nativeSession.sessionSecret}`,
          "content-type": "application/json",
        },
        payload: reauthenticationRequest({
          schema_version: 1, idempotency_key: `composition-native-reauth-${clientKind}`,
          expected_resource_version: 1, password: "native-current-password",
        }),
      });
      assert.equal(reauthentication.statusCode, 200, reauthentication.body);
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
    }
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
      verifiedSubject: { ...verifiedSubject, providerSubject: "composition-apple-subject", identityKind: "apple" },
    });
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "apple_identity_link", authority: refreshed, payload: appleLinkPayload,
      verifiedSubject: { ...verifiedSubject, providerSubject: "composition-other-apple-subject", identityKind: "apple" },
    }), /IDEMPOTENCY_CONFLICT/u);
    assert.equal((await pool.query("select count(*)::int as count from auth_subjects where actor_id = $1 and provider_identity_kind = 'apple'", [registered.actorId])).rows[0]?.count, 1);
    const company = await operations.executeProtectedAuthorityCommand({
      kind: "company_create", authority: refreshed,
      payload: { schema_version: 1, idempotency_key: "composition-company", payload_hash: `sha256:${"b".repeat(64)}`, display_name: "Composition Company", administrator_email: "admin@example.test" },
    }) as { tenant_id: string };
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "company_create", authority: refreshed,
      payload: { schema_version: 1, idempotency_key: "composition-company", payload_hash: `sha256:${"b".repeat(64)}`, display_name: "Composition Company", administrator_email: "admin@example.test" },
    }), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, "IDEMPOTENCY_CONFLICT");
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
      [checkpointRecoverySubject.normalizedEmail, checkpointRecoverySubject],
      [domainRetrySubject.normalizedEmail, domainRetrySubject],
      ...[...lateInvalidSubjects.values()].map((subject) => [subject.normalizedEmail, subject] as const),
    ]);
    const confirmedSubjects = new Map<string, typeof onboardingSubject>();
    const usedVerificationCodes = new Set<string>();
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
        return subject;
      },
      async verifyEmail(input) {
        if (usedVerificationCodes.has(input.verificationCode)) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        verificationCalls += 1;
        const subject = lateInvalidSubjects.get(input.verificationCode)
          ?? (input.verificationCode === "concurrent-verification-code" ? concurrentOnboardingSubject
            : input.verificationCode === "checkpoint-recovery-code" ? checkpointRecoverySubject
              : input.verificationCode === "domain-retry-code" ? domainRetrySubject
                : onboardingSubject);
        if (subject.providerSubject !== input.expectedProviderSubject) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        usedVerificationCodes.add(input.verificationCode);
        confirmedSubjects.set(subject.providerSubject, subject);
        return subject;
      },
      signInEmail: unavailableProvider,
      beginApple: unavailableProvider,
      reauthenticateAndBeginAppleLink: unavailableProvider,
      completeApple: unavailableProvider,
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
    const recoveredCheckpoint = await checkpointRecoveryApp.inject({
      method: "POST", url: "/auth/v1/email/verification", headers: publicHeaders,
      payload: checkpointVerification,
    });
    assert.equal(recoveredCheckpoint.statusCode, 200, recoveredCheckpoint.body);
    assert.equal(verificationCalls, verificationCallsBeforeCheckpointRecovery + 1, "checkpoint recovery must not reuse OTP");
    assert.equal((await pool.query(
      "select count(*)::int as count from auth_subjects where provider_subject = $1",
      [checkpointRecoverySubject.providerSubject],
    )).rows[0]?.count, 1);
    await checkpointRecoveryApp.close();

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

    await operations.executeAuthorityCommand({
      kind: "password_reset_completed", payload: {}, verifiedSubject,
    });
    assert.equal((await pool.query("select status from core_sessions where session_id = $1", [issued.session.session_id])).rows[0]?.status, "revoked");

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
