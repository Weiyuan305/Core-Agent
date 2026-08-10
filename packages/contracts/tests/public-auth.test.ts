import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import * as Contracts from "../src/index.js";

const {
  AccountDeletionSchema,
  AppleAuthorizationCallbackRequestSchema,
  AppleAuthorizationCallbackResponseSchema,
  AppleAuthorizationStartRequestSchema,
  AppleAuthorizationStartResponseSchema,
  AppleIdentityLinkRequestSchema,
  AppleIdentityLinkResponseSchema,
  AuthSessionViewSchema,
  AuthSubjectSchema,
  CompanyCreateRequestSchema,
  CompanyCreateResponseSchema,
  CompanyMemberInviteRequestSchema,
  CompanyMemberInviteResponseSchema,
  CompanyMemberSuspendRequestSchema,
  CompanyMemberSuspendResponseSchema,
  CompanyMemberRevokeRequestSchema,
  CompanyMemberRevokeResponseSchema,
  CoreSessionClientKindSchema,
  CoreSessionRevocationReasonCodeSchema,
  CoreSessionSchema,
  CoreSessionStatusSchema,
  EmailSignInRequestSchema,
  EmailSignInResponseSchema,
  EmailSignUpRequestSchema,
  EmailSignUpResponseSchema,
  EmailVerificationRequestSchema,
  EmailVerificationResponseSchema,
  InvitationAcceptanceRequestSchema,
  InvitationAcceptanceResponseSchema,
  InvitationEmailRegistrationRequestSchema,
  InvitationEmailRegistrationResponseSchema,
  InvitationInspectRequestSchema,
  InvitationInspectResponseSchema,
  InvitationRevokeRequestSchema,
  InvitationRevokeResponseSchema,
  InvitationRoleSchema,
  InvitationSchema,
  InvitationStatusSchema,
  PasswordResetRequestSchema,
  PasswordResetResponseSchema,
  PlatformRoleAssignmentSchema,
  PlatformRoleSchema,
  ProviderIdentityKindSchema,
  ReauthenticationRequestSchema,
  ReauthenticationResponseSchema,
  SessionInspectRequestSchema,
  SessionInspectResponseSchema,
  SessionRevokeRequestSchema,
  SessionRevokeResponseSchema,
  AccountDeletionRequestSchema,
  AccountDeletionResponseSchema,
  AccountDeletionCancelRequestSchema,
  AccountDeletionCancelResponseSchema,
  StableErrorCodeSchema,
  IdentityEventSchema,
  validateAccountDeletion,
  validateCoreSession,
  validateInvitation,
} = Contracts as unknown as Record<string, any>;

const timestamp = "2026-08-10T01:02:03Z";
const resource = { schema_version: 1 as const, resource_version: 1, created_at: timestamp, updated_at: timestamp };
const idem = { schema_version: 1 as const, idempotency_key: "idem_01", payload_hash: `sha256:${"a".repeat(64)}` };
const providerKinds = ["email_password", "apple"] as const;
const coreSessionClients = ["web", "iphone", "macos"] as const;
const coreSessionStatuses = ["active", "revoked", "expired"] as const;
const invitationStatuses = ["pending", "accepted", "revoked", "expired", "replaced"] as const;
const platformRoles = ["platform_super_admin"] as const;
const invitationSecret = "i".repeat(43);
const compileRequired = (name: string, schema: unknown) => {
  assert.notEqual(schema, undefined, `${name} must be exported`);
  return Schema.Compile(schema as never);
};

test("auth authority vocabulary is closed to the approved values", () => {
  const tables = [
    [ProviderIdentityKindSchema, providerKinds, "password"],
    [CoreSessionClientKindSchema, coreSessionClients, "android"],
    [CoreSessionStatusSchema, coreSessionStatuses, "disabled"],
    [InvitationRoleSchema, ["admin", "consultant"] as const, "student"],
    [InvitationStatusSchema, invitationStatuses, "used"],
    [PlatformRoleSchema, platformRoles, "company_admin"],
  ] as const;
  for (const [schema, allowed, rejected] of tables) {
    const validator = compileRequired(rejected, schema);
    for (const value of allowed) assert.equal(validator.Check(value), true, value);
    assert.equal(validator.Check(rejected), false, rejected);
  }
});

