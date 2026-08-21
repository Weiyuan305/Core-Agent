import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { applyMigrations, migrationTestInternals } from "../src/db/migrate.js";
import { EXPECTED_SCHEMA_VERSION } from "../src/db/schema-version.js";
import { workerJobKinds } from "../src/repositories/jobs.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const newTables = [
  "capabilities",
  "capability_runtime_projections",
  "capability_versions",
  "entitlement_assignments",
  "entitlement_snapshot_capabilities",
  "entitlement_snapshot_sources",
  "entitlement_snapshots",
  "entitlements",
  "pack_members",
  "pack_products",
  "pack_versions",
  "platform_authority_audit",
  "profile_snapshot_pointers",
  "runtime_activity",
  "tenant_pack_releases",
] as const;

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
}

async function ensureRoles(): Promise<void> {
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

async function applyPrefix(maximumVersion: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `core-agent-v${maximumVersion}-migrations-`));
  await cp(migrationsDirectory, directory, { recursive: true });
  for (const filename of await readdir(directory)) {
    const version = Number(/^([0-9]{3,})_/u.exec(filename)?.[1] ?? 0);
    if (version > maximumVersion) await rm(join(directory, filename));
  }
  const manifests = new Map(
    [...migrationTestInternals.schemaManifests].filter(([version]) => version <= maximumVersion),
  );
  await migrationTestInternals.applyMigrationsWithManifests(pool, directory, manifests);
  return directory;
}

async function seedIdentityGraph(tenantId: string, tenantMode: "b2b" | "b2c" = "b2b"): Promise<void> {
  const now = new Date("2026-08-21T00:00:00.000Z");
  await pool.query(
    `insert into tenants (
       tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at
     ) values ($1, 1, 1, $2, 'active', $3, $4, $4)`,
    [tenantId, tenantMode, `Synthetic ${tenantId}`, now],
  );
  await pool.query(
    `insert into actors (
       actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at
     ) values ($1, 1, 1, 'human', $2, 'active', $3, $3)`,
    [`actor_${tenantId}`, `Actor ${tenantId}`, now],
  );
  await pool.query(
    `insert into memberships (
       tenant_id, membership_id, actor_id, schema_version, resource_version, roles,
       membership_source, seat_ref, status, created_at, updated_at
     ) values ($1, $2, $3, 1, 1, $4, $5, null, 'active', $6, $6)`,
    [
      tenantId,
      `membership_${tenantId}`,
      `actor_${tenantId}`,
      tenantMode === "b2b" ? ["admin", "consultant"] : ["student"],
      tenantMode === "b2b" ? "company" : "self",
      now,
    ],
  );
  await pool.query(
    `insert into profiles (
       tenant_id, profile_id, schema_version, resource_version, owner_actor_id, profile_kind,
       hermes_profile_ref, description, status, provider_config_id, model_id, created_at, updated_at
     ) values ($1, $2, 1, 1, $3, $4, $2, 'Synthetic entitlement profile', 'active', 'provider', 'model', $5, $5)`,
    [tenantId, `profile_${tenantId}`, `actor_${tenantId}`, tenantMode === "b2b" ? "consultant" : "default", now],
  );
}

