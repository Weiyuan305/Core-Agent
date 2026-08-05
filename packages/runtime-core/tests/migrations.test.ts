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

test("empty database migrates exactly to schema version 8 with Worker claim indexes", async () => {
  await applyMigrations(pool, migrationsDirectory);

  assert.equal(EXPECTED_SCHEMA_VERSION, 8);
  assert.equal(await readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  await assert.doesNotReject(assertSchemaVersion(db, EXPECTED_SCHEMA_VERSION));
  await assert.rejects(assertSchemaVersion(db, 3), /ahead/);
  await assert.rejects(assertSchemaVersion(db, 9), /behind/);
  const runtimeCommandColumn = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'worker_jobs' and column_name = 'runtime_command'
  `.execute(db);
  assert.deepEqual(runtimeCommandColumn.rows, [{ column_name: "runtime_command" }]);
  const workerFactColumns = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema = 'public' and (
      (table_name = 'runtime_containers' and column_name = 'runtime_platform') or
      (table_name = 'runtime_containers' and column_name = 'command_version') or
      (table_name = 'worker_jobs' and column_name = 'target_command_version') or
      (table_name = 'outbox' and column_name in ('lease_owner', 'lease_expires_at', 'last_error_summary'))
    ) order by column_name
  `.execute(db);
  assert.deepEqual(workerFactColumns.rows.map((row) => row.column_name), ["command_version", "last_error_summary", "lease_expires_at", "lease_owner", "runtime_platform", "target_command_version"]);
  const indexes = await sql<{ indexname: string }>`
    select indexname from pg_indexes
    where schemaname = 'public' and indexname in (
      'agent_runs_tenant_conversation_run_idx',
      'worker_jobs_tenant_run_idx',
      'worker_jobs_platform_eligible_idx',
      'worker_jobs_platform_recovery_idx',
      'outbox_exhausted_recovery_idx'
    ) order by indexname
  `.execute(db);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    "agent_runs_tenant_conversation_run_idx",
    "outbox_exhausted_recovery_idx",
    "worker_jobs_platform_eligible_idx",
    "worker_jobs_platform_recovery_idx",
    "worker_jobs_tenant_run_idx",
  ]);
});

test("version 8 upgrades a genuine v7 database and supports Worker claim plans", { timeout: 10_000 }, async () => {
  const v7Directory = await mkdtemp(join(tmpdir(), "core-agent-v7-migrations-"));
  await cp(migrationsDirectory, v7Directory, { recursive: true });
  await rm(join(v7Directory, "008_outbox_exhausted_recovery_index.sql"));
  try {
    await applyMigrations(pool, v7Directory);
    assert.equal(await readSchemaVersion(db), 7);
    await applyMigrations(pool, migrationsDirectory);
    assert.equal(await readSchemaVersion(db), 8);

    const plans = await db.connection().execute(async (connection) => {
      await sql`set enable_seqscan = off`.execute(connection);
      try {
        const agentRuns = await sql<{ "QUERY PLAN": string }>`
          explain select run_id from agent_runs
          where tenant_id = 'tenant_plan' and conversation_id = 'conversation_plan'
        `.execute(connection);
        const jobRun = await sql<{ "QUERY PLAN": string }>`
          explain select job_id from worker_jobs
          where tenant_id = 'tenant_plan' and run_id = 'run_plan'
        `.execute(connection);
        const eligible = await sql<{ "QUERY PLAN": string }>`
          explain select job_id from worker_jobs
          where job_kind = 'execute_agent_run'
            and status in ('queued', 'retrying')
            and next_attempt_at <= now()
          order by created_at limit 4
        `.execute(connection);
        const exhaustedOutbox = await sql<{ "QUERY PLAN": string }>`
          explain select tenant_id, outbox_id from outbox
          where status = 'pending' and attempt_count >= 10
            and (lease_owner is null or lease_expires_at is null or lease_expires_at <= clock_timestamp())
          order by created_at, tenant_id, outbox_id
          limit 100 for update skip locked
        `.execute(connection);
        return [...agentRuns.rows, ...jobRun.rows, ...eligible.rows, ...exhaustedOutbox.rows].map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        await sql`reset enable_seqscan`.execute(connection);
      }
    });
    assert.match(plans, /agent_runs_tenant_conversation_run_idx/);
    assert.match(plans, /worker_jobs_tenant_run_idx/);
    assert.match(plans, /worker_jobs_platform_eligible_idx/);
    assert.match(plans, /outbox_exhausted_recovery_idx/);
  } finally {
    await rm(v7Directory, { recursive: true, force: true });
  }
});

