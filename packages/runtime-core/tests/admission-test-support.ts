import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import type { Pool } from "pg";

import {
  applyMigrations,
  canonicalPayloadHash,
  deriveRuntimeContainerId,
  loadProviderCatalog,
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
    status: options.tenantStatus ?? "active",
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
    status: options.profileStatus ?? "active",
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
    desired_state: options.runtimeDesiredState ?? "running",
    observed_state: options.runtimeObservedState ?? "ready",
    image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`,
    runtime_platform: "linux/amd64",
    generation: 1,
    volume_ref: `volume_${tenantId}`,
    health_status: options.runtimeHealthStatus ?? "healthy",
    last_probed_at: admissionNow,
    failure_summary: null,
    created_at: admissionNow,
    updated_at: admissionNow,
  }).execute();
  return { profileId, runtimeId };
}
