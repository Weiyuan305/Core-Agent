import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { ProductEventSchema } from "@core-agent/contracts";
import Schema from "typebox/schema";

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

test("empty database migrates exactly to schema version 4 with durable runtime command intent", async () => {
  await applyMigrations(pool, migrationsDirectory);

  assert.equal(EXPECTED_SCHEMA_VERSION, 4);
  assert.equal(await readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  await assert.doesNotReject(assertSchemaVersion(db, EXPECTED_SCHEMA_VERSION));
  await assert.rejects(assertSchemaVersion(db, 3), /ahead/);
  await assert.rejects(assertSchemaVersion(db, 5), /behind/);
  const runtimeCommandColumn = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'worker_jobs' and column_name = 'runtime_command'
  `.execute(db);
  assert.deepEqual(runtimeCommandColumn.rows, [{ column_name: "runtime_command" }]);
});

test("version 4 terminalizes ambiguous legacy reconcile jobs and enforces the job-kind invariant", async () => {
  const legacyDirectory = await mkdtemp(join(tmpdir(), "core-agent-v3-migrations-"));
  await cp(migrationsDirectory, legacyDirectory, { recursive: true });
  await rm(join(legacyDirectory, "004_runtime_command_intent.sql"));
  try {
    await applyMigrations(pool, legacyDirectory);
    await seedTenant("tenant_upgrade");
    const createdAt = new Date("2026-08-03T00:00:00.000Z");
    for (const [suffix, desiredState] of [
      ["running", "running"], ["stopped", "stopped"], ["deleted", "deleted"],
    ] as const) {
      await pool.query(
        `insert into runtime_containers (
          tenant_id, container_id, schema_version, resource_version, runtime_kind,
          desired_state, observed_state, image_ref, generation, volume_ref, health_status,
          last_probed_at, failure_summary, created_at, updated_at
        ) values ($1, $2, 1, 1, 'hermes', $3, 'requested', $4, 1, $5, 'unknown', null, null, $6, $6)`,
        ["tenant_upgrade", `runtime_${suffix}`, desiredState, `managed/runtime:v1@sha256:${"a".repeat(64)}`, `volume_${suffix}`, createdAt],
      );
      await pool.query(
        `insert into worker_jobs (
          tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
          lease_expires_at, next_attempt_at, payload_ref, effect_state, last_error_summary,
          run_id, container_id, created_at, updated_at
        ) values ($1, $2, 'reconcile_runtime', 'queued', 0, 3, null, null, $3, $4, 'pre_effect', null, null, $4, $3, $3)`,
        ["tenant_upgrade", `job_${suffix}`, createdAt, `runtime_${suffix}`],
      );
    }
    await pool.query(
      `insert into worker_jobs (
        tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
        lease_expires_at, next_attempt_at, payload_ref, effect_state, last_error_summary,
        run_id, container_id, created_at, updated_at
      ) values ($1, 'job_dispatch', 'dispatch_outbox', 'queued', 0, 3, null, null, $2, 'outbox_1', 'pre_effect', null, null, null, $2, $2)`,
      ["tenant_upgrade", createdAt],
    );
    await pool.query(
      `insert into worker_jobs (
        tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
        lease_expires_at, next_attempt_at, payload_ref, effect_state, last_error_summary,
        run_id, container_id, created_at, updated_at
      ) values ($1, 'job_orphan', 'reconcile_runtime', 'running', 1, 3, 'legacy_worker', $2, $2, 'runtime_missing', 'pre_effect', null, null, null, $2, $2)`,
      ["tenant_upgrade", createdAt],
    );

    await applyMigrations(pool, migrationsDirectory);
    const legacyReconcileJobs = await db.selectFrom("worker_jobs")
      .select(["job_id", "status", "runtime_command", "lease_owner", "lease_expires_at", "last_error_summary"])
      .where("job_kind", "=", "reconcile_runtime").orderBy("job_id").execute();
    assert.deepEqual(legacyReconcileJobs.map((job) => job.job_id), [
      "job_deleted", "job_orphan", "job_running", "job_stopped",
    ]);
    for (const job of legacyReconcileJobs) {
      assert.equal(job.status, "failed", job.job_id);
      assert.equal(job.runtime_command, null, job.job_id);
      assert.equal(job.lease_owner, null, job.job_id);
      assert.equal(job.lease_expires_at, null, job.job_id);
      assert.equal(job.last_error_summary, "Legacy reconcile intent unavailable after schema upgrade", job.job_id);
    }
    assert.equal(
      legacyReconcileJobs.find((job) => job.job_id === "job_running")?.runtime_command,
      null,
      "running desired state must not be fabricated into start or restart",
    );
    for (const status of ["queued", "running", "retrying"] as const) {
      await assert.rejects(
        db.updateTable("worker_jobs").set({ status, runtime_command: null }).where("job_id", "=", "job_running").execute(),
        /worker_jobs_runtime_command_intent_check/,
      );
    }
    await assert.doesNotReject(
      db.updateTable("worker_jobs").set({ status: "cancelled", runtime_command: null })
        .where("job_id", "=", "job_running").execute(),
    );
    await assert.rejects(
      db.updateTable("worker_jobs").set({ runtime_command: "start" }).where("job_id", "=", "job_dispatch").execute(),
      /worker_jobs_runtime_command_intent_check/,
    );
  } finally {
    await rm(legacyDirectory, { recursive: true, force: true });
  }
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

test("complete ProductEvents round-trip while bigint values remain exact strings", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await db.insertInto("tenants").values({
    tenant_id: "tenant_event",
    schema_version: 1,
    resource_version: "9007199254740993",
    tenant_mode: "b2b",
    status: "active",
    display_name: "Synthetic event tenant",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  }).execute();
  await seedActor("tenant_event", "actor_tenant_event");
  await seedProfile("tenant_event", "profile_event");

  const occurredAt = new Date("2026-08-03T12:00:00.000Z");
  const studentRef = {
    student_id: "student_synthetic",
    source_system: "synthetic_source",
    source_version: "source_v1",
  };
  const caseRef = {
    case_id: "case_synthetic",
    student_id: "student_synthetic",
    capability_id: "capability_synthetic",
    source_system: "synthetic_source",
    source_version: "source_v1",
  };
  const payload = { error_id: "error_synthetic", code: "INTERNAL_ERROR", category: "internal" };

  await db.insertInto("product_events").values({
    tenant_id: "tenant_event",
    event_id: "event_complete",
    stream_id: "stream_synthetic",
    schema_version: 1,
    sequence: 42,
    event_type: "error.reported",
    occurred_at: occurredAt,
    request_id: "request_synthetic",
    trace_id: "trace_synthetic",
    correlation_id: "correlation_synthetic",
    causation_id: "causation_synthetic",
    profile_id: "profile_event",
    conversation_id: null,
    run_id: null,
    task_id: "task_synthetic",
    approval_id: "approval_synthetic",
    student_ref: studentRef,
    case_ref: caseRef,
    capability_id: "capability_synthetic",
    payload,
  }).execute();

  const tenant = await db.selectFrom("tenants")
    .select("resource_version")
    .where("tenant_id", "=", "tenant_event")
    .executeTakeFirstOrThrow();
  assert.equal(typeof tenant.resource_version, "string");
  assert.equal(tenant.resource_version, "9007199254740993");

  const stored = await db.selectFrom("product_events")
    .selectAll()
    .where("tenant_id", "=", "tenant_event")
    .where("event_id", "=", "event_complete")
    .executeTakeFirstOrThrow();
  assert.equal(typeof stored.sequence, "string");
  assert.equal(stored.sequence, "42");

  const reconstructed = {
    schema_version: stored.schema_version,
    event_id: stored.event_id,
    occurred_at: stored.occurred_at.toISOString(),
    sequence: Number(stored.sequence),
    tenant_id: stored.tenant_id,
    request_id: stored.request_id,
    trace_id: stored.trace_id,
    correlation_id: stored.correlation_id,
    causation_id: stored.causation_id,
    profile_id: stored.profile_id,
    task_id: stored.task_id,
    approval_id: stored.approval_id,
    student_ref: stored.student_ref,
    case_ref: stored.case_ref,
    capability_id: stored.capability_id,
    event_type: stored.event_type,
    payload: stored.payload,
  };
  assert.equal(Schema.Check(ProductEventSchema, reconstructed), true);
  assert.deepEqual(reconstructed, {
    schema_version: 1,
    event_id: "event_complete",
    occurred_at: "2026-08-03T12:00:00.000Z",
    sequence: 42,
    tenant_id: "tenant_event",
    request_id: "request_synthetic",
    trace_id: "trace_synthetic",
    correlation_id: "correlation_synthetic",
    causation_id: "causation_synthetic",
    profile_id: "profile_event",
    task_id: "task_synthetic",
    approval_id: "approval_synthetic",
    student_ref: studentRef,
    case_ref: caseRef,
    capability_id: "capability_synthetic",
    event_type: "error.reported",
    payload,
  });
});

test("PostgreSQL tests refuse databases outside the core_agent_ namespace", () => {
  assert.throws(
    () => assertDisposableDatabaseUrl("postgresql://example:example@127.0.0.1:55432/postgres"),
    /core_agent_/,
  );
});
