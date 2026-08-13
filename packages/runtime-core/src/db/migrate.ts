import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool } from "pg";

interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

interface SchemaManifest {
  readonly checksum: string;
  readonly name: string;
  readonly relations?: readonly string[];
  readonly sequences?: readonly string[];
  readonly validateAndConverge?: (client: import("pg").PoolClient, maximumVersion: number) => Promise<void>;
  readonly version: number;
}

const schemaManifestEntries = [
  [1, "resources", "0704ccd79f552a2e913eaddd3f7dd9ab16a6a8aefc6e6484ac31d064456d0e2e"],
  [2, "execution", "153d18f015192ca06e5ab58791a6517965a6113afd8cfbb9844149dc5a518b40"],
  [3, "events", "c857a1d47f2d9f8ef5671198b1040a5708fe7a6480cded1b8ed3090b948a220f"],
  [4, "runtime_command_intent", "aed2030a91ee2e5685d49aa3f50fb888a1db197fa2c3e848eaf343494be5501d"],
  [5, "worker_runtime_facts", "ca97c68d4095c74933af2dbbfbc03e6959ab6598fde3c86861e40d3229a0aed1"],
  [6, "worker_job_attempt_fence", "b6c7a9e3f8564ba761ec13938882db9a9bc157edc7045a5537db2107924562c5"],
  [7, "agent_run_claim_indexes", "ddc3de91432e8c0a82261ea1289745ef73360aa403bcad24dddaaaaea85ceafa"],
  [8, "outbox_exhausted_recovery_index", "622b248d1df5b2636ac6616ab59274e1cd6bf2ae4a54d1e97b8b7fbe5a61209b"],
  [9, "agent_run_failure_code", "5c67f4d0bb65a25cf331acd122e3ae1ba48ef287f34e2cd97844e96b1f95af95"],
  [10, "identity_authority", "eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381"],
] as const;

const schemaManifests = new Map<number, SchemaManifest>(schemaManifestEntries.map(([version, name, checksum]) => [
  version, { version, name, checksum },
]));

const schema10Tables = [
  "account_deletions", "actors", "agent_runs", "audit_events", "auth_subjects",
  "conversations", "core_agent_schema_migrations", "core_sessions", "idempotency_records",
  "identity_invitations", "memberships", "messages", "oauth_transactions", "outbox",
  "platform_role_assignments", "private_identity_pii", "product_events", "profiles",
  "public_rate_limits", "runtime_containers", "secret_references", "sessions",
  "stream_cursors", "stream_sequences", "tenants", "worker_jobs",
] as const;

const applicationTables = schema10Tables.filter((table) => ![
  "account_deletions", "auth_subjects", "core_agent_schema_migrations", "core_sessions",
  "identity_invitations", "oauth_transactions", "platform_role_assignments",
  "private_identity_pii", "public_rate_limits",
].includes(table));

const identityGrants = [
  ["SELECT, INSERT, UPDATE", "tenants, actors, memberships, profiles, platform_role_assignments, identity_invitations, oauth_transactions, core_sessions, account_deletions"],
  ["SELECT, INSERT, UPDATE, DELETE", "auth_subjects, private_identity_pii, core_sessions"],
  ["SELECT, INSERT, UPDATE", "public_rate_limits, idempotency_records, stream_sequences"],
  ["SELECT, INSERT", "product_events, audit_events, outbox, worker_jobs"],
] as const;

