import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool, type PoolClient } from "pg";
import { ProductEventSchema } from "@core-agent/contracts";
import Schema from "typebox/schema";

import { applyMigrations, migrationTestInternals } from "../src/db/migrate.js";
import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import {
  assertSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  readSchemaVersion,
} from "../src/db/schema-version.js";

const testDatabaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const identityTables = [
  "account_deletions",
  "auth_subjects",
  "core_sessions",
  "email_verification_transactions",
  "identity_invitations",
  "oauth_transactions",
  "platform_role_assignments",
  "private_identity_pii",
  "public_rate_limits",
] as const;
const identityPrivilegeMatrix = Object.freeze({
  tenants: ["SELECT", "INSERT", "UPDATE"],
  actors: ["SELECT", "INSERT", "UPDATE"],
  memberships: ["SELECT", "INSERT", "UPDATE"],
  profiles: ["SELECT", "INSERT", "UPDATE"],
  auth_subjects: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  private_identity_pii: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  platform_role_assignments: ["SELECT", "INSERT", "UPDATE"],
  identity_invitations: ["SELECT", "INSERT", "UPDATE"],
  oauth_transactions: ["SELECT", "INSERT", "UPDATE"],
  core_sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  email_verification_transactions: ["SELECT", "INSERT", "UPDATE"],
  account_deletions: ["SELECT", "INSERT", "UPDATE"],
  public_rate_limits: ["SELECT", "INSERT", "UPDATE"],
  idempotency_records: ["SELECT", "INSERT", "UPDATE"],
  product_events: ["SELECT", "INSERT"],
  audit_events: ["SELECT", "INSERT"],
  outbox: ["SELECT", "INSERT"],
  stream_sequences: ["SELECT", "INSERT", "UPDATE"],
  worker_jobs: ["SELECT", "INSERT"],
} as const);
const identityColumnShape = {
  account_deletions: [
    "account_deletion_id:text:NO", "actor_id:text:NO", "status:text:NO",
    "requested_at:timestamptz:NO", "scheduled_for:timestamptz:NO", "cancelled_at:timestamptz:YES",
    "deleted_at:timestamptz:YES", "resource_version:int8:NO", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  auth_subjects: [
    "auth_subject_id:text:NO", "actor_id:text:NO", "provider:text:NO", "provider_subject:text:NO",
    "provider_identity_kind:text:NO", "verified_at:timestamptz:NO", "status:text:NO",
    "resource_version:int8:NO", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  core_sessions: [
    "session_id:text:NO", "secret_digest:bytea:NO", "csrf_digest:bytea:YES", "actor_id:text:NO",
    "auth_subject_id:text:NO", "client_kind:text:NO", "status:text:NO", "device_label:text:YES",
    "created_at:timestamptz:NO", "last_seen_at:timestamptz:NO", "idle_expires_at:timestamptz:NO",
    "absolute_expires_at:timestamptz:NO", "reauthenticated_at:timestamptz:YES", "revocation_reason:text:YES",
    "resource_version:int8:NO", "updated_at:timestamptz:NO",
  ],
  email_verification_transactions: [
    "email_verification_transaction_id:text:NO", "start_idempotency_key:text:NO", "start_payload_hash:text:NO",
    "normalized_email_hmac:bytea:NO", "binding_ciphertext:bytea:NO", "verified_provider_subject_hmac:bytea:YES",
    "status:text:NO", "expires_at:timestamptz:NO", "consumed_at:timestamptz:YES",
    "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  identity_invitations: [
    "invitation_id:text:NO", "tenant_id:text:NO", "membership_id:text:NO", "invited_by_actor_id:text:NO",
    "role:text:NO", "secret_digest:bytea:NO", "normalized_email_hmac:bytea:NO", "status:text:NO",
    "expires_at:timestamptz:NO", "accepted_actor_id:text:YES", "accepted_at:timestamptz:YES",
    "replaced_by_invitation_id:text:YES", "resource_version:int8:NO", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  oauth_transactions: [
    "oauth_transaction_id:text:NO", "provider:text:NO", "flow_kind:text:NO", "actor_id:text:YES",
    "client_kind:text:NO", "state_digest:bytea:NO", "nonce_digest:bytea:NO", "pkce_verifier_ciphertext:bytea:NO",
    "redirect_uri:text:NO", "status:text:NO", "expires_at:timestamptz:NO", "consumed_at:timestamptz:YES",
    "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  platform_role_assignments: [
    "platform_role_assignment_id:text:NO", "actor_id:text:NO", "role:text:NO", "status:text:NO",
    "resource_version:int8:NO", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  private_identity_pii: [
    "actor_id:text:NO", "normalized_email_hmac:bytea:NO", "encrypted_email:bytea:NO",
    "encryption_key_ref:text:NO", "created_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
  public_rate_limits: [
    "bucket_kind:text:NO", "account_identifier_hmac:bytea:NO", "client_identifier_hmac:bytea:NO",
    "window_started_at:timestamptz:NO", "request_count:int4:NO", "expires_at:timestamptz:NO", "updated_at:timestamptz:NO",
  ],
} as const;

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

async function probeRelationSemantics(sqlText: string, names: readonly string[]): Promise<unknown[]> {
  await pool.query("begin");
  try {
    await pool.query(sqlText);
    return (await pool.query(`
      select namespace.nspname as schema, relation.relname as name, relation.relkind as relkind,
        case when relation.relkind in ('v', 'm') then pg_get_viewdef(relation.oid, true) else '' end as definition,
        case when relation.relkind = 'p' then pg_get_partkeydef(relation.oid) else '' end as "partitionKey",
        coalesce(parent_namespace.nspname || '.' || parent.relname, '') as parent,
        case when relation.relispartition then pg_get_expr(relation.relpartbound, relation.oid, true) else '' end as bound,
        coalesce(format_type(sequence.seqtypid, null), '') as "dataType",
        coalesce(sequence.seqstart::text, '') as start, coalesce(sequence.seqincrement::text, '') as increment,
        coalesce(sequence.seqmin::text, '') as min, coalesce(sequence.seqmax::text, '') as max,
        coalesce(sequence.seqcache::text, '') as cache, coalesce(sequence.seqcycle, false) as cycle
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      left join pg_inherits inheritance on inheritance.inhrelid = relation.oid
      left join pg_class parent on parent.oid = inheritance.inhparent
      left join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
      left join pg_sequence sequence on sequence.seqrelid = relation.oid
      where namespace.nspname = 'public' and relation.relname = any($1::text[])
      order by relation.relname
    `, [names])).rows;
  } finally {
    await pool.query("rollback");
  }
}

async function ensureIdentityTestRoles(): Promise<void> {
  await pool.query(`do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then
        create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then
        create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'core_agent_migrator') then
        create role core_agent_migrator nologin nosuperuser nocreatedb nocreaterole noinherit;
      end if;
    end
  $$`);
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
  await applyMigrationPrefix(v9Directory, 9);
  assert.equal(await readSchemaVersion(db), 9);
  return v9Directory;
}

async function applyMigrationPrefix(directory: string, maximumVersion: number): Promise<void> {
  for (const filename of await readdir(directory)) {
    const version = /^([0-9]{3,})_/u.exec(filename)?.[1];
    if (version !== undefined && Number(version) > maximumVersion) {
      await rm(join(directory, filename));
    }
  }
  await migrationTestInternals.applyMigrationsWithManifests(
    pool,
    directory,
    new Map([...migrationTestInternals.schemaManifests].filter(([version]) => version <= maximumVersion)),
  );
}

async function seedLegacyProvisioner(tenantIds: readonly string[], membershipId = "core_agent_provisioner_admin"): Promise<void> {
  const timestamp = new Date("2026-08-10T00:00:00.000Z");
  for (const tenantId of tenantIds) {
    await pool.query(
      `insert into tenants (
        tenant_id, schema_version, resource_version, tenant_mode, status,
        display_name, created_at, updated_at
      ) values ($1, 1, 1, 'b2b', 'active', $2, $3, $3)`,
      [tenantId, `Legacy ${tenantId}`, timestamp],
    );
    await pool.query(
      `insert into actors (
        tenant_id, actor_id, schema_version, resource_version, actor_kind,
        display_name, status, created_at, updated_at
      ) values ($1, 'core_agent_provisioner', 1, 1, 'service', 'Core Agent Provisioner', 'active', $2, $2)`,
      [tenantId, timestamp],
    );
    await pool.query(
      `insert into memberships (
        tenant_id, membership_id, actor_id, schema_version, resource_version,
        roles, seat_ref, status, created_at, updated_at
      ) values ($1, $2, 'core_agent_provisioner', 1, 1, array['admin'], null, 'active', $3, $3)`,
      [tenantId, membershipId, timestamp],
    );
  }
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

test.before(async () => {
  await ensureIdentityTestRoles();
});

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await db.destroy();
});

test("empty database migrates exactly to schema version 12 with durable email verification transactions", async () => {
  await applyMigrations(pool, migrationsDirectory);

  assert.equal(EXPECTED_SCHEMA_VERSION, 12);
  assert.equal(await readSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  await assert.doesNotReject(assertSchemaVersion(db, EXPECTED_SCHEMA_VERSION));
  await assert.rejects(assertSchemaVersion(db, 3), /ahead/);
  await assert.rejects(assertSchemaVersion(db, 13), /behind/);
  const emailVerificationColumns = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'email_verification_transactions'
    order by ordinal_position
  `.execute(db);
  assert.deepEqual(emailVerificationColumns.rows.map((row) => row.column_name), [
    "email_verification_transaction_id",
    "start_idempotency_key",
    "start_payload_hash",
    "normalized_email_hmac",
    "binding_ciphertext",
    "verified_provider_subject_hmac",
    "status",
    "expires_at",
    "consumed_at",
    "created_at",
    "updated_at",
  ]);
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

test("schema 12 upgrades schema 10 through password reset and email verification without changing oauth ACLs", async () => {
  const v10Directory = await mkdtemp(join(tmpdir(), "core-agent-v10-migrations-"));
  try {
    await cp(migrationsDirectory, v10Directory, { recursive: true });
    await applyMigrationPrefix(v10Directory, 10);
    assert.equal(await readSchemaVersion(db), 10);
    await pool.query(`insert into oauth_transactions (
      oauth_transaction_id, provider, flow_kind, actor_id, client_kind,
      state_digest, nonce_digest, pkce_verifier_ciphertext, redirect_uri,
      status, expires_at, consumed_at, created_at, updated_at
    ) values (
      'oauth_v10_existing', 'supabase', 'apple_sign_in', null, 'web',
      decode(repeat('01', 32), 'hex'), decode(repeat('02', 32), 'hex'), decode('03', 'hex'),
      'https://app.example.test/auth/callback', 'pending', now() + interval '10 minutes', null, now(), now()
    )`);
    const readAcl = async () => (await pool.query<{ readonly acl: string | null }>(
      `select relation.relacl::text as acl
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'public' and relation.relname = 'oauth_transactions'`,
    )).rows;
    const aclBefore = await readAcl();

    await applyMigrations(pool, migrationsDirectory);
    assert.equal(await readSchemaVersion(db), 12);
    assert.deepEqual(await readAcl(), aclBefore);
    assert.equal((await pool.query(
      "select count(*)::int as count from oauth_transactions where oauth_transaction_id = 'oauth_v10_existing'",
    )).rows[0]?.count, 1);
    await pool.query(`insert into oauth_transactions (
      oauth_transaction_id, provider, flow_kind, actor_id, client_kind,
      state_digest, nonce_digest, pkce_verifier_ciphertext, redirect_uri,
      status, expires_at, consumed_at, created_at, updated_at
    ) values (
      'oauth_v11_password_reset', 'supabase', 'password_reset', null, 'web',
      decode(repeat('04', 32), 'hex'), decode(repeat('05', 32), 'hex'), decode('06', 'hex'),
      'https://app.example.test/auth/reset', 'pending', now() + interval '10 minutes', null, now(), now()
    )`);
    await assert.rejects(
      pool.query(`insert into oauth_transactions (
        oauth_transaction_id, provider, flow_kind, actor_id, client_kind,
        state_digest, nonce_digest, pkce_verifier_ciphertext, redirect_uri,
        status, expires_at, consumed_at, created_at, updated_at
      ) values (
        'oauth_v11_invalid', 'supabase', 'invalid_flow', null, 'web',
        decode(repeat('07', 32), 'hex'), decode(repeat('08', 32), 'hex'), decode('09', 'hex'),
        'https://app.example.test/auth/reset', 'pending', now() + interval '10 minutes', null, now(), now()
      )`),
      /oauth_transactions_flow_kind_check/u,
    );
    assert.equal((await pool.query(
      `select pg_get_constraintdef(oid, true) as definition
       from pg_constraint where conname = 'oauth_transactions_flow_kind_check'`,
    )).rows[0]?.definition, "CHECK (flow_kind = ANY (ARRAY['apple_sign_in'::text, 'apple_link'::text, 'password_reset'::text]))");

    await applyMigrations(pool, migrationsDirectory);
    assert.equal((await pool.query(
      "select count(*)::int as count from core_agent_schema_migrations where version = 11",
    )).rows[0]?.count, 1);
    assert.equal((await pool.query(
      "select count(*)::int as count from core_agent_schema_migrations where version = 12",
    )).rows[0]?.count, 1);
  } finally {
    await rm(v10Directory, { recursive: true, force: true });
  }
});

test("schema 11 catalog rejection rolls back its constraint change and migration record", async () => {
  const v10Directory = await mkdtemp(join(tmpdir(), "core-agent-v10-rollback-base-"));
  const invalidDirectory = await mkdtemp(join(tmpdir(), "core-agent-v11-rollback-"));
  try {
    await cp(migrationsDirectory, v10Directory, { recursive: true });
    await applyMigrationPrefix(v10Directory, 10);
    await cp(migrationsDirectory, invalidDirectory, { recursive: true });
    const migrationPath = join(invalidDirectory, "011_password_reset_transactions.sql");
    const invalidSql = `${await readFile(migrationPath, "utf8")}\ncreate table undeclared_password_reset_migration (id text);\n`;
    await writeFile(migrationPath, invalidSql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(11, {
      ...manifests.get(11)!,
      checksum: (await import("node:crypto")).createHash("sha256").update(invalidSql).digest("hex"),
    });

    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, invalidDirectory, manifests),
      /schema 11 manifest validation failed: relation catalog/u,
    );
    assert.equal(await readSchemaVersion(db), 10);
    assert.equal((await pool.query(
      "select count(*)::int as count from core_agent_schema_migrations where version = 11",
    )).rows[0]?.count, 0);
    assert.equal((await pool.query(
      "select to_regclass('public.undeclared_password_reset_migration')::text as relation",
    )).rows[0]?.relation, null);
    assert.equal((await pool.query(
      `select pg_get_constraintdef(oid, true) as definition
       from pg_constraint where conname = 'oauth_transactions_flow_kind_check'`,
    )).rows[0]?.definition, "CHECK (flow_kind = ANY (ARRAY['apple_sign_in'::text, 'apple_link'::text]))");
  } finally {
    await rm(v10Directory, { recursive: true, force: true });
    await rm(invalidDirectory, { recursive: true, force: true });
  }
});

test("database role bootstrap removes hostile role drift and rotates persisted SCRAM credentials", async () => {
  const runtimeCore = await import("../src/index.js") as Record<string, unknown>;
  assert.equal(typeof runtimeCore.bootstrapRuntimeDatabaseAuth, "function");
  const bootstrapAuth = runtimeCore.bootstrapRuntimeDatabaseAuth as (input: {
    databaseUrl: string;
    bootstrapPasswordFile: string;
    migratorPasswordFile: string;
    applicationPasswordFile: string;
    identityPasswordFile: string;
  }) => Promise<void>;
  const directory = await mkdtemp(join(tmpdir(), "core-agent-database-auth-"));
  const databaseUrl = new URL(assertDisposableDatabaseUrl(testDatabaseUrl));
  const databaseName = databaseUrl.pathname.slice(1);
  assert.match(databaseName, /^core_agent_[a-z0-9_]+$/u);
  const bootstrapRole = databaseUrl.username;
  assert.match(bootstrapRole, /^core_agent_[a-z0-9_]+$/u);
  assert.equal(databaseUrl.password, "");
  const protectedPasswordFile = process.env.CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE;
  assert(protectedPasswordFile, "CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE is required for authentication tests");
  assert.equal(typeof runtimeCore.readProtectedDatabasePassword, "function");
  const originalBootstrapPassword = await (runtimeCore.readProtectedDatabasePassword as (path: string) => Promise<string>)(protectedPasswordFile);
  const bootstrapPassword = randomBytes(32).toString("base64url");
  databaseUrl.password = "";

  const rotateBootstrapPassword = async (password: string) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local password_encryption = 'scram-sha-256'");
      await client.query("select set_config('core_agent.test_bootstrap_role', $1, true)", [bootstrapRole]);
      await client.query("select set_config('core_agent.test_bootstrap_password', $1, true)", [password]);
      await client.query(`do $password$
        begin
          execute format(
            'alter role %I password %L',
            current_setting('core_agent.test_bootstrap_role'),
            current_setting('core_agent.test_bootstrap_password')
          );
          perform set_config('core_agent.test_bootstrap_password', '', true);
        end
      $password$`);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const secretPaths = {
    bootstrapPasswordFile: join(directory, "bootstrap"),
    migratorPasswordFile: join(directory, "migrator"),
    applicationPasswordFile: join(directory, "application"),
    identityPasswordFile: join(directory, "identity"),
  };
  const writeSecrets = async (values: Record<keyof typeof secretPaths, string>) => {
    for (const [name, path] of Object.entries(secretPaths) as [keyof typeof secretPaths, string][]) {
      await writeFile(path, values[name], { mode: 0o600 });
      await chmod(path, 0o600);
    }
  };
  const credentials = () => ({
    bootstrapPasswordFile: bootstrapPassword,
    migratorPasswordFile: randomBytes(32).toString("base64url"),
    applicationPasswordFile: randomBytes(32).toString("base64url"),
    identityPasswordFile: randomBytes(32).toString("base64url"),
  });
  const connect = async (role: string, password: string | undefined) => {
    const target = new URL(databaseUrl);
    target.username = role;
    target.password = password ?? "";
    const client = new Client({ connectionString: target.toString() });
    await client.connect();
    return client;
  };
  const rejectsAuthentication = async (role: string, password: string | undefined) => {
    const target = new URL(databaseUrl);
    target.username = role;
    target.password = password ?? "";
    const client = new Client({ connectionString: target.toString() });
    try {
      await assert.rejects(client.connect(), (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, /[A-Za-z0-9_-]{32,}/u);
        return true;
      });
    } finally {
      await client.end().catch(() => undefined);
    }
  };

  try {
    await rotateBootstrapPassword(bootstrapPassword);
    await pool.query(`do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'core_agent_migrator') then
          create role core_agent_migrator nologin nosuperuser nocreatedb nocreaterole noinherit;
        end if;
      end
    $$`);
    await pool.query(
      "alter role core_agent_migrator nologin password null; alter role core_agent_app nologin password null; alter role core_agent_identity nologin password null",
    );
    const protectedRoles = ["core_agent_app", "core_agent_identity", "core_agent_migrator"] as const;
    for (const [index, role] of protectedRoles.entries()) {
      const parent = `core_agent_hostile_parent_${index}`;
      const member = `core_agent_hostile_member_${index}`;
      await pool.query(`create role ${parent} nologin; create role ${member} nologin`);
      await pool.query(`grant ${parent} to ${role}; grant ${role} to ${member}`);
      await pool.query(`alter role ${role} superuser createdb createrole inherit replication bypassrls`);
    }

    const first = credentials();
    await writeSecrets(first);
    await pool.query(`grant temporary on database "${databaseName}" to core_agent_app, core_agent_identity, core_agent_migrator`);
    await pool.query("grant create on schema public to public, core_agent_app, core_agent_identity");
    await bootstrapAuth({ databaseUrl: databaseUrl.toString(), ...secretPaths });
    await bootstrapAuth({ databaseUrl: databaseUrl.toString(), ...secretPaths });

    for (const role of ["core_agent_app", "core_agent_identity", "core_agent_migrator"]) {
      assert.equal((await pool.query("select has_database_privilege($1, current_database(), 'TEMPORARY') as allowed", [role])).rows[0]?.allowed, false);
      assert.equal((await pool.query("select has_schema_privilege($1, 'public', 'CREATE') as allowed", [role])).rows[0]?.allowed, role === "core_agent_migrator");
    }
    assert.equal((await pool.query("select has_schema_privilege('public', 'public', 'CREATE') as allowed")).rows[0]?.allowed, false);

    const roles = await pool.query<{
      rolname: string;
      scram: boolean;
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `select rolname, rolpassword like 'SCRAM-SHA-256$%' as scram,
              rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls
       from pg_authid
       where rolname = any($1::text[])
       order by rolname`,
      [["core_agent_app", bootstrapRole, "core_agent_identity", "core_agent_migrator"]],
    );
    assert.deepEqual(roles.rows, [
      { rolname: "core_agent_app", scram: true, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false },
      { rolname: bootstrapRole, scram: true, rolcanlogin: true, rolsuper: true, rolcreatedb: true, rolcreaterole: true, rolinherit: true, rolreplication: true, rolbypassrls: true },
      { rolname: "core_agent_identity", scram: true, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false },
      { rolname: "core_agent_migrator", scram: true, rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false },
    ].sort((left, right) => left.rolname.localeCompare(right.rolname)));
    const memberships = await pool.query<{ count: number }>(
      `select count(*)::int as count
       from pg_auth_members memberships
       join pg_roles granted_role on granted_role.oid = memberships.roleid
       join pg_roles member_role on member_role.oid = memberships.member
       where granted_role.rolname = any($1::text[])
          or member_role.rolname = any($1::text[])`,
      [protectedRoles],
    );
    assert.equal(memberships.rows[0]?.count, 0);
    for (const [role, password] of [
      ["core_agent_app", first.applicationPasswordFile],
      ["core_agent_identity", first.identityPasswordFile],
      ["core_agent_migrator", first.migratorPasswordFile],
    ] as const) {
      const client = await connect(role, password);
      assert.equal((await client.query<{ current_user: string }>("select current_user")).rows[0]?.current_user, role);
      if (role !== "core_agent_identity") {
        await assert.rejects(client.query("set role core_agent_identity"), /permission denied/);
      }
      await client.end();
    }
    await rejectsAuthentication("core_agent_identity", undefined);
    await rejectsAuthentication("core_agent_identity", randomBytes(32).toString("base64url"));
    await rejectsAuthentication("core_agent_identity", first.applicationPasswordFile);
    await rejectsAuthentication("core_agent_migrator", first.applicationPasswordFile);

    const rotated = credentials();
    await writeSecrets(rotated);
    await bootstrapAuth({ databaseUrl: databaseUrl.toString(), ...secretPaths });
    await rejectsAuthentication("core_agent_app", first.applicationPasswordFile);
    const rotatedClient = await connect("core_agent_app", rotated.applicationPasswordFile);
    await rotatedClient.end();
  } finally {
    await pool.query(`do $cleanup$
      declare edge record;
      begin
        for edge in
          select granted_role.rolname as granted_role, member_role.rolname as member_role
          from pg_auth_members memberships
          join pg_roles granted_role on granted_role.oid = memberships.roleid
          join pg_roles member_role on member_role.oid = memberships.member
          where granted_role.rolname = any(array['core_agent_app', 'core_agent_identity', 'core_agent_migrator'])
             or member_role.rolname = any(array['core_agent_app', 'core_agent_identity', 'core_agent_migrator'])
        loop
          execute format('revoke %I from %I', edge.granted_role, edge.member_role);
        end loop;
      end
    $cleanup$`);
    await pool.query(
      `alter role core_agent_migrator login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password null;
       alter role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password null;
       alter role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password null`,
    ).catch(() => undefined);
    for (let index = 0; index < 3; index += 1) {
      await pool.query(`drop role if exists core_agent_hostile_parent_${index}; drop role if exists core_agent_hostile_member_${index}`).catch(() => undefined);
    }
    await rotateBootstrapPassword(originalBootstrapPassword).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
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
    await seedLegacyProvisioner(["tenant_legacy_platform_control_a", "tenant_legacy_platform_control_b"]);
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

test("schema 10 backfills one legacy platform provisioner Membership", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await seedLegacyProvisioner(["tenant_legacy_platform_one"]);

    await applyMigrations(pool, migrationsDirectory);

    const memberships = await pool.query(
      `select tenant_id, membership_id, membership_source
       from memberships where actor_id = 'core_agent_provisioner' order by tenant_id`,
    );
    assert.deepEqual(memberships.rows, [{
      tenant_id: "tenant_legacy_platform_one",
      membership_id: "core_agent_provisioner_admin",
      membership_source: "platform",
    }]);
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("schema 10 backfills multiple legacy platform provisioner Memberships", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await seedLegacyProvisioner(["tenant_legacy_platform_a", "tenant_legacy_platform_b"]);

    await applyMigrations(pool, migrationsDirectory);

    const memberships = await pool.query(
      `select tenant_id, membership_source
       from memberships where actor_id = 'core_agent_provisioner' order by tenant_id`,
    );
    assert.deepEqual(memberships.rows, [
      { tenant_id: "tenant_legacy_platform_a", membership_source: "platform" },
      { tenant_id: "tenant_legacy_platform_b", membership_source: "platform" },
    ]);
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("schema 10 does not classify a provisioner lookalike as platform authority", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await seedLegacyProvisioner(
      ["tenant_legacy_lookalike_a", "tenant_legacy_lookalike_b"],
      "core_agent_provisioner_admin_lookalike",
    );

    await assert.rejects(
      applyMigrations(pool, migrationsDirectory),
      /legacy ordinary Membership authority conflict/,
    );
    assert.equal(await readSchemaVersion(db), 9);
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("schema 10 role prerequisite fails closed before an existing schema-9 upgrade", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    const migration = await readFile(join(migrationsDirectory, "010_identity_authority.sql"), "utf8");
    const modified = migration.replaceAll("core_agent_identity", "core_agent_identity_missing_for_test");
    await writeFile(join(v9Directory, "010_identity_authority.sql"), modified);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.delete(11);
    manifests.delete(12);
    manifests.set(10, {
      ...manifests.get(10)!,
      checksum: (await import("node:crypto")).createHash("sha256").update(modified).digest("hex"),
    });

    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, v9Directory, manifests),
      /required database role core_agent_identity_missing_for_test is absent/,
    );
    assert.equal(await readSchemaVersion(db), 9);
  } finally {
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("schema 10 collapses consistent Actors and preserves every legacy Actor foreign key", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await seedLegacyGlobalActorGraph();

    await applyMigrations(pool, migrationsDirectory);

    assert.equal(await readSchemaVersion(db), 12);
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
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name = any($1::text[]) order by table_name`,
      [identityTables],
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), identityTables);
    const publicReads = await pool.query(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'PUBLIC'
         and table_name = any($1::text[]) and privilege_type = 'SELECT'`,
      [identityTables],
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

test("schema 10 identity authority tables retain their compatibility and security-critical catalog shape", async () => {
  await applyMigrations(pool, migrationsDirectory);

  const columns = await pool.query<{
    table_name: keyof typeof identityColumnShape;
    column_name: string;
    udt_name: string;
    is_nullable: "YES" | "NO";
  }>(
    `select table_name, column_name, udt_name, is_nullable
     from information_schema.columns
     where table_schema = 'public' and table_name = any($1::text[])
     order by table_name, ordinal_position`,
    [identityTables],
  );
  const actualColumns = Object.fromEntries(identityTables.map((tableName) => [
    tableName,
    columns.rows
      .filter((column) => column.table_name === tableName)
      .map((column) => `${column.column_name}:${column.udt_name}:${column.is_nullable}`),
  ]));
  assert.deepEqual(actualColumns, identityColumnShape);

  const keys = await pool.query<{ table_name: string; constraint_type: string; definition: string }>(
    `select relation.relname as table_name, catalog_constraint.contype as constraint_type,
            pg_get_constraintdef(catalog_constraint.oid) as definition
     from pg_constraint as catalog_constraint
     join pg_class as relation on relation.oid = catalog_constraint.conrelid
     where relation.relname = any($1::text[]) and catalog_constraint.contype in ('p', 'u', 'f')
     order by table_name, constraint_type, definition`,
    [identityTables],
  );
  const actualKeys = new Set(keys.rows.map((key) => `${key.table_name}:${key.constraint_type}:${key.definition}`));
  const expectedKeys = new Set([
    "account_deletions:f:FOREIGN KEY (actor_id) REFERENCES actors(actor_id)",
    "account_deletions:p:PRIMARY KEY (account_deletion_id)",
    "auth_subjects:f:FOREIGN KEY (actor_id) REFERENCES actors(actor_id)",
    "auth_subjects:p:PRIMARY KEY (auth_subject_id)",
    "auth_subjects:u:UNIQUE (actor_id, auth_subject_id)",
    "auth_subjects:u:UNIQUE (provider, provider_subject)",
    "core_sessions:f:FOREIGN KEY (actor_id) REFERENCES actors(actor_id)",
    "core_sessions:f:FOREIGN KEY (actor_id, auth_subject_id) REFERENCES auth_subjects(actor_id, auth_subject_id)",
    "core_sessions:f:FOREIGN KEY (auth_subject_id) REFERENCES auth_subjects(auth_subject_id)",
    "core_sessions:p:PRIMARY KEY (session_id)",
    "core_sessions:u:UNIQUE (secret_digest)",
    "email_verification_transactions:p:PRIMARY KEY (email_verification_transaction_id)",
    "email_verification_transactions:u:UNIQUE (start_idempotency_key)",
    "identity_invitations:f:FOREIGN KEY (accepted_actor_id) REFERENCES actors(actor_id)",
    "identity_invitations:f:FOREIGN KEY (invited_by_actor_id) REFERENCES actors(actor_id)",
    "identity_invitations:f:FOREIGN KEY (replaced_by_invitation_id) REFERENCES identity_invitations(invitation_id)",
    "identity_invitations:f:FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)",
    "identity_invitations:p:PRIMARY KEY (invitation_id)",
    "identity_invitations:u:UNIQUE (secret_digest)",
    "oauth_transactions:f:FOREIGN KEY (actor_id) REFERENCES actors(actor_id)",
    "oauth_transactions:p:PRIMARY KEY (oauth_transaction_id)",
    "oauth_transactions:u:UNIQUE (state_digest)",
    "platform_role_assignments:f:FOREIGN KEY (actor_id) REFERENCES actors(actor_id)",
    "platform_role_assignments:p:PRIMARY KEY (platform_role_assignment_id)",
    "platform_role_assignments:u:UNIQUE (actor_id, role)",
    "private_identity_pii:f:FOREIGN KEY (actor_id) REFERENCES actors(actor_id)",
    "private_identity_pii:p:PRIMARY KEY (actor_id)",
    "private_identity_pii:u:UNIQUE (normalized_email_hmac)",
    "public_rate_limits:p:PRIMARY KEY (bucket_kind, account_identifier_hmac, client_identifier_hmac, window_started_at)",
  ]);
  assert.deepEqual(actualKeys, expectedKeys);

  const checks = await pool.query<{ table_name: string; definitions: string }>(
    `select relation.relname as table_name,
            string_agg(pg_get_constraintdef(catalog_constraint.oid), E'\n' order by catalog_constraint.conname) as definitions
     from pg_constraint as catalog_constraint
     join pg_class as relation on relation.oid = catalog_constraint.conrelid
     where relation.relname = any($1::text[]) and catalog_constraint.contype = 'c'
     group by relation.relname order by relation.relname`,
    [identityTables],
  );
  const checkText = new Map(checks.rows.map((row) => [row.table_name, row.definitions]));
  for (const [tableName, required] of Object.entries({
    auth_subjects: ["supabase", "email_password", "apple", "active", "unlinked", "revoked"],
    platform_role_assignments: ["platform_super_admin", "active", "revoked"],
    identity_invitations: ["admin", "consultant", "pending", "accepted", "revoked", "expired", "replaced", "octet_length(secret_digest) = 32", "octet_length(normalized_email_hmac) = 32"],
    oauth_transactions: ["supabase", "apple_sign_in", "apple_link", "password_reset", "web", "iphone", "macos", "pending", "consumed", "expired", "octet_length(state_digest) = 32", "octet_length(nonce_digest) = 32"],
    core_sessions: ["web", "iphone", "macos", "active", "revoked", "expired", "octet_length(secret_digest) = 32", "octet_length(csrf_digest) = 32"],
    email_verification_transactions: ["pending", "consumed", "expired", "sha256:", "octet_length(normalized_email_hmac) = 32", "octet_length(binding_ciphertext) >= 33", "octet_length(verified_provider_subject_hmac) = 32"],
    account_deletions: ["deletion_pending", "cancelled", "deleted"],
    private_identity_pii: ["octet_length(normalized_email_hmac) = 32", "octet_length(encrypted_email) > 0"],
    public_rate_limits: ["signup", "login", "reset", "apple_callback", "invitation_accept", "reauthenticate", "octet_length(account_identifier_hmac) = 32", "octet_length(client_identifier_hmac) = 32"],
  })) {
    const definitions = checkText.get(tableName) ?? "";
    for (const fragment of required) assert(definitions.includes(fragment), `${tableName} missing check: ${fragment}`);
  }
});

test("schema 10 grants only the documented Identity Task 3-9 table-operation matrix", async () => {
  const v9Directory = await applyThroughSchema9();
  try {
    await pool.query("grant usage on schema public to core_agent_app");
    await pool.query(
      "alter default privileges for role current_user in schema public grant select, insert, update, delete on tables to core_agent_app",
    );
    await pool.query("grant select, insert, update, delete on all tables in schema public to core_agent_identity");
    await applyMigrations(pool, migrationsDirectory);

    const privileges = await pool.query<{ role_name: string; table_name: string; privilege: string; allowed: boolean }>(
      `select role_name, table_name, privilege,
              has_table_privilege(role_name, format('public.%I', table_name), privilege) as allowed
       from unnest($1::text[]) as role_name
       cross join unnest($2::text[]) as table_name
       cross join unnest($3::text[]) as privilege
       order by role_name, table_name, privilege`,
      [["core_agent_app", "core_agent_identity"], Object.keys(identityPrivilegeMatrix), ["SELECT", "INSERT", "UPDATE", "DELETE"]],
    );
    for (const privilege of privileges.rows) {
      const identityAllowed = (identityPrivilegeMatrix[privilege.table_name as keyof typeof identityPrivilegeMatrix] as readonly string[])
        .includes(privilege.privilege);
      if (privilege.role_name === "core_agent_identity") {
        assert.equal(privilege.allowed, identityAllowed, `${privilege.role_name} ${privilege.privilege} ${privilege.table_name}`);
      } else if (identityTables.includes(privilege.table_name as typeof identityTables[number])) {
        assert.equal(privilege.allowed, false, `${privilege.role_name} ${privilege.privilege} ${privilege.table_name}`);
      }
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role core_agent_app");
      await assert.rejects(client.query("select count(*) from auth_subjects"), /permission denied/);
      await client.query("rollback");

      await client.query("begin");
      await client.query("set local role core_agent_app");
      await assert.rejects(client.query(
        `insert into public_rate_limits (
          bucket_kind, account_identifier_hmac, client_identifier_hmac,
          window_started_at, request_count, expires_at, updated_at
        ) values (
          'login', decode(repeat('22', 32), 'hex'), decode(repeat('33', 32), 'hex'),
          '2026-08-10T00:00:00.000Z', 1, '2026-08-10T01:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )`,
      ), /permission denied/);
      await client.query("rollback");

      await client.query("begin");
      await client.query("set local role core_agent_identity");
      await assert.doesNotReject(client.query("select count(*) from auth_subjects"));
      await assert.rejects(client.query("select count(*) from conversations"), /permission denied/);
      await client.query("rollback");

      await client.query("begin");
      await client.query("set local role core_agent_identity");
      await assert.rejects(client.query("delete from tenants where false"), /permission denied/);
      await client.query("rollback");

      await client.query("begin");
      await client.query("set local role core_agent_identity");
      await assert.rejects(client.query("update product_events set payload = payload where false"), /permission denied/);
      await client.query("rollback");

      await client.query("begin");
      await client.query("set local role core_agent_identity");
      await assert.rejects(client.query("update worker_jobs set updated_at = updated_at where false"), /permission denied/);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.query(
      "alter default privileges for role current_user in schema public revoke select, insert, update, delete on tables from core_agent_app",
    );
    await rm(v9Directory, { recursive: true, force: true });
  }
});

test("recorded schema 10 startup reconverges dirty direct ACLs and remains idempotent", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query("grant select, insert, update, delete on table private_identity_pii to core_agent_app");
  await pool.query("grant select, update, delete on table conversations, secret_references, runtime_containers to core_agent_identity");

  await applyMigrations(pool, migrationsDirectory);
  await applyMigrations(pool, migrationsDirectory);

  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    assert.equal((await pool.query("select has_table_privilege('core_agent_app', 'public.private_identity_pii', $1) as allowed", [privilege])).rows[0]?.allowed, false);
  }
  for (const table of ["conversations", "secret_references", "runtime_containers"]) {
    for (const privilege of ["SELECT", "UPDATE", "DELETE"]) {
      assert.equal((await pool.query("select has_table_privilege('core_agent_identity'::text, format('public.%I', $1::text), $2::text) as allowed", [table, privilege])).rows[0]?.allowed, false);
    }
  }
});

