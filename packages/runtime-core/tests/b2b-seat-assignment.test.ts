import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPayloadHash } from "../src/domain/idempotency.js";
import {
  entitlementTestDatabase,
  entitlementTestNow,
  entitlementTestPool,
  resetEntitlementTestDatabase,
  seedCompanyAdminAuthority,
  seedPlatformAuthority,
  seedPublishedPack,
  seedTenant,
} from "./entitlement-test-support.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
type Command = (dependencies: Record<string, unknown>, context: Record<string, unknown>, input: unknown) => Promise<Record<string, unknown>>;
function required(name: string): Command {
  assert.equal(typeof runtime[name], "function", `${name} must be exported`);
  return runtime[name] as Command;
}
function command(payload: Record<string, unknown>) { return { ...payload, payload_hash: canonicalPayloadHash(payload) }; }

test.beforeEach(async () => {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
});
async function arrange(seats = 1, profileCount = 3) {
  const platform = await seedPlatformAuthority("seat_setup");
  const tenantId = "tenant_seat_assignment";
  await seedTenant(tenantId, "b2b", profileCount);
  const admin = await seedCompanyAdminAuthority(tenantId, 1, "seat_admin");
  const pack = await seedPublishedPack("seat_assignment", ["b2b"]);
  const platformDependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
  };
  const release = await required("selectTenantPackRelease")(platformDependencies, platform, command({
    schema_version: 1,
    idempotency_key: "seat-release",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    pack_version_id: pack.packVersionId,
    expected_resource_version: 1,
  }));
  const entitlement = await required("grantEntitlement")(platformDependencies, platform, command({
    schema_version: 1,
    idempotency_key: "seat-grant",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    source: "platform_manual",
    external_order_ref: "seat-order",
    expected_resource_version: 1,
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: seats,
  }));
  const resolved: string[] = [];
  const dependencies = {
    db: entitlementTestDatabase,
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: async (input: { profileId: string }) => { resolved.push(input.profileId); },
  };
  return { tenantId, pack, release, entitlement, admin, dependencies, resolved };
}

test("eligible company admin assigns and revokes one Pack seat with exact replay and event graph", async () => {
  const arranged = await arrange(1, 3);
  const assign = required("assignPackSeat");
  const payload = {
    schema_version: 1,
    idempotency_key: "assign-seat-2",
    entitlement_id: arranged.entitlement.entitlement_id,
    expected_resource_version: 1,
    profile_id: `profile_${arranged.tenantId}_2`,
  };
  const assigned = await assign(arranged.dependencies, arranged.admin, command(payload));
  assert.deepEqual(assigned, {
    schema_version: 1,
    assignment_id: assigned.assignment_id,
    entitlement_id: arranged.entitlement.entitlement_id,
    profile_id: payload.profile_id,
    status: "preparing",
    reason_code: "seat_assigned",
    resource_version: 1,
    used_seats: 1,
    total_seats: 1,
    available_seats: 0,
  });
  assert.deepEqual(await assign(arranged.dependencies, arranged.admin, command(payload)), assigned);
  await assert.rejects(() => assign(arranged.dependencies, arranged.admin, command({
    ...payload,
    profile_id: `profile_${arranged.tenantId}_3`,
  })), { code: "IDEMPOTENCY_CONFLICT" });
  assert.deepEqual(arranged.resolved, [payload.profile_id]);

  const revoke = required("revokePackSeat");
  const revoked = await revoke(arranged.dependencies, arranged.admin, command({
    schema_version: 1,
    idempotency_key: "revoke-seat-2",
    assignment_id: assigned.assignment_id,
    expected_resource_version: 1,
    reason_code: "administrator_revoked",
  }));
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.available_seats, 1);
  assert.equal((await entitlementTestPool.query(
    "select count(*)::int as count from entitlement_assignments where status in ('preparing','available')",
  )).rows[0]?.count, 0);
  assert.deepEqual(arranged.resolved, [payload.profile_id, payload.profile_id]);
  assert.deepEqual((await entitlementTestPool.query(
    `select
       (select count(*)::int from product_events where event_type in ('assignment.created','assignment.revoked')) as events,
       (select count(*)::int from outbox inner join product_events using (tenant_id, event_id)
          where event_type in ('assignment.created','assignment.revoked')) as outbox,
       (select count(*)::int from audit_events where resource_type = 'assignment') as audits`,
  )).rows, [{ events: 2, outbox: 2, audits: 2 }]);
});

test("assignment rejects stale reauthentication, cross-Tenant Profiles, and non-consultant company authority", async () => {
  const arranged = await arrange(2, 3);
  await entitlementTestPool.query(
    "update core_sessions set reauthenticated_at = $2 where session_id = $1",
    [arranged.admin.performingSessionId, new Date(entitlementTestNow.getTime() - 10 * 60_000)],
  );
  await assert.rejects(() => required("assignPackSeat")(arranged.dependencies, arranged.admin, command({
    schema_version: 1,
    idempotency_key: "assign-stale",
    entitlement_id: arranged.entitlement.entitlement_id,
    expected_resource_version: 1,
    profile_id: `profile_${arranged.tenantId}_2`,
  })), { code: "UNAUTHENTICATED" });
  await entitlementTestPool.query(
    "update core_sessions set reauthenticated_at = $2 where session_id = $1",
    [arranged.admin.performingSessionId, entitlementTestNow],
  );
  await seedTenant("tenant_other_assignment", "b2b", 1);
  await assert.rejects(() => required("assignPackSeat")(arranged.dependencies, arranged.admin, command({
    schema_version: 1,
    idempotency_key: "assign-cross-tenant",
    entitlement_id: arranged.entitlement.entitlement_id,
    expected_resource_version: 1,
    profile_id: "profile_tenant_other_assignment_1",
  })), { code: "RESOURCE_NOT_FOUND" });
  await entitlementTestPool.query(
    `update memberships set roles = array['admin']
     where tenant_id = $1 and actor_id = $2`,
    [arranged.tenantId, `actor_${arranged.tenantId}_2`],
  );
  await assert.rejects(() => required("assignPackSeat")(arranged.dependencies, arranged.admin, command({
    schema_version: 1,
    idempotency_key: "assign-not-consultant",
    entitlement_id: arranged.entitlement.entitlement_id,
    expected_resource_version: 1,
    profile_id: `profile_${arranged.tenantId}_2`,
  })), { code: "UNAUTHENTICATED" });
});
