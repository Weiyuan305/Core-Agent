import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalPayloadHash, createRedactor, createRuntimeDatabase, applyMigrations, loadProviderCatalog } from "@core-agent/runtime-core";
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
const imageLock = {
  schemaVersion: 1, repository: "managed/runtime", tag: "v1",
  platforms: {
    "linux/amd64": { reference: imageRef },
    "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
  },
};
const providerCatalog = loadProviderCatalog([{
  provider_config_id: "provider_a", base_url: "https://provider.example/v1", model_ids: ["model_a"],
  credential_secret_ref: "provider_secret_a", timeout_ms: 10_000, max_safe_retries: 1,
}]);
const logger = { child() { return this; }, info() {}, error() {}, warn() {}, debug() {}, fatal() {}, trace() {}, silent() {}, level: "silent" } as unknown as FastifyBaseLogger;

function hash<T extends Record<string, unknown>>(value: T) {
  return { ...value, payload_hash: canonicalPayloadHash(value) };
}
function rehash<T extends { payload_hash: string }>(value: T) {
  const { payload_hash: _payloadHash, ...payload } = value;
  return hash(payload);
}
function request() {
  const tenantId = "tenant_http_provision";
  const timestamp = "2026-08-04T01:00:00.000Z";
  return hash({
    schema_version: 1, idempotency_key: "idem_http_provision", client_request_id: "client_http_provision",
    identity_graph: {
      schema_version: 1,
      tenant: { schema_version: 1, resource_version: 1, tenant_id: tenantId, tenant_mode: "b2c", display_name: "HTTP B2C", status: "provisioning", created_at: timestamp, updated_at: timestamp },
      actors: [{ schema_version: 1, resource_version: 1, actor_id: "actor_http_student", actor_kind: "human", display_name: "Student", status: "active", created_at: timestamp, updated_at: timestamp }],
      memberships: [{ schema_version: 1, resource_version: 1, membership_id: "membership_http_student", tenant_id: tenantId, actor_id: "actor_http_student", roles: ["student"], membership_source: "self", status: "active", created_at: timestamp, updated_at: timestamp }],
      profiles: [{ schema_version: 1, resource_version: 1, profile_id: "profile_http_student", tenant_id: tenantId, owner_actor_id: "actor_http_student", profile_kind: "default", status: "provisioning", hermes_profile_ref: "hermes_http_student", created_at: timestamp, updated_at: timestamp }],
    },
    provider_config_id: "provider_a", model_id: "model_a",
    runtime: { image_ref: imageRef, platform: "linux/amd64", ingress_secret_ref: "ingress_http_provision" },
    profile_runtime_config: [{ profile_id: "profile_http_student", description: "Default student runtime" }],
  });
}

test("provisioning returns one accepted runtime and replays the same direct response envelope", async () => {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const directory = await mkdtemp(join(testRoot, "provision-"));
  await chmod(directory, 0o700);
  const bootstrapKeyFile = join(directory, "bootstrap-key");
  await writeFile(bootstrapKeyFile, `${bootstrapKey}\n`, { mode: 0o600 });
  const app = await buildControlPlaneApp({
    environment: {
      databaseUrl, bootstrapKeyFile, apiHost: "127.0.0.1", apiPort: 8787,
      secretRoot: directory, supervisorSocket: join(directory, "supervisor.sock"),
      providerCatalogFile: join(directory, "providers.json"), workerId: "worker_test",
    },
    db, providerCatalog, imageLock, logger, redactor: createRedactor([bootstrapKey]),
  });
  try {
    const payload = request();
    const headers = { authorization: `Bearer ${bootstrapKey}` };
    const first = await app.inject({ method: "POST", url: "/internal/v1/tenant-provisioning", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/internal/v1/tenant-provisioning", headers, payload });
    assert.equal(first.statusCode, 202);
    assert.deepEqual(replay.json(), first.json());
    assert.equal((first.json() as { status: string }).status, "accepted");
    assert.equal(await db.selectFrom("runtime_containers").selectAll().execute().then((rows) => rows.length), 1);
    assert.equal(await db.selectFrom("worker_jobs").selectAll().execute().then((rows) => rows.length), 1);
    const mismatch = await app.inject({
      method: "POST", url: "/internal/v1/tenant-provisioning", headers,
      payload: { ...payload, payload_hash: `sha256:${"0".repeat(64)}` },
    });
    assert.equal(mismatch.statusCode, 400);
    assert.equal((mismatch.json() as { code: string }).code, "INVALID_REQUEST");
    const conflict = await app.inject({
      method: "POST", url: "/internal/v1/tenant-provisioning", headers,
      payload: rehash({ ...payload, client_request_id: "client_http_changed" }),
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.json() as { code: string }).code, "IDEMPOTENCY_CONFLICT");
    const malformed = await app.inject({
      method: "POST", url: "/internal/v1/tenant-provisioning", headers,
      payload: { ...payload, unexpected: true },
    });
    assert.equal(malformed.statusCode, 400);
    assert.equal((malformed.json() as { code: string }).code, "INVALID_REQUEST");
    const forbiddenScope = await app.inject({
      method: "POST", url: "/internal/v1/tenant-provisioning",
      headers: { ...headers, "x-core-agent-tenant-id": payload.identity_graph.tenant.tenant_id }, payload,
    });
    assert.equal(forbiddenScope.statusCode, 400);
    assert.equal((forbiddenScope.json() as { code: string }).code, "INVALID_REQUEST");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await db.destroy();
  }
});
