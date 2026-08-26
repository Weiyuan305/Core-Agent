import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

interface SnapshotHashInput {
  sourceEntitlementIds?: readonly string[];
  sourceAssignmentIds?: readonly string[];
  sourceReleaseIds?: readonly string[];
  capabilities?: readonly {
    capability_id: string;
    capability_version_id: string;
    version: string;
  }[];
}

function canonicalSnapshotHash(input: SnapshotHashInput): string {
  const canonical = JSON.stringify({
    capabilities: [...(input.capabilities ?? [])],
    source_assignment_ids: [...(input.sourceAssignmentIds ?? [])],
    source_entitlement_ids: [...(input.sourceEntitlementIds ?? [])],
    source_release_ids: [...(input.sourceReleaseIds ?? [])],
  });
  return `sha256:${createHash("sha256")
    .update(`core-agent-entitlement-snapshot-v1\0${canonical}`, "utf8")
    .digest("hex")}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function waitForDatabaseLock(applicationName: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await pool.query<{ wait_event_type: string | null }>(
      `select wait_event_type from pg_stat_activity
       where application_name = $1 and state = 'active'`,
      [applicationName],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return true;
    if (activity.rowCount === 0) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${applicationName} database lock`);
}

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
  await pool.query("update pack_versions set status = 'reviewed', resource_version = 2, updated_at = $1 where pack_version_id = 'pack_version_read'", [now]);
  await pool.query("update pack_versions set status = 'published', resource_version = 3, updated_at = $1 where pack_version_id = 'pack_version_read'", [now]);
  await pool.query(
    `insert into tenant_pack_releases (
       tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
       generation, status, resource_version, created_at, updated_at
     ) values ('release_read', $1, 'pack_product_read', 'pack_version_read', '1.0.0', 1, 'preparing', 1, $2, $2)`,
    [tenantId, now],
  );
  await pool.query(
    "update tenant_pack_releases set status = 'current', resource_version = 2, updated_at = $2 where tenant_id = $1 and tenant_pack_release_id = 'release_read'",
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

async function insertSnapshotAggregate(
  client: PoolClient,
  input: {
    snapshotId: string;
    tenantId: string;
    profileId: string;
    snapshotVersion?: number;
    sourceEntitlementIds?: readonly string[];
    sourceAssignmentIds?: readonly string[];
    sourceReleaseIds?: readonly string[];
    capabilities?: readonly {
      capability_id: string;
      capability_version_id: string;
      version: string;
    }[];
    canonicalInputHash?: string;
    evaluatedAt?: Date;
  },
): Promise<void> {
  const sources = [
    ["entitlement", input.sourceEntitlementIds ?? []],
    ["assignment", input.sourceAssignmentIds ?? []],
    ["release", input.sourceReleaseIds ?? []],
  ] as const;
  const capabilities = input.capabilities ?? [];
  const canonicalInputHash = input.canonicalInputHash ?? canonicalSnapshotHash({
    sourceEntitlementIds: input.sourceEntitlementIds,
    sourceAssignmentIds: input.sourceAssignmentIds,
    sourceReleaseIds: input.sourceReleaseIds,
    capabilities,
  });
  await client.query(
    `insert into entitlement_snapshots (
       snapshot_id, tenant_id, profile_id, snapshot_version, evaluated_at,
       canonical_input_hash, resource_version
     ) values ($1, $2, $3, $4, $5, $6, 1)`,
    [
      input.snapshotId,
      input.tenantId,
      input.profileId,
      input.snapshotVersion ?? 1,
      input.evaluatedAt ?? new Date("2000-01-01T00:00:00.000Z"),
      canonicalInputHash,
    ],
  );
  for (const [sourceKind, sourceIds] of sources) {
    for (const [index, sourceId] of sourceIds.entries()) {
      await client.query(
        `insert into entitlement_snapshot_sources (
           tenant_id, profile_id, snapshot_id, source_kind, source_id, source_order
         ) values ($1, $2, $3, $4, $5, $6)`,
        [input.tenantId, input.profileId, input.snapshotId, sourceKind, sourceId, index + 1],
      );
    }
  }
  for (const [index, capability] of capabilities.entries()) {
    await client.query(
      `insert into entitlement_snapshot_capabilities (
         tenant_id, profile_id, snapshot_id, capability_id, capability_version_id,
         version, capability_order
       ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.tenantId,
        input.profileId,
        input.snapshotId,
        capability.capability_id,
        capability.capability_version_id,
        capability.version,
        index + 1,
      ],
    );
  }
}

async function seedAvailableAssignment(tenantId: string, assignmentId = "assignment_read"): Promise<void> {
  await pool.query(
    `insert into entitlement_assignments (
       assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
     ) values ($1, $2, 'entitlement_read', $3, 'available', 'seat_assigned', 1)`,
    [assignmentId, tenantId, `profile_${tenantId}`],
  );
}

async function seedAdditionalAssignedEntitlement(tenantId: string, suffix: string): Promise<void> {
  await pool.query(
    `insert into entitlements (
       entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
       pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
       expires_at, status, reason_code, resource_version
     ) values (
       $1, $2, 'pack_product_read', 'release_read', 'pack_version_read', '1.0.0',
       'platform_manual', $3, 'b2b', 'seat', 1, clock_timestamp() + interval '30 days',
       'active', 'platform_grant', 1
     )`,
    [`entitlement_read_${suffix}`, tenantId, `order_read_${suffix}`],
  );
  await pool.query(
    `insert into entitlement_assignments (
       assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
     ) values ($1, $2, $3, $4, 'available', 'seat_assigned', 1)`,
    [`assignment_read_${suffix}`, tenantId, `entitlement_read_${suffix}`, `profile_${tenantId}`],
  );
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

test("schema 16 migrates both empty and schema-12 databases without changing identity history", async () => {
  assert.equal(EXPECTED_SCHEMA_VERSION, 16);
  await applyMigrations(pool, migrationsDirectory);
  assert.deepEqual(
    (await pool.query("select version, name from core_agent_schema_migrations order by version")).rows.at(-1),
    { version: 16, name: "policy_mcp_gateway" },
  );

  await resetDatabase();
  const prefixDirectory = await applyPrefix(12);
  try {
    const historyBefore = await pool.query("select version, name, checksum, applied_at from core_agent_schema_migrations order by version");
    await applyMigrations(pool, migrationsDirectory);
    const historyAfter = await pool.query("select version, name, checksum, applied_at from core_agent_schema_migrations order by version");
    assert.deepEqual(historyAfter.rows.slice(0, 12), historyBefore.rows);
    assert.equal(historyAfter.rows[12]?.version, 13);
    assert.equal(historyAfter.rows[13]?.version, 14);
    assert.equal(historyAfter.rows[14]?.version, 15);
    assert.equal(historyAfter.rows[15]?.version, 16);
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
  assert.equal((await pool.query<{ allowed: boolean }>("select has_schema_privilege('core_agent_app', 'public', 'usage') as allowed")).rows[0]?.allowed, true);
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
  assert.equal(privileges.rows.some((row) => row.grantee === "core_agent_app" && row.table_name === "tenant_pack_releases" && row.privilege_type === "UPDATE"), true);
  assert.equal(privileges.rows.some((row) => row.grantee === "core_agent_app" && row.table_name === "entitlements" && row.privilege_type !== "SELECT"), false);

  const functionPrivileges = await pool.query<{ grantee: string; privilege_type: string }>(
    `select grantee, privilege_type from information_schema.routine_privileges
     where specific_schema = 'public' and routine_name = 'advance_profile_snapshot_pointer'
       and grantee in ('PUBLIC', 'core_agent_app', 'core_agent_identity')
     order by grantee`,
  );
  assert.deepEqual(functionPrivileges.rows, [
    { grantee: "core_agent_app", privilege_type: "EXECUTE" },
    { grantee: "core_agent_identity", privilege_type: "EXECUTE" },
  ]);
});

test("catalog, release, and snapshot history is fail-closed immutable", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_immutable");
  await seedAvailableAssignment("tenant_immutable");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_immutable",
    tenantId: "tenant_immutable",
    profileId: "profile_tenant_immutable",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));

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

test("catalog admission enforces Contracts 0.7 exact refs and publishable canonical members", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_catalog_admission");
  const invalidVersions = ["1.0", "01.0.0", "1.0.0-01", "1.0.0+build", "latest", "^1.0.0"];
  for (const [index, version] of invalidVersions.entries()) {
    await assert.rejects(
      pool.query(
        `insert into capability_versions (
           capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
           risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
         ) values ($1, 'capability_read', $2, 'mcp', $3, 'synthetic/read@1.0.0', 'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'draft', 1, now(), now())`,
        [`invalid_version_${index}`, version, `manifest:sha256:${"c".repeat(64)}`],
      ),
      (error) => constraintName(error) === "capability_versions_canonical_version_check",
    );
  }
  for (const [index, artifactRef] of [
    "oci:registry.example/synthetic/read:latest",
    "npm:@synthetic/read@^1.0.0#sha512-not-exact",
    `npm:mutable#sha512-${Buffer.alloc(64, 0x61).toString("base64")}`,
    "https://registry.example/synthetic/read.tgz",
    "manifest:sha256:ABCDEF",
  ].entries()) {
    await assert.rejects(
      pool.query(
        `insert into capability_versions (
           capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
           risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
         ) values ($1, 'capability_read', $2, 'mcp', $3, 'synthetic/read@1.0.0', 'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'draft', 1, now(), now())`,
        [`invalid_artifact_${index}`, `2.0.${index}`, artifactRef],
      ),
      (error) => constraintName(error) === "capability_versions_immutable_artifact_ref_check",
    );
  }
  for (const [index, contractRef] of [
    "synthetic/read@latest",
    "synthetic/read@^1.0.0",
    "synthetic/read@mutable@1.0.0",
    "synthetic/read@\nmutable@1.0.0",
    "HTTPS://contracts.example/read@1.0.0",
  ].entries()) {
    await assert.rejects(
      pool.query(
        `insert into capability_versions (
           capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
           risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
         ) values ($1, 'capability_read', $2, 'mcp', $3, $4, 'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'draft', 1, now(), now())`,
        [`invalid_contract_${index}`, `3.0.${index}`, `manifest:sha256:${"d".repeat(64)}`, contractRef],
      ),
      (error) => constraintName(error) === "capability_versions_exact_contract_ref_check",
    );
  }
  await assert.rejects(
    pool.query(
      `insert into capability_versions (
         capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
         risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
       ) values (
         'invalid_compatibility_semver', 'capability_read', '3.1.0', 'mcp', $1,
         'synthetic/read@3.1.0', 'read', 'none', $2::jsonb, 'draft', 1, now(), now()
       )`,
      [
        `manifest:sha256:${"d".repeat(64)}`,
        JSON.stringify({
          core_contract_version: `1.0.0-${"a".repeat(123)}`,
          domain_contract_version: "1.0.0",
          runtime_protocol_version: "1.0.0",
          tenant_modes: ["b2b", "b2c"],
        }),
      ],
    ),
    (error) => constraintName(error) === "capability_versions_compatibility_object_check",
  );

  await pool.query(
    `insert into pack_versions (pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at)
     values ('pack_empty', 'pack_product_read', '2.0.0', 'draft', 1, now(), now())`,
  );
  await pool.query("update pack_versions set status = 'reviewed' where pack_version_id = 'pack_empty'");
  await assert.rejects(
    pool.query("update pack_versions set status = 'published' where pack_version_id = 'pack_empty'"),
    (error) => constraintName(error) === "pack_versions_publishable_members_check",
  );
  const packValidator = await pool.query<{ definition: string }>(
    "select pg_get_functiondef('enforce_pack_version_immutability()'::regprocedure) as definition",
  );
  assert.match(
    packValidator.rows[0]!.definition,
    /order by member\.capability_id collate "C",\s*member\.capability_version_id collate "C",\s*member\.version collate "C"/iu,
  );

  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values
       ('capability_version_draft', 'capability_read', '4.0.0', 'mcp', $1, 'synthetic/read@4.0.0', 'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'draft', 1, now(), now()),
       ('capability_version_risky', 'capability_read', '5.0.0', 'mcp', $2, 'synthetic/read@5.0.0', 'external_write', 'human_approval', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'reviewed', 1, now(), now()),
       ('capability_version_blocked', 'capability_read', '5.1.0', 'mcp', $3, 'synthetic/read@5.1.0', 'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'blocked', 1, now(), now())`,
    [
      `manifest:sha256:${"e".repeat(64)}`,
      `manifest:sha256:${"f".repeat(64)}`,
      `manifest:sha256:${"a".repeat(64)}`,
    ],
  );
  for (const [packId, packVersion, memberId, capabilityVersionId] of [
    ["pack_unsorted", "3.0.0", "member_unsorted", "capability_version_read"],
    ["pack_draft_member", "4.0.0", "member_draft", "capability_version_draft"],
    ["pack_risky_member", "5.0.0", "member_risky", "capability_version_risky"],
    ["pack_blocked_member", "5.1.0", "member_blocked", "capability_version_blocked"],
  ] as const) {
    await pool.query(
      `insert into pack_versions (pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at)
       values ($1, 'pack_product_read', $2, 'draft', 1, now(), now())`,
      [packId, packVersion],
    );
    await pool.query(
      `insert into pack_members (
         pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
         resource_version, created_at, updated_at
       ) select $1, $2, $3, capability_id, capability_version_id, version, 1, now(), now()
         from capability_versions where capability_version_id = $4`,
      [memberId, packId, packId === "pack_unsorted" ? 2 : 1, capabilityVersionId],
    );
    await pool.query("update pack_versions set status = 'reviewed' where pack_version_id = $1", [packId]);
    await assert.rejects(
      pool.query("update pack_versions set status = 'published' where pack_version_id = $1", [packId]),
      (error) => constraintName(error) === "pack_versions_publishable_members_check",
    );
  }

  await pool.query(
    `insert into pack_versions (pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at)
     values ('pack_not_published', 'pack_product_read', '6.0.0', 'draft', 1, now(), now())`,
  );
  await pool.query("update pack_versions set status = 'reviewed' where pack_version_id = 'pack_not_published'");
  await assert.rejects(
    pool.query(
      `insert into tenant_pack_releases (
         tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
         generation, status, resource_version
       ) values ('release_not_published', 'tenant_catalog_admission', 'pack_product_read', 'pack_not_published', '6.0.0', 2, 'preparing', 1)`,
    ),
    (error) => constraintName(error) === "tenant_pack_releases_published_pack_check",
  );
});

test("review round 3 catalog validators fail closed on NULL, missing fields, and non-draft Pack insertion", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_catalog_hostile");
  const validators = await pool.query<{
    artifact_null: boolean;
    compatibility_null: boolean;
    contract_null: boolean;
    semver_null: boolean;
  }>(`select
    core_agent_is_canonical_semver(null) is false as semver_null,
    core_agent_is_exact_contract_ref(null) is false as contract_null,
    core_agent_is_immutable_artifact_ref(null) is false as artifact_null,
    core_agent_is_valid_capability_compatibility(null) is false as compatibility_null`);
  assert.deepEqual(validators.rows[0], {
    artifact_null: true,
    compatibility_null: true,
    contract_null: true,
    semver_null: true,
  });
  await assert.rejects(
    pool.query(
      `insert into capability_versions (
         capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
         risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
       ) values (
         'capability_missing_compatibility', 'capability_read', '8.0.0', 'mcp', $1,
         'foobar@', 'read', 'none', '{}'::jsonb, 'draft', 1, now(), now()
       )`,
      [`manifest:sha256:${"b".repeat(64)}`],
    ),
    (error) => [
      "capability_versions_exact_contract_ref_check",
      "capability_versions_compatibility_object_check",
    ].includes(constraintName(error) ?? ""),
  );
  await assert.rejects(
    pool.query(
      `insert into pack_versions (
         pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
       ) values ('pack_insert_reviewed', 'pack_product_read', '8.0.0', 'reviewed', 1, now(), now())`,
    ),
    (error) => constraintName(error) === "pack_versions_initial_status_check",
  );
});