test("recorded schema 10 startup converges every owned relation column ACL to exact empty", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query(`drop role if exists core_agent_unknown_column_acl;
    drop role if exists "core_agent_column_acl_"";--";
    create role core_agent_unknown_column_acl;
    create role "core_agent_column_acl_"";--"`);
  try {
    await pool.query("grant select (provider_subject, provider) on auth_subjects to core_agent_unknown_column_acl with grant option");
    await pool.query("grant update (provider_subject) on auth_subjects to public");
    await pool.query("grant references (display_name) on tenants to core_agent_app with grant option");
    await pool.query("grant select (device_label), update (revocation_reason) on core_sessions to core_agent_identity with grant option");
    await pool.query(`grant select (provider) on auth_subjects to "core_agent_column_acl_"";--"`);
    await pool.query("grant insert (provider_identity_kind) on auth_subjects to current_user with grant option");
    await pool.query("grant select (tableoid, ctid, xmin) on auth_subjects to core_agent_unknown_column_acl with grant option");
    await pool.query("grant select (tableoid) on auth_subjects to public");
    await pool.query("grant select (ctid) on auth_subjects to current_user with grant option");

    await applyMigrations(pool, migrationsDirectory);
    await applyMigrations(pool, migrationsDirectory);

    const columnAcls = await pool.query<{ count: number }>(
      `select count(*)::int as count
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       join pg_attribute attribute on attribute.attrelid = relation.oid
         and attribute.attnum <> 0 and not attribute.attisdropped
       cross join lateral aclexplode(attribute.attacl) privilege
       where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm')`,
    );
    assert.equal(columnAcls.rows[0]?.count, 0);
  } finally {
    await pool.query(`drop owned by core_agent_unknown_column_acl;
      drop owned by "core_agent_column_acl_"";--";
      drop role if exists core_agent_unknown_column_acl;
      drop role if exists "core_agent_column_acl_"";--"`);
  }
});

