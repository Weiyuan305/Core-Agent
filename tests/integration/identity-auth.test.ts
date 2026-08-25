import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalEmailVerificationStartPayloadHash,
  canonicalPayloadHash,
  issueCoreSession,
} from "@core-agent/runtime-core";
import type { LightMyRequestResponse } from "fastify";

import { buildIdentityGatewayApp } from "../../apps/identity-gateway/src/app.js";
import type { IdentityGatewayConfig } from "../../apps/identity-gateway/src/config.js";
import {
  CORE_CSRF_COOKIE_NAME,
  CORE_SESSION_COOKIE_NAME,
} from "../../apps/identity-gateway/src/security.js";
import { identityGatewayServerTestInternals } from "../../apps/identity-gateway/src/server.js";
import {
  createIntegrationFakeAuthProvider,
  INTEGRATION_B2C_EMAIL,
  INTEGRATION_B2C_PASSWORD,
  INTEGRATION_B2B_EMAIL,
  INTEGRATION_B2B_PASSWORD,
  type IntegrationFakeAuthProvider,
} from "./fakes/fake-auth-provider.js";
import { createIntegrationHarness, type IntegrationHarness } from "./harness.js";

const host = "identity.task11.test";
const origin = "https://app.task11.test";
const now = new Date("2026-08-20T05:00:00.000Z");
const publicHeaders = Object.freeze({ host, origin, "content-type": "application/json" });

interface SessionDelivery {
  readonly session: {
    readonly actor_id: string;
    readonly session_id: string;
    readonly session_resource_version: number;
    readonly client_kind: "web" | "iphone" | "macos";
  };
}

interface CookieCredentials {
  readonly header: string;
  readonly sessionSecret: string;
  readonly csrfSecret: string;
}

let harness: IntegrationHarness;
let provider: IntegrationFakeAuthProvider;
let app: Awaited<ReturnType<typeof buildIdentityGatewayApp>>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function json<T>(response: LightMyRequestResponse): T {
  return response.json() as T;
}

function sessionCookies(response: LightMyRequestResponse): CookieCredentials {
  const raw = response.headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const values = new Map(lines.map((line) => {
    const pair = line.split(";", 1)[0]!;
    const separator = pair.indexOf("=");
    return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
  }));
  const sessionSecret = values.get(CORE_SESSION_COOKIE_NAME);
  const csrfSecret = values.get(CORE_CSRF_COOKIE_NAME);
  assert.equal(typeof sessionSecret, "string");
  assert.equal(typeof csrfSecret, "string");
  return {
    header: `${CORE_SESSION_COOKIE_NAME}=${sessionSecret}; ${CORE_CSRF_COOKIE_NAME}=${csrfSecret}`,
    sessionSecret,
    csrfSecret,
  };
}

function mutationHeaders(credentials: CookieCredentials): Record<string, string> {
  return { ...publicHeaders, cookie: credentials.header, "x-core-agent-csrf": credentials.csrfSecret };
}

function emailSignInPayload(email: string, password: string, idempotencyKey: string) {
  const facts = {
    schema_version: 1 as const,
    idempotency_key: idempotencyKey,
    email,
    password,
    client_kind: "web" as const,
  };
  return {
    ...facts,
    payload_hash: canonicalPayloadHash({
      schema_version: 1,
      idempotency_key: idempotencyKey,
      normalized_email: email.toLowerCase(),
      sign_in_proof_digest: sha256(password),
      client_kind: "web",
    }),
  };
}

