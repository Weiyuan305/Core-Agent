import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPayloadHash } from "../src/domain/idempotency.js";
import { CapabilityProjectionRepository } from "../src/repositories/entitlements/projections.js";
import { deriveRuntimeContainerId } from "../src/services/provision-tenant.js";
import { resolveProfileSnapshotInTransaction } from "../src/services/entitlements/resolve-profile-snapshot.js";
import {
  assignPackSeat,
  grantEntitlement,
  loadCurrentSnapshotAuthority,
  markJobEffectDispatched,
  selectTenantPackRelease,
} from "../src/index.js";
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

function command(payload: Record<string, unknown>) {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;

test.beforeEach(async () => {
  await resetEntitlementTestDatabase();
  await seedTenant("tenant_platform_authority", "b2b", 0);
});
test.after(async () => entitlementTestPool.end());

async function arrange(profileCount = 1) {
  const tenantId = "tenant_projection";
  const profileIds = await seedTenant(tenantId, "b2b", profileCount);
  const profileId = profileIds[0];
  const platform = await seedPlatformAuthority("projection");
  const admin = await seedCompanyAdminAuthority(tenantId, 1, "projection");
  const pack = await seedPublishedPack("projection", ["b2b"]);
  const platformDependencies = {
    db: entitlementTestDatabase,
    platformAuthorityTenantId: "tenant_platform_authority",
    databaseNow: async () => new Date(entitlementTestNow),
  };
  await selectTenantPackRelease(platformDependencies, platform, command({
    schema_version: 1,
    idempotency_key: "projection-release",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    pack_version_id: pack.packVersionId,
    expected_resource_version: 1,
  }) as never);
  const entitlement = await grantEntitlement(platformDependencies, platform, command({
    schema_version: 1,
    idempotency_key: "projection-grant",
    tenant_id: tenantId,
    pack_product_id: pack.packProductId,
    source: "platform_manual",
    external_order_ref: "projection-order",
    expected_resource_version: 1,
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: profileCount,
  }) as never);
  const assignmentIds: string[] = [];
  for (const [index, targetProfileId] of profileIds.entries()) {
    const assignment = await assignPackSeat({
      db: entitlementTestDatabase,
      databaseNow: async () => new Date(entitlementTestNow),
      resolveProfileSnapshotInTransaction,
    }, admin, command({
      schema_version: 1,
      idempotency_key: `projection-assignment-${index + 1}`,
      entitlement_id: entitlement.entitlement_id,
      expected_resource_version: 1,
      profile_id: targetProfileId,
    }) as never);
    assignmentIds.push(assignment.assignment_id);
  }
  const runtimeId = deriveRuntimeContainerId(tenantId);
  await entitlementTestDatabase.insertInto("runtime_containers").values({
    tenant_id: tenantId,
    container_id: runtimeId,
    schema_version: 1,
    resource_version: 1,
    command_version: 0,
    runtime_kind: "hermes",
    desired_state: "running",
    observed_state: "ready",
    image_ref: imageRef,
    runtime_platform: "linux/amd64",
    generation: 1,
    volume_ref: "volume_projection",
    health_status: "healthy",
    last_probed_at: entitlementTestNow,
    failure_summary: null,
    capability_manifest_digest: `sha256:${"0".repeat(64)}`,
    created_at: entitlementTestNow,
    updated_at: entitlementTestNow,
  }).execute();
  const directJob = await entitlementTestDatabase.selectFrom("worker_jobs")
    .innerJoin("capability_runtime_projections", "capability_runtime_projections.projection_id", "worker_jobs.payload_ref")
    .select(["worker_jobs.job_id", "worker_jobs.attempt_count", "capability_runtime_projections.projection_id"])
    .where("worker_jobs.tenant_id", "=", tenantId)
    .where("worker_jobs.job_kind", "=", "reconcile_capability_projection")
    .executeTakeFirstOrThrow();
  await entitlementTestDatabase.updateTable("worker_jobs").set({
    status: "running",
    attempt_count: 1,
    lease_owner: "worker_projection",
    lease_expires_at: new Date("2100-01-01T00:00:00.000Z"),
  }).where("tenant_id", "=", tenantId).where("job_id", "=", directJob.job_id).execute();
  return {
    tenantId,
    profileId: profileId!,
    profileIds,
    assignmentId: assignmentIds[0]!,
    assignmentIds: Object.freeze(assignmentIds),
    runtimeId,
    platform,
    platformDependencies,
    pack,
    job: {
      tenantId,
      jobId: directJob.job_id,
      workerId: "worker_projection",
      attemptCount: 1,
      projectionId: directJob.projection_id,
    },
  };
}

async function runProjection(
  repository: CapabilityProjectionRepository,
  job: Awaited<ReturnType<typeof arrange>>["job"],
  runtimeId: string,
) {
  const prepared = await repository.prepare(job);
  assert.equal(prepared.kind, "ready");
  if (prepared.kind !== "ready") throw new Error("Projection was not ready");
  assert.deepEqual(await markJobEffectDispatched(entitlementTestDatabase, job), { kind: "updated" });
  const observation = {
    tenant_id: job.tenantId,
    runtime_id: runtimeId,
    generation: prepared.facts.runtimeGeneration,
    exists: true as const,
    lifecycle: "running" as const,
    health: "healthy" as const,
    image_ref: imageRef,
    private_origin: `http://runtime-generation-${prepared.facts.runtimeGeneration}:8642`,
    profile_ids: prepared.facts.expectedProfileIds,
    capability_manifest_digest: prepared.facts.manifestDigest,
  };
  assert.deepEqual(await repository.complete(job, prepared.facts, observation), { kind: "completed" });
  return prepared.facts;
}

async function claimReleaseProjection(tenantId: string, releaseId: string, workerId: string, profileId?: string) {
  let query = entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .innerJoin("worker_jobs", (join) => join
      .onRef("worker_jobs.tenant_id", "=", "capability_runtime_projections.tenant_id")
      .onRef("worker_jobs.payload_ref", "=", "capability_runtime_projections.projection_id"))
    .select(["worker_jobs.job_id", "capability_runtime_projections.projection_id"])
    .where("capability_runtime_projections.tenant_id", "=", tenantId)
    .where("capability_runtime_projections.tenant_pack_release_id", "=", releaseId)
    .where("capability_runtime_projections.status", "=", "preparing");
  if (profileId !== undefined) query = query.where("capability_runtime_projections.profile_id", "=", profileId);
  const row = await query.executeTakeFirstOrThrow();
  await entitlementTestDatabase.updateTable("worker_jobs").set({
    status: "running",
    attempt_count: 1,
    lease_owner: workerId,
    lease_expires_at: new Date("2100-01-01T00:00:00.000Z"),
  }).where("tenant_id", "=", tenantId).where("job_id", "=", row.job_id).executeTakeFirstOrThrow();
  return {
    tenantId,
    jobId: row.job_id,
    workerId,
    attemptCount: 1,
    projectionId: row.projection_id,
  };
}

test("projection preparation preserves current runtime until exact inspection atomically publishes availability", async () => {
  const arranged = await arrange();
  const repository = new CapabilityProjectionRepository(entitlementTestDatabase, () => new Date(entitlementTestNow));
  const prepared = await repository.prepare(arranged.job);
  assert.equal(prepared.kind, "ready");
  if (prepared.kind !== "ready") return;
  assert.equal(prepared.facts.runtimeGeneration, 2);
  assert.equal(prepared.facts.manifest.capabilities.length, 1);
  assert.equal(prepared.facts.manifest.capabilities[0]?.kind, "mcp");
  assert.equal((await entitlementTestDatabase.selectFrom("runtime_containers").select("generation")
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow()).generation, 1);
  assert.deepEqual(await markJobEffectDispatched(entitlementTestDatabase, arranged.job), { kind: "updated" });

  const observation = {
    tenant_id: arranged.tenantId,
    runtime_id: arranged.runtimeId,
    generation: prepared.facts.runtimeGeneration,
    exists: true as const,
    lifecycle: "running" as const,
    health: "healthy" as const,
    image_ref: imageRef,
    private_origin: "http://core-agent-runtime-projection:8642",
    profile_ids: prepared.facts.expectedProfileIds,
    capability_manifest_digest: prepared.facts.manifestDigest,
  };
  const evaluatedAt = (await entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .select("evaluated_at")
    .where("tenant_id", "=", arranged.tenantId)
    .where("projection_id", "=", arranged.job.projectionId)
    .executeTakeFirstOrThrow()).evaluated_at.toISOString();
  assert.deepEqual(await repository.complete(arranged.job, prepared.facts, observation), { kind: "completed" });
  const terminal = await entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .innerJoin("runtime_containers", "runtime_containers.tenant_id", "capability_runtime_projections.tenant_id")
    .select([
      "capability_runtime_projections.status",
      "capability_runtime_projections.capability_manifest_digest",
      "runtime_containers.generation",
      "runtime_containers.capability_manifest_digest as runtime_digest",
    ])
    .where("capability_runtime_projections.projection_id", "=", arranged.job.projectionId).executeTakeFirstOrThrow();
  assert.deepEqual(terminal, {
    status: "available",
    capability_manifest_digest: prepared.facts.manifestDigest,
    generation: 2,
    runtime_digest: prepared.facts.manifestDigest,
  });
  assert.equal((await entitlementTestDatabase.selectFrom("entitlement_assignments").select("status")
    .where("assignment_id", "=", arranged.assignmentId).executeTakeFirstOrThrow()).status, "available");
  const availableEvents = await entitlementTestDatabase.selectFrom("product_events")
    .innerJoin("outbox", (join) => join
      .onRef("outbox.tenant_id", "=", "product_events.tenant_id")
      .onRef("outbox.event_id", "=", "product_events.event_id"))
    .select(["product_events.event_type", "product_events.payload", "outbox.delivery_target"])
    .where("product_events.tenant_id", "=", arranged.tenantId)
    .where("product_events.event_type", "=", "service.available")
    .execute();
  assert.deepEqual(availableEvents, [{
    event_type: "service.available",
    payload: {
      profile_id: arranged.profileId,
      generation: 2,
      entitlement_snapshot_ref: {
        snapshot_id: prepared.facts.snapshotId,
        version: prepared.facts.snapshotVersion,
        evaluated_at: evaluatedAt,
      },
      state: "available",
    },
    delivery_target: "internal_event_stream",
  }]);
  assert.equal((await loadCurrentSnapshotAuthority({
    trx: entitlementTestDatabase,
    tenantId: arranged.tenantId,
    profileId: arranged.profileId,
    now: new Date(entitlementTestNow),
  })).current, true);
});

test("projection completion after authority changes is fenced and preserves the previous runtime", async () => {
  const arranged = await arrange();
  const repository = new CapabilityProjectionRepository(entitlementTestDatabase, () => new Date(entitlementTestNow));
  const prepared = await repository.prepare(arranged.job);
  assert.equal(prepared.kind, "ready");
  if (prepared.kind !== "ready") return;
  assert.deepEqual(await markJobEffectDispatched(entitlementTestDatabase, arranged.job), { kind: "updated" });
  await entitlementTestDatabase.updateTable("entitlement_assignments").set({ status: "revoked", reason_code: "administrator_revoked" })
    .where("assignment_id", "=", arranged.assignmentId).execute();
  const observation = {
    tenant_id: arranged.tenantId,
    runtime_id: arranged.runtimeId,
    generation: prepared.facts.runtimeGeneration,
    exists: true as const,
    lifecycle: "running" as const,
    health: "healthy" as const,
    image_ref: imageRef,
    profile_ids: prepared.facts.expectedProfileIds,
    capability_manifest_digest: prepared.facts.manifestDigest,
  };
  assert.deepEqual(await repository.complete(arranged.job, prepared.facts, observation), { kind: "superseded" });
  const runtime = await entitlementTestDatabase.selectFrom("runtime_containers").select(["generation", "capability_manifest_digest"])
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow();
  assert.deepEqual(runtime, { generation: 1, capability_manifest_digest: `sha256:${"0".repeat(64)}` });
});

test("reviewed Pack upgrade and rollback each require exact proof through a new runtime generation", async () => {
  const arranged = await arrange();
  const repository = new CapabilityProjectionRepository(entitlementTestDatabase, () => new Date(entitlementTestNow));
  const initial = await runProjection(repository, arranged.job, arranged.runtimeId);
  assert.equal(initial.runtimeGeneration, 2);
  const originalPointer = (await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select("snapshot_id")
    .where("tenant_id", "=", arranged.tenantId)
    .where("profile_id", "=", arranged.profileId)
    .executeTakeFirstOrThrow()).snapshot_id;

  const upgradePack = await seedPublishedPack("projection_upgrade", ["b2b"], "2.0.0", arranged.pack.packProductId);
  const upgrade = await selectTenantPackRelease({
    ...arranged.platformDependencies,
    resolveProfileSnapshotInTransaction,
  }, arranged.platform, command({
    schema_version: 1,
    idempotency_key: "projection-upgrade-release",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    pack_version_id: upgradePack.packVersionId,
    expected_resource_version: 1,
  }) as never);
  assert.equal(upgrade.kind, "preparing");
  const upgradeReleaseId = upgrade.releaseId;
  const beforeUpgrade = await entitlementTestDatabase.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest"])
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow();
  assert.equal(beforeUpgrade.generation, 2);
  assert.equal((await entitlementTestDatabase.selectFrom("profile_snapshot_pointers").select("snapshot_id")
    .where("tenant_id", "=", arranged.tenantId).where("profile_id", "=", arranged.profileId)
    .executeTakeFirstOrThrow()).snapshot_id, originalPointer);

  const upgradeJob = await claimReleaseProjection(arranged.tenantId, upgradeReleaseId, "worker_projection_upgrade");
  const upgraded = await runProjection(repository, upgradeJob, arranged.runtimeId);
  assert.equal(upgraded.runtimeGeneration, 3);
  assert.equal(upgraded.manifest.capabilities[0]?.capability_id, upgradePack.capabilityId);
  assert.equal((await entitlementTestDatabase.selectFrom("tenant_pack_releases").select("status")
    .where("tenant_id", "=", arranged.tenantId).where("tenant_pack_release_id", "=", upgradeReleaseId)
    .executeTakeFirstOrThrow()).status, "current");
  assert.equal((await entitlementTestDatabase.selectFrom("tenant_pack_releases").select("status")
    .where("tenant_id", "=", arranged.tenantId).where("status", "=", "superseded")
    .executeTakeFirstOrThrow()).status, "superseded");

  const rollback = await selectTenantPackRelease({
    ...arranged.platformDependencies,
    resolveProfileSnapshotInTransaction,
  }, arranged.platform, command({
    schema_version: 1,
    idempotency_key: "projection-rollback-release",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    pack_version_id: arranged.pack.packVersionId,
    expected_resource_version: 2,
  }) as never);
  assert.equal(rollback.kind, "preparing");
  const rollbackJob = await claimReleaseProjection(arranged.tenantId, rollback.releaseId, "worker_projection_rollback");
  const rolledBack = await runProjection(repository, rollbackJob, arranged.runtimeId);
  assert.equal(rolledBack.runtimeGeneration, 4);
  assert.equal(rolledBack.manifest.capabilities[0]?.capability_id, arranged.pack.capabilityId);
  assert.equal((await entitlementTestDatabase.selectFrom("runtime_containers").select("generation")
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow()).generation, 4);
});

test("terminal candidate failure leaves the prior release pointer and runtime generation current", async () => {
  const arranged = await arrange();
  const repository = new CapabilityProjectionRepository(entitlementTestDatabase, () => new Date(entitlementTestNow));
  await runProjection(repository, arranged.job, arranged.runtimeId);
  const currentBefore = await entitlementTestDatabase.selectFrom("tenant_pack_releases")
    .select(["tenant_pack_release_id", "status"])
    .where("tenant_id", "=", arranged.tenantId)
    .where("status", "=", "current").executeTakeFirstOrThrow();
  const pointerBefore = await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select(["snapshot_id", "resource_version"])
    .where("tenant_id", "=", arranged.tenantId)
    .where("profile_id", "=", arranged.profileId).executeTakeFirstOrThrow();
  const candidatePack = await seedPublishedPack("projection_failure", ["b2b"], "2.0.0", arranged.pack.packProductId);
  const candidate = await selectTenantPackRelease({
    ...arranged.platformDependencies,
    resolveProfileSnapshotInTransaction,
  }, arranged.platform, command({
    schema_version: 1,
    idempotency_key: "projection-failed-release",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    pack_version_id: candidatePack.packVersionId,
    expected_resource_version: 1,
  }) as never);
  assert.equal(candidate.kind, "preparing");
  const candidateJob = await claimReleaseProjection(arranged.tenantId, candidate.releaseId, "worker_projection_failure");
  assert.equal((await repository.prepare(candidateJob)).kind, "ready");
  assert.deepEqual(await repository.fail(
    candidateJob,
    "runtime_health_check_failed",
    "Synthetic bounded Runtime health failure",
  ), { kind: "failed" });

  assert.deepEqual(await entitlementTestDatabase.selectFrom("tenant_pack_releases")
    .select(["tenant_pack_release_id", "status"])
    .where("tenant_id", "=", arranged.tenantId)
    .where("status", "in", ["current", "failed"])
    .orderBy("status", "asc").execute(), [
    { tenant_pack_release_id: currentBefore.tenant_pack_release_id, status: "current" },
    { tenant_pack_release_id: candidate.releaseId, status: "failed" },
  ]);
  assert.deepEqual(await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select(["snapshot_id", "resource_version"])
    .where("tenant_id", "=", arranged.tenantId)
    .where("profile_id", "=", arranged.profileId).executeTakeFirstOrThrow(), pointerBefore);
  assert.equal((await entitlementTestDatabase.selectFrom("runtime_containers").select("generation")
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow()).generation, 2);
  const failedProjection = await entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .select(["snapshot_id", "snapshot_version", "evaluated_at", "runtime_generation"])
    .where("tenant_id", "=", arranged.tenantId)
    .where("projection_id", "=", candidateJob.projectionId).executeTakeFirstOrThrow();
  assert.deepEqual(await entitlementTestDatabase.selectFrom("product_events")
    .innerJoin("outbox", (join) => join
      .onRef("outbox.tenant_id", "=", "product_events.tenant_id")
      .onRef("outbox.event_id", "=", "product_events.event_id"))
    .select(["product_events.payload", "outbox.delivery_target"])
    .where("product_events.tenant_id", "=", arranged.tenantId)
    .where("product_events.event_type", "=", "service.failed").execute(), [{
    payload: {
      profile_id: arranged.profileId,
      generation: Number(failedProjection.runtime_generation),
      entitlement_snapshot_ref: {
        snapshot_id: failedProjection.snapshot_id,
        version: Number(failedProjection.snapshot_version),
        evaluated_at: failedProjection.evaluated_at.toISOString(),
      },
      state: "failed",
      reason_code: "runtime_health_check_failed",
    },
    delivery_target: "internal_event_stream",
  }]);
});

test("all affected B2B Profile projections must be proven before one release and every pointer become current", async () => {
  const arranged = await arrange(2);
  const repository = new CapabilityProjectionRepository(entitlementTestDatabase, () => new Date(entitlementTestNow));
  const candidatePack = await seedPublishedPack("projection_multi_profile", ["b2b"], "2.0.0", arranged.pack.packProductId);
  const candidate = await selectTenantPackRelease({
    ...arranged.platformDependencies,
    resolveProfileSnapshotInTransaction,
  }, arranged.platform, command({
    schema_version: 1,
    idempotency_key: "projection-multi-profile-release",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    pack_version_id: candidatePack.packVersionId,
    expected_resource_version: 1,
  }) as never);
  assert.equal(candidate.kind, "preparing");

  const firstJob = await claimReleaseProjection(
    arranged.tenantId,
    candidate.releaseId,
    "worker_projection_multi_1",
    arranged.profileIds[0],
  );
  const first = await runProjection(repository, firstJob, arranged.runtimeId);
  assert.equal((await entitlementTestDatabase.selectFrom("tenant_pack_releases").select("status")
    .where("tenant_id", "=", arranged.tenantId).where("tenant_pack_release_id", "=", candidate.releaseId)
    .executeTakeFirstOrThrow()).status, "preparing");

  const secondJob = await claimReleaseProjection(
    arranged.tenantId,
    candidate.releaseId,
    "worker_projection_multi_2",
    arranged.profileIds[1],
  );
  const second = await runProjection(repository, secondJob, arranged.runtimeId);
  assert(second.runtimeGeneration > first.runtimeGeneration);
  assert.equal((await entitlementTestDatabase.selectFrom("tenant_pack_releases").select("status")
    .where("tenant_id", "=", arranged.tenantId).where("tenant_pack_release_id", "=", candidate.releaseId)
    .executeTakeFirstOrThrow()).status, "current");
  const pointers = await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select(["profile_id", "snapshot_id"]).where("tenant_id", "=", arranged.tenantId)
    .where("profile_id", "in", [...arranged.profileIds]).orderBy("profile_id", "asc").execute();
  const candidateSnapshots = await entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .select(["profile_id", "snapshot_id", "status"])
    .where("tenant_id", "=", arranged.tenantId)
    .where("tenant_pack_release_id", "=", candidate.releaseId)
    .orderBy("profile_id", "asc").execute();
  assert.deepEqual(pointers, candidateSnapshots.map(({ profile_id, snapshot_id }) => ({ profile_id, snapshot_id })));
  assert.deepEqual(candidateSnapshots.map(({ status }) => status), ["available", "available"]);
  for (const profile of arranged.profileIds) {
    assert.equal((await loadCurrentSnapshotAuthority({
      trx: entitlementTestDatabase,
      tenantId: arranged.tenantId,
      profileId: profile,
      now: new Date(entitlementTestNow),
    })).current, true);
  }
});

test("one failed B2B Profile projection fails the whole candidate and preserves the previous Runtime and pointers", async () => {
  const arranged = await arrange(2);
  const repository = new CapabilityProjectionRepository(entitlementTestDatabase, () => new Date(entitlementTestNow));
  const runtimeBefore = await entitlementTestDatabase.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest"])
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow();
  const pointersBefore = await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select(["profile_id", "snapshot_id", "resource_version"])
    .where("tenant_id", "=", arranged.tenantId).orderBy("profile_id", "asc").execute();
  const candidatePack = await seedPublishedPack("projection_multi_failure", ["b2b"], "2.0.0", arranged.pack.packProductId);
  const candidate = await selectTenantPackRelease({
    ...arranged.platformDependencies,
    resolveProfileSnapshotInTransaction,
  }, arranged.platform, command({
    schema_version: 1,
    idempotency_key: "projection-multi-profile-failure-release",
    tenant_id: arranged.tenantId,
    pack_product_id: arranged.pack.packProductId,
    pack_version_id: candidatePack.packVersionId,
    expected_resource_version: 1,
  }) as never);
  const firstJob = await claimReleaseProjection(
    arranged.tenantId,
    candidate.releaseId,
    "worker_projection_multi_failure_1",
    arranged.profileIds[0],
  );
  await runProjection(repository, firstJob, arranged.runtimeId);
  assert.deepEqual(await entitlementTestDatabase.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest"])
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow(), runtimeBefore);

  const secondJob = await claimReleaseProjection(
    arranged.tenantId,
    candidate.releaseId,
    "worker_projection_multi_failure_2",
    arranged.profileIds[1],
  );
  assert.equal((await repository.prepare(secondJob)).kind, "ready");
  assert.deepEqual(await repository.fail(
    secondJob,
    "runtime_health_check_failed",
    "Synthetic second Profile health failure",
  ), { kind: "failed" });
  assert.equal((await entitlementTestDatabase.selectFrom("tenant_pack_releases").select("status")
    .where("tenant_id", "=", arranged.tenantId).where("tenant_pack_release_id", "=", candidate.releaseId)
    .executeTakeFirstOrThrow()).status, "failed");
  assert.deepEqual(await entitlementTestDatabase.selectFrom("capability_runtime_projections")
    .select("status").where("tenant_id", "=", arranged.tenantId)
    .where("tenant_pack_release_id", "=", candidate.releaseId).orderBy("profile_id", "asc").execute(), [
    { status: "failed" },
    { status: "failed" },
  ]);
  assert.deepEqual(await entitlementTestDatabase.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest"])
    .where("tenant_id", "=", arranged.tenantId).executeTakeFirstOrThrow(), runtimeBefore);
  assert.deepEqual(await entitlementTestDatabase.selectFrom("profile_snapshot_pointers")
    .select(["profile_id", "snapshot_id", "resource_version"])
    .where("tenant_id", "=", arranged.tenantId).orderBy("profile_id", "asc").execute(), pointersBefore);
});