test("review round 3 Pack publication validates NEW product semantics and freezes published Product modes", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_pack_product_semantics");
  await assert.rejects(
    pool.query(
      "update pack_products set tenant_modes = array['b2b']::text[] where pack_product_id = 'pack_product_read'",
    ),
    (error) => constraintName(error) === "pack_products_published_semantics_immutable_check",
  );

  await pool.query(
    `insert into pack_products (
       pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at
     ) values
       ('pack_product_b2b_only', 'B2B only', array['b2b'], 1, now(), now()),
       ('pack_product_b2c_only', 'B2C only', array['b2c'], 1, now(), now())`,
  );
  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_b2b_only', 'capability_read', '8.1.0', 'mcp', $1,
       'synthetic/read@8.1.0', 'read', 'none',
       '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b"]}'::jsonb,
       'reviewed', 1, now(), now()
     )`,
    [`manifest:sha256:${"c".repeat(64)}`],
  );
  await pool.query(
    `insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_new_product_bypass', 'pack_product_b2b_only', '8.1.0', 'draft', 1, now(), now())`,
  );
  await pool.query(
    `insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id,
       version, resource_version, created_at, updated_at
     ) values (
       'member_new_product_bypass', 'pack_new_product_bypass', 1, 'capability_read',
       'capability_version_b2b_only', '8.1.0', 1, now(), now()
     )`,
  );
  await pool.query("update pack_versions set status = 'reviewed' where pack_version_id = 'pack_new_product_bypass'");
  await assert.rejects(
    pool.query(
      `update pack_versions
       set pack_product_id = 'pack_product_b2c_only', status = 'published'
       where pack_version_id = 'pack_new_product_bypass'`,
    ),
    (error) => constraintName(error) === "pack_versions_publishable_members_check",
  );
});

