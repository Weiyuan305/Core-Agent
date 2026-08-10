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
  CompanyMembershipRequestSchema,
  CompanyMembershipResponseSchema,
  CoreSessionClientKindSchema,
  CoreSessionSchema,
  CoreSessionStatusSchema,
  EmailSignInRequestSchema,
  EmailSignInResponseSchema,
  EmailSignUpRequestSchema,
  EmailSignUpResponseSchema,
  InvitationAcceptanceRequestSchema,
  InvitationAcceptanceResponseSchema,
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
} = Contracts as unknown as Record<string, any>;

const timestamp = "2026-08-10T01:02:03Z";
const resource = { schema_version: 1 as const, resource_version: 1, created_at: timestamp, updated_at: timestamp };
const idem = { schema_version: 1 as const, idempotency_key: "idem_01", payload_hash: `sha256:${"a".repeat(64)}` };
const providerKinds = ["email_password", "apple"] as const;
const coreSessionClients = ["web", "iphone", "macos"] as const;
const coreSessionStatuses = ["active", "revoked", "expired"] as const;
const invitationStatuses = ["pending", "accepted", "revoked", "expired", "replaced"] as const;
const platformRoles = ["platform_super_admin"] as const;
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
});

const requestCases: Array<[string, unknown, unknown]> = [
  ["email sign-up", EmailSignUpRequestSchema, { ...idem, email: "student@example.test", password: "correct-horse", client_kind: "web" }],
  ["email sign-in", EmailSignInRequestSchema, { schema_version: 1, email: "student@example.test", password: "correct-horse", client_kind: "iphone", device_label: "Phone" }],
  ["password reset", PasswordResetRequestSchema, { schema_version: 1, email: "student@example.test" }],
  ["Apple start", AppleAuthorizationStartRequestSchema, { schema_version: 1, client_kind: "web", redirect_uri: "https://auth.example.test/callback" }],
  ["Apple callback", AppleAuthorizationCallbackRequestSchema, { ...idem, transaction_id: "oauth_01", authorization_code: "opaque_code", state: "opaque_state" }],
  ["Apple link", AppleIdentityLinkRequestSchema, { ...idem, transaction_id: "oauth_02", authorization_code: "opaque_code", state: "opaque_state" }],
  ["session inspect", SessionInspectRequestSchema, { schema_version: 1, session_id: "session_01" }],
  ["session revoke", SessionRevokeRequestSchema, { ...idem, session_id: "session_01", reason_code: "user_sign_out" }],
  ["reauthentication", ReauthenticationRequestSchema, { schema_version: 1, password: "correct-horse" }],
  ["invitation acceptance", InvitationAcceptanceRequestSchema, { ...idem, invitation_secret: "opaque_invitation_secret", client_kind: "web" }],
  ["company creation", CompanyCreateRequestSchema, { ...idem, display_name: "Synthetic Company", administrator_invitation_ref: "invite_ref_01" }],
  ["company membership", CompanyMembershipRequestSchema, { ...idem, tenant_id: "tenant_01", role: "consultant", invitation_ref: "invite_ref_02" }],
  ["account deletion", AccountDeletionRequestSchema, { ...idem, reason_code: "user_requested" }],
  ["account deletion cancel", AccountDeletionCancelRequestSchema, { ...idem, account_deletion_id: "deletion_01" }],
];

test("every public auth request has an exact closed shape", () => {
  for (const [name, schema, value] of requestCases) {
    const validator = compileRequired(name, schema);
    assert.equal(validator.Check(value), true, name);
    assert.equal(validator.Check({ ...(value as object), tenant_override: "forged" }), false, name);
  }
});

test("every public auth response is closed and provider-neutral", () => {
  const sessionView = { schema_version: 1, actor_id: "actor_01", session_id: "session_01", client_kind: "web", idle_expires_at: timestamp, absolute_expires_at: timestamp, reauthentication_required: false };
  const responseCases: Array<[string, unknown, unknown]> = [
    ["email sign-up", EmailSignUpResponseSchema, { schema_version: 1, actor_id: "actor_01", tenant_id: "tenant_01", membership_id: "membership_01", profile_id: "profile_01", session: sessionView }],
    ["email sign-in", EmailSignInResponseSchema, { schema_version: 1, session: sessionView }],
    ["password reset", PasswordResetResponseSchema, { schema_version: 1, accepted: true }],
    ["Apple start", AppleAuthorizationStartResponseSchema, { schema_version: 1, transaction_id: "oauth_01", authorization_url: "https://appleid.apple.com/auth/authorize", expires_at: timestamp }],
    ["Apple callback", AppleAuthorizationCallbackResponseSchema, { schema_version: 1, session: sessionView }],
    ["Apple link", AppleIdentityLinkResponseSchema, { schema_version: 1, auth_subject_id: "auth_01", linked: true }],
    ["session inspect", SessionInspectResponseSchema, { schema_version: 1, session: sessionView }],
    ["session revoke", SessionRevokeResponseSchema, { schema_version: 1, session_id: "session_01", status: "revoked" }],
    ["reauthentication", ReauthenticationResponseSchema, { schema_version: 1, reauthenticated_at: timestamp, valid_until: timestamp }],
    ["invitation acceptance", InvitationAcceptanceResponseSchema, { schema_version: 1, tenant_id: "tenant_01", membership_id: "membership_01", profile_id: "profile_01", session: sessionView }],
    ["company creation", CompanyCreateResponseSchema, { schema_version: 1, tenant_id: "tenant_01", administrator_invitation_id: "invitation_01" }],
    ["company membership", CompanyMembershipResponseSchema, { schema_version: 1, membership_id: "membership_01", invitation_id: "invitation_01" }],
    ["account deletion", AccountDeletionResponseSchema, { schema_version: 1, account_deletion_id: "deletion_01", status: "deletion_pending", scheduled_for: timestamp }],
    ["account deletion cancel", AccountDeletionCancelResponseSchema, { schema_version: 1, account_deletion_id: "deletion_01", status: "cancelled" }],
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