async function seedCatalogAndEntitlement(
  tenantId: string,
  options: { seats?: number; tenantMode?: "b2b" | "b2c" } = {},
): Promise<void> {
  const tenantMode = options.tenantMode ?? "b2b";
  await seedIdentityGraph(tenantId, tenantMode);
  const now = new Date("2026-08-21T00:00:00.000Z");
  await pool.query(
    `insert into capabilities (
       capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at
     ) values ('capability_read', 'Read capability', 'synthetic', 'mcp', 1, $1, $1)`,
    [now],
  );
  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_read', 'capability_read', '1.0.0', 'mcp',
       'manifest:sha256:${"a".repeat(64)}', 'synthetic/read@1.0.0',
       'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb,
       'reviewed', 1, $1, $1
     )`,
    [now],
  );
  await pool.query(
    `insert into pack_products (
       pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at
     ) values ('pack_product_read', 'Read pack', array['b2b','b2c'], 1, $1, $1)`,
    [now],
  );
  await pool.query(
    `insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_version_read', 'pack_product_read', '1.0.0', 'draft', 1, $1, $1)`,
    [now],
  );
  await pool.query(
    `insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
       resource_version, created_at, updated_at
     ) values (
       'pack_member_read', 'pack_version_read', 1, 'capability_read', 'capability_version_read', '1.0.0',
       1, $1, $1
     )`,
    [now],
  );
  await pool.query("update pack_versions set status = 'published', resource_version = 2, updated_at = $1 where pack_version_id = 'pack_version_read'", [now]);
  await pool.query(
    `insert into tenant_pack_releases (
       tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
       generation, status, resource_version, created_at, updated_at
     ) values ('release_read', $1, 'pack_product_read', 'pack_version_read', '1.0.0', 1, 'current', 1, $2, $2)`,
    [tenantId, now],
  );
  await pool.query(
    `insert into entitlements (
       entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
       pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
       expires_at, status, reason_code, resource_version
     ) values (
       'entitlement_read', $1, 'pack_product_read', 'release_read', 'pack_version_read',
       '1.0.0', 'platform_manual', 'order_read', $2, $3, $4,
       clock_timestamp() + interval '30 days', 'active', 'platform_grant', 1
     )`,
    [tenantId, tenantMode, tenantMode === "b2b" ? "seat" : "automatic", tenantMode === "b2b" ? options.seats ?? 1 : null],
  );
}

function constraintName(error: unknown): string | undefined {
  return (error as { constraint?: string }).constraint;
}

async function withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

test.before(async () => ensureRoles());
test.beforeEach(async () => resetDatabase());
test.after(async () => pool.end());

test("schema 13 migrates both empty and schema-12 databases without changing identity history", async () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, 13);
  await applyMigrations(pool, migrationsDirectory);
  assert.deepEqual(
    (await pool.query("select version, name from core_agent_schema_migrations order by version")).rows.at(-1),
    { version: 13, name: "entitlement_capability_authority" },
  );

  await resetDatabase();
  const prefixDirectory = await applyPrefix(12);
  try {
    const historyBefore = await pool.query("select version, name, checksum, applied_at from core_agent_schema_migrations order by version");
    await applyMigrations(pool, migrationsDirectory);
    const historyAfter = await pool.query("select version, name, checksum, applied_at from core_agent_schema_migrations order by version");
    assert.deepEqual(historyAfter.rows.slice(0, 12), historyBefore.rows);
    assert.equal(historyAfter.rows[12]?.version, 13);
  } finally {
    await rm(prefixDirectory, { recursive: true, force: true });
  }
});

test("schema 13 registers the exact authority tables and required query indexes", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any($1::text[])
     order by table_name`,
    [newTables],
  );
  assert.deepEqual(tables.rows.map((row) => row.table_name), [...newTables]);

  const requiredIndexes = [
    "capability_runtime_projections_claim_idx",
    "entitlement_assignments_active_entitlement_idx",
    "entitlement_assignments_active_profile_idx",
    "entitlements_active_authority_idx",
    "entitlements_due_expiry_idx",
    "profile_snapshot_pointers_snapshot_idx",
    "runtime_activity_due_idle_stop_idx",
    "tenant_pack_releases_affected_idx",
    "worker_jobs_capability_projection_claim_idx",
  ];
  const indexes = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public' and indexname = any($1::text[]) order by indexname`,
    [requiredIndexes],
  );
  assert.deepEqual(indexes.rows.map((row) => row.indexname), requiredIndexes);

  const requiredConstraints = [
    "capability_versions_exact_ref_key",
    "entitlement_assignments_entitlement_fkey",
    "entitlement_assignments_profile_fkey",
    "entitlements_assignment_mode_check",
    "entitlements_order_key",
    "entitlements_release_fkey",
    "entitlements_validity_check",
    "pack_members_capability_version_fkey",
    "pack_members_order_key",
    "profile_snapshot_pointers_snapshot_fkey",
    "runtime_containers_capability_manifest_digest_check",
    "tenant_pack_releases_generation_key",
    "tenant_pack_releases_pack_version_fkey",
  ];
  const constraints = await pool.query<{ conname: string }>(
    `select conname from pg_constraint where connamespace = 'public'::regnamespace
       and conname = any($1::text[]) order by conname`,
    [requiredConstraints],
  );
  assert.deepEqual(constraints.rows.map((row) => row.conname), requiredConstraints);
});

