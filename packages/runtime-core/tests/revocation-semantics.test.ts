import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPayloadHash } from "../src/index.js";
import {
  entitlementTestDatabase,
  entitlementTestNow,
  resetEntitlementTestDatabase,
  seedPublishedPack,
  seedTenant,
} from "./entitlement-test-support.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;

test.beforeEach(resetEntitlementTestDatabase);
test.after(async () => entitlementTestDatabase.destroy());

test("account-deletion revocation removes only the Actor's entitlement authority and advances empty snapshots", async () => {
  assert.equal(typeof runtime.createAccountDeletionEntitlementRevocationPort, "function");
  const tenantId = "tenant_deletion_authority";
  const [profileId] = await seedTenant(tenantId, "b2c", 1);
  const pack = await seedPublishedPack("deletion_authority", ["b2c"]);
  await entitlementTestDatabase.insertInto("tenant_pack_releases").values({
    tenant_pack_release_id: "release_deletion_authority",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    pack_version_id: pack.packVersionId,
    pack_version: "1.0.0",
    generation: 1,
    status: "preparing",
    resource_version: 1,
    created_at: entitlementTestNow,
    updated_at: entitlementTestNow,
  }).execute();
  await entitlementTestDatabase.updateTable("tenant_pack_releases")
    .set({ status: "current", resource_version: 2, updated_at: entitlementTestNow })
    .where("tenant_pack_release_id", "=", "release_deletion_authority").execute();
  await entitlementTestDatabase.insertInto("entitlements").values({
    entitlement_id: "entitlement_deletion_authority",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    tenant_pack_release_id: "release_deletion_authority",
    pack_version_id: pack.packVersionId,
    pack_version: "1.0.0",
    source: "platform_manual",
    external_order_ref: "deletion-authority-order",
    tenant_mode: "b2c",
    assignment_mode: "automatic",
    seat_quantity: null,
    valid_from: entitlementTestNow,
    expires_at: null,
    status: "active",
    reason_code: "platform_grant",
    resource_version: 1,
    created_at: entitlementTestNow,
    updated_at: entitlementTestNow,
  }).execute();
  const port = (runtime.createAccountDeletionEntitlementRevocationPort as (input: Record<string, unknown>) => {
    revokeInTransaction(input: Record<string, unknown>): Promise<void>;
  })({ resolveProfileSnapshotInTransaction: runtime.resolveProfileSnapshotInTransaction });
  await entitlementTestDatabase.transaction().execute(async (trx) => port.revokeInTransaction({
    trx,
    actorId: `actor_${tenantId}_1`,
    accountDeletionId: "account_deletion_authority",
    now: entitlementTestNow,
    requestId: "request_deletion_authority",
    traceId: "trace_deletion_authority",
  }));
  assert.deepEqual(await entitlementTestDatabase.selectFrom("entitlements")
    .select(["status", "reason_code"]).where("tenant_id", "=", tenantId).executeTakeFirstOrThrow(), {
    status: "revoked",
    reason_code: "platform_revoked",
  });
  assert.deepEqual(await entitlementTestDatabase.selectFrom("entitlement_snapshot_capabilities")
    .select("capability_id").where("tenant_id", "=", tenantId).where("profile_id", "=", profileId!).execute(), []);
  assert.deepEqual(await entitlementTestDatabase.selectFrom("worker_jobs").select(["job_kind", "payload_ref"])
    .where("tenant_id", "=", tenantId).execute(), [{
    job_kind: "reconcile_capability_projection", payload_ref: profileId!,
  }]);
  assert.equal(canonicalPayloadHash({ account_deletion_id: "account_deletion_authority" }).startsWith("sha256:"), true);
});