async function beginAndCompleteEmailRegistration(input: {
  readonly idempotencyKey: string;
  readonly email: string;
  readonly password: string;
  readonly invitationSecret?: string;
}): Promise<{ readonly response: SessionDelivery; readonly credentials: CookieCredentials }> {
  const startIdempotencyKey = `${input.idempotencyKey}-start`;
  let invitationDigest: string | undefined;
  if (input.invitationSecret !== undefined) {
    const secretBytes = Buffer.from(input.invitationSecret, "base64url");
    try {
      invitationDigest = createHash("sha256").update(secretBytes).digest("base64url");
    } finally {
      secretBytes.fill(0);
    }
  }
  const start = await app.inject({
    method: "POST",
    url: input.invitationSecret === undefined ? "/auth/v1/email/sign-up" : "/auth/v1/invitations/register",
    headers: publicHeaders,
    payload: {
      schema_version: 1,
      idempotency_key: startIdempotencyKey,
      payload_hash: canonicalEmailVerificationStartPayloadHash({
        idempotencyKey: startIdempotencyKey,
        normalizedEmail: input.email.toLowerCase(),
        clientKind: "web",
        flowKind: input.invitationSecret === undefined ? "b2c" : "invitation",
        ...(invitationDigest === undefined ? {} : { invitationDigest }),
      }),
      ...(input.invitationSecret === undefined ? {} : { invitation_secret: input.invitationSecret }),
      email: input.email,
      password: input.password,
      client_kind: "web",
    },
  });
  assert.equal(start.statusCode, 202, start.body);
  const verificationId = json<{ readonly verification_id: string }>(start).verification_id;
  assert.equal(typeof verificationId, "string");
  const verificationFacts = {
    schema_version: 1 as const,
    idempotency_key: `${input.idempotencyKey}-complete`,
    verification_id: verificationId,
    verification_code: "fake-email-verification-code",
  };
  const completed = await app.inject({
    method: "POST",
    url: "/auth/v1/email/verification",
    headers: publicHeaders,
    payload: { ...verificationFacts, payload_hash: canonicalPayloadHash(verificationFacts) },
  });
  assert.equal(completed.statusCode, 200, completed.body);
  return { response: json<SessionDelivery>(completed), credentials: sessionCookies(completed) };
}

async function reauthenticate(
  registration: { readonly response: SessionDelivery; readonly credentials: CookieCredentials },
  password: string,
  idempotencyKey: string,
): Promise<void> {
  const facts = {
    schema_version: 1 as const,
    idempotency_key: idempotencyKey,
    expected_resource_version: registration.response.session.session_resource_version,
    password,
  };
  const response = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate", headers: mutationHeaders(registration.credentials),
    payload: {
      ...facts,
      payload_hash: canonicalPayloadHash({
        schema_version: 1,
        idempotency_key: facts.idempotency_key,
        expected_resource_version: facts.expected_resource_version,
        reauthentication_proof_digest: sha256(password),
      }),
    },
  });
  assert.equal(response.statusCode, 200, response.body);
}

function publicErrorShape(response: LightMyRequestResponse): unknown {
  const body = json<Record<string, unknown>>(response);
  return {
    status: response.statusCode,
    code: body.code,
    message: body.message,
    retryable: body.retryable,
  };
}

async function seedPlatformAuthority(): Promise<CookieCredentials> {
  const databaseNow = new Date();
  await harness.db.insertInto("actors").values({
    actor_id: "actor_task11_platform", schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: "Task11 platform administrator", status: "active", created_at: databaseNow, updated_at: databaseNow,
  }).execute();
  await harness.db.insertInto("auth_subjects").values({
    auth_subject_id: "auth_subject_task11_platform", actor_id: "actor_task11_platform", provider: "supabase",
    provider_subject: "provider_task11_platform", provider_identity_kind: "email_password",
    verified_at: databaseNow, status: "active", resource_version: 1, created_at: databaseNow, updated_at: databaseNow,
  }).execute();
  await harness.db.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: "platform_role_task11", actor_id: "actor_task11_platform",
    role: "platform_super_admin", status: "active", resource_version: 1, created_at: databaseNow, updated_at: databaseNow,
  }).execute();
  const issued = await issueCoreSession({ db: harness.db }, {
    sessionId: "session_task11_platform", actorId: "actor_task11_platform",
    authSubjectId: "auth_subject_task11_platform", clientKind: "web",
  });
  await harness.db.updateTable("core_sessions").set({
    reauthenticated_at: databaseNow,
    resource_version: 2,
    updated_at: databaseNow,
  }).where("session_id", "=", issued.session.session_id).executeTakeFirstOrThrow();
  assert.equal(typeof issued.csrfSecret, "string");
  return {
    header: `${CORE_SESSION_COOKIE_NAME}=${issued.sessionSecret}; ${CORE_CSRF_COOKIE_NAME}=${issued.csrfSecret}`,
    sessionSecret: issued.sessionSecret,
    csrfSecret: issued.csrfSecret,
  };
}

