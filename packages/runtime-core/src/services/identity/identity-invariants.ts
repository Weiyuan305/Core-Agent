import { DomainError } from "../../domain/idempotency.js";

export type IdentityAuthorityRole = "admin" | "consultant" | "student";
export type IdentityAuthorityMembershipStatus = "invited" | "active" | "suspended" | "revoked";
export type IdentityAuthorityMembershipSource = "self" | "company" | "platform";
export type IdentityAuthorityTenantMode = "b2b" | "b2c";

export interface IdentityAuthorityMembershipFacts {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly tenantMode: IdentityAuthorityTenantMode;
  readonly source: IdentityAuthorityMembershipSource;
  readonly roles: readonly IdentityAuthorityRole[];
  readonly status: IdentityAuthorityMembershipStatus;
}

export interface IdentityAuthorityProfileFacts {
  readonly profileId: string;
  readonly tenantId: string;
  readonly profileKind: "default" | "consultant";
}

function invariant(message: string): never {
  throw new DomainError("INVALID_STATE_TRANSITION", message);
}

function hasExactRole(roles: readonly IdentityAuthorityRole[], role: IdentityAuthorityRole): boolean {
  return roles.length === 1 && roles[0] === role;
}

export function assertIdentityAuthorityInvariants(
  platformRoles: readonly "platform_super_admin"[],
  memberships: readonly IdentityAuthorityMembershipFacts[],
  ownedProfiles: readonly IdentityAuthorityProfileFacts[],
  b2cProfileCounts: ReadonlyMap<string, number>,
): void {
  const ordinaryAuthority = memberships.filter((membership) => (
    membership.source !== "platform"
    && (membership.status === "active" || membership.status === "invited")
  ));
  if (ordinaryAuthority.length > 1) invariant("Actor has duplicate ordinary authority");

  for (const membership of memberships) {
    if (membership.source === "platform") {
      if (membership.tenantMode !== "b2b") invariant("Platform Membership requires a B2B Tenant");
      if (!hasExactRole(membership.roles, "admin")) {
        invariant("Platform Membership requires exactly the admin role");
      }
      if (membership.status !== "active" && membership.status !== "revoked") {
        invariant("Platform Membership must be active or revoked");
      }
      if (membership.status === "active" && !platformRoles.includes("platform_super_admin")) {
        invariant("Platform Membership requires active platform_super_admin authority");
      }
    }
    if (
      membership.tenantMode === "b2c"
      && (membership.source !== "self" || !hasExactRole(membership.roles, "student"))
    ) invariant("B2C authority must contain only the self student role");
  }

  for (const count of b2cProfileCounts.values()) {
    if (count > 1) invariant("Actor authority contains a second B2C Profile");
  }

  const membershipsByTenant = new Map(memberships.map((membership) => [membership.tenantId, membership]));
  for (const profile of ownedProfiles) {
    const membership = membershipsByTenant.get(profile.tenantId);
    if (membership === undefined) invariant("Actor authority contains a cross-Tenant resource reference");
    const expectedRole = profile.profileKind === "default" ? "student" : "consultant";
    const expectedMode = profile.profileKind === "default" ? "b2c" : "b2b";
    if (
      membership.tenantMode !== expectedMode
      || membership.status !== "active"
      || !membership.roles.includes(expectedRole)
    ) invariant("Profile without an active matching role");
  }
}
