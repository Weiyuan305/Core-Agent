import type { ColumnType } from "kysely";

type BigIntInput = string | number | bigint;
type EntitlementBigInt = ColumnType<string, BigIntInput, BigIntInput>;
type DefaultTimestamp = ColumnType<Date, Date | undefined, Date>;

export type CapabilityKind = "mcp" | "skill" | "policy";
export type CapabilityRiskClass = "read" | "draft_write" | "external_write" | "privileged";
export type ApprovalRequirement = "none" | "user_confirmation" | "human_approval";
export type CapabilityVersionStatus = "draft" | "reviewed" | "retired" | "blocked";
export type PackVersionStatus = "draft" | "reviewed" | "published" | "retired" | "blocked";
export type TenantPackReleaseStatus = "preparing" | "current" | "failed" | "superseded";
export type EntitlementStatus = "active" | "suspended" | "expired" | "revoked";
export type AssignmentStatus = "preparing" | "available" | "suspended" | "expired" | "failed" | "revoked";
export type ProjectionStatus = "preparing" | "available" | "failed";

export interface CapabilityTable {
  capability_id: string;
  display_name: string;
  owning_domain: string;
  kind: CapabilityKind;
  resource_version: EntitlementBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface CapabilityVersionTable {
  capability_version_id: string;
  capability_id: string;
  version: string;
  kind: CapabilityKind;
  artifact_ref: string;
  contract_ref: string;
  risk_class: CapabilityRiskClass;
  approval_requirement: ApprovalRequirement;
  compatibility_json: unknown;
  status: CapabilityVersionStatus;
  resource_version: EntitlementBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface PackProductTable {
  pack_product_id: string;
  display_name: string;
  tenant_modes: ("b2b" | "b2c")[];
  resource_version: EntitlementBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface PackVersionTable {
  pack_version_id: string;
  pack_product_id: string;
  version: string;
  status: PackVersionStatus;
  resource_version: EntitlementBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface PackMemberTable {
  pack_member_id: string;
  pack_version_id: string;
  member_order: number;
  capability_id: string;
  capability_version_id: string;
  version: string;
  resource_version: EntitlementBigInt;
  created_at: Date;
  updated_at: Date;
}

export interface PlatformAuthorityAuditTable {
  platform_authority_audit_id: string;
  authority_tenant_id: string;
  actor_id: string;
  membership_id: string;
  action: string;
  decision: "allowed" | "denied" | "not_applicable";
  outcome: "succeeded" | "failed" | "cancelled" | "pending";
  resource_type: string;
  resource_id: string;
  resource_version: EntitlementBigInt | null;
  request_id: string;
  trace_id: string;
  reason_summary: string;
  change_summary: string | null;
  occurred_at: DefaultTimestamp;
}

export interface TenantPackReleaseTable {
  tenant_pack_release_id: string;
  tenant_id: string;
  pack_product_id: string;
  pack_version_id: string;
  pack_version: string;
  generation: EntitlementBigInt;
  status: TenantPackReleaseStatus;
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface EntitlementTable {
  entitlement_id: string;
  tenant_id: string;
  pack_product_id: string;
  tenant_pack_release_id: string;
  pack_version_id: string;
  pack_version: string;
  source: "platform_manual";
  external_order_ref: string;
  tenant_mode: "b2b" | "b2c";
  assignment_mode: "seat" | "automatic";
  seat_quantity: number | null;
  valid_from: DefaultTimestamp;
  expires_at: Date | null;
  status: EntitlementStatus;
  reason_code: "platform_grant" | "administrator_suspended" | "administrator_reactivated" | "platform_revoked" | "validity_expired";
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface EntitlementAssignmentTable {
  assignment_id: string;
  tenant_id: string;
  entitlement_id: string;
  profile_id: string;
  status: AssignmentStatus;
  reason_code: "seat_assigned" | "administrator_suspended" | "authority_suspended" | "validity_expired" | "runtime_preparation_failed" | "administrator_revoked";
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface EntitlementSnapshotTable {
  snapshot_id: string;
  tenant_id: string;
  profile_id: string;
  snapshot_version: EntitlementBigInt;
  evaluated_at: DefaultTimestamp;
  creation_xid: ColumnType<string, undefined, never>;
  canonical_input_hash: string;
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
}

export interface EntitlementSnapshotSourceTable {
  tenant_id: string;
  profile_id: string;
  snapshot_id: string;
  source_kind: "entitlement" | "assignment" | "release";
  source_id: string;
  source_order: number;
  created_at: DefaultTimestamp;
}

export interface EntitlementSnapshotCapabilityTable {
  tenant_id: string;
  profile_id: string;
  snapshot_id: string;
  capability_id: string;
  capability_version_id: string;
  version: string;
  capability_order: number;
  created_at: DefaultTimestamp;
}

export interface ProfileSnapshotPointerTable {
  tenant_id: string;
  profile_id: string;
  snapshot_id: string;
  snapshot_version: EntitlementBigInt;
  evaluated_at: Date;
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface CapabilityRuntimeProjectionTable {
  projection_id: string;
  tenant_id: string;
  profile_id: string;
  snapshot_id: string;
  snapshot_version: EntitlementBigInt;
  evaluated_at: Date;
  tenant_pack_release_id: string | null;
  runtime_generation: EntitlementBigInt;
  capability_manifest_digest: string;
  status: ProjectionStatus;
  reason_code: "runtime_preparation_failed" | "runtime_health_check_failed" | "capability_manifest_mismatch" | null;
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RuntimeActivityTable {
  tenant_id: string;
  runtime_generation: EntitlementBigInt;
  last_work_at: DefaultTimestamp;
  active_conversation_count: ColumnType<number, number | undefined, number>;
  active_run_count: ColumnType<number, number | undefined, number>;
  resource_version: EntitlementBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface EntitlementAuthorityTables {
  capabilities: CapabilityTable;
  capability_versions: CapabilityVersionTable;
  pack_products: PackProductTable;
  pack_versions: PackVersionTable;
  pack_members: PackMemberTable;
  platform_authority_audit: PlatformAuthorityAuditTable;
  tenant_pack_releases: TenantPackReleaseTable;
  entitlements: EntitlementTable;
  entitlement_assignments: EntitlementAssignmentTable;
  entitlement_snapshots: EntitlementSnapshotTable;
  entitlement_snapshot_sources: EntitlementSnapshotSourceTable;
  entitlement_snapshot_capabilities: EntitlementSnapshotCapabilityTable;
  profile_snapshot_pointers: ProfileSnapshotPointerTable;
  capability_runtime_projections: CapabilityRuntimeProjectionTable;
  runtime_activity: RuntimeActivityTable;
}
