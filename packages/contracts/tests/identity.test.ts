import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import * as Contracts from "../src/index.js";
import type { IdentityGraph } from "../src/index.js";

const {
  ActorStatusSchema,
  IdentityAuthorityActorStatusSchema,
  IdentityGraphSchema,
  MembershipSourceSchema,
  MembershipSchema,
  validateIdentityGraph,
  validateIdentityGraphs,
} = Contracts as unknown as Record<string, any>;

const timestamp = "2026-08-03T01:02:03Z";
const resource = { schema_version: 1 as const, resource_version: 1, created_at: timestamp, updated_at: timestamp };
const membershipSources = ["self", "company", "platform"] as const;
const actorStatuses = ["active", "disabled", "deletion_pending", "deleted"] as const;
const compileRequired = (name: string, schema: unknown) => {
  assert.notEqual(schema, undefined, `${name} must be exported`);
  return Schema.Compile(schema as never);
};

const b2bGraph: IdentityGraph = {
  schema_version: 1,
  tenant: { ...resource, tenant_id: "tenant_demo", tenant_mode: "b2b", display_name: "Demo tenant", status: "active" },
  actors: [
    { ...resource, actor_id: "actor_consultant", actor_kind: "human", status: "active", display_name: "Consultant" },
  ],
  memberships: [
    { ...resource, membership_id: "membership_demo", tenant_id: "tenant_demo", actor_id: "actor_consultant", roles: ["consultant"], status: "active" },
  ],
  profiles: [
    { ...resource, profile_id: "profile_demo", tenant_id: "tenant_demo", owner_actor_id: "actor_consultant", profile_kind: "consultant", status: "active", hermes_profile_ref: "hermes_profile_demo" },
  ],
};

test("validates a B2B consultant graph", () => {
  assert.equal(Schema.Compile(IdentityGraphSchema).Check(b2bGraph), true);
  assert.deepEqual(validateIdentityGraph(b2bGraph), []);
});

test("membership roles are non-empty and unique", () => {
  assert.equal(Schema.Compile(MembershipSchema).Check({ ...b2bGraph.memberships[0], roles: [] }), false);
  assert.equal(Schema.Compile(MembershipSchema).Check({ ...b2bGraph.memberships[0], roles: ["consultant", "consultant"] }), false);
});

test("identity vocabulary accepts exactly the approved membership sources and actor states", () => {
  const membershipSource = compileRequired("MembershipSourceSchema", MembershipSourceSchema);
  const actorStatus = compileRequired("IdentityAuthorityActorStatusSchema", IdentityAuthorityActorStatusSchema);
  const releasedActorStatus = compileRequired("ActorStatusSchema", ActorStatusSchema);
  for (const value of membershipSources) assert.equal(membershipSource.Check(value), true, value);
  for (const value of actorStatuses) assert.equal(actorStatus.Check(value), true, value);
  assert.equal(membershipSource.Check("provider"), false);
  assert.equal(actorStatus.Check("pending"), false);
  assert.equal(releasedActorStatus.Check("active"), true);
  assert.equal(releasedActorStatus.Check("disabled"), true);
  assert.equal(releasedActorStatus.Check("deletion_pending"), false);
  assert.equal(releasedActorStatus.Check("deleted"), false);
});

test("platform memberships are permanent admin-only authority without a seat", () => {
  const cases: Array<{ membership: IdentityGraph["memberships"][number]; code?: string }> = [
    {
      membership: {
        ...b2bGraph.memberships[0]!,
        roles: ["admin"],
        membership_source: "platform",
      },
    },
    {
      membership: {
        ...b2bGraph.memberships[0]!,
        roles: ["consultant"],
        membership_source: "platform",
      },
      code: "PLATFORM_MEMBERSHIP_ROLE_INVALID",
    },
    {
      membership: {
        ...b2bGraph.memberships[0]!,
        roles: ["admin", "student"],
        membership_source: "platform",
      },
      code: "PLATFORM_MEMBERSHIP_ROLE_INVALID",
    },
    {
      membership: {
        ...b2bGraph.memberships[0]!,
        roles: ["admin"],
        membership_source: "platform",
        seat_ref: "seat_forbidden",
      },
      code: "PLATFORM_MEMBERSHIP_SEAT_FORBIDDEN",
    },
  ];
  for (const { membership, code } of cases) {
    const graph = structuredClone(b2bGraph);
    graph.memberships = [membership];
    graph.profiles = [];
    const codes = validateIdentityGraph(graph).map((item) => item.code);
    assert.equal(code === undefined ? codes.length === 0 : codes.includes(code), true, code);
  }
});

