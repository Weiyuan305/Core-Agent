import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import {
  assertIdentityAuthorityInvariants,
  type IdentityAuthorityMembershipFacts,
  type IdentityAuthorityMembershipSource,
  type IdentityAuthorityMembershipStatus,
  type IdentityAuthorityProfileFacts,
  type IdentityAuthorityRole,
  type IdentityAuthorityTenantMode,
} from "../../services/identity/identity-invariants.js";

export interface ActorIdentityAuthority {
  readonly actorId: string;
  readonly actorStatus: "active" | "disabled" | "deletion_pending" | "deleted";
  readonly platformRoles: readonly "platform_super_admin"[];
  readonly memberships: readonly {
    membershipId: string;
    tenantId: string;
    tenantMode: "b2b" | "b2c";
    source: "self" | "company" | "platform";
    roles: readonly ("admin" | "consultant" | "student")[];
    status: "invited" | "active" | "suspended" | "revoked";
  }[];
}

function invalidAuthority(message: string): never {
  throw new DomainError("INTERNAL_ERROR", message);
}

function isTenantMode(value: string): value is IdentityAuthorityTenantMode {
  return value === "b2b" || value === "b2c";
}

function isMembershipSource(value: string): value is IdentityAuthorityMembershipSource {
  return value === "self" || value === "company" || value === "platform";
}

function isMembershipStatus(value: string): value is IdentityAuthorityMembershipStatus {
  return value === "invited" || value === "active" || value === "suspended" || value === "revoked";
}

function isRole(value: string): value is IdentityAuthorityRole {
  return value === "admin" || value === "consultant" || value === "student";
}

export async function loadActorIdentityAuthority(
  trx: Transaction<RuntimeDatabase>,
  actorId: string,
): Promise<ActorIdentityAuthority> {
  if (actorId.length < 1 || actorId.length > 255) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Actor identity authority was not found");
  }
  const actor = await trx.selectFrom("actors")
    .select(["actor_id", "status"])
    .where("actor_id", "=", actorId)
    .forShare()
    .executeTakeFirst();
  if (actor === undefined) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Actor identity authority was not found");
  }

  const [roleRows, membershipRows, profileRows] = await Promise.all([
    trx.selectFrom("platform_role_assignments")
      .select(["role", "status"])
      .where("actor_id", "=", actorId)
      .orderBy("role", "asc")
      .execute(),
    trx.selectFrom("memberships")
      .innerJoin("tenants", "tenants.tenant_id", "memberships.tenant_id")
      .select([
        "memberships.membership_id",
        "memberships.tenant_id",
        "tenants.tenant_mode",
        "memberships.membership_source",
        "memberships.roles",
        "memberships.status",
      ])
      .where("memberships.actor_id", "=", actorId)
      .orderBy("memberships.tenant_id", "asc")
      .orderBy("memberships.membership_id", "asc")
      .execute(),
    trx.selectFrom("profiles")
      .select(["profile_id", "tenant_id", "profile_kind"])
      .where("owner_actor_id", "=", actorId)
      .orderBy("tenant_id", "asc")
      .orderBy("profile_id", "asc")
      .execute(),
  ]);

  const memberships: IdentityAuthorityMembershipFacts[] = membershipRows.map((row) => {
    if (
      !isTenantMode(row.tenant_mode)
      || !isMembershipSource(row.membership_source)
      || !isMembershipStatus(row.status)
      || row.roles.some((role) => !isRole(role))
    ) invalidAuthority("Stored identity authority is invalid");
    return {
      membershipId: row.membership_id,
      tenantId: row.tenant_id,
      tenantMode: row.tenant_mode,
      source: row.membership_source,
      roles: row.roles as IdentityAuthorityRole[],
      status: row.status,
    };
  });
  const ownedProfiles: IdentityAuthorityProfileFacts[] = profileRows.map((row) => {
    if (row.profile_kind !== "default" && row.profile_kind !== "consultant") {
      invalidAuthority("Stored identity Profile is invalid");
    }
    return { profileId: row.profile_id, tenantId: row.tenant_id, profileKind: row.profile_kind };
  });
  const b2cTenantIds = memberships
    .filter((membership) => membership.tenantMode === "b2c")
    .map((membership) => membership.tenantId);
  const b2cProfileCounts = new Map<string, number>();
  if (b2cTenantIds.length > 0) {
    const counts = await trx.selectFrom("profiles")
      .select(({ fn }) => ["tenant_id", fn.countAll<string>().as("count")])
      .where("tenant_id", "in", b2cTenantIds)
      .groupBy("tenant_id")
      .execute();
    for (const row of counts) b2cProfileCounts.set(row.tenant_id, Number(row.count));
  }
  assertIdentityAuthorityInvariants(memberships, ownedProfiles, b2cProfileCounts);

  const platformRoles = roleRows
    .filter((row) => row.status === "active")
    .map((row) => {
      if (row.role !== "platform_super_admin") invalidAuthority("Stored platform authority is invalid");
      return row.role;
    });
  const frozenMemberships = memberships.map((membership) => Object.freeze({
    ...membership,
    roles: Object.freeze([...membership.roles]),
  }));
  return Object.freeze({
    actorId: actor.actor_id,
    actorStatus: actor.status,
    platformRoles: Object.freeze(platformRoles),
    memberships: Object.freeze(frozenMemberships),
  });
}
