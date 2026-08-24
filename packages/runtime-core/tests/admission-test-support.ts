import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import type { Kysely } from "kysely";
import type { Pool } from "pg";

import {
  applyMigrations,
  canonicalPayloadHash,
  deriveRuntimeContainerId,
  loadProviderCatalog,
  resolveProfileSnapshotInTransaction,
  type RuntimeDatabase,
} from "../src/index.js";

export const admissionNow = new Date("2026-08-05T01:00:00.000Z");
export const providerCatalog = loadProviderCatalog([{
  provider_config_id: "provider_admission",
  base_url: "https://provider.example/v1",
  model_ids: ["model_admission"],
  credential_secret_ref: "provider_secret_admission",
  timeout_ms: 10_000,
  max_safe_retries: 2,
}]);

export const migrationsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export const serviceContext = (tenantId: string) => ({
  tenantId,
  requestId: `request_${tenantId}`,
  traceId: `trace_${tenantId}`,
  actorId: "core_agent_provisioner" as const,
  membershipId: "core_agent_provisioner_admin" as const,
  effectiveRole: "admin" as const,
});

export function withPayloadHash<T extends Record<string, unknown>>(payload: T): T & { payload_hash: string } {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

export async function resetAdmissionDatabase(pool: Pool): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
}

export interface ReadyTenantOptions {
  readonly tenantStatus?: "active" | "suspended";
  readonly profileStatus?: "active" | "suspended";
  readonly runtimeDesiredState?: "running" | "stopped";
  readonly runtimeObservedState?: "ready" | "stopped" | "failed";
  readonly runtimeHealthStatus?: "healthy" | "unknown" | "unhealthy";
}

