#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  assignPackSeat,
  canonicalPayloadHash,
  changeEntitlementStatus,
  commandRuntime,
  createCapabilityVersion,
  createPackVersion,
  createRuntimeDatabase,
  databaseConnectionOptions,
  deriveRuntimeContainerId,
  DomainError,
  enqueueIdleB2cRuntimeStopJobs,
  ensureRuntimeWakeIntent,
  grantEntitlement,
  issueCoreSession,
  publishPackVersion,
  readProtectedDatabasePassword,
  requireCurrentSnapshotAuthority,
  resolveProfileSnapshotInTransaction,
  reviewCapabilityVersion,
  reviewPackVersion,
  selectTenantPackRelease,
} from "@core-agent/runtime-core";
import { sql } from "kysely";
import { Pool } from "pg";

const tenantPattern = /^synthetic-capability-acceptance-[a-z0-9][a-z0-9-]{0,63}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const contractRef = "acceptance/capability@1.0.0";
const maximumWaitMs = 5 * 60 * 1_000;

class LocalAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "LocalAcceptanceError";
    this.code = code;
  }
}

function fail(code = "CAPABILITY_ACCEPTANCE_LOCAL_SCENARIO_FAILED") {
  throw new LocalAcceptanceError(code);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) fail("CAPABILITY_ACCEPTANCE_LOCAL_CONFIGURATION_INVALID");
  return value;
}

