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
  const hasTenantId = (await pool.query<{ exists: boolean }>(
    `select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'actors' and column_name = 'tenant_id'
    ) as exists`,
  )).rows[0]?.exists === true;
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  if (hasTenantId) {
    await pool.query(
      `insert into actors (
        tenant_id, actor_id, schema_version, resource_version, actor_kind,
        display_name, status, created_at, updated_at
      ) values ($1, $2, 1, 1, 'service', 'Synthetic service', 'active', $3, $3)`,
      [tenantId, actorId, timestamp],
    );
    return;
  }
  await pool.query(
    `insert into actors (
      actor_id, schema_version, resource_version, actor_kind,
      display_name, status, created_at, updated_at
    ) values ($1, 1, 1, 'service', 'Synthetic service', 'active', $2, $2)`,
    [actorId, timestamp],
  );
}

async function applyThroughSchema9(): Promise<string> {
  const v9Directory = await mkdtemp(join(tmpdir(), "core-agent-v9-migrations-"));
  await cp(migrationsDirectory, v9Directory, { recursive: true });
  await rm(join(v9Directory, "010_identity_authority.sql"), { force: true });
  await applyMigrations(pool, v9Directory);
  assert.equal(await readSchemaVersion(db), 9);
  return v9Directory;
}

async function seedLegacyGlobalActorGraph(): Promise<void> {
  const timestamp = new Date("2026-08-10T00:00:00.000Z");
  await pool.query(
    `insert into tenants (
      tenant_id, schema_version, resource_version, tenant_mode, status,
      display_name, created_at, updated_at
    ) values
      ('tenant_global_a', 1, 1, 'b2b', 'active', 'Global A', $1, $1),
      ('tenant_global_b', 1, 1, 'b2c', 'active', 'Global B', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into actors (
      tenant_id, actor_id, schema_version, resource_version, actor_kind,
      display_name, status, created_at, updated_at
    ) values
      ('tenant_global_a', 'actor_global', 1, 1, 'human', 'Stable Human', 'active', $1, $1),
      ('tenant_global_b', 'actor_global', 1, 3, 'human', 'Stable Human', 'active', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into memberships (
      tenant_id, membership_id, actor_id, schema_version, resource_version,
      roles, seat_ref, status, created_at, updated_at
    ) values
      ('tenant_global_a', 'membership_global_a', 'actor_global', 1, 1, array['consultant'], null, 'active', $1, $1),
      ('tenant_global_b', 'membership_global_b', 'actor_global', 1, 1, array['student'], null, 'revoked', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into profiles (
      tenant_id, profile_id, schema_version, resource_version, owner_actor_id,
      profile_kind, hermes_profile_ref, description, status, provider_config_id,
      model_id, created_at, updated_at
    ) values
      ('tenant_global_a', 'profile_global_a', 1, 1, 'actor_global', 'consultant', 'profile_global_a', 'A', 'active', 'provider', 'model', $1, $1),
      ('tenant_global_b', 'profile_global_b', 1, 1, 'actor_global', 'default', 'profile_global_b', 'B', 'active', 'provider', 'model', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into conversations (
      tenant_id, conversation_id, profile_id, created_by_actor_id, status,
      schema_version, resource_version, student_ref, case_ref, created_at, updated_at
    ) values
      ('tenant_global_a', 'conversation_global_a', 'profile_global_a', 'actor_global', 'active', 1, 1, null, null, $1, $1),
      ('tenant_global_b', 'conversation_global_b', 'profile_global_b', 'actor_global', 'active', 1, 1, null, null, $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into sessions (
      tenant_id, session_id, profile_id, actor_id, conversation_id, schema_version,
      resource_version, status, last_active_at, expires_at, hermes_session_ref,
      created_at, updated_at
    ) values
      ('tenant_global_a', 'agent_session_global_a', 'profile_global_a', 'actor_global', 'conversation_global_a', 1, 1, 'active', $1, $2, 'hermes_global_a', $1, $1),
      ('tenant_global_b', 'agent_session_global_b', 'profile_global_b', 'actor_global', 'conversation_global_b', 1, 1, 'active', $1, $2, 'hermes_global_b', $1, $1)`,
    [timestamp, new Date("2026-09-10T00:00:00.000Z")],
  );
  await pool.query(
    `insert into audit_events (
      tenant_id, audit_event_id, schema_version, occurred_at, actor_id, membership_id,
      effective_role, action, resource_type, resource_id, decision, outcome, request_id,
      trace_id, reason_summary, event_json
    ) values
      ('tenant_global_a', 'audit_global_a', 1, $1, 'actor_global', 'membership_global_a', 'consultant', 'test', 'actor', 'actor_global', 'allowed', 'succeeded', 'request_a', 'trace_a', 'test', '{}'::jsonb),
      ('tenant_global_b', 'audit_global_b', 1, $1, 'actor_global', 'membership_global_b', 'student', 'test', 'actor', 'actor_global', 'allowed', 'succeeded', 'request_b', 'trace_b', 'test', '{}'::jsonb)`,
    [timestamp],
  );
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

test("empty database migrates exactly to schema version 10 with identity authority", async () => {
  await applyMigrations(pool, migrationsDirectory);

  assert.equal(EXPECTED_SCHEMA_VERSION, 10);
  assert.equal(await readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  await assert.doesNotReject(assertSchemaVersion(db, EXPECTED_SCHEMA_VERSION));
  await assert.rejects(assertSchemaVersion(db, 3), /ahead/);
  await assert.rejects(assertSchemaVersion(db, 11), /behind/);
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
  const agentRunFailureColumn = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'agent_runs' and column_name = 'failure_code'
  `.execute(db);
  assert.deepEqual(agentRunFailureColumn.rows, [{ column_name: "failure_code" }]);
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

test("schema 10 fails closed for every contradictory legacy global Actor fact", async () => {
  const contradictions = [
    ["actor_kind", "human"],
    ["status", "disabled"],
    ["display_name", "Different Human"],
  ] as const;
  for (const [column, value] of contradictions) {
    await resetDatabase();
    const v9Directory = await applyThroughSchema9();
    try {
      await seedTenant(`tenant_conflict_${column}_a`);
      await seedTenant(`tenant_conflict_${column}_b`);
      await seedActor(`tenant_conflict_${column}_a`, "actor_conflict");
      await seedActor(`tenant_conflict_${column}_b`, "actor_conflict");
      await pool.query(
        `update actors set ${column} = $1 where tenant_id = $2 and actor_id = 'actor_conflict'`,
        [value, `tenant_conflict_${column}_b`],
      );

      await assert.rejects(applyMigrations(pool, migrationsDirectory), /contradictory legacy Actor facts/);
      assert.equal(await readSchemaVersion(db), 9);
      assert.equal((await pool.query("select count(*)::int as count from actors where actor_id = 'actor_conflict'")).rows[0]?.count, 2);
    } finally {
      await rm(v9Directory, { recursive: true, force: true });
    }
  }
});

test("schema 10 fails closed for legacy cross-Tenant ordinary Membership authority", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    const timestamp = new Date("2026-08-10T00:00:00.000Z");
    await pool.query(
      `insert into tenants (
        tenant_id, schema_version, resource_version, tenant_mode, status,
        display_name, created_at, updated_at
      ) values
        ('tenant_legacy_authority_a', 1, 1, 'b2b', 'active', 'Legacy Authority A', $1, $1),
        ('tenant_legacy_authority_b', 1, 1, 'b2b', 'active', 'Legacy Authority B', $1, $1)`,
      [timestamp],
    );
    await pool.query(
      `insert into actors (
        tenant_id, actor_id, schema_version, resource_version, actor_kind,
        display_name, status, created_at, updated_at
      ) values
        ('tenant_legacy_authority_a', 'actor_legacy_authority', 1, 1, 'human', 'Legacy Human', 'active', $1, $1),
        ('tenant_legacy_authority_b', 'actor_legacy_authority', 1, 1, 'human', 'Legacy Human', 'active', $1, $1)`,
      [timestamp],
    );
    await pool.query(
      `insert into memberships (
        tenant_id, membership_id, actor_id, schema_version, resource_version,
        roles, seat_ref, status, created_at, updated_at
      ) values
        ('tenant_legacy_authority_a', 'membership_legacy_authority_a', 'actor_legacy_authority', 1, 1, array['consultant'], null, 'active', $1, $1),
        ('tenant_legacy_authority_b', 'membership_legacy_authority_b', 'actor_legacy_authority', 1, 1, array['consultant'], null, 'invited', $1, $1)`,
      [timestamp],
    );

    await assert.rejects(
      applyMigrations(pool, migrationsDirectory),
      /legacy ordinary Membership authority conflict/,
    );
    assert.equal(await readSchemaVersion(db), 9);
    assert.equal((await pool.query(
      "select count(*)::int as count from memberships where actor_id = 'actor_legacy_authority'",
    )).rows[0]?.count, 2);
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("schema 10 collapses consistent Actors and preserves every legacy Actor foreign key", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await seedLegacyGlobalActorGraph();

    await applyMigrations(pool, migrationsDirectory);

    assert.equal(await readSchemaVersion(db), 10);
    const actors = await pool.query("select * from actors where actor_id = 'actor_global'");
    assert.equal(actors.rowCount, 1);
    assert.equal("tenant_id" in actors.rows[0], false);
    assert.equal(actors.rows[0]?.resource_version, "3");
    const preserved = await pool.query<{ relation: string; count: number }>(
      `select 'memberships' as relation, count(*)::int as count from memberships where actor_id = 'actor_global'
       union all select 'profiles', count(*)::int from profiles where owner_actor_id = 'actor_global'
       union all select 'conversations', count(*)::int from conversations where created_by_actor_id = 'actor_global'
       union all select 'sessions', count(*)::int from sessions where actor_id = 'actor_global'
       union all select 'audit_events', count(*)::int from audit_events where actor_id = 'actor_global'
       order by relation`,
    );
    assert.deepEqual(preserved.rows, [
      { relation: "audit_events", count: 2 },
      { relation: "conversations", count: 2 },
      { relation: "memberships", count: 2 },
      { relation: "profiles", count: 2 },
      { relation: "sessions", count: 2 },
    ]);
    const sources = await pool.query("select tenant_id, membership_source from memberships order by tenant_id");
    assert.deepEqual(sources.rows, [
      { tenant_id: "tenant_global_a", membership_source: "company" },
      { tenant_id: "tenant_global_b", membership_source: "self" },
    ]);
    const sourceColumn = await pool.query(
      `select is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'memberships' and column_name = 'membership_source'`,
    );
    assert.deepEqual(sourceColumn.rows, [{ is_nullable: "NO", column_default: null }]);
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("schema 10 preserves Tenant foreign keys after replacing composite Actor foreign keys", async () => {
  await applyMigrations(pool, migrationsDirectory);

  const tenantForeignKeys = await pool.query<{ relation: string }>(
    `select distinct child.relname as relation
     from pg_constraint as fk
     join pg_class as child on child.oid = fk.conrelid
     join pg_class as parent on parent.oid = fk.confrelid
     join unnest(fk.conkey) as key(attnum) on true
     join pg_attribute as attribute
       on attribute.attrelid = child.oid and attribute.attnum = key.attnum
     where fk.contype = 'f'
       and child.relname = any($1::text[])
       and attribute.attname = 'tenant_id'
       and parent.relname <> 'actors'
     order by relation`,
    [["memberships", "profiles", "conversations", "sessions", "audit_events"]],
  );
  assert.deepEqual(tenantForeignKeys.rows.map((row) => row.relation), [
    "audit_events",
    "conversations",
    "memberships",
    "profiles",
    "sessions",
  ]);

  const directTenantForeignKeys = await pool.query<{ relation: string; definition: string }>(
    `select child.relname as relation, pg_get_constraintdef(fk.oid) as definition
     from pg_constraint as fk
     join pg_class as child on child.oid = fk.conrelid
     join pg_class as parent on parent.oid = fk.confrelid
     where fk.contype = 'f'
       and child.relname = any($1::text[])
       and parent.relname = 'tenants'
     order by relation`,
    [["memberships", "profiles"]],
  );
  assert.deepEqual(directTenantForeignKeys.rows, [
    { relation: "memberships", definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)" },
    { relation: "profiles", definition: "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)" },
  ]);
});

test("ordinary Membership authority has an actor-leading partial index", async () => {
  await applyMigrations(pool, migrationsDirectory);

  const index = await pool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
     where schemaname = 'public' and indexname = 'memberships_ordinary_actor_authority_idx'`,
  );
  assert.equal(index.rowCount, 1);
  assert.match(index.rows[0]!.indexdef, /USING btree \(actor_id, tenant_id, membership_id\)/);
  assert.match(index.rows[0]!.indexdef, /WHERE \(\(membership_source <> 'platform'::text\) AND \(status = ANY \(ARRAY\['active'::text, 'invited'::text\]\)\)\)/);
});

test("schema 10 creates private authority tables without PUBLIC read grants and admits future jobs", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await seedTenant("tenant_identity_tables");
    await applyMigrations(pool, migrationsDirectory);
    const expectedTables = [
      "account_deletions",
      "auth_subjects",
      "core_sessions",
      "identity_invitations",
      "oauth_transactions",
      "platform_role_assignments",
      "private_identity_pii",
      "public_rate_limits",
    ];
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[]) order by table_name`,
      [expectedTables],
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), expectedTables);
    const publicReads = await pool.query(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'PUBLIC'
         and table_name = any($1::text[]) and privilege_type = 'SELECT'`,
      [expectedTables],
    );
    assert.deepEqual(publicReads.rows, []);
    const timestamp = new Date("2026-08-10T00:00:00.000Z");
    for (const jobKind of ["project_platform_memberships", "finalize_account_deletion"]) {
      await pool.query(
        `insert into worker_jobs (
          tenant_id, job_id, job_kind, status, attempt_count, max_attempts,
          lease_owner, lease_expires_at, next_attempt_at, payload_ref,
          runtime_command, target_command_version, effect_state, last_error_summary,
          run_id, container_id, created_at, updated_at
        ) values ($1, $2, $3, 'queued', 0, 5, null, null, $4, $5, null, null, 'pre_effect', null, null, null, $4, $4)`,
        ["tenant_identity_tables", `job_${jobKind}`, jobKind, timestamp, `payload_${jobKind}`],
      );
    }
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("deferred ordinary Membership authority serializes concurrent cross-Tenant invitations", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const timestamp = new Date("2026-08-10T00:00:00.000Z");
  await pool.query(
    `insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
     values ('tenant_race_a', 1, 1, 'b2b', 'active', 'Race A', $1, $1),
            ('tenant_race_b', 1, 1, 'b2b', 'active', 'Race B', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
     values ('actor_race', 1, 1, 'human', 'Race', 'active', $1, $1)`,
    [timestamp],
  );
  const clients = [await pool.connect(), await pool.connect()];
  try {
    await Promise.all(clients.map((client) => client.query("begin")));
    await Promise.all(clients.map((client, index) => client.query(
      `insert into memberships (
        tenant_id, membership_id, actor_id, schema_version, resource_version, roles,
        membership_source, seat_ref, status, created_at, updated_at
      ) values ($1, $2, 'actor_race', 1, 1, array['consultant'], 'company', null, 'invited', $3, $3)`,
      [`tenant_race_${index === 0 ? "a" : "b"}`, `membership_race_${index}`, timestamp],
    )));
    const commits = await Promise.allSettled(clients.map((client) => client.query("commit")));
    assert.equal(commits.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(commits.filter((result) => result.status === "rejected").length, 1);
    assert.match(String(commits.find((result) => result.status === "rejected")?.reason), /ordinary Membership authority conflict/);
    assert.equal((await pool.query(
      "select count(*)::int as count from memberships where actor_id = 'actor_race' and status in ('active', 'invited')",
    )).rows[0]?.count, 1);
  } finally {
    await Promise.allSettled(clients.map((client) => client.query("rollback")));
    clients.forEach((client) => client.release());
  }
});