test("rejects a cross-tenant profile", () => {
  const graph = structuredClone(b2bGraph);
  graph.profiles[0]!.tenant_id = "tenant_other";
  assert.deepEqual(validateIdentityGraph(graph).map((item) => item.code), ["TENANT_SCOPE_MISMATCH"]);
});

test("rejects B2C consultant profiles and multiple defaults", () => {
  const graph = structuredClone(b2bGraph);
  graph.tenant.tenant_mode = "b2c";
  graph.memberships[0]!.roles = ["student"];
  graph.profiles.push({ ...graph.profiles[0]!, profile_id: "profile_second", profile_kind: "default" });
  assert.deepEqual(
    validateIdentityGraph(graph).map((item) => item.code).sort(),
    ["B2C_PROFILE_COUNT_INVALID", "B2C_PROFILE_KIND_INVALID"],
  );
});

test("rejects a consultant profile without an active consultant membership", () => {
  const graph = structuredClone(b2bGraph);
  graph.memberships[0]!.status = "suspended";
  assert.deepEqual(validateIdentityGraph(graph).map((item) => item.code), ["PROFILE_OWNER_NOT_ACTIVE_CONSULTANT"]);
});

test("rejects B2B default profiles owned by student memberships", () => {
  const graph = structuredClone(b2bGraph);
  graph.memberships[0]!.roles = ["student"];
  graph.profiles[0]!.profile_kind = "default";
  assert.deepEqual(
    validateIdentityGraph(graph).map((item) => item.code),
    ["B2B_MEMBERSHIP_ROLE_INVALID", "B2B_PROFILE_KIND_INVALID"],
  );
});

test("rejects student authority in B2B and platform authority in B2C", () => {
  const b2b = structuredClone(b2bGraph);
  b2b.memberships[0]!.roles = ["student"];
  b2b.profiles = [];
  assert.equal(
    validateIdentityGraph(b2b).some((item) => item.code === "B2B_MEMBERSHIP_ROLE_INVALID"),
    true,
  );

  const b2c = structuredClone(b2bGraph);
  b2c.tenant.tenant_mode = "b2c";
  b2c.memberships[0]!.roles = ["admin"];
  b2c.memberships[0]!.membership_source = "platform";
  b2c.profiles[0]!.profile_kind = "default";
  assert.equal(
    validateIdentityGraph(b2c).some((item) => item.code === "B2C_MEMBERSHIP_SOURCE_INVALID"),
    true,
  );
});

test("membership sources follow tenant mode while undefined remains legacy-readable", () => {
  const b2b = structuredClone(b2bGraph);
  b2b.profiles = [];
  b2b.memberships[0]!.membership_source = "self";
  assert.equal(
    validateIdentityGraph(b2b).some((item) => item.code === "B2B_MEMBERSHIP_SOURCE_INVALID"),
    true,
  );
  delete b2b.memberships[0]!.membership_source;
  assert.equal(
    validateIdentityGraph(b2b).some((item) => item.code === "B2B_MEMBERSHIP_SOURCE_INVALID"),
    false,
  );

  const b2c = structuredClone(b2bGraph);
  b2c.tenant.tenant_mode = "b2c";
  b2c.memberships[0]!.roles = ["student"];
  b2c.memberships[0]!.membership_source = "company";
  b2c.profiles[0]!.profile_kind = "default";
  assert.equal(
    validateIdentityGraph(b2c).some((item) => item.code === "B2C_MEMBERSHIP_SOURCE_INVALID"),
    true,
  );
  delete b2c.memberships[0]!.membership_source;
  assert.equal(
    validateIdentityGraph(b2c).some((item) => item.code === "B2C_MEMBERSHIP_SOURCE_INVALID"),
    false,
  );
});