test("review round 3 Entitlements bind canonical Tenant mode and Pack Product mode", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_mode_binding");
  await assert.rejects(
    pool.query(
      `insert into entitlements (
         entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
         pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
         expires_at, status, reason_code, resource_version
       ) values (
         'entitlement_wrong_tenant_mode', 'tenant_mode_binding', 'pack_product_read', 'release_read',
         'pack_version_read', '1.0.0', 'platform_manual', 'order_wrong_mode', 'b2c', 'automatic', null,
         clock_timestamp() + interval '30 days', 'active', 'platform_grant', 1
       )`,
    ),
    (error) => constraintName(error) === "entitlements_tenant_mode_fkey",
  );

  await seedIdentityGraph("tenant_product_mode_binding", "b2c");
  await pool.query(
    `insert into pack_products (
       pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at
     ) values ('pack_product_b2b_release', 'B2B release', array['b2b'], 1, now(), now())`,
  );
  await pool.query(
    `insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_version_b2b_release', 'pack_product_b2b_release', '9.0.0', 'draft', 1, now(), now())`,
  );
  await pool.query(
    `insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
       resource_version, created_at, updated_at
     ) values (
       'pack_member_b2b_release', 'pack_version_b2b_release', 1, 'capability_read',
       'capability_version_read', '1.0.0', 1, now(), now()
     )`,
  );
  await pool.query("update pack_versions set status = 'reviewed' where pack_version_id = 'pack_version_b2b_release'");
  await pool.query("update pack_versions set status = 'published' where pack_version_id = 'pack_version_b2b_release'");
  await pool.query(
    `insert into tenant_pack_releases (
       tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
       generation, status, resource_version
     ) values (
       'release_b2b_for_b2c', 'tenant_product_mode_binding', 'pack_product_b2b_release',
       'pack_version_b2b_release', '9.0.0', 1, 'preparing', 1
     )`,
  );
  await pool.query("update tenant_pack_releases set status = 'current' where tenant_pack_release_id = 'release_b2b_for_b2c'");
  await assert.rejects(
    pool.query(
      `insert into entitlements (
         entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
         pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
         expires_at, status, reason_code, resource_version
       ) values (
         'entitlement_unsupported_product_mode', 'tenant_product_mode_binding', 'pack_product_b2b_release',
         'release_b2b_for_b2c', 'pack_version_b2b_release', '9.0.0', 'platform_manual',
         'order_unsupported_product_mode', 'b2c', 'automatic', null,
         clock_timestamp() + interval '30 days', 'active', 'platform_grant', 1
       )`,
    ),
    (error) => constraintName(error) === "entitlements_pack_product_mode_check",
  );
});

test("review round 3 Tenant Pack Release insertion starts only in preparing", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_release_insert_state");
  await pool.query(
    "update tenant_pack_releases set status = 'superseded' where tenant_pack_release_id = 'release_read'",
  );
  await assert.rejects(
    pool.query(
      `insert into tenant_pack_releases (
         tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
         generation, status, resource_version
       ) values (
         'release_direct_current', 'tenant_release_insert_state', 'pack_product_read',
         'pack_version_read', '1.0.0', 2, 'current', 1
       )`,
    ),
    (error) => constraintName(error) === "tenant_pack_releases_initial_status_check",
  );
});

test("Capability and Pack status transitions cannot downgrade then mutate frozen content", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_status_transition");
  await assert.rejects(
    withTransaction(async (client) => {
      await client.query("update capability_versions set status = 'draft' where capability_version_id = 'capability_version_read'");
      await client.query("update capability_versions set artifact_ref = $1 where capability_version_id = 'capability_version_read'", [`manifest:sha256:${"7".repeat(64)}`]);
    }),
    (error) => constraintName(error) === "capability_versions_status_transition_check",
  );
  await assert.rejects(
    withTransaction(async (client) => {
      await client.query("update pack_versions set status = 'reviewed' where pack_version_id = 'pack_version_read'");
      await client.query("delete from pack_members where pack_member_id = 'pack_member_read'");
    }),
    (error) => constraintName(error) === "pack_versions_status_transition_check",
  );
});

test("Snapshot children are same-transaction sealed and validate typed same-Tenant release authority", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_authority");
  await seedAvailableAssignment("tenant_snapshot_authority");
  await seedIdentityGraph("tenant_snapshot_other");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_valid",
    tenantId: "tenant_snapshot_authority",
    profileId: "profile_tenant_snapshot_authority",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));
  await assert.rejects(
    pool.query(
      `insert into entitlement_snapshot_sources (
         tenant_id, profile_id, snapshot_id, source_kind, source_id, source_order
       ) values ('tenant_snapshot_authority', 'profile_tenant_snapshot_authority', 'snapshot_valid', 'entitlement', 'entitlement_read', 1)`,
    ),
    (error) => constraintName(error) === "entitlement_snapshot_children_creation_transaction_check",
  );
  await assert.rejects(
    withTransaction(async (client) => {
      await client.query(
        `insert into entitlement_snapshots (
           snapshot_id, tenant_id, profile_id, snapshot_version, canonical_input_hash, resource_version
         ) values ('snapshot_cross_tenant', 'tenant_snapshot_other', 'profile_tenant_snapshot_other', 1, $1, 1)`,
        [canonicalSnapshotHash({ sourceReleaseIds: ["release_read"] })],
      );
      await client.query(
        `insert into entitlement_snapshot_sources (
           tenant_id, profile_id, snapshot_id, source_kind, source_id, source_order
         ) values ('tenant_snapshot_other', 'profile_tenant_snapshot_other', 'snapshot_cross_tenant', 'release', 'release_read', 1)`,
      );
    }),
    (error) => constraintName(error) === "entitlement_snapshots_source_authority_check",
  );
});