test("every schema 13 foreign key has a valid source-column prefix index", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const missing = await pool.query<{ constraint_name: string }>(`
    select constraint_row.conname as constraint_name
    from pg_constraint constraint_row
    join pg_class relation on relation.oid = constraint_row.conrelid
    where constraint_row.contype = 'f'
      and relation.relname = any($1::text[])
      and not exists (
        select 1
        from pg_index index_row
        where index_row.indrelid = constraint_row.conrelid
          and index_row.indisvalid
          and index_row.indisready
          and index_row.indnkeyatts >= cardinality(constraint_row.conkey)
          and not exists (
            select 1
            from unnest(constraint_row.conkey) with ordinality as key_column(attnum, position)
            where index_row.indkey[(key_column.position - 1)::integer] <> key_column.attnum
          )
      )
    order by constraint_row.conname
  `, [newTables]);
  assert.deepEqual(missing.rows, []);
});

test("schema 13 authority ACLs are private and grant only reviewed service operations", async () => {
  await applyMigrations(pool, migrationsDirectory);
  const privileges = await pool.query<{ grantee: string; privilege_type: string; table_name: string }>(
    `select grantee, table_name, privilege_type
     from information_schema.role_table_grants
     where table_schema = 'public' and table_name = any($1::text[])
       and grantee in ('PUBLIC', 'core_agent_app', 'core_agent_identity')
     order by grantee, table_name, privilege_type`,
    [newTables],
  );
  assert.equal(privileges.rows.some((row) => row.grantee === "PUBLIC"), false);
  assert.equal(privileges.rows.some((row) => row.grantee === "core_agent_app" && row.table_name === "platform_authority_audit"), false);
  assert.equal(privileges.rows.some((row) => row.grantee === "core_agent_identity" && row.table_name === "platform_authority_audit" && row.privilege_type === "INSERT"), true);
  assert.equal(privileges.rows.some((row) => row.grantee === "core_agent_identity" && row.table_name === "profile_snapshot_pointers" && row.privilege_type === "UPDATE"), false);

  const functionPrivileges = await pool.query<{ grantee: string; privilege_type: string }>(
    `select grantee, privilege_type from information_schema.routine_privileges
     where specific_schema = 'public' and routine_name = 'advance_profile_snapshot_pointer'
       and grantee in ('PUBLIC', 'core_agent_app', 'core_agent_identity')
     order by grantee`,
  );
  assert.deepEqual(functionPrivileges.rows, [{ grantee: "core_agent_identity", privilege_type: "EXECUTE" }]);
});