test("platform Memberships may span multiple B2B Tenants", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const timestamp = new Date("2026-08-10T00:00:00.000Z");
  await pool.query(
    `insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
     values ('tenant_platform_a', 1, 1, 'b2b', 'active', 'Platform A', $1, $1),
            ('tenant_platform_b', 1, 1, 'b2b', 'active', 'Platform B', $1, $1)`,
    [timestamp],
  );
  await pool.query(
    `insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
     values ('actor_platform', 1, 1, 'human', 'Platform', 'active', $1, $1)`,
    [timestamp],
  );
  await assert.doesNotReject(pool.query(
    `insert into memberships (
      tenant_id, membership_id, actor_id, schema_version, resource_version, roles,
      membership_source, seat_ref, status, created_at, updated_at
    ) values
      ('tenant_platform_a', 'membership_platform_a', 'actor_platform', 1, 1, array['admin'], 'platform', null, 'active', $1, $1),
      ('tenant_platform_b', 'membership_platform_b', 'actor_platform', 1, 1, array['admin'], 'platform', null, 'active', $1, $1)`,
    [timestamp],
  ));
});

test("schema 10 upgrades a genuine v7 database and supports Worker claim plans", { timeout: 10_000 }, async () => {
  const v7Directory = await mkdtemp(join(tmpdir(), "core-agent-v7-migrations-"));
  await cp(migrationsDirectory, v7Directory, { recursive: true });
  await rm(join(v7Directory, "008_outbox_exhausted_recovery_index.sql"));
  await rm(join(v7Directory, "009_agent_run_failure_code.sql"));
  await rm(join(v7Directory, "010_identity_authority.sql"));
  try {
    await applyMigrations(pool, v7Directory);
    assert.equal(await readSchemaVersion(db), 7);
    await applyMigrations(pool, migrationsDirectory);
    assert.equal(await readSchemaVersion(db), 10);

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

test("schema 10 backfills failed Runs and enforces failure code state", async () => {
  const v8Directory = await mkdtemp(join(tmpdir(), "core-agent-v8-migrations-"));
  await cp(migrationsDirectory, v8Directory, { recursive: true });
  await rm(join(v8Directory, "009_agent_run_failure_code.sql"));
  await rm(join(v8Directory, "010_identity_authority.sql"));
  try {
    await applyMigrations(pool, v8Directory);
    assert.equal(await readSchemaVersion(db), 8);
    const tenantId = "tenant_v8_failure_upgrade";
    const actorId = `actor_${tenantId}`;
    const profileId = "profile_v8_failure_upgrade";
    const conversationId = "conversation_v8_failure_upgrade";
    const createdAt = new Date("2026-08-07T00:00:00.000Z");
    await seedTenant(tenantId);
    await seedActor(tenantId, actorId);
    await seedProfile(tenantId, profileId);
    await db.insertInto("conversations").values({
      tenant_id: tenantId,
      conversation_id: conversationId,
      profile_id: profileId,
      created_by_actor_id: actorId,
      status: "active",
      schema_version: 1,
      resource_version: 1,
      student_ref: null,
      case_ref: null,
      created_at: createdAt,
      updated_at: createdAt,
    }).execute();
    await db.insertInto("agent_runs").values([
      {
        tenant_id: tenantId, run_id: "run_v8_failed", conversation_id: conversationId,
        request_id: "request_v8_failed", trace_id: "trace_v8_failed",
        client_request_id: "client_v8_failed", idempotency_key: "idem_v8_failed",
        parent_run_id: null, schema_version: 1, resource_version: 1, status: "failed",
        started_at: createdAt, finished_at: createdAt, failure_summary: "Legacy failure",
        created_at: createdAt, updated_at: createdAt,
      },
      {
        tenant_id: tenantId, run_id: "run_v8_succeeded", conversation_id: conversationId,
        request_id: "request_v8_succeeded", trace_id: "trace_v8_succeeded",
        client_request_id: "client_v8_succeeded", idempotency_key: "idem_v8_succeeded",
        parent_run_id: null, schema_version: 1, resource_version: 1, status: "succeeded",
        started_at: createdAt, finished_at: createdAt, failure_summary: null,
        created_at: createdAt, updated_at: createdAt,
      },
    ]).execute();

    await applyMigrations(pool, migrationsDirectory);

    const rows = await pool.query<{ run_id: string; failure_code: string | null }>(
      "select run_id, failure_code from agent_runs where tenant_id = $1 order by run_id",
      [tenantId],
    );
    assert.deepEqual(rows.rows, [
      { run_id: "run_v8_failed", failure_code: "RUN_FAILURE_UNKNOWN" },
      { run_id: "run_v8_succeeded", failure_code: null },
    ]);
    await assert.rejects(
      pool.query("update agent_runs set failure_code = null where tenant_id = $1 and run_id = 'run_v8_failed'", [tenantId]),
      /agent_runs_failure_code_state_check/,
    );
    await assert.rejects(
      pool.query("update agent_runs set failure_code = 'RUN_INTERNAL_ERROR' where tenant_id = $1 and run_id = 'run_v8_succeeded'", [tenantId]),
      /agent_runs_failure_code_state_check/,
    );
    await assert.rejects(
      pool.query("update agent_runs set failure_code = 'PROVIDER_503' where tenant_id = $1 and run_id = 'run_v8_failed'", [tenantId]),
      /agent_runs_failure_code_allowlist_check/,
    );
  } finally {
    await rm(v8Directory, { recursive: true, force: true });
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
  await rm(join(legacyDirectory, "009_agent_run_failure_code.sql"));
  await rm(join(legacyDirectory, "010_identity_authority.sql"));
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
  await rm(join(v4Directory, "009_agent_run_failure_code.sql"));
  await rm(join(v4Directory, "010_identity_authority.sql"));
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
  await rm(join(v5Directory, "009_agent_run_failure_code.sql"));
  await rm(join(v5Directory, "010_identity_authority.sql"));
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
  await rm(join(v5Directory, "009_agent_run_failure_code.sql"));
  await rm(join(v5Directory, "010_identity_authority.sql"));
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
