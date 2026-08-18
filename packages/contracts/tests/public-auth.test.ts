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
  AppleIdentityLinkStartRequestSchema,
  AppleIdentityLinkResponseSchema,
  AuthSessionViewSchema,
  AuthSubjectSchema,
  CompanyCreateRequestSchema,
  CompanyCreateResponseSchema,
  CompanyConsultantRoleGrantRequestSchema,
  CompanyConsultantRoleGrantResponseSchema,
  CompanyConsultantRoleRemoveRequestSchema,
  CompanyConsultantRoleRemoveResponseSchema,
  CompanyMemberInviteRequestSchema,
  CompanyMemberInviteResponseSchema,
  CompanyMemberListRequestSchema,
  CompanyMemberListResponseSchema,
  CompanyMemberViewSchema,
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
  MembershipEventReasonCodeSchema,
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
  ["Apple Web link start", AppleIdentityLinkStartRequestSchema, { ...idem, password: "correct-horse", client_kind: "web", redirect_uri: "https://auth.example.test/callback" }],
  ["Apple native link start", AppleIdentityLinkStartRequestSchema, { ...idem, password: "correct-horse", client_kind: "iphone", redirect_uri: "coreagent://auth/callback", nonce: "opaque_native_nonce", pkce_code_challenge: "a".repeat(43), pkce_code_challenge_method: "S256" }],
  ["session inspect", SessionInspectRequestSchema, { schema_version: 1, session_id: "session_01" }],
  ["session revoke", SessionRevokeRequestSchema, { ...idem, expected_resource_version: 1, session_id: "session_01", reason_code: "user_sign_out" }],
  ["reauthentication", ReauthenticationRequestSchema, { ...idem, expected_resource_version: 1, password: "correct-horse" }],
  ["invitation inspect", InvitationInspectRequestSchema, { schema_version: 1, invitation_secret: invitationSecret }],
  ["invitation email registration", InvitationEmailRegistrationRequestSchema, { ...idem, invitation_secret: invitationSecret, email: "invitee@example.test", password: "correct-horse", client_kind: "web" }],
  ["invitation acceptance", InvitationAcceptanceRequestSchema, { ...idem, expected_resource_version: 1, invitation_secret: invitationSecret, authentication_proof: { kind: "email_password", client_kind: "web", verification_proof: "opaque_verified_email_proof" } }],
  ["invitation revoke", InvitationRevokeRequestSchema, { ...idem, expected_resource_version: 1, invitation_id: "invitation_01", reason_code: "administrator_revoked" }],
  ["company creation", CompanyCreateRequestSchema, { ...idem, display_name: "Synthetic Company", administrator_email: "admin@example.test" }],
  ["company member invite", CompanyMemberInviteRequestSchema, { ...idem, tenant_id: "tenant_01", email: "invitee@example.test", role: "consultant" }],
  ["company member list", CompanyMemberListRequestSchema, { schema_version: 1, tenant_id: "tenant_01", limit: 50 }],
  ["company consultant role grant", CompanyConsultantRoleGrantRequestSchema, { ...idem, grant_mode: "create_profile", membership_id: "membership_01", expected_membership_resource_version: 4 }],
  ["company consultant role remove", CompanyConsultantRoleRemoveRequestSchema, { ...idem, membership_id: "membership_01", expected_membership_resource_version: 5, profile_id: "profile_01", expected_profile_resource_version: 1 }],
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
    ["invitation email registration", InvitationEmailRegistrationResponseSchema, { schema_version: 1, verification_id: "verification_invitation_01", status: "verification_pending" }],
    ["invitation acceptance", InvitationAcceptanceResponseSchema, { schema_version: 1, transport: "web_cookie", role: "consultant", tenant_id: "tenant_01", invitation_resource_version: 2, membership_id: "membership_01", membership_resource_version: 2, profile_id: "profile_01", profile_resource_version: 1, session: sessionView }],
    ["invitation revoke", InvitationRevokeResponseSchema, { schema_version: 1, invitation_id: "invitation_01", status: "revoked", resource_version: 2 }],
    ["company creation", CompanyCreateResponseSchema, { schema_version: 1, tenant_id: "tenant_01", tenant_resource_version: 1, administrator_invitation_id: "invitation_01", administrator_invitation_resource_version: 1, administrator_invitation_secret: invitationSecret }],
    ["company member invite", CompanyMemberInviteResponseSchema, { schema_version: 1, membership_id: "membership_01", membership_resource_version: 1, invitation_id: "invitation_01", invitation_resource_version: 1, invitation_secret: invitationSecret }],
    ["company member list", CompanyMemberListResponseSchema, { schema_version: 1, tenant_id: "tenant_01", members: [{ schema_version: 1, membership_id: "membership_01", actor_id: "actor_01", roles: ["consultant"], status: "active", source: "company", membership_resource_version: 2, profile_id: "profile_01", profile_resource_version: 1, profile_status: "active" }], page_info: { schema_version: 1, has_more: false } }],
    ["company consultant role grant", CompanyConsultantRoleGrantResponseSchema, { schema_version: 1, membership_id: "membership_01", roles: ["admin", "consultant"], membership_resource_version: 5, profile_id: "profile_01", profile_resource_version: 1, profile_status: "active" }],
    ["company consultant role remove", CompanyConsultantRoleRemoveResponseSchema, { schema_version: 1, membership_id: "membership_01", roles: ["admin"], membership_resource_version: 6, profile_id: "profile_01", profile_resource_version: 2, profile_status: "suspended" }],
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