test("catalog, release, and snapshot history is fail-closed immutable", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_immutable");
  const now = new Date("2026-08-21T00:00:00.000Z");
  await pool.query(
    `insert into entitlement_snapshots (
       snapshot_id, tenant_id, profile_id, snapshot_version, canonical_input_hash, resource_version
     ) values ('snapshot_immutable', 'tenant_immutable', 'profile_tenant_immutable', 1, $1, 1)`,
    [`sha256:${"b".repeat(64)}`],
  );
  await pool.query(
    `insert into entitlement_snapshot_sources (
       tenant_id, profile_id, snapshot_id, source_kind, source_id, source_order, created_at
     ) values ('tenant_immutable', 'profile_tenant_immutable', 'snapshot_immutable', 'entitlement', 'entitlement_read', 1, $1)`,
    [now],
  );
  await pool.query(
    `insert into entitlement_snapshot_capabilities (
       tenant_id, profile_id, snapshot_id, capability_id, capability_version_id, version, capability_order, created_at
     ) values (
       'tenant_immutable', 'profile_tenant_immutable', 'snapshot_immutable',
       'capability_read', 'capability_version_read', '1.0.0', 1, $1
     )`,
    [now],
  );

  const mutations: readonly [string, string][] = [
    ["update capability_versions set artifact_ref = 'manifest:sha256:" + "c".repeat(64) + "' where capability_version_id = 'capability_version_read'", "capability_versions_reviewed_immutable_check"],
    ["delete from capability_versions where capability_version_id = 'capability_version_read'", "capability_versions_reviewed_immutable_check"],
    ["update pack_versions set version = '1.0.1' where pack_version_id = 'pack_version_read'", "pack_versions_published_immutable_check"],
    ["delete from pack_members where pack_member_id = 'pack_member_read'", "pack_members_published_immutable_check"],
    ["update tenant_pack_releases set generation = 2 where tenant_pack_release_id = 'release_read'", "tenant_pack_releases_history_immutable_check"],
    ["delete from tenant_pack_releases where tenant_pack_release_id = 'release_read'", "tenant_pack_releases_history_immutable_check"],
    ["update entitlement_snapshots set canonical_input_hash = 'sha256:" + "d".repeat(64) + "' where snapshot_id = 'snapshot_immutable'", "entitlement_snapshots_immutable_check"],
    ["delete from entitlement_snapshot_sources where snapshot_id = 'snapshot_immutable'", "entitlement_snapshot_sources_immutable_check"],
    ["delete from entitlement_snapshot_capabilities where snapshot_id = 'snapshot_immutable'", "entitlement_snapshot_capabilities_immutable_check"],
  ];
  for (const [statement, expectedConstraint] of mutations) {
    await assert.rejects(pool.query(statement), (error) => constraintName(error) === expectedConstraint, expectedConstraint);
  }
});

test("tenant scoped foreign keys, order identity, assignment mode, and database-time validity fail closed", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_authority", { seats: 2 });
  await seedIdentityGraph("tenant_other");

  await assert.rejects(
    pool.query(
      `insert into capability_versions (
         capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
         risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
       ) values (
         'capability_version_wrong_kind', 'capability_read', '2.0.0', 'skill',
         'registry.example/capability-read@sha256:wrong-kind', 'contracts://capability-read/2.0.0',
         'read', 'none', '{}'::jsonb, 'reviewed', 1, clock_timestamp(), clock_timestamp()
       )`,
    ),
    (error) => constraintName(error) === "capability_versions_kind_matches_capability_check",
  );

  const stored = await pool.query<{ created_at: Date; valid_from: Date }>(
    "select created_at, valid_from from entitlements where entitlement_id = 'entitlement_read'",
  );
  assert.ok(Math.abs(stored.rows[0]!.valid_from.getTime() - stored.rows[0]!.created_at.getTime()) < 1000);

  await assert.rejects(
    pool.query(
      `insert into entitlement_assignments (
         assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
       ) values ('assignment_cross_tenant', 'tenant_other', 'entitlement_read', 'profile_tenant_other', 'preparing', 'seat_assigned', 1)`,
    ),
    (error) => constraintName(error) === "entitlement_assignments_active_authority_check",
  );
  await assert.rejects(
    pool.query(
      `insert into entitlements (
         entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id, pack_version,
         source, external_order_ref, tenant_mode, assignment_mode, seat_quantity, expires_at,
         status, reason_code, resource_version
       ) values (
         'entitlement_duplicate_order', 'tenant_authority', 'pack_product_read', 'release_read',
         'pack_version_read', '1.0.0', 'platform_manual', 'order_read', 'b2b', 'seat', 1,
         clock_timestamp() + interval '1 day', 'active', 'platform_grant', 1
       )`,
    ),
    (error) => constraintName(error) === "entitlements_order_key",
  );
  await assert.rejects(
    pool.query(
      `insert into entitlements (
         entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id, pack_version,
         source, external_order_ref, tenant_mode, assignment_mode, seat_quantity, valid_from, expires_at,
         status, reason_code, resource_version
       ) values (
         'entitlement_invalid_window', 'tenant_authority', 'pack_product_read', 'release_read',
         'pack_version_read', '1.0.0', 'platform_manual', 'order_invalid_window', 'b2b', 'seat', 1,
         clock_timestamp(), clock_timestamp() - interval '1 second', 'active', 'platform_grant', 1
       )`,
    ),
    (error) => constraintName(error) === "entitlements_validity_check",
  );
  await assert.rejects(
    pool.query(
      `insert into entitlements (
         entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id, pack_version,
         source, external_order_ref, tenant_mode, assignment_mode, seat_quantity, expires_at,
         status, reason_code, resource_version
       ) values (
         'entitlement_invalid_mode', 'tenant_authority', 'pack_product_read', 'release_read',
         'pack_version_read', '1.0.0', 'platform_manual', 'order_invalid_mode', 'b2c', 'automatic', 1,
         clock_timestamp() + interval '1 day', 'active', 'platform_grant', 1
       )`,
    ),
    (error) => constraintName(error) === "entitlements_assignment_mode_check",
  );
});