test("B2B account deletion preserves company Entitlement history and other consultant assignments", async () => {
  const tenantId = "tenant_deletion_b2b";
  const [deletedProfileId, retainedProfileId] = await seedTenant(tenantId, "b2b", 2);
  const pack = await seedPublishedPack("deletion_b2b", ["b2b"]);
  await entitlementTestDatabase.insertInto("tenant_pack_releases").values({
    tenant_pack_release_id: "release_deletion_b2b", tenant_id: tenantId,
    pack_product_id: pack.packProductId, pack_version_id: pack.packVersionId, pack_version: "1.0.0",
    generation: 1, status: "preparing", resource_version: 1,
    created_at: entitlementTestNow, updated_at: entitlementTestNow,
  }).execute();
  await entitlementTestDatabase.updateTable("tenant_pack_releases")
    .set({ status: "current", resource_version: 2, updated_at: entitlementTestNow })
    .where("tenant_pack_release_id", "=", "release_deletion_b2b").execute();
  await entitlementTestDatabase.insertInto("entitlements").values({
    entitlement_id: "entitlement_deletion_b2b", tenant_id: tenantId, pack_product_id: pack.packProductId,
    tenant_pack_release_id: "release_deletion_b2b", pack_version_id: pack.packVersionId, pack_version: "1.0.0",
    source: "platform_manual", external_order_ref: "deletion-b2b-order", tenant_mode: "b2b",
    assignment_mode: "seat", seat_quantity: 2, valid_from: entitlementTestNow, expires_at: null,
    status: "active", reason_code: "platform_grant", resource_version: 1,
    created_at: entitlementTestNow, updated_at: entitlementTestNow,
  }).execute();
  for (const [index, profileId] of [deletedProfileId!, retainedProfileId!].entries()) {
    await entitlementTestDatabase.insertInto("entitlement_assignments").values({
      assignment_id: `assignment_deletion_b2b_${index + 1}`, tenant_id: tenantId,
      entitlement_id: "entitlement_deletion_b2b", profile_id: profileId,
      status: "preparing", reason_code: "seat_assigned", resource_version: 1,
      created_at: entitlementTestNow, updated_at: entitlementTestNow,
    }).execute();
    await entitlementTestDatabase.updateTable("entitlement_assignments")
      .set({ status: "available", resource_version: 2, updated_at: entitlementTestNow })
      .where("assignment_id", "=", `assignment_deletion_b2b_${index + 1}`).execute();
    await entitlementTestDatabase.transaction().execute(async (trx) => (
      runtime.resolveProfileSnapshotInTransaction as (input: Record<string, unknown>) => Promise<unknown>
    )({
      trx, now: entitlementTestNow, tenantId, profileId,
      evidence: {
        actorId: `actor_${tenantId}_1`, membershipId: `membership_${tenantId}_1`,
        requestId: `request_b2b_${index + 1}`, traceId: `trace_b2b_${index + 1}`,
      },
    }));
  }
  const port = (runtime.createAccountDeletionEntitlementRevocationPort as () => {
    revokeInTransaction(input: Record<string, unknown>): Promise<void>;
  })();
  await entitlementTestDatabase.transaction().execute(async (trx) => port.revokeInTransaction({
    trx,
    actorId: `actor_${tenantId}_1`,
    accountDeletionId: "account_deletion_b2b",
    now: entitlementTestNow,
    requestId: "request_deletion_b2b",
    traceId: "trace_deletion_b2b",
  }));
  assert.equal((await entitlementTestDatabase.selectFrom("entitlements").select("status")
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow()).status, "active");
  assert.deepEqual(await entitlementTestDatabase.selectFrom("entitlement_assignments")
    .select(["assignment_id", "status"]).where("tenant_id", "=", tenantId)
    .orderBy("assignment_id", "asc").execute(), [
    { assignment_id: "assignment_deletion_b2b_1", status: "revoked" },
    { assignment_id: "assignment_deletion_b2b_2", status: "available" },
  ]);
  const deletedPointer = await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select("snapshot_id").where("tenant_id", "=", tenantId).where("profile_id", "=", deletedProfileId!).executeTakeFirstOrThrow();
  assert.deepEqual(await entitlementTestDatabase.selectFrom("entitlement_snapshot_capabilities")
    .select("capability_id").where("snapshot_id", "=", deletedPointer.snapshot_id).execute(), []);
  const retainedPointer = await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select("snapshot_id").where("tenant_id", "=", tenantId).where("profile_id", "=", retainedProfileId!).executeTakeFirstOrThrow();
  assert.deepEqual(await entitlementTestDatabase.selectFrom("entitlement_snapshot_capabilities")
    .select("capability_id").where("snapshot_id", "=", retainedPointer.snapshot_id).execute(), [{ capability_id: pack.capabilityId }]);
  assert.deepEqual(await entitlementTestDatabase.selectFrom("worker_jobs").select(["job_kind", "payload_ref"])
    .where("tenant_id", "=", tenantId).execute(), [{
    job_kind: "reconcile_capability_projection", payload_ref: deletedProfileId!,
  }]);
  const currentAuthority = await (runtime.loadCurrentSnapshotAuthority as (input: Record<string, unknown>) => Promise<{
    readonly current: boolean;
    readonly state: string;
  }>)({
    trx: entitlementTestDatabase,
    tenantId,
    profileId: deletedProfileId!,
    now: entitlementTestNow,
  });
  assert.deepEqual({ current: currentAuthority.current, state: currentAuthority.state }, {
    current: false,
    state: "denied",
  });
});

