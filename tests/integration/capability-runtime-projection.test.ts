import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assignPackSeat,
  changeEntitlementStatus,
  createCapabilityVersion,
  createPackVersion,
  deriveRuntimeContainerId,
  DomainError,
  enqueueIdleB2cRuntimeStopJobs,
  ensureRuntimeWakeIntent,
  grantEntitlement,
  publishPackVersion,
  resolveProfileSnapshotInTransaction,
  reviewCapabilityVersion,
  reviewPackVersion,
  selectTenantPackRelease,
  touchRuntimeActivity,
} from "@core-agent/runtime-core";
import { sql } from "kysely";

import { createIntegrationHarness, type IntegrationHarness } from "./harness.js";
import {
  entitlementSliceInternals,
  prepareB2BEntitlementSlice,
  type PreparedEntitlementSlice,
} from "./fixtures/entitlement-slice.js";

const contractRef = "integration/capability@1.0.0";

let harness: IntegrationHarness;
let slice: PreparedEntitlementSlice;

test.before(async () => {
  harness = await createIntegrationHarness("capability-runtime-projection");
  slice = await prepareB2BEntitlementSlice(harness);
});

test.after(async () => {
  await harness?.close();
});

function catalogDependencies() {
  return {
    db: harness.db,
    knownContractRefs: [contractRef],
    platformCompatibility: {
      core_contract_version: "0.8.0",
      runtime_protocol_version: "1.0.0",
    },
    catalogAuthorityTenantId: slice.platformTenantId,
  } as const;
}

function catalogContext(label: string) {
  return {
    performingActorId: slice.platformActorId,
    requestId: `request_${label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    traceId: `trace_${label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
  } as const;
}

async function createReviewedCapabilityVersion(version: string, label: string): Promise<string> {
  const capabilityVersionId = `capability_version_${label}_${entitlementSliceInternals.suffix(slice.tenantId)}`;
  const context = catalogContext(`capability_${label}`);
  await createCapabilityVersion(catalogDependencies(), context, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `capability_create_${label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    capability_id: slice.capabilityId,
    capability_version_id: capabilityVersionId,
    display_name: "Integration read capability",
    owning_domain: "integration",
    kind: "mcp" as const,
    version,
    artifact_ref: `manifest:sha256:${createHash("sha256").update(capabilityVersionId).digest("hex")}`,
    contract_ref: contractRef,
    risk_class: "read" as const,
    approval_requirement: "none" as const,
    compatibility: {
      core_contract_version: "0.8.0",
      domain_contract_version: "1.0.0",
      runtime_protocol_version: "1.0.0",
      tenant_modes: ["b2b"] as const,
    },
    expected_resource_version: null,
  }));
  await reviewCapabilityVersion(catalogDependencies(), context, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `capability_review_${label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    capability_version_id: capabilityVersionId,
    expected_resource_version: 1,
  }));
  return capabilityVersionId;
}