test("direct SQL assignment concurrency cannot oversubscribe a one-seat Entitlement", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_seat", { seats: 1 });
  const now = new Date("2026-08-21T00:00:00.000Z");
  await pool.query(
    `insert into profiles (
       tenant_id, profile_id, schema_version, resource_version, owner_actor_id, profile_kind,
       hermes_profile_ref, description, status, provider_config_id, model_id, created_at, updated_at
     ) values
       ('tenant_seat', 'profile_seat_a', 1, 1, 'actor_tenant_seat', 'consultant', 'profile_seat_a', 'A', 'active', 'provider', 'model', $1, $1),
       ('tenant_seat', 'profile_seat_b', 1, 1, 'actor_tenant_seat', 'consultant', 'profile_seat_b', 'B', 'active', 'provider', 'model', $1, $1)`,
    [now],
  );

  const insertAssignment = (suffix: "a" | "b") => withTransaction(async (client) => {
    await client.query(
      `insert into entitlement_assignments (
         assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
       ) values ($1, 'tenant_seat', 'entitlement_read', $2, 'preparing', 'seat_assigned', 1)`,
      [`assignment_seat_${suffix}`, `profile_seat_${suffix}`],
    );
    return suffix;
  });
  const results = await Promise.allSettled([insertAssignment("a"), insertAssignment("b")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(constraintName(rejected?.reason), "entitlement_assignments_seat_capacity_check");
  assert.equal(
    Number((await pool.query("select count(*)::int as count from entitlement_assignments where status in ('preparing', 'available')")).rows[0]?.count),
    1,
  );
});

test("current Snapshot pointer advances only through expected-version CAS", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_pointer");
  for (const [id, version, digest] of [["snapshot_pointer_1", 1, "e"], ["snapshot_pointer_2", 2, "f"]] as const) {
    await pool.query(
      `insert into entitlement_snapshots (
         snapshot_id, tenant_id, profile_id, snapshot_version, canonical_input_hash, resource_version
       ) values ($1, 'tenant_pointer', 'profile_tenant_pointer', $2, $3, 1)`,
      [id, version, `sha256:${digest.repeat(64)}`],
    );
  }

  const inserted = await pool.query<{ resource_version: string }>(
    "select resource_version::text from advance_profile_snapshot_pointer($1, $2, $3, $4)",
    ["tenant_pointer", "profile_tenant_pointer", 0, "snapshot_pointer_1"],
  );
  assert.equal(inserted.rows[0]?.resource_version, "1");
  await assert.rejects(
    pool.query("update profile_snapshot_pointers set snapshot_id = 'snapshot_pointer_2' where tenant_id = 'tenant_pointer'"),
    (error) => constraintName(error) === "profile_snapshot_pointers_cas_check",
  );
  await assert.rejects(
    pool.query("select * from advance_profile_snapshot_pointer($1, $2, $3, $4)", ["tenant_pointer", "profile_tenant_pointer", 0, "snapshot_pointer_2"]),
    (error) => constraintName(error) === "profile_snapshot_pointers_expected_version_check",
  );
  const advanced = await pool.query<{ resource_version: string }>(
    "select resource_version::text from advance_profile_snapshot_pointer($1, $2, $3, $4)",
    ["tenant_pointer", "profile_tenant_pointer", 1, "snapshot_pointer_2"],
  );
  assert.equal(advanced.rows[0]?.resource_version, "2");
});

