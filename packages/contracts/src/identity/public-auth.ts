import Type, { type Static, type TProperties } from "typebox";

import {
  OpaqueIdSchema,
  PageInfoSchema,
  PageRequestSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { IdempotencyRequestSchema } from "../runtime/idempotency.js";
import {
  CoreSessionClientKindSchema,
  InvitationRoleSchema,
  InvitationStatusSchema,
} from "./authority.js";
import { MembershipStatusSchema } from "../tenant/identity.js";

const EmailSchema = Type.String({ minLength: 3, maxLength: 320, format: "email" });
const PasswordSchema = Type.String({ minLength: 8, maxLength: 1_024 });
const DeviceLabelSchema = Type.String({ minLength: 1, maxLength: 80 });
const OAuthProofSchema = Type.String({ minLength: 8, maxLength: 4_096 });
const SessionSecretSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
const PkceChallengeSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
const PkceVerifierSchema = Type.String({ minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" });
const RedirectUriSchema = Type.String({ minLength: 1, maxLength: 2_048, format: "uri" });
const InvitationSecretSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
const PublicSessionRevocationReasonSchema = Type.Union([
  Type.Literal("user_sign_out"),
  Type.Literal("administrator_revoked"),
]);
const InvitationRevocationReasonSchema = Type.Literal("administrator_revoked");
const MemberSuspensionReasonSchema = Type.Literal("administrator_suspended");
const MemberRevocationReasonSchema = Type.Literal("administrator_revoked");
const AccountDeletionRequestReasonSchema = Type.Literal("user_requested");
const CompanyMemberSourceSchema = Type.Union([
  Type.Literal("company"),
  Type.Literal("platform"),
]);
const NativeClientKindSchema = Type.Union([Type.Literal("iphone"), Type.Literal("macos")]);
const IdempotencyRequestProperties = IdempotencyRequestSchema.properties;
const VersionedWriteProperties = {
  ...IdempotencyRequestProperties,
  expected_resource_version: ResourceVersionSchema,
} as const;

function request<const Properties extends TProperties>(id: string, properties: Properties) {
  return Type.Object(properties, { additionalProperties: false, $id: `core-agent://v1/${id}` });
}

function response<const Properties extends TProperties>(id: string, properties: Properties) {
  return Type.Object(properties, { additionalProperties: false, $id: `core-agent://v1/${id}` });
}

const AuthSessionViewFields = {
  schema_version: SchemaVersionSchema,
  actor_id: OpaqueIdSchema,
  actor_resource_version: ResourceVersionSchema,
  session_id: OpaqueIdSchema,
  session_resource_version: ResourceVersionSchema,
  client_kind: CoreSessionClientKindSchema,
  idle_expires_at: UtcTimestampSchema,
  absolute_expires_at: UtcTimestampSchema,
  reauthentication_required: Type.Boolean(),
} as const;
const WebAuthSessionViewSchema = Type.Object(
  { ...AuthSessionViewFields, client_kind: Type.Literal("web") },
  { additionalProperties: false },
);
const NativeAuthSessionViewSchema = Type.Object(
  { ...AuthSessionViewFields, client_kind: NativeClientKindSchema },
  { additionalProperties: false },
);

function webSessionDelivery<const Extra extends TProperties>(extra: Extra) {
  return Type.Object({
    schema_version: SchemaVersionSchema,
    transport: Type.Literal("web_cookie"),
    ...extra,
    session: WebAuthSessionViewSchema,
  }, { additionalProperties: false });
}

function nativeSessionDelivery<const Extra extends TProperties>(extra: Extra) {
  return Type.Object({
    schema_version: SchemaVersionSchema,
    transport: Type.Literal("native"),
    ...extra,
    session: NativeAuthSessionViewSchema,
    session_secret: SessionSecretSchema,
  }, { additionalProperties: false });
}

function sessionDelivery<const Extra extends TProperties>(id: string, extra: Extra) {
  return Type.Union([
    webSessionDelivery(extra),
    nativeSessionDelivery(extra),
  ], { $id: `core-agent://v1/${id}` });
}

const WebAppleCallbackFields = {
  client_kind: Type.Literal("web"),
  transaction_id: OpaqueIdSchema,
  authorization_code: OAuthProofSchema,
  state: OAuthProofSchema,
} as const;
const NativeAppleCallbackFields = {
  client_kind: NativeClientKindSchema,
  transaction_id: OpaqueIdSchema,
  authorization_code: OAuthProofSchema,
  state: OAuthProofSchema,
  nonce: OAuthProofSchema,
  pkce_code_verifier: PkceVerifierSchema,
} as const;

export const AuthSessionViewSchema = response("auth-session-view", AuthSessionViewFields);

export const EmailSignUpRequestSchema = request("email-sign-up-request", {
  ...IdempotencyRequestProperties,
  email: EmailSchema,
  password: PasswordSchema,
  client_kind: CoreSessionClientKindSchema,
  device_label: Type.Optional(DeviceLabelSchema),
});
export const EmailSignUpResponseSchema = response("email-sign-up-response", {
  schema_version: SchemaVersionSchema,
  verification_id: OpaqueIdSchema,
  status: Type.Literal("verification_pending"),
});
export const EmailVerificationRequestSchema = request("email-verification-request", {
  ...IdempotencyRequestProperties,
  verification_id: OpaqueIdSchema,
  verification_code: OAuthProofSchema,
});
export const EmailVerificationResponseSchema = sessionDelivery("email-verification-response", {});

export const EmailSignInRequestSchema = request("email-sign-in-request", {
  ...IdempotencyRequestProperties,
  email: EmailSchema,
  password: PasswordSchema,
  client_kind: CoreSessionClientKindSchema,
  device_label: Type.Optional(DeviceLabelSchema),
});
export const EmailSignInResponseSchema = sessionDelivery("email-sign-in-response", {});

export const PasswordResetRequestSchema = request("password-reset-request", {
  ...IdempotencyRequestProperties,
  email: EmailSchema,
});
export const PasswordResetResponseSchema = response("password-reset-response", {
  schema_version: SchemaVersionSchema,
  accepted: Type.Literal(true),
});

export const AppleAuthorizationStartRequestSchema = Type.Union([
  Type.Object({
    ...IdempotencyRequestProperties,
    client_kind: Type.Literal("web"),
    redirect_uri: RedirectUriSchema,
    device_label: Type.Optional(DeviceLabelSchema),
  }, { additionalProperties: false }),
  Type.Object({
    ...IdempotencyRequestProperties,
    client_kind: NativeClientKindSchema,
    redirect_uri: RedirectUriSchema,
    nonce: OAuthProofSchema,
    pkce_code_challenge: PkceChallengeSchema,
    pkce_code_challenge_method: Type.Literal("S256"),
    device_label: Type.Optional(DeviceLabelSchema),
  }, { additionalProperties: false }),
], { $id: "core-agent://v1/apple-authorization-start-request" });
export const AppleAuthorizationStartResponseSchema = response("apple-authorization-start-response", {
  schema_version: SchemaVersionSchema,
  transaction_id: OpaqueIdSchema,
  authorization_url: RedirectUriSchema,
  expires_at: UtcTimestampSchema,
});

export const AppleAuthorizationCallbackRequestSchema = Type.Union([
  Type.Object({ ...IdempotencyRequestProperties, ...WebAppleCallbackFields }, { additionalProperties: false }),
  Type.Object({ ...IdempotencyRequestProperties, ...NativeAppleCallbackFields }, { additionalProperties: false }),
], { $id: "core-agent://v1/apple-authorization-callback-request" });
export const AppleAuthorizationCallbackResponseSchema = sessionDelivery(
  "apple-authorization-callback-response",
  {},
);
export const AppleIdentityLinkRequestSchema = Type.Union([
  Type.Object({ ...IdempotencyRequestProperties, ...WebAppleCallbackFields }, { additionalProperties: false }),
  Type.Object({ ...IdempotencyRequestProperties, ...NativeAppleCallbackFields }, { additionalProperties: false }),
], { $id: "core-agent://v1/apple-identity-link-request" });
export const AppleIdentityLinkResponseSchema = response("apple-identity-link-response", {
  schema_version: SchemaVersionSchema,
  auth_subject_id: OpaqueIdSchema,
  linked: Type.Literal(true),
});

export const SessionInspectRequestSchema = request("session-inspect-request", {
  schema_version: SchemaVersionSchema,
  session_id: OpaqueIdSchema,
});
export const SessionInspectResponseSchema = response("session-inspect-response", {
  schema_version: SchemaVersionSchema,
  session: Type.Object(AuthSessionViewFields, { additionalProperties: false }),
});
export const SessionRevokeRequestSchema = request("session-revoke-request", {
  ...VersionedWriteProperties,
  session_id: OpaqueIdSchema,
  reason_code: PublicSessionRevocationReasonSchema,
});
export const SessionRevokeResponseSchema = response("session-revoke-response", {
  schema_version: SchemaVersionSchema,
  session_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
  resource_version: ResourceVersionSchema,
});

export const ReauthenticationRequestSchema = request("reauthentication-request", {
  ...VersionedWriteProperties,
  password: PasswordSchema,
});
export const ReauthenticationResponseSchema = response("reauthentication-response", {
  schema_version: SchemaVersionSchema,
  reauthenticated_at: UtcTimestampSchema,
  valid_until: UtcTimestampSchema,
  session_resource_version: ResourceVersionSchema,
});

export const InvitationInspectRequestSchema = request("invitation-inspect-request", {
  schema_version: SchemaVersionSchema,
  invitation_secret: InvitationSecretSchema,
});
export const InvitationInspectResponseSchema = response("invitation-inspect-response", {
  schema_version: SchemaVersionSchema,
  invitation_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  role: InvitationRoleSchema,
  status: InvitationStatusSchema,
  expires_at: UtcTimestampSchema,
  resource_version: ResourceVersionSchema,
});

export const InvitationEmailRegistrationRequestSchema = request("invitation-email-registration-request", {
  ...IdempotencyRequestProperties,
  invitation_secret: InvitationSecretSchema,
  email: EmailSchema,
  password: PasswordSchema,
  client_kind: CoreSessionClientKindSchema,
  device_label: Type.Optional(DeviceLabelSchema),
});
export const InvitationEmailRegistrationResponseSchema = response("invitation-email-registration-response", {
  schema_version: SchemaVersionSchema,
  status: Type.Literal("verification_pending"),
});

const InvitationEmailPasswordProofSchema = Type.Object({
  kind: Type.Literal("email_password"),
  client_kind: CoreSessionClientKindSchema,
  verification_proof: OAuthProofSchema,
}, { additionalProperties: false });
const InvitationAppleWebProofSchema = Type.Object({
  kind: Type.Literal("apple"),
  ...WebAppleCallbackFields,
}, { additionalProperties: false });
const InvitationAppleNativeProofSchema = Type.Object({
  kind: Type.Literal("apple"),
  ...NativeAppleCallbackFields,
}, { additionalProperties: false });
export const InvitationAuthenticationProofSchema = Type.Union([
  InvitationEmailPasswordProofSchema,
  InvitationAppleWebProofSchema,
  InvitationAppleNativeProofSchema,
]);

export const InvitationAcceptanceRequestSchema = request("invitation-acceptance-request", {
  ...VersionedWriteProperties,
  invitation_secret: InvitationSecretSchema,
  authentication_proof: InvitationAuthenticationProofSchema,
  device_label: Type.Optional(DeviceLabelSchema),
});
const InvitationAcceptanceCommonFields = {
  tenant_id: OpaqueIdSchema,
  invitation_resource_version: ResourceVersionSchema,
  membership_id: OpaqueIdSchema,
  membership_resource_version: ResourceVersionSchema,
} as const;
const InvitationAcceptanceAdminFields = {
  ...InvitationAcceptanceCommonFields,
  role: Type.Literal("admin"),
} as const;
const InvitationAcceptanceConsultantFields = {
  ...InvitationAcceptanceCommonFields,
  role: Type.Literal("consultant"),
  profile_id: OpaqueIdSchema,
  profile_resource_version: ResourceVersionSchema,
} as const;
export const InvitationAcceptanceResponseSchema = Type.Union([
  webSessionDelivery(InvitationAcceptanceAdminFields),
  nativeSessionDelivery(InvitationAcceptanceAdminFields),
  webSessionDelivery(InvitationAcceptanceConsultantFields),
  nativeSessionDelivery(InvitationAcceptanceConsultantFields),
], { $id: "core-agent://v1/invitation-acceptance-response" });
export const InvitationRevokeRequestSchema = request("invitation-revoke-request", {
  ...VersionedWriteProperties,
  invitation_id: OpaqueIdSchema,
  reason_code: InvitationRevocationReasonSchema,
});
export const InvitationRevokeResponseSchema = response("invitation-revoke-response", {
  schema_version: SchemaVersionSchema,
  invitation_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
  resource_version: ResourceVersionSchema,
});

export const CompanyCreateRequestSchema = request("company-create-request", {
  ...IdempotencyRequestProperties,
  display_name: Type.String({ minLength: 1, maxLength: 200 }),
  administrator_email: EmailSchema,
});
export const CompanyCreateResponseSchema = response("company-create-response", {
  schema_version: SchemaVersionSchema,
  tenant_id: OpaqueIdSchema,
  tenant_resource_version: ResourceVersionSchema,
  administrator_invitation_id: OpaqueIdSchema,
  administrator_invitation_resource_version: ResourceVersionSchema,
  administrator_invitation_secret: InvitationSecretSchema,
});
export const CompanyMemberInviteRequestSchema = request("company-member-invite-request", {
  ...IdempotencyRequestProperties,
  tenant_id: OpaqueIdSchema,
  email: EmailSchema,
  role: InvitationRoleSchema,
});
export const CompanyMemberInviteResponseSchema = response("company-member-invite-response", {
  schema_version: SchemaVersionSchema,
  membership_id: OpaqueIdSchema,
  membership_resource_version: ResourceVersionSchema,
  invitation_id: OpaqueIdSchema,
  invitation_resource_version: ResourceVersionSchema,
  invitation_secret: InvitationSecretSchema,
});
const CompanyMemberViewCommonFields = {
  schema_version: SchemaVersionSchema,
  membership_id: OpaqueIdSchema,
  actor_id: OpaqueIdSchema,
  status: MembershipStatusSchema,
  source: CompanyMemberSourceSchema,
  membership_resource_version: ResourceVersionSchema,
} as const;
export const CompanyMemberViewSchema = Type.Union([
  Type.Object({
    ...CompanyMemberViewCommonFields,
    role: Type.Literal("admin"),
  }, { additionalProperties: false }),
  Type.Object({
    ...CompanyMemberViewCommonFields,
    role: Type.Literal("consultant"),
    profile_id: OpaqueIdSchema,
    profile_resource_version: ResourceVersionSchema,
  }, { additionalProperties: false }),
], { $id: "core-agent://v1/company-member-view" });
export const CompanyMemberListRequestSchema = request("company-member-list-request", {
  ...PageRequestSchema.properties,
  tenant_id: OpaqueIdSchema,
});
export const CompanyMemberListResponseSchema = response("company-member-list-response", {
  schema_version: SchemaVersionSchema,
  tenant_id: OpaqueIdSchema,
  members: Type.Array(CompanyMemberViewSchema, { maxItems: 200 }),
  page_info: PageInfoSchema,
});
export const CompanyMemberSuspendRequestSchema = request("company-member-suspend-request", {
  ...VersionedWriteProperties,
  membership_id: OpaqueIdSchema,
  reason_code: MemberSuspensionReasonSchema,
});
export const CompanyMemberSuspendResponseSchema = response("company-member-suspend-response", {
  schema_version: SchemaVersionSchema,
  membership_id: OpaqueIdSchema,
  status: Type.Literal("suspended"),
  resource_version: ResourceVersionSchema,
});
export const CompanyMemberRevokeRequestSchema = request("company-member-revoke-request", {
  ...VersionedWriteProperties,
  membership_id: OpaqueIdSchema,
  reason_code: MemberRevocationReasonSchema,
});
export const CompanyMemberRevokeResponseSchema = response("company-member-revoke-response", {
  schema_version: SchemaVersionSchema,
  membership_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
  resource_version: ResourceVersionSchema,
});

export const AccountDeletionRequestSchema = request("account-deletion-request", {
  ...VersionedWriteProperties,
  reason_code: AccountDeletionRequestReasonSchema,
});
export const AccountDeletionResponseSchema = response("account-deletion-response", {
  schema_version: SchemaVersionSchema,
  account_deletion_id: OpaqueIdSchema,
  status: Type.Literal("deletion_pending"),
  scheduled_for: UtcTimestampSchema,
  resource_version: ResourceVersionSchema,
});
export const AccountDeletionCancelRequestSchema = request("account-deletion-cancel-request", {
  ...VersionedWriteProperties,
  account_deletion_id: OpaqueIdSchema,
});
export const AccountDeletionCancelResponseSchema = response("account-deletion-cancel-response", {
  schema_version: SchemaVersionSchema,
  account_deletion_id: OpaqueIdSchema,
  status: Type.Literal("cancelled"),
  resource_version: ResourceVersionSchema,
});

export type AuthSessionView = Static<typeof AuthSessionViewSchema>;
export type EmailSignUpRequest = Static<typeof EmailSignUpRequestSchema>;
export type EmailSignUpResponse = Static<typeof EmailSignUpResponseSchema>;
export type EmailVerificationRequest = Static<typeof EmailVerificationRequestSchema>;
export type EmailVerificationResponse = Static<typeof EmailVerificationResponseSchema>;
export type EmailSignInRequest = Static<typeof EmailSignInRequestSchema>;
export type EmailSignInResponse = Static<typeof EmailSignInResponseSchema>;
export type PasswordResetRequest = Static<typeof PasswordResetRequestSchema>;
export type PasswordResetResponse = Static<typeof PasswordResetResponseSchema>;
export type AppleAuthorizationStartRequest = Static<typeof AppleAuthorizationStartRequestSchema>;
export type AppleAuthorizationStartResponse = Static<typeof AppleAuthorizationStartResponseSchema>;
export type AppleAuthorizationCallbackRequest = Static<typeof AppleAuthorizationCallbackRequestSchema>;
export type AppleAuthorizationCallbackResponse = Static<typeof AppleAuthorizationCallbackResponseSchema>;
export type AppleIdentityLinkRequest = Static<typeof AppleIdentityLinkRequestSchema>;
export type AppleIdentityLinkResponse = Static<typeof AppleIdentityLinkResponseSchema>;
export type SessionInspectRequest = Static<typeof SessionInspectRequestSchema>;
export type SessionInspectResponse = Static<typeof SessionInspectResponseSchema>;
export type SessionRevokeRequest = Static<typeof SessionRevokeRequestSchema>;
export type SessionRevokeResponse = Static<typeof SessionRevokeResponseSchema>;
export type ReauthenticationRequest = Static<typeof ReauthenticationRequestSchema>;
export type ReauthenticationResponse = Static<typeof ReauthenticationResponseSchema>;
export type InvitationInspectRequest = Static<typeof InvitationInspectRequestSchema>;
export type InvitationInspectResponse = Static<typeof InvitationInspectResponseSchema>;
export type InvitationEmailRegistrationRequest = Static<typeof InvitationEmailRegistrationRequestSchema>;
export type InvitationEmailRegistrationResponse = Static<typeof InvitationEmailRegistrationResponseSchema>;
export type InvitationAcceptanceRequest = Static<typeof InvitationAcceptanceRequestSchema>;
export type InvitationAcceptanceResponse = Static<typeof InvitationAcceptanceResponseSchema>;
export type InvitationRevokeRequest = Static<typeof InvitationRevokeRequestSchema>;
export type InvitationRevokeResponse = Static<typeof InvitationRevokeResponseSchema>;
export type CompanyCreateRequest = Static<typeof CompanyCreateRequestSchema>;
export type CompanyCreateResponse = Static<typeof CompanyCreateResponseSchema>;
export type CompanyMemberInviteRequest = Static<typeof CompanyMemberInviteRequestSchema>;
export type CompanyMemberInviteResponse = Static<typeof CompanyMemberInviteResponseSchema>;
export type CompanyMemberView = Static<typeof CompanyMemberViewSchema>;
export type CompanyMemberListRequest = Static<typeof CompanyMemberListRequestSchema>;
export type CompanyMemberListResponse = Static<typeof CompanyMemberListResponseSchema>;
export type CompanyMemberSuspendRequest = Static<typeof CompanyMemberSuspendRequestSchema>;
export type CompanyMemberSuspendResponse = Static<typeof CompanyMemberSuspendResponseSchema>;
export type CompanyMemberRevokeRequest = Static<typeof CompanyMemberRevokeRequestSchema>;
export type CompanyMemberRevokeResponse = Static<typeof CompanyMemberRevokeResponseSchema>;
export type AccountDeletionRequest = Static<typeof AccountDeletionRequestSchema>;
export type AccountDeletionResponse = Static<typeof AccountDeletionResponseSchema>;
export type AccountDeletionCancelRequest = Static<typeof AccountDeletionCancelRequestSchema>;
export type AccountDeletionCancelResponse = Static<typeof AccountDeletionCancelResponseSchema>;
