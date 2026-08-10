import Type, { type Static } from "typebox";

import { OpaqueIdSchema, ResourceMetadataFields, SchemaVersionSchema } from "../common/primitives.js";
import { ActorSchema, MembershipSchema, TenantSchema } from "../tenant/identity.js";
import { type ContractViolation, violation } from "../common/validation.js";

export const ProfileKindSchema = Type.Union([Type.Literal("default"), Type.Literal("consultant")]);
export const ProfileStatusSchema = Type.Union([
  Type.Literal("provisioning"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("archived"),
]);

export const ProfileSchema = Type.Object(
  {
    ...ResourceMetadataFields,
    profile_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    owner_actor_id: OpaqueIdSchema,
    profile_kind: ProfileKindSchema,
    status: ProfileStatusSchema,
    hermes_profile_ref: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/profile" },
);

export const IdentityGraphSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    tenant: TenantSchema,
    actors: Type.Array(ActorSchema),
    memberships: Type.Array(MembershipSchema),
    profiles: Type.Array(ProfileSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/identity-graph" },
);

export type Profile = Static<typeof ProfileSchema>;
export type IdentityGraph = Static<typeof IdentityGraphSchema>;

export function validateIdentityGraph(graph: IdentityGraph): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const actorIds = new Set(graph.actors.map((actor) => actor.actor_id));
  const tenantMemberships = graph.memberships.filter(
    (membership) => membership.tenant_id === graph.tenant.tenant_id,
  );

  for (const membership of graph.memberships) {
    if (membership.tenant_id !== graph.tenant.tenant_id) {
      violations.push(violation("TENANT_SCOPE_MISMATCH", "memberships.tenant_id", "Membership is outside the selected tenant"));
    }
    if (!actorIds.has(membership.actor_id)) {
      violations.push(violation("MEMBERSHIP_ACTOR_NOT_FOUND", "memberships.actor_id", "Membership actor does not exist"));
    }
    if (membership.membership_source === "platform") {
      if (membership.roles.length !== 1 || membership.roles[0] !== "admin") {
        violations.push(violation("PLATFORM_MEMBERSHIP_ROLE_INVALID", "memberships.roles", "Platform Membership requires only the admin role"));
      }
      if (membership.seat_ref !== undefined) {
        violations.push(violation("PLATFORM_MEMBERSHIP_SEAT_FORBIDDEN", "memberships.seat_ref", "Platform Membership cannot consume a seat"));
      }
    }
    if (graph.tenant.tenant_mode === "b2b" && membership.roles.includes("student")) {
      violations.push(violation("B2B_MEMBERSHIP_ROLE_INVALID", "memberships.roles", "B2B tenant does not allow student authority"));
    }
    if (graph.tenant.tenant_mode === "b2c") {
      if (membership.membership_source === "platform") {
        violations.push(violation("B2C_MEMBERSHIP_SOURCE_INVALID", "memberships.membership_source", "B2C tenant does not allow platform authority"));
      }
      if (membership.roles.length !== 1 || membership.roles[0] !== "student") {
        violations.push(violation("B2C_MEMBERSHIP_ROLE_INVALID", "memberships.roles", "B2C tenant requires only student authority"));
      }
    }
  }

  for (const profile of graph.profiles) {
    if (profile.tenant_id !== graph.tenant.tenant_id) {
      violations.push(violation("TENANT_SCOPE_MISMATCH", "profiles.tenant_id", "Profile is outside the selected tenant"));
      continue;
    }
    if (!actorIds.has(profile.owner_actor_id)) {
      violations.push(violation("PROFILE_OWNER_NOT_FOUND", "profiles.owner_actor_id", "Profile owner does not exist"));
    }
    if (graph.tenant.tenant_mode === "b2b" && profile.profile_kind === "default") {
      violations.push(violation("B2B_PROFILE_KIND_INVALID", "profiles.profile_kind", "B2B tenant only allows consultant profiles"));
    }
    if (graph.tenant.tenant_mode === "b2b" && profile.profile_kind === "consultant") {
      const membership = tenantMemberships.find(
        (item) => item.actor_id === profile.owner_actor_id
          && item.status === "active"
          && item.roles.includes("consultant"),
      );
      if (membership === undefined) {
        violations.push(violation("PROFILE_OWNER_NOT_ACTIVE_CONSULTANT", "profiles.owner_actor_id", "Consultant profile requires an active consultant membership"));
      }
    }
    if (graph.tenant.tenant_mode === "b2c" && profile.profile_kind === "default") {
      const membership = tenantMemberships.find(
        (item) => item.actor_id === profile.owner_actor_id
          && item.status === "active"
          && item.roles.includes("student"),
      );
      if (membership === undefined) {
        violations.push(violation("B2C_PROFILE_OWNER_NOT_ACTIVE_STUDENT", "profiles.owner_actor_id", "B2C default profile requires an active student membership"));
      }
    }
  }

  if (graph.tenant.tenant_mode === "b2c") {
    const activeStudents = tenantMemberships.filter((membership) => (
      membership.status === "active" && membership.roles.includes("student")
    ));
    if (activeStudents.length !== 1) {
      violations.push(violation("B2C_ACTIVE_STUDENT_COUNT_INVALID", "memberships", "B2C tenant requires exactly one active student Membership"));
    }
    if (graph.profiles.length !== 1) {
      violations.push(violation("B2C_PROFILE_COUNT_INVALID", "profiles", "B2C tenant requires exactly one profile"));
    }
    if (graph.profiles.some((profile) => profile.profile_kind !== "default")) {
      violations.push(violation("B2C_PROFILE_KIND_INVALID", "profiles.profile_kind", "B2C tenant only allows the default profile"));
    }
  }

  return violations;
}

export function validateIdentityGraphs(graphs: readonly IdentityGraph[]): ContractViolation[] {
  const tenantsByOrdinaryActor = new Map<string, Set<string>>();
  for (const graph of graphs) {
    for (const membership of graph.memberships) {
      if (
        membership.membership_source === "platform"
        || !["active", "invited"].includes(membership.status)
      ) continue;
      const tenants = tenantsByOrdinaryActor.get(membership.actor_id) ?? new Set<string>();
      tenants.add(membership.tenant_id);
      tenantsByOrdinaryActor.set(membership.actor_id, tenants);
    }
  }
  return [...tenantsByOrdinaryActor.entries()]
    .filter(([, tenants]) => tenants.size > 1)
    .map(([actorId]) => violation(
      "ACTOR_AUTHORITY_TENANT_CONFLICT",
      "memberships.actor_id",
      `Actor ${actorId} has authority in more than one tenant`,
    ));
}
