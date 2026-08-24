import assert from "node:assert/strict";
import test from "node:test";

import { EXPECTED_SCHEMA_VERSION } from "../src/db/schema-version.js";
import { canonicalPayloadHash } from "../src/domain/idempotency.js";
import {
  digestHex,
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
function snapshotResolver() {
  assert.equal(typeof runtime.resolveProfileSnapshot, "function", "resolveProfileSnapshot must be exported");
  return runtime.resolveProfileSnapshot as (dependencies: Record<string, unknown>, input: Record<string, unknown>) => Promise<Record<string, any>>;
}

test.beforeEach(async () => {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
});

test("schema 15 admits a later monotonic Snapshot when a historical canonical set recurs", async () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, 15);
  const catalog = await entitlementTestPool.query<{ contype: string }>(
    `select constraint_type.contype
     from pg_constraint as constraint_type
     where constraint_type.conrelid = 'entitlement_snapshots'::regclass
       and constraint_type.conname = 'entitlement_snapshots_input_key'`,
  );
  assert.equal(catalog.rowCount, 0);
});

async function arrangeB2b() {
  const platform = await seedPlatformAuthority("snapshot_setup");
  const tenantId = "tenant_snapshot_service";
  await seedTenant(tenantId, "b2b", 3);
  const admin = await seedCompanyAdminAuthority(tenantId, 1, "snapshot_admin");
  const pack = await seedPublishedPack("snapshot_service", ["b2b"]);
  const platformDependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: runtime.resolveProfileSnapshotInTransaction,
  };
  await required("selectTenantPackRelease")(platformDependencies, platform, command({
    schema_version: 1, idempotency_key: "snapshot-release", tenant_id: tenantId,
    pack_product_id: pack.packProductId, pack_version_id: pack.packVersionId, expected_resource_version: 1,
  }));
  const entitlement = await required("grantEntitlement")(platformDependencies, platform, command({
    schema_version: 1, idempotency_key: "snapshot-grant", tenant_id: tenantId,
    pack_product_id: pack.packProductId, source: "platform_manual", external_order_ref: "snapshot-order",
    expected_resource_version: 1, tenant_mode: "b2b", assignment_mode: "seat", seat_quantity: 2,
  }));
  const assignment = await required("assignPackSeat")({
    db: entitlementTestDatabase,
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: async () => undefined,
  }, admin, command({
    schema_version: 1, idempotency_key: "snapshot-assignment",
    entitlement_id: entitlement.entitlement_id, expected_resource_version: 1,
    profile_id: `profile_${tenantId}_2`,
  }));
  return { tenantId, platform, admin, pack, entitlement, assignment };
}

test("Profile Snapshot persistence is immutable, idempotently reused, concurrent-safe, and projection-linked", async () => {
  const arranged = await arrangeB2b();
  const resolve = snapshotResolver();
  const input = {
    tenantId: arranged.tenantId,
    profileId: `profile_${arranged.tenantId}_2`,
    evidence: {
      actorId: arranged.admin.performingActorId,
      membershipId: `membership_${arranged.tenantId}_1`,
      requestId: "request_snapshot_resolve",
      traceId: "trace_snapshot_resolve",
    },
  };
  const first = await resolve({ db: entitlementTestDatabase }, input);
  assert.equal(first.reused, false);
  assert.deepEqual(first.capabilityIds, [arranged.pack.capabilityId]);
  assert.equal(first.snapshotRef.version, 1);
  assert.equal(first.pointerVersion, 1);
  assert.equal(first.projection.status, "preparing");
  const replay = await resolve({ db: entitlementTestDatabase }, input);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.snapshotRef, first.snapshotRef);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => resolve({ db: entitlementTestDatabase }, input)));
  assert.ok(concurrent.every((candidate) => candidate.snapshotRef.snapshot_id === first.snapshotRef.snapshot_id));
  assert.deepEqual((await entitlementTestPool.query(
    `select
       (select count(*)::int from entitlement_snapshots) as snapshots,
       (select count(*)::int from profile_snapshot_pointers) as pointers,
       (select count(*)::int from capability_runtime_projections) as projections,
       (select count(*)::int from product_events where event_type = 'entitlement_snapshot.changed') as events`,
  )).rows, [{ snapshots: 1, pointers: 1, projections: 1, events: 1 }]);
  await assert.rejects(
    entitlementTestPool.query("update entitlement_snapshots set canonical_input_hash = $2 where snapshot_id = $1", [
      first.snapshotRef.snapshot_id, `sha256:${"f".repeat(64)}`,
    ]),
    (error) => (error as { constraint?: string }).constraint === "entitlement_snapshots_immutable_check",
  );
});