async function createPublishedPack(input: {
  readonly label: string;
  readonly packProductId: string;
  readonly displayName: string;
  readonly packVersion: string;
  readonly capabilityVersionId: string;
  readonly capabilityVersion: string;
}): Promise<string> {
  const packVersionId = `pack_version_${input.label}_${entitlementSliceInternals.suffix(slice.tenantId)}`;
  const context = catalogContext(`pack_${input.label}`);
  await createPackVersion(catalogDependencies(), context, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `pack_create_${input.label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    pack_product_id: input.packProductId,
    pack_version_id: packVersionId,
    display_name: input.displayName,
    tenant_modes: ["b2b"] as const,
    version: input.packVersion,
    expected_resource_version: null,
    members: [{
      capability_id: slice.capabilityId,
      capability_version_id: input.capabilityVersionId,
      version: input.capabilityVersion,
    }],
  }));
  await reviewPackVersion(catalogDependencies(), context, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `pack_review_${input.label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    pack_version_id: packVersionId,
    expected_resource_version: 1,
  }));
  await publishPackVersion(catalogDependencies(), context, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `pack_publish_${input.label}_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    pack_version_id: packVersionId,
    expected_resource_version: 2,
  }));
  return packVersionId;
}

async function waitForLatestProjection(): Promise<{
  readonly runtime_generation: string;
  readonly snapshot_id: string;
  readonly capability_manifest_digest: string;
}> {
  const row = await entitlementSliceInternals.waitFor(
    () => harness.db.selectFrom("capability_runtime_projections")
      .select(["runtime_generation", "snapshot_id", "capability_manifest_digest", "status"])
      .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
      .orderBy("runtime_generation", "desc").executeTakeFirst(),
    (candidate) => candidate?.status === "available",
    "latest capability projection",
  );
  assert(row !== undefined);
  return row;
}

test("a conflicting Pack upgrade preserves current authority and a valid rollback proves a newer Runtime generation", async () => {
  const marker = entitlementSliceInternals.suffix(slice.tenantId);
  const addOnProductId = `pack_addon_${marker}`;
  const addOnPackVersionId = await createPublishedPack({
    label: "addon_v1",
    packProductId: addOnProductId,
    displayName: "Integration compatibility add-on",
    packVersion: "1.0.0",
    capabilityVersionId: slice.capabilityVersionId,
    capabilityVersion: "1.0.0",
  });
  const entitlementDependencies = {
    db: harness.db,
    platformAuthorityTenantId: slice.platformTenantId,
  } as const;
  const addOnRelease = await selectTenantPackRelease(
    entitlementDependencies,
    slice.platformContext,
    entitlementSliceInternals.protectedCommand({
      schema_version: 1 as const,
      idempotency_key: `addon_release_${marker}`,
      tenant_id: slice.tenantId,
      pack_product_id: addOnProductId,
      pack_version_id: addOnPackVersionId,
      expected_resource_version: 1,
    }),
  );
  assert.equal(addOnRelease.kind, "current");
  const addOnEntitlement = await grantEntitlement(
    entitlementDependencies,
    slice.platformContext,
    entitlementSliceInternals.protectedCommand({
      schema_version: 1 as const,
      idempotency_key: `addon_grant_${marker}`,
      tenant_id: slice.tenantId,
      pack_product_id: addOnProductId,
      source: "platform_manual" as const,
      external_order_ref: `order_addon_${marker}`,
      expected_resource_version: 1,
      tenant_mode: "b2b" as const,
      assignment_mode: "seat" as const,
      seat_quantity: 1,
    }),
  );
  await assignPackSeat({
    db: harness.db,
    platformAuthorityTenantId: slice.platformTenantId,
    authorityTenantId: slice.tenantId,
    resolveProfileSnapshotInTransaction,
  }, slice.companyContext, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `addon_assign_${marker}`,
    entitlement_id: addOnEntitlement.entitlement_id,
    expected_resource_version: 1,
    profile_id: slice.profileId,
  }));
  await waitForLatestProjection();

  const capabilityV2 = await createReviewedCapabilityVersion("2.0.0", "slice_v2");
  const packV2 = await createPublishedPack({
    label: "slice_v2",
    packProductId: slice.packProductId,
    displayName: "Integration service",
    packVersion: "2.0.0",
    capabilityVersionId: capabilityV2,
    capabilityVersion: "2.0.0",
  });
  const currentBeforeConflict = await harness.db.selectFrom("tenant_pack_releases").selectAll()
    .where("tenant_id", "=", slice.tenantId).where("pack_product_id", "=", slice.packProductId)
    .where("status", "=", "current").executeTakeFirstOrThrow();
  const pointerBeforeConflict = await harness.db.selectFrom("profile_snapshot_pointers")
    .select(["snapshot_id", "snapshot_version", "resource_version"])
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .executeTakeFirstOrThrow();
  const runtimeBeforeConflict = await harness.db.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest", "volume_ref"])
    .where("tenant_id", "=", slice.tenantId).executeTakeFirstOrThrow();
  await assert.rejects(selectTenantPackRelease(
    entitlementDependencies,
    slice.platformContext,
    entitlementSliceInternals.protectedCommand({
      schema_version: 1 as const,
      idempotency_key: `conflicting_upgrade_${marker}`,
      tenant_id: slice.tenantId,
      pack_product_id: slice.packProductId,
      pack_version_id: packV2,
      expected_resource_version: Number(currentBeforeConflict.resource_version),
    }),
  ), (error: unknown) => error instanceof DomainError && error.code === "CAPABILITY_CONFLICT");
  assert.deepEqual(await harness.db.selectFrom("profile_snapshot_pointers")
    .select(["snapshot_id", "snapshot_version", "resource_version"])
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .executeTakeFirstOrThrow(), pointerBeforeConflict);
  assert.deepEqual(await harness.db.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest", "volume_ref"])
    .where("tenant_id", "=", slice.tenantId).executeTakeFirstOrThrow(), runtimeBeforeConflict);
  assert.deepEqual(await harness.db.selectFrom("tenant_pack_releases").select(["tenant_pack_release_id", "status"])
    .where("tenant_id", "=", slice.tenantId).where("pack_product_id", "=", slice.packProductId)
    .execute(), [{ tenant_pack_release_id: currentBeforeConflict.tenant_pack_release_id, status: "current" }]);

  const addOnVersion = await harness.db.selectFrom("entitlements").select("resource_version")
    .where("entitlement_id", "=", addOnEntitlement.entitlement_id).executeTakeFirstOrThrow();
  await changeEntitlementStatus(entitlementDependencies, slice.platformContext, entitlementSliceInternals.protectedCommand({
    schema_version: 1 as const,
    idempotency_key: `addon_suspend_${marker}`,
    entitlement_id: addOnEntitlement.entitlement_id,
    expected_resource_version: Number(addOnVersion.resource_version),
    status: "suspended" as const,
    reason_code: "administrator_suspended" as const,
  }));
  const afterAddOnRemoval = await waitForLatestProjection();
  assert(Number(afterAddOnRemoval.runtime_generation) > runtimeBeforeConflict.generation);

  const upgrade = await selectTenantPackRelease(
    entitlementDependencies,
    slice.platformContext,
    entitlementSliceInternals.protectedCommand({
      schema_version: 1 as const,
      idempotency_key: `valid_upgrade_${marker}`,
      tenant_id: slice.tenantId,
      pack_product_id: slice.packProductId,
      pack_version_id: packV2,
      expected_resource_version: Number(currentBeforeConflict.resource_version),
    }),
  );
  assert.equal(upgrade.kind, "preparing");
  await entitlementSliceInternals.waitFor(
    () => harness.db.selectFrom("tenant_pack_releases").select(["status", "resource_version"])
      .where("tenant_id", "=", slice.tenantId).where("tenant_pack_release_id", "=", upgrade.releaseId)
      .executeTakeFirst(),
    (row) => row?.status === "current",
    "upgrade release current",
  );
  const upgraded = await waitForLatestProjection();
  const upgradedGeneration = Number(upgraded.runtime_generation);
  assert(upgradedGeneration > Number(afterAddOnRemoval.runtime_generation));

  const rollback = await selectTenantPackRelease(
    entitlementDependencies,
    slice.platformContext,
    entitlementSliceInternals.protectedCommand({
      schema_version: 1 as const,
      idempotency_key: `valid_rollback_${marker}`,
      tenant_id: slice.tenantId,
      pack_product_id: slice.packProductId,
      pack_version_id: slice.packVersionId,
      expected_resource_version: 2,
    }),
  );
  assert.equal(rollback.kind, "preparing");
  await entitlementSliceInternals.waitFor(
    () => harness.db.selectFrom("tenant_pack_releases").select("status")
      .where("tenant_id", "=", slice.tenantId).where("tenant_pack_release_id", "=", rollback.releaseId)
      .executeTakeFirst(),
    (row) => row?.status === "current",
    "rollback release current",
  );
  const rolledBack = await waitForLatestProjection();
  assert(Number(rolledBack.runtime_generation) > upgradedGeneration);
  const rolledBackCapabilities = await harness.db.selectFrom("entitlement_snapshot_capabilities")
    .select(["capability_version_id", "version"])
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .where("snapshot_id", "=", rolledBack.snapshot_id).execute();
  assert.deepEqual(rolledBackCapabilities, [{
    capability_version_id: slice.capabilityVersionId,
    version: "1.0.0",
  }]);
  assert.equal((await harness.db.selectFrom("entitlement_snapshots").select("snapshot_id")
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .execute()).some((snapshot) => snapshot.snapshot_id === pointerBeforeConflict.snapshot_id), true);
});

test("a B2C Runtime stops after 30 idle minutes and one idempotent wake preserves its Volume", async () => {
  await harness.stopWorker();
  const marker = entitlementSliceInternals.suffix(`${slice.tenantId}_b2c_idle`);
  const tenantId = `tenant_b2c_idle_${marker}`;
  const runtimeId = deriveRuntimeContainerId(tenantId);
  const now = new Date();
  const imageRef = `managed/runtime-task16:v1@sha256:${"a".repeat(64)}`;
  const digest = `sha256:${createHash("sha256").update(tenantId).digest("hex")}`;
  const volumeRef = `volume_b2c_idle_${marker}`;
  await harness.db.insertInto("tenants").values({
    tenant_id: tenantId,
    schema_version: 1,
    resource_version: 1,
    tenant_mode: "b2c",
    status: "active",
    display_name: "Integration B2C idle tenant",
    created_at: now,
    updated_at: now,
  }).execute();
  await harness.db.insertInto("memberships").values({
    tenant_id: tenantId,
    membership_id: "core_agent_provisioner_admin",
    actor_id: "core_agent_provisioner",
    schema_version: 1,
    resource_version: 1,
    roles: ["admin"],
    membership_source: "platform",
    seat_ref: null,
    status: "active",
    created_at: now,
    updated_at: now,
  }).execute();
  await harness.db.insertInto("runtime_containers").values({
    tenant_id: tenantId,
    container_id: runtimeId,
    schema_version: 1,
    resource_version: 1,
    command_version: 1,
    runtime_kind: "hermes",
    desired_state: "running",
    observed_state: "ready",
    image_ref: imageRef,
    runtime_platform: "linux/amd64",
    generation: 1,
    volume_ref: volumeRef,
    health_status: "healthy",
    last_probed_at: now,
    failure_summary: null,
    capability_manifest_digest: digest,
    created_at: now,
    updated_at: now,
  }).execute();
  await harness.db.insertInto("runtime_activity").values({
    tenant_id: tenantId,
    runtime_generation: 1,
    last_work_at: sql<Date>`clock_timestamp() - interval '31 minutes'`,
    active_conversation_count: 0,
    active_run_count: 0,
    resource_version: 1,
    created_at: now,
    updated_at: now,
  }).execute();
  harness.supervisorState.observations.set(`${tenantId}\0${runtimeId}`, {
    tenant_id: tenantId,
    runtime_id: runtimeId,
    generation: 1,
    exists: true,
    lifecycle: "running",
    health: "healthy",
    image_ref: imageRef,
    private_origin: "http://core-agent-runtime-task16:8642",
  });
  assert.equal(await enqueueIdleB2cRuntimeStopJobs(harness.db, 10), 1);
  await harness.startWorker("worker_b2c_idle_stop");
  await harness.worker.untilRuntimeStatus(runtimeId, "stopped");
  const stopped = await harness.db.selectFrom("runtime_containers")
    .select(["generation", "volume_ref", "capability_manifest_digest", "desired_state", "observed_state"])
    .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(stopped, {
    generation: 1,
    volume_ref: volumeRef,
    capability_manifest_digest: digest,
    desired_state: "stopped",
    observed_state: "stopped",
  });

  await harness.stopWorker();
  await harness.db.transaction().execute((trx) => touchRuntimeActivity(trx, tenantId));
  const wake = () => harness.db.transaction().execute((trx) => ensureRuntimeWakeIntent(trx, { tenantId, runtimeId }));
  assert.equal(await wake(), "preparing");
  assert.equal(await wake(), "preparing");
  assert.equal(await harness.db.selectFrom("worker_jobs").select("job_id")
    .where("tenant_id", "=", tenantId).where("job_kind", "=", "reconcile_runtime")
    .where("runtime_command", "=", "start").where("status", "=", "queued")
    .execute().then((rows) => rows.length), 1);
  await harness.startWorker("worker_b2c_idle_wake");
  await harness.worker.untilRuntimeStatus(runtimeId, "ready");
  const woken = await harness.db.selectFrom("runtime_containers")
    .select(["generation", "volume_ref", "capability_manifest_digest", "desired_state", "observed_state", "health_status"])
    .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId)
    .executeTakeFirstOrThrow();
  assert.deepEqual(woken, {
    generation: 1,
    volume_ref: volumeRef,
    capability_manifest_digest: digest,
    desired_state: "running",
    observed_state: "ready",
    health_status: "healthy",
  });
  assert.deepEqual(await harness.db.selectFrom("worker_jobs")
    .select(["runtime_command", "status", "effect_state"])
    .where("tenant_id", "=", tenantId).where("job_kind", "=", "reconcile_runtime")
    .orderBy("created_at", "asc").execute(), [
    { runtime_command: "stop", status: "succeeded", effect_state: "unsafe_to_replay" },
    { runtime_command: "start", status: "succeeded", effect_state: "unsafe_to_replay" },
  ]);
  const lifecycleKinds = harness.fakeSupervisor.requests
    .filter((request) => (request.kind === "stop" || request.kind === "start")
      && request.tenant_id === tenantId && request.runtime_id === runtimeId)
    .map((request) => request.kind);
  assert.deepEqual(lifecycleKinds, ["stop", "start"]);
});