async function convergeSchema10Acls(client: import("pg").PoolClient, maximumVersion = 10): Promise<void> {
  const catalog = await client.query<{ owner_matches: boolean; table_name: string }>(
    `select relation.relname as table_name, owner.rolname = current_user as owner_matches
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_roles owner on owner.oid = relation.relowner
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
     order by relation.relname`,
  );
  if (
    (maximumVersion === 10 && catalog.rows.length !== schema10Tables.length)
    || schema10Tables.some((table) => !catalog.rows.some((row) => row.table_name === table && row.owner_matches))
  ) throw new Error("schema 10 ACL convergence failed: catalog");

  const triggers = await client.query<{ definition: string; enabled: string; function_name: string; trigger_name: string }>(
    `select pg_get_triggerdef(trigger.oid, true) as definition,
            trigger.tgenabled as enabled,
            function.proname as function_name,
            trigger.tgname as trigger_name
     from pg_trigger trigger
     join pg_class relation on relation.oid = trigger.tgrelid
     join pg_proc function on function.oid = trigger.tgfoid
     where relation.relnamespace = 'public'::regnamespace and not trigger.tgisinternal
     order by trigger.tgname`,
  );
  const expectedTriggers = [
    ["core_sessions_revoked_deletion_check", "enforce_core_session_revoked_deletion",
      "CREATE TRIGGER core_sessions_revoked_deletion_check BEFORE DELETE ON core_sessions FOR EACH ROW EXECUTE FUNCTION enforce_core_session_revoked_deletion()"],
    ["memberships_ordinary_actor_authority_check", "enforce_ordinary_membership_actor_authority",
      "CREATE CONSTRAINT TRIGGER memberships_ordinary_actor_authority_check AFTER INSERT OR UPDATE OF actor_id, membership_source, status ON memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.membership_source <> 'platform'::text AND (new.status = ANY (ARRAY['active'::text, 'invited'::text]))) EXECUTE FUNCTION enforce_ordinary_membership_actor_authority()"],
    ["worker_jobs_identity_job_kind_check", "enforce_identity_worker_job_kind",
      "CREATE TRIGGER worker_jobs_identity_job_kind_check BEFORE INSERT ON worker_jobs FOR EACH ROW EXECUTE FUNCTION enforce_identity_worker_job_kind()"],
  ] as const;
  if (triggers.rows.length !== expectedTriggers.length || triggers.rows.some((row, index) =>
    row.enabled !== "O"
    || row.trigger_name !== expectedTriggers[index]?.[0]
    || row.function_name !== expectedTriggers[index]?.[1]
    || row.definition !== expectedTriggers[index]?.[2])) {
    throw new Error("schema 10 manifest validation failed: trigger");
  }
  for (const [, functionName] of expectedTriggers) {
    await client.query(`alter function ${functionName}() set search_path = pg_catalog, public`);
  }
  const functions = await client.query<{ config: string[] | null; identity_args: string; name: string; owner_matches: boolean; result: string; security_definer: boolean }>(
    `select function.proname as name, function.proconfig as config,
            owner.rolname = current_user as owner_matches,
            function.prosecdef as security_definer,
            pg_get_function_identity_arguments(function.oid) as identity_args,
            pg_get_function_result(function.oid) as result
     from pg_proc function
     join pg_roles owner on owner.oid = function.proowner
     where function.pronamespace = 'public'::regnamespace
       and function.proname = any($1::text[])
     order by function.proname`,
    [expectedTriggers.map((entry) => entry[1])],
  );
  if (functions.rows.length !== 3 || functions.rows.some((row) =>
    !row.owner_matches || row.security_definer || row.identity_args !== "" || row.result !== "trigger"
    || JSON.stringify(row.config) !== JSON.stringify(["search_path=pg_catalog, public"]))) {
    throw new Error("schema 10 manifest validation failed: function");
  }
  const shape = await client.query<{ column_hash: string; constraint_hash: string; index_hash: string }>(
    `select
       (select md5(string_agg(format('%s|%s|%s|%s|%s', relation.relname, attribute.attname,
          format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull,
          coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '')), E'\\n'
          order by relation.relname, attribute.attnum))
        from pg_class relation
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        join pg_attribute attribute on attribute.attrelid = relation.oid and attribute.attnum > 0 and not attribute.attisdropped
        left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
        where namespace.nspname = 'public' and relation.relname = any($1::text[])) as column_hash,
       (select md5(string_agg(format('%s|%s|%s|%s', catalog_constraint.conrelid::regclass::text,
          catalog_constraint.conname, catalog_constraint.contype, pg_get_constraintdef(catalog_constraint.oid, true)), E'\\n'
          order by catalog_constraint.conrelid::regclass::text, catalog_constraint.conname))
        from pg_constraint catalog_constraint
        where catalog_constraint.connamespace = 'public'::regnamespace
          and catalog_constraint.conrelid::regclass::text = any($1::text[])
          and catalog_constraint.convalidated) as constraint_hash,
       (select md5(string_agg(format('%s|%s|%s', indexes.tablename, indexes.indexname, indexes.indexdef), E'\\n'
          order by indexes.tablename, indexes.indexname))
        from pg_indexes indexes
        where indexes.schemaname = 'public' and indexes.tablename = any($1::text[])) as index_hash`,
    [["actors", "memberships", "auth_subjects", "private_identity_pii", "platform_role_assignments",
      "identity_invitations", "oauth_transactions", "core_sessions", "account_deletions",
      "public_rate_limits", "worker_jobs"]],
  );
  if (shape.rows[0]?.column_hash !== "08d51c576487ee2792b487dc21117648") {
    throw new Error("schema 10 manifest validation failed: column");
  }
  if (shape.rows[0]?.constraint_hash !== "868449ac00eb5285e3df9abbc7f269c5") {
    throw new Error("schema 10 manifest validation failed: constraint");
  }
  if (shape.rows[0]?.index_hash !== "8643638c98a319a230069e9bd5f0b09e") {
    throw new Error("schema 10 manifest validation failed: index");
  }
  const definitions = await client.query<{ definition_hash: string; name: string }>(
    `select proname as name, md5(pg_get_functiondef(oid)) as definition_hash
     from pg_proc
     where pronamespace = 'public'::regnamespace and proname = any($1::text[])
     order by proname`,
    [expectedTriggers.map((entry) => entry[1])],
  );
  const expectedDefinitionHashes = [
    ["enforce_core_session_revoked_deletion", "42880212e8574d7c72e6890101e936a9"],
    ["enforce_identity_worker_job_kind", "8b1134035bc62e57f81d5b96fa36e5e6"],
    ["enforce_ordinary_membership_actor_authority", "a19d30d4b4882b906aabeea0f680d0cd"],
  ];
  if (definitions.rows.length !== expectedDefinitionHashes.length || definitions.rows.some((row, index) =>
    row.name !== expectedDefinitionHashes[index]?.[0] || row.definition_hash !== expectedDefinitionHashes[index]?.[1])) {
    throw new Error("schema 10 manifest validation failed: function definition");
  }

  const tables = schema10Tables.join(", ");
  try {
    await client.query(`revoke all on table ${tables} from public, core_agent_app, core_agent_identity`);
  } catch {
    throw new Error("schema 10 ACL convergence failed: table revoke");
  }
  try {
    await client.query(`grant select, insert, update, delete on table ${applicationTables.join(", ")} to core_agent_app`);
    await client.query("grant select on table core_agent_schema_migrations to core_agent_app");
  } catch {
    throw new Error("schema 10 ACL convergence failed: application grant");
  }
  for (const [privileges, grantTables] of identityGrants) {
    try {
      await client.query(`grant ${privileges} on table ${grantTables} to core_agent_identity`);
    } catch {
      throw new Error("schema 10 ACL convergence failed: identity grant");
    }
  }
  const sequences = await client.query<{ owner_matches: boolean; sequence_name: string }>(
    `select relation.relname as sequence_name, owner.rolname = current_user as owner_matches
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_roles owner on owner.oid = relation.relowner
     where namespace.nspname = 'public' and relation.relkind = 'S'
     order by relation.relname`,
  );
  if (sequences.rows.length !== 0) throw new Error("schema 10 manifest validation failed: sequence catalog");
  if (sequences.rows.some((row) => !row.owner_matches)) {
    throw new Error("schema 10 ACL convergence failed: sequence owner");
  }
  for (const sequence of sequences.rows) {
    if (!/^[a-z][a-z0-9_]*$/u.test(sequence.sequence_name)) throw new Error("schema 10 ACL convergence failed: sequence name");
    try {
      await client.query(`revoke all on sequence "${sequence.sequence_name}" from public, core_agent_app, core_agent_identity`);
    } catch {
      throw new Error("schema 10 ACL convergence failed: sequence revoke");
    }
  }
  const acl = await client.query<{ acl_hash: string }>(
    `select md5(coalesce(string_agg(format('%s|%s|%s|%s', relation.relname,
       coalesce(grantee.rolname, 'PUBLIC'), privilege.privilege_type, privilege.is_grantable), E'\\n'
       order by relation.relname, coalesce(grantee.rolname, 'PUBLIC'), privilege.privilege_type,
       privilege.is_grantable), '')) as acl_hash
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     cross join lateral aclexplode(coalesce(relation.relacl,
       acldefault(case relation.relkind when 'S' then 'S'::"char" else 'r'::"char" end, relation.relowner))) privilege
     left join pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'S')
       and (privilege.grantee = 0 or grantee.rolname in ('core_agent_app', 'core_agent_identity'))`,
  );
  if (acl.rows[0]?.acl_hash !== "8736605e8eea0f9d4b892d95391cd8f5") {
    throw new Error("schema 10 manifest validation failed: ACL");
  }
}