test("preparing Pack release stages a Snapshot without moving current authority and available current projections remain reusable", async () => {
  const arranged = await arrangeB2b();
  const resolve = snapshotResolver();
  const input = {
    tenantId: arranged.tenantId,
    profileId: `profile_${arranged.tenantId}_2`,
    evidence: {
      actorId: arranged.admin.performingActorId,
      membershipId: `membership_${arranged.tenantId}_1`,
      requestId: "request_snapshot_candidate",
      traceId: "trace_snapshot_candidate",
    },
  };
  const current = await resolve({ db: entitlementTestDatabase }, input);
  await entitlementTestPool.query(
    "update capability_runtime_projections set status = 'available', updated_at = $1 where projection_id = $2",
    [entitlementTestNow, current.projection.projectionId],
  );
  const currentReplay = await resolve({ db: entitlementTestDatabase }, input);
  assert.equal(currentReplay.projection.status, "available");

  const candidatePack = await seedPublishedPack(
    "snapshot_service_candidate",
    ["b2b"],
    "2.0.0",
    arranged.pack.packProductId,
  );
  const candidateRelease = await required("selectTenantPackRelease")({
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: runtime.resolveProfileSnapshotInTransaction,
  }, arranged.platform, command({
    schema_version: 1,
    idempotency_key: "snapshot-candidate-release",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    pack_version_id: candidatePack.packVersionId,
    expected_resource_version: 1,
  }));
  assert.equal(candidateRelease.kind, "preparing");
  const automaticallyStaged = (await entitlementTestPool.query(
    `select snapshot_id, tenant_pack_release_id, status
     from capability_runtime_projections
     where tenant_id = $1 and tenant_pack_release_id = $2`,
    [arranged.tenantId, candidateRelease.releaseId],
  )).rows[0];
  assert.equal(automaticallyStaged?.tenant_pack_release_id, candidateRelease.releaseId);

  const staged = await resolve({ db: entitlementTestDatabase }, {
    ...input,
    candidateReleaseId: candidateRelease.releaseId,
  });
  assert.equal(staged.staged, true);
  assert.equal(staged.reused, true);
  assert.equal(staged.snapshotRef.snapshot_id, automaticallyStaged?.snapshot_id);
  assert.equal(staged.snapshotRef.version, 2);
  assert.deepEqual(staged.capabilityIds, [candidatePack.capabilityId]);
  assert.equal(staged.pointerVersion, current.pointerVersion);
  assert.deepEqual((await entitlementTestPool.query(
    `select pointer.snapshot_id, projection.tenant_pack_release_id, projection.status
     from profile_snapshot_pointers as pointer
     join capability_runtime_projections as projection
       on projection.tenant_id = pointer.tenant_id and projection.snapshot_id = $3
     where pointer.tenant_id = $1 and pointer.profile_id = $2`,
    [arranged.tenantId, input.profileId, staged.snapshotRef.snapshot_id],
  )).rows, [{
    snapshot_id: current.snapshotRef.snapshot_id,
    tenant_pack_release_id: candidateRelease.releaseId,
    status: "preparing",
  }]);
});

