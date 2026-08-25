import type { TSchema } from "typebox";

import { ApprovalSchema } from "./approval/schema.js";
import {
  GatewayToolDescriptorSchema,
  GatewayToolResultSchema,
  McpToolCallArgumentsSchema,
} from "./mcp/gateway.js";
import {
  PolicyDecisionReasonSchema,
  ToolPolicyDecisionRequestSchema,
  ToolPolicyDecisionResponseSchema,
} from "./policy/policy-decision.js";
import {
  ClosePolicySessionRequestSchema,
  ClosePolicySessionResponseSchema,
  OpenPolicySessionRequestSchema,
  OpenPolicySessionResponseSchema,
  PolicySessionStateSchema,
} from "./policy/policy-session.js";
import { AuditEventSchema } from "./audit/audit-event.js";
import {
  PageInfoSchema,
  PageRequestSchema,
  ResourceMetadataSchema,
  TraceContextSchema,
} from "./common/primitives.js";
import { ErrorEnvelopeSchema } from "./errors/error-envelope.js";
import {
  CapabilitySchema,
  CapabilityVersionSchema,
  PackMemberSchema,
  PackProductSchema,
  PackVersionSchema,
  TenantPackReleaseSchema,
} from "./entitlements/catalog.js";
import {
  EntitlementAssignmentSchema,
  EntitlementSchema,
} from "./entitlements/authority.js";
import {
  CapabilityServiceProjectionSchema,
  EntitlementSnapshotSchema,
  ProfileSnapshotPointerSchema,
} from "./entitlements/snapshots.js";
import {
  AssignPackSeatRequestSchema,
  ChangeEntitlementStatusRequestSchema,
  CompanyAssignmentSummarySchema,
  CompanyServiceSummarySchema,
  GrantEntitlementRequestSchema,
  RevokePackSeatRequestSchema,
  SelectTenantPackReleaseRequestSchema,
  StudentServiceSummarySchema,
} from "./entitlements/public-api.js";
import {
  AccountDeletionSchema,
  AuthSubjectSchema,
  CoreSessionSchema,
  InvitationSchema,
  PlatformRoleAssignmentSchema,
} from "./identity/authority.js";
import {
  AccountDeletionCancelRequestSchema,
  AccountDeletionCancelResponseSchema,
  AccountDeletionRequestSchema,
  AccountDeletionResponseSchema,
  AppleAuthorizationCallbackRequestSchema,
  AppleAuthorizationCallbackResponseSchema,
  AppleAuthorizationStartRequestSchema,
  AppleAuthorizationStartResponseSchema,
  AppleIdentityLinkStartRequestSchema,
  AppleIdentityLinkStartResponseSchema,
  AppleIdentityLinkRequestSchema,
  AppleIdentityLinkResponseSchema,
  AuthSessionViewSchema,
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
  CompanyMemberRevokeRequestSchema,
  CompanyMemberRevokeResponseSchema,
  CompanyMemberSuspendRequestSchema,
  CompanyMemberSuspendResponseSchema,
  CompanyMemberViewSchema,
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
  PasswordResetRequestSchema,
  PasswordResetCompletionRequestSchema,
  PasswordResetResponseSchema,
  ReauthenticationRequestSchema,
  ReauthenticationResponseSchema,
  SessionInspectRequestSchema,
  SessionInspectResponseSchema,
  SessionRevokeRequestSchema,
  SessionRevokeResponseSchema,
} from "./identity/public-auth.js";
import {
  MessageCreatedEventSchema,
  CatalogEventSchema,
  PolicyEventSchema,
  ProductEventEnvelopeSchema,
  ProductEventSchema,
} from "./events/product-event.js";
import { IdentityGraphSchema, ProfileSchema } from "./profile/profile.js";
import {
  SignedTrustedRequestContextSchema,
  TrustedRequestContextSchema,
} from "./request-context/trusted-request-context.js";
import {
  IdempotencyRecordSchema,
  IdempotencyRequestSchema,
  VersionedWriteRequestSchema,
} from "./runtime/idempotency.js";
import { MessageSchema } from "./runtime/messages.js";
import { CreateAgentRunRequestSchema } from "./runtime/requests.js";
import {
  CaseRefSchema,
  ConsentSnapshotRefSchema,
  EntitlementSnapshotRefSchema,
  StudentRefSchema,
} from "./runtime/refs.js";
import {
  AgentRunSchema,
  ConversationSchema,
  RuntimeContainerSchema,
  SessionSchema,
  TaskSchema,
} from "./runtime/resources.js";
import { ActorSchema, MembershipSchema, TenantSchema } from "./tenant/identity.js";

