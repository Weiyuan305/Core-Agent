import type { ColumnType } from "kysely";

type BigIntInput = string | number | bigint;
type IdentityBigInt = ColumnType<string, BigIntInput, BigIntInput>;
type Digest = ColumnType<Buffer, Uint8Array, Uint8Array>;

export interface AuthSubjectTable {
  auth_subject_id: string;
  actor_id: string;
  provider: "supabase";
  provider_subject: string;
  provider_identity_kind: "email_password" | "apple";
  verified_at: Date;
  status: "active" | "unlinked" | "revoked";
  resource_version: IdentityBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface PrivateIdentityPiiTable {
  actor_id: string;
  normalized_email_hmac: Digest;
  encrypted_email: ColumnType<Buffer, Uint8Array, Uint8Array>;
  encryption_key_ref: string;
  created_at: Date;
  updated_at: Date;
}

export interface PlatformRoleAssignmentTable {
  platform_role_assignment_id: string;
  actor_id: string;
  role: "platform_super_admin";
  status: "active" | "revoked";
  resource_version: IdentityBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface IdentityInvitationTable {
  invitation_id: string;
  tenant_id: string;
  membership_id: string;
  invited_by_actor_id: string;
  role: "admin" | "consultant";
  secret_digest: Digest;
  normalized_email_hmac: Digest;
  status: "pending" | "accepted" | "revoked" | "expired" | "replaced";
  expires_at: Date;
  accepted_actor_id: string | null;
  accepted_at: Date | null;
  replaced_by_invitation_id: string | null;
  resource_version: IdentityBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface OauthTransactionTable {
  oauth_transaction_id: string;
  provider: "supabase";
  flow_kind: "apple_sign_in" | "apple_link" | "password_reset";
  actor_id: string | null;
  client_kind: "web" | "iphone" | "macos";
  state_digest: Digest;
  nonce_digest: Digest;
  pkce_verifier_ciphertext: ColumnType<Buffer, Uint8Array, Uint8Array>;
  redirect_uri: string;
  status: "pending" | "consumed" | "expired";
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CoreSessionTable {
  session_id: string;
  secret_digest: Digest;
  csrf_digest: ColumnType<Buffer | null, Uint8Array | null, Uint8Array | null>;
  actor_id: string;
  auth_subject_id: string;
  client_kind: "web" | "iphone" | "macos";
  status: "active" | "revoked" | "expired";
  device_label: string | null;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  reauthenticated_at: Date | null;
  revocation_reason: string | null;
  resource_version: IdentityBigInt;
  updated_at: Date;
}

export interface AccountDeletionTable {
  account_deletion_id: string;
  actor_id: string;
  status: "deletion_pending" | "cancelled" | "deleted";
  requested_at: Date;
  scheduled_for: Date;
  cancelled_at: Date | null;
  deleted_at: Date | null;
  resource_version: IdentityBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface PublicRateLimitTable {
  bucket_kind: "signup" | "login" | "reset" | "apple_callback" | "invitation_accept" | "reauthenticate";
  account_identifier_hmac: Digest;
  client_identifier_hmac: Digest;
  window_started_at: Date;
  request_count: number;
  expires_at: Date;
  updated_at: Date;
}

export interface IdentityAuthorityTables {
  auth_subjects: AuthSubjectTable;
  private_identity_pii: PrivateIdentityPiiTable;
  platform_role_assignments: PlatformRoleAssignmentTable;
  identity_invitations: IdentityInvitationTable;
  oauth_transactions: OauthTransactionTable;
  core_sessions: CoreSessionTable;
  account_deletions: AccountDeletionTable;
  public_rate_limits: PublicRateLimitTable;
}