test("conflicting Pack versions preserve the prior pointer and create no conflicting projection", async () => {
  const arranged = await arrangeB2b();
  const resolve = snapshotResolver();
  const input = {
    tenantId: arranged.tenantId,
    profileId: `profile_${arranged.tenantId}_2`,
    evidence: {
      actorId: arranged.admin.performingActorId,
      membershipId: `membership_${arranged.tenantId}_1`,
      requestId: "request_snapshot_conflict",
      traceId: "trace_snapshot_conflict",
    },
  };
  await resolve({ db: entitlementTestDatabase }, input);
  const pointerBefore = (await entitlementTestPool.query(
    "select snapshot_id, resource_version::int from profile_snapshot_pointers where tenant_id = $1 and profile_id = $2",
    [arranged.tenantId, input.profileId],
  )).rows[0];
  await entitlementTestPool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values ($1, $2, '2.0.0', 'mcp', $3, 'synthetic/entitlement@1.0.0', 'read', 'none',
       '{"core_contract_version":"0.8.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b"]}'::jsonb,
       'reviewed', 1, $4, $4)`,
    ["capability_version_snapshot_conflict", arranged.pack.capabilityId, `manifest:sha256:${digestHex("snapshot_conflict")}`, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into pack_products (pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at)
     values ('pack_product_snapshot_conflict', 'Conflict Pack', array['b2b'], 1, $1, $1)`,
    [entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into pack_versions (pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at)
     values ('pack_version_snapshot_conflict', 'pack_product_snapshot_conflict', '2.0.0', 'draft', 1, $1, $1)`,
    [entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into pack_members (pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version, resource_version, created_at, updated_at)
     values ('pack_member_snapshot_conflict', 'pack_version_snapshot_conflict', 1, $2, 'capability_version_snapshot_conflict', '2.0.0', 1, $1, $1)`,
    [entitlementTestNow, arranged.pack.capabilityId],
  );
  await entitlementTestPool.query(
    "update pack_versions set status='reviewed', resource_version=2, updated_at=$1 where pack_version_id='pack_version_snapshot_conflict'",
    [entitlementTestNow],
  );
  await entitlementTestPool.query(
    "update pack_versions set status='published', resource_version=3, updated_at=$1 where pack_version_id='pack_version_snapshot_conflict'",
    [entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into tenant_pack_releases (tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version, generation, status, resource_version, created_at, updated_at)
     values ('release_snapshot_conflict', $2, 'pack_product_snapshot_conflict', 'pack_version_snapshot_conflict', '2.0.0', 1, 'preparing', 1, $1, $1)`,
    [entitlementTestNow, arranged.tenantId],
  );
  await entitlementTestPool.query(
    "update tenant_pack_releases set status='current', updated_at=$1 where tenant_pack_release_id='release_snapshot_conflict'",
    [entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into entitlements (entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id, pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity, valid_from, status, reason_code, resource_version, created_at, updated_at)
     values ('entitlement_snapshot_conflict', $2, 'pack_product_snapshot_conflict', 'release_snapshot_conflict', 'pack_version_snapshot_conflict', '2.0.0', 'platform_manual', 'order_snapshot_conflict', 'b2b', 'seat', 1, $1, 'active', 'platform_grant', 1, $1, $1)`,
    [entitlementTestNow, arranged.tenantId],
  );
  await entitlementTestPool.query(
    `insert into entitlement_assignments (assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version, created_at, updated_at)
     values ('assignment_snapshot_conflict', $2, 'entitlement_snapshot_conflict', $3, 'preparing', 'seat_assigned', 1, $1, $1)`,
    [entitlementTestNow, arranged.tenantId, input.profileId],
  );
  await assert.rejects(() => resolve({ db: entitlementTestDatabase }, input), { code: "CAPABILITY_CONFLICT" });
  assert.deepEqual((await entitlementTestPool.query(
    "select snapshot_id, resource_version::int from profile_snapshot_pointers where tenant_id = $1 and profile_id = $2",
    [arranged.tenantId, input.profileId],
  )).rows[0], pointerBefore);
  assert.equal((await entitlementTestPool.query("select count(*)::int as count from capability_runtime_projections")).rows[0]?.count, 1);
});