test("version 4 terminalizes ambiguous legacy reconcile jobs and enforces the job-kind invariant", async () => {
  const legacyDirectory = await mkdtemp(join(tmpdir(), "core-agent-v3-migrations-"));
  await cp(migrationsDirectory, legacyDirectory, { recursive: true });
  await rm(join(legacyDirectory, "004_runtime_command_intent.sql"));
  await rm(join(legacyDirectory, "005_worker_runtime_facts.sql"));
  await rm(join(legacyDirectory, "006_worker_job_attempt_fence.sql"));
  await rm(join(legacyDirectory, "007_agent_run_claim_indexes.sql"));
  await rm(join(legacyDirectory, "008_outbox_exhausted_recovery_index.sql"));
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
    const historicalUpdatedAt = new Date("2026-08-03T02:00:00.000Z");
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      await pool.query(
        `insert into worker_jobs (
          tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
          lease_expires_at, next_attempt_at, payload_ref, effect_state, last_error_summary,
          run_id, container_id, created_at, updated_at
        ) values ($1, $2, 'reconcile_runtime', $3, 2, 3, 'historical_worker', $4, $4, $5, 'pre_effect', $6, null, null, $4, $4)`,
        ["tenant_upgrade", `job_historical_${status}`, status, historicalUpdatedAt, `runtime_historical_${status}`, `Historical ${status}`],
      );
    }

    await applyMigrations(pool, migrationsDirectory);
    const activeLegacyJobs = await db.selectFrom("worker_jobs")
      .select(["job_id", "status", "runtime_command", "lease_owner", "lease_expires_at", "last_error_summary"])
      .where("job_id", "in", ["job_deleted", "job_orphan", "job_running", "job_stopped"])
      .orderBy("job_id").execute();
    assert.deepEqual(activeLegacyJobs.map((job) => job.job_id), [
      "job_deleted", "job_orphan", "job_running", "job_stopped",
    ]);
    for (const job of activeLegacyJobs) {
      assert.equal(job.status, "failed", job.job_id);
      assert.equal(job.runtime_command, null, job.job_id);
      assert.equal(job.lease_owner, null, job.job_id);
      assert.equal(job.lease_expires_at, null, job.job_id);
      assert.equal(job.last_error_summary, "Legacy reconcile intent unavailable after schema upgrade", job.job_id);
    }
    assert.equal(
      activeLegacyJobs.find((job) => job.job_id === "job_running")?.runtime_command,
      null,
      "running desired state must not be fabricated into start or restart",
    );
    const historicalJobs = await db.selectFrom("worker_jobs")
      .select(["job_id", "status", "runtime_command", "attempt_count", "lease_owner", "lease_expires_at", "last_error_summary", "updated_at"])
      .where("job_id", "like", "job_historical_%").orderBy("job_id").execute();
    assert.deepEqual(historicalJobs, ["cancelled", "failed", "succeeded"].map((status) => ({
      job_id: `job_historical_${status}`,
      status,
      runtime_command: null,
      attempt_count: 2,
      lease_owner: "historical_worker",
      lease_expires_at: historicalUpdatedAt,
      last_error_summary: `Historical ${status}`,
      updated_at: historicalUpdatedAt,
    })));
    for (const status of ["queued", "running", "retrying"] as const) {
      await assert.rejects(
        db.updateTable("worker_jobs").set({ status, runtime_command: null }).where("job_id", "=", "job_running").execute(),
        /worker_jobs_runtime_command_intent_check/,
      );
    }
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      await assert.doesNotReject(
        db.updateTable("worker_jobs").set({ status, runtime_command: null })
          .where("job_id", "=", "job_running").execute(),
      );
    }
    await assert.rejects(
      db.updateTable("worker_jobs").set({ runtime_command: "start" }).where("job_id", "=", "job_dispatch").execute(),
      /worker_jobs_runtime_command_intent_check/,
    );
  } finally {
    await rm(legacyDirectory, { recursive: true, force: true });
  }
});

