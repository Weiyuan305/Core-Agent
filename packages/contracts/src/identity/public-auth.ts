import Type, { type Static, type TProperties } from "typebox";

import { OpaqueIdSchema, SchemaVersionSchema, UtcTimestampSchema } from "../common/primitives.js";
import { IdempotencyRequestSchema } from "../runtime/idempotency.js";
import {
  CoreSessionClientKindSchema,
  InvitationRoleSchema,
} from "./authority.js";

const EmailSchema = Type.String({ minLength: 3, maxLength: 320, format: "email" });
const PasswordSchema = Type.String({ minLength: 8, maxLength: 1_024 });
const DeviceLabelSchema = Type.String({ minLength: 1, maxLength: 80 });
const SafeReasonCodeSchema = Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9_]+$" });
const OAuthProofSchema = Type.String({ minLength: 8, maxLength: 4_096 });
const IdempotencyRequestProperties = IdempotencyRequestSchema.properties;

function request<const Properties extends TProperties>(id: string, properties: Properties) {
  return Type.Object(properties, { additionalProperties: false, $id: `core-agent://v1/${id}` });
}

function response<const Properties extends TProperties>(id: string, properties: Properties) {
  return Type.Object(properties, { additionalProperties: false, $id: `core-agent://v1/${id}` });
}

const AuthSessionViewFields = {
  schema_version: SchemaVersionSchema,
  actor_id: OpaqueIdSchema,
  session_id: OpaqueIdSchema,
  client_kind: CoreSessionClientKindSchema,
  idle_expires_at: UtcTimestampSchema,
  absolute_expires_at: UtcTimestampSchema,
  reauthentication_required: Type.Boolean(),
} as const;

const EmbeddedAuthSessionViewSchema = Type.Object(AuthSessionViewFields, { additionalProperties: false });

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
  actor_id: OpaqueIdSchema,
  tenant_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  session: EmbeddedAuthSessionViewSchema,
});

export const EmailSignInRequestSchema = request("email-sign-in-request", {
  schema_version: SchemaVersionSchema,
  email: EmailSchema,
  password: PasswordSchema,
  client_kind: CoreSessionClientKindSchema,
  device_label: Type.Optional(DeviceLabelSchema),
});
export const EmailSignInResponseSchema = response("email-sign-in-response", {
  schema_version: SchemaVersionSchema,
  session: EmbeddedAuthSessionViewSchema,
});

export const PasswordResetRequestSchema = request("password-reset-request", {
  schema_version: SchemaVersionSchema,
  email: EmailSchema,
});
export const PasswordResetResponseSchema = response("password-reset-response", {
  schema_version: SchemaVersionSchema,
  accepted: Type.Literal(true),
});

export const AppleAuthorizationStartRequestSchema = request("apple-authorization-start-request", {
  schema_version: SchemaVersionSchema,
  client_kind: CoreSessionClientKindSchema,
  redirect_uri: Type.String({ minLength: 1, maxLength: 2_048, format: "uri" }),
  device_label: Type.Optional(DeviceLabelSchema),
});
export const AppleAuthorizationStartResponseSchema = response("apple-authorization-start-response", {
  schema_version: SchemaVersionSchema,
  transaction_id: OpaqueIdSchema,
  authorization_url: Type.String({ minLength: 1, maxLength: 2_048, format: "uri" }),
  expires_at: UtcTimestampSchema,
});

const AppleCallbackFields = {
  ...IdempotencyRequestProperties,
  transaction_id: OpaqueIdSchema,
  authorization_code: OAuthProofSchema,
  state: OAuthProofSchema,
} as const;

export const AppleAuthorizationCallbackRequestSchema = request(
  "apple-authorization-callback-request",
  AppleCallbackFields,
);
export const AppleAuthorizationCallbackResponseSchema = response("apple-authorization-callback-response", {
  schema_version: SchemaVersionSchema,
  session: EmbeddedAuthSessionViewSchema,
});
export const AppleIdentityLinkRequestSchema = request("apple-identity-link-request", AppleCallbackFields);
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
  session: EmbeddedAuthSessionViewSchema,
});
export const SessionRevokeRequestSchema = request("session-revoke-request", {
  ...IdempotencyRequestProperties,
  session_id: OpaqueIdSchema,
  reason_code: SafeReasonCodeSchema,
});
export const SessionRevokeResponseSchema = response("session-revoke-response", {
  schema_version: SchemaVersionSchema,
  session_id: OpaqueIdSchema,
  status: Type.Literal("revoked"),
});