export const ContractSchemas = {
  "resource-metadata": ResourceMetadataSchema,
  "trace-context": TraceContextSchema,
  "page-request": PageRequestSchema,
  "page-info": PageInfoSchema,
  "student-ref": StudentRefSchema,
  "case-ref": CaseRefSchema,
  "entitlement-snapshot-ref": EntitlementSnapshotRefSchema,
  "consent-snapshot-ref": ConsentSnapshotRefSchema,
  capability: CapabilitySchema,
  "capability-version": CapabilityVersionSchema,
  "pack-product": PackProductSchema,
  "pack-member": PackMemberSchema,
  "pack-version": PackVersionSchema,
  "tenant-pack-release": TenantPackReleaseSchema,
  entitlement: EntitlementSchema,
  "entitlement-assignment": EntitlementAssignmentSchema,
  "entitlement-snapshot": EntitlementSnapshotSchema,
  "profile-snapshot-pointer": ProfileSnapshotPointerSchema,
  "capability-service-projection": CapabilityServiceProjectionSchema,
  "company-service-summary": CompanyServiceSummarySchema,
  "student-service-summary": StudentServiceSummarySchema,
  "company-assignment-summary": CompanyAssignmentSummarySchema,
  "select-tenant-pack-release-request": SelectTenantPackReleaseRequestSchema,
  "grant-entitlement-request": GrantEntitlementRequestSchema,
  "change-entitlement-status-request": ChangeEntitlementStatusRequestSchema,
  "assign-pack-seat-request": AssignPackSeatRequestSchema,
  "revoke-pack-seat-request": RevokePackSeatRequestSchema,
  tenant: TenantSchema,
  actor: ActorSchema,
  membership: MembershipSchema,
  profile: ProfileSchema,
  "identity-graph": IdentityGraphSchema,
  "runtime-container": RuntimeContainerSchema,
  conversation: ConversationSchema,
  session: SessionSchema,
  "agent-run": AgentRunSchema,
  message: MessageSchema,
  task: TaskSchema,
  approval: ApprovalSchema,
  "policy-session-state": PolicySessionStateSchema,
  "open-policy-session-request": OpenPolicySessionRequestSchema,
  "open-policy-session-response": OpenPolicySessionResponseSchema,
  "close-policy-session-request": ClosePolicySessionRequestSchema,
  "close-policy-session-response": ClosePolicySessionResponseSchema,
  "policy-decision-reason": PolicyDecisionReasonSchema,
  "tool-policy-decision-request": ToolPolicyDecisionRequestSchema,
  "tool-policy-decision-response": ToolPolicyDecisionResponseSchema,
  "gateway-tool-descriptor": GatewayToolDescriptorSchema,
  "mcp-tool-call-arguments": McpToolCallArgumentsSchema,
  "gateway-tool-result": GatewayToolResultSchema,
  "trusted-request-context": TrustedRequestContextSchema,
  "signed-trusted-request-context": SignedTrustedRequestContextSchema,
  "product-event-envelope": ProductEventEnvelopeSchema,
  "product-event": ProductEventSchema,
  "message-created-event": MessageCreatedEventSchema,
  "catalog-event": CatalogEventSchema,
  "policy-event": PolicyEventSchema,
  "audit-event": AuditEventSchema,
  "error-envelope": ErrorEnvelopeSchema,
  "idempotency-request": IdempotencyRequestSchema,
  "idempotency-record": IdempotencyRecordSchema,
  "versioned-write-request": VersionedWriteRequestSchema,
  "create-agent-run-request": CreateAgentRunRequestSchema,
  "auth-subject": AuthSubjectSchema,
  "platform-role-assignment": PlatformRoleAssignmentSchema,
  invitation: InvitationSchema,
  "core-session": CoreSessionSchema,
  "account-deletion": AccountDeletionSchema,
  "email-sign-up-request": EmailSignUpRequestSchema,
  "email-sign-up-response": EmailSignUpResponseSchema,
  "email-verification-request": EmailVerificationRequestSchema,
  "email-verification-response": EmailVerificationResponseSchema,
  "email-sign-in-request": EmailSignInRequestSchema,
  "email-sign-in-response": EmailSignInResponseSchema,
  "password-reset-request": PasswordResetRequestSchema,
  "password-reset-completion-request": PasswordResetCompletionRequestSchema,
  "password-reset-response": PasswordResetResponseSchema,
  "apple-authorization-start-request": AppleAuthorizationStartRequestSchema,
  "apple-authorization-start-response": AppleAuthorizationStartResponseSchema,
  "apple-authorization-callback-request": AppleAuthorizationCallbackRequestSchema,
  "apple-authorization-callback-response": AppleAuthorizationCallbackResponseSchema,
  "apple-identity-link-start-request": AppleIdentityLinkStartRequestSchema,
  "apple-identity-link-start-response": AppleIdentityLinkStartResponseSchema,
  "apple-identity-link-request": AppleIdentityLinkRequestSchema,
  "apple-identity-link-response": AppleIdentityLinkResponseSchema,
  "auth-session-view": AuthSessionViewSchema,
  "session-inspect-request": SessionInspectRequestSchema,
  "session-inspect-response": SessionInspectResponseSchema,
  "session-revoke-request": SessionRevokeRequestSchema,
  "session-revoke-response": SessionRevokeResponseSchema,
  "reauthentication-request": ReauthenticationRequestSchema,
  "reauthentication-response": ReauthenticationResponseSchema,
  "invitation-acceptance-request": InvitationAcceptanceRequestSchema,
  "invitation-acceptance-response": InvitationAcceptanceResponseSchema,
  "invitation-email-registration-request": InvitationEmailRegistrationRequestSchema,
  "invitation-email-registration-response": InvitationEmailRegistrationResponseSchema,
  "invitation-inspect-request": InvitationInspectRequestSchema,
  "invitation-inspect-response": InvitationInspectResponseSchema,
  "invitation-revoke-request": InvitationRevokeRequestSchema,
  "invitation-revoke-response": InvitationRevokeResponseSchema,
  "company-create-request": CompanyCreateRequestSchema,
  "company-create-response": CompanyCreateResponseSchema,
  "company-consultant-role-grant-request": CompanyConsultantRoleGrantRequestSchema,
  "company-consultant-role-grant-response": CompanyConsultantRoleGrantResponseSchema,
  "company-consultant-role-remove-request": CompanyConsultantRoleRemoveRequestSchema,
  "company-consultant-role-remove-response": CompanyConsultantRoleRemoveResponseSchema,
  "company-member-invite-request": CompanyMemberInviteRequestSchema,
  "company-member-invite-response": CompanyMemberInviteResponseSchema,
  "company-member-view": CompanyMemberViewSchema,
  "company-member-list-request": CompanyMemberListRequestSchema,
  "company-member-list-response": CompanyMemberListResponseSchema,
  "company-member-suspend-request": CompanyMemberSuspendRequestSchema,
  "company-member-suspend-response": CompanyMemberSuspendResponseSchema,
  "company-member-revoke-request": CompanyMemberRevokeRequestSchema,
  "company-member-revoke-response": CompanyMemberRevokeResponseSchema,
  "account-deletion-request": AccountDeletionRequestSchema,
  "account-deletion-response": AccountDeletionResponseSchema,
  "account-deletion-cancel-request": AccountDeletionCancelRequestSchema,
  "account-deletion-cancel-response": AccountDeletionCancelResponseSchema,
} satisfies Record<string, TSchema>;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function serializeSchema(schema: TSchema): string {
  const document = { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema };
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
}