test("version 5 fails genuine active v4 command intent closed and preserves terminal v4 history", async () => {
  const v4Directory = await mkdtemp(join(tmpdir(), "core-agent-v4-migrations-"));
  await cp(migrationsDirectory, v4Directory, { recursive: true });
  await rm(join(v4Directory, "005_worker_runtime_facts.sql"));
  await rm(join(v4Directory, "006_worker_job_attempt_fence.sql"));
  await rm(join(v4Directory, "007_agent_run_claim_indexes.sql"));
  await rm(join(v4Directory, "008_outbox_exhausted_recovery_index.sql"));
  try {
    await applyMigrations(pool, v4Directory);
    await seedTenant("tenant_v4_worker_upgrade");
    const timestamp = new Date("2026-08-04T00:00:00.000Z");
    await pool.query(
      `insert into worker_jobs (
        tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
        lease_expires_at, next_attempt_at, payload_ref, runtime_command, effect_state,
        last_error_summary, run_id, container_id, created_at, updated_at
      ) values
        ($1, 'job_v4_active', 'reconcile_runtime', 'running', 1, 5, 'worker_v4', $2, $2, 'runtime_v4', 'stop', 'pre_effect', null, null, null, $2, $2),
        ($1, 'job_v4_terminal', 'reconcile_runtime', 'succeeded', 2, 5, null, null, $2, 'runtime_v4', 'restart', 'pre_effect', null, null, null, $2, $2)`,
      ["tenant_v4_worker_upgrade", timestamp],
    );
    await applyMigrations(pool, migrationsDirectory);
    const rows = await db.selectFrom("worker_jobs").select(["job_id", "status", "runtime_command", "target_command_version", "lease_owner", "lease_expires_at", "attempt_count", "last_error_summary"]).where("tenant_id", "=", "tenant_v4_worker_upgrade").orderBy("job_id").execute();
    assert.deepEqual(rows, [
      { job_id: "job_v4_active", status: "failed", runtime_command: "stop", target_command_version: null, lease_owner: null, lease_expires_at: null, attempt_count: 1, last_error_summary: "Legacy reconcile command version unavailable after schema upgrade" },
      { job_id: "job_v4_terminal", status: "succeeded", runtime_command: "restart", target_command_version: null, lease_owner: null, lease_expires_at: null, attempt_count: 2, last_error_summary: null },
    ]);
  } finally {
    await rm(v4Directory, { recursive: true, force: true });
  }
});

test("latest schema upgrades a genuine v5 database through the version 6 Worker attempt fence", async () => {
  const v5Directory = await mkdtemp(join(tmpdir(), "core-agent-v5-migrations-"));
  await cp(migrationsDirectory, v5Directory, { recursive: true });
  await rm(join(v5Directory, "006_worker_job_attempt_fence.sql"));
  await rm(join(v5Directory, "007_agent_run_claim_indexes.sql"));
  await rm(join(v5Directory, "008_outbox_exhausted_recovery_index.sql"));
  try {
    await applyMigrations(pool, v5Directory);
    assert.equal(await readSchemaVersion(db), 5);
    await seedTenant("tenant_v5_attempt_upgrade");
    const timestamp = new Date("2026-08-04T00:00:00.000Z");
    await pool.query(
      `insert into worker_jobs (
        tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
        lease_expires_at, next_attempt_at, payload_ref, runtime_command, target_command_version,
        effect_state, last_error_summary, run_id, container_id, created_at, updated_at
      ) values ($1, 'job_v5_final', 'execute_agent_run', 'running', 3, 3, 'worker_v5', $2, $2, 'run_v5', null, null, 'unsafe_to_replay', null, null, null, $2, $2)`,
      ["tenant_v5_attempt_upgrade", timestamp],
    );
    await applyMigrations(pool, migrationsDirectory);
    assert.equal(await readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
    await assert.rejects(
      db.updateTable("worker_jobs").set({ attempt_count: 4 }).where("tenant_id", "=", "tenant_v5_attempt_upgrade").where("job_id", "=", "job_v5_final").execute(),
      /worker_jobs_attempt_count_max_check/,
    );
  } finally {
    await rm(v5Directory, { recursive: true, force: true });
  }
});

test("version 6 fails closed when genuine v5 storage already exceeds the Worker attempt fence", async () => {
  const v5Directory = await mkdtemp(join(tmpdir(), "core-agent-v5-invalid-migrations-"));
  await cp(migrationsDirectory, v5Directory, { recursive: true });
  await rm(join(v5Directory, "006_worker_job_attempt_fence.sql"));
  await rm(join(v5Directory, "007_agent_run_claim_indexes.sql"));
  await rm(join(v5Directory, "008_outbox_exhausted_recovery_index.sql"));
  try {
    await applyMigrations(pool, v5Directory);
    await seedTenant("tenant_v5_invalid_attempt");
    const timestamp = new Date("2026-08-04T00:00:00.000Z");
    await pool.query(
      `insert into worker_jobs (
        tenant_id, job_id, job_kind, status, attempt_count, max_attempts, lease_owner,
        lease_expires_at, next_attempt_at, payload_ref, runtime_command, target_command_version,
        effect_state, last_error_summary, run_id, container_id, created_at, updated_at
      ) values ($1, 'job_v5_invalid', 'execute_agent_run', 'running', 4, 3, 'worker_v5', $2, $2, 'run_v5', null, null, 'unsafe_to_replay', null, null, null, $2, $2)`,
      ["tenant_v5_invalid_attempt", timestamp],
    );
    await assert.rejects(applyMigrations(pool, migrationsDirectory), /worker_jobs_attempt_count_max_check/);
    assert.equal(await readSchemaVersion(db), 5);
  } finally {
    await rm(v5Directory, { recursive: true, force: true });
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
