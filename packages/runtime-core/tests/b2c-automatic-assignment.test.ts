import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPayloadHash } from "../src/domain/idempotency.js";
import {
  entitlementTestDatabase,
  entitlementTestNow,
  entitlementTestPool,
  resetEntitlementTestDatabase,
  seedPlatformAuthority,
  seedPublishedPack,
  seedTenant,
} from "./entitlement-test-support.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
type Command = (dependencies: Record<string, unknown>, context: Record<string, unknown>, input: unknown) => Promise<Record<string, any>>;
function required(name: string): Command {
  assert.equal(typeof runtime[name], "function", `${name} must be exported`);
  return runtime[name] as Command;
}
function command(payload: Record<string, unknown>) { return { ...payload, payload_hash: canonicalPayloadHash(payload) }; }
function snapshotResolver() {
  assert.equal(typeof runtime.resolveProfileSnapshot, "function", "resolveProfileSnapshot must be exported");
  return runtime.resolveProfileSnapshot as (dependencies: Record<string, unknown>, input: Record<string, unknown>) => Promise<Record<string, any>>;
}

test.beforeEach(async () => {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
});
test.after(async () => entitlementTestPool.end());

test("B2C suite plus add-on is an automatic union and removal creates a new monotonic historical-set Snapshot", async () => {
  const platform = await seedPlatformAuthority("b2c_snapshot");
  const tenantId = "tenant_b2c_snapshot";
  await seedTenant(tenantId, "b2c", 1);
  const dependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: runtime.resolveProfileSnapshotInTransaction,
  };
  const evidence = {
    actorId: `actor_${tenantId}_1`,
    membershipId: `membership_${tenantId}_1`,
    requestId: "request_b2c_snapshot",
    traceId: "trace_b2c_snapshot",
  };
  const grantPack = async (suffix: string) => {
    const pack = await seedPublishedPack(suffix, ["b2c"]);
    await required("selectTenantPackRelease")(dependencies, platform, command({
      schema_version: 1, idempotency_key: `release-${suffix}`, tenant_id: tenantId,
      pack_product_id: pack.packProductId, pack_version_id: pack.packVersionId, expected_resource_version: 1,
    }));
    const entitlement = await required("grantEntitlement")(dependencies, platform, command({
      schema_version: 1, idempotency_key: `grant-${suffix}`, tenant_id: tenantId,
      pack_product_id: pack.packProductId, source: "platform_manual", external_order_ref: `order-${suffix}`,
      expected_resource_version: 1, tenant_mode: "b2c", assignment_mode: "automatic",
    }));
    return { pack, entitlement };
  };
  const suite = await grantPack("b2c_suite");
  assert.equal((await entitlementTestPool.query(
    "select count(*)::int as count from profile_snapshot_pointers where tenant_id = $1",
    [tenantId],
  )).rows[0]?.count, 1, "B2C grant must resolve current authority in the grant transaction");
  const resolve = snapshotResolver();
  const resolveInput = { tenantId, profileId: `profile_${tenantId}_1`, evidence };
  const first = await resolve({ db: entitlementTestDatabase }, resolveInput);
  assert.equal(first.reused, true);
  const addOn = await grantPack("b2c_addon");
  const second = await resolve({ db: entitlementTestDatabase }, resolveInput);
  assert.deepEqual(second.capabilityIds, [suite.pack.capabilityId, addOn.pack.capabilityId].sort());
  await required("changeEntitlementStatus")(dependencies, platform, command({
    schema_version: 1, idempotency_key: "revoke-b2c-addon",
    entitlement_id: addOn.entitlement.entitlement_id, expected_resource_version: 1,
    status: "revoked", reason_code: "platform_revoked",
  }));
  const third = await resolve({ db: entitlementTestDatabase }, resolveInput);
  assert.deepEqual(third.capabilityIds, [suite.pack.capabilityId]);
  assert.equal(third.snapshotRef.version, 3);
  assert.equal(third.canonicalInputHash, first.canonicalInputHash);
  assert.notEqual(third.snapshotRef.snapshot_id, first.snapshotRef.snapshot_id);
  assert.equal((await entitlementTestPool.query("select count(*)::int as count from entitlement_assignments")).rows[0]?.count, 0);
});

test("B2C automatic resolution rejects anything other than one active student Membership and default Profile", async () => {
  const tenantId = "tenant_b2c_invalid_graph";
  await seedTenant(tenantId, "b2c", 1);
  await entitlementTestPool.query(
    `insert into profiles (tenant_id, profile_id, schema_version, resource_version, owner_actor_id, profile_kind,
       hermes_profile_ref, description, status, provider_config_id, model_id, created_at, updated_at)
     values ($1, 'profile_b2c_extra', 1, 1, $2, 'default', 'profile_b2c_extra', 'Extra', 'active', 'provider', 'model', $3, $3)`,
    [tenantId, `actor_${tenantId}_1`, entitlementTestNow],
  );
  await assert.rejects(() => snapshotResolver()({ db: entitlementTestDatabase }, {
    tenantId,
    profileId: `profile_${tenantId}_1`,
    evidence: { actorId: `actor_${tenantId}_1`, membershipId: `membership_${tenantId}_1`, requestId: "r", traceId: "t" },
  }), { code: "ENTITLEMENT_DENIED" });
});