async function createCompany(credentials: CookieCredentials, suffix: string, administratorEmail: string) {
  const facts = {
    schema_version: 1 as const,
    idempotency_key: `task11-company-${suffix}`,
    display_name: `Task11 Company ${suffix}`,
    administrator_email: administratorEmail,
  };
  const response = await app.inject({
    method: "POST", url: "/auth/v1/companies", headers: mutationHeaders(credentials),
    payload: { ...facts, payload_hash: canonicalPayloadHash(facts) },
  });
  assert.equal(response.statusCode, 200, response.body);
  return json<{
    readonly tenant_id: string;
    readonly administrator_invitation_secret: string;
  }>(response);
}

test.before(async () => {
  harness = await createIntegrationHarness("identity-auth");
  provider = createIntegrationFakeAuthProvider(() => new Date(now));
  const piiKey = Buffer.alloc(32, 0x41);
  const piiProtector = identityGatewayServerTestInternals.aesProtector(Buffer.alloc(32, 0x42), "task11-private-pii");
  const oauthProtector = identityGatewayServerTestInternals.aesProtector(Buffer.alloc(32, 0x43), "task11-oauth");
  const config: IdentityGatewayConfig = {
    databaseUrl: harness.databaseUrl,
    publicOrigins: new Set([origin]),
    cookieHost: host,
    publicBaseUrl: `https://${host}`,
    providerUrl: "https://fake-auth.task11.invalid",
    providerPublishableKeyRef: "unused-publishable",
    providerServiceRoleKeyRef: "unused-service-role",
    appleWebRedirectUris: new Set([`${origin}/auth/apple/callback`]),
    appleNativeRedirectUris: new Set(["coreagent://auth/apple/callback"]),
    passwordResetRedirectUri: `${origin}/auth/password/reset/callback`,
    emailVerificationRedirectUri: `${origin}/auth/v1/email/verification`,
    sessionHmacKeyRef: "unused-session",
    piiHmacKeyRef: "unused-pii",
    signingKeyRef: "unused-signing",
    host: "127.0.0.1",
    port: 8788,
    publicAuthEnabled: true,
    trustedProxyAddresses: new Set(),
  };
  app = await buildIdentityGatewayApp({
    config,
    provider,
    operations: identityGatewayServerTestInternals.productionOperations(
      harness.db, piiKey, piiProtector, oauthProtector, "tenant_platform_authority",
    ),
    flowCookieKey: Buffer.alloc(32, 0x44),
    now: () => new Date(now),
  });
});

test.after(async () => {
  await app?.close();
  await harness?.close();
});