test("Snapshot capabilities must be reviewed first-release-safe Pack members reachable from a source release", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_capability");
  await seedAvailableAssignment("tenant_snapshot_capability");
  await pool.query(
    `insert into capabilities (capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at)
     values ('capability_unreachable', 'Unreachable', 'synthetic', 'skill', 1, now(), now())`,
  );
  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_unreachable', 'capability_unreachable', '1.0.0', 'skill', $1,
       'synthetic/unreachable@1.0.0', 'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'reviewed', 1, now(), now()
     )`,
    [`manifest:sha256:${"8".repeat(64)}`],
  );
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_unreachable",
      tenantId: "tenant_snapshot_capability",
      profileId: "profile_tenant_snapshot_capability",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_unreachable",
        capability_version_id: "capability_version_unreachable",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_capability_completeness_check",
  );
});

test("review round 3 Snapshot creation uses DB truth, exact canonical hash, and one top-level xid across savepoints", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_creation_truth");
  await seedAvailableAssignment("tenant_snapshot_creation_truth");
  const capability = {
    capability_id: "capability_read",
    capability_version_id: "capability_version_read",
    version: "1.0.0",
  } as const;
  const canonicalInputHash = canonicalSnapshotHash({
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [capability],
  });
  const callerTimestamp = new Date("2000-01-01T00:00:00.000Z");
  const databaseBefore = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
  await withTransaction(async (client) => {
    await client.query(
      `insert into entitlement_snapshots (
         snapshot_id, tenant_id, profile_id, snapshot_version, evaluated_at,
         canonical_input_hash, resource_version
       ) values (
         'snapshot_creation_truth', 'tenant_snapshot_creation_truth',
         'profile_tenant_snapshot_creation_truth', 1, $1, $2, 1
       )`,
      [callerTimestamp, canonicalInputHash],
    );
    await client.query("savepoint snapshot_children");
    await client.query(
      `insert into entitlement_snapshot_sources (
         tenant_id, profile_id, snapshot_id, source_kind, source_id, source_order
       ) values
         ('tenant_snapshot_creation_truth', 'profile_tenant_snapshot_creation_truth', 'snapshot_creation_truth', 'entitlement', 'entitlement_read', 1),
         ('tenant_snapshot_creation_truth', 'profile_tenant_snapshot_creation_truth', 'snapshot_creation_truth', 'assignment', 'assignment_read', 1),
         ('tenant_snapshot_creation_truth', 'profile_tenant_snapshot_creation_truth', 'snapshot_creation_truth', 'release', 'release_read', 1)`,
    );
    await client.query(
      `insert into entitlement_snapshot_capabilities (
         tenant_id, profile_id, snapshot_id, capability_id, capability_version_id, version, capability_order
       ) values (
         'tenant_snapshot_creation_truth', 'profile_tenant_snapshot_creation_truth', 'snapshot_creation_truth',
         'capability_read', 'capability_version_read', '1.0.0', 1
       )`,
    );
    await client.query("release savepoint snapshot_children");
  });
  const stored = await pool.query<{ canonical_input_hash: string; creation_xid: string; evaluated_at: Date }>(
    `select canonical_input_hash, creation_xid::text, evaluated_at
     from entitlement_snapshots where snapshot_id = 'snapshot_creation_truth'`,
  );
  const databaseAfter = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]!.now;
  assert.equal(stored.rows[0]?.canonical_input_hash, canonicalInputHash);
  assert.match(stored.rows[0]?.creation_xid ?? "", /^[1-9][0-9]*$/u);
  assert.ok(stored.rows[0]!.evaluated_at >= databaseBefore);
  assert.ok(stored.rows[0]!.evaluated_at <= databaseAfter);
  assert.notEqual(stored.rows[0]!.evaluated_at.toISOString(), callerTimestamp.toISOString());
  assert.deepEqual(
    (await pool.query<{ type: string }>(
      `select format_type(attribute.atttypid, attribute.atttypmod) as type
       from pg_attribute attribute
       where attribute.attrelid = 'entitlement_snapshots'::regclass
         and attribute.attname = 'creation_xid' and not attribute.attisdropped`,
    )).rows,
    [{ type: "xid8" }],
  );
  const validator = await pool.query<{ definition: string }>(
    "select pg_get_functiondef('validate_entitlement_snapshot_aggregate()'::regprocedure) as definition",
  );
  assert.match(validator.rows[0]!.definition, /order by source\.source_id collate "C"/iu);
  assert.match(
    validator.rows[0]!.definition,
    /order by capability\.capability_id collate "C",\s*capability\.capability_version_id collate "C",\s*capability\.version collate "C"/iu,
  );
});

test("review round 3 Snapshot canonical hash cannot be caller-forged", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_hash");
  await seedAvailableAssignment("tenant_snapshot_hash");
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_forged_hash",
      tenantId: "tenant_snapshot_hash",
      profileId: "profile_tenant_snapshot_hash",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_read",
        capability_version_id: "capability_version_read",
        version: "1.0.0",
      }],
      canonicalInputHash: `sha256:${"0".repeat(64)}`,
    })),
    (error) => constraintName(error) === "entitlement_snapshots_canonical_input_authority_check",
  );
});

test("review round 3 Snapshot authority rejects bare releases, expired rights, and unassigned B2B rights", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_bare_release");
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_bare_release",
      tenantId: "tenant_snapshot_bare_release",
      profileId: "profile_tenant_snapshot_bare_release",
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_read",
        capability_version_id: "capability_version_read",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_source_completeness_check",
  );

  await resetDatabase();
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_expired");
  await seedAvailableAssignment("tenant_snapshot_expired");
  await pool.query(
    `update entitlements
     set valid_from = clock_timestamp() - interval '2 days',
         expires_at = clock_timestamp() - interval '1 day'
     where entitlement_id = 'entitlement_read'`,
  );
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_expired",
      tenantId: "tenant_snapshot_expired",
      profileId: "profile_tenant_snapshot_expired",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_read",
        capability_version_id: "capability_version_read",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_source_completeness_check",
  );

  await resetDatabase();
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_unassigned");
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_unassigned",
      tenantId: "tenant_snapshot_unassigned",
      profileId: "profile_tenant_snapshot_unassigned",
      sourceEntitlementIds: ["entitlement_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_read",
        capability_version_id: "capability_version_read",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_source_completeness_check",
  );
});

test("review round 3 B2C automatic Snapshot is valid without Assignment", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_b2c", { tenantMode: "b2c" });
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_b2c",
    tenantId: "tenant_snapshot_b2c",
    profileId: "profile_tenant_snapshot_b2c",
    sourceEntitlementIds: ["entitlement_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));
});

test("review round 3 Snapshot Capability must come from a source Entitlement release", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_snapshot_entitlement_release");
  await seedAvailableAssignment("tenant_snapshot_entitlement_release");
  await pool.query(
    `insert into capabilities (
       capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at
     ) values ('capability_other_release', 'Other release', 'synthetic', 'mcp', 1, now(), now())`,
  );
  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_other_release', 'capability_other_release', '1.0.0', 'mcp', $1,
       'synthetic/other@1.0.0', 'read', 'none',
       '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b"]}'::jsonb,
       'reviewed', 1, now(), now()
     )`,
    [`manifest:sha256:${"d".repeat(64)}`],
  );
  await pool.query(
    `insert into pack_products (
       pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at
     ) values ('pack_product_other_release', 'Other release', array['b2b'], 1, now(), now())`,
  );
  await pool.query(
    `insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_version_other_release', 'pack_product_other_release', '1.0.0', 'draft', 1, now(), now())`,
  );
  await pool.query(
    `insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
       resource_version, created_at, updated_at
     ) values (
       'pack_member_other_release', 'pack_version_other_release', 1, 'capability_other_release',
       'capability_version_other_release', '1.0.0', 1, now(), now()
     )`,
  );
  await pool.query("update pack_versions set status = 'reviewed' where pack_version_id = 'pack_version_other_release'");
  await pool.query("update pack_versions set status = 'published' where pack_version_id = 'pack_version_other_release'");
  await pool.query(
    `insert into tenant_pack_releases (
       tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
       generation, status, resource_version
     ) values (
       'release_other', 'tenant_snapshot_entitlement_release', 'pack_product_other_release',
       'pack_version_other_release', '1.0.0', 1, 'preparing', 1
     )`,
  );
  await pool.query("update tenant_pack_releases set status = 'current' where tenant_pack_release_id = 'release_other'");
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_capability_other_release",
      tenantId: "tenant_snapshot_entitlement_release",
      profileId: "profile_tenant_snapshot_entitlement_release",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_other_release",
        capability_version_id: "capability_version_other_release",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_capability_completeness_check",
  );
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
         'manifest:sha256:${"9".repeat(64)}', 'synthetic/read@2.0.0',
         'read', 'none', '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb, 'reviewed', 1, clock_timestamp(), clock_timestamp()
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

test("Entitlement seat reductions serialize with preparing and available Assignment consumption", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_seat_reduction", { seats: 2 });
  const now = new Date("2026-08-21T00:00:00.000Z");
  await pool.query(
    `insert into profiles (
       tenant_id, profile_id, schema_version, resource_version, owner_actor_id, profile_kind,
       hermes_profile_ref, description, status, provider_config_id, model_id, created_at, updated_at
     ) values
       ('tenant_seat_reduction', 'profile_reduction_a', 1, 1, 'actor_tenant_seat_reduction', 'consultant', 'profile_reduction_a', 'A', 'active', 'provider', 'model', $1, $1),
       ('tenant_seat_reduction', 'profile_reduction_b', 1, 1, 'actor_tenant_seat_reduction', 'consultant', 'profile_reduction_b', 'B', 'active', 'provider', 'model', $1, $1)`,
    [now],
  );
  await pool.query(
    `insert into entitlement_assignments (
       assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
     ) values ('assignment_reduction_a', 'tenant_seat_reduction', 'entitlement_read', 'profile_reduction_a', 'available', 'seat_assigned', 1)`,
  );
  const results = await Promise.allSettled([
    withTransaction(async (client) => client.query(
      `insert into entitlement_assignments (
         assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
       ) values ('assignment_reduction_b', 'tenant_seat_reduction', 'entitlement_read', 'profile_reduction_b', 'preparing', 'seat_assigned', 1)`,
    )),
    withTransaction(async (client) => client.query(
      "update entitlements set seat_quantity = 1 where tenant_id = 'tenant_seat_reduction' and entitlement_id = 'entitlement_read'",
    )),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.ok([
    "entitlement_assignments_seat_capacity_check",
    "entitlements_consumed_seat_capacity_check",
  ].includes(constraintName(rejected?.reason) ?? ""));
  const authority = await pool.query<{ seats: number; assignments: number }>(
    `select entitlement.seat_quantity as seats, count(assignment.assignment_id)::int as assignments
     from entitlements entitlement
     left join entitlement_assignments assignment
       on assignment.tenant_id = entitlement.tenant_id
      and assignment.entitlement_id = entitlement.entitlement_id
      and assignment.status in ('preparing', 'available')
     where entitlement.tenant_id = 'tenant_seat_reduction' and entitlement.entitlement_id = 'entitlement_read'
     group by entitlement.seat_quantity`,
  );
  assert.ok(authority.rows[0]!.seats >= authority.rows[0]!.assignments);
});

test("Tenant releases enforce irreversible rollout generations", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_release_state");
  await assert.rejects(
    pool.query("update tenant_pack_releases set status = 'failed' where tenant_pack_release_id = 'release_read'"),
    (error) => constraintName(error) === "tenant_pack_releases_status_transition_check",
  );
  for (const [releaseId, generation, status] of [
    ["release_failed", 2, "failed"],
    ["release_superseded", 3, "superseded"],
  ] as const) {
    await pool.query(
      `insert into tenant_pack_releases (
         tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
         generation, status, resource_version
       ) values ($1, 'tenant_release_state', 'pack_product_read', 'pack_version_read', '1.0.0', $2, 'preparing', 1)`,
      [releaseId, generation],
    );
    if (status === "superseded") {
      await pool.query("update tenant_pack_releases set status = 'superseded' where tenant_pack_release_id = 'release_read'");
      await pool.query("update tenant_pack_releases set status = 'current' where tenant_pack_release_id = $1", [releaseId]);
    }
    await pool.query("update tenant_pack_releases set status = $2 where tenant_pack_release_id = $1", [releaseId, status]);
    await assert.rejects(
      pool.query("update tenant_pack_releases set status = 'current' where tenant_pack_release_id = $1", [releaseId]),
      (error) => constraintName(error) === "tenant_pack_releases_status_transition_check",
    );
  }
});