test("identity authority resources are closed and contain only bounded public facts", () => {
  const cases: Array<[unknown, unknown]> = [
    [AuthSubjectSchema, { ...resource, auth_subject_id: "auth_01", actor_id: "actor_01", provider: "supabase", provider_subject: "subject_01", provider_identity_kind: "apple", verified_at: timestamp, status: "active" }],
    [PlatformRoleAssignmentSchema, { ...resource, platform_role_assignment_id: "assignment_01", actor_id: "actor_01", role: "platform_super_admin", status: "active" }],
    [InvitationSchema, { ...resource, invitation_id: "invitation_01", tenant_id: "tenant_01", membership_id: "membership_01", invited_by_actor_id: "actor_admin", role: "consultant", status: "pending", expires_at: timestamp }],
    [CoreSessionSchema, { ...resource, session_id: "session_01", actor_id: "actor_01", auth_subject_id: "auth_01", client_kind: "web", last_seen_at: timestamp, idle_expires_at: timestamp, absolute_expires_at: timestamp, status: "active" }],
    [AccountDeletionSchema, { ...resource, account_deletion_id: "deletion_01", actor_id: "actor_01", status: "deletion_pending", requested_at: timestamp, scheduled_for: timestamp }],
  ];
  for (const [schema, value] of cases) {
    const validator = compileRequired(String((value as Record<string, unknown>).status ?? "resource"), schema);
    assert.equal(validator.Check(value), true);
    assert.equal(validator.Check({ ...(value as object), access_token: "sentinel" }), false);
  }
  const sessionValidator = compileRequired("CoreSessionSchema", CoreSessionSchema);
  const revokedSession = {
    ...resource,
    session_id: "session_01",
    actor_id: "actor_01",
    auth_subject_id: "auth_01",
    client_kind: "web",
    last_seen_at: timestamp,
    idle_expires_at: timestamp,
    absolute_expires_at: timestamp,
    status: "revoked",
    revocation_reason_code: "password_reset",
  };
  assert.equal(sessionValidator.Check(revokedSession), true);
  assert.equal(sessionValidator.Check({ ...revokedSession, revocation_reason_code: "arbitrary_text" }), false);
});

