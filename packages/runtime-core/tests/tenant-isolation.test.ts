import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createRuntimeDatabase,
  ResourceRepositories,
  SecretReferenceRepository,
  type Actor,
  type RuntimeContainer,
} from "@core-agent/runtime-core";
import { Pool } from "pg";

import { applyMigrations } from "../src/db/migrate.js";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));

function assertDisposableDatabaseUrl(url: string | undefined): string {
  if (url === undefined) throw new Error("CONTROL_PLANE_TEST_DATABASE_URL is required for PostgreSQL tests");
  if (!new URL(url).pathname.slice(1).startsWith("core_agent_")) {
    throw new Error("PostgreSQL tests require a database name beginning with core_agent_");
  }
  return url;
}

const pool = new Pool({ connectionString: assertDisposableDatabaseUrl(testDatabaseUrl) });
const db = createRuntimeDatabase(pool);
const repositories = new ResourceRepositories(db);

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
}

async function seedTenant(tenantId: string): Promise<void> {
  await db.insertInto("tenants").values({
    tenant_id: tenantId,
    schema_version: 1,
    resource_version: 1,
    tenant_mode: "b2b",
    status: "active",
    display_name: `Synthetic ${tenantId}`,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  }).execute();
}

function syntheticRuntime(overrides: Partial<RuntimeContainer> = {}): RuntimeContainer {
  return {
    schema_version: 1,
    resource_version: 1,
    container_id: "runtime_a",
    tenant_id: "tenant_a",
    runtime_kind: "hermes",
    desired_state: "running",
    observed_state: "ready",
    image_ref: `registry.example/hermes@sha256:${"a".repeat(64)}`,
    generation: 1,
    volume_ref: "volume_a",
    health_status: "healthy",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function syntheticActor(overrides: Partial<Actor> = {}): Actor {
  return {
    schema_version: 1,
    resource_version: 1,
    actor_id: "actor_a",
    actor_kind: "service",
    status: "active",
    display_name: "Synthetic actor",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetDatabase();
  await seedTenant("tenant_a");
  await seedTenant("tenant_b");
});

test.after(async () => {
  await db.destroy();
});

test("repository cannot fetch a resource through another tenant", async () => {
  const tenantA = repositories.forTenant("tenant_a");
  const tenantB = repositories.forTenant("tenant_b");
  await tenantA.runtimes.insert(syntheticRuntime());

  assert.equal(await tenantB.runtimes.find("runtime_a"), undefined);
});

test("Actor repository uses stable global identity while Memberships remain tenant scoped", async () => {
  const tenantA = repositories.forTenant("tenant_a");
  const tenantB = repositories.forTenant("tenant_b");
  const actor = syntheticActor({ actor_id: "actor_global_repository" });
  await tenantA.actors.insert(actor);

  assert.deepEqual(await tenantB.actors.find(actor.actor_id), actor);
  assert.equal(
    await db.selectFrom("actors").select(({ fn }) => fn.countAll<string>().as("count"))
      .where("actor_id", "=", actor.actor_id).executeTakeFirstOrThrow().then((row) => row.count),
    "1",
  );
});

test("repository rejects a runtime whose mapped bigint is not a safe integer", async () => {
  await db.insertInto("runtime_containers").values({
    tenant_id: "tenant_a",
    container_id: "runtime_unsafe_version",
    schema_version: 1,
    resource_version: "9007199254740993",
    runtime_kind: "hermes",
    desired_state: "running",
    observed_state: "ready",
    image_ref: `registry.example/hermes@sha256:${"a".repeat(64)}`,
    generation: 1,
    volume_ref: "volume_a",
    health_status: "healthy",
    last_probed_at: null,
    failure_summary: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  }).execute();

  await assert.rejects(
    repositories.forTenant("tenant_a").runtimes.find("runtime_unsafe_version"),
    /safe integer/i,
  );
});

test("repository inserts reject unsafe contract resource versions before writing", async () => {
  const unsafeVersion = Number.MAX_SAFE_INTEGER + 1;
  const tenant = repositories.forTenant("tenant_a");

  await assert.rejects(
    tenant.runtimes.insert(syntheticRuntime({ container_id: "runtime_unsafe_input", resource_version: unsafeVersion })),
    /positive safe integer/i,
  );
  await assert.rejects(
    tenant.actors.insert(syntheticActor({ actor_id: "actor_unsafe_input", resource_version: unsafeVersion })),
    /positive safe integer/i,
  );
  assert.equal(
    await db.selectFrom("runtime_containers")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", "tenant_a")
      .executeTakeFirstOrThrow()
      .then((row) => row.count),
    "0",
  );
  assert.equal(await tenant.actors.find("actor_unsafe_input"), undefined);
});

test("secret reference repository stores tenant-scoped metadata only", async () => {
  const tenantA = new SecretReferenceRepository({ tenantId: "tenant_a", db });
  const tenantB = new SecretReferenceRepository({ tenantId: "tenant_b", db });
  const metadata = [
    { reference_id: "provider_tokenhub_main", purpose: "model_provider" as const },
    { reference_id: "hermes_ingress_main", purpose: "hermes_ingress" as const },
    { reference_id: "bootstrap_service_main", purpose: "bootstrap_service" as const },
  ].map((reference) => ({
    ...reference,
    version: 1,
    status: "active" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }));

  for (const reference of metadata) {
    await tenantA.insert(reference);
    assert.deepEqual(await tenantA.find(reference.reference_id), reference);
    assert.equal(await tenantB.find(reference.reference_id), undefined);
  }

  const stored = await db.selectFrom("secret_references")
    .selectAll()
    .where("tenant_id", "=", "tenant_a")
    .orderBy("reference_id", "asc")
    .execute();
  assert.deepEqual(stored.map((row) => [row.reference_id, row.purpose]), [
    ["bootstrap_service_main", "bootstrap"],
    ["hermes_ingress_main", "integration"],
    ["provider_tokenhub_main", "provider_credential"],
  ]);
  assert.deepEqual(Object.keys(stored[0] ?? {}).sort(), [
    "created_at",
    "purpose",
    "reference_id",
    "status",
    "tenant_id",
    "updated_at",
    "version",
  ]);

  await assert.rejects(
    tenantA.insert({ ...metadata[0]!, reference_id: "unsafe_version", version: Number.MAX_SAFE_INTEGER + 1 }),
    /positive safe integer/,
  );
  await assert.rejects(
    tenantA.insert({ ...metadata[0]!, reference_id: "unsafe_purpose", purpose: "private" as never }),
    /purpose/,
  );
});