schemaManifests.set(10, {
  ...schemaManifests.get(10)!,
  relations: schema10Tables,
  sequences: [],
  validateAndConverge: convergeSchema10Acls,
});

async function validateRegisteredCatalog(
  client: import("pg").PoolClient,
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
): Promise<void> {
  if (throughVersion < 10) return;
  const expectedRelations = [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.relations ?? [])
    .sort();
  const expectedSequences = [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.sequences ?? [])
    .sort();
  const relations = (await client.query<{ name: string }>(
    `select relation.relname as name from pg_class relation
     where relation.relnamespace = 'public'::regnamespace and relation.relkind in ('r', 'p')
     order by relation.relname`,
  )).rows.map((row) => row.name);
  const sequences = (await client.query<{ name: string }>(
    `select relation.relname as name from pg_class relation
     where relation.relnamespace = 'public'::regnamespace and relation.relkind = 'S'
     order by relation.relname`,
  )).rows.map((row) => row.name);
  if (JSON.stringify(relations) !== JSON.stringify(expectedRelations)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: relation catalog`);
  }
  if (JSON.stringify(sequences) !== JSON.stringify(expectedSequences)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: sequence catalog`);
  }
}

const migrationFilePattern = /^(?<version>[0-9]{3,})_(?<name>[a-z0-9][a-z0-9_-]*)\.sql$/;

