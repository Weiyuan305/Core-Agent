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
test.after(async () => entitlementTestPool.end());

test("twenty concurrent attempts consume exactly three seats without duplicate effects or oversubscription", async () => {
  const platform = await seedPlatformAuthority("seat_concurrency_setup");
  const tenantId = "tenant_seat_concurrency";
  await seedTenant(tenantId, "b2b", 20);
  const admin = await seedCompanyAdminAuthority(tenantId, 1, "seat_concurrency_admin");
  const pack = await seedPublishedPack("seat_concurrency", ["b2b"]);
  const platformDependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
  };
  await required("selectTenantPackRelease")(platformDependencies, platform, command({
    schema_version: 1, idempotency_key: "concurrent-release", tenant_id: tenantId,
    pack_product_id: pack.packProductId, pack_version_id: pack.packVersionId, expected_resource_version: 1,
  }));
  const entitlement = await required("grantEntitlement")(platformDependencies, platform, command({
    schema_version: 1, idempotency_key: "concurrent-grant", tenant_id: tenantId,
    pack_product_id: pack.packProductId, source: "platform_manual", external_order_ref: "concurrent-order",
    expected_resource_version: 1, tenant_mode: "b2b", assignment_mode: "seat", seat_quantity: 3,
  }));
  let resolverCalls = 0;
  const dependencies = {
    db: entitlementTestDatabase,
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: async () => { resolverCalls += 1; },
  };
  const observations: number[] = [];
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      const row = (await entitlementTestPool.query(
        "select count(*)::int as count from entitlement_assignments where status in ('preparing','available')",
      )).rows[0] as { count: number };
      observations.push(row.count);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => required("assignPackSeat")(
    dependencies,
    admin,
    command({
      schema_version: 1,
      idempotency_key: `concurrent-assign-${index + 1}`,
      entitlement_id: entitlement.entitlement_id,
      expected_resource_version: 1,
      profile_id: `profile_${tenantId}_${index + 1}`,
    }),
  )));
  monitoring = false;
  await monitor;
  const successes = settled.filter((result) => result.status === "fulfilled");
  const failures = settled.filter((result) => result.status === "rejected");
  assert.equal(successes.length, 3);
  assert.equal(failures.length, 17);
  const failureCodes = failures.map((result) => (result as PromiseRejectedResult).reason?.code ?? "unknown");
  assert.ok(failureCodes.every((code) => code === "SEAT_EXHAUSTED"), JSON.stringify(failureCodes));
  assert.ok(observations.every((count) => count <= 3));
  assert.equal(resolverCalls, 3);
  assert.deepEqual((await entitlementTestPool.query(
    `select
       count(*)::int as assignments,
       count(distinct profile_id)::int as profiles,
       (select count(*)::int from product_events where event_type = 'assignment.created') as events,
       (select count(*)::int from outbox inner join product_events using (tenant_id, event_id)
          where event_type = 'assignment.created') as outbox
     from entitlement_assignments where status in ('preparing','available')`,
  )).rows, [{ assignments: 3, profiles: 3, events: 3, outbox: 3 }]);
});
