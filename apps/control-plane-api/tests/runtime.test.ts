import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { applyMigrations, canonicalPayloadHash, createRedactor, createRuntimeDatabase, loadProviderCatalog } from "@core-agent/runtime-core";
import type { FastifyBaseLogger } from "fastify";
import { Pool } from "pg";

import { buildControlPlaneApp } from "../src/app.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "runtime-core", "migrations");
const testRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
const bootstrapKey = "synthetic-bootstrap-key-00000001";
const imageRef = `managed/runtime:v1@sha256:${"a".repeat(64)}`;
const imageLock = { schemaVersion: 1, repository: "managed/runtime", tag: "v1", platforms: {
  "linux/amd64": { reference: imageRef }, "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
} };
const providerCatalog = loadProviderCatalog([{ provider_config_id: "provider_a", base_url: "https://provider.example/v1", model_ids: ["model_a"], credential_secret_ref: "provider_secret_a", timeout_ms: 10_000, max_safe_retries: 1 }]);
const logger = { child() { return this; }, info() {}, error() {}, warn() {}, debug() {}, fatal() {}, trace() {}, silent() {}, level: "silent" } as unknown as FastifyBaseLogger;

function hash<T extends Record<string, unknown>>(value: T) {
  return { ...value, payload_hash: canonicalPayloadHash(value) };
}
function provisioning(tenantId: string) {
  const timestamp = "2026-08-04T01:00:00.000Z";
  return hash({ schema_version: 1, idempotency_key: `idem_${tenantId}`, client_request_id: `client_${tenantId}`,
    identity_graph: { schema_version: 1,
      tenant: { schema_version: 1, resource_version: 1, tenant_id: tenantId, tenant_mode: "b2c", display_name: "Runtime tenant", status: "provisioning", created_at: timestamp, updated_at: timestamp },
      actors: [{ schema_version: 1, resource_version: 1, actor_id: `actor_${tenantId}`, actor_kind: "human", status: "active", created_at: timestamp, updated_at: timestamp }],
      memberships: [{ schema_version: 1, resource_version: 1, membership_id: `membership_${tenantId}`, tenant_id: tenantId, actor_id: `actor_${tenantId}`, roles: ["student"], membership_source: "self", status: "active", created_at: timestamp, updated_at: timestamp }],
      profiles: [{ schema_version: 1, resource_version: 1, profile_id: `profile_${tenantId}`, tenant_id: tenantId, owner_actor_id: `actor_${tenantId}`, profile_kind: "default", status: "provisioning", hermes_profile_ref: `hermes_${tenantId}`, created_at: timestamp, updated_at: timestamp }],
    }, provider_config_id: "provider_a", model_id: "model_a",
    runtime: { image_ref: imageRef, platform: "linux/amd64", ingress_secret_ref: `ingress_${tenantId}` },
    profile_runtime_config: [{ profile_id: `profile_${tenantId}`, description: "Default profile" }],
  });
}

test("runtime routes enforce scope and expected resource versions with direct envelopes", async () => {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const directory = await mkdtemp(join(testRoot, "runtime-"));
  await chmod(directory, 0o700);
  const bootstrapKeyFile = join(directory, "bootstrap-key");
  await writeFile(bootstrapKeyFile, `${bootstrapKey}\n`, { mode: 0o600 });
  const app = await buildControlPlaneApp({ environment: {
    databaseUrl, bootstrapKeyFile, apiHost: "127.0.0.1", apiPort: 8787, secretRoot: directory,
    supervisorSocket: join(directory, "supervisor.sock"), providerCatalogFile: join(directory, "providers.json"), workerId: "worker_test",
  }, db, providerCatalog, imageLock, logger, redactor: createRedactor([bootstrapKey]) });
  try {
    const tenantId = "tenant_http_runtime";
    const headers = { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId };
    assert.equal((await app.inject({
      method: "POST", url: "/internal/v1/tenant-provisioning",
      headers: { authorization: `Bearer ${bootstrapKey}` }, payload: provisioning(tenantId),
    })).statusCode, 202);
    const queried = await app.inject({ method: "GET", url: `/internal/v1/tenants/${tenantId}/runtime`, headers });
    assert.equal(queried.statusCode, 200);
    const volumeRef = (queried.json() as { volume_ref: string }).volume_ref;
    const command = hash({ schema_version: 1, idempotency_key: "idem_http_stop", expected_resource_version: 1, command: "stop" });
    const first = await app.inject({ method: "POST", url: `/internal/v1/tenants/${tenantId}/runtime-commands`, headers, payload: command });
    const replay = await app.inject({ method: "POST", url: `/internal/v1/tenants/${tenantId}/runtime-commands`, headers, payload: command });
    assert.equal(first.statusCode, 202);
    assert.deepEqual(replay.json(), first.json());
    assert.equal((first.json() as { runtime: { desired_state: string } }).runtime.desired_state, "stopped");
    const after = await app.inject({ method: "GET", url: `/internal/v1/tenants/${tenantId}/runtime`, headers });
    assert.equal((after.json() as { volume_ref: string }).volume_ref, volumeRef);

    const stale = hash({ schema_version: 1, idempotency_key: "idem_http_stale", expected_resource_version: 1, command: "delete" });
    const conflict = await app.inject({ method: "POST", url: `/internal/v1/tenants/${tenantId}/runtime-commands`, headers, payload: stale });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { code: string }).code, "RESOURCE_VERSION_CONFLICT");
    const crossTenant = await app.inject({ method: "GET", url: "/internal/v1/tenants/tenant_other/runtime", headers });
    assert.equal(crossTenant.statusCode, 404);
    assert.equal((crossTenant.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
    const crossTenantCommand = await app.inject({
      method: "POST", url: "/internal/v1/tenants/tenant_other/runtime-commands", headers,
      payload: hash({ schema_version: 1, idempotency_key: "idem_cross_tenant", expected_resource_version: 2, command: "start" }),
    });
    assert.equal(crossTenantCommand.statusCode, 404);
    assert.equal((crossTenantCommand.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await db.destroy();
  }
});