test("Apple link start contains current password and released start fields without provider authority", () => {
  const linkStart = compileRequired("AppleIdentityLinkStartRequestSchema", AppleIdentityLinkStartRequestSchema);
  const web = { ...idem, password: "correct-horse", client_kind: "web", redirect_uri: "https://auth.example.test/callback" };
  assert.equal(linkStart.Check(web), true);
  for (const forbidden of [
    { email: "forged@example.test" },
    { actor_id: "actor_forged" },
    { access_token: "provider-token" },
    { provider_proof: "provider-proof" },
  ]) assert.equal(linkStart.Check({ ...web, ...forbidden }), false);
  assert.equal(compileRequired("AppleIdentityLinkRequestSchema", AppleIdentityLinkRequestSchema).Check({
    ...idem,
    client_kind: "web",
    transaction_id: "oauth_03",
    authorization_code: "opaque_code",
    state: "opaque_state",
    password: "forbidden",
  }), false);
});

test("every durable public mutation is idempotent and existing-resource writes are versioned", () => {
  const readSchemas = new Set([
    SessionInspectRequestSchema,
    InvitationInspectRequestSchema,
    CompanyMemberListRequestSchema,
  ]);
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

test("invitation acceptance returns role-coherent authority for Web and native transports", () => {
  const validator = compileRequired("InvitationAcceptanceResponseSchema", InvitationAcceptanceResponseSchema);
  const webSession = {
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
  const common = {
    schema_version: 1,
    transport: "web_cookie",
    tenant_id: "tenant_01",
    invitation_resource_version: 2,
    membership_id: "membership_01",
    membership_resource_version: 2,
    session: webSession,
  };
  assert.equal(validator.Check({ ...common, role: "admin" }), true);
  assert.equal(validator.Check({ ...common, role: "admin", profile_id: "profile_01", profile_resource_version: 1 }), false);
  assert.equal(validator.Check({ ...common, role: "consultant" }), false);
  assert.equal(validator.Check({ ...common, role: "consultant", profile_id: "profile_01", profile_resource_version: 1 }), true);

  const native = {
    ...common,
    transport: "native",
    role: "consultant",
    profile_id: "profile_01",
    profile_resource_version: 1,
    session: { ...webSession, client_kind: "iphone" },
    session_secret: "s".repeat(43),
  };
  assert.equal(validator.Check(native), true);
});

test("company member list exposes safe role-coherent versions for follow-up writes", () => {
  const view = compileRequired("CompanyMemberViewSchema", CompanyMemberViewSchema);
  const listRequest = compileRequired("CompanyMemberListRequestSchema", CompanyMemberListRequestSchema);
  const listResponse = compileRequired("CompanyMemberListResponseSchema", CompanyMemberListResponseSchema);
  const common = {
    schema_version: 1,
    membership_id: "membership_01",
    actor_id: "actor_01",
    membership_resource_version: 4,
  };
  const platformAdmin = {
    ...common,
    roles: ["admin"],
    status: "active",
    source: "platform",
  };
  const consultant = {
    ...common,
    roles: ["consultant"],
    status: "active",
    source: "company",
    profile_id: "profile_01",
    profile_resource_version: 3,
    profile_status: "active",
  };
  assert.equal(view.Check(platformAdmin), true);
  for (const roles of [["admin"], ["consultant"]]) {
    assert.equal(view.Check({ ...common, source: "company", status: "invited", roles }), true, `invited ${roles[0]}`);
  }
  for (const [status, profile_status] of [["active", "active"], ["suspended", "suspended"], ["revoked", "archived"]]) {
    assert.equal(view.Check({ ...common, source: "company", status, roles: ["admin"] }), true, `${status} admin`);
    assert.equal(view.Check({ ...consultant, status, profile_status }), true, `${status} consultant`);
    assert.equal(view.Check({ ...consultant, status, profile_status, roles: ["admin", "consultant"] }), true, `${status} dual-role`);
    assert.equal(view.Check({ ...consultant, status, profile_status, roles: ["consultant", "admin"] }), false, `${status} reverse dual-role`);
  }
  for (const profile_status of ["suspended", "archived"]) {
    assert.equal(view.Check({ ...consultant, roles: ["admin"], profile_status }), true, `active admin retained ${profile_status}`);
  }
  assert.equal(view.Check({ ...consultant, roles: ["admin"], status: "suspended", profile_status: "suspended" }), true);
  assert.equal(view.Check({ ...consultant, roles: ["admin"], status: "revoked", profile_status: "archived" }), true);
  assert.equal(view.Check({ ...platformAdmin, source: "self" }), false);
  assert.equal(view.Check({ ...platformAdmin, roles: ["consultant"] }), false);
  assert.equal(view.Check({ ...platformAdmin, profile_id: "profile_forbidden", profile_resource_version: 1 }), false);
  assert.equal(view.Check({ ...platformAdmin, status: "suspended" }), false);
  assert.equal(view.Check({ ...common, source: "company", status: "invited", roles: ["admin", "consultant"] }), false);
  assert.equal(view.Check({ ...common, source: "company", status: "invited", roles: ["consultant"], profile_id: "profile_forbidden", profile_resource_version: 1, profile_status: "active" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin"], profile_status: "active" }), false);
  assert.equal(view.Check({ ...consultant, status: "suspended", profile_status: "active" }), false);
  assert.equal(view.Check({ ...consultant, status: "suspended", profile_status: "archived" }), false);
  assert.equal(view.Check({ ...consultant, status: "revoked", profile_status: "active" }), false);
  assert.equal(view.Check({ ...consultant, status: "revoked", profile_status: "suspended" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin", "consultant"], status: "active", profile_status: "suspended" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin", "consultant"], status: "active", profile_status: "archived" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin", "consultant"], status: "suspended", profile_status: "active" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin", "consultant"], status: "suspended", profile_status: "archived" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin", "consultant"], status: "revoked", profile_status: "active" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin", "consultant"], status: "revoked", profile_status: "suspended" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin"], status: "suspended", profile_status: "archived" }), false);
  assert.equal(view.Check({ ...consultant, roles: ["admin"], status: "revoked", profile_status: "suspended" }), false);
  assert.equal(view.Check({ ...consultant, profile_id: undefined, profile_resource_version: undefined, profile_status: undefined }), false);
  assert.equal(view.Check({ ...common, source: "company", status: "active", roles: ["student"] }), false);
  for (const forbidden of ["email", "provider_subject", "access_token"]) {
    assert.equal(view.Check({ ...consultant, [forbidden]: "sentinel" }), false, forbidden);
  }

  const request = { schema_version: 1, tenant_id: "tenant_01", cursor: "cursor_01", limit: 50 };
  const response = {
    schema_version: 1,
    tenant_id: "tenant_01",
    members: [platformAdmin, consultant],
    page_info: { schema_version: 1, next_cursor: "cursor_02", has_more: true },
  };
  assert.equal(listRequest.Check(request), true);
  assert.equal(listResponse.Check(response), true);
  assert.equal(compileRequired("CompanyMemberSuspendRequestSchema", CompanyMemberSuspendRequestSchema).Check({ ...idem, membership_id: consultant.membership_id, expected_resource_version: consultant.membership_resource_version, reason_code: "administrator_suspended" }), true);
  assert.equal(compileRequired("CompanyMemberRevokeRequestSchema", CompanyMemberRevokeRequestSchema).Check({ ...idem, membership_id: consultant.membership_id, expected_resource_version: consultant.membership_resource_version, reason_code: "administrator_revoked" }), true);
});

test("membership event reasons publish the complete closed lifecycle vocabulary", () => {
  const reason = compileRequired("MembershipEventReasonCodeSchema", MembershipEventReasonCodeSchema);
  const identityEvent = compileRequired("IdentityEventSchema", IdentityEventSchema);
  const base = {
    schema_version: 1,
    event_id: "event_membership",
    occurred_at: timestamp,
    sequence: 1,
    tenant_id: "tenant_01",
    request_id: "request_01",
    trace_id: "trace_01",
    correlation_id: "correlation_01",
    causation_id: "causation_01",
    event_type: "membership.changed",
  };
  const reasons = [
    "invitation_accepted",
    "administrator_suspended",
    "administrator_revoked",
    "consultant_role_granted",
    "consultant_role_revoked",
    "platform_role_projected",
    "platform_role_revoked",
    "account_deletion_requested",
    "account_deletion_cancelled",
    "actor_disabled",
    "tenant_closed",
  ];
  for (const reason_code of reasons) {
    assert.equal(reason.Check(reason_code), true, reason_code);
    assert.equal(identityEvent.Check({
      ...base,
      payload: {
        membership_id: "membership_01",
        actor_id: "actor_01",
        status: "active",
        reason_code,
        resource_version: 2,
      },
    }), true, reason_code);
  }
  assert.equal(reason.Check("unknown_membership_reason"), false);
  assert.equal(identityEvent.Check({
    ...base,
    payload: {
      membership_id: "membership_01",
      actor_id: "actor_01",
      status: "active",
      reason_code: "unknown_membership_reason",
      resource_version: 2,
    },
  }), false);
});

test("consultant role commands expose closed canonical Membership and Profile version loops", () => {
  const grantRequest = compileRequired("CompanyConsultantRoleGrantRequestSchema", CompanyConsultantRoleGrantRequestSchema);
  const grantResponse = compileRequired("CompanyConsultantRoleGrantResponseSchema", CompanyConsultantRoleGrantResponseSchema);
  const removeRequest = compileRequired("CompanyConsultantRoleRemoveRequestSchema", CompanyConsultantRoleRemoveRequestSchema);
  const removeResponse = compileRequired("CompanyConsultantRoleRemoveResponseSchema", CompanyConsultantRoleRemoveResponseSchema);
  const memberView = compileRequired("CompanyMemberViewSchema", CompanyMemberViewSchema);
  const admin = {
    schema_version: 1,
    membership_id: "membership_01",
    actor_id: "actor_01",
    roles: ["admin"],
    status: "active",
    source: "company",
    membership_resource_version: 4,
  };
  const grant = {
    ...idem,
    grant_mode: "create_profile",
    membership_id: admin.membership_id,
    expected_membership_resource_version: admin.membership_resource_version,
  };
  assert.equal(memberView.Check(admin), true);
  assert.equal(grantRequest.Check(grant), true);
  assert.equal(grantRequest.Check({ ...grant, grant_mode: undefined }), false);
  assert.equal(grantRequest.Check({ ...grant, profile_id: "profile_forged", expected_profile_resource_version: 1 }), false);
  for (const field of ["roles", "action", "profile_status"]) {
    assert.equal(grantRequest.Check({ ...grant, [field]: field === "roles" ? ["consultant"] : "client_forged" }), false, field);
  }

  const granted = {
    schema_version: 1,
    membership_id: admin.membership_id,
    roles: ["admin", "consultant"],
    membership_resource_version: 5,
    profile_id: "profile_01",
    profile_resource_version: 1,
    profile_status: "active",
  };
  assert.equal(grantResponse.Check(granted), true);
  assert.equal(grantResponse.Check({ ...granted, roles: ["consultant", "admin"] }), false);
  const remove = {
    ...idem,
    membership_id: granted.membership_id,
    expected_membership_resource_version: granted.membership_resource_version,
    profile_id: granted.profile_id,
    expected_profile_resource_version: granted.profile_resource_version,
  };
  assert.equal(removeRequest.Check(remove), true);
  assert.equal(removeRequest.Check({ ...remove, expected_profile_resource_version: undefined }), false);
  for (const field of ["roles", "action", "profile_status"]) {
    assert.equal(removeRequest.Check({ ...remove, [field]: field === "roles" ? ["admin"] : "client_forged" }), false, field);
  }

  const removed = {
    schema_version: 1,
    membership_id: granted.membership_id,
    roles: ["admin"],
    membership_resource_version: 6,
    profile_id: granted.profile_id,
    profile_resource_version: 2,
    profile_status: "suspended",
  };
  assert.equal(removeResponse.Check(removed), true);
  assert.equal(removeResponse.Check({ ...removed, profile_status: "active" }), false);
  const retained = {
    ...admin,
    membership_resource_version: removed.membership_resource_version,
    profile_id: removed.profile_id,
    profile_resource_version: removed.profile_resource_version,
    profile_status: removed.profile_status,
  };
  assert.equal(memberView.Check(retained), true);

  const regrant = {
    schema_version: 1,
    idempotency_key: "idem_regrant",
    payload_hash: `sha256:${"b".repeat(64)}`,
    grant_mode: "reactivate_profile",
    membership_id: retained.membership_id,
    expected_membership_resource_version: retained.membership_resource_version,
    profile_id: retained.profile_id,
    expected_profile_resource_version: retained.profile_resource_version,
  };
  assert.equal(grantRequest.Check(regrant), true);
  assert.equal(grantRequest.Check({ ...regrant, profile_id: undefined }), false);
  assert.equal(grantRequest.Check({ ...regrant, expected_profile_resource_version: undefined }), false);
  assert.equal(grantRequest.Check({ ...regrant, expected_profile_resource_version: 0 }), false);
  assert.equal(grantRequest.Check({ ...regrant, profile_resource_version: regrant.expected_profile_resource_version }), false);
  assert.equal(grantRequest.Check({ ...regrant, grant_mode: "reuse_profile" }), false);

  const regranted = {
    ...granted,
    membership_resource_version: 7,
    profile_resource_version: 3,
  };
  assert.equal(grantResponse.Check(regranted), true);
  assert.equal(memberView.Check({
    ...admin,
    roles: regranted.roles,
    membership_resource_version: regranted.membership_resource_version,
    profile_id: regranted.profile_id,
    profile_resource_version: regranted.profile_resource_version,
    profile_status: regranted.profile_status,
  }), true);
});

test("public mutation reasons are scoped to caller-authorized commands", () => {
  const cases: Array<[string, unknown, unknown, readonly string[]]> = [
    ["Session revoke", SessionRevokeRequestSchema, { ...idem, expected_resource_version: 1, session_id: "session_01" }, ["user_sign_out", "administrator_revoked"]],
    ["invitation revoke", InvitationRevokeRequestSchema, { ...idem, expected_resource_version: 1, invitation_id: "invitation_01" }, ["administrator_revoked"]],
    ["member suspend", CompanyMemberSuspendRequestSchema, { ...idem, expected_resource_version: 1, membership_id: "membership_01" }, ["administrator_suspended"]],
    ["member revoke", CompanyMemberRevokeRequestSchema, { ...idem, expected_resource_version: 1, membership_id: "membership_01" }, ["administrator_revoked"]],
    ["account deletion", AccountDeletionRequestSchema, { ...idem, expected_resource_version: 1 }, ["user_requested"]],
  ];
  const allReasons = [
    "user_sign_out",
    "administrator_suspended",
    "administrator_revoked",
    "user_requested",
    "password_reset",
    "provider_unlinked",
    "actor_disabled",
    "account_deletion_requested",
    "expired",
  ];
  for (const [name, schema, base, allowed] of cases) {
    const validator = compileRequired(name, schema);
    for (const reason_code of allReasons) {
      assert.equal(validator.Check({ ...(base as object), reason_code }), allowed.includes(reason_code), `${name}: ${reason_code}`);
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
  assert.equal(pending.Check({
    schema_version: 1,
    verification_id: "verification_invitation_01",
    status: "verification_pending",
  }), true);
  assert.equal(pending.Check({ schema_version: 1, status: "verification_pending" }), true, "0.6 remains additive while the Gateway always returns the binding");
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
    ["invitation.changed", { invitation_id: "invitation_01", membership_id: "membership_01", status: "revoked", resource_version: 2 }],
    ["invitation.changed", { invitation_id: "invitation_01", membership_id: "membership_01", status: "replaced", resource_version: 2, replacement_invitation_id: "invitation_02" }],
    ["invitation.changed", { invitation_id: "invitation_01", membership_id: "membership_01", status: "expired", resource_version: 2 }],
    ["platform_role.changed", { platform_role_assignment_id: "platform_role_01", actor_id: "actor_01", status: "active", resource_version: 1 }],
    ["platform_role.changed", { platform_role_assignment_id: "platform_role_01", actor_id: "actor_01", status: "revoked", resource_version: 2 }],
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
  assert.equal(validator.Check({
    ...base,
    event_type: "invitation.changed",
    payload: { invitation_id: "invitation_01", membership_id: "membership_01", status: "accepted", resource_version: 2 },
  }), false);
  assert.equal(validator.Check({
    ...base,
    event_type: "platform_role.changed",
    payload: { platform_role_assignment_id: "platform_role_01", actor_id: "actor_01", status: "active", resource_version: 1, tenant_role: "admin" },
  }), false);
});
