import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyMigrations, canonicalPayloadHash, createRuntimeDatabase, issueCoreSession } from "@core-agent/runtime-core";
import { Pool } from "pg";

import { buildProductionIdentityGateway, identityGatewayServerTestInternals } from "../../src/server.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../packages/runtime-core/migrations");

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
      idempotencyKey: "composition-email-start", payloadHash: `sha256:${"a".repeat(64)}`,
      normalizedEmail: "composition@example.test", clientKind: "web", deviceLabel: "Composition Browser",
    });
    const verifiedSubject = {
      provider: "supabase" as const, providerSubject: "composition-provider-subject",
      identityKind: "email_password" as const, normalizedEmail: "composition@example.test",
      verifiedAt: "2026-08-18T00:00:00.000Z",
    };
    const registered = await operations.completeEmailVerification({ verificationId: begun.verificationId, verifiedSubject });
    const sessionIdempotency = {
      idempotencyKey: "composition-session-issue", payloadHash: `sha256:${"c".repeat(64)}`,
      operation: "email_verification" as const,
    };
    const issued = await operations.issueSession(verifiedSubject, registered.clientKind, registered.deviceLabel, sessionIdempotency);
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
    await assert.rejects(
      operations.issueSession(verifiedSubject, registered.clientKind, registered.deviceLabel, sessionIdempotency),
      /IDEMPOTENCY_CONFLICT/u,
    );
    assert.equal((await pool.query("select count(*)::int as count from core_sessions where actor_id = $1", [registered.actorId])).rows[0]?.count, 1);

    await pool.query(`insert into platform_role_assignments (
      platform_role_assignment_id, actor_id, role, status, resource_version, created_at, updated_at
    ) values ($1, $2, 'platform_super_admin', 'active', 1, now(), now())`, ["platform_role_composition", registered.actorId]);
    await pool.query("update core_sessions set reauthenticated_at = now(), updated_at = now() where session_id = $1", [issued.session.session_id]);
    const refreshed = await operations.authenticateSession({ sessionSecret: issued.sessionSecret, csrfSecret: issued.csrfSecret!, requireCsrf: true });
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
    assert.equal((await pool.query("select count(*)::int as count from tenants where tenant_id = $1 and tenant_mode = 'b2b'", [company.tenant_id])).rows[0]?.count, 1);
    await assert.rejects(operations.executeProtectedAuthorityCommand({
      kind: "company_member_list", authority: refreshed,
      payload: { schema_version: 1, tenant_id: company.tenant_id, limit: 20 },
    }), /UNAUTHENTICATED/u, "platform projection must not become company-admin list authority");

    const timestamp = new Date("2026-08-18T02:00:00.000Z");
    await db.insertInto("actors").values([
      { actor_id: "actor_composition_admin", schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Composition admin", status: "active", created_at: timestamp, updated_at: timestamp },
      { actor_id: "actor_composition_invitee", schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Composition invitee", status: "active", created_at: timestamp, updated_at: timestamp },
    ]).execute();
    await db.insertInto("auth_subjects").values([
      { auth_subject_id: "auth_composition_admin", actor_id: "actor_composition_admin", provider: "supabase", provider_subject: "provider_composition_admin", provider_identity_kind: "email_password", verified_at: timestamp, status: "active", resource_version: 1, created_at: timestamp, updated_at: timestamp },
      { auth_subject_id: "auth_composition_invitee", actor_id: "actor_composition_invitee", provider: "supabase", provider_subject: "provider_composition_invitee", provider_identity_kind: "email_password", verified_at: timestamp, status: "active", resource_version: 1, created_at: timestamp, updated_at: timestamp },
    ]).execute();
    const adminEmail = "company-admin@example.test";
    const inviteeEmail = "company-invitee@example.test";
    await db.insertInto("private_identity_pii").values([
      { actor_id: "actor_composition_admin", normalized_email_hmac: createHmac("sha256", key).update(adminEmail).digest(), encrypted_email: Buffer.from("encrypted-admin"), encryption_key_ref: "composition", created_at: timestamp, updated_at: timestamp },
      { actor_id: "actor_composition_invitee", normalized_email_hmac: createHmac("sha256", key).update(inviteeEmail).digest(), encrypted_email: Buffer.from("encrypted-invitee"), encryption_key_ref: "composition", created_at: timestamp, updated_at: timestamp },
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
    const accepted = await operations.executeAuthorityCommand({
      kind: "invitation_accept",
      payload: { schema_version: 1, idempotency_key: "composition-invitation-accept", payload_hash: `sha256:${"f".repeat(64)}`, invitation_secret: invitation.invitation_secret, expected_resource_version: 1 },
      verifiedSubject: { provider: "supabase", providerSubject: "provider_composition_invitee", identityKind: "email_password", normalizedEmail: inviteeEmail, verifiedAt: timestamp.toISOString() },
    }) as { membership_id: string; role: string };
    assert.equal(accepted.membership_id, invitation.membership_id);
    assert.equal(accepted.role, "consultant");
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