async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map(async (entry) => {
      const match = migrationFilePattern.exec(entry.name);
      if (match?.groups === undefined) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }
      const { version, name } = match.groups;
      if (version === undefined || name === undefined) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }
      const sql = await readFile(join(directory, entry.name), "utf8");
      return {
        version: Number(version),
        name,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }));

  migrations.sort((left, right) => left.version - right.version);
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]?.version === migrations[index]?.version) {
      throw new Error(`Duplicate migration version: ${migrations[index]?.version}`);
    }
  }
  return migrations;
}

async function applyMigrationsWithManifests(
  pool: Pool,
  directory: string,
  manifests: ReadonlyMap<number, SchemaManifest>,
): Promise<void> {
  const migrations = await readMigrations(directory);
  for (const migration of migrations) {
    const manifest = manifests.get(migration.version);
    if (manifest === undefined) throw new Error(`no binary-owned schema manifest for migration ${migration.version}`);
    if (manifest.name !== migration.name || manifest.checksum !== migration.checksum) {
      throw new Error(`migration ${migration.version} checksum does not match its binary-owned schema manifest`);
    }
  }
  const maximumVersion = Math.max(...manifests.keys());
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query("select pg_advisory_lock(hashtext('core-agent-schema-migrations'))");
    locked = true;
    const table = await client.query<{ table_name: string | null }>(
      "select to_regclass('public.core_agent_schema_migrations')::text as table_name",
    );
    const applied = table.rows[0]?.table_name === null
      ? new Map<number, { name: string; checksum: string }>()
      : new Map((await client.query<{ version: number; name: string; checksum: string }>(
        "select version, name, checksum from core_agent_schema_migrations order by version",
      )).rows.map((row) => [row.version, row]));
    const recordedVersions = [...applied.keys()];
    if (recordedVersions.some((version) => version > maximumVersion)) {
      throw new Error("database schema is newer than this binary");
    }

    for (const migration of migrations) {
      const recorded = applied.get(migration.version);
      if (recorded !== undefined) {
        if (recorded.name !== migration.name || recorded.checksum !== migration.checksum) {
          throw new Error(`Applied migration checksum mismatch for version ${migration.version}`);
        }
        continue;
      }

      await client.query("begin");
      try {
        await client.query(migration.sql);
        await manifests.get(migration.version)?.validateAndConverge?.(client, maximumVersion);
        if (migration.version === maximumVersion) {
          await validateRegisteredCatalog(client, manifests, migration.version);
        }
        await client.query(
          "insert into core_agent_schema_migrations (version, name, checksum, applied_at) values ($1, $2, $3, now())",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("commit");
        applied.set(migration.version, { name: migration.name, checksum: migration.checksum });
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    if (applied.has(10)) {
      await client.query("begin");
      try {
        for (const version of [...applied.keys()].sort((left, right) => left - right)) {
          await manifests.get(version)?.validateAndConverge?.(client, maximumVersion);
        }
        await validateRegisteredCatalog(client, manifests, Math.max(...applied.keys()));
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        if (error instanceof Error && (
          error.message.startsWith("schema 10 ACL convergence failed:")
          || error.message.startsWith("schema 10 manifest validation failed:")
        )) throw error;
        throw new Error("schema 10 ACL convergence failed");
      }
    }
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtext('core-agent-schema-migrations'))");
    client.release();
  }
}

export async function applyMigrations(pool: Pool, directory: string): Promise<void> {
  await applyMigrationsWithManifests(pool, directory, schemaManifests);
}

export const migrationTestInternals = Object.freeze({ applyMigrationsWithManifests, schemaManifests });