test("fake-provider B2C slice enforces Cookie CSRF reauthentication outage revocation deletion recovery and public-safe errors", async () => {
  const registration = await beginAndCompleteEmailRegistration({
    idempotencyKey: "task11-b2c",
    email: INTEGRATION_B2C_EMAIL,
    password: INTEGRATION_B2C_PASSWORD,
  });
  assert.equal(registration.response.session.client_kind, "web");
  const actorId = registration.response.session.actor_id;
  assert.equal((await harness.db.selectFrom("actors").select("actor_id").where("actor_id", "=", actorId).executeTakeFirst())?.actor_id, actorId);
  assert.equal((await harness.db.selectFrom("memberships").select("roles").where("actor_id", "=", actorId).executeTakeFirst())?.roles[0], "student");
  assert.equal(await harness.db.selectFrom("runtime_containers").select("container_id").where("tenant_id", "=", (
    await harness.db.selectFrom("memberships").select("tenant_id").where("actor_id", "=", actorId).executeTakeFirstOrThrow()
  ).tenant_id).executeTakeFirst(), undefined);

  const inspected = await app.inject({
    method: "GET", url: "/auth/v1/session",
    headers: { host, origin, cookie: registration.credentials.header },
  });
  assert.equal(inspected.statusCode, 200, inspected.body);
  const inspectedSession = json<{ readonly session: SessionDelivery["session"] }>(inspected).session;
  assert.equal(inspectedSession.actor_id, actorId);

  const missingCsrf = await app.inject({
    method: "POST", url: "/auth/v1/session/sign-out",
    headers: { ...publicHeaders, cookie: registration.credentials.header },
    payload: { schema_version: 1 },
  });
  assert.equal(missingCsrf.statusCode, 401);

  provider.setAvailable(false);
  const unavailableKnown = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-in", headers: publicHeaders,
    payload: emailSignInPayload(INTEGRATION_B2C_EMAIL, INTEGRATION_B2C_PASSWORD, "task11-outage-known"),
  });
  const unavailableUnknown = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-in", headers: publicHeaders,
    payload: emailSignInPayload("unknown.task11@example.test", INTEGRATION_B2C_PASSWORD, "task11-outage-unknown"),
  });
  assert.deepEqual(publicErrorShape(unavailableKnown), publicErrorShape(unavailableUnknown));
  assert.equal(unavailableKnown.statusCode, 503);
  assert.doesNotMatch(unavailableKnown.body, /student\.task11|unknown\.task11|provider_subject|supabase|password/u);
  provider.setAvailable(true);

  const secondSignIn = await app.inject({
    method: "POST", url: "/auth/v1/email/sign-in", headers: publicHeaders,
    payload: emailSignInPayload(INTEGRATION_B2C_EMAIL, INTEGRATION_B2C_PASSWORD, "task11-sign-in-second"),
  });
  assert.equal(secondSignIn.statusCode, 200, secondSignIn.body);
  const secondCredentials = sessionCookies(secondSignIn);
  const secondSession = json<SessionDelivery>(secondSignIn).session;

  const reauthenticationFacts = {
    schema_version: 1 as const,
    idempotency_key: "task11-reauthenticate",
    expected_resource_version: secondSession.session_resource_version,
    password: INTEGRATION_B2C_PASSWORD,
  };
  const reauthentication = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate", headers: mutationHeaders(secondCredentials),
    payload: {
      ...reauthenticationFacts,
      payload_hash: canonicalPayloadHash({
        schema_version: 1,
        idempotency_key: reauthenticationFacts.idempotency_key,
        expected_resource_version: reauthenticationFacts.expected_resource_version,
        reauthentication_proof_digest: sha256(INTEGRATION_B2C_PASSWORD),
      }),
    },
  });
  assert.equal(reauthentication.statusCode, 200, reauthentication.body);

  const firstSessionVersion = Number((await harness.db.selectFrom("core_sessions").select("resource_version")
    .where("session_id", "=", inspectedSession.session_id).executeTakeFirstOrThrow()).resource_version);
  const revokeFacts = {
    schema_version: 1 as const,
    idempotency_key: "task11-revoke-first-session",
    expected_resource_version: firstSessionVersion,
    session_id: inspectedSession.session_id,
    reason_code: "administrator_revoked" as const,
  };
  const revoked = await app.inject({
    method: "POST", url: "/auth/v1/sessions/revoke", headers: mutationHeaders(secondCredentials),
    payload: { ...revokeFacts, payload_hash: canonicalPayloadHash(revokeFacts) },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await harness.db.selectFrom("core_sessions").select("status")
    .where("session_id", "=", inspectedSession.session_id).executeTakeFirstOrThrow()).status, "revoked");

  const actorVersion = Number((await harness.db.selectFrom("actors").select("resource_version")
    .where("actor_id", "=", actorId).executeTakeFirstOrThrow()).resource_version);
  const deletionFacts = {
    schema_version: 1 as const,
    idempotency_key: "task11-delete-account",
    expected_resource_version: actorVersion,
    reason_code: "user_requested" as const,
  };
  const deletion = await app.inject({
    method: "POST", url: "/auth/v1/account/deletion/request", headers: mutationHeaders(secondCredentials),
    payload: { ...deletionFacts, payload_hash: canonicalPayloadHash(deletionFacts) },
  });
  assert.equal(deletion.statusCode, 200, deletion.body);
  const deletionBody = json<{ readonly account_deletion_id: string; readonly resource_version: number }>(deletion);
  const recoveryReauthenticationFacts = {
    schema_version: 1 as const,
    idempotency_key: "task11-deletion-recovery-reauthenticate",
    expected_resource_version: secondSession.session_resource_version,
    password: INTEGRATION_B2C_PASSWORD,
  };
  const recoveryReauthentication = await app.inject({
    method: "POST", url: "/auth/v1/reauthenticate", headers: mutationHeaders(secondCredentials),
    payload: {
      ...recoveryReauthenticationFacts,
      payload_hash: canonicalPayloadHash({
        schema_version: 1,
        idempotency_key: recoveryReauthenticationFacts.idempotency_key,
        expected_resource_version: recoveryReauthenticationFacts.expected_resource_version,
        reauthentication_proof_digest: sha256(INTEGRATION_B2C_PASSWORD),
      }),
    },
  });
  assert.equal(recoveryReauthentication.statusCode, 200, recoveryReauthentication.body);
  const cancelFacts = {
    schema_version: 1 as const,
    idempotency_key: "task11-cancel-deletion",
    expected_resource_version: deletionBody.resource_version,
    account_deletion_id: deletionBody.account_deletion_id,
  };
  const cancelled = await app.inject({
    method: "POST", url: "/auth/v1/account/deletion/cancel", headers: mutationHeaders(secondCredentials),
    payload: { ...cancelFacts, payload_hash: canonicalPayloadHash(cancelFacts) },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(json<{ readonly status: string }>(cancelled).status, "cancelled");
  assert.equal((await harness.db.selectFrom("actors").select("status").where("actor_id", "=", actorId).executeTakeFirstOrThrow()).status, "active");
});

