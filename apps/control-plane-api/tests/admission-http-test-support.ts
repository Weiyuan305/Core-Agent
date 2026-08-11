import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  createRedactor,
  createRuntimeDatabase,
  deriveRuntimeContainerId,
  loadProviderCatalog,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Pool } from "pg";

import { buildControlPlaneApp } from "../src/app.js";
import type { EventNotifier } from "../src/sse.js";

export const bootstrapKey = "synthetic-bootstrap-key-00000001";
export const admissionHttpNow = new Date("2026-08-05T02:00:00.000Z");
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "runtime-core", "migrations");
const testRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
const providerCatalog = loadProviderCatalog([{
  provider_config_id: "provider_http_admission",
  base_url: "https://provider.example/v1",
  model_ids: ["model_http_admission"],
  credential_secret_ref: "provider_secret_http_admission",
  timeout_ms: 10_000,
  max_safe_retries: 1,
}]);
const imageLock = {
  schemaVersion: 1,
  repository: "managed/runtime",
  tag: "v1",
  platforms: {
    "linux/amd64": { reference: `managed/runtime:v1@sha256:${"a".repeat(64)}` },
    "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
  },
};
const logger = {
  child() { return this; }, info() {}, error() {}, warn() {}, debug() {}, fatal() {}, trace() {}, silent() {}, level: "silent",
} as unknown as FastifyBaseLogger;

export async function resetHttpAdmissionDatabase(pool: Pool): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
}

export async function seedHttpReadyTenant(db: Kysely<RuntimeDatabase>, tenantId: string): Promise<string> {
  const profileId = `profile_${tenantId}`;
  const ownerId = `owner_${tenantId}`;
  await db.insertInto("tenants").values({ tenant_id: tenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2c", status: "active", display_name: "HTTP admission tenant", created_at: admissionHttpNow, updated_at: admissionHttpNow }).execute();
  await db.insertInto("actors").values([
    { actor_id: ownerId, schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Owner", status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
    { actor_id: "core_agent_provisioner", schema_version: 1, resource_version: 1, actor_kind: "service", display_name: "Core Agent Provisioner", status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
  ]).onConflict((conflict) => conflict.column("actor_id").doNothing()).execute();
  await db.insertInto("memberships").values([
    { tenant_id: tenantId, membership_id: `membership_${tenantId}`, actor_id: ownerId, schema_version: 1, resource_version: 1, roles: ["student"], membership_source: "self", seat_ref: null, status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
    { tenant_id: tenantId, membership_id: "core_agent_provisioner_admin", actor_id: "core_agent_provisioner", schema_version: 1, resource_version: 1, roles: ["admin"], membership_source: "platform", seat_ref: null, status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
  ]).execute();
  await db.insertInto("profiles").values({ tenant_id: tenantId, profile_id: profileId, schema_version: 1, resource_version: 1, owner_actor_id: ownerId, profile_kind: "default", hermes_profile_ref: `hermes_${tenantId}`, description: "HTTP admission profile", status: "active", provider_config_id: "provider_http_admission", model_id: "model_http_admission", created_at: admissionHttpNow, updated_at: admissionHttpNow }).execute();
  await db.insertInto("runtime_containers").values({ tenant_id: tenantId, container_id: deriveRuntimeContainerId(tenantId), schema_version: 1, resource_version: 1, command_version: 0, runtime_kind: "hermes", desired_state: "running", observed_state: "ready", image_ref: imageLock.platforms["linux/amd64"].reference, runtime_platform: "linux/amd64", generation: 1, volume_ref: `volume_${tenantId}`, health_status: "healthy", last_probed_at: admissionHttpNow, failure_summary: null, created_at: admissionHttpNow, updated_at: admissionHttpNow }).execute();
  return profileId;
}

export async function buildHttpAdmissionApp(
  databaseUrl: string,
  db: Kysely<RuntimeDatabase>,
  options: { readonly eventNotifier?: EventNotifier } = {},
): Promise<{ app: FastifyInstance; directory: string }> {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const directory = await mkdtemp(join(testRoot, "admission-"));
  await chmod(directory, 0o700);
  const bootstrapKeyFile = join(directory, "bootstrap-key");
  await writeFile(bootstrapKeyFile, `${bootstrapKey}\n`, { mode: 0o600 });
  const app = await buildControlPlaneApp({
    environment: {
      databaseUrl,
      bootstrapKeyFile,
      apiHost: "127.0.0.1",
      apiPort: 8787,
      secretRoot: directory,
      supervisorSocket: join(directory, "supervisor.sock"),
      providerCatalogFile: join(directory, "providers.json"),
      workerId: "worker_test",
    },
    db,
    providerCatalog,
    imageLock,
    logger,
    redactor: createRedactor([bootstrapKey]),
    ...(options.eventNotifier === undefined ? {} : { eventNotifier: options.eventNotifier }),
  });
  return { app, directory };
}

export { createRuntimeDatabase };
