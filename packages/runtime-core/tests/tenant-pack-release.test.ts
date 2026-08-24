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
type SelectRelease = (dependencies: Record<string, unknown>, context: Record<string, unknown>, input: unknown) => Promise<Record<string, unknown>>;

function required(): SelectRelease {
  assert.equal(typeof runtime.selectTenantPackRelease, "function", "selectTenantPackRelease must be exported");
  return runtime.selectTenantPackRelease as SelectRelease;
}

function command(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

test.beforeEach(async () => {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
});
test.after(async () => entitlementTestPool.end());

test("first Pack release becomes current and an authority-bearing upgrade remains preparing with monotonic generation", async () => {
  const context = await seedPlatformAuthority();
  await seedTenant("tenant_release", "b2b");
  const first = await seedPublishedPack("release_one", ["b2b"], "1.0.0", "pack_product_release");
  const select = required();
  const dependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
  };
  const firstInput = command({
    schema_version: 1,
    idempotency_key: "release-first",
    tenant_id: "tenant_release",
    pack_product_id: first.packProductId,
    pack_version_id: first.packVersionId,
    expected_resource_version: 1,
  });
  const current = await select(dependencies, context, firstInput);
  assert.deepEqual(current, {
    kind: "current",
    releaseId: current.releaseId,
    generation: 1,
  });
  assert.deepEqual(await select(dependencies, context, firstInput), {
    kind: "replay",
    releaseId: current.releaseId,
    generation: 1,
  });

  await entitlementTestPool.query(
    `insert into entitlements (
       entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
       pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
       valid_from, expires_at, status, reason_code, resource_version, created_at, updated_at
     ) select 'entitlement_release_active', tenant_id, pack_product_id, tenant_pack_release_id,
       pack_version_id, pack_version, 'platform_manual', 'order_release_active', 'b2b', 'seat', 1,
       $1, null, 'active', 'platform_grant', 1, $1, $1
     from tenant_pack_releases where tenant_pack_release_id = $2`,
    [entitlementTestNow, current.releaseId],
  );
  const second = await seedPublishedPack("release_two", ["b2b"], "2.0.0", first.packProductId);
  const preparing = await select(dependencies, context, command({
    schema_version: 1,
    idempotency_key: "release-second",
    tenant_id: "tenant_release",
    pack_product_id: first.packProductId,
    pack_version_id: second.packVersionId,
    expected_resource_version: 1,
  }));
  assert.equal(preparing.kind, "preparing");
  assert.equal(preparing.generation, 2);
  assert.deepEqual((await entitlementTestPool.query(
    "select generation::int, status from tenant_pack_releases where tenant_id = 'tenant_release' order by generation",
  )).rows, [
    { generation: 1, status: "current" },
    { generation: 2, status: "preparing" },
  ]);
});

test("release selection requires current platform authority and recent Core Session reauthentication", async () => {
  const context = await seedPlatformAuthority("stale");
  await seedTenant("tenant_release_stale", "b2b");
  const pack = await seedPublishedPack("release_stale", ["b2b"]);
  await entitlementTestPool.query(
    "update core_sessions set reauthenticated_at = $2 where session_id = $1",
    [context.performingSessionId, new Date(entitlementTestNow.getTime() - 10 * 60_000)],
  );
  await assert.rejects(() => required()({
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
  }, context, command({
    schema_version: 1,
    idempotency_key: "release-stale",
    tenant_id: "tenant_release_stale",
    pack_product_id: pack.packProductId,
    pack_version_id: pack.packVersionId,
    expected_resource_version: 1,
  })), { code: "UNAUTHENTICATED" });
  assert.equal((await entitlementTestPool.query("select count(*)::int as count from tenant_pack_releases")).rows[0]?.count, 0);
});