test("fake-provider invited B2B slice preserves invitation-only onboarding and server-derived platform cross-company access", async () => {
  const platformCredentials = await seedPlatformAuthority();
  const companyA = await createCompany(platformCredentials, "a", INTEGRATION_B2B_EMAIL);
  const companyB = await createCompany(platformCredentials, "b", "second-administrator.task11@example.test");

  const administratorA = await beginAndCompleteEmailRegistration({
    idempotencyKey: "task11-b2b-a",
    email: INTEGRATION_B2B_EMAIL,
    password: INTEGRATION_B2B_PASSWORD,
    invitationSecret: companyA.administrator_invitation_secret,
  });
  const administratorB = await beginAndCompleteEmailRegistration({
    idempotencyKey: "task11-b2b-b",
    email: "second-administrator.task11@example.test",
    password: "task11-second-administrator-password",
    invitationSecret: companyB.administrator_invitation_secret,
  });
  assert.notEqual(administratorA.response.session.actor_id, administratorB.response.session.actor_id);
  await reauthenticate(administratorA, INTEGRATION_B2B_PASSWORD, "task11-b2b-a-reauthenticate");
  await reauthenticate(administratorB, "task11-second-administrator-password", "task11-b2b-b-reauthenticate");

  for (const [company, administrator] of [[companyA, administratorA], [companyB, administratorB]] as const) {
    const listed = await app.inject({
      method: "POST", url: "/auth/v1/companies/members/list", headers: mutationHeaders(administrator.credentials),
      payload: { schema_version: 1, tenant_id: company.tenant_id, limit: 100 },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    const members = json<{ readonly members: readonly { readonly actor_id: string; readonly source: string; readonly roles: readonly string[] }[] }>(listed).members;
    assert.equal(members.length, 1);
    assert.equal(members[0]?.source, "company");
    assert.deepEqual(members[0]?.roles, ["admin"]);
    assert.notEqual(members[0]?.actor_id, "actor_task11_platform");
  }

  const platformMemberships = await harness.db.selectFrom("memberships")
    .select(["tenant_id", "actor_id", "membership_source", "roles", "status"])
    .where("actor_id", "=", "actor_task11_platform").orderBy("tenant_id").execute();
  assert.deepEqual(platformMemberships.map((membership) => membership.tenant_id).sort(), [companyA.tenant_id, companyB.tenant_id].sort());
  assert(platformMemberships.every((membership) => membership.membership_source === "platform"
    && membership.status === "active" && JSON.stringify(membership.roles) === '["admin"]'));
  assert.equal(await harness.db.selectFrom("profiles").select("profile_id")
    .where("owner_actor_id", "in", [administratorA.response.session.actor_id, administratorB.response.session.actor_id])
    .execute().then((rows) => rows.length), 0);
});
