import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  IdentityGraphSchema,
  MembershipSchema,
  validateIdentityGraph,
  type IdentityGraph,
} from "../src/index.js";

const timestamp = "2026-08-03T01:02:03Z";
const resource = { schema_version: 1 as const, resource_version: 1, created_at: timestamp, updated_at: timestamp };

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