export async function seedReadyTenant(
  db: Kysely<RuntimeDatabase>,
  tenantId: string,
  options: ReadyTenantOptions = {},
): Promise<{ profileId: string; runtimeId: string }> {
  const profileId = `profile_${tenantId}`;
  const ownerId = `owner_${tenantId}`;
  const runtimeId = deriveRuntimeContainerId(tenantId);
  await db.insertInto("tenants").values({
    tenant_id: tenantId,
    schema_version: 1,
    resource_version: 1,
    tenant_mode: "b2c",
    status: "active",
    display_name: `Tenant ${tenantId}`,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.insertInto("actors").values([{
    actor_id: ownerId,
    schema_version: 1,
    resource_version: 1,
    actor_kind: "human",
    display_name: "Student owner",
    status: "active",
    created_at: admissionNow,
    updated_at: admissionNow,
  }, {
    actor_id: "core_agent_provisioner",
    schema_version: 1,
    resource_version: 1,
    actor_kind: "service",
    display_name: "Core Agent Provisioner",
    status: "active",
    created_at: admissionNow,
    updated_at: admissionNow,
  }]).onConflict((conflict) => conflict.column("actor_id").doNothing()).execute();
  await db.insertInto("memberships").values([{
    tenant_id: tenantId,
    membership_id: `membership_${tenantId}`,
    actor_id: ownerId,
    schema_version: 1,
    resource_version: 1,
    roles: ["student"],
    membership_source: "self",
    seat_ref: null,
    status: "active",
    created_at: admissionNow,
    updated_at: admissionNow,
  }, {
    tenant_id: tenantId,
    membership_id: "core_agent_provisioner_admin",
    actor_id: "core_agent_provisioner",
    schema_version: 1,
    resource_version: 1,
    roles: ["admin"],
    membership_source: "platform",
    seat_ref: null,
    status: "active",
    created_at: admissionNow,
    updated_at: admissionNow,
  }]).execute();
  await db.insertInto("profiles").values({
    tenant_id: tenantId,
    profile_id: profileId,
    schema_version: 1,
    resource_version: 1,
    owner_actor_id: ownerId,
    profile_kind: "default",
    hermes_profile_ref: `hermes_${tenantId}`,
    description: "Admission test profile",
    status: "active",
    provider_config_id: "provider_admission",
    model_id: "model_admission",
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.insertInto("runtime_containers").values({
    tenant_id: tenantId,
    container_id: runtimeId,
    schema_version: 1,
    resource_version: 1,
    command_version: 0,
    runtime_kind: "hermes",
    desired_state: "running",
    observed_state: "ready",
    image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`,
    runtime_platform: "linux/amd64",
    generation: 1,
    volume_ref: `volume_${tenantId}`,
    health_status: "healthy",
    last_probed_at: admissionNow,
    failure_summary: null,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  const suffix = createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 24);
  const capabilityId = `capability_admission_${suffix}`;
  const capabilityVersionId = `capability_version_admission_${suffix}`;
  const packProductId = `pack_product_admission_${suffix}`;
  const packVersionId = `pack_version_admission_${suffix}`;
  const releaseId = `release_admission_${suffix}`;
  await db.insertInto("capabilities").values({
    capability_id: capabilityId,
    display_name: "Admission capability",
    owning_domain: "admission",
    kind: "mcp",
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.insertInto("capability_versions").values({
    capability_version_id: capabilityVersionId,
    capability_id: capabilityId,
    version: "1.0.0",
    kind: "mcp",
    artifact_ref: `manifest:sha256:${createHash("sha256").update(capabilityVersionId).digest("hex")}`,
    contract_ref: "admission/capability@1.0.0",
    risk_class: "read",
    approval_requirement: "none",
    compatibility_json: {
      core_contract_version: "0.8.0",
      domain_contract_version: "1.0.0",
      runtime_protocol_version: "1.0.0",
      tenant_modes: ["b2c"],
    },
    status: "reviewed",
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.insertInto("pack_products").values({
    pack_product_id: packProductId,
    display_name: "Admission Pack",
    tenant_modes: ["b2c"],
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.insertInto("pack_versions").values({
    pack_version_id: packVersionId,
    pack_product_id: packProductId,
    version: "1.0.0",
    status: "draft",
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.insertInto("pack_members").values({
    pack_member_id: `pack_member_admission_${suffix}`,
    pack_version_id: packVersionId,
    member_order: 1,
    capability_id: capabilityId,
    capability_version_id: capabilityVersionId,
    version: "1.0.0",
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.updateTable("pack_versions").set({ status: "reviewed", resource_version: 2, updated_at: admissionNow })
    .where("pack_version_id", "=", packVersionId).execute();
  await db.updateTable("pack_versions").set({ status: "published", resource_version: 3, updated_at: admissionNow })
    .where("pack_version_id", "=", packVersionId).execute();
  await db.insertInto("tenant_pack_releases").values({
    tenant_pack_release_id: releaseId,
    tenant_id: tenantId,
    pack_product_id: packProductId,
    pack_version_id: packVersionId,
    pack_version: "1.0.0",
    generation: 1,
    status: "preparing",
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  await db.updateTable("tenant_pack_releases").set({ status: "current", resource_version: 2, updated_at: admissionNow })
    .where("tenant_pack_release_id", "=", releaseId).execute();
  await db.insertInto("entitlements").values({
    entitlement_id: `entitlement_admission_${suffix}`,
    tenant_id: tenantId,
    pack_product_id: packProductId,
    tenant_pack_release_id: releaseId,
    pack_version_id: packVersionId,
    pack_version: "1.0.0",
    source: "platform_manual",
    external_order_ref: `admission_order_${suffix}`,
    tenant_mode: "b2c",
    assignment_mode: "automatic",
    seat_quantity: null,
    valid_from: admissionNow,
    expires_at: null,
    status: "active",
    reason_code: "platform_grant",
    resource_version: 1,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  const snapshot = await db.transaction().execute((trx) => resolveProfileSnapshotInTransaction({
    trx,
    tenantId,
    profileId,
    now: admissionNow,
    evidence: {
      actorId: "core_agent_provisioner",
      membershipId: "core_agent_provisioner_admin",
      requestId: `request_seed_${suffix}`,
      traceId: `trace_seed_${suffix}`,
    },
  }));
  await db.updateTable("capability_runtime_projections").set({ status: "available", updated_at: admissionNow })
    .where("projection_id", "=", snapshot.projection.projectionId).execute();
  await db.updateTable("runtime_containers").set({
    generation: snapshot.projection.generation,
    capability_manifest_digest: snapshot.canonicalInputHash,
    ...(options.runtimeDesiredState === undefined ? {} : { desired_state: options.runtimeDesiredState }),
    ...(options.runtimeObservedState === undefined ? {} : { observed_state: options.runtimeObservedState }),
    ...(options.runtimeHealthStatus === undefined ? {} : { health_status: options.runtimeHealthStatus }),
  }).where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("outbox").where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("product_events").where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("audit_events").where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("stream_sequences").where("tenant_id", "=", tenantId).execute();
  if (options.tenantStatus !== undefined) {
    await db.updateTable("tenants").set({ status: options.tenantStatus }).where("tenant_id", "=", tenantId).execute();
  }
  if (options.profileStatus !== undefined) {
    await db.updateTable("profiles").set({ status: options.profileStatus }).where("tenant_id", "=", tenantId).execute();
  }
  return { profileId, runtimeId };
}