test("core_agent_app can perform only Task 8 release transition and pointer CAS authority", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_app_worker");
  await pool.query(
    `insert into entitlement_snapshots (
       snapshot_id, tenant_id, profile_id, snapshot_version, canonical_input_hash, resource_version
     ) values ('snapshot_app_worker', 'tenant_app_worker', 'profile_tenant_app_worker', 1, $1, 1)`,
    [canonicalSnapshotHash({})],
  );
  await withTransaction(async (client) => {
    await client.query("set local role core_agent_app");
    await client.query(
      "update tenant_pack_releases set status = 'superseded' where tenant_pack_release_id = 'release_read'",
    );
    const result = await client.query<{ resource_version: string }>(
      "select resource_version::text from advance_profile_snapshot_pointer($1, $2, 0, $3)",
      ["tenant_app_worker", "profile_tenant_app_worker", "snapshot_app_worker"],
    );
    assert.equal(result.rows[0]?.resource_version, "1");
  });
  await assert.rejects(
    withTransaction(async (client) => {
      await client.query("set local role core_agent_app");
      await client.query("update tenant_pack_releases set status = 'current' where tenant_pack_release_id = 'release_read'");
    }),
    (error) => constraintName(error) === "tenant_pack_releases_status_transition_check",
  );
  await assert.rejects(
    withTransaction(async (client) => {
      await client.query("set local role core_agent_app");
      await client.query("update entitlements set seat_quantity = 2 where entitlement_id = 'entitlement_read'");
    }),
    /permission denied for table entitlements/,
  );
});

test("audit actors and projection releases are exact same-Tenant composite authorities", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_composite_authority");
  await seedIdentityGraph("tenant_composite_other");
  await assert.rejects(
    pool.query(
      `insert into platform_authority_audit (
         platform_authority_audit_id, authority_tenant_id, actor_id, membership_id, action,
         decision, outcome, resource_type, resource_id, resource_version, request_id, trace_id, reason_summary
       ) values (
         'audit_mismatch', 'tenant_composite_authority', 'actor_tenant_composite_other',
         'membership_tenant_composite_authority', 'catalog.review', 'allowed', 'succeeded',
         'capability_version', 'capability_version_read', 1, 'request_audit', 'trace_audit', 'safe'
       )`,
    ),
    (error) => constraintName(error) === "platform_authority_audit_membership_actor_fkey",
  );

  await withTransaction(async (client) => {
    await client.query(
      `insert into entitlement_snapshots (
         snapshot_id, tenant_id, profile_id, snapshot_version, canonical_input_hash, resource_version
       ) values ('snapshot_other_projection', 'tenant_composite_other', 'profile_tenant_composite_other', 1, $1, 1)`,
      [canonicalSnapshotHash({})],
    );
  });
  await assert.rejects(
    pool.query(
      `insert into capability_runtime_projections (
         projection_id, tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at,
         tenant_pack_release_id, runtime_generation, capability_manifest_digest, status, resource_version
       ) select 'projection_cross_tenant', snapshot.tenant_id, snapshot.profile_id, snapshot.snapshot_id,
                snapshot.snapshot_version, snapshot.evaluated_at, 'release_read', 1, $1, 'preparing', 1
         from entitlement_snapshots snapshot where snapshot.snapshot_id = 'snapshot_other_projection'`,
      [`sha256:${"5".repeat(64)}`],
    ),
    (error) => constraintName(error) === "capability_runtime_projections_release_fkey",
  );
});

test("current Snapshot pointer advances only through expected-version CAS", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_pointer");
  await seedAvailableAssignment("tenant_pointer");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_pointer_1",
    tenantId: "tenant_pointer",
    profileId: "profile_tenant_pointer",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));
  const inserted = await pool.query<{ resource_version: string }>(
    "select resource_version::text from advance_profile_snapshot_pointer($1, $2, $3, $4)",
    ["tenant_pointer", "profile_tenant_pointer", 0, "snapshot_pointer_1"],
  );
  assert.equal(inserted.rows[0]?.resource_version, "1");
  await seedAdditionalAssignedEntitlement("tenant_pointer", "pointer");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_pointer_2",
    tenantId: "tenant_pointer",
    profileId: "profile_tenant_pointer",
    snapshotVersion: 2,
    sourceEntitlementIds: ["entitlement_read", "entitlement_read_pointer"],
    sourceAssignmentIds: ["assignment_read", "assignment_read_pointer"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));

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
  await assert.rejects(
    pool.query("select * from advance_profile_snapshot_pointer($1, $2, $3, $4)", ["tenant_pointer", "profile_tenant_pointer", 2, "snapshot_pointer_2"]),
    (error) => constraintName(error) === "profile_snapshot_pointers_monotonic_snapshot_check",
  );
  await assert.rejects(
    pool.query("select * from advance_profile_snapshot_pointer($1, $2, $3, $4)", ["tenant_pointer", "profile_tenant_pointer", 2, "snapshot_pointer_1"]),
    (error) => constraintName(error) === "profile_snapshot_pointers_monotonic_snapshot_check",
  );
});

test("concurrent absent Snapshot pointer initialization serializes on the canonical Profile", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_pointer_init");
  await seedAvailableAssignment("tenant_pointer_init");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_init_1",
    tenantId: "tenant_pointer_init",
    profileId: "profile_tenant_pointer_init",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));
  const attempts = await Promise.allSettled([
    pool.query("select * from advance_profile_snapshot_pointer($1, $2, 0, $3)", ["tenant_pointer_init", "profile_tenant_pointer_init", "snapshot_init_1"]),
    pool.query("select * from advance_profile_snapshot_pointer($1, $2, 0, $3)", ["tenant_pointer_init", "profile_tenant_pointer_init", "snapshot_init_1"]),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(constraintName(rejected?.reason), "profile_snapshot_pointers_expected_version_check");
});

