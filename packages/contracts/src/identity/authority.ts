import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields, UtcTimestampSchema } from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";

export const AuthProviderSchema = Type.Union([Type.Literal("supabase")]);
export const IdentityAuthorityActorStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("disabled"),
  Type.Literal("deletion_pending"),
  Type.Literal("deleted"),
]);
export const ProviderIdentityKindSchema = Type.Union([
  Type.Literal("email_password"),
  Type.Literal("apple"),
]);
export const AuthSubjectStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("unlinked"),
  Type.Literal("revoked"),
]);
export const PlatformRoleSchema = Type.Union([Type.Literal("platform_super_admin")]);
export const PlatformRoleAssignmentStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("revoked"),
]);
export const InvitationRoleSchema = Type.Union([
  Type.Literal("admin"),
  Type.Literal("consultant"),
]);
export const InvitationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("accepted"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
  Type.Literal("replaced"),
]);
export const CoreSessionClientKindSchema = Type.Union([
  Type.Literal("web"),
  Type.Literal("iphone"),
  Type.Literal("macos"),
]);
export const CoreSessionStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("revoked"),
  Type.Literal("expired"),
]);
export const CoreSessionRevocationReasonCodeSchema = Type.Union([
  Type.Literal("user_sign_out"),
  Type.Literal("administrator_revoked"),
  Type.Literal("password_reset"),
  Type.Literal("provider_unlinked"),
  Type.Literal("actor_disabled"),
  Type.Literal("account_deletion_requested"),
  Type.Literal("expired"),
]);
export const AccountDeletionStatusSchema = Type.Union([
  Type.Literal("deletion_pending"),
  Type.Literal("cancelled"),
  Type.Literal("deleted"),
]);

export const AuthSubjectSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    auth_subject_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    provider: AuthProviderSchema,
    provider_subject: OpaqueIdSchema,
    provider_identity_kind: ProviderIdentityKindSchema,
    verified_at: UtcTimestampSchema,
    status: AuthSubjectStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/auth-subject" },
);

export const PlatformRoleAssignmentSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    platform_role_assignment_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    role: PlatformRoleSchema,
    status: PlatformRoleAssignmentStatusSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/platform-role-assignment" },
);

export const InvitationSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    invitation_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    membership_id: OpaqueIdSchema,
    invited_by_actor_id: OpaqueIdSchema,
    role: InvitationRoleSchema,
    status: InvitationStatusSchema,
    expires_at: UtcTimestampSchema,
    accepted_actor_id: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/invitation" },
);

export const CoreSessionSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    session_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    auth_subject_id: OpaqueIdSchema,
    client_kind: CoreSessionClientKindSchema,
    device_label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    last_seen_at: UtcTimestampSchema,
    idle_expires_at: UtcTimestampSchema,
    absolute_expires_at: UtcTimestampSchema,
    reauthenticated_at: Type.Optional(UtcTimestampSchema),
    status: CoreSessionStatusSchema,
    revocation_reason_code: Type.Optional(CoreSessionRevocationReasonCodeSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/core-session" },
);

export const AccountDeletionSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    account_deletion_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    status: AccountDeletionStatusSchema,
    requested_at: UtcTimestampSchema,
    scheduled_for: UtcTimestampSchema,
    cancelled_at: Type.Optional(UtcTimestampSchema),
    deleted_at: Type.Optional(UtcTimestampSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/account-deletion" },
);

export function validateInvitation(invitation: Invitation): ContractViolation[] {
  if (invitation.status === "accepted" && invitation.accepted_actor_id === undefined) {
    return [violation(
      "INVITATION_ACCEPTED_ACTOR_REQUIRED",
      "accepted_actor_id",
      "Accepted Invitation requires the accepting Actor",
    )];
  }
  if (invitation.status !== "accepted" && invitation.accepted_actor_id !== undefined) {
    return [violation(
      "INVITATION_ACCEPTED_ACTOR_FORBIDDEN",
      "accepted_actor_id",
      "Only an accepted Invitation may carry the accepting Actor",
    )];
  }
  return [];
}

export function validateCoreSession(session: CoreSession): ContractViolation[] {
  if (session.status === "revoked" && session.revocation_reason_code === undefined) {
    return [violation(
      "CORE_SESSION_REVOCATION_REASON_REQUIRED",
      "revocation_reason_code",
      "Revoked Core Session requires a revocation reason",
    )];
  }
  if (session.status !== "revoked" && session.revocation_reason_code !== undefined) {
    return [violation(
      "CORE_SESSION_REVOCATION_REASON_FORBIDDEN",
      "revocation_reason_code",
      "Only a revoked Core Session may carry a revocation reason",
    )];
  }
  return [];
}

export function validateAccountDeletion(deletion: AccountDeletion): ContractViolation[] {
  const violations: ContractViolation[] = [];
  if (deletion.status === "deletion_pending") {
    if (deletion.cancelled_at !== undefined) {
      violations.push(violation(
        "ACCOUNT_DELETION_CANCELLED_AT_FORBIDDEN",
        "cancelled_at",
        "Pending Account Deletion cannot be cancelled",
      ));
    }
    if (deletion.deleted_at !== undefined) {
      violations.push(violation(
        "ACCOUNT_DELETION_DELETED_AT_FORBIDDEN",
        "deleted_at",
        "Pending Account Deletion cannot be completed",
      ));
    }
  }
  if (deletion.status === "cancelled") {
    if (deletion.cancelled_at === undefined) {
      violations.push(violation(
        "ACCOUNT_DELETION_CANCELLED_AT_REQUIRED",
        "cancelled_at",
        "Cancelled Account Deletion requires its cancellation time",
      ));
    }
    if (deletion.deleted_at !== undefined) {
      violations.push(violation(
        "ACCOUNT_DELETION_DELETED_AT_FORBIDDEN",
        "deleted_at",
        "Cancelled Account Deletion cannot be completed",
      ));
    }
  }
  if (deletion.status === "deleted") {
    if (deletion.deleted_at === undefined) {
      violations.push(violation(
        "ACCOUNT_DELETION_DELETED_AT_REQUIRED",
        "deleted_at",
        "Completed Account Deletion requires its deletion time",
      ));
    }
    if (deletion.cancelled_at !== undefined) {
      violations.push(violation(
        "ACCOUNT_DELETION_CANCELLED_AT_FORBIDDEN",
        "cancelled_at",
        "Completed Account Deletion cannot be cancelled",
      ));
    }
  }
  return violations;
}

export type AuthSubject = Static<typeof AuthSubjectSchema>;
export type PlatformRoleAssignment = Static<typeof PlatformRoleAssignmentSchema>;
export type Invitation = Static<typeof InvitationSchema>;
export type CoreSession = Static<typeof CoreSessionSchema>;
export type AccountDeletion = Static<typeof AccountDeletionSchema>;