export const ReauthenticationRequestSchema = request("reauthentication-request", {
  schema_version: SchemaVersionSchema,
  password: PasswordSchema,
});
export const ReauthenticationResponseSchema = response("reauthentication-response", {
  schema_version: SchemaVersionSchema,
  reauthenticated_at: UtcTimestampSchema,
  valid_until: UtcTimestampSchema,
});

export const InvitationAcceptanceRequestSchema = request("invitation-acceptance-request", {
  ...IdempotencyRequestProperties,
  invitation_secret: Type.String({ minLength: 16, maxLength: 1_024 }),
  client_kind: CoreSessionClientKindSchema,
  device_label: Type.Optional(DeviceLabelSchema),
});
export const InvitationAcceptanceResponseSchema = response("invitation-acceptance-response", {
  schema_version: SchemaVersionSchema,
  tenant_id: OpaqueIdSchema,
  membership_id: OpaqueIdSchema,
  profile_id: Type.Optional(OpaqueIdSchema),
  session: EmbeddedAuthSessionViewSchema,
});

export const CompanyCreateRequestSchema = request("company-create-request", {
  ...IdempotencyRequestProperties,
  display_name: Type.String({ minLength: 1, maxLength: 200 }),
  administrator_invitation_ref: OpaqueIdSchema,
});
export const CompanyCreateResponseSchema = response("company-create-response", {
  schema_version: SchemaVersionSchema,
  tenant_id: OpaqueIdSchema,
  administrator_invitation_id: OpaqueIdSchema,
});
export const CompanyMembershipRequestSchema = request("company-membership-request", {
  ...IdempotencyRequestProperties,
  tenant_id: OpaqueIdSchema,
  role: InvitationRoleSchema,
  invitation_ref: OpaqueIdSchema,
});
export const CompanyMembershipResponseSchema = response("company-membership-response", {
  schema_version: SchemaVersionSchema,
  membership_id: OpaqueIdSchema,
  invitation_id: OpaqueIdSchema,
});

export const AccountDeletionRequestSchema = request("account-deletion-request", {
  ...IdempotencyRequestProperties,
  reason_code: SafeReasonCodeSchema,
});
export const AccountDeletionResponseSchema = response("account-deletion-response", {
  schema_version: SchemaVersionSchema,
  account_deletion_id: OpaqueIdSchema,
  status: Type.Literal("deletion_pending"),
  scheduled_for: UtcTimestampSchema,
});
export const AccountDeletionCancelRequestSchema = request("account-deletion-cancel-request", {
  ...IdempotencyRequestProperties,
  account_deletion_id: OpaqueIdSchema,
});
export const AccountDeletionCancelResponseSchema = response("account-deletion-cancel-response", {
  schema_version: SchemaVersionSchema,
  account_deletion_id: OpaqueIdSchema,
  status: Type.Literal("cancelled"),
});

export type AuthSessionView = Static<typeof AuthSessionViewSchema>;
export type EmailSignUpRequest = Static<typeof EmailSignUpRequestSchema>;
export type EmailSignUpResponse = Static<typeof EmailSignUpResponseSchema>;
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
export type InvitationAcceptanceRequest = Static<typeof InvitationAcceptanceRequestSchema>;
export type InvitationAcceptanceResponse = Static<typeof InvitationAcceptanceResponseSchema>;
export type CompanyCreateRequest = Static<typeof CompanyCreateRequestSchema>;
export type CompanyCreateResponse = Static<typeof CompanyCreateResponseSchema>;
export type CompanyMembershipRequest = Static<typeof CompanyMembershipRequestSchema>;
export type CompanyMembershipResponse = Static<typeof CompanyMembershipResponseSchema>;
export type AccountDeletionRequest = Static<typeof AccountDeletionRequestSchema>;
export type AccountDeletionResponse = Static<typeof AccountDeletionResponseSchema>;
export type AccountDeletionCancelRequest = Static<typeof AccountDeletionCancelRequestSchema>;
export type AccountDeletionCancelResponse = Static<typeof AccountDeletionCancelResponseSchema>;