test("review round 4 Snapshot aggregate equals the complete deduplicated effective union", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_complete_union");
  await seedAvailableAssignment("tenant_complete_union");

  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_empty_subset",
      tenantId: "tenant_complete_union",
      profileId: "profile_tenant_complete_union",
    })),
    (error) => constraintName(error) === "entitlement_snapshots_source_completeness_check",
  );

  await pool.query(
    `insert into entitlements (
       entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
       pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
       expires_at, status, reason_code, resource_version
     ) values (
       'entitlement_read_additional', 'tenant_complete_union', 'pack_product_read', 'release_read',
       'pack_version_read', '1.0.0', 'platform_manual', 'order_read_additional', 'b2b', 'seat', 1,
       clock_timestamp() + interval '30 days', 'active', 'platform_grant', 1
     )`,
  );
  await pool.query(
    `insert into entitlement_assignments (
       assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
     ) values (
       'assignment_read_additional', 'tenant_complete_union', 'entitlement_read_additional',
       'profile_tenant_complete_union', 'available', 'seat_assigned', 1
     )`,
  );
  const capabilityV1 = {
    capability_id: "capability_read",
    capability_version_id: "capability_version_read",
    version: "1.0.0",
  } as const;
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_source_subset",
      tenantId: "tenant_complete_union",
      profileId: "profile_tenant_complete_union",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [capabilityV1],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_source_completeness_check",
  );

  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_exact_union",
    tenantId: "tenant_complete_union",
    profileId: "profile_tenant_complete_union",
    sourceEntitlementIds: ["entitlement_read", "entitlement_read_additional"],
    sourceAssignmentIds: ["assignment_read", "assignment_read_additional"],
    sourceReleaseIds: ["release_read"],
    capabilities: [capabilityV1],
  }));
  assert.equal(
    Number((await pool.query(
      "select count(*)::int as count from entitlement_snapshot_capabilities where snapshot_id = 'snapshot_exact_union'",
    )).rows[0]?.count),
    1,
  );

  await pool.query(
    `insert into capabilities (
       capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at
     ) values ('capability_extra', 'Extra', 'synthetic', 'skill', 1, now(), now())`,
  );
  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_extra', 'capability_extra', '1.0.0', 'skill', $1,
       'synthetic/extra@1.0.0', 'read', 'none',
       '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb,
       'reviewed', 1, now(), now()
     )`,
    [`manifest:sha256:${"7".repeat(64)}`],
  );
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_extra_capability",
      tenantId: "tenant_complete_union",
      profileId: "profile_tenant_complete_union",
      snapshotVersion: 2,
      sourceEntitlementIds: ["entitlement_read", "entitlement_read_additional"],
      sourceAssignmentIds: ["assignment_read", "assignment_read_additional"],
      sourceReleaseIds: ["release_read"],
      capabilities: [capabilityV1, {
        capability_id: "capability_extra",
        capability_version_id: "capability_version_extra",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_capability_completeness_check",
  );

  await pool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_read_v2', 'capability_read', '2.0.0', 'mcp', $1,
       'synthetic/read@2.0.0', 'read', 'none',
       '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb,
       'reviewed', 1, now(), now()
     )`,
    [`manifest:sha256:${"6".repeat(64)}`],
  );
  await pool.query(
    `insert into pack_products (
       pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at
     ) values ('pack_product_conflict', 'Conflict', array['b2b','b2c'], 1, now(), now());
     insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_version_conflict', 'pack_product_conflict', '1.0.0', 'draft', 1, now(), now());
     insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
       resource_version, created_at, updated_at
     ) values (
       'pack_member_conflict', 'pack_version_conflict', 1, 'capability_read',
       'capability_version_read_v2', '2.0.0', 1, now(), now()
     );
     update pack_versions set status = 'reviewed', resource_version = 2 where pack_version_id = 'pack_version_conflict';
     update pack_versions set status = 'published', resource_version = 3 where pack_version_id = 'pack_version_conflict';
     insert into tenant_pack_releases (
       tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
       generation, status, resource_version
     ) values (
       'release_conflict', 'tenant_complete_union', 'pack_product_conflict', 'pack_version_conflict',
       '1.0.0', 1, 'preparing', 1
     );
     update tenant_pack_releases set status = 'current', resource_version = 2
       where tenant_pack_release_id = 'release_conflict';
     insert into entitlements (
       entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
       pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
       expires_at, status, reason_code, resource_version
     ) values (
       'entitlement_conflict', 'tenant_complete_union', 'pack_product_conflict', 'release_conflict',
       'pack_version_conflict', '1.0.0', 'platform_manual', 'order_conflict', 'b2b', 'seat', 1,
       clock_timestamp() + interval '30 days', 'active', 'platform_grant', 1
     );
     insert into entitlement_assignments (
       assignment_id, tenant_id, entitlement_id, profile_id, status, reason_code, resource_version
     ) values (
       'assignment_conflict', 'tenant_complete_union', 'entitlement_conflict',
       'profile_tenant_complete_union', 'available', 'seat_assigned', 1
     )`,
  );
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_conflicting_union",
      tenantId: "tenant_complete_union",
      profileId: "profile_tenant_complete_union",
      snapshotVersion: 2,
      sourceEntitlementIds: ["entitlement_conflict", "entitlement_read", "entitlement_read_additional"],
      sourceAssignmentIds: ["assignment_conflict", "assignment_read", "assignment_read_additional"],
      sourceReleaseIds: ["release_conflict", "release_read"],
      capabilities: [capabilityV1],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_capability_conflict_check",
  );
});

test("review round 5 complete Snapshot sources reject missing Capability children", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_missing_capability");
  await seedAvailableAssignment("tenant_missing_capability");

  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_missing_capability",
      tenantId: "tenant_missing_capability",
      profileId: "profile_tenant_missing_capability",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_capability_completeness_check",
  );
});

test("review round 4 preparing release Snapshot stays pending until release is current", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_candidate_release");
  await seedAvailableAssignment("tenant_candidate_release");
  await pool.query(
    `insert into capabilities (
       capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at
     ) values ('capability_candidate', 'Candidate capability', 'synthetic', 'skill', 1, now(), now());
     insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_candidate', 'capability_candidate', '2.0.0', 'skill',
       'manifest:sha256:5555555555555555555555555555555555555555555555555555555555555555',
       'synthetic/candidate@2.0.0', 'read', 'none',
       '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b","b2c"]}'::jsonb,
       'reviewed', 1, now(), now()
     );
     insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_version_candidate', 'pack_product_read', '2.0.0', 'draft', 1, now(), now());
     insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
       resource_version, created_at, updated_at
     ) values (
       'pack_member_candidate', 'pack_version_candidate', 1, 'capability_candidate',
       'capability_version_candidate', '2.0.0', 1, now(), now()
     );
     update pack_versions set status = 'reviewed', resource_version = 2 where pack_version_id = 'pack_version_candidate';
     update pack_versions set status = 'published', resource_version = 3 where pack_version_id = 'pack_version_candidate';
     insert into tenant_pack_releases (
       tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version,
       generation, status, resource_version
     ) values (
       'release_candidate', 'tenant_candidate_release', 'pack_product_read', 'pack_version_candidate',
       '2.0.0', 2, 'preparing', 1
     )`,
  );
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_candidate",
    tenantId: "tenant_candidate_release",
    profileId: "profile_tenant_candidate_release",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_candidate"],
    capabilities: [{
      capability_id: "capability_candidate",
      capability_version_id: "capability_version_candidate",
      version: "2.0.0",
    }],
  }));
  await assert.rejects(
    pool.query(
      "select * from advance_profile_snapshot_pointer($1, $2, 0, $3)",
      ["tenant_candidate_release", "profile_tenant_candidate_release", "snapshot_candidate"],
    ),
    (error) => constraintName(error) === "profile_snapshot_pointers_release_current_check",
  );
  await pool.query(
    "update tenant_pack_releases set status = 'superseded' where tenant_pack_release_id = 'release_read'",
  );
  await pool.query(
    "update tenant_pack_releases set status = 'current' where tenant_pack_release_id = 'release_candidate'",
  );
  const advanced = await pool.query<{ resource_version: string }>(
    "select resource_version::text from advance_profile_snapshot_pointer($1, $2, 0, $3)",
    ["tenant_candidate_release", "profile_tenant_candidate_release", "snapshot_candidate"],
  );
  assert.equal(advanced.rows[0]?.resource_version, "1");
});

test("review round 5 pointer CAS rejects authority changed after Snapshot preparation", async () => {
  const cases = [
    {
      name: "revoked Entitlement",
      mutate: () => pool.query(
        `update entitlements
         set status = 'revoked', reason_code = 'platform_revoked', resource_version = 2
         where tenant_id = 'tenant_pointer_revalidate' and entitlement_id = 'entitlement_read'`,
      ),
    },
    {
      name: "expired Entitlement",
      mutate: () => pool.query(
        `update entitlements
         set status = 'expired', reason_code = 'validity_expired', expires_at = clock_timestamp(), resource_version = 2
         where tenant_id = 'tenant_pointer_revalidate' and entitlement_id = 'entitlement_read'`,
      ),
    },
    {
      name: "removed Assignment",
      mutate: () => pool.query(
        `update entitlement_assignments
         set status = 'revoked', reason_code = 'administrator_revoked', resource_version = 2
         where tenant_id = 'tenant_pointer_revalidate' and assignment_id = 'assignment_read'`,
      ),
    },
    {
      name: "added Entitlement and Assignment",
      mutate: () => seedAdditionalAssignedEntitlement("tenant_pointer_revalidate", "after_prepare"),
    },
  ] as const;

  for (const [index, mutation] of cases.entries()) {
    if (index > 0) await resetDatabase();
    await applyMigrations(pool, migrationsDirectory);
    await seedCatalogAndEntitlement("tenant_pointer_revalidate");
    await seedAvailableAssignment("tenant_pointer_revalidate");
    await withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: `snapshot_pointer_revalidate_${index}`,
      tenantId: "tenant_pointer_revalidate",
      profileId: "profile_tenant_pointer_revalidate",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_read",
        capability_version_id: "capability_version_read",
        version: "1.0.0",
      }],
    }));
    await mutation.mutate();
    await assert.rejects(
      pool.query(
        "select * from advance_profile_snapshot_pointer($1, $2, 0, $3)",
        ["tenant_pointer_revalidate", "profile_tenant_pointer_revalidate", `snapshot_pointer_revalidate_${index}`],
      ),
      (error) => {
        assert.equal(constraintName(error), "profile_snapshot_pointers_current_authority_check", mutation.name);
        return true;
      },
    );
  }
});