test("column ACL convergence rolls back with a rejected forward migration", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query("drop role if exists core_agent_column_acl_rollback; create role core_agent_column_acl_rollback");
  const directory = await mkdtemp(join(tmpdir(), "core-agent-column-acl-rollback-"));
  try {
    await pool.query("grant select (provider_subject, tableoid, xmin) on auth_subjects to core_agent_column_acl_rollback with grant option");
    await cp(migrationsDirectory, directory, { recursive: true });
    const migrationSql = "create table undeclared_column_acl_rollback (id text);\n";
    await writeFile(join(directory, "013_column_acl_rollback.sql"), migrationSql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "column_acl_rollback",
      checksum: (await import("node:crypto")).createHash("sha256").update(migrationSql).digest("hex"),
    });
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /schema 13 manifest validation failed: relation catalog/u,
    );
    assert.equal((await pool.query(
      "select has_column_privilege('core_agent_column_acl_rollback', 'auth_subjects', 'provider_subject', 'SELECT WITH GRANT OPTION') as allowed",
    )).rows[0]?.allowed, true);
    assert.equal((await pool.query(
      "select has_column_privilege('core_agent_column_acl_rollback', 'auth_subjects', 'tableoid', 'SELECT WITH GRANT OPTION') as allowed",
    )).rows[0]?.allowed, true);
    assert.equal((await pool.query("select to_regclass('public.undeclared_column_acl_rollback')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count, 0);
  } finally {
    await pool.query("drop owned by core_agent_column_acl_rollback; drop role if exists core_agent_column_acl_rollback");
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered views and materialized views reconverge column ACLs to exact empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-forward-column-acl-"));
  const migrationSql = `
    create table registered_column_acl_source (id integer not null, label text);
    create table registered_column_acl_partitioned (id integer not null, label text) partition by list (id);
    create table registered_column_acl_partition partition of registered_column_acl_partitioned for values in (1);
    create view registered_column_acl_view as select id, label from registered_column_acl_source;
    create materialized view registered_column_acl_materialized as select id, label from registered_column_acl_source;
  `;
  await pool.query("drop role if exists core_agent_forward_column_acl; create role core_agent_forward_column_acl");
  try {
    const relationSemantics = await probeRelationSemantics(migrationSql, [
      "registered_column_acl_partitioned", "registered_column_acl_partition",
      "registered_column_acl_view", "registered_column_acl_materialized",
    ]);
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_forward_column_acl.sql"), migrationSql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "forward_column_acl",
      checksum: (await import("node:crypto")).createHash("sha256").update(migrationSql).digest("hex"),
      objects: [
        ["public", "registered_column_acl_source", "r", "current_user"],
        ["public", "registered_column_acl_partitioned", "p", "current_user"],
        ["public", "registered_column_acl_partition", "r", "current_user"],
        ["public", "registered_column_acl_view", "v", "current_user"],
        ["public", "registered_column_acl_materialized", "m", "current_user"],
      ],
      relationSemantics,
      columns: [
        { schema: "public", relation: "registered_column_acl_source", relkind: "r", name: "id", position: 1, type: "integer", notNull: true, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_source", relkind: "r", name: "label", position: 2, type: "text", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_partitioned", relkind: "p", name: "id", position: 1, type: "integer", notNull: true, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_partitioned", relkind: "p", name: "label", position: 2, type: "text", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_partition", relkind: "r", name: "id", position: 1, type: "integer", notNull: true, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_partition", relkind: "r", name: "label", position: 2, type: "text", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_view", relkind: "v", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_view", relkind: "v", name: "label", position: 2, type: "text", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_materialized", relkind: "m", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_column_acl_materialized", relkind: "m", name: "label", position: 2, type: "text", notNull: false, defaultExpression: "" },
      ],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await pool.query("grant select (id, label) on registered_column_acl_view to core_agent_forward_column_acl with grant option");
    await pool.query("grant select (id) on registered_column_acl_materialized to public");
    await pool.query("grant select (label) on registered_column_acl_materialized to core_agent_forward_column_acl with grant option");
    await pool.query("grant select (tableoid) on registered_column_acl_source to core_agent_forward_column_acl with grant option");
    await pool.query("grant select (tableoid) on registered_column_acl_partitioned to public");
    await pool.query("grant select (xmin) on registered_column_acl_partition to current_user with grant option");
    await pool.query("grant select (ctid) on registered_column_acl_materialized to core_agent_forward_column_acl with grant option");
    const dirtySystemAcls = await pool.query<{ kinds: string[] }>(
      `select array_agg(distinct relation.relkind order by relation.relkind)::text[] as kinds
       from pg_class relation
       join pg_attribute attribute on attribute.attrelid = relation.oid and attribute.attnum < 0
       cross join lateral aclexplode(attribute.attacl) privilege
       where relation.relname = any($1::text[])`,
      [[
        "registered_column_acl_source", "registered_column_acl_partitioned",
        "registered_column_acl_partition", "registered_column_acl_materialized",
      ]],
    );
    assert.deepEqual(dirtySystemAcls.rows[0]?.kinds, ["m", "p", "r"]);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query(
      `select count(*)::int as count from pg_class relation
       join pg_attribute attribute on attribute.attrelid = relation.oid
         and attribute.attnum <> 0 and not attribute.attisdropped
       cross join lateral aclexplode(attribute.attacl) privilege
       where relation.relname = any($1::text[])`,
      [[
        "registered_column_acl_source", "registered_column_acl_partitioned", "registered_column_acl_partition",
        "registered_column_acl_view", "registered_column_acl_materialized",
      ]],
    )).rows[0]?.count, 0);
  } finally {
    await pool.query("drop owned by core_agent_forward_column_acl; drop role if exists core_agent_forward_column_acl");
    await rm(directory, { recursive: true, force: true });
  }
});

test("recorded schema 10 fails closed on an undeclared sequence", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query("create sequence acl_drift_sequence");
  await assert.rejects(applyMigrations(pool, migrationsDirectory), /schema 12 manifest validation failed: relation catalog/);
});

test("recorded schema 10 convergence fails closed for a malformed partial identity catalog", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query("drop table public_rate_limits");
  await assert.rejects(applyMigrations(pool, migrationsDirectory), /schema 10 ACL convergence failed/);
});

