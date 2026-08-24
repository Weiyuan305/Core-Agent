import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalPayloadHash, DomainError } from "../src/index.js";
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
type CurrentAuthority = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function requiredCommand(name: string): Command {
  assert.equal(typeof runtime[name], "function", `${name} must be exported`);
  return runtime[name] as Command;
}

function requiredAuthority(name: string): CurrentAuthority {
  assert.equal(typeof runtime[name], "function", `${name} must be exported`);
  return runtime[name] as CurrentAuthority;
}

function command(payload: Record<string, unknown>) {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

async function arrangeCurrentB2cAuthority() {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
  const platform = await seedPlatformAuthority("admission");
  const tenantId = "tenant_entitlement_admission";
  const [profileId] = await seedTenant(tenantId, "b2c", 1);
  const pack = await seedPublishedPack("admission", ["b2c"]);
  const dependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
    resolveProfileSnapshotInTransaction: runtime.resolveProfileSnapshotInTransaction,
  };
  await requiredCommand("selectTenantPackRelease")(dependencies, platform, command({
    schema_version: 1,
    idempotency_key: "admission-release",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    pack_version_id: pack.packVersionId,
    expected_resource_version: 1,
  }));
  await requiredCommand("grantEntitlement")(dependencies, platform, command({
    schema_version: 1,
    idempotency_key: "admission-grant",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    source: "platform_manual",
    external_order_ref: "admission-order",
    expected_resource_version: 1,
    tenant_mode: "b2c",
    assignment_mode: "automatic",
  }));
  const projection = await entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .select(["projection_id", "runtime_generation", "capability_manifest_digest"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  await entitlementTestDatabase.updateTable("capability_runtime_projections")
    .set({ status: "available", updated_at: entitlementTestNow })
    .where("projection_id", "=", projection.projection_id).execute();
  await entitlementTestDatabase.insertInto("runtime_containers").values({
    tenant_id: tenantId,
    container_id: `runtime_${createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 32)}`,
    schema_version: 1,
    resource_version: 1,
    command_version: 1,
    runtime_kind: "hermes",
    desired_state: "running",
    observed_state: "ready",
    image_ref: `hermes@sha256:${"d".repeat(64)}`,
    runtime_platform: "linux/arm64",
    generation: Number(projection.runtime_generation),
    volume_ref: `volume_${tenantId}`,
    health_status: "healthy",
    last_probed_at: entitlementTestNow,
    failure_summary: null,
    capability_manifest_digest: projection.capability_manifest_digest,
    created_at: entitlementTestNow,
    updated_at: entitlementTestNow,
  }).execute();
  return {
    tenantId,
    profileId: profileId!,
    actorId: `actor_${tenantId}_1`,
    membershipId: `membership_${tenantId}_1`,
    capabilityId: pack.capabilityId,
  };
}

test.after(async () => entitlementTestDatabase.destroy());

test("current Snapshot authority requires an exact effective set and available matching Runtime projection", async () => {
  const arranged = await arrangeCurrentB2cAuthority();
  const load = requiredAuthority("loadCurrentSnapshotAuthority");
  const authority = await load({
    trx: entitlementTestDatabase,
    tenantId: arranged.tenantId,
    profileId: arranged.profileId,
    now: entitlementTestNow,
  });
  assert.equal(authority.current, true);
  assert.deepEqual(authority.capabilityIds, [arranged.capabilityId]);
  assert.equal(authority.tenantId, arranged.tenantId);
  assert.equal(authority.profileId, arranged.profileId);

  await entitlementTestDatabase.updateTable("runtime_containers")
    .set({ capability_manifest_digest: `sha256:${"a".repeat(64)}` })
    .where("tenant_id", "=", arranged.tenantId).execute();
  const preparing = await load({
    trx: entitlementTestDatabase,
    tenantId: arranged.tenantId,
    profileId: arranged.profileId,
    now: entitlementTestNow,
  });
  assert.equal(preparing.current, false);
  assert.equal(preparing.state, "preparing");
  await assert.rejects(requiredAuthority("requireCurrentSnapshotAuthority")({
    db: entitlementTestDatabase,
    tenantId: arranged.tenantId,
    profileId: arranged.profileId,
    now: entitlementTestNow,
  }), (error: unknown) => error instanceof DomainError && error.code === "SERVICE_PREPARING");
});

test("current authority denies stale signed capabilities before a new external effect", async () => {
  const arranged = await arrangeCurrentB2cAuthority();
  const recheck = requiredAuthority("recheckCapabilityBeforeEffect");
  let effects = 0;
  await recheck({
    db: entitlementTestDatabase,
    tenantId: arranged.tenantId,
    profileId: arranged.profileId,
    capabilityId: arranged.capabilityId,
    expectedSnapshotRef: (await requiredAuthority("loadCurrentSnapshotAuthority")({
      trx: entitlementTestDatabase,
      tenantId: arranged.tenantId,
      profileId: arranged.profileId,
      now: entitlementTestNow,
    })).snapshotRef,
    effect: async () => { effects += 1; },
  });
  assert.equal(effects, 1);

  await entitlementTestDatabase.updateTable("entitlements")
    .set({ status: "revoked", reason_code: "platform_revoked", resource_version: 2, updated_at: entitlementTestNow })
    .where("tenant_id", "=", arranged.tenantId).execute();
  await assert.rejects(recheck({
    db: entitlementTestDatabase,
    tenantId: arranged.tenantId,
    profileId: arranged.profileId,
    capabilityId: arranged.capabilityId,
    expectedSnapshotRef: { snapshot_id: "stale", version: 1, evaluated_at: entitlementTestNow.toISOString() },
    effect: async () => { effects += 1; },
  }), (error: unknown) => error instanceof DomainError && error.code === "ENTITLEMENT_DENIED");
  assert.equal(effects, 1);
});

test("database failures at the current-authority boundary fail closed without provider details", async () => {
  const requireAuthority = requiredAuthority("requireCurrentSnapshotAuthority");
  assert.equal(typeof runtime.requireCurrentSnapshot, "function");
  await assert.rejects(requireAuthority({
    db: { transaction() { throw new Error("postgresql://secret@host/internal"); } },
    tenantId: "tenant_failure",
    profileId: "profile_failure",
  }), (error: unknown) => (
    error instanceof DomainError
    && error.code === "DEPENDENCY_UNAVAILABLE"
    && !error.message.includes("postgresql")
  ));
  await assert.rejects(requiredAuthority("loadCurrentSnapshotAuthority")({
    trx: { selectFrom() { throw new Error("postgresql://secret@host/internal"); } },
    tenantId: "tenant_failure",
    profileId: "profile_failure",
    now: entitlementTestNow,
  }), (error: unknown) => (
    error instanceof DomainError
    && error.code === "DEPENDENCY_UNAVAILABLE"
    && !error.message.includes("postgresql")
  ));
});

test("current authority immediately denies every underlying Tenant Profile Membership Pack Capability and release transition", async () => {
  const cases: ReadonlyArray<readonly [string, (tenantId: string) => Promise<unknown>]> = [
    ["tenant", (tenantId) => entitlementTestDatabase.updateTable("tenants").set({ status: "suspended" }).where("tenant_id", "=", tenantId).execute()],
    ["profile", (tenantId) => entitlementTestDatabase.updateTable("profiles").set({ status: "suspended" }).where("tenant_id", "=", tenantId).execute()],
    ["membership", (tenantId) => entitlementTestDatabase.updateTable("memberships").set({ status: "suspended" })
      .where("tenant_id", "=", tenantId).where("membership_source", "=", "self").execute()],
    ["entitlement-suspended", (tenantId) => entitlementTestDatabase.updateTable("entitlements").set({
      status: "suspended", reason_code: "administrator_suspended", resource_version: 2, updated_at: entitlementTestNow,
    }).where("tenant_id", "=", tenantId).execute()],
    ["entitlement-expired", (tenantId) => entitlementTestDatabase.updateTable("entitlements").set({
      valid_from: new Date(entitlementTestNow.getTime() - 2),
      expires_at: new Date(entitlementTestNow.getTime() - 1),
      status: "expired", reason_code: "validity_expired", resource_version: 2, updated_at: entitlementTestNow,
    }).where("tenant_id", "=", tenantId).execute()],
    ["release", (tenantId) => entitlementTestDatabase.updateTable("tenant_pack_releases").set({ status: "superseded", resource_version: 3, updated_at: entitlementTestNow })
      .where("tenant_id", "=", tenantId).execute()],
    ["pack", () => entitlementTestDatabase.updateTable("pack_versions").set({ status: "blocked", resource_version: 4, updated_at: entitlementTestNow }).execute()],
    ["capability", () => entitlementTestDatabase.updateTable("capability_versions").set({ status: "blocked", resource_version: 2, updated_at: entitlementTestNow }).execute()],
  ];
  for (const [label, mutate] of cases) {
    const arranged = await arrangeCurrentB2cAuthority();
    await mutate(arranged.tenantId);
    const authority = await requiredAuthority("loadCurrentSnapshotAuthority")({
      trx: entitlementTestDatabase,
      tenantId: arranged.tenantId,
      profileId: arranged.profileId,
      now: entitlementTestNow,
    });
    assert.equal(authority.current, false, `${label} authority must be denied`);
    assert.equal(authority.state, "denied", `${label} transition must not remain preparing`);
  }
});