test("Worker kinds and Runtime manifest digest are exact", async () => {
  await applyMigrations(pool, migrationsDirectory);
  assert.deepEqual(workerJobKinds, [
    "provision_runtime",
    "reconcile_runtime",
    "execute_agent_run",
    "dispatch_outbox",
    "project_platform_memberships",
    "finalize_account_deletion",
    "reconcile_capability_projection",
    "stop_idle_b2c_runtime",
  ]);
  await seedIdentityGraph("tenant_worker", "b2c");
  const now = new Date("2026-08-21T00:00:00.000Z");
  await pool.query(
    `insert into runtime_containers (
       tenant_id, container_id, schema_version, resource_version, runtime_kind, desired_state,
       observed_state, image_ref, generation, volume_ref, health_status, capability_manifest_digest,
       created_at, updated_at
     ) values (
       'tenant_worker', 'container_worker', 1, 1, 'hermes', 'running', 'ready',
       $1, 1, 'volume_worker', 'healthy', $2, $3, $3
     )`,
    [`registry.example/runtime@sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, now],
  );
  await assert.rejects(
    pool.query("update runtime_containers set capability_manifest_digest = 'SHA256:invalid' where tenant_id = 'tenant_worker'"),
    (error) => constraintName(error) === "runtime_containers_capability_manifest_digest_check",
  );
  for (const [index, kind] of ["reconcile_capability_projection", "stop_idle_b2c_runtime"].entries()) {
    await pool.query(
      `insert into worker_jobs (
         tenant_id, job_id, job_kind, status, attempt_count, max_attempts, next_attempt_at,
         payload_ref, effect_state, created_at, updated_at
       ) values ('tenant_worker', $1, $2, 'queued', 0, 3, $3, $4, 'pre_effect', $3, $3)`,
      [`job_entitlement_${index}`, kind, now, `entitlement:${index}`],
    );
  }
});

test("required authority claim paths use their dedicated indexes", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_explain", { seats: 2 });
  await pool.query("set enable_seqscan = off");
  const plans: readonly [string, string][] = [
    ["explain (costs off) select entitlement_id from entitlements where tenant_id = 'tenant_explain' and status = 'active' and valid_from <= clock_timestamp() and (expires_at is null or expires_at > clock_timestamp())", "entitlements_active_authority_idx"],
    ["explain (costs off) select assignment_id from entitlement_assignments where tenant_id = 'tenant_explain' and profile_id = 'profile_tenant_explain' and status in ('preparing','available')", "entitlement_assignments_active_profile_idx"],
    ["explain (costs off) select snapshot_id from profile_snapshot_pointers where tenant_id = 'tenant_explain' and profile_id = 'profile_tenant_explain'", "profile_snapshot_pointers_snapshot_fk_idx"],
    ["explain (costs off) select tenant_id from tenant_pack_releases where pack_version_id = 'pack_version_read' and status = 'current'", "tenant_pack_releases_affected_idx"],
    ["explain (costs off) select entitlement_id from entitlements where status = 'active' and expires_at <= clock_timestamp() order by expires_at limit 10", "entitlements_due_expiry_idx"],
    ["explain (costs off) select tenant_id from runtime_activity where active_conversation_count = 0 and active_run_count = 0 and last_work_at <= clock_timestamp() - interval '30 minutes' order by last_work_at limit 10", "runtime_activity_due_idle_stop_idx"],
    ["explain (costs off) select projection_id from capability_runtime_projections where status in ('preparing','failed') order by updated_at limit 10", "capability_runtime_projections_claim_idx"],
    ["explain (costs off) select job_id from worker_jobs where job_kind = 'reconcile_capability_projection' and status in ('queued','retrying') and next_attempt_at <= clock_timestamp() order by created_at limit 10", "worker_jobs_capability_projection_claim_idx"],
  ];
  for (const [query, expectedIndex] of plans) {
    const plan = (await pool.query<{ "QUERY PLAN": string }>(query)).rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(plan, new RegExp(expectedIndex), `${expectedIndex}\n${plan}`);
  }
});
