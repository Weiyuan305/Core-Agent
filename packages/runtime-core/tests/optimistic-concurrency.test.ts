import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createRuntimeDatabase, ResourceRepositories, withTenantTransaction, type RuntimeContainer } from "@core-agent/runtime-core";
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

test.beforeEach(async () => {
  await resetDatabase();
  await seedTenant("tenant_a");
});

test.after(async () => {
  await db.destroy();
});

test("expected resource version prevents a lost runtime update", async () => {
  const repo = repositories.forTenant("tenant_a").runtimes;
  await repo.insert(syntheticRuntime());

  assert.deepEqual(
    await repo.updateDesiredState("runtime_a", "stopped", 1),
    { kind: "updated", resource_version: 2 },
  );
  assert.deepEqual(
    await repo.updateDesiredState("runtime_a", "running", 1),
    { kind: "version_conflict", current_resource_version: 2 },
  );
});

test("maximum safe resource version cannot be incremented or persisted out of contract range", async () => {
  const repo = repositories.forTenant("tenant_a").runtimes;
  await repo.insert(syntheticRuntime({ resource_version: Number.MAX_SAFE_INTEGER }));

  await assert.rejects(
    repo.updateDesiredState("runtime_a", "stopped", Number.MAX_SAFE_INTEGER),
    /safe integer/i,
  );
  const stored = await db.selectFrom("runtime_containers")
    .select(["desired_state", "resource_version"])
    .where("tenant_id", "=", "tenant_a")
    .where("container_id", "=", "runtime_a")
    .executeTakeFirstOrThrow();
  assert.deepEqual(stored, {
    desired_state: "running",
    resource_version: Number.MAX_SAFE_INTEGER.toString(),
  });
});

async function waitForBlockedRuntimeQuery(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await pool.query<{ blocked: boolean }>(`
      select exists (
        select 1
        from pg_stat_activity
        where pid <> pg_backend_pid()
          and datname = current_database()
          and wait_event_type = 'Lock'
          and query like '%runtime_containers%'
      ) as blocked
    `);
    if (blocked.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the runtime CAS query to block");
}

test("CAS classification does not observe a replacement row created during the write", async () => {
  const repo = repositories.forTenant("tenant_a").runtimes;
  await repo.insert(syntheticRuntime());

  let releaseLock: (() => void) | undefined;
  let announceLock: (() => void) | undefined;
  const mayReplace = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const lockAcquired = new Promise<void>((resolve) => {
    announceLock = resolve;
  });
  const replacement = db.transaction().execute(async (trx) => {
    await trx.selectFrom("runtime_containers")
      .select("container_id")
      .where("tenant_id", "=", "tenant_a")
      .where("container_id", "=", "runtime_a")
      .forUpdate()
      .executeTakeFirstOrThrow();
    announceLock?.();
    await mayReplace;
    await trx.deleteFrom("runtime_containers")
      .where("tenant_id", "=", "tenant_a")
      .where("container_id", "=", "runtime_a")
      .execute();
    await trx.insertInto("runtime_containers").values({
      tenant_id: "tenant_a",
      container_id: "runtime_a",
      schema_version: 1,
      resource_version: 9,
      runtime_kind: "hermes",
      desired_state: "deleted",
      observed_state: "deleted",
      image_ref: `registry.example/hermes@sha256:${"a".repeat(64)}`,
      generation: 1,
      volume_ref: "volume_replacement",
      health_status: "unknown",
      last_probed_at: null,
      failure_summary: null,
      created_at: new Date("2026-01-02T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    }).execute();
  });

  await lockAcquired;
  const result = repo.updateDesiredState("runtime_a", "stopped", 1);
  await waitForBlockedRuntimeQuery().catch(async (error) => {
    releaseLock?.();
    await replacement;
    throw error;
  });
  releaseLock?.();
  await replacement;

  assert.deepEqual(await result, { kind: "not_found" });
  assert.deepEqual(
    await repo.find("runtime_a"),
    syntheticRuntime({
      resource_version: 9,
      desired_state: "deleted",
      observed_state: "deleted",
      volume_ref: "volume_replacement",
      health_status: "unknown",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    }),
  );
});

test("tenant transaction rejects invalid scope before beginning database work", async () => {
  await assert.rejects(
    withTenantTransaction(db, "tenant invalid", async () => undefined),
    /invalid tenant id/i,
  );
});