test("B2B account deletion revokes the Actor's suspended Profile assignment and queues reconciliation", async () => {
  const tenantId = "tenant_deletion_b2b_suspended";
  const [profileId] = await seedTenant(tenantId, "b2b", 1);
  const pack = await seedPublishedPack("deletion_b2b_suspended", ["b2b"]);
  await entitlementTestDatabase.insertInto("tenant_pack_releases").values({
    tenant_pack_release_id: "release_deletion_b2b_suspended", tenant_id: tenantId,
    pack_product_id: pack.packProductId, pack_version_id: pack.packVersionId, pack_version: "1.0.0",
    generation: 1, status: "preparing", resource_version: 1,
    created_at: entitlementTestNow, updated_at: entitlementTestNow,
  }).execute();
  await entitlementTestDatabase.updateTable("tenant_pack_releases")
    .set({ status: "current", resource_version: 2, updated_at: entitlementTestNow })
    .where("tenant_pack_release_id", "=", "release_deletion_b2b_suspended").execute();
  await entitlementTestDatabase.insertInto("entitlements").values({
    entitlement_id: "entitlement_deletion_b2b_suspended", tenant_id: tenantId,
    pack_product_id: pack.packProductId, tenant_pack_release_id: "release_deletion_b2b_suspended",
    pack_version_id: pack.packVersionId, pack_version: "1.0.0", source: "platform_manual",
    external_order_ref: "deletion-b2b-suspended-order", tenant_mode: "b2b", assignment_mode: "seat",
    seat_quantity: 1, valid_from: entitlementTestNow, expires_at: null, status: "active",
    reason_code: "platform_grant", resource_version: 1,
    created_at: entitlementTestNow, updated_at: entitlementTestNow,
  }).execute();
  await entitlementTestDatabase.insertInto("entitlement_assignments").values({
    assignment_id: "assignment_deletion_b2b_suspended", tenant_id: tenantId,
    entitlement_id: "entitlement_deletion_b2b_suspended", profile_id: profileId!, status: "preparing",
    reason_code: "seat_assigned", resource_version: 1,
    created_at: entitlementTestNow, updated_at: entitlementTestNow,
  }).execute();
  await entitlementTestDatabase.updateTable("entitlement_assignments")
    .set({ status: "available", resource_version: 2, updated_at: entitlementTestNow })
    .where("assignment_id", "=", "assignment_deletion_b2b_suspended").execute();
  await entitlementTestDatabase.updateTable("profiles").set({ status: "suspended", resource_version: 2, updated_at: entitlementTestNow })
    .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId!).execute();
  await entitlementTestDatabase.updateTable("entitlement_assignments")
    .set({ status: "suspended", reason_code: "authority_suspended", resource_version: 3, updated_at: entitlementTestNow })
    .where("assignment_id", "=", "assignment_deletion_b2b_suspended").execute();
  const port = (runtime.createAccountDeletionEntitlementRevocationPort as () => {
    revokeInTransaction(input: Record<string, unknown>): Promise<void>;
  })();
  await entitlementTestDatabase.transaction().execute(async (trx) => port.revokeInTransaction({
    trx, actorId: `actor_${tenantId}_1`, accountDeletionId: "account_deletion_b2b_suspended",
    now: entitlementTestNow, requestId: "request_deletion_b2b_suspended", traceId: "trace_deletion_b2b_suspended",
  }));
  assert.equal((await entitlementTestDatabase.selectFrom("entitlement_assignments").select("status")
    .where("assignment_id", "=", "assignment_deletion_b2b_suspended").executeTakeFirstOrThrow()).status, "revoked");
  assert.deepEqual(await entitlementTestDatabase.selectFrom("worker_jobs").select(["job_kind", "payload_ref"])
    .where("tenant_id", "=", tenantId).execute(), [{
    job_kind: "reconcile_capability_projection", payload_ref: profileId!,
  }]);
});