test("an unknown migration 013 is rejected before SQL execution or recording", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-unknown-migration-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_unknown.sql"), "create table unknown_manifest_side_effect (id text primary key);\n");
    await assert.rejects(applyMigrations(pool, directory), /migration manifest inventory/u);
    assert.equal((await pool.query("select to_regclass('public.unknown_manifest_side_effect')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select to_regclass('public.core_agent_schema_migrations')::text as relation")).rows[0]?.relation, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration and manifest inventories are an exact ordered contiguous bijection before connect", async (t) => {
  const cases: Array<[string, (directory: string, manifests: Map<number, typeof migrationTestInternals.schemaManifests extends ReadonlyMap<number, infer M> ? M : never>) => Promise<void>]> = [
    ["orphan manifest", async (_directory, manifests) => {
      manifests.set(13, { version: 13, name: "orphan", checksum: "0".repeat(64) });
    }],
    ["gap", async (directory, manifests) => {
      await rm(join(directory, "005_worker_runtime_facts.sql"));
      manifests.delete(5);
    }],
    ["reordered manifests", async (_directory, manifests) => {
      const reversed = [...manifests.entries()].reverse();
      manifests.clear();
      for (const [version, manifest] of reversed) manifests.set(version, manifest);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "core-agent-inventory-"));
      let connects = 0;
      try {
        await cp(migrationsDirectory, directory, { recursive: true });
        const manifests = new Map(migrationTestInternals.schemaManifests);
        await mutate(directory, manifests);
        await assert.rejects(
          migrationTestInternals.applyMigrationsWithManifests({
            connect: async () => { connects += 1; throw new Error("must not connect"); },
          } as unknown as Pool, directory, manifests),
          /migration manifest inventory/u,
        );
        assert.equal(connects, 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("a database above the binary max fails closed", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query(
    "insert into core_agent_schema_migrations(version, name, checksum, applied_at) values (13, 'future', $1, now())",
    ["0".repeat(64)],
  );
  await assert.rejects(applyMigrations(pool, migrationsDirectory), /database schema is newer than this binary/u);
});

test("a registered migration 013 validates and records atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-registered-migration-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = "create table registered_manifest_object (id text primary key);\n";
    await writeFile(join(directory, "013_registered.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "registered",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "registered_manifest_object", "r", "current_user"]],
      columns: [["registered_manifest_object", "id", "text", true, ""]],
      constraints: [["registered_manifest_object", "registered_manifest_object_pkey", "p", true, "PRIMARY KEY (id)"]],
      indexes: [["registered_manifest_object", "registered_manifest_object_pkey", "CREATE UNIQUE INDEX registered_manifest_object_pkey ON public.registered_manifest_object USING btree (id)"]],
      validateAndConverge: async (client: PoolClient) => {
        const result = await client.query("select to_regclass('public.registered_manifest_object')::text as relation");
        if (result.rows[0]?.relation !== "registered_manifest_object") throw new Error("schema 13 manifest validation failed");
      },
    });
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select max(version) as version from core_agent_schema_migrations")).rows[0]?.version, 13);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a registered migration manifest failure rolls back both schema and record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-failing-manifest-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = "create table rolled_back_manifest_object (id text primary key);\n";
    await writeFile(join(directory, "013_registered.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "registered",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "rolled_back_manifest_object", "r", "current_user"]],
      validateAndConverge: async () => { throw new Error("schema 13 manifest validation failed"); },
    });
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /schema 13 manifest validation failed/);
    assert.equal((await pool.query("select to_regclass('public.rolled_back_manifest_object')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered relation semantics validate exact kind-specific catalogs and amendments", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-relation-semantics-"));
  const v11Sql = `
    create view registered_semantic_view as select 1::integer as id;
    create materialized view registered_semantic_mat as select 1::integer as id;
    create table registered_semantic_parent (id integer) partition by range (id);
    create table registered_semantic_child partition of registered_semantic_parent for values from (0) to (10);
    create sequence registered_semantic_sequence as integer start 5 increment 2 minvalue 1 maxvalue 99 cache 3 cycle;
  `;
  const readSemantics = async () => (await pool.query(`
    select namespace.nspname as schema, relation.relname as name, relation.relkind as relkind,
      case when relation.relkind in ('v', 'm') then pg_get_viewdef(relation.oid, true) else '' end as definition,
      case when relation.relkind = 'p' then pg_get_partkeydef(relation.oid) else '' end as "partitionKey",
      coalesce(parent_namespace.nspname || '.' || parent.relname, '') as parent,
      case when relation.relispartition then pg_get_expr(relation.relpartbound, relation.oid, true) else '' end as bound,
      coalesce(format_type(sequence.seqtypid, null), '') as "dataType",
      coalesce(sequence.seqstart::text, '') as start, coalesce(sequence.seqincrement::text, '') as increment,
      coalesce(sequence.seqmin::text, '') as min, coalesce(sequence.seqmax::text, '') as max,
      coalesce(sequence.seqcache::text, '') as cache, coalesce(sequence.seqcycle, false) as cycle
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    left join pg_inherits inheritance on inheritance.inhrelid = relation.oid
    left join pg_class parent on parent.oid = inheritance.inhparent
    left join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
    left join pg_sequence sequence on sequence.seqrelid = relation.oid
    where namespace.nspname = 'public' and relation.relname like 'registered_semantic_%'
    order by relation.relname
  `)).rows;
  try {
    await pool.query("begin");
    await pool.query(v11Sql);
    const semantics = await readSemantics();
    await pool.query("rollback");
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_relation_semantics.sql"), v11Sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13, name: "relation_semantics",
      checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
      objects: [
        ["public", "registered_semantic_view", "v", "current_user"],
        ["public", "registered_semantic_mat", "m", "current_user"],
        ["public", "registered_semantic_parent", "p", "current_user"],
        ["public", "registered_semantic_child", "r", "current_user"],
        ["public", "registered_semantic_sequence", "S", "current_user"],
      ],
      relationSemantics: semantics,
      columns: [
        { schema: "public", relation: "registered_semantic_view", relkind: "v", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_semantic_mat", relkind: "m", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_semantic_parent", relkind: "p", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "registered_semantic_child", relkind: "r", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
      ],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);

    const semanticDrifts = [
      ["alter sequence registered_semantic_sequence increment by 7 cache 1 no cycle", "alter sequence registered_semantic_sequence increment by 2 cache 3 cycle"],
      ["create or replace view registered_semantic_view as select 9::integer as id", "create or replace view registered_semantic_view as select 1::integer as id"],
      ["drop materialized view registered_semantic_mat; create materialized view registered_semantic_mat as select 9::integer as id", "drop materialized view registered_semantic_mat; create materialized view registered_semantic_mat as select 1::integer as id"],
      [
        "drop table registered_semantic_parent cascade; create table registered_semantic_parent (id integer) partition by hash (id); create table registered_semantic_child partition of registered_semantic_parent for values with (modulus 4, remainder 0)",
        "drop table registered_semantic_parent cascade; create table registered_semantic_parent (id integer) partition by range (id); create table registered_semantic_child partition of registered_semantic_parent for values from (0) to (10)",
      ],
      ["drop table registered_semantic_child; create table registered_semantic_child partition of registered_semantic_parent for values from (10) to (20)", "drop table registered_semantic_child; create table registered_semantic_child partition of registered_semantic_parent for values from (0) to (10)"],
    ] as const;
    for (const [mutate, restore] of semanticDrifts) {
      await pool.query(mutate);
      await assert.rejects(
        migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
        /relation semantic catalog/u,
      );
      await pool.query(restore);
    }
    const v13Sql = "create or replace view registered_semantic_view as select 2::integer as id;\n";
    await writeFile(join(directory, "014_relation_semantic_amendment.sql"), v13Sql);
    await pool.query("begin");
    const beforeView = (await readSemantics()).find((entry) => entry.name === "registered_semantic_view");
    await pool.query(v13Sql);
    const afterView = (await readSemantics()).find((entry) => entry.name === "registered_semantic_view");
    await pool.query("rollback");
    manifests.set(14, {
      version: 14, name: "relation_semantic_amendment",
      checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      relationSemanticAmendments: [{ action: "replace", before: beforeView, after: afterView }],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 14")).rows[0]?.count, 1);

    const v14Sql = "create or replace view registered_semantic_view as select 3::integer as id;\n";
    await writeFile(join(directory, "015_missing_relation_semantic_amendment.sql"), v14Sql);
    manifests.set(15, {
      version: 15, name: "missing_relation_semantic_amendment",
      checksum: (await import("node:crypto")).createHash("sha256").update(v14Sql).digest("hex"),
    } as never);
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /relation semantic catalog/u);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 15")).rows[0]?.count, 0);
    assert.equal((await readSemantics()).find((entry) => entry.name === "registered_semantic_view")?.definition, afterView.definition);
  } finally {
    await pool.query("rollback").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a semantic revoke cannot disable validation for still-owned special relations", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-relation-semantic-revoke-"));
  const v11Sql = `
    create view semantic_revoke_view as select 1::integer as id;
    create materialized view semantic_revoke_mat as select 1::integer as id;
    create table semantic_revoke_parent (id integer) partition by range (id);
    create table semantic_revoke_child partition of semantic_revoke_parent for values from (0) to (10);
    create sequence semantic_revoke_sequence as integer start 5 increment 2 minvalue 1 maxvalue 99 cache 3 cycle;
  `;
  const v13Sql = `
    create or replace view semantic_revoke_view as select 2::integer as id;
    drop materialized view semantic_revoke_mat;
    create materialized view semantic_revoke_mat as select 2::integer as id;
    drop table semantic_revoke_parent cascade;
    create table semantic_revoke_parent (id integer) partition by hash (id);
    create table semantic_revoke_child partition of semantic_revoke_parent for values with (modulus 4, remainder 0);
    alter sequence semantic_revoke_sequence increment by 7 cache 1 no cycle;
  `;
  const names = [
    "semantic_revoke_view", "semantic_revoke_mat", "semantic_revoke_parent",
    "semantic_revoke_child", "semantic_revoke_sequence",
  ];
  try {
    const before = await probeRelationSemantics(v11Sql, names);
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_semantic_revoke_base.sql"), v11Sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "semantic_revoke_base",
      checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
      objects: [
        ["public", "semantic_revoke_view", "v", "current_user"],
        ["public", "semantic_revoke_mat", "m", "current_user"],
        ["public", "semantic_revoke_parent", "p", "current_user"],
        ["public", "semantic_revoke_child", "r", "current_user"],
        ["public", "semantic_revoke_sequence", "S", "current_user"],
      ],
      relationSemantics: before,
      columns: [
        { schema: "public", relation: "semantic_revoke_view", relkind: "v", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "semantic_revoke_mat", relkind: "m", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "semantic_revoke_parent", relkind: "p", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        { schema: "public", relation: "semantic_revoke_child", relkind: "r", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
      ],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await writeFile(join(directory, "014_semantic_revoke_drift.sql"), v13Sql);
    manifests.set(14, {
      version: 14,
      name: "semantic_revoke_drift",
      checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      relationSemanticAmendments: before.map((semantic) => ({ action: "revoke", before: semantic })),
    } as never);

    let rejected = false;
    try {
      await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    } catch (error) {
      rejected = /invalid relation semantic revoke/u.test(String(error));
    }
    let restartAccepted = false;
    if (!rejected) {
      await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
      restartAccepted = true;
    }
    const after = (await pool.query(`
      select namespace.nspname as schema, relation.relname as name, relation.relkind as relkind,
        case when relation.relkind in ('v', 'm') then pg_get_viewdef(relation.oid, true) else '' end as definition,
        case when relation.relkind = 'p' then pg_get_partkeydef(relation.oid) else '' end as "partitionKey",
        coalesce(parent_namespace.nspname || '.' || parent.relname, '') as parent,
        case when relation.relispartition then pg_get_expr(relation.relpartbound, relation.oid, true) else '' end as bound,
        coalesce(format_type(sequence.seqtypid, null), '') as "dataType",
        coalesce(sequence.seqstart::text, '') as start, coalesce(sequence.seqincrement::text, '') as increment,
        coalesce(sequence.seqmin::text, '') as min, coalesce(sequence.seqmax::text, '') as max,
        coalesce(sequence.seqcache::text, '') as cache, coalesce(sequence.seqcycle, false) as cycle
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      left join pg_inherits inheritance on inheritance.inhrelid = relation.oid
      left join pg_class parent on parent.oid = inheritance.inhparent
      left join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
      left join pg_sequence sequence on sequence.seqrelid = relation.oid
      where namespace.nspname = 'public' and relation.relname = any($1::text[])
      order by relation.relname
    `, [names])).rows;
    assert.deepEqual({
      rejected,
      restartAccepted,
      record: (await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 14")).rows[0]?.count,
      objects: after.length,
      semantics: after,
    }, { rejected: true, restartAccepted: false, record: 0, objects: 5, semantics: before });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("semantic revoke then re-add is rejected within and across manifest versions", async () => {
  const runScenario = async (crossVersion: boolean): Promise<{ rejected: boolean; records: number }> => {
    await resetDatabase();
    const directory = await mkdtemp(join(tmpdir(), "core-agent-semantic-readd-"));
    const v11Sql = "create view semantic_readd_view as select 1::integer as id;\n";
    try {
      const [semantic] = await probeRelationSemantics(v11Sql, ["semantic_readd_view"]);
      await cp(migrationsDirectory, directory, { recursive: true });
      await writeFile(join(directory, "013_semantic_readd_base.sql"), v11Sql);
      const manifests = new Map(migrationTestInternals.schemaManifests);
      manifests.set(13, {
        version: 13, name: "semantic_readd_base",
        checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
        objects: [["public", "semantic_readd_view", "v", "current_user"]],
        relationSemantics: [semantic],
        columns: [{ schema: "public", relation: "semantic_readd_view", relkind: "v", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" }],
      } as never);
      await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
      const v13Sql = "select 13;\n";
      await writeFile(join(directory, "014_semantic_readd_revoke.sql"), v13Sql);
      manifests.set(14, {
        version: 14, name: "semantic_readd_revoke",
        checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
        relationSemanticAmendments: crossVersion
          ? [{ action: "revoke", before: semantic }]
          : [{ action: "revoke", before: semantic }, { action: "add", after: semantic }],
      } as never);
      if (crossVersion) {
        const v14Sql = "select 14;\n";
        await writeFile(join(directory, "015_semantic_readd_restore.sql"), v14Sql);
        manifests.set(15, {
          version: 15, name: "semantic_readd_restore",
          checksum: (await import("node:crypto")).createHash("sha256").update(v14Sql).digest("hex"),
          relationSemanticAmendments: [{ action: "add", after: semantic }],
        } as never);
      }
      let rejected = false;
      try {
        await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
      } catch (error) {
        rejected = /invalid relation semantic revoke/u.test(String(error));
      }
      return {
        rejected,
        records: (await pool.query("select count(*)::int as count from core_agent_schema_migrations where version >= 14")).rows[0]?.count,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  assert.deepEqual(await runScenario(false), { rejected: true, records: 0 });
  assert.deepEqual(await runScenario(true), { rejected: true, records: 0 });
});

test("relation semantic declarations reject missing duplicate wrong and unowned shapes", async () => {
  const scenarios = ["missing", "duplicate", "wrong", "unowned"] as const;
  for (const scenario of scenarios) {
    await resetDatabase();
    const directory = await mkdtemp(join(tmpdir(), `core-agent-semantic-${scenario}-`));
    const relation = `semantic_${scenario}_view`;
    const sql = `create view ${relation} as select 1::integer as id;\n`;
    try {
      const [actual] = await probeRelationSemantics(sql, [relation]);
      await cp(migrationsDirectory, directory, { recursive: true });
      await writeFile(join(directory, `013_semantic_${scenario}.sql`), sql);
      const manifests = new Map(migrationTestInternals.schemaManifests);
      const wrong = { ...actual as Record<string, unknown>, definition: " SELECT 99 AS id;" };
      manifests.set(13, {
        version: 13,
        name: `semantic_${scenario}`,
        checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
        objects: scenario === "unowned" ? [] : [["public", relation, "v", "current_user"]],
        relationSemantics: scenario === "missing" ? []
          : scenario === "duplicate" ? [actual, actual]
            : scenario === "wrong" ? [wrong] : [actual],
        columns: scenario === "unowned" ? [] : [
          { schema: "public", relation, relkind: "v", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
        ],
      } as never);
      await assert.rejects(
        migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
        /relation semantic|relation semantics/u,
      );
      assert.equal((await pool.query("select to_regclass($1)::text as relation", [`public.${relation}`])).rows[0]?.relation, null);
      const migrationTable = (await pool.query("select to_regclass('public.core_agent_schema_migrations')::text as relation")).rows[0]?.relation;
      const record = migrationTable === null ? 0
        : (await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count;
      assert.equal(record, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("migration transaction control is rejected before connect and cannot escape atomic rollback", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-transaction-control-"));
  const sql = `
    create table transaction_escape_probe (id integer);
    commit;
    create table transaction_escape_after_commit (id integer);
  `;
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_transaction_escape.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13, name: "transaction_escape",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [],
    } as never);
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests));
    assert.equal((await pool.query("select to_regclass('public.transaction_escape_probe')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select to_regclass('public.transaction_escape_after_commit')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select to_regclass('public.core_agent_schema_migrations')::text as relation")).rows[0]?.relation, null);

    for (const command of [
      "begin", "start transaction", "commit", "end", "rollback", "abort", "savepoint guarded",
      "release savepoint guarded", "rollback to savepoint guarded", "prepare transaction 'guarded'",
      "commit prepared 'guarded'", "rollback prepared 'guarded'",
      "set transaction isolation level serializable",
      "set session characteristics as transaction isolation level serializable",
    ]) {
      const commandSql = `${command};\n`;
      await writeFile(join(directory, "013_transaction_escape.sql"), commandSql);
      manifests.set(13, {
        version: 13, name: "transaction_escape",
        checksum: (await import("node:crypto")).createHash("sha256").update(commandSql).digest("hex"), objects: [],
      } as never);
      let rejectedConnects = 0;
      await assert.rejects(
        migrationTestInternals.applyMigrationsWithManifests({
          connect: async () => { rejectedConnects += 1; throw new Error("transaction control reached connect"); },
        } as never, directory, manifests),
        /transaction control/u,
      );
      assert.equal(rejectedConnects, 0);
    }

    const safeSql = `
      -- begin; commit; rollback;
      /* outer commit; /* nested abort; */ release savepoint hidden; */
      select 'begin; commit', E'rollback\\' escaped', "commit", $$ start transaction; $$;
      create function public.transaction_word_probe() returns text language sql as $body$ select 'prepare transaction' $body$;
    `;
    await writeFile(join(directory, "013_transaction_escape.sql"), safeSql);
    manifests.set(13, {
      version: 13, name: "transaction_escape",
      checksum: (await import("node:crypto")).createHash("sha256").update(safeSql).digest("hex"), objects: [],
    } as never);
    let connects = 0;
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests({
        connect: async () => { connects += 1; throw new Error("safe SQL reached connect"); },
      } as never, directory, manifests),
      /safe SQL reached connect/u,
    );
    assert.equal(connects, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered columns validate collation identity and generated semantics atomically", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-column-semantics-"));
  const sql = `create table registered_column_semantics (
    id bigint not null,
    source text collate "C",
    collated text collate "C",
    derived text generated always as (source || '!') stored
  );\n`;
  const readColumns = async () => (await pool.query(`select 'public' as schema, relation.relname as relation,
      relation.relkind as relkind, attribute.attname as name, attribute.attnum as position,
      format_type(attribute.atttypid, attribute.atttypmod) as type, attribute.attnotnull as "notNull",
      coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') as "defaultExpression",
      case when catalog_collation.oid is null then ''
        else format('%I.%I', collation_namespace.nspname, catalog_collation.collname) end as "collation",
      attribute.attidentity as identity, attribute.attgenerated as generated
    from pg_class relation join pg_attribute attribute on attribute.attrelid = relation.oid
      and attribute.attnum > 0 and not attribute.attisdropped
    left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
    left join pg_collation catalog_collation on catalog_collation.oid = attribute.attcollation and attribute.attcollation <> 0
    left join pg_namespace collation_namespace on collation_namespace.oid = catalog_collation.collnamespace
    where relation.oid = 'public.registered_column_semantics'::regclass order by attribute.attnum`)).rows;
  try {
    await pool.query("begin");
    await pool.query(sql);
    const columns = await readColumns();
    await pool.query("rollback");
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_column_semantics.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13, name: "column_semantics",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "registered_column_semantics", "r", "current_user"]], columns,
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    manifests.set(13, {
      ...manifests.get(13),
      columns: columns.map((column) => column.name === "derived" ? { ...column, generated: "" } : column),
    } as never);
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /column catalog/u);
    manifests.set(13, { ...manifests.get(13), columns } as never);
    await pool.query("alter table registered_column_semantics alter column collated type text collate \"POSIX\"");
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /column catalog/u);
    await pool.query("alter table registered_column_semantics alter column collated type text collate \"C\"");

    const v13Sql = "alter table registered_column_semantics alter column id add generated always as identity (sequence name registered_column_semantics_identity_seq);\n";
    await pool.query("begin");
    await pool.query(v13Sql);
    const identityColumns = await readColumns();
    const identitySemantic = (await pool.query(`select 'public' as schema, relation.relname as name,
        relation.relkind as relkind, '' as definition, '' as "partitionKey", '' as parent, '' as bound,
        format_type(sequence.seqtypid, null) as "dataType", sequence.seqstart::text as start,
        sequence.seqincrement::text as increment, sequence.seqmin::text as min, sequence.seqmax::text as max,
        sequence.seqcache::text as cache, sequence.seqcycle as cycle
      from pg_class relation join pg_sequence sequence on sequence.seqrelid = relation.oid
      where relation.oid = 'public.registered_column_semantics_identity_seq'::regclass`)).rows[0];
    await pool.query("rollback");
    await writeFile(join(directory, "014_column_identity.sql"), v13Sql);
    const beforeId = columns.find((column) => column.name === "id");
    const afterId = identityColumns.find((column) => column.name === "id");
    manifests.set(14, {
      version: 14, name: "column_identity",
      checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      objects: [["public", "registered_column_semantics_identity_seq", "S", "current_user"]],
      relationSemantics: [identitySemantic],
      columnAmendments: [{ action: "replace", before: beforeId, after: afterId }],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query(`select attidentity from pg_attribute
      where attrelid = 'public.registered_column_semantics'::regclass and attname = 'id'`)).rows[0]?.attidentity, "a");

    const v14Sql = "alter table registered_column_semantics alter column id set generated by default;\n";
    await writeFile(join(directory, "015_missing_identity_amendment.sql"), v14Sql);
    manifests.set(15, {
      version: 15, name: "missing_identity_amendment",
      checksum: (await import("node:crypto")).createHash("sha256").update(v14Sql).digest("hex"),
    } as never);
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /column catalog/u);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 15")).rows[0]?.count, 0);
    assert.equal((await pool.query(`select attidentity from pg_attribute
      where attrelid = 'public.registered_column_semantics'::regclass and attname = 'id'`)).rows[0]?.attidentity, "a");
  } finally {
    await pool.query("rollback").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered migration 013 forward security objects validate and record in one transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-forward-security-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = `
      create table registered_security_object (id bigint primary key);
      create sequence registered_security_sequence;
      create function registered_security_trigger() returns trigger language plpgsql
        set search_path = pg_catalog, public as $$ begin return new; end $$;
      revoke all on function registered_security_trigger() from public;
      create trigger registered_security_check before insert on registered_security_object
        for each row execute function registered_security_trigger();
      create view registered_security_view as select id from registered_security_object;
    `;
    const relationSemantics = await probeRelationSemantics(sql, ["registered_security_sequence", "registered_security_view"]);
    await writeFile(join(directory, "013_registered_security.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "registered_security",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [
        ["public", "registered_security_object", "r", "current_user"],
        ["public", "registered_security_sequence", "S", "current_user"],
        ["public", "registered_security_view", "v", "current_user"],
      ],
      relationSemantics,
      columns: [
        ["registered_security_object", "id", "bigint", true, ""],
        {
          schema: "public", relation: "registered_security_view", relkind: "v",
          name: "id", position: 1, type: "bigint", notNull: false, defaultExpression: "",
        },
      ],
      constraints: [["registered_security_object", "registered_security_object_pkey", "p", true, "PRIMARY KEY (id)"]],
      indexes: [["registered_security_object", "registered_security_object_pkey", "CREATE UNIQUE INDEX registered_security_object_pkey ON public.registered_security_object USING btree (id)"]],
      triggers: [["registered_security_object", "registered_security_check", "O", "CREATE TRIGGER registered_security_check BEFORE INSERT ON registered_security_object FOR EACH ROW EXECUTE FUNCTION registered_security_trigger()"]],
      routines: [["f", "registered_security_trigger", "", "trigger", false, ["search_path=pg_catalog, public"], "35dcfee45395dbef24cd2196a919182b"]],
      routineAcls: [["revoke", "public", "registered_security_trigger", "f", "", "PUBLIC", "EXECUTE", false]],
      validateAndConverge: async (client: PoolClient) => {
        const result = await client.query("select to_regclass('public.registered_security_view')::text as relation");
        if (result.rows[0]?.relation !== "registered_security_view") throw new Error("schema 13 manifest validation failed");
      },
    });
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select max(version) as version from core_agent_schema_migrations")).rows[0]?.version, 13);
    assert.equal((await pool.query("select to_regclass('public.registered_security_view')::text as relation")).rows[0]?.relation, "registered_security_view");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered migration 013 declares exact relation and routine ACL additions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-forward-acl-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = `
      create table registered_acl_object (id text primary key);
      grant select on table registered_acl_object to core_agent_app;
      create function registered_security_trigger() returns trigger language plpgsql
        set search_path = pg_catalog, public as $$ begin return new; end $$;
      revoke all on function registered_security_trigger() from public;
      grant execute on function registered_security_trigger() to core_agent_identity;
    `;
    await writeFile(join(directory, "013_registered_acl.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "registered_acl",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "registered_acl_object", "r", "current_user"]],
      columns: [["registered_acl_object", "id", "text", true, ""]],
      constraints: [["registered_acl_object", "registered_acl_object_pkey", "p", true, "PRIMARY KEY (id)"]],
      indexes: [["registered_acl_object", "registered_acl_object_pkey", "CREATE UNIQUE INDEX registered_acl_object_pkey ON public.registered_acl_object USING btree (id)"]],
      routines: [["f", "registered_security_trigger", "", "trigger", false, ["search_path=pg_catalog, public"], "35dcfee45395dbef24cd2196a919182b"]],
      relationAcls: [
        ["grant", "public", "registered_acl_object", "r", "core_agent_app", "SELECT", false],
      ],
      routineAcls: [
        ["revoke", "public", "registered_security_trigger", "f", "", "PUBLIC", "EXECUTE", false],
        ["grant", "public", "registered_security_trigger", "f", "", "core_agent_identity", "EXECUTE", false],
      ],
    });
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select has_table_privilege('core_agent_app', 'registered_acl_object', 'SELECT') as allowed")).rows[0]?.allowed, true);
    assert.equal((await pool.query("select has_function_privilege('core_agent_identity', 'registered_security_trigger()', 'EXECUTE') as allowed")).rows[0]?.allowed, true);

    await pool.query("revoke select on registered_acl_object from core_agent_app");
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select has_table_privilege('core_agent_app', 'registered_acl_object', 'SELECT') as allowed")).rows[0]?.allowed, true);

    await pool.query("grant insert on registered_acl_object to core_agent_app");
    await pool.query("grant execute on function registered_security_trigger() to core_agent_app");
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /ACL/u,
    );
    await pool.query("revoke insert on registered_acl_object from core_agent_app");
    await pool.query("revoke execute on function registered_security_trigger() from core_agent_app");

    await pool.query("grant select on registered_acl_object to core_agent_app with grant option");
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query(
      `select bool_or(privilege.is_grantable) as grantable
       from pg_class relation
       cross join lateral aclexplode(relation.relacl) privilege
       where relation.oid = 'registered_acl_object'::regclass
         and privilege.grantee = 'core_agent_app'::regrole and privilege.privilege_type = 'SELECT'`,
    )).rows[0]?.grantable, false);

    await pool.query("drop role if exists core_agent_unknown_acl; create role core_agent_unknown_acl; grant select on registered_acl_object to core_agent_unknown_acl");
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /schema 13 manifest validation failed: relation ACL/u,
    );
    await pool.query("revoke all on registered_acl_object from core_agent_unknown_acl; drop role core_agent_unknown_acl");
  } finally {
    await pool.query("drop owned by core_agent_unknown_acl; drop role if exists core_agent_unknown_acl").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered ACL grants and revokes fold across versions for relations and routines", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-acl-fold-"));
  const v11Sql = `
    create table registered_acl_fold (id text primary key);
    grant select on registered_acl_fold to core_agent_app;
    create function registered_acl_fold_fn() returns integer language sql
      set search_path = pg_catalog, public as 'select 1';
    revoke execute on function registered_acl_fold_fn() from public;
    grant execute on function registered_acl_fold_fn() to core_agent_identity;
  `;
  const v13Sql = `
    revoke select on registered_acl_fold from core_agent_app;
    revoke execute on function registered_acl_fold_fn() from core_agent_identity;
  `;
  try {
    await pool.query("begin");
    await pool.query(v11Sql);
    const routine = (await pool.query<{ arguments: string; config: string[] | null; definition_hash: string; result: string }>(
      `select pg_get_function_identity_arguments(oid) as arguments, pg_get_function_result(oid) as result,
              proconfig as config, md5(pg_get_functiondef(oid)) as definition_hash
       from pg_proc where oid = 'public.registered_acl_fold_fn()'::regprocedure`,
    )).rows[0]!;
    await pool.query("rollback");
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_acl_fold_grant.sql"), v11Sql);
    await writeFile(join(directory, "014_acl_fold_revoke.sql"), v13Sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13, name: "acl_fold_grant",
      checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
      objects: [["public", "registered_acl_fold", "r", "current_user"]],
      columns: [["registered_acl_fold", "id", "text", true, ""]],
      constraints: [["registered_acl_fold", "registered_acl_fold_pkey", "p", true, "PRIMARY KEY (id)"]],
      indexes: [["registered_acl_fold", "registered_acl_fold_pkey", "CREATE UNIQUE INDEX registered_acl_fold_pkey ON public.registered_acl_fold USING btree (id)"]],
      routines: [["f", "registered_acl_fold_fn", routine.arguments, routine.result, false, routine.config ?? [], routine.definition_hash]],
      relationAcls: [["grant", "public", "registered_acl_fold", "r", "core_agent_app", "SELECT", false]],
      routineAcls: [
        ["revoke", "public", "registered_acl_fold_fn", "f", "", "PUBLIC", "EXECUTE", false],
        ["grant", "public", "registered_acl_fold_fn", "f", "", "core_agent_identity", "EXECUTE", false],
      ],
    } as never);
    manifests.set(14, {
      version: 14, name: "acl_fold_revoke",
      checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      relationAcls: [["revoke", "public", "registered_acl_fold", "r", "core_agent_app", "SELECT", false]],
      routineAcls: [["revoke", "public", "registered_acl_fold_fn", "f", "", "core_agent_identity", "EXECUTE", false]],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select has_table_privilege('core_agent_app', 'registered_acl_fold', 'SELECT') as allowed")).rows[0]?.allowed, false);
    assert.equal((await pool.query("select has_function_privilege('core_agent_identity', 'registered_acl_fold_fn()', 'EXECUTE') as allowed")).rows[0]?.allowed, false);
    assert.equal((await pool.query("select max(version)::int as version from core_agent_schema_migrations")).rows[0]?.version, 14);
  } finally {
    await pool.query("rollback").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered ACL repeated grants replace grant options deterministically", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-acl-grant-option-"));
  const sqlByVersion = new Map([
    [13, `create table registered_acl_option (id text); grant select on registered_acl_option to core_agent_app;
      create function registered_acl_option_fn() returns integer language sql set search_path = pg_catalog, public as 'select 1';
      revoke execute on function registered_acl_option_fn() from public; grant execute on function registered_acl_option_fn() to core_agent_identity;`],
    [14, `grant select on registered_acl_option to core_agent_app with grant option;
      grant execute on function registered_acl_option_fn() to core_agent_identity with grant option;`],
    [15, "select 1;"],
    [16, `revoke grant option for select on registered_acl_option from core_agent_app;
      revoke grant option for execute on function registered_acl_option_fn() from core_agent_identity;`],
  ]);
  try {
    await pool.query("begin");
    await pool.query(sqlByVersion.get(13)!);
    const routine = (await pool.query<{ arguments: string; config: string[] | null; definition_hash: string; result: string }>(
      `select pg_get_function_identity_arguments(oid) as arguments, pg_get_function_result(oid) as result,
              proconfig as config, md5(pg_get_functiondef(oid)) as definition_hash
       from pg_proc where oid = 'public.registered_acl_option_fn()'::regprocedure`,
    )).rows[0]!;
    await pool.query("rollback");
    await cp(migrationsDirectory, directory, { recursive: true });
    for (const [version, sqlText] of sqlByVersion) {
      await writeFile(join(directory, `${String(version).padStart(3, "0")}_acl_option_${version}.sql`), `${sqlText}\n`);
    }
    const manifests = new Map(migrationTestInternals.schemaManifests);
    const aclFor = (grantable: boolean) => ({
      relationAcls: [["grant", "public", "registered_acl_option", "r", "core_agent_app", "SELECT", grantable]],
      routineAcls: [["grant", "public", "registered_acl_option_fn", "f", "", "core_agent_identity", "EXECUTE", grantable]],
    });
    manifests.set(13, {
      version: 13, name: "acl_option_13", checksum: (await import("node:crypto")).createHash("sha256").update(`${sqlByVersion.get(13)}\n`).digest("hex"),
      objects: [["public", "registered_acl_option", "r", "current_user"]], columns: [["registered_acl_option", "id", "text", false, ""]],
      routines: [["f", "registered_acl_option_fn", routine.arguments, routine.result, false, routine.config ?? [], routine.definition_hash]],
      routineAcls: [
        ["revoke", "public", "registered_acl_option_fn", "f", "", "PUBLIC", "EXECUTE", false],
        ...aclFor(false).routineAcls,
      ], relationAcls: aclFor(false).relationAcls,
    } as never);
    for (const [version, grantable] of [[14, true], [15, true], [16, false]] as const) {
      const sqlText = `${sqlByVersion.get(version)}\n`;
      manifests.set(version, {
        version, name: `acl_option_${version}`,
        checksum: (await import("node:crypto")).createHash("sha256").update(sqlText).digest("hex"),
        ...aclFor(grantable),
      } as never);
    }
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    const relationGrant = await pool.query<{ grantable: boolean }>(
      `select privilege.is_grantable as grantable from pg_class relation
       cross join lateral aclexplode(relation.relacl) privilege
       where relation.oid = 'registered_acl_option'::regclass and privilege.grantee = 'core_agent_app'::regrole
         and privilege.privilege_type = 'SELECT'`,
    );
    const routineGrant = await pool.query<{ grantable: boolean }>(
      `select privilege.is_grantable as grantable from pg_proc routine
       cross join lateral aclexplode(routine.proacl) privilege
       where routine.oid = 'registered_acl_option_fn()'::regprocedure and privilege.grantee = 'core_agent_identity'::regrole`,
    );
    assert.deepEqual(relationGrant.rows, [{ grantable: false }]);
    assert.deepEqual(routineGrant.rows, [{ grantable: false }]);
    assert.equal((await pool.query("select max(version)::int as version from core_agent_schema_migrations")).rows[0]?.version, 16);
  } finally {
    await pool.query("rollback").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("forward ACL fold rejects absent revokes and same-version duplicates before mutation", async (t) => {
  for (const scenario of ["relation absent revoke", "routine absent revoke", "relation duplicate grant", "routine duplicate grant"] as const) {
    await t.test(scenario, async () => {
      await resetDatabase();
      const directory = await mkdtemp(join(tmpdir(), "core-agent-acl-invalid-fold-"));
      const sqlText = "create table acl_invalid_fold_probe (id integer);\n";
      try {
        await cp(migrationsDirectory, directory, { recursive: true });
        await writeFile(join(directory, "013_acl_invalid_fold.sql"), sqlText);
        const relationEntry = ["grant", "public", "acl_invalid_fold_probe", "r", "core_agent_app", "SELECT", false] as const;
        const routineEntry = ["grant", "public", "missing_acl_fold_fn", "f", "", "core_agent_identity", "EXECUTE", false] as const;
        const manifests = new Map(migrationTestInternals.schemaManifests);
        manifests.set(13, {
          version: 13, name: "acl_invalid_fold", checksum: (await import("node:crypto")).createHash("sha256").update(sqlText).digest("hex"),
          relationAcls: scenario === "relation absent revoke"
            ? [["revoke", ...relationEntry.slice(1)]] : scenario === "relation duplicate grant" ? [relationEntry, relationEntry] : [],
          routineAcls: scenario === "routine absent revoke"
            ? [["revoke", ...routineEntry.slice(1)]] : scenario === "routine duplicate grant" ? [routineEntry, routineEntry] : [],
        } as never);
        await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /(?:invalid|duplicate) (?:relationAcls|routineAcls)/u);
        assert.equal((await pool.query("select to_regclass('public.acl_invalid_fold_probe')::text as relation")).rows[0]?.relation, null);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("recorded registered view rejects replacement by a materialized view with the same name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-relkind-drift-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = "create view registered_relkind_object as select 1::integer as id;\n";
    const relationSemantics = await probeRelationSemantics(sql, ["registered_relkind_object"]);
    await writeFile(join(directory, "013_registered_relkind.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "registered_relkind",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "registered_relkind_object", "v", "current_user"]],
      relationSemantics,
      columns: [{
        schema: "public", relation: "registered_relkind_object", relkind: "v",
        name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "",
      }],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await pool.query("drop view registered_relkind_object; create materialized view registered_relkind_object as select 1::integer as id");
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /schema 13 manifest validation failed: relation catalog/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("undeclared forward ACL rolls back its object and migration record atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-acl-rollback-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = "create table registered_acl_rollback (id text); grant select on registered_acl_rollback to public;\n";
    await writeFile(join(directory, "013_acl_rollback.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "acl_rollback",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "registered_acl_rollback", "r", "current_user"]],
      columns: [["registered_acl_rollback", "id", "text", false, ""]],
    });
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /schema 13 manifest validation failed: relation ACL/u,
    );
    assert.equal((await pool.query("select to_regclass('registered_acl_rollback')::text as object")).rows[0]?.object, null);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered relation identities reject relkind owner and same-name category drift", async (t) => {
  const cases = [
    {
      name: "table to partitioned table",
      sql: "create table registered_identity_object (id integer);\n",
      object: ["public", "registered_identity_object", "r", "current_user"] as const,
      columns: [["registered_identity_object", "id", "integer", false, ""]] as const,
      mutate: "drop table registered_identity_object; create table registered_identity_object (id integer) partition by list (id)",
    },
    {
      name: "sequence to view",
      sql: "create sequence registered_identity_object;\n",
      object: ["public", "registered_identity_object", "S", "current_user"] as const,
      columns: [] as const,
      mutate: "drop sequence registered_identity_object; create view registered_identity_object as select 1::bigint as last_value",
    },
    {
      name: "owner",
      sql: "create table registered_identity_object (id integer);\n",
      object: ["public", "registered_identity_object", "r", "current_user"] as const,
      columns: [["registered_identity_object", "id", "integer", false, ""]] as const,
      mutate: "alter table registered_identity_object owner to core_agent_app",
    },
    {
      name: "sequence owner",
      sql: "create sequence registered_identity_object;\n",
      object: ["public", "registered_identity_object", "S", "current_user"] as const,
      columns: [] as const,
      mutate: "alter sequence registered_identity_object owner to core_agent_app",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await resetDatabase();
      const directory = await mkdtemp(join(tmpdir(), "core-agent-object-identity-"));
      try {
        await cp(migrationsDirectory, directory, { recursive: true });
        await writeFile(join(directory, "013_object_identity.sql"), scenario.sql);
        const relationSemantics = scenario.object[2] === "S"
          ? await probeRelationSemantics(scenario.sql, ["registered_identity_object"])
          : undefined;
        const manifests = new Map(migrationTestInternals.schemaManifests);
        manifests.set(13, {
          version: 13,
          name: "object_identity",
          checksum: (await import("node:crypto")).createHash("sha256").update(scenario.sql).digest("hex"),
          objects: [scenario.object],
          relationSemantics,
          columns: scenario.columns,
        });
        await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
        await pool.query(scenario.mutate);
        await assert.rejects(
          migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
          /schema 13 manifest validation failed: relation catalog/u,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("registered migration 013 amends an existing schema-1 relation atomically", async (t) => {
  const scenarios = [
    { name: "declared add", declaration: "correct", succeeds: true },
    { name: "missing amendment", declaration: "missing", succeeds: false },
    { name: "wrong amendment", declaration: "wrong", succeeds: false },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      await resetDatabase();
      const directory = await mkdtemp(join(tmpdir(), "core-agent-existing-relation-amendment-"));
      const sql = "alter table runtime_containers add column capability_manifest_digest bytea;\n";
      try {
        await cp(migrationsDirectory, directory, { recursive: true });
        await writeFile(join(directory, "013_runtime_capability_digest.sql"), sql);
        const manifests = new Map(migrationTestInternals.schemaManifests);
        const amendment = scenario.declaration === "missing" ? [] : [{
          action: "add",
          after: {
            schema: "public", relation: "runtime_containers", relkind: "r",
            name: "capability_manifest_digest", position: 18,
            type: scenario.declaration === "wrong" ? "text" : "bytea",
            notNull: false, defaultExpression: "",
          },
        }];
        manifests.set(13, {
          version: 13,
          name: "runtime_capability_digest",
          checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
          columnAmendments: amendment,
        } as never);
        if (scenario.succeeds) {
          await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
          await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
          assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count, 1);
          assert.equal((await pool.query(
            "select count(*)::int as count from information_schema.columns where table_schema = 'public' and table_name = 'runtime_containers' and column_name = 'capability_manifest_digest' and data_type = 'bytea'",
          )).rows[0]?.count, 1);
        } else {
          await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /manifest validation failed/u);
          assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count, 0);
          assert.equal((await pool.query(
            "select count(*)::int as count from information_schema.columns where table_schema = 'public' and table_name = 'runtime_containers' and column_name = 'capability_manifest_digest'",
          )).rows[0]?.count, 0);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("version-owned shape amendments deterministically add replace and revoke", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-shape-fold-"));
  const v11Sql = `
    create table registered_shape_evolution (
      id text not null,
      label text,
      obsolete integer,
      constraint registered_shape_evolution_pkey primary key (id),
      constraint registered_shape_evolution_label_check check (label <> '')
    );
    create index registered_shape_evolution_label_idx on registered_shape_evolution (label);
  `;
  const v13Sql = `
    alter table registered_shape_evolution alter column label type varchar(32);
    alter table registered_shape_evolution drop column obsolete;
    alter table registered_shape_evolution add column digest bytea;
    alter table registered_shape_evolution drop constraint registered_shape_evolution_label_check;
    alter table registered_shape_evolution add constraint registered_shape_evolution_label_check check (char_length(label) > 0);
    alter table registered_shape_evolution add constraint registered_shape_evolution_digest_check check (digest is null or octet_length(digest) = 32);
    drop index registered_shape_evolution_label_idx;
    create index registered_shape_evolution_label_idx on registered_shape_evolution (lower(label));
    create index registered_shape_evolution_digest_idx on registered_shape_evolution (digest);
  `;
  const readShapes = async () => {
    const columns = (await pool.query(`select 'public' as schema, relation.relname as relation, relation.relkind as relkind,
        attribute.attname as name, attribute.attnum as position, format_type(attribute.atttypid, attribute.atttypmod) as type,
        attribute.attnotnull as "notNull", coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') as "defaultExpression"
      from pg_class relation join pg_attribute attribute on attribute.attrelid = relation.oid
        and attribute.attnum > 0 and not attribute.attisdropped
      left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
      where relation.oid = 'public.registered_shape_evolution'::regclass order by attribute.attnum`)).rows;
    const constraints = (await pool.query(`select 'public' as schema, relation.relname as relation, relation.relkind as relkind,
        catalog_constraint.conname as name, catalog_constraint.contype as type,
        catalog_constraint.convalidated as validated, pg_get_constraintdef(catalog_constraint.oid, true) as definition
      from pg_constraint catalog_constraint join pg_class relation on relation.oid = catalog_constraint.conrelid
      where relation.oid = 'public.registered_shape_evolution'::regclass order by catalog_constraint.conname`)).rows;
    const indexes = (await pool.query(`select 'public' as schema, relation.relname as relation, relation.relkind as relkind,
        index_relation.relname as name, pg_get_indexdef(index_relation.oid) as definition
      from pg_index catalog_index join pg_class relation on relation.oid = catalog_index.indrelid
      join pg_class index_relation on index_relation.oid = catalog_index.indexrelid
      where relation.oid = 'public.registered_shape_evolution'::regclass order by index_relation.relname`)).rows;
    return { columns, constraints, indexes };
  };
  const amendments = <T extends { name: string }>(before: T[], after: T[]) => {
    const beforeByName = new Map(before.map((shape) => [shape.name, shape]));
    const afterByName = new Map(after.map((shape) => [shape.name, shape]));
    return [...new Set([...beforeByName.keys(), ...afterByName.keys()])].sort().flatMap((name) => {
      const previous = beforeByName.get(name);
      const next = afterByName.get(name);
      if (previous === undefined) return [{ action: "add", after: next }];
      if (next === undefined) return [{ action: "revoke", before: previous }];
      return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ action: "replace", before: previous, after: next }];
    });
  };
  try {
    await pool.query("begin");
    await pool.query(v11Sql);
    const before = await readShapes();
    await pool.query(v13Sql);
    const after = await readShapes();
    await pool.query("rollback");

    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_shape_evolution.sql"), v11Sql);
    await writeFile(join(directory, "014_shape_amendments.sql"), v13Sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13, name: "shape_evolution",
      checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
      objects: [["public", "registered_shape_evolution", "r", "current_user"]],
      columns: before.columns, constraints: before.constraints, indexes: before.indexes,
    } as never);
    manifests.set(14, {
      version: 14, name: "shape_amendments",
      checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      columnAmendments: amendments(before.columns, after.columns),
      constraintAmendments: amendments(before.constraints, after.constraints),
      indexAmendments: amendments(before.indexes, after.indexes),
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select max(version)::int as version from core_agent_schema_migrations")).rows[0]?.version, 14);
    assert.equal((await pool.query("select count(*)::int as count from information_schema.columns where table_name = 'registered_shape_evolution' and column_name = 'digest' and data_type = 'bytea'")).rows[0]?.count, 1);
  } finally {
    await pool.query("rollback").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid replacement amendment rolls back its SQL and migration record", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-invalid-shape-amendment-"));
  const v11Sql = "create table invalid_shape_amendment (id text not null);\n";
  const v13Sql = "alter table invalid_shape_amendment alter column id type varchar(32);\n";
  const base = { schema: "public", relation: "invalid_shape_amendment", relkind: "r", name: "id", position: 1, type: "text", notNull: true, defaultExpression: "" } as const;
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_invalid_shape_base.sql"), v11Sql);
    await writeFile(join(directory, "014_invalid_shape_change.sql"), v13Sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13, name: "invalid_shape_base",
      checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
      objects: [["public", "invalid_shape_amendment", "r", "current_user"]], columns: [base],
    } as never);
    manifests.set(14, {
      version: 14, name: "invalid_shape_change",
      checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      columnAmendments: [{
        action: "replace", before: base,
        after: { ...base, type: "integer" },
      }],
    } as never);
    await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /column catalog/u);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 14")).rows[0]?.count, 0);
    assert.equal((await pool.query("select data_type from information_schema.columns where table_name = 'invalid_shape_amendment' and column_name = 'id'")).rows[0]?.data_type, "text");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shape replace and revoke require exact existing history and rollback atomically", async (t) => {
  for (const scenario of ["replace absent", "revoke absent"] as const) {
    await t.test(scenario, async () => {
      await resetDatabase();
      const directory = await mkdtemp(join(tmpdir(), "core-agent-shape-history-"));
      const v11Sql = "create table shape_history_probe (id text not null);\n";
      const v13Sql = scenario === "replace absent"
        ? "alter table shape_history_probe add column invented text;\n"
        : "select 1;\n";
      const invented = { schema: "public", relation: "shape_history_probe", relkind: "r", name: "invented", position: 2, type: "bytea", notNull: false, defaultExpression: "" } as const;
      try {
        await cp(migrationsDirectory, directory, { recursive: true });
        await writeFile(join(directory, "013_shape_history_base.sql"), v11Sql);
        await writeFile(join(directory, "014_shape_history_invalid.sql"), v13Sql);
        const manifests = new Map(migrationTestInternals.schemaManifests);
        manifests.set(13, {
          version: 13, name: "shape_history_base",
          checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
          objects: [["public", "shape_history_probe", "r", "current_user"]],
          columns: [["shape_history_probe", "id", "text", true, ""]],
        } as never);
        manifests.set(14, {
          version: 14, name: "shape_history_invalid",
          checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
          columnAmendments: scenario === "replace absent"
            ? [{ action: "replace", before: invented, after: { ...invented, type: "text" } }]
            : [{ action: "revoke", before: invented }],
        } as never);
        await assert.rejects(
          migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
          /invalid columns (?:replace|revoke)/u,
        );
        assert.equal((await pool.query("select to_regclass('public.core_agent_schema_migrations')::text as relation")).rows[0]?.relation, null);
        assert.equal((await pool.query("select count(*)::int as count from information_schema.columns where table_name = 'shape_history_probe' and column_name = 'invented'")).rows[0]?.count, 0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("shape replacement compares canonical fields rather than object property order", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-shape-order-"));
  const v11Sql = "create table shape_order_probe (id text not null);\n";
  const v13Sql = "alter table shape_order_probe alter column id type varchar(32);\n";
  const base = { schema: "public", relation: "shape_order_probe", relkind: "r", name: "id", position: 1, type: "text", notNull: true, defaultExpression: "" } as const;
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_shape_order_base.sql"), v11Sql);
    await writeFile(join(directory, "014_shape_order_replace.sql"), v13Sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, { version: 13, name: "shape_order_base", checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"), objects: [["public", "shape_order_probe", "r", "current_user"]], columns: [base] } as never);
    manifests.set(14, {
      version: 14, name: "shape_order_replace", checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
      columnAmendments: [{
        action: "replace",
        before: { name: "id", relkind: "r", relation: "shape_order_probe", schema: "public", defaultExpression: "", notNull: true, type: "text", position: 1 },
        after: { ...base, type: "character varying(32)" },
      }],
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select max(version)::int as version from core_agent_schema_migrations")).rows[0]?.version, 14);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all shape kinds reject absent history and duplicate add or revoke operations", async (t) => {
  const column = { schema: "public", relation: "shape_fold_guard", relkind: "r", name: "invented", position: 2, type: "text", notNull: false, defaultExpression: "" } as const;
  const constraint = { schema: "public", relation: "shape_fold_guard", relkind: "r", name: "invented_check", type: "c", validated: true, definition: "CHECK ((id <> ''::text))" } as const;
  const index = { schema: "public", relation: "shape_fold_guard", relkind: "r", name: "invented_idx", definition: "CREATE INDEX invented_idx ON public.shape_fold_guard USING btree (id)" } as const;
  const existingColumn = { ...column, name: "id", position: 1, notNull: true };
  const existingConstraint = { ...constraint, name: "shape_fold_guard_pkey", type: "p", definition: "PRIMARY KEY (id)" };
  const existingIndex = { ...index, name: "shape_fold_guard_pkey", definition: "CREATE UNIQUE INDEX shape_fold_guard_pkey ON public.shape_fold_guard USING btree (id)" };
  const scenarios = [
    ["column replace absent", { columnAmendments: [{ action: "replace", before: { ...column, type: "bytea" }, after: column }] }],
    ["constraint replace absent", { constraintAmendments: [{ action: "replace", before: { ...constraint, definition: "CHECK (false)" }, after: constraint }] }],
    ["index replace absent", { indexAmendments: [{ action: "replace", before: { ...index, definition: "CREATE INDEX invented_idx ON public.shape_fold_guard USING hash (id)" }, after: index }] }],
    ["constraint revoke absent", { constraintAmendments: [{ action: "revoke", before: constraint }] }],
    ["index revoke absent", { indexAmendments: [{ action: "revoke", before: index }] }],
    ["column duplicate add", { columnAmendments: [{ action: "add", after: column }, { action: "add", after: column }] }],
    ["constraint duplicate add", { constraintAmendments: [{ action: "add", after: constraint }, { action: "add", after: constraint }] }],
    ["index duplicate add", { indexAmendments: [{ action: "add", after: index }, { action: "add", after: index }] }],
    ["column duplicate revoke", { columnAmendments: [{ action: "revoke", before: existingColumn }, { action: "revoke", before: existingColumn }] }],
    ["constraint duplicate revoke", { constraintAmendments: [{ action: "revoke", before: existingConstraint }, { action: "revoke", before: existingConstraint }] }],
    ["index duplicate revoke", { indexAmendments: [{ action: "revoke", before: existingIndex }, { action: "revoke", before: existingIndex }] }],
  ] as const;
  for (const [name, amendments] of scenarios) {
    await t.test(name, async () => {
      await resetDatabase();
      const directory = await mkdtemp(join(tmpdir(), "core-agent-shape-fold-guard-"));
      const v11Sql = "create table shape_fold_guard (id text primary key);\n";
      const v13Sql = "select 1;\n";
      try {
        await cp(migrationsDirectory, directory, { recursive: true });
        await writeFile(join(directory, "013_shape_fold_guard.sql"), v11Sql);
        await writeFile(join(directory, "014_shape_fold_invalid.sql"), v13Sql);
        const manifests = new Map(migrationTestInternals.schemaManifests);
        manifests.set(13, {
          version: 13, name: "shape_fold_guard", checksum: (await import("node:crypto")).createHash("sha256").update(v11Sql).digest("hex"),
          objects: [["public", "shape_fold_guard", "r", "current_user"]], columns: [existingColumn],
          constraints: [existingConstraint], indexes: [existingIndex],
        } as never);
        manifests.set(14, {
          version: 14, name: "shape_fold_invalid", checksum: (await import("node:crypto")).createHash("sha256").update(v13Sql).digest("hex"),
          ...amendments,
        } as never);
        await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /invalid (?:columns|constraints|indexes) (?:add|replace|revoke)/u);
        assert.equal((await pool.query("select to_regclass('public.shape_fold_guard')::text as relation")).rows[0]?.relation, null);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("registered views and materialized views require exact ordered column shapes", async (t) => {
  for (const kind of ["view", "materialized view"] as const) {
    await t.test(kind, async (kindTest) => {
      for (const [drift, selection] of [
        ["add", "1::integer as id, 'safe'::text as label, 2::integer as extra"],
        ["remove", "1::integer as id"],
        ["type", "1::bigint as id, 'safe'::text as label"],
        ["order", "'safe'::text as label, 1::integer as id"],
        ["name", "1::integer as renamed, 'safe'::text as label"],
      ] as const) {
        await kindTest.test(drift, async () => {
          await resetDatabase();
          const directory = await mkdtemp(join(tmpdir(), "core-agent-view-shape-"));
          const sql = `create ${kind} registered_column_view as select 1::integer as id, 'safe'::text as label;\n`;
          try {
            const relationSemantics = await probeRelationSemantics(sql, ["registered_column_view"]);
            await cp(migrationsDirectory, directory, { recursive: true });
            await writeFile(join(directory, "013_view_shape.sql"), sql);
            const manifests = new Map(migrationTestInternals.schemaManifests);
            manifests.set(13, {
              version: 13,
              name: "view_shape",
              checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
              objects: [["public", "registered_column_view", kind === "view" ? "v" : "m", "current_user"]],
              relationSemantics,
              columns: [
                { schema: "public", relation: "registered_column_view", relkind: kind === "view" ? "v" : "m", name: "id", position: 1, type: "integer", notNull: false, defaultExpression: "" },
                { schema: "public", relation: "registered_column_view", relkind: kind === "view" ? "v" : "m", name: "label", position: 2, type: "text", notNull: false, defaultExpression: "" },
              ],
            } as never);
            await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
            await pool.query(`drop ${kind} registered_column_view; create ${kind} registered_column_view as select ${selection}`);
            await assert.rejects(migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests), /(?:relation semantic|column) catalog/u);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        });
      }
    });
  }
});

test("registered routine ACLs accept canonical complex signatures without raw SQL interpolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-routine-signatures-"));
  const sql = `
    create schema registered_types;
    create type registered_types.payload as (value text);
    create type public."QuotedType" as enum ('safe');
    create function public.registered_acl_complex(value text[]) returns integer language sql
      set search_path = pg_catalog, public as 'select 1';
    create function public.registered_acl_complex(value registered_types.payload) returns integer language sql
      set search_path = pg_catalog, public as 'select 2';
    create function public.registered_acl_quoted(value public."QuotedType") returns integer language sql
      set search_path = pg_catalog, public as 'select 3';
    create procedure public.registered_acl_procedure(value text[]) language sql
      set search_path = pg_catalog, public as 'select 1';
    revoke all on function public.registered_acl_complex(text[]) from public;
    grant execute on function public.registered_acl_complex(text[]) to core_agent_identity;
    revoke all on function public.registered_acl_complex(registered_types.payload) from public;
    revoke all on function public.registered_acl_quoted(public."QuotedType") from public;
    revoke all on procedure public.registered_acl_procedure(text[]) from public;
  `;
  try {
    await resetDatabase();
    await pool.query("begin");
    await pool.query(sql);
    const routineRows = (await pool.query<{
      arguments: string; config: string[] | null; definition_hash: string; kind: string; name: string; result: string;
    }>(`select prokind as kind, proname as name, pg_get_function_identity_arguments(oid) as arguments,
               pg_get_function_result(oid) as result, proconfig as config, md5(pg_get_functiondef(oid)) as definition_hash
        from pg_proc where pronamespace = 'public'::regnamespace and proname like 'registered_acl_%'
        order by proname, pg_get_function_identity_arguments(oid)`)).rows;
    await pool.query("rollback");
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_routine_signatures.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "routine_signatures",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      routines: routineRows.map((row) => [row.kind, row.name, row.arguments, row.result, false, row.config ?? [], row.definition_hash]),
      routineAcls: routineRows.flatMap((row) => [
        ["revoke", "public", row.name, row.kind, row.arguments, "PUBLIC", "EXECUTE", false],
        ...(row.name === "registered_acl_complex" && row.arguments.endsWith("text[]")
          ? [["grant", "public", row.name, row.kind, row.arguments, "core_agent_identity", "EXECUTE", false]]
          : []),
      ]),
    } as never);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    assert.equal((await pool.query("select has_function_privilege('core_agent_identity', 'public.registered_acl_complex(text[])', 'EXECUTE') as allowed")).rows[0]?.allowed, true);
    assert.equal((await pool.query("select has_function_privilege('core_agent_identity', 'public.registered_acl_complex(registered_types.payload)', 'EXECUTE') as allowed")).rows[0]?.allowed, false);

    await pool.query("grant execute on function public.registered_acl_complex(registered_types.payload) to core_agent_identity");
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /routine ACL/u,
    );
    await pool.query("revoke execute on function public.registered_acl_complex(registered_types.payload) from core_agent_identity");

    await pool.query("grant execute on function public.registered_acl_complex(text[]) to core_agent_identity with grant option");
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
    const grantOption = await pool.query<{ grantable: boolean }>(
      `select privilege.is_grantable as grantable
       from pg_proc routine cross join lateral aclexplode(routine.proacl) privilege
       where routine.oid = 'public.registered_acl_complex(text[])'::regprocedure
         and privilege.grantee = 'core_agent_identity'::regrole`,
    );
    assert.deepEqual(grantOption.rows, [{ grantable: false }]);

    await pool.query("grant execute on procedure public.registered_acl_procedure(text[]) to core_agent_app");
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /routine ACL/u,
    );
    await pool.query("revoke execute on procedure public.registered_acl_procedure(text[]) from core_agent_app");
    await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
  } finally {
    await pool.query("rollback").catch(() => undefined);
    await pool.query("drop schema if exists registered_types cascade").catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("routine ACL injection-shaped declarations fail before migration SQL can mutate the database", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-routine-injection-"));
  const sql = "create table routine_acl_injection_probe (id integer);\n";
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_routine_injection.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "routine_injection",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      routineAcls: [["grant", "public", "registered_acl_complex", "f", "text[]); create table injected(); --", "core_agent_identity", "EXECUTE", false]],
    } as never);
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /routine ACL declaration/u,
    );
    assert.equal((await pool.query("select to_regclass('public.routine_acl_injection_probe')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select to_regclass('public.core_agent_schema_migrations')::text as relation")).rows[0]?.relation, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relation ownership cannot be redeclared by a later manifest", async () => {
  await resetDatabase();
  const directory = await mkdtemp(join(tmpdir(), "core-agent-duplicate-owner-"));
  const sql = "create table duplicate_owner_probe (id integer);\n";
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    await writeFile(join(directory, "013_duplicate_owner.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "duplicate_owner",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "runtime_containers", "r", "current_user"]],
    });
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /duplicate object ownership/u,
    );
    assert.equal((await pool.query("select to_regclass('public.duplicate_owner_probe')::text as relation")).rows[0]?.relation, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("registered migration 013 union failure rolls back every object and record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "core-agent-forward-union-failure-"));
  try {
    await cp(migrationsDirectory, directory, { recursive: true });
    const sql = `
      create table registered_union_object (id text primary key);
      create function undeclared_union_function() returns integer language sql as 'select 1';
    `;
    await writeFile(join(directory, "013_union_failure.sql"), sql);
    const manifests = new Map(migrationTestInternals.schemaManifests);
    manifests.set(13, {
      version: 13,
      name: "union_failure",
      checksum: (await import("node:crypto")).createHash("sha256").update(sql).digest("hex"),
      objects: [["public", "registered_union_object", "r", "current_user"]],
      columns: [["registered_union_object", "id", "text", true, ""]],
      constraints: [["registered_union_object", "registered_union_object_pkey", "p", true, "PRIMARY KEY (id)"]],
      indexes: [["registered_union_object", "registered_union_object_pkey", "CREATE UNIQUE INDEX registered_union_object_pkey ON public.registered_union_object USING btree (id)"]],
    });
    await assert.rejects(
      migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests),
      /schema 13 manifest validation failed: routine catalog/u,
    );
    assert.equal((await pool.query("select to_regclass('public.registered_union_object')::text as relation")).rows[0]?.relation, null);
    assert.equal((await pool.query("select to_regprocedure('public.undeclared_union_function()')::text as routine")).rows[0]?.routine, null);
    assert.equal((await pool.query("select count(*)::int as count from core_agent_schema_migrations where version = 13")).rows[0]?.count, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recorded current max rejects undeclared security catalog objects and grantees", async (t) => {
  const mutations: Array<[string, string]> = [
    ["unknown ACL grantee", "create role core_agent_unknown_acl; grant select on auth_subjects to core_agent_unknown_acl"],
    ["NOT VALID constraint", "alter table auth_subjects add constraint hostile_not_valid check (true) not valid"],
    ["SECURITY DEFINER public function", "create function hostile_public() returns integer language sql security definer as 'select 1'"],
    ["view", "create view hostile_view as select actor_id from actors"],
    ["materialized view", "create materialized view hostile_materialized as select actor_id from actors"],
    ["sequence", "create sequence hostile_security_sequence"],
    ["index", "create index hostile_index on tenants(status)"],
    ["trigger", "create trigger hostile_trigger before delete on actors for each row execute function enforce_core_session_revoked_deletion()"],
    ["function", "create function hostile_function() returns integer language sql as 'select 1'"],
    ["procedure", "create procedure hostile_procedure() language sql as 'select 1'"],
  ];
  for (const [name, mutation] of mutations) {
    await t.test(name, async () => {
      await resetDatabase();
      await applyMigrations(pool, migrationsDirectory);
      if (name === "unknown ACL grantee") await pool.query("drop role if exists core_agent_unknown_acl");
      await pool.query(mutation);
      await assert.rejects(applyMigrations(pool, migrationsDirectory), /manifest validation failed/u);
      if (name === "unknown ACL grantee") {
        await pool.query("drop owned by core_agent_unknown_acl; drop role core_agent_unknown_acl").catch(() => undefined);
      }
    });
  }
});

test("recorded schema 10 rejects missing disabled or rebound authority trigger", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await pool.query("alter table memberships disable trigger memberships_ordinary_actor_authority_check");
  await assert.rejects(applyMigrations(pool, migrationsDirectory), /schema 10 manifest validation failed: trigger/);
});

test("recorded schema 10 rejects altered constraint index function owner ACL sequence and column shapes", async (t) => {
  const mutations: Array<[string, string]> = [
    ["constraint", "alter table memberships drop constraint memberships_source_check"],
    ["index", "drop index memberships_ordinary_actor_authority_idx"],
    ["function definition", `create or replace function enforce_core_session_revoked_deletion() returns trigger language plpgsql as $$ begin return old; end $$`],
    ["catalog", "alter table auth_subjects owner to core_agent_migrator"],
    ["table revoke", "grant select on private_identity_pii to public"],
    ["sequence catalog", "create sequence undeclared_manifest_sequence"],
    ["column", "alter table auth_subjects alter column provider_subject drop not null"],
  ];
  for (const [category, mutation] of mutations) {
    await t.test(category, async () => {
      await resetDatabase();
      await applyMigrations(pool, migrationsDirectory);
      await pool.query(mutation);
      if (category === "table revoke") {
        await applyMigrations(pool, migrationsDirectory);
        assert.equal((await pool.query("select has_table_privilege('public', 'private_identity_pii', 'select') as allowed")).rows[0]?.allowed, false);
      } else {
        await assert.rejects(
          applyMigrations(pool, migrationsDirectory),
          category === "sequence catalog"
            ? /schema 12 manifest validation failed: relation catalog/u
            : /schema 10 (manifest validation|ACL convergence) failed/u,
        );
      }
    });
  }
});

test("schema 10 authority functions pin the reviewed search path", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const functions = await pool.query<{ name: string; config: string[] | null }>(
    `select proname as name, proconfig as config
     from pg_proc
     where pronamespace = 'public'::regnamespace
       and proname = any($1::text[])
     order by proname`,
    [["enforce_core_session_revoked_deletion", "enforce_identity_worker_job_kind", "enforce_ordinary_membership_actor_authority"]],
  );
  assert.deepEqual(functions.rows, [
    { name: "enforce_core_session_revoked_deletion", config: ["search_path=pg_catalog, public"] },
    { name: "enforce_identity_worker_job_kind", config: ["search_path=pg_catalog, public"] },
    { name: "enforce_ordinary_membership_actor_authority", config: ["search_path=pg_catalog, public"] },
  ]);
});

test("real Identity login commits and atomically rolls back the Task 3 cross-table graph", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const password = randomBytes(32).toString("base64url");
  const administrator = await pool.connect();
  let identity: Client | undefined;
  try {
    const statement = await administrator.query<{ statement: string }>(
      "select format('alter role core_agent_identity login password %L', $1::text) as statement",
      [password],
    );
    await administrator.query(statement.rows[0]!.statement);
    const target = new URL(assertDisposableDatabaseUrl(testDatabaseUrl));
    identity = new Client({
      host: target.hostname,
      port: Number(target.port || 5432),
      database: target.pathname.slice(1),
      user: "core_agent_identity",
      password,
    });
    await identity.connect();
    assert.equal((await identity.query<{ current_user: string }>("select current_user")).rows[0]?.current_user, "core_agent_identity");
    for (const table of ["runtime_containers", "conversations", "messages", "secret_references", "stream_cursors"]) {
      await assert.rejects(identity.query(`select count(*) from ${table}`), /permission denied/);
    }
    await assert.doesNotReject(identity.query("delete from core_sessions where false"));

    const writeGraph = async (suffix: string, injectFailure: boolean) => {
      const tenant = `tenant_identity_${suffix}`;
      const actor = `actor_identity_${suffix}`;
      const membership = `membership_identity_${suffix}`;
      const profile = `profile_identity_${suffix}`;
      const subject = `subject_identity_${suffix}`;
      const event = `event_identity_${suffix}`;
      const timestamp = new Date("2026-08-11T00:00:00.000Z");
      await identity!.query("begin isolation level serializable");
      try {
        await identity!.query(
          `insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
           values ($1, 1, 1, 'human', 'Synthetic identity actor', 'active', $2, $2)`, [actor, timestamp],
        );
        await identity!.query(
          `insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
           values ($1, 1, 1, 'b2c', 'active', 'Synthetic identity tenant', $2, $2)`, [tenant, timestamp],
        );
        await identity!.query(
          `insert into memberships (tenant_id, membership_id, actor_id, schema_version, resource_version, roles, membership_source, seat_ref, status, created_at, updated_at)
           values ($1, $2, $3, 1, 1, array['student'], 'self', null, 'active', $4, $4)`, [tenant, membership, actor, timestamp],
        );
        await identity!.query(
          `insert into profiles (tenant_id, profile_id, schema_version, resource_version, owner_actor_id, profile_kind, hermes_profile_ref, description, status, provider_config_id, model_id, created_at, updated_at)
           values ($1, $2, 1, 1, $3, 'default', $2, 'Synthetic identity profile', 'active', 'synthetic-provider', 'synthetic-model', $4, $4)`, [tenant, profile, actor, timestamp],
        );
        await identity!.query(
          `insert into auth_subjects (auth_subject_id, actor_id, provider, provider_subject, provider_identity_kind, verified_at, status, resource_version, created_at, updated_at)
           values ($1, $2, 'supabase', $3, 'email_password', $4, 'active', 1, $4, $4)`, [subject, actor, `opaque-provider-${suffix}`, timestamp],
        );
        await identity!.query(
          `insert into private_identity_pii (actor_id, normalized_email_hmac, encrypted_email, encryption_key_ref, created_at, updated_at)
           values ($1, decode($2, 'hex'), decode('01', 'hex'), 'synthetic-key-v1', $3, $3)`, [actor, suffix.padEnd(64, "0").slice(0, 64), timestamp],
        );
        await identity!.query(
          `insert into idempotency_records (tenant_id, idempotency_key, payload_hash, operation, status, result_ref, response_json, expires_at, created_at, updated_at)
           values ($1, $2, $3, 'identity.register-b2c', 'completed', $4, '{}'::jsonb, $5, $6, $6)`,
          [tenant, `idempotency-${suffix}`, `sha256:${suffix.padEnd(64, "a").slice(0, 64)}`, actor, new Date("2026-08-13T00:00:00.000Z"), timestamp],
        );
        await identity!.query("insert into stream_sequences (tenant_id, stream_id, last_sequence) values ($1, $2, 1)", [tenant, actor]);
        await identity!.query(
          `insert into product_events (tenant_id, event_id, stream_id, schema_version, sequence, event_type, occurred_at, request_id, trace_id, correlation_id, causation_id, profile_id, payload)
           values ($1, $2, $3, 1, 1, 'identity.actor.registered', $4, $5, $6, $5, $5, $7, '{}'::jsonb)`,
          [tenant, event, actor, timestamp, `request-${suffix}`, `trace-${suffix}`, profile],
        );
        await identity!.query(
          `insert into audit_events (tenant_id, audit_event_id, schema_version, occurred_at, actor_id, membership_id, effective_role, action, resource_type, resource_id, decision, outcome, request_id, trace_id, reason_summary, event_json)
           values ($1, $2, 1, $3, $4, $5, 'student', 'identity.register-b2c', 'actor', $4, 'allowed', 'succeeded', $6, $7, 'synthetic registration', '{}'::jsonb)`,
          [tenant, `audit-${suffix}`, timestamp, actor, membership, `request-${suffix}`, `trace-${suffix}`],
        );
        await identity!.query(
          `insert into outbox (tenant_id, outbox_id, event_id, delivery_target, status, attempt_count, next_attempt_at, created_at, updated_at)
           values ($1, $2, $3, 'internal_event_stream', 'pending', 0, $4, $4, $4)`,
          [tenant, `outbox-${suffix}`, event, timestamp],
        );
        if (injectFailure) throw new Error("synthetic injected rollback");
        await identity!.query("commit");
      } catch (error) {
        await identity!.query("rollback");
        throw error;
      }
      return { tenant, actor, membership, profile, subject };
    };

    const committed = await writeGraph("1".repeat(32), false);
    await assert.rejects(writeGraph("2".repeat(32), true), /synthetic injected rollback/);
    const enqueueIdentityJob = (jobKind: string) => identity!.query(
      `insert into worker_jobs (
        tenant_id, job_id, job_kind, status, attempt_count, max_attempts,
        next_attempt_at, payload_ref, runtime_command, target_command_version,
        effect_state, created_at, updated_at
      ) values ($1, $2, $3, 'succeeded', 0, 3, $4, $5, null, null, 'pre_effect', $4, $4)`,
      [
        committed.tenant,
        `job_identity_${jobKind}`,
        jobKind,
        new Date("2026-08-11T00:00:00.000Z"),
        `identity:${jobKind}`,
      ],
    );
    for (const jobKind of ["project_platform_memberships", "finalize_account_deletion"]) {
      await assert.doesNotReject(enqueueIdentityJob(jobKind));
    }
    for (const jobKind of ["provision_runtime", "reconcile_runtime", "execute_agent_run", "dispatch_outbox"]) {
      await assert.rejects(enqueueIdentityJob(jobKind), /Identity role may enqueue only identity Worker jobs/);
    }
    await administrator.query(`
      create or replace function public.identity_worker_job_security_definer_probe(
        target_tenant text,
        target_job text,
        target_kind text
      ) returns void
      language sql
      security definer
      set search_path = pg_catalog, public
      as $probe$
        insert into public.worker_jobs (
          tenant_id, job_id, job_kind, status, attempt_count, max_attempts,
          next_attempt_at, payload_ref, runtime_command, target_command_version,
          effect_state, created_at, updated_at
        ) values (
          target_tenant, target_job, target_kind, 'succeeded', 0, 3,
          timestamptz '2026-08-11T00:00:00.000Z', 'identity:security-definer-probe',
          null, null, 'pre_effect', timestamptz '2026-08-11T00:00:00.000Z',
          timestamptz '2026-08-11T00:00:00.000Z'
        )
      $probe$
    `);
    await assert.rejects(
      identity.query(
        "select public.identity_worker_job_security_definer_probe($1, $2, 'provision_runtime')",
        [committed.tenant, "job_identity_security_definer_probe"],
      ),
      /Identity role may enqueue only identity Worker jobs/,
    );
    const rolledBackSuffix = "2".repeat(32);
    assert.equal((await pool.query<{ count: number }>(
      `select (
        (select count(*) from actors where actor_id = $1)
        + (select count(*) from tenants where tenant_id = $2)
        + (select count(*) from memberships where membership_id = $3)
        + (select count(*) from profiles where profile_id = $4)
        + (select count(*) from auth_subjects where auth_subject_id = $5)
        + (select count(*) from private_identity_pii where actor_id = $1)
        + (select count(*) from idempotency_records where idempotency_key = $6)
        + (select count(*) from stream_sequences where stream_id = $1)
        + (select count(*) from product_events where event_id = $7)
        + (select count(*) from audit_events where audit_event_id = $8)
        + (select count(*) from outbox where outbox_id = $9)
      )::int as count`,
      [
        `actor_identity_${rolledBackSuffix}`, `tenant_identity_${rolledBackSuffix}`,
        `membership_identity_${rolledBackSuffix}`, `profile_identity_${rolledBackSuffix}`,
        `subject_identity_${rolledBackSuffix}`, `idempotency-${rolledBackSuffix}`,
        `event_identity_${rolledBackSuffix}`, `audit-${rolledBackSuffix}`, `outbox-${rolledBackSuffix}`,
      ],
    )).rows[0]?.count, 0);

    const rolledBackFinalization = await writeGraph("3".repeat(32), false);
    const createCoreSession = async (graph: typeof committed, suffix: string, status: "active" | "revoked" | "expired") => {
      const timestamp = new Date("2026-08-11T00:00:00.000Z");
      await identity!.query(
        `insert into core_sessions (
          session_id, secret_digest, csrf_digest, actor_id, auth_subject_id, client_kind,
          status, device_label, created_at, last_seen_at, idle_expires_at,
          absolute_expires_at, reauthenticated_at, revocation_reason, resource_version, updated_at
        ) values (
          $1, decode($2, 'hex'), null, $3, $4, 'web', $5, 'Synthetic browser',
          $6, $6, $7, $8, null, $9, 1, $6
        )`,
        [
          `session_identity_${suffix}`, suffix.padEnd(64, "f").slice(0, 64), graph.actor,
          graph.subject, status, timestamp, new Date("2026-08-11T01:00:00.000Z"),
          new Date("2026-08-13T00:00:00.000Z"), status === "revoked" ? "account_deletion" : null,
        ],
      );
    };
    await createCoreSession(committed, "4".repeat(32), "active");
    await createCoreSession(committed, "5".repeat(32), "revoked");
    await createCoreSession(committed, "7".repeat(32), "expired");
    await assert.rejects(
      identity.query(
        `insert into core_sessions (
          session_id, secret_digest, csrf_digest, actor_id, auth_subject_id, client_kind,
          status, device_label, created_at, last_seen_at, idle_expires_at,
          absolute_expires_at, reauthenticated_at, revocation_reason, resource_version, updated_at
        ) values (
          $1, decode(repeat('88', 32), 'hex'), null, $2, $3, 'web', 'revoked', null,
          $4, $4, $5, $6, null, 'account_deletion', 1, $4
        )`,
        [
          "session_identity_mismatched_subject", committed.actor, rolledBackFinalization.subject,
          new Date("2026-08-11T00:00:00.000Z"), new Date("2026-08-11T01:00:00.000Z"),
          new Date("2026-08-13T00:00:00.000Z"),
        ],
      ),
      /foreign key constraint/,
    );
    await assert.rejects(
      identity.query("delete from core_sessions where session_id = $1", [`session_identity_${"4".repeat(32)}`]),
      /only revoked Core Sessions may be deleted/,
    );
    assert.equal((await identity.query<{ count: number }>(
      "select count(*)::int as count from core_sessions where actor_id = $1",
      [committed.actor],
    )).rows[0]?.count, 3);
    await assert.rejects(
      identity.query("delete from core_sessions where session_id = $1", [`session_identity_${"7".repeat(32)}`]),
      /only revoked Core Sessions may be deleted/,
    );
    await identity.query(
      "update core_sessions set status = 'revoked', revocation_reason = 'account_deletion', resource_version = resource_version + 1 where actor_id = $1",
      [committed.actor],
    );
    await identity.query("update auth_subjects set status = 'revoked', resource_version = resource_version + 1 where actor_id = $1", [committed.actor]);

    await createCoreSession(rolledBackFinalization, "6".repeat(32), "revoked");
    await identity.query("update auth_subjects set status = 'revoked', resource_version = resource_version + 1 where actor_id = $1", [rolledBackFinalization.actor]);
    const finalizeIdentity = async (graph: typeof committed, injectFailure: boolean) => {
      await identity!.query("begin isolation level serializable");
      try {
        await identity!.query("delete from core_sessions where actor_id = $1 and status = 'revoked'", [graph.actor]);
        await identity!.query("delete from auth_subjects where actor_id = $1 and status = 'revoked'", [graph.actor]);
        await identity!.query("delete from private_identity_pii where actor_id = $1", [graph.actor]);
        if (injectFailure) throw new Error("synthetic finalization rollback");
        await identity!.query("commit");
      } catch (error) {
        await identity!.query("rollback");
        throw error;
      }
    };
    await finalizeIdentity(committed, false);
    await assert.rejects(finalizeIdentity(rolledBackFinalization, true), /synthetic finalization rollback/);
    for (const [graph, expected] of [[committed, 0], [rolledBackFinalization, 1]] as const) {
      const retained = await identity.query<{ sessions: number; subjects: number; pii: number }>(
        `select
          (select count(*)::int from core_sessions where actor_id = $1) as sessions,
          (select count(*)::int from auth_subjects where actor_id = $1) as subjects,
          (select count(*)::int from private_identity_pii where actor_id = $1) as pii`,
        [graph.actor],
      );
      assert.deepEqual(retained.rows[0], { sessions: expected, subjects: expected, pii: expected });
    }

    await identity.query("begin isolation level serializable");
    await identity.query("update actors set status = 'disabled', resource_version = resource_version + 1 where actor_id = $1", [committed.actor]);
    await identity.query("update memberships set status = 'suspended', resource_version = resource_version + 1 where tenant_id = $1 and membership_id = $2", [committed.tenant, committed.membership]);
    await identity.query("update profiles set status = 'suspended', resource_version = resource_version + 1 where tenant_id = $1 and profile_id = $2", [committed.tenant, committed.profile]);
    await identity.query(
      `insert into worker_jobs (tenant_id, job_id, job_kind, status, attempt_count, max_attempts, next_attempt_at, payload_ref, effect_state, created_at, updated_at)
       values ($1, 'job_identity_projection', 'project_platform_memberships', 'queued', 0, 3, $2, 'identity:projection', 'pre_effect', $2, $2)`,
      [committed.tenant, new Date("2026-08-11T00:00:00.000Z")],
    );
    await identity.query("rollback");
  } finally {
    await identity?.end().catch(() => undefined);
    await administrator.query("drop function if exists public.identity_worker_job_security_definer_probe(text, text, text)").catch(() => undefined);
    await administrator.query("alter role core_agent_identity password null").catch(() => undefined);
    administrator.release();
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
    await applyMigrationPrefix(v7Directory, 7);
    assert.equal(await readSchemaVersion(db), 7);
    await applyMigrations(pool, migrationsDirectory);
    assert.equal(await readSchemaVersion(db), 12);

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
    await applyMigrationPrefix(v8Directory, 8);
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
    await applyMigrationPrefix(legacyDirectory, 3);
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
    await applyMigrationPrefix(v4Directory, 4);
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
    await applyMigrationPrefix(v5Directory, 5);
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
    await applyMigrationPrefix(v5Directory, 5);
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

  const occurredAt = new Date("2026-08-03T13:00:00.000Z");
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
    occurred_at: "2026-08-03T13:00:00.000Z",
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