test("review round 5 authority mutation cannot cross pointer validation and write", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_pointer_barrier");
  await seedAvailableAssignment("tenant_pointer_barrier");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_pointer_barrier",
    tenantId: "tenant_pointer_barrier",
    profileId: "profile_tenant_pointer_barrier",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));

  const mutationClient = await pool.connect();
  const pointerClient = await pool.connect();
  try {
    await mutationClient.query("begin");
    await pointerClient.query("select set_config('application_name', 'entitlement_pointer_authority_barrier', false)");
    await mutationClient.query(
      `update entitlements
       set status = 'revoked', reason_code = 'platform_revoked', resource_version = 2
       where tenant_id = 'tenant_pointer_barrier' and entitlement_id = 'entitlement_read'`,
    );
    const pointerAdvance = pointerClient.query(
      "select * from advance_profile_snapshot_pointer($1, $2, 0, $3)",
      ["tenant_pointer_barrier", "profile_tenant_pointer_barrier", "snapshot_pointer_barrier"],
    );
    const waitedOnAuthorityLock = await waitForDatabaseLock("entitlement_pointer_authority_barrier");
    await mutationClient.query("commit");
    const [pointerResult] = await Promise.allSettled([pointerAdvance]);
    assert.equal(waitedOnAuthorityLock, true);
    assert.equal(pointerResult!.status, "rejected");
    if (pointerResult!.status === "rejected") {
      assert.equal(constraintName(pointerResult!.reason), "profile_snapshot_pointers_current_authority_check");
    }
    assert.equal(
      Number((await pool.query(
        "select count(*)::int as count from profile_snapshot_pointers where tenant_id = 'tenant_pointer_barrier'",
      )).rows[0]?.count),
      0,
    );
  } finally {
    await mutationClient.query("rollback").catch(() => undefined);
    mutationClient.release();
    pointerClient.release();
  }
});

test("review round 6 every Assignment UPDATE locks its parent Entitlement before Profile", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_assignment_parent_lock");
  await seedAvailableAssignment("tenant_assignment_parent_lock");

  const entitlementClient = await pool.connect();
  const assignmentClient = await pool.connect();
  try {
    await entitlementClient.query("begin");
    await assignmentClient.query("begin");
    await assignmentClient.query("select set_config('application_name', 'entitlement_assignment_parent_lock', false)");
    await entitlementClient.query(
      `select 1 from entitlements
       where tenant_id = 'tenant_assignment_parent_lock' and entitlement_id = 'entitlement_read'
       for update`,
    );
    const assignmentUpdate = assignmentClient.query(
      `update entitlement_assignments
       set updated_at = clock_timestamp(), resource_version = 2
       where tenant_id = 'tenant_assignment_parent_lock' and assignment_id = 'assignment_read'`,
    );
    const waitedOnParent = await waitForDatabaseLock("entitlement_assignment_parent_lock");
    await entitlementClient.query("commit");
    const [assignmentResult] = await Promise.allSettled([assignmentUpdate]);
    if (assignmentResult!.status === "fulfilled") await assignmentClient.query("commit");
    else await assignmentClient.query("rollback");
    assert.equal(waitedOnParent, true);
    assert.equal(assignmentResult!.status, "fulfilled");
  } finally {
    await entitlementClient.query("rollback").catch(() => undefined);
    await assignmentClient.query("rollback").catch(() => undefined);
    entitlementClient.release();
    assignmentClient.release();
  }
});

test("review round 6 Entitlement-first and Assignment UPDATE complete without a lock-order deadlock", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_entitlement_first");
  await seedAvailableAssignment("tenant_entitlement_first");

  const entitlementClient = await pool.connect();
  const assignmentClient = await pool.connect();
  try {
    await entitlementClient.query("begin");
    await assignmentClient.query("begin");
    await entitlementClient.query("set local deadlock_timeout = '100ms'");
    await assignmentClient.query("set local deadlock_timeout = '100ms'");
    await assignmentClient.query("select set_config('application_name', 'entitlement_assignment_deadlock_probe', false)");
    await entitlementClient.query(
      `select 1 from entitlements
       where tenant_id = 'tenant_entitlement_first' and entitlement_id = 'entitlement_read'
       for update`,
    );
    const assignmentUpdate = assignmentClient.query(
      `update entitlement_assignments
       set status = 'available', resource_version = 2
       where tenant_id = 'tenant_entitlement_first' and assignment_id = 'assignment_read'`,
    ).then(
      (value) => ({ status: "fulfilled", value } as const),
      (reason: unknown) => ({ status: "rejected", reason } as const),
    );
    assert.equal(await waitForDatabaseLock("entitlement_assignment_deadlock_probe"), true);
    const [entitlementUpdateResult] = await Promise.allSettled([
      entitlementClient.query(
        `update entitlements
         set updated_at = clock_timestamp(), resource_version = 2
         where tenant_id = 'tenant_entitlement_first' and entitlement_id = 'entitlement_read'`,
      ),
    ]);
    if (entitlementUpdateResult!.status === "fulfilled") await entitlementClient.query("commit");
    else await entitlementClient.query("rollback");
    const assignmentUpdateResult = await assignmentUpdate;
    if (assignmentUpdateResult!.status === "fulfilled") await assignmentClient.query("commit");
    else await assignmentClient.query("rollback");
    assert.equal(entitlementUpdateResult!.status, "fulfilled");
    assert.equal(assignmentUpdateResult!.status, "fulfilled");
    assert.deepEqual(
      (await pool.query(
        `select entitlement.resource_version::text as entitlement_version,
                assignment.resource_version::text as assignment_version
         from entitlements as entitlement
         join entitlement_assignments as assignment
           on assignment.tenant_id = entitlement.tenant_id
          and assignment.entitlement_id = entitlement.entitlement_id
         where entitlement.tenant_id = 'tenant_entitlement_first'`,
      )).rows,
      [{ entitlement_version: "2", assignment_version: "2" }],
    );
  } finally {
    await entitlementClient.query("rollback").catch(() => undefined);
    await assignmentClient.query("rollback").catch(() => undefined);
    entitlementClient.release();
    assignmentClient.release();
  }
});

test("review round 6 Assignment-first and Entitlement UPDATE serialize without deadlock", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_assignment_first");
  await seedAvailableAssignment("tenant_assignment_first");

  const assignmentClient = await pool.connect();
  const entitlementClient = await pool.connect();
  try {
    await assignmentClient.query("begin");
    await entitlementClient.query("begin");
    await entitlementClient.query("select set_config('application_name', 'entitlement_update_after_assignment', false)");
    await assignmentClient.query(
      `update entitlement_assignments
       set status = 'available', resource_version = 2
       where tenant_id = 'tenant_assignment_first' and assignment_id = 'assignment_read'`,
    );
    const entitlementUpdate = entitlementClient.query(
      `update entitlements
       set updated_at = clock_timestamp(), resource_version = 2
       where tenant_id = 'tenant_assignment_first' and entitlement_id = 'entitlement_read'`,
    );
    assert.equal(await waitForDatabaseLock("entitlement_update_after_assignment"), true);
    await assignmentClient.query("commit");
    const [entitlementResult] = await Promise.allSettled([entitlementUpdate]);
    if (entitlementResult!.status === "fulfilled") await entitlementClient.query("commit");
    else await entitlementClient.query("rollback");
    assert.equal(entitlementResult!.status, "fulfilled");
    assert.deepEqual(
      (await pool.query(
        `select entitlement.resource_version::text as entitlement_version,
                assignment.resource_version::text as assignment_version
         from entitlements as entitlement
         join entitlement_assignments as assignment
           on assignment.tenant_id = entitlement.tenant_id
          and assignment.entitlement_id = entitlement.entitlement_id
         where entitlement.tenant_id = 'tenant_assignment_first'`,
      )).rows,
      [{ entitlement_version: "2", assignment_version: "2" }],
    );
  } finally {
    await assignmentClient.query("rollback").catch(() => undefined);
    await entitlementClient.query("rollback").catch(() => undefined);
    assignmentClient.release();
    entitlementClient.release();
  }
});