function suffix(value) {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function ids(tenantId) {
  const marker = suffix(tenantId);
  return Object.freeze({
    marker,
    actorId: `synthetic-capability-actor-${marker}`,
    membershipId: `synthetic-capability-member-${marker}`,
    profileId: `synthetic-capability-profile-${marker}`,
    platformTenantId: `synthetic-capability-platform-${marker}`,
    platformActorId: `synthetic-capability-platform-actor-${marker}`,
    platformMembershipId: `synthetic-capability-platform-member-${marker}`,
    platformAuthSubjectId: `synthetic-capability-platform-auth-${marker}`,
    platformSessionId: `synthetic-capability-platform-session-${marker}`,
    companyAuthSubjectId: `synthetic-capability-company-auth-${marker}`,
    companySessionId: `synthetic-capability-company-session-${marker}`,
    capabilityId: `capability_acceptance_${marker}`,
    capabilityVersionV1Id: `capability_version_acceptance_v1_${marker}`,
    capabilityVersionV2Id: `capability_version_acceptance_v2_${marker}`,
    packProductId: `pack_acceptance_${marker}`,
    packVersionV1Id: `pack_version_acceptance_v1_${marker}`,
    packVersionV2Id: `pack_version_acceptance_v2_${marker}`,
    b2cTenantId: `synthetic-capability-acceptance-b2c-${marker}`,
    b2cActorId: `synthetic-capability-b2c-actor-${marker}`,
    b2cMembershipId: `synthetic-capability-b2c-member-${marker}`,
    b2cProfileId: `synthetic-capability-b2c-profile-${marker}`,
    b2cCapabilityId: `capability_acceptance_b2c_${marker}`,
    b2cCapabilityVersionId: `capability_version_acceptance_b2c_${marker}`,
    b2cPackProductId: `pack_acceptance_b2c_${marker}`,
    b2cPackVersionId: `pack_version_acceptance_b2c_${marker}`,
  });
}

function protectedCommand(facts) {
  return Object.freeze({ ...facts, payload_hash: canonicalPayloadHash(facts) });
}

async function waitFor(load, accepted) {
  const deadline = Date.now() + maximumWaitMs;
  for (;;) {
    const value = await load();
    if (accepted(value)) return value;
    if (Date.now() >= deadline) fail("CAPABILITY_ACCEPTANCE_LOCAL_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function connect(environment) {
  const applicationPassword = await readProtectedDatabasePassword(required(
    environment,
    "CORE_AGENT_ACCEPTANCE_APPLICATION_DATABASE_PASSWORD_FILE",
  ));
  const identityPassword = await readProtectedDatabasePassword(required(
    environment,
    "CORE_AGENT_ACCEPTANCE_IDENTITY_DATABASE_PASSWORD_FILE",
  ));
  const applicationPool = new Pool(databaseConnectionOptions(
    required(environment, "CORE_AGENT_ACCEPTANCE_APPLICATION_DATABASE_URL"),
    applicationPassword,
  ));
  const identityPool = new Pool(databaseConnectionOptions(
    required(environment, "CORE_AGENT_ACCEPTANCE_IDENTITY_DATABASE_URL"),
    identityPassword,
  ));
  return Object.freeze({
    applicationDb: createRuntimeDatabase(applicationPool),
    identityDb: createRuntimeDatabase(identityPool),
    async close() {
      await Promise.allSettled([applicationPool.end(), identityPool.end()]);
    },
  });
}

function catalogDependencies(db, platformTenantId) {
  return Object.freeze({
    db,
    knownContractRefs: [contractRef],
    platformCompatibility: {
      core_contract_version: "0.8.0",
      runtime_protocol_version: "1.0.0",
    },
    catalogAuthorityTenantId: platformTenantId,
  });
}

async function createAuthorities(db, tenantId, identifiers) {
  const now = new Date();
  const [tenant, profile, membership] = await Promise.all([
    db.selectFrom("tenants").select(["tenant_mode", "status"])
      .where("tenant_id", "=", tenantId).executeTakeFirst(),
    db.selectFrom("profiles").select(["owner_actor_id", "provider_config_id", "model_id"])
      .where("tenant_id", "=", tenantId).where("profile_id", "=", identifiers.profileId).executeTakeFirst(),
    db.selectFrom("memberships").select(["actor_id", "status"])
      .where("tenant_id", "=", tenantId).where("membership_id", "=", identifiers.membershipId).executeTakeFirst(),
  ]);
  if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active"
    || profile?.owner_actor_id !== identifiers.actorId
    || membership?.actor_id !== identifiers.actorId || membership.status !== "active") fail();
  const collision = await db.selectFrom("tenants").select("tenant_id")
    .where("tenant_id", "in", [identifiers.platformTenantId, identifiers.b2cTenantId]).executeTakeFirst();
  if (collision !== undefined) fail("CAPABILITY_ACCEPTANCE_SYNTHETIC_TENANT_NOT_DISPOSABLE");

  await db.updateTable("memberships").set({ roles: ["admin", "consultant"], updated_at: now })
    .where("tenant_id", "=", tenantId).where("membership_id", "=", identifiers.membershipId).execute();
  await db.insertInto("tenants").values({
    tenant_id: identifiers.platformTenantId, schema_version: 1, resource_version: 1,
    tenant_mode: "b2b", status: "active", display_name: "Synthetic capability authority",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("actors").values({
    actor_id: identifiers.platformActorId, schema_version: 1, resource_version: 1,
    actor_kind: "human", display_name: "Synthetic platform administrator", status: "active",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("auth_subjects").values([{
    auth_subject_id: identifiers.platformAuthSubjectId, actor_id: identifiers.platformActorId,
    provider: "supabase", provider_subject: `synthetic-provider-platform-${identifiers.marker}`,
    provider_identity_kind: "email_password", verified_at: now, status: "active",
    resource_version: 1, created_at: now, updated_at: now,
  }, {
    auth_subject_id: identifiers.companyAuthSubjectId, actor_id: identifiers.actorId,
    provider: "supabase", provider_subject: `synthetic-provider-company-${identifiers.marker}`,
    provider_identity_kind: "email_password", verified_at: now, status: "active",
    resource_version: 1, created_at: now, updated_at: now,
  }]).execute();
  await db.insertInto("memberships").values({
    tenant_id: identifiers.platformTenantId, membership_id: identifiers.platformMembershipId,
    actor_id: identifiers.platformActorId, schema_version: 1, resource_version: 1,
    roles: ["admin"], membership_source: "platform", seat_ref: null, status: "active",
    created_at: now, updated_at: now,
  }).execute();
  await db.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: `synthetic-capability-role-${identifiers.marker}`,
    actor_id: identifiers.platformActorId, role: "platform_super_admin", status: "active",
    resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await issueCoreSession({ db }, {
    sessionId: identifiers.platformSessionId,
    actorId: identifiers.platformActorId,
    authSubjectId: identifiers.platformAuthSubjectId,
    clientKind: "web",
  });
  await issueCoreSession({ db }, {
    sessionId: identifiers.companySessionId,
    actorId: identifiers.actorId,
    authSubjectId: identifiers.companyAuthSubjectId,
    clientKind: "web",
  });
  await db.updateTable("core_sessions").set({ reauthenticated_at: now, updated_at: now })
    .where("session_id", "in", [identifiers.platformSessionId, identifiers.companySessionId]).execute();
  return Object.freeze({ providerConfigId: profile.provider_config_id, modelId: profile.model_id });
}

function contexts(identifiers) {
  return Object.freeze({
    platform: Object.freeze({
      performingActorId: identifiers.platformActorId,
      performingAuthSubjectId: identifiers.platformAuthSubjectId,
      performingSessionId: identifiers.platformSessionId,
      requestId: `synthetic-capability-platform-request-${identifiers.marker}`,
      traceId: `synthetic-capability-platform-trace-${identifiers.marker}`,
    }),
    company: Object.freeze({
      performingActorId: identifiers.actorId,
      performingAuthSubjectId: identifiers.companyAuthSubjectId,
      performingSessionId: identifiers.companySessionId,
      requestId: `synthetic-capability-company-request-${identifiers.marker}`,
      traceId: `synthetic-capability-company-trace-${identifiers.marker}`,
    }),
  });
}

async function createReviewedCapability(db, identifiers, context, input) {
  const dependencies = catalogDependencies(db, identifiers.platformTenantId);
  await createCapabilityVersion(dependencies, context, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-capability-create-${input.label}-${identifiers.marker}`,
    capability_id: input.capabilityId,
    capability_version_id: input.capabilityVersionId,
    display_name: input.displayName,
    owning_domain: "acceptance",
    kind: "mcp",
    version: input.version,
    artifact_ref: `manifest:sha256:${createHash("sha256").update(input.capabilityVersionId).digest("hex")}`,
    contract_ref: contractRef,
    risk_class: "read",
    approval_requirement: "none",
    compatibility: {
      core_contract_version: "0.8.0",
      domain_contract_version: "1.0.0",
      runtime_protocol_version: "1.0.0",
      tenant_modes: [input.tenantMode],
    },
    expected_resource_version: null,
  }));
  await reviewCapabilityVersion(dependencies, context, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-capability-review-${input.label}-${identifiers.marker}`,
    capability_version_id: input.capabilityVersionId,
    expected_resource_version: 1,
  }));
}

async function createPublishedPack(db, identifiers, context, input) {
  const dependencies = catalogDependencies(db, identifiers.platformTenantId);
  await createPackVersion(dependencies, context, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-pack-create-${input.label}-${identifiers.marker}`,
    pack_product_id: input.packProductId,
    pack_version_id: input.packVersionId,
    display_name: input.displayName,
    tenant_modes: [input.tenantMode],
    version: input.version,
    expected_resource_version: null,
    members: [{
      capability_id: input.capabilityId,
      capability_version_id: input.capabilityVersionId,
      version: input.version,
    }],
  }));
  await reviewPackVersion(dependencies, context, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-pack-review-${input.label}-${identifiers.marker}`,
    pack_version_id: input.packVersionId,
    expected_resource_version: 1,
  }));
  await publishPackVersion(dependencies, context, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-pack-publish-${input.label}-${identifiers.marker}`,
    pack_version_id: input.packVersionId,
    expected_resource_version: 2,
  }));
}

async function waitForProjection(db, tenantId, profileId, releaseId) {
  const projection = await waitFor(
    () => {
      let query = db.selectFrom("capability_runtime_projections")
        .select(["runtime_generation", "capability_manifest_digest", "snapshot_id", "status"])
        .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId);
      if (releaseId !== undefined) query = query.where("tenant_pack_release_id", "=", releaseId);
      return query.orderBy("runtime_generation", "desc").executeTakeFirst();
    },
    (row) => row?.status === "available" && digestPattern.test(row.capability_manifest_digest),
  );
  const generation = Number(projection.runtime_generation);
  if (!Number.isSafeInteger(generation) || generation < 1) fail();
  const runtime = await db.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest", "observed_state", "health_status"])
    .where("tenant_id", "=", tenantId).where("container_id", "=", deriveRuntimeContainerId(tenantId))
    .executeTakeFirst();
  if (runtime?.generation !== generation || runtime.capability_manifest_digest !== projection.capability_manifest_digest
    || runtime.observed_state !== "ready" || runtime.health_status !== "healthy") fail();
  const capabilities = await db.selectFrom("entitlement_snapshot_capabilities")
    .innerJoin("capability_versions", (join) => join
      .onRef("capability_versions.capability_id", "=", "entitlement_snapshot_capabilities.capability_id")
      .onRef("capability_versions.capability_version_id", "=", "entitlement_snapshot_capabilities.capability_version_id")
      .onRef("capability_versions.version", "=", "entitlement_snapshot_capabilities.version"))
    .select([
      "entitlement_snapshot_capabilities.capability_id",
      "entitlement_snapshot_capabilities.capability_version_id",
      "entitlement_snapshot_capabilities.version",
      "capability_versions.kind",
    ])
    .where("entitlement_snapshot_capabilities.tenant_id", "=", tenantId)
    .where("entitlement_snapshot_capabilities.profile_id", "=", profileId)
    .where("entitlement_snapshot_capabilities.snapshot_id", "=", projection.snapshot_id)
    .orderBy("entitlement_snapshot_capabilities.capability_order", "asc")
    .execute();
  if (capabilities.length === 0) fail();
  const capabilitySetHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(capabilities), "utf8").digest("hex")}`;
  return Object.freeze({ generation, digest: projection.capability_manifest_digest, capabilitySetHash });
}

async function initialB2b(identityDb, applicationDb, tenantId, identifiers, authority, context) {
  await createReviewedCapability(identityDb, identifiers, context.platform, {
    label: "b2b-v1", tenantMode: "b2b", displayName: "Synthetic read capability",
    capabilityId: identifiers.capabilityId, capabilityVersionId: identifiers.capabilityVersionV1Id,
    version: "1.0.0",
  });
  await createPublishedPack(identityDb, identifiers, context.platform, {
    label: "b2b-v1", tenantMode: "b2b", displayName: "Synthetic capability service",
    packProductId: identifiers.packProductId, packVersionId: identifiers.packVersionV1Id,
    capabilityId: identifiers.capabilityId, capabilityVersionId: identifiers.capabilityVersionV1Id,
    version: "1.0.0",
  });
  const entitlementDependencies = { db: identityDb, platformAuthorityTenantId: identifiers.platformTenantId };
  const release = await selectTenantPackRelease(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-release-b2b-v1-${identifiers.marker}`,
    tenant_id: tenantId,
    pack_product_id: identifiers.packProductId,
    pack_version_id: identifiers.packVersionV1Id,
    expected_resource_version: 1,
  }));
  if (release.kind !== "current") fail();
  const entitlement = await grantEntitlement(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-grant-b2b-${identifiers.marker}`,
    tenant_id: tenantId,
    pack_product_id: identifiers.packProductId,
    source: "platform_manual",
    external_order_ref: `synthetic-order-b2b-${identifiers.marker}`,
    expected_resource_version: 1,
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: 1,
  }));
  const assignment = await assignPackSeat({
    db: identityDb,
    platformAuthorityTenantId: identifiers.platformTenantId,
    authorityTenantId: tenantId,
    resolveProfileSnapshotInTransaction,
  }, context.company, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-seat-b2b-${identifiers.marker}`,
    entitlement_id: entitlement.entitlement_id,
    expected_resource_version: 1,
    profile_id: identifiers.profileId,
  }));
  if (assignment.status !== "preparing") fail();
  const available = await waitForProjection(applicationDb, tenantId, identifiers.profileId);
  await waitFor(
    () => identityDb.selectFrom("entitlement_assignments").select("status")
      .where("assignment_id", "=", assignment.assignment_id).executeTakeFirst(),
    (row) => row?.status === "available",
  );
  return Object.freeze({ entitlement, available, grantState: assignment.status });
}

async function revokeAndRollback(identityDb, applicationDb, tenantId, identifiers, context, initial) {
  const entitlementDependencies = { db: identityDb, platformAuthorityTenantId: identifiers.platformTenantId };
  const current = await identityDb.selectFrom("entitlements").select("resource_version")
    .where("entitlement_id", "=", initial.entitlement.entitlement_id).executeTakeFirstOrThrow();
  const suspended = await changeEntitlementStatus(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-suspend-b2b-${identifiers.marker}`,
    entitlement_id: initial.entitlement.entitlement_id,
    expected_resource_version: Number(current.resource_version),
    status: "suspended",
    reason_code: "administrator_suspended",
  }));
  let denied = false;
  try {
    await requireCurrentSnapshotAuthority({ db: applicationDb, tenantId, profileId: identifiers.profileId });
  } catch (error) {
    denied = error instanceof DomainError && error.code === "ENTITLEMENT_DENIED";
  }
  if (!denied) fail();
  const reactivated = await changeEntitlementStatus(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-reactivate-b2b-${identifiers.marker}`,
    entitlement_id: initial.entitlement.entitlement_id,
    expected_resource_version: suspended.resource_version,
    status: "active",
    reason_code: "administrator_reactivated",
  }));
  if (reactivated.status !== "active") fail();

  await createReviewedCapability(identityDb, identifiers, context.platform, {
    label: "b2b-v2", tenantMode: "b2b", displayName: "Synthetic read capability",
    capabilityId: identifiers.capabilityId, capabilityVersionId: identifiers.capabilityVersionV2Id,
    version: "2.0.0",
  });
  await createPublishedPack(identityDb, identifiers, context.platform, {
    label: "b2b-v2", tenantMode: "b2b", displayName: "Synthetic capability service",
    packProductId: identifiers.packProductId, packVersionId: identifiers.packVersionV2Id,
    capabilityId: identifiers.capabilityId, capabilityVersionId: identifiers.capabilityVersionV2Id,
    version: "2.0.0",
  });
  const currentRelease = await identityDb.selectFrom("tenant_pack_releases").select("resource_version")
    .where("tenant_id", "=", tenantId).where("pack_product_id", "=", identifiers.packProductId)
    .where("status", "=", "current").executeTakeFirstOrThrow();
  const upgrade = await selectTenantPackRelease(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-release-b2b-v2-${identifiers.marker}`,
    tenant_id: tenantId,
    pack_product_id: identifiers.packProductId,
    pack_version_id: identifiers.packVersionV2Id,
    expected_resource_version: Number(currentRelease.resource_version),
  }));
  if (upgrade.kind !== "preparing") fail();
  await waitFor(
    () => identityDb.selectFrom("tenant_pack_releases").select("status")
      .where("tenant_pack_release_id", "=", upgrade.releaseId).executeTakeFirst(),
    (row) => row?.status === "current",
  );
  const upgraded = await waitForProjection(applicationDb, tenantId, identifiers.profileId, upgrade.releaseId);
  const upgradedCurrent = await identityDb.selectFrom("tenant_pack_releases").select("resource_version")
    .where("tenant_pack_release_id", "=", upgrade.releaseId).executeTakeFirstOrThrow();
  const rollback = await selectTenantPackRelease(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-release-b2b-rollback-${identifiers.marker}`,
    tenant_id: tenantId,
    pack_product_id: identifiers.packProductId,
    pack_version_id: identifiers.packVersionV1Id,
    expected_resource_version: Number(upgradedCurrent.resource_version),
  }));
  if (rollback.kind !== "preparing") fail();
  await waitFor(
    () => identityDb.selectFrom("tenant_pack_releases").select("status")
      .where("tenant_pack_release_id", "=", rollback.releaseId).executeTakeFirst(),
    (row) => row?.status === "current",
  );
  const rolledBack = await waitForProjection(applicationDb, tenantId, identifiers.profileId, rollback.releaseId);
  if (upgraded.generation <= initial.available.generation || rolledBack.generation <= upgraded.generation
    || upgraded.digest === initial.available.digest || rolledBack.digest === initial.available.digest
    || upgraded.capabilitySetHash === initial.available.capabilitySetHash
    || rolledBack.capabilitySetHash !== initial.available.capabilitySetHash) fail();
  return Object.freeze({
    revoked: Object.freeze({ state: suspended.status, newAdmissionDenied: denied }),
    rolledBack: Object.freeze({ state: "available", ...rolledBack }),
  });
}

async function b2cIdleLifecycle(identityDb, applicationDb, identifiers, authority, context) {
  const now = new Date();
  await identityDb.insertInto("tenants").values({
    tenant_id: identifiers.b2cTenantId, schema_version: 1, resource_version: 1,
    tenant_mode: "b2c", status: "active", display_name: "Synthetic B2C acceptance",
    created_at: now, updated_at: now,
  }).execute();
  await identityDb.insertInto("actors").values({
    actor_id: identifiers.b2cActorId, schema_version: 1, resource_version: 1,
    actor_kind: "human", display_name: "Synthetic B2C actor", status: "active",
    created_at: now, updated_at: now,
  }).execute();
  await identityDb.insertInto("memberships").values({
    tenant_id: identifiers.b2cTenantId, membership_id: identifiers.b2cMembershipId,
    actor_id: identifiers.b2cActorId, schema_version: 1, resource_version: 1,
    roles: ["student"], membership_source: "self", seat_ref: null, status: "active",
    created_at: now, updated_at: now,
  }).execute();
  await identityDb.insertInto("profiles").values({
    tenant_id: identifiers.b2cTenantId, profile_id: identifiers.b2cProfileId,
    schema_version: 1, resource_version: 1, owner_actor_id: identifiers.b2cActorId,
    profile_kind: "default", hermes_profile_ref: identifiers.b2cProfileId,
    description: "Synthetic B2C acceptance profile", status: "active",
    provider_config_id: authority.providerConfigId, model_id: authority.modelId,
    created_at: now, updated_at: now,
  }).execute();
  await createReviewedCapability(identityDb, identifiers, context.platform, {
    label: "b2c-v1", tenantMode: "b2c", displayName: "Synthetic B2C read capability",
    capabilityId: identifiers.b2cCapabilityId,
    capabilityVersionId: identifiers.b2cCapabilityVersionId,
    version: "1.0.0",
  });
  await createPublishedPack(identityDb, identifiers, context.platform, {
    label: "b2c-v1", tenantMode: "b2c", displayName: "Synthetic B2C service",
    packProductId: identifiers.b2cPackProductId,
    packVersionId: identifiers.b2cPackVersionId,
    capabilityId: identifiers.b2cCapabilityId,
    capabilityVersionId: identifiers.b2cCapabilityVersionId,
    version: "1.0.0",
  });
  const entitlementDependencies = { db: identityDb, platformAuthorityTenantId: identifiers.platformTenantId };
  const release = await selectTenantPackRelease(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-release-b2c-${identifiers.marker}`,
    tenant_id: identifiers.b2cTenantId,
    pack_product_id: identifiers.b2cPackProductId,
    pack_version_id: identifiers.b2cPackVersionId,
    expected_resource_version: 1,
  }));
  if (release.kind !== "current") fail();
  await grantEntitlement(entitlementDependencies, context.platform, protectedCommand({
    schema_version: 1,
    idempotency_key: `synthetic-grant-b2c-${identifiers.marker}`,
    tenant_id: identifiers.b2cTenantId,
    pack_product_id: identifiers.b2cPackProductId,
    source: "platform_manual",
    external_order_ref: `synthetic-order-b2c-${identifiers.marker}`,
    expected_resource_version: 1,
    tenant_mode: "b2c",
    assignment_mode: "automatic",
  }));
  const available = await waitForProjection(
    applicationDb,
    identifiers.b2cTenantId,
    identifiers.b2cProfileId,
  );
  const before = await applicationDb.selectFrom("runtime_containers")
    .select(["volume_ref", "generation", "capability_manifest_digest"])
    .where("tenant_id", "=", identifiers.b2cTenantId).executeTakeFirstOrThrow();
  await applicationDb.updateTable("runtime_activity").set({
    last_work_at: sql`clock_timestamp() - interval '31 minutes'`,
  }).where("tenant_id", "=", identifiers.b2cTenantId).execute();
  if (await enqueueIdleB2cRuntimeStopJobs(applicationDb, 1) !== 1) fail();
  await waitFor(
    () => applicationDb.selectFrom("runtime_containers")
      .select(["desired_state", "observed_state"])
      .where("tenant_id", "=", identifiers.b2cTenantId).executeTakeFirst(),
    (row) => row?.desired_state === "stopped" && row.observed_state === "stopped",
  );
  const wake = () => applicationDb.transaction().execute((trx) => ensureRuntimeWakeIntent(trx, {
    tenantId: identifiers.b2cTenantId,
    runtimeId: deriveRuntimeContainerId(identifiers.b2cTenantId),
  }));
  const firstWake = await wake();
  const secondWake = await wake();
  if (!new Set(["preparing", "ready"]).has(firstWake) || !new Set(["preparing", "ready"]).has(secondWake)) fail();
  const startJobs = await applicationDb.selectFrom("worker_jobs").select("job_id")
    .where("tenant_id", "=", identifiers.b2cTenantId)
    .where("job_kind", "=", "reconcile_runtime").where("runtime_command", "=", "start").execute();
  if (startJobs.length !== 1) fail();
  await waitFor(
    () => applicationDb.selectFrom("runtime_containers")
      .select(["desired_state", "observed_state", "health_status", "volume_ref", "generation", "capability_manifest_digest"])
      .where("tenant_id", "=", identifiers.b2cTenantId).executeTakeFirst(),
    (row) => row?.desired_state === "running" && row.observed_state === "ready" && row.health_status === "healthy",
  );
  const after = await applicationDb.selectFrom("runtime_containers")
    .select(["volume_ref", "generation", "capability_manifest_digest"])
    .where("tenant_id", "=", identifiers.b2cTenantId).executeTakeFirstOrThrow();
  if (after.volume_ref !== before.volume_ref || after.generation !== before.generation
    || after.capability_manifest_digest !== before.capability_manifest_digest
    || after.generation !== available.generation) fail();
  return Object.freeze({ stopped: true, woke: true, volumePreserved: true, generation: after.generation });
}

