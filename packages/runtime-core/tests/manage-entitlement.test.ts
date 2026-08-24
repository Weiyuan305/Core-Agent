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
type Command = (dependencies: Record<string, unknown>, context: Record<string, unknown>, input: unknown) => Promise<Record<string, unknown>>;
function required(name: string): Command {
  assert.equal(typeof runtime[name], "function", `${name} must be exported`);
  return runtime[name] as Command;
}
function command(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

test.beforeEach(async () => {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
});

async function arrange(mode: "b2b" | "b2c") {
  const context = await seedPlatformAuthority(mode);
  const tenantId = `tenant_grant_${mode}`;
  await seedTenant(tenantId, mode);
  const pack = await seedPublishedPack(`grant_${mode}`, [mode]);
  const dependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
    expiryContext: context,
  };
  const release = await required("selectTenantPackRelease")(dependencies, context, command({
    schema_version: 1,
    idempotency_key: `release-${mode}`,
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    pack_version_id: pack.packVersionId,
    expected_resource_version: 1,
  }));
  return { context, tenantId, pack, dependencies, release };
}

test("B2B grant replays exactly, conflicts on changed commercial facts, and commits the complete event graph atomically", async () => {
  const arranged = await arrange("b2b");
  const grant = required("grantEntitlement");
  const payload = {
    schema_version: 1,
    idempotency_key: "grant-b2b",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    source: "platform_manual",
    external_order_ref: "order-b2b",
    expected_resource_version: 1,
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: 3,
  };
  const granted = await grant(arranged.dependencies, arranged.context, command(payload));
  assert.equal(granted.status, "active");
  assert.equal(granted.valid_from, entitlementTestNow.toISOString());
  assert.deepEqual(await grant(arranged.dependencies, arranged.context, command(payload)), granted);
  await assert.rejects(
    () => grant(arranged.dependencies, arranged.context, command({ ...payload, seat_quantity: 4 })),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.deepEqual((await entitlementTestPool.query(
    `select
       (select count(*)::int from entitlements) as entitlements,
       (select count(*)::int from platform_authority_audit where resource_type = 'entitlement') as platform_audits,
       (select count(*)::int from audit_events where resource_type = 'entitlement') as audits,
       (select count(*)::int from product_events where event_type = 'entitlement.activated') as events,
       (select count(*)::int from outbox inner join product_events using (tenant_id, event_id)
          where event_type = 'entitlement.activated') as outbox,
       (select count(*)::int from worker_jobs where job_kind = 'reconcile_capability_projection') as jobs`,
  )).rows, [{ entitlements: 1, platform_audits: 1, audits: 1, events: 1, outbox: 1, jobs: 1 }]);
});

test("B2C grants are automatic without seats and status transitions are optimistic irreversible authority changes", async () => {
  const arranged = await arrange("b2c");
  const grant = required("grantEntitlement");
  const granted = await grant(arranged.dependencies, arranged.context, command({
    schema_version: 1,
    idempotency_key: "grant-b2c",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    source: "platform_manual",
    external_order_ref: "order-b2c",
    expected_resource_version: 1,
    tenant_mode: "b2c",
    assignment_mode: "automatic",
  }));
  assert.equal(granted.seat_quantity, undefined);
  const change = required("changeEntitlementStatus");
  const suspended = await change(arranged.dependencies, arranged.context, command({
    schema_version: 1,
    idempotency_key: "suspend-b2c",
    entitlement_id: granted.entitlement_id,
    expected_resource_version: 1,
    status: "suspended",
    reason_code: "administrator_suspended",
  }));
  assert.equal(suspended.status, "suspended");
  const reactivated = await change(arranged.dependencies, arranged.context, command({
    schema_version: 1,
    idempotency_key: "reactivate-b2c",
    entitlement_id: granted.entitlement_id,
    expected_resource_version: 2,
    status: "active",
    reason_code: "administrator_reactivated",
  }));
  assert.equal(reactivated.status, "active");
  const revoked = await change(arranged.dependencies, arranged.context, command({
    schema_version: 1,
    idempotency_key: "revoke-b2c",
    entitlement_id: granted.entitlement_id,
    expected_resource_version: 3,
    status: "revoked",
    reason_code: "platform_revoked",
  }));
  assert.equal(revoked.status, "revoked");
  await assert.rejects(() => change(arranged.dependencies, arranged.context, command({
    schema_version: 1,
    idempotency_key: "reactivate-revoked",
    entitlement_id: granted.entitlement_id,
    expected_resource_version: 4,
    status: "active",
    reason_code: "administrator_reactivated",
  })), { code: "INVALID_STATE_TRANSITION" });
});

test("expiry claims only database-due active Entitlements in pages and cannot be forged through the public status command", async () => {
  const arranged = await arrange("b2c");
  const releaseId = String(arranged.release.releaseId);
  await entitlementTestPool.query(
    `insert into entitlements (
       entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
       pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
       valid_from, expires_at, status, reason_code, resource_version, created_at, updated_at
     ) values (
       'entitlement_due', $1, $2, $3, $4, '1.0.0', 'platform_manual', 'order_due',
       'b2c', 'automatic', null, clock_timestamp() - interval '2 days',
       clock_timestamp() - interval '1 day', 'active', 'platform_grant', 1,
       clock_timestamp() - interval '2 days', clock_timestamp() - interval '2 days'
     )`,
    [arranged.tenantId, arranged.pack.packProductId, releaseId, arranged.pack.packVersionId],
  );
  await assert.rejects(() => required("changeEntitlementStatus")(arranged.dependencies, arranged.context, command({
    schema_version: 1,
    idempotency_key: "forge-expiry",
    entitlement_id: "entitlement_due",
    expected_resource_version: 1,
    status: "expired",
    reason_code: "validity_expired",
  })), { code: "INVALID_REQUEST" });
  const result = await (runtime.expireEntitlements as (dependencies: Record<string, unknown>) => Promise<readonly string[]>)(arranged.dependencies);
  assert.deepEqual(result, ["entitlement_due"]);
  assert.deepEqual((await entitlementTestPool.query(
    "select status, reason_code, resource_version::int from entitlements where entitlement_id = 'entitlement_due'",
  )).rows, [{ status: "expired", reason_code: "validity_expired", resource_version: 2 }]);
});
