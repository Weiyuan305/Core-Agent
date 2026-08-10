import type { TSchema } from "typebox";

import { ApprovalSchema } from "./approval/schema.js";
import { AuditEventSchema } from "./audit/audit-event.js";
import {
  PageInfoSchema,
  PageRequestSchema,
  ResourceMetadataSchema,
  TraceContextSchema,
} from "./common/primitives.js";
import { ErrorEnvelopeSchema } from "./errors/error-envelope.js";
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
  AppleIdentityLinkRequestSchema,
  AppleIdentityLinkResponseSchema,
  AuthSessionViewSchema,
  CompanyCreateRequestSchema,
  CompanyCreateResponseSchema,
  CompanyMembershipRequestSchema,
  CompanyMembershipResponseSchema,
  EmailSignInRequestSchema,
  EmailSignInResponseSchema,
  EmailSignUpRequestSchema,
  EmailSignUpResponseSchema,
  InvitationAcceptanceRequestSchema,
  InvitationAcceptanceResponseSchema,
  PasswordResetRequestSchema,
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
  "trusted-request-context": TrustedRequestContextSchema,
  "signed-trusted-request-context": SignedTrustedRequestContextSchema,
  "product-event-envelope": ProductEventEnvelopeSchema,
  "product-event": ProductEventSchema,
  "message-created-event": MessageCreatedEventSchema,
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
  "email-sign-in-request": EmailSignInRequestSchema,
  "email-sign-in-response": EmailSignInResponseSchema,
  "password-reset-request": PasswordResetRequestSchema,
  "password-reset-response": PasswordResetResponseSchema,
  "apple-authorization-start-request": AppleAuthorizationStartRequestSchema,
  "apple-authorization-start-response": AppleAuthorizationStartResponseSchema,
  "apple-authorization-callback-request": AppleAuthorizationCallbackRequestSchema,
  "apple-authorization-callback-response": AppleAuthorizationCallbackResponseSchema,
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
  "company-create-request": CompanyCreateRequestSchema,
  "company-create-response": CompanyCreateResponseSchema,
  "company-membership-request": CompanyMembershipRequestSchema,
  "company-membership-response": CompanyMembershipResponseSchema,
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