test("review round 6 CAS-first orders a later Entitlement mutation after the pointer write", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_pointer_cas_first");
  await seedAvailableAssignment("tenant_pointer_cas_first");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_pointer_cas_first",
    tenantId: "tenant_pointer_cas_first",
    profileId: "profile_tenant_pointer_cas_first",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));

  const pointerClient = await pool.connect();
  const mutationClient = await pool.connect();
  try {
    await pointerClient.query("begin");
    await mutationClient.query("begin");
    await mutationClient.query("select set_config('application_name', 'entitlement_mutation_after_pointer', false)");
    await pointerClient.query(
      "select * from advance_profile_snapshot_pointer($1, $2, 0, $3)",
      ["tenant_pointer_cas_first", "profile_tenant_pointer_cas_first", "snapshot_pointer_cas_first"],
    );
    const mutation = mutationClient.query(
      `update entitlements
       set status = 'revoked', reason_code = 'platform_revoked', resource_version = 2
       where tenant_id = 'tenant_pointer_cas_first' and entitlement_id = 'entitlement_read'`,
    );
    assert.equal(await waitForDatabaseLock("entitlement_mutation_after_pointer"), true);
    await pointerClient.query("commit");
    const [mutationResult] = await Promise.allSettled([mutation]);
    if (mutationResult!.status === "fulfilled") await mutationClient.query("commit");
    else await mutationClient.query("rollback");
    assert.equal(mutationResult!.status, "fulfilled");
    assert.deepEqual(
      (await pool.query(
        `select pointer.resource_version::text as pointer_version, entitlement.status
         from profile_snapshot_pointers as pointer
         join entitlements as entitlement on entitlement.tenant_id = pointer.tenant_id
         where pointer.tenant_id = 'tenant_pointer_cas_first'`,
      )).rows,
      [{ pointer_version: "1", status: "revoked" }],
    );
  } finally {
    await pointerClient.query("rollback").catch(() => undefined);
    await mutationClient.query("rollback").catch(() => undefined);
    pointerClient.release();
    mutationClient.release();
  }
});

test("review round 4 historical current releases resolve retired authority but never blocked authority", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_retired_current");
  await seedAvailableAssignment("tenant_retired_current");
  await pool.query("update pack_versions set status = 'retired' where pack_version_id = 'pack_version_read'");
  await pool.query("update capability_versions set status = 'retired' where capability_version_id = 'capability_version_read'");
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_retired_current",
    tenantId: "tenant_retired_current",
    profileId: "profile_tenant_retired_current",
    sourceEntitlementIds: ["entitlement_read"],
    sourceAssignmentIds: ["assignment_read"],
    sourceReleaseIds: ["release_read"],
    capabilities: [{
      capability_id: "capability_read",
      capability_version_id: "capability_version_read",
      version: "1.0.0",
    }],
  }));

  await resetDatabase();
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_blocked_current");
  await seedAvailableAssignment("tenant_blocked_current");
  await pool.query("update capability_versions set status = 'blocked' where capability_version_id = 'capability_version_read'");
  await assert.rejects(
    withTransaction((client) => insertSnapshotAggregate(client, {
      snapshotId: "snapshot_blocked_current",
      tenantId: "tenant_blocked_current",
      profileId: "profile_tenant_blocked_current",
      sourceEntitlementIds: ["entitlement_read"],
      sourceAssignmentIds: ["assignment_read"],
      sourceReleaseIds: ["release_read"],
      capabilities: [{
        capability_id: "capability_read",
        capability_version_id: "capability_version_read",
        version: "1.0.0",
      }],
    })),
    (error) => constraintName(error) === "entitlement_snapshots_capability_authority_check",
  );
});

test("review round 4 Pack publication and Product mode updates serialize on one Product lock", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedIdentityGraph("tenant_product_lock");
  await pool.query(
    `insert into capabilities (
       capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at
     ) values ('capability_product_lock', 'Lock capability', 'synthetic', 'mcp', 1, now(), now());
     insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values (
       'capability_version_product_lock', 'capability_product_lock', '1.0.0', 'mcp',
       'manifest:sha256:4444444444444444444444444444444444444444444444444444444444444444',
       'synthetic/product-lock@1.0.0', 'read', 'none',
       '{"core_contract_version":"0.7.0","domain_contract_version":"1.0.0","runtime_protocol_version":"1.0.0","tenant_modes":["b2b"]}'::jsonb,
       'reviewed', 1, now(), now()
     );
     insert into pack_products (
       pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at
     ) values ('pack_product_lock', 'Lock pack', array['b2b'], 1, now(), now());
     insert into pack_versions (
       pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at
     ) values ('pack_version_lock', 'pack_product_lock', '1.0.0', 'draft', 1, now(), now());
     insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id, version,
       resource_version, created_at, updated_at
     ) values (
       'pack_member_lock', 'pack_version_lock', 1, 'capability_product_lock',
       'capability_version_product_lock', '1.0.0', 1, now(), now()
     );
     update pack_versions set status = 'reviewed', resource_version = 2 where pack_version_id = 'pack_version_lock'`,
  );
  const productClient = await pool.connect();
  const publishClient = await pool.connect();
  try {
    await productClient.query("begin");
    await publishClient.query("begin");
    await publishClient.query("select set_config('application_name', 'entitlement_product_publish_barrier', false)");
    await productClient.query(
      "update pack_products set tenant_modes = array['b2b','b2c'] where pack_product_id = 'pack_product_lock'",
    );
    const publish = publishClient.query(
      "update pack_versions set status = 'published', resource_version = 3 where pack_version_id = 'pack_version_lock'",
    ).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const waitedOnProductLock = await waitForDatabaseLock("entitlement_product_publish_barrier");
    await productClient.query("commit");
    const publishResult = await publish;
    if (publishResult.status === "fulfilled") await publishClient.query("commit");
    else await publishClient.query("rollback");
    assert.equal(waitedOnProductLock, true);
    assert.equal(publishResult.status, "rejected");
    if (publishResult.status === "rejected") {
      assert.equal(constraintName(publishResult.reason), "pack_versions_publishable_members_check");
    }
    assert.deepEqual(
      (await pool.query(
        "select tenant_modes, (select status from pack_versions where pack_version_id = 'pack_version_lock') as pack_status from pack_products where pack_product_id = 'pack_product_lock'",
      )).rows,
      [{ tenant_modes: ["b2b", "b2c"], pack_status: "reviewed" }],
    );
  } finally {
    await productClient.query("rollback").catch(() => undefined);
    await publishClient.query("rollback").catch(() => undefined);
    productClient.release();
    publishClient.release();
  }
});

test("review round 4 SQL canonical hash matches UTF-8 TypeScript order and JSON escaping", async () => {
  await applyMigrations(pool, migrationsDirectory);
  await seedCatalogAndEntitlement("tenant_unicode_hash", { tenantMode: "b2c" });
  await pool.query("delete from entitlements where tenant_id = 'tenant_unicode_hash'");
  const entitlementIds = [
    "entitlement_\uE000",
    "entitlement_\u{1F600}",
    "entitlement_\"escape\\line\n",
  ].sort(compareUtf8);
  for (const [index, entitlementId] of entitlementIds.entries()) {
    await pool.query(
      `insert into entitlements (
         entitlement_id, tenant_id, pack_product_id, tenant_pack_release_id, pack_version_id,
         pack_version, source, external_order_ref, tenant_mode, assignment_mode, seat_quantity,
         expires_at, status, reason_code, resource_version
       ) values (
         $1, 'tenant_unicode_hash', 'pack_product_read', 'release_read', 'pack_version_read',
         '1.0.0', 'platform_manual', $2, 'b2c', 'automatic', null,
         clock_timestamp() + interval '30 days', 'active', 'platform_grant', 1
       )`,
      [entitlementId, `unicode_order_${index}`],
    );
  }
  const capabilities = [{
    capability_id: "capability_read",
    capability_version_id: "capability_version_read",
    version: "1.0.0",
  }] as const;
  const canonicalInputHash = canonicalSnapshotHash({
    sourceEntitlementIds: entitlementIds,
    sourceReleaseIds: ["release_read"],
    capabilities,
  });
  await withTransaction((client) => insertSnapshotAggregate(client, {
    snapshotId: "snapshot_unicode_hash",
    tenantId: "tenant_unicode_hash",
    profileId: "profile_tenant_unicode_hash",
    sourceEntitlementIds: entitlementIds,
    sourceReleaseIds: ["release_read"],
    capabilities,
    canonicalInputHash,
  }));
  assert.deepEqual(
    (await pool.query(
      `select canonical_input_hash from entitlement_snapshots
       where snapshot_id = 'snapshot_unicode_hash'`,
    )).rows,
    [{ canonical_input_hash: canonicalInputHash }],
  );
});

test("review round 4 Snapshot creation metadata is database-generated and immutable in Kysely", async () => {
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../src/db/entitlement-tables.ts"),
    "utf8",
  );
  assert.match(
    source,
    /evaluated_at: ColumnType<Date, undefined, never>;\s+creation_xid: ColumnType<string, undefined, never>;/u,
  );
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