const requestCases: Array<[string, unknown, unknown]> = [
  ["email sign-up", EmailSignUpRequestSchema, { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" }],
  ["email verification", EmailVerificationRequestSchema, { ...idem, verification_id: "verification_01", verification_code: "opaque_verification_code" }],
  ["email sign-in", EmailSignInRequestSchema, { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "iphone", device_label: "Phone" }],
  ["password reset", PasswordResetRequestSchema, { ...idem, email: "student@example.test" }],
  ["Apple Web start", AppleAuthorizationStartRequestSchema, { ...idem, client_kind: "web", redirect_uri: "https://auth.example.test/callback" }],
  ["Apple native start", AppleAuthorizationStartRequestSchema, { ...idem, client_kind: "iphone", redirect_uri: "coreagent://auth/callback", nonce: "opaque_native_nonce", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" }],
  ["Apple Web callback", AppleAuthorizationCallbackRequestSchema, { ...idem, client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state" }],
  ["Apple native callback", AppleAuthorizationCallbackRequestSchema, { ...idem, client_kind: "macos", transaction_id: "oauth_02", authorization_code: "opaque_code", state: "opaque_state", nonce: "opaque_native_nonce", pkce_code_verifier: "b".repeat(43) }],
  ["Apple link", AppleIdentityLinkRequestSchema, { ...idem, client_kind: "web", transaction_id: "oauth_03", authorization_code: "opaque_code", state: "opaque_state" }],
  ["session inspect", SessionInspectRequestSchema, { schema_version: 1, session_id: "session_01" }],
  ["session revoke", SessionRevokeRequestSchema, { ...idem, expected_resource_version: 1, session_id: "session_01", reason_code: "user_sign_out" }],
  ["reauthentication", ReauthenticationRequestSchema, { ...idem, expected_resource_version: 1, password: "correct-horse" }],
  ["invitation inspect", InvitationInspectRequestSchema, { schema_version: 1, invitation_secret: invitationSecret }],
  ["invitation email registration", InvitationEmailRegistrationRequestSchema, { ...idem, invitation_secret: invitationSecret, email: "invitee@example.test", password: "correct-horse", client_kind: "web" }],
  ["invitation acceptance", InvitationAcceptanceRequestSchema, { ...idem, expected_resource_version: 1, invitation_secret: invitationSecret, authentication_proof: { kind: "email_password", client_kind: "web", verification_proof: "opaque_verified_email_proof" } }],
  ["invitation revoke", InvitationRevokeRequestSchema, { ...idem, expected_resource_version: 1, invitation_id: "invitation_01", reason_code: "administrator_revoked" }],
  ["company creation", CompanyCreateRequestSchema, { ...idem, display_name: "Synthetic Company", administrator_email: "admin@example.test" }],
  ["company member invite", CompanyMemberInviteRequestSchema, { ...idem, tenant_id: "tenant_01", email: "invitee@example.test", role: "consultant" }],
  ["company member suspend", CompanyMemberSuspendRequestSchema, { ...idem, expected_resource_version: 1, membership_id: "membership_01", reason_code: "administrator_suspended" }],
  ["company member revoke", CompanyMemberRevokeRequestSchema, { ...idem, expected_resource_version: 1, membership_id: "membership_01", reason_code: "administrator_revoked" }],
  ["account deletion", AccountDeletionRequestSchema, { ...idem, expected_resource_version: 1, reason_code: "user_requested" }],
  ["account deletion cancel", AccountDeletionCancelRequestSchema, { ...idem, expected_resource_version: 1, account_deletion_id: "deletion_01" }],
];

test("every public auth request has an exact closed shape", () => {
  for (const [name, schema, value] of requestCases) {
    const validator = compileRequired(name, schema);
    assert.equal(validator.Check(value), true, name);
    assert.equal(validator.Check({ ...(value as object), tenant_override: "forged" }), false, name);
  }
});

test("every public auth response is closed and provider-neutral", () => {
  const sessionView = { schema_version: 1, actor_id: "actor_01", actor_resource_version: 4, session_id: "session_01", session_resource_version: 7, client_kind: "web", idle_expires_at: timestamp, absolute_expires_at: timestamp, reauthentication_required: false };
  const responseCases: Array<[string, unknown, unknown]> = [
    ["email sign-up", EmailSignUpResponseSchema, { schema_version: 1, verification_id: "verification_01", status: "verification_pending" }],
    ["email verification", EmailVerificationResponseSchema, { schema_version: 1, transport: "web_cookie", session: sessionView }],
    ["email sign-in", EmailSignInResponseSchema, { schema_version: 1, transport: "web_cookie", session: sessionView }],
    ["password reset", PasswordResetResponseSchema, { schema_version: 1, accepted: true }],
    ["Apple start", AppleAuthorizationStartResponseSchema, { schema_version: 1, transaction_id: "oauth_01", authorization_url: "https://appleid.apple.com/auth/authorize", expires_at: timestamp }],
    ["Apple callback", AppleAuthorizationCallbackResponseSchema, { schema_version: 1, transport: "web_cookie", session: sessionView }],
    ["Apple link", AppleIdentityLinkResponseSchema, { schema_version: 1, auth_subject_id: "auth_01", linked: true }],
    ["session inspect", SessionInspectResponseSchema, { schema_version: 1, session: sessionView }],
    ["session revoke", SessionRevokeResponseSchema, { schema_version: 1, session_id: "session_01", status: "revoked", resource_version: 8 }],
    ["reauthentication", ReauthenticationResponseSchema, { schema_version: 1, reauthenticated_at: timestamp, valid_until: timestamp, session_resource_version: 8 }],
    ["invitation inspect", InvitationInspectResponseSchema, { schema_version: 1, invitation_id: "invitation_01", tenant_id: "tenant_01", role: "consultant", status: "pending", expires_at: timestamp, resource_version: 1 }],
    ["invitation email registration", InvitationEmailRegistrationResponseSchema, { schema_version: 1, status: "verification_pending" }],
    ["invitation acceptance", InvitationAcceptanceResponseSchema, { schema_version: 1, transport: "web_cookie", tenant_id: "tenant_01", invitation_resource_version: 2, membership_id: "membership_01", membership_resource_version: 2, profile_id: "profile_01", profile_resource_version: 1, session: sessionView }],
    ["invitation revoke", InvitationRevokeResponseSchema, { schema_version: 1, invitation_id: "invitation_01", status: "revoked", resource_version: 2 }],
    ["company creation", CompanyCreateResponseSchema, { schema_version: 1, tenant_id: "tenant_01", tenant_resource_version: 1, administrator_invitation_id: "invitation_01", administrator_invitation_resource_version: 1, administrator_invitation_secret: invitationSecret }],
    ["company member invite", CompanyMemberInviteResponseSchema, { schema_version: 1, membership_id: "membership_01", membership_resource_version: 1, invitation_id: "invitation_01", invitation_resource_version: 1, invitation_secret: invitationSecret }],
    ["company member suspend", CompanyMemberSuspendResponseSchema, { schema_version: 1, membership_id: "membership_01", status: "suspended", resource_version: 2 }],
    ["company member revoke", CompanyMemberRevokeResponseSchema, { schema_version: 1, membership_id: "membership_01", status: "revoked", resource_version: 2 }],
    ["account deletion", AccountDeletionResponseSchema, { schema_version: 1, account_deletion_id: "deletion_01", status: "deletion_pending", scheduled_for: timestamp, resource_version: 1 }],
    ["account deletion cancel", AccountDeletionCancelResponseSchema, { schema_version: 1, account_deletion_id: "deletion_01", status: "cancelled", resource_version: 2 }],
  ];
  for (const [name, schema, value] of responseCases) {
    const validator = compileRequired(name, schema);
    assert.equal(validator.Check(value), true, name);
    for (const field of ["password", "email", "provider_subject", "access_token", "refresh_token", "authorization", "raw_claims", "key_id", "provider_error_body"]) {
      assert.equal(validator.Check({ ...(value as object), [field]: "sentinel" }), false, `${name}: ${field}`);
    }
  }
  assert.equal(compileRequired("AuthSessionViewSchema", AuthSessionViewSchema).Check(sessionView), true);
});

test("sign-up stays verification-pending and Session delivery is transport-specific", () => {
  const signup = compileRequired("EmailSignUpResponseSchema", EmailSignUpResponseSchema);
  assert.equal(signup.Check({ schema_version: 1, verification_id: "verification_01", status: "verification_pending" }), true);
  assert.equal(signup.Check({ schema_version: 1, status: "verification_pending", session: {} }), false);

  const nativeSession = {
    schema_version: 1,
    actor_id: "actor_01",
    actor_resource_version: 4,
    session_id: "session_native",
    session_resource_version: 7,
    client_kind: "iphone",
    idle_expires_at: timestamp,
    absolute_expires_at: timestamp,
    reauthentication_required: false,
  };
  const signin = compileRequired("EmailSignInResponseSchema", EmailSignInResponseSchema);
  assert.equal(signin.Check({ schema_version: 1, transport: "web_cookie", session: { ...nativeSession, client_kind: "web" } }), true);
  assert.equal(signin.Check({ schema_version: 1, transport: "web_cookie", session: { ...nativeSession, client_kind: "web" }, session_secret: "a".repeat(43) }), false);
  assert.equal(signin.Check({ schema_version: 1, transport: "native", session: nativeSession, session_secret: "a".repeat(43) }), true);
  assert.equal(signin.Check({ schema_version: 1, transport: "native", session: nativeSession }), false);
});

test("Apple and invitation proofs use closed Web and native PKCE variants", () => {
  const start = compileRequired("AppleAuthorizationStartRequestSchema", AppleAuthorizationStartRequestSchema);
  const callback = compileRequired("AppleAuthorizationCallbackRequestSchema", AppleAuthorizationCallbackRequestSchema);
  const webStart = { ...idem, client_kind: "web", redirect_uri: "https://auth.example.test/callback" };
  const nativeStart = { ...idem, client_kind: "iphone", redirect_uri: "coreagent://auth/callback", nonce: "opaque_native_nonce", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" };
  assert.equal(start.Check(webStart), true);
  assert.equal(start.Check({ ...webStart, nonce: "forbidden" }), false);
  assert.equal(start.Check(nativeStart), true);
  assert.equal(start.Check({ ...nativeStart, pkce_code_challenge: "a".repeat(44) }), false);
  assert.equal(start.Check({ ...nativeStart, pkce_code_challenge: `${"a".repeat(42)}.` }), false);
  assert.equal(start.Check({ ...nativeStart, pkce_code_challenge_method: "plain" }), false);
  assert.equal(callback.Check({ ...idem, client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state" }), true);
  assert.equal(callback.Check({ ...idem, client_kind: "iphone", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state" }), false);
  assert.equal(callback.Check({ ...idem, client_kind: "iphone", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state", nonce: "opaque_native_nonce", pkce_code_verifier: "b".repeat(43) }), true);

  const accept = compileRequired("InvitationAcceptanceRequestSchema", InvitationAcceptanceRequestSchema);
  const common = { ...idem, expected_resource_version: 1, invitation_secret: invitationSecret };
  assert.equal(accept.Check({ ...common, authentication_proof: { kind: "email_password", client_kind: "web", verification_proof: "opaque_verified_email_proof" } }), true);
  assert.equal(accept.Check({ ...common, authentication_proof: { kind: "email_password", client_kind: "web", email: "invitee@example.test", password: "correct-horse" } }), false);
  assert.equal(accept.Check({ ...common, authentication_proof: { kind: "apple", client_kind: "web", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state" } }), true);
  assert.equal(accept.Check({ ...common, authentication_proof: { kind: "apple", client_kind: "macos", transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state", nonce: "opaque_native_nonce", pkce_code_verifier: "b".repeat(43) } }), true);
});

test("every durable public mutation is idempotent and existing-resource writes are versioned", () => {
  const readSchemas = new Set([SessionInspectRequestSchema, InvitationInspectRequestSchema]);
  const existingResourceMutations = new Set([
    SessionRevokeRequestSchema,
    ReauthenticationRequestSchema,
    InvitationAcceptanceRequestSchema,
    InvitationRevokeRequestSchema,
    CompanyMemberSuspendRequestSchema,
    CompanyMemberRevokeRequestSchema,
    AccountDeletionRequestSchema,
    AccountDeletionCancelRequestSchema,
  ]);
  for (const [name, schema, value] of requestCases) {
    const validator = compileRequired(name, schema);
    if (!readSchemas.has(schema)) {
      const { idempotency_key: _key, ...withoutKey } = value as Record<string, unknown>;
      assert.equal(validator.Check(withoutKey), false, `${name}: idempotency_key`);
    }
    if (existingResourceMutations.has(schema)) {
      const { expected_resource_version: _version, ...withoutVersion } = value as Record<string, unknown>;
      assert.equal(validator.Check(withoutVersion), false, `${name}: expected_resource_version`);
    }
  }
});

test("invitation registration stays pending until final verified-email acceptance", () => {
  const register = compileRequired("InvitationEmailRegistrationRequestSchema", InvitationEmailRegistrationRequestSchema);
  const pending = compileRequired("InvitationEmailRegistrationResponseSchema", InvitationEmailRegistrationResponseSchema);
  const accept = compileRequired("InvitationAcceptanceRequestSchema", InvitationAcceptanceRequestSchema);
  const registration = {
    ...idem,
    invitation_secret: invitationSecret,
    email: "invitee@example.test",
    password: "correct-horse",
    client_kind: "web",
  };
  assert.equal(register.Check(registration), true);
  assert.equal(pending.Check({ schema_version: 1, status: "verification_pending" }), true);
  assert.equal(pending.Check({ schema_version: 1, status: "verification_pending", session: {} }), false);
  assert.equal(pending.Check({ schema_version: 1, status: "verification_pending", tenant_id: "tenant_01" }), false);
  assert.equal(accept.Check({
    ...idem,
    expected_resource_version: 1,
    invitation_secret: invitationSecret,
    authentication_proof: {
      kind: "email_password",
      client_kind: "web",
      verification_proof: "opaque_verified_email_proof",
    },
  }), true);
});

test("public views return every resource version required by the next mutation", () => {
  const sessionView = {
    schema_version: 1,
    actor_id: "actor_01",
    actor_resource_version: 4,
    session_id: "session_01",
    session_resource_version: 7,
    client_kind: "web",
    idle_expires_at: timestamp,
    absolute_expires_at: timestamp,
    reauthentication_required: false,
  };
  assert.equal(compileRequired("SessionInspectResponseSchema", SessionInspectResponseSchema).Check({ schema_version: 1, session: sessionView }), true);
  assert.equal(compileRequired("SessionRevokeRequestSchema", SessionRevokeRequestSchema).Check({ ...idem, session_id: sessionView.session_id, expected_resource_version: sessionView.session_resource_version, reason_code: "user_sign_out" }), true);
  assert.equal(compileRequired("ReauthenticationRequestSchema", ReauthenticationRequestSchema).Check({ ...idem, expected_resource_version: sessionView.session_resource_version, password: "correct-horse" }), true);
  assert.equal(compileRequired("AccountDeletionRequestSchema", AccountDeletionRequestSchema).Check({ ...idem, expected_resource_version: sessionView.actor_resource_version, reason_code: "user_requested" }), true);

  const deletion = { schema_version: 1, account_deletion_id: "deletion_01", status: "deletion_pending", scheduled_for: timestamp, resource_version: 3 };
  assert.equal(compileRequired("AccountDeletionResponseSchema", AccountDeletionResponseSchema).Check(deletion), true);
  assert.equal(compileRequired("AccountDeletionCancelRequestSchema", AccountDeletionCancelRequestSchema).Check({ ...idem, account_deletion_id: deletion.account_deletion_id, expected_resource_version: deletion.resource_version }), true);

  const invitation = { schema_version: 1, invitation_id: "invitation_01", tenant_id: "tenant_01", role: "consultant", status: "pending", expires_at: timestamp, resource_version: 5 };
  assert.equal(compileRequired("InvitationInspectResponseSchema", InvitationInspectResponseSchema).Check(invitation), true);
  assert.equal(compileRequired("InvitationRevokeRequestSchema", InvitationRevokeRequestSchema).Check({ ...idem, invitation_id: invitation.invitation_id, expected_resource_version: invitation.resource_version, reason_code: "administrator_revoked" }), true);

  const createdMember = { schema_version: 1, membership_id: "membership_01", membership_resource_version: 1, invitation_id: "invitation_01", invitation_resource_version: 1, invitation_secret: invitationSecret };
  assert.equal(compileRequired("CompanyMemberInviteResponseSchema", CompanyMemberInviteResponseSchema).Check(createdMember), true);
  assert.equal(compileRequired("CompanyMemberSuspendRequestSchema", CompanyMemberSuspendRequestSchema).Check({ ...idem, membership_id: createdMember.membership_id, expected_resource_version: createdMember.membership_resource_version, reason_code: "administrator_suspended" }), true);
});

test("invitation, Session, and deletion semantic validators reject contradictory states", () => {
  assert.equal(typeof validateInvitation, "function");
  assert.equal(typeof validateCoreSession, "function");
  assert.equal(typeof validateAccountDeletion, "function");
  const invitation = { ...resource, invitation_id: "invitation_01", tenant_id: "tenant_01", membership_id: "membership_01", invited_by_actor_id: "actor_admin", role: "consultant", status: "accepted", expires_at: timestamp };
  assert.deepEqual(validateInvitation(invitation).map((item: { code: string }) => item.code), ["INVITATION_ACCEPTED_ACTOR_REQUIRED"]);
  assert.deepEqual(validateInvitation({ ...invitation, accepted_actor_id: "actor_01" }), []);

  const session = { ...resource, session_id: "session_01", actor_id: "actor_01", auth_subject_id: "auth_01", client_kind: "web", last_seen_at: timestamp, idle_expires_at: timestamp, absolute_expires_at: timestamp, status: "revoked" };
  assert.deepEqual(validateCoreSession(session).map((item: { code: string }) => item.code), ["CORE_SESSION_REVOCATION_REASON_REQUIRED"]);
  assert.deepEqual(validateCoreSession({ ...session, status: "active", revocation_reason_code: "user_sign_out" }).map((item: { code: string }) => item.code), ["CORE_SESSION_REVOCATION_REASON_FORBIDDEN"]);

  const deletion = { ...resource, account_deletion_id: "deletion_01", actor_id: "actor_01", status: "cancelled", requested_at: timestamp, scheduled_for: timestamp };
  assert.deepEqual(validateAccountDeletion(deletion).map((item: { code: string }) => item.code), ["ACCOUNT_DELETION_CANCELLED_AT_REQUIRED"]);
  assert.deepEqual(validateAccountDeletion({ ...deletion, cancelled_at: timestamp, deleted_at: timestamp }).map((item: { code: string }) => item.code), ["ACCOUNT_DELETION_DELETED_AT_FORBIDDEN"]);
});

test("Core Session revocation reasons use only the approved safe vocabulary", () => {
  const validator = compileRequired("CoreSessionRevocationReasonCodeSchema", CoreSessionRevocationReasonCodeSchema);
  for (const reason of ["user_sign_out", "administrator_revoked", "password_reset", "provider_unlinked", "actor_disabled", "account_deletion_requested", "expired"]) {
    assert.equal(validator.Check(reason), true, reason);
  }
  assert.equal(validator.Check("free form provider failure"), false);
});

test("stable errors include the complete public identity vocabulary", () => {
  const validator = Schema.Compile(StableErrorCodeSchema);
  for (const code of ["AUTH_INVALID", "AUTH_EMAIL_UNVERIFIED", "AUTH_RATE_LIMITED", "AUTH_PROVIDER_UNAVAILABLE", "AUTH_CALLBACK_INVALID", "AUTH_CONFLICT", "REAUTHENTICATION_REQUIRED"]) {
    assert.equal(validator.Check(code), true, code);
  }
});

test("identity events use bounded ID, state, reason-code, and version payloads", () => {
  const validator = compileRequired("IdentityEventSchema", IdentityEventSchema);
  const base = {
    schema_version: 1,
    event_id: "event_01",
    occurred_at: timestamp,
    sequence: 1,
    tenant_id: "tenant_01",
    request_id: "request_01",
    trace_id: "trace_01",
    correlation_id: "correlation_01",
    causation_id: "causation_01",
  };
  const events = [
    ["identity.registered", { actor_id: "actor_01", tenant_id: "tenant_01", membership_id: "membership_01", profile_id: "profile_01", resource_version: 1 }],
    ["invitation.created", { invitation_id: "invitation_01", membership_id: "membership_01", status: "pending", resource_version: 1 }],
    ["invitation.accepted", { invitation_id: "invitation_01", membership_id: "membership_01", actor_id: "actor_01", status: "accepted", resource_version: 2 }],
    ["membership.changed", { membership_id: "membership_01", actor_id: "actor_01", status: "active", reason_code: "invitation_accepted", resource_version: 2 }],
    ["session.revoked", { session_id: "session_01", actor_id: "actor_01", status: "revoked", reason_code: "user_sign_out", resource_version: 2 }],
    ["account.deletion_requested", { account_deletion_id: "deletion_01", actor_id: "actor_01", status: "deletion_pending", resource_version: 1 }],
    ["account.deletion_cancelled", { account_deletion_id: "deletion_01", actor_id: "actor_01", status: "cancelled", resource_version: 2 }],
    ["account.deleted", { account_deletion_id: "deletion_01", actor_id: "actor_01", status: "deleted", resource_version: 3 }],
  ] as const;
  for (const [event_type, payload] of events) {
    assert.equal(validator.Check({ ...base, event_type, payload }), true, event_type);
    assert.equal(validator.Check({ ...base, event_type, payload: { ...payload, email: "student@example.test" } }), false, event_type);
  }
});