test("an ordinary actor cannot have multiple active or invited rows in one tenant", () => {
  const graph = structuredClone(b2bGraph);
  graph.memberships.push({
    ...graph.memberships[0]!,
    membership_id: "membership_duplicate",
    membership_source: "company",
    status: "invited",
  });
  assert.deepEqual(
    validateIdentityGraph(graph).map((item) => item.code),
    ["ACTOR_AUTHORITY_MEMBERSHIP_CONFLICT"],
  );
  assert.deepEqual(
    validateIdentityGraphs([graph]).map((item) => item.code),
    ["ACTOR_AUTHORITY_MEMBERSHIP_CONFLICT"],
  );

  graph.memberships[0]!.roles = ["admin"];
  graph.memberships[0]!.membership_source = "platform";
  graph.memberships[1]!.roles = ["admin"];
  graph.memberships[1]!.membership_source = "platform";
  graph.profiles = [];
  assert.deepEqual(validateIdentityGraph(graph), []);
});

test("rejects B2C default profiles without an active student membership", () => {
  const baseGraph = structuredClone(b2bGraph);
  baseGraph.tenant.tenant_mode = "b2c";
  baseGraph.profiles[0]!.profile_kind = "default";
  baseGraph.memberships[0]!.roles = ["student"];

  const graphs = [
    { ...structuredClone(baseGraph), memberships: [] },
    structuredClone(baseGraph),
    structuredClone(baseGraph),
    structuredClone(baseGraph),
  ];
  graphs[1]!.memberships[0]!.roles = ["admin"];
  graphs[2]!.memberships[0]!.status = "suspended";
  graphs[3]!.memberships[0]!.status = "revoked";

  for (const [index, graph] of graphs.entries()) {
    assert.deepEqual(
      validateIdentityGraph(graph).map((item) => item.code),
      index === 1
        ? ["B2C_MEMBERSHIP_ROLE_INVALID", "B2C_PROFILE_OWNER_NOT_ACTIVE_STUDENT", "B2C_ACTIVE_STUDENT_COUNT_INVALID"]
        : ["B2C_PROFILE_OWNER_NOT_ACTIVE_STUDENT", "B2C_ACTIVE_STUDENT_COUNT_INVALID"],
    );
  }
});

test("a B2C graph has exactly one active student and one default profile", () => {
  const graph = structuredClone(b2bGraph);
  graph.tenant.tenant_mode = "b2c";
  graph.memberships[0]!.roles = ["student"];
  graph.memberships[0]!.membership_source = "self";
  graph.profiles[0]!.profile_kind = "default";
  graph.memberships.push({
    ...graph.memberships[0]!,
    membership_id: "membership_second",
    actor_id: "actor_second",
  });
  graph.actors.push({
    ...graph.actors[0]!,
    actor_id: "actor_second",
  });
  assert.equal(
    validateIdentityGraph(graph).some((item) => item.code === "B2C_ACTIVE_STUDENT_COUNT_INVALID"),
    true,
  );
});

test("an ordinary actor cannot hold active or invited authority in two identity graphs", () => {
  assert.equal(typeof validateIdentityGraphs, "function");
  const first = structuredClone(b2bGraph);
  const second = structuredClone(b2bGraph);
  first.tenant.tenant_id = "tenant_first";
  first.memberships[0]!.tenant_id = "tenant_first";
  first.profiles[0]!.tenant_id = "tenant_first";
  second.tenant.tenant_id = "tenant_second";
  second.memberships[0]!.tenant_id = "tenant_second";
  second.profiles[0]!.tenant_id = "tenant_second";
  second.memberships[0]!.status = "invited";
  assert.deepEqual(
    validateIdentityGraphs([first, second]).map((item) => item.code),
    ["ACTOR_AUTHORITY_TENANT_CONFLICT"],
  );

  first.memberships[0]!.roles = ["admin"];
  first.memberships[0]!.membership_source = "platform";
  first.profiles = [];
  second.memberships[0]!.roles = ["admin"];
  second.memberships[0]!.membership_source = "platform";
  second.memberships[0]!.status = "active";
  second.profiles = [];
  assert.deepEqual(validateIdentityGraphs([first, second]), []);
});