async function runScenario(connections, tenantId) {
  const identifiers = ids(tenantId);
  const authority = await createAuthorities(connections.identityDb, tenantId, identifiers);
  const context = contexts(identifiers);
  const initial = await initialB2b(
    connections.identityDb,
    connections.applicationDb,
    tenantId,
    identifiers,
    authority,
    context,
  );
  const idle = await b2cIdleLifecycle(
    connections.identityDb,
    connections.applicationDb,
    identifiers,
    authority,
    context,
  );
  const lifecycle = await revokeAndRollback(
    connections.identityDb,
    connections.applicationDb,
    tenantId,
    identifiers,
    context,
    initial,
  );
  return Object.freeze({
    prepared: Object.freeze({ tenantId, ...initial.available }),
    granted: Object.freeze({ state: initial.grantState }),
    available: Object.freeze({
      state: "available",
      generation: initial.available.generation,
      digest: initial.available.digest,
    }),
    revoked: lifecycle.revoked,
    idle,
    rolledBack: lifecycle.rolledBack,
  });
}

async function cleanupB2c(connections, tenantId) {
  const identifiers = ids(tenantId);
  const runtime = await connections.applicationDb.selectFrom("runtime_containers")
    .select(["resource_version", "desired_state", "observed_state"])
    .where("tenant_id", "=", identifiers.b2cTenantId).executeTakeFirst();
  if (runtime !== undefined && runtime.desired_state !== "deleted" && runtime.observed_state !== "deleted") {
    await commandRuntime({ db: connections.applicationDb }, {
      tenantId: identifiers.b2cTenantId,
      actorId: identifiers.b2cActorId,
      membershipId: identifiers.b2cMembershipId,
      effectiveRole: "student",
      requestId: `synthetic-capability-cleanup-request-${identifiers.marker}`,
      traceId: `synthetic-capability-cleanup-trace-${identifiers.marker}`,
    }, protectedCommand({
      schema_version: 1,
      idempotency_key: `synthetic-capability-delete-b2c-${identifiers.marker}`,
      expected_resource_version: Number(runtime.resource_version),
      command: "delete",
    }));
    await waitFor(
      () => connections.applicationDb.selectFrom("runtime_containers")
        .select("observed_state").where("tenant_id", "=", identifiers.b2cTenantId).executeTakeFirst(),
      (row) => row?.observed_state === "deleted",
    );
  }
  return Object.freeze({ state: "removed" });
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  if (!Array.isArray(argv) || argv.length !== 2 || !new Set(["run", "cleanup"]).has(argv[0])
    || typeof argv[1] !== "string" || !tenantPattern.test(argv[1])) {
    fail("CAPABILITY_ACCEPTANCE_LOCAL_ARGUMENT_INVALID");
  }
  const connections = await connect(environment);
  try {
    const result = argv[0] === "run"
      ? await runScenario(connections, argv[1])
      : await cleanupB2c(connections, argv[1]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await connections.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof LocalAcceptanceError ? error.code : "CAPABILITY_ACCEPTANCE_LOCAL_SCENARIO_FAILED"}\n`);
    process.exitCode = 1;
  }
}
