import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { applyMigrations } from "../src/db/migrate.js";
import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import {
  assertSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  readSchemaVersion,
} from "../src/db/schema-version.js";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function assertDisposableDatabaseUrl(url: string | undefined): string {
  if (url === undefined) throw new Error("CONTROL_PLANE_TEST_DATABASE_URL is required for PostgreSQL tests");
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.startsWith("core_agent_")) {
    throw new Error("PostgreSQL tests require a database name beginning with core_agent_");
  }
  return url;
}

const pool = new Pool({ connectionString: assertDisposableDatabaseUrl(testDatabaseUrl) });
const db: Kysely<RuntimeDatabase> = createRuntimeDatabase(pool);

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
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

async function seedActor(tenantId: string, actorId: string): Promise<void> {
  await db.insertInto("actors").values({
    tenant_id: tenantId,
    actor_id: actorId,
    schema_version: 1,
    resource_version: 1,
    actor_kind: "service",
    display_name: "Synthetic service",
    status: "active",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  }).execute();
}

async function seedProfile(tenantId: string, profileId: string): Promise<void> {
  await db.insertInto("profiles").values({
    tenant_id: tenantId,
    profile_id: profileId,
    schema_version: 1,
    resource_version: 1,
    owner_actor_id: `actor_${tenantId}`,
    profile_kind: "consultant",
    hermes_profile_ref: profileId,
    description: "Synthetic profile used only by PostgreSQL migration tests.",
    status: "active",
    provider_config_id: "synthetic-provider",
    model_id: "synthetic-model",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  }).execute();
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await db.destroy();
});

test("empty database migrates exactly to schema version 3", async () => {
  await applyMigrations(pool, migrationsDirectory);

  assert.equal(await readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  await assert.doesNotReject(assertSchemaVersion(db, EXPECTED_SCHEMA_VERSION));
  await assert.rejects(assertSchemaVersion(db, 2), /ahead/);
  await assert.rejects(assertSchemaVersion(db, 4), /behind/);
});

test("modified applied migrations are rejected by checksum", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "core-agent-migrations-"));
  await cp(migrationsDirectory, temporaryDirectory, { recursive: true });
  try {
    await applyMigrations(pool, temporaryDirectory);
    const firstMigration = join(temporaryDirectory, "001_resources.sql");
    await writeFile(firstMigration, `${await readFile(firstMigration, "utf8")}\n-- synthetic mutation\n`);
    await assert.rejects(applyMigrations(pool, temporaryDirectory), /checksum/i);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("tenant composite foreign keys fail closed", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedTenant("tenant_a");
  await seedTenant("tenant_b");
  await seedActor("tenant_a", "actor_tenant_a");
  await seedActor("tenant_b", "actor_b");
  await seedProfile("tenant_a", "profile_a");

  await assert.rejects(
    db.insertInto("conversations").values({
      tenant_id: "tenant_b",
      conversation_id: "conversation_b",
      profile_id: "profile_a",
      created_by_actor_id: "actor_b",
      status: "active",
      schema_version: 1,
      resource_version: 1,
      student_ref: null,
      case_ref: null,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-01T00:00:00.000Z"),
    }).execute(),
    /foreign key/i,
  );
});

test("secret and event tables reject secret-material column names", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const columns = await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('secret_references', 'product_events', 'audit_events')
      and column_name ~ '(secret|token|password|credential|api_key).*(value|bytes|cipher|payload)'
  `.execute(db);

  assert.deepEqual(columns.rows, []);
});

test("PostgreSQL tests refuse databases outside the core_agent_ namespace", () => {
  assert.throws(
    () => assertDisposableDatabaseUrl("postgresql://example:example@127.0.0.1:55432/postgres"),
    /core_agent_/,
  );
});
