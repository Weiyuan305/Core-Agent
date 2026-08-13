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
  readonly columns?: readonly (readonly [relation: string, name: string, type: string, notNull: boolean, defaultExpression: string])[];
  readonly constraints?: readonly (readonly [relation: string, name: string, type: string, validated: boolean, definition: string])[];
  readonly indexes?: readonly (readonly [relation: string, name: string, definition: string])[];
  readonly name: string;
  readonly relations?: readonly string[];
  readonly routines?: readonly (readonly [kind: string, name: string, arguments: string, result: string, securityDefiner: boolean, config: readonly string[], definitionHash: string])[];
  readonly views?: readonly string[];
  readonly sequences?: readonly string[];
  readonly triggers?: readonly (readonly [relation: string, name: string, enabled: string, definition: string])[];
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

schemaManifests.set(1, { ...schemaManifests.get(1)!, relations: [
  "agent_runs", "actors", "conversations", "core_agent_schema_migrations", "memberships", "messages",
  "profiles", "runtime_containers", "secret_references", "sessions", "tenants",
] });
schemaManifests.set(2, { ...schemaManifests.get(2)!, relations: ["idempotency_records", "outbox", "worker_jobs"] });
schemaManifests.set(3, { ...schemaManifests.get(3)!, relations: ["audit_events", "product_events", "stream_cursors", "stream_sequences"] });

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

const schema10Triggers = [
  ["core_sessions", "core_sessions_revoked_deletion_check", "O",
    "CREATE TRIGGER core_sessions_revoked_deletion_check BEFORE DELETE ON core_sessions FOR EACH ROW EXECUTE FUNCTION enforce_core_session_revoked_deletion()"],
  ["memberships", "memberships_ordinary_actor_authority_check", "O",
    "CREATE CONSTRAINT TRIGGER memberships_ordinary_actor_authority_check AFTER INSERT OR UPDATE OF actor_id, membership_source, status ON memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.membership_source <> 'platform'::text AND (new.status = ANY (ARRAY['active'::text, 'invited'::text]))) EXECUTE FUNCTION enforce_ordinary_membership_actor_authority()"],
  ["worker_jobs", "worker_jobs_identity_job_kind_check", "O",
    "CREATE TRIGGER worker_jobs_identity_job_kind_check BEFORE INSERT ON worker_jobs FOR EACH ROW EXECUTE FUNCTION enforce_identity_worker_job_kind()"],
] as const;

const schema10Routines = [
  ["f", "enforce_core_session_revoked_deletion", "", "trigger", false, ["search_path=pg_catalog, public"], "42880212e8574d7c72e6890101e936a9"],
  ["f", "enforce_identity_worker_job_kind", "", "trigger", false, ["search_path=pg_catalog, public"], "8b1134035bc62e57f81d5b96fa36e5e6"],
  ["f", "enforce_ordinary_membership_actor_authority", "", "trigger", false, ["search_path=pg_catalog, public"], "a19d30d4b4882b906aabeea0f680d0cd"],
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
       and trigger.tgname = any($1::text[])
     order by trigger.tgname`,
    [schema10Triggers.map((entry) => entry[1])],
  );
  if (triggers.rows.length !== schema10Triggers.length || triggers.rows.some((row, index) =>
    row.enabled !== "O"
    || row.trigger_name !== schema10Triggers[index]?.[1]
    || row.function_name !== schema10Routines.find((entry) => row.definition.endsWith(`${entry[1]}()`))?.[1]
    || row.definition !== schema10Triggers[index]?.[3])) {
    throw new Error("schema 10 manifest validation failed: trigger");
  }
  for (const [, functionName] of schema10Routines) {
    await client.query(`alter function ${functionName}() set search_path = pg_catalog, public`);
    await client.query(`revoke all on function ${functionName}() from public, core_agent_app, core_agent_identity`);
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
    [schema10Routines.map((entry) => entry[1])],
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
       (select md5(string_agg(format('%s|%s|%s|%s|%s', catalog_constraint.conrelid::regclass::text,
          catalog_constraint.conname, catalog_constraint.contype, catalog_constraint.convalidated,
          pg_get_constraintdef(catalog_constraint.oid, true)), E'\\n'
          order by catalog_constraint.conrelid::regclass::text, catalog_constraint.conname))
        from pg_constraint catalog_constraint
        where catalog_constraint.connamespace = 'public'::regnamespace
          and catalog_constraint.conrelid::regclass::text = any($1::text[])
          ) as constraint_hash,
       (select md5(string_agg(format('%s|%s|%s', indexes.tablename, indexes.indexname, indexes.indexdef), E'\\n'
          order by indexes.tablename, indexes.indexname))
        from pg_indexes indexes
        where indexes.schemaname = 'public' and indexes.tablename = any($1::text[])) as index_hash`,
    [schema10Tables],
  );
  if (shape.rows[0]?.column_hash !== "26c38a64c8f7a6473cfd916bf896a2be") {
    throw new Error("schema 10 manifest validation failed: column");
  }
  if (shape.rows[0]?.constraint_hash !== "3c16529462719fc465cb21215eba4569") {
    throw new Error("schema 10 manifest validation failed: constraint");
  }
  if (shape.rows[0]?.index_hash !== "e35bb22408d7b171971cf0cd4aa4b5f5") {
    throw new Error("schema 10 manifest validation failed: index");
  }
  const definitions = await client.query<{ definition_hash: string; name: string }>(
    `select proname as name, md5(pg_get_functiondef(oid)) as definition_hash
     from pg_proc
     where pronamespace = 'public'::regnamespace and proname = any($1::text[])
     order by proname`,
    [schema10Routines.map((entry) => entry[1])],
  );
  if (definitions.rows.length !== schema10Routines.length || definitions.rows.some((row, index) =>
    row.name !== schema10Routines[index]?.[1] || row.definition_hash !== schema10Routines[index]?.[6])) {
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
  if (sequences.rows.filter((row) => schemaManifests.get(10)?.sequences?.includes(row.sequence_name)).some((row) => !row.owner_matches)) {
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
       and relation.relname = any($1::text[]) and privilege.grantee <> relation.relowner`,
    [schema10Tables],
  );
  if (acl.rows[0]?.acl_hash !== "8736605e8eea0f9d4b892d95391cd8f5") {
    throw new Error("schema 10 manifest validation failed: ACL");
  }
}

schemaManifests.set(10, {
  ...schemaManifests.get(10)!,
  relations: [
    "account_deletions", "auth_subjects", "core_sessions", "identity_invitations", "oauth_transactions",
    "platform_role_assignments", "private_identity_pii", "public_rate_limits",
  ],
  sequences: [],
  triggers: schema10Triggers,
  routines: schema10Routines,
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
  const expectedViews = [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.views ?? [])
    .sort();
  const relationsResult = await client.query<{ name: string; owner_matches: boolean }>(
    `select relation.relname as name, owner.rolname = current_user as owner_matches
     from pg_class relation join pg_roles owner on owner.oid = relation.relowner
     where relation.relnamespace = 'public'::regnamespace and relation.relkind in ('r', 'p')
     order by relation.relname`,
  );
  const relations = relationsResult.rows.map((row) => row.name);
  const sequencesResult = await client.query<{ name: string; owner_matches: boolean }>(
    `select relation.relname as name, owner.rolname = current_user as owner_matches
     from pg_class relation join pg_roles owner on owner.oid = relation.relowner
     where relation.relnamespace = 'public'::regnamespace and relation.relkind = 'S'
     order by relation.relname`,
  );
  const sequences = sequencesResult.rows.map((row) => row.name);
  const viewsResult = await client.query<{ name: string; owner_matches: boolean }>(
    `select relation.relname as name, owner.rolname = current_user as owner_matches
     from pg_class relation join pg_roles owner on owner.oid = relation.relowner
     where relation.relnamespace = 'public'::regnamespace and relation.relkind in ('v', 'm')
     order by relation.relname`,
  );
  const views = viewsResult.rows.map((row) => row.name);
  if ([...relationsResult.rows, ...sequencesResult.rows, ...viewsResult.rows].some((row) => !row.owner_matches)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: relation owner`);
  }
  if (JSON.stringify(relations) !== JSON.stringify(expectedRelations)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: relation catalog`);
  }
  if (JSON.stringify(sequences) !== JSON.stringify(expectedSequences)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: sequence catalog`);
  }
  if (JSON.stringify(views) !== JSON.stringify(expectedViews)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: view catalog`);
  }
  if (throughVersion < 10) return;

  const expectedTriggers = [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.triggers ?? [])
    .sort((left, right) => `${left[0]}|${left[1]}`.localeCompare(`${right[0]}|${right[1]}`));
  const actualTriggers = (await client.query<{ definition: string; enabled: string; name: string; relation: string }>(
    `select trigger.tgrelid::regclass::text as relation, trigger.tgname as name,
            trigger.tgenabled as enabled, pg_get_triggerdef(trigger.oid, true) as definition
     from pg_trigger trigger
     where trigger.tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
       and not trigger.tgisinternal
     order by trigger.tgrelid::regclass::text, trigger.tgname`,
  )).rows.map((row) => [row.relation, row.name, row.enabled, row.definition] as const);
  if (JSON.stringify(actualTriggers) !== JSON.stringify(expectedTriggers)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: trigger catalog`);
  }

  const expectedRoutines = [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.routines ?? [])
    .sort((left, right) => `${left[1]}|${left[2]}`.localeCompare(`${right[1]}|${right[2]}`));
  const actualRoutines = (await client.query<{
    arguments: string; config: string[] | null; definition_hash: string; kind: string; name: string;
    owner_matches: boolean; result: string; security_definer: boolean;
  }>(
    `select routine.prokind as kind, routine.proname as name,
            pg_get_function_identity_arguments(routine.oid) as arguments,
            pg_get_function_result(routine.oid) as result,
            owner.rolname = current_user as owner_matches,
            routine.prosecdef as security_definer, routine.proconfig as config,
            md5(pg_get_functiondef(routine.oid)) as definition_hash
     from pg_proc routine join pg_roles owner on owner.oid = routine.proowner
     where routine.pronamespace = 'public'::regnamespace
     order by routine.proname, pg_get_function_identity_arguments(routine.oid)`,
  )).rows;
  const normalizedRoutines = actualRoutines.map((row) => [
    row.kind, row.name, row.arguments, row.result, row.security_definer, row.config ?? [], row.definition_hash,
  ] as const);
  if (actualRoutines.some((row) => !row.owner_matches)
    || JSON.stringify(normalizedRoutines) !== JSON.stringify(expectedRoutines)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: routine catalog`);
  }
  const routineGrants = await client.query(
    `select 1 from pg_proc routine
     cross join lateral aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
     where routine.pronamespace = 'public'::regnamespace and privilege.grantee <> routine.proowner
     limit 1`,
  );
  if (routineGrants.rowCount !== 0) {
    throw new Error(`schema ${throughVersion} manifest validation failed: routine ACL`);
  }

  const futureRelations = [...manifests.values()]
    .filter((manifest) => manifest.version > 10 && manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.relations ?? [])
    .sort();
  const expectedColumns = [...manifests.values()]
    .filter((manifest) => manifest.version > 10 && manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.columns ?? [])
    .sort((left, right) => `${left[0]}|${left[1]}`.localeCompare(`${right[0]}|${right[1]}`));
  const actualColumns = futureRelations.length === 0 ? [] : (await client.query<{
    default_expression: string; name: string; not_null: boolean; relation: string; type: string;
  }>(
    `select relation.relname as relation, attribute.attname as name,
            format_type(attribute.atttypid, attribute.atttypmod) as type,
            attribute.attnotnull as not_null,
            coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') as default_expression
     from pg_class relation join pg_attribute attribute on attribute.attrelid = relation.oid
       and attribute.attnum > 0 and not attribute.attisdropped
     left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
     where relation.relnamespace = 'public'::regnamespace and relation.relname = any($1::text[])
     order by relation.relname, attribute.attnum`,
    [futureRelations],
  )).rows.map((row) => [row.relation, row.name, row.type, row.not_null, row.default_expression] as const);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: column catalog`);
  }
  const expectedConstraints = [...manifests.values()]
    .filter((manifest) => manifest.version > 10 && manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.constraints ?? [])
    .sort((left, right) => `${left[0]}|${left[1]}`.localeCompare(`${right[0]}|${right[1]}`));
  const actualConstraints = futureRelations.length === 0 ? [] : (await client.query<{
    definition: string; name: string; relation: string; type: string; validated: boolean;
  }>(
    `select catalog_constraint.conrelid::regclass::text as relation, catalog_constraint.conname as name,
            catalog_constraint.contype as type, catalog_constraint.convalidated as validated,
            pg_get_constraintdef(catalog_constraint.oid, true) as definition
     from pg_constraint catalog_constraint
     where catalog_constraint.connamespace = 'public'::regnamespace
       and catalog_constraint.conrelid::regclass::text = any($1::text[])
     order by catalog_constraint.conrelid::regclass::text, catalog_constraint.conname`,
    [futureRelations],
  )).rows.map((row) => [row.relation, row.name, row.type, row.validated, row.definition] as const);
  if (JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: constraint catalog`);
  }
  const expectedIndexes = [...manifests.values()]
    .filter((manifest) => manifest.version > 10 && manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.indexes ?? [])
    .sort((left, right) => `${left[0]}|${left[1]}`.localeCompare(`${right[0]}|${right[1]}`));
  const actualIndexes = futureRelations.length === 0 ? [] : (await client.query<{ definition: string; name: string; relation: string }>(
    `select tablename as relation, indexname as name, indexdef as definition
     from pg_indexes where schemaname = 'public' and tablename = any($1::text[])
     order by tablename, indexname`,
    [futureRelations],
  )).rows.map((row) => [row.relation, row.name, row.definition] as const);
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: index catalog`);
  }
  const futureAclObjects = [...futureRelations,
    ...[...manifests.values()].filter((manifest) => manifest.version > 10 && manifest.version <= throughVersion)
      .flatMap((manifest) => [...(manifest.views ?? []), ...(manifest.sequences ?? [])])];
  if (futureAclObjects.length > 0) {
    const unexpectedAcl = await client.query(
      `select 1 from pg_class relation
       cross join lateral aclexplode(coalesce(relation.relacl,
         acldefault(case relation.relkind when 'S' then 'S'::"char" else 'r'::"char" end, relation.relowner))) privilege
       where relation.relnamespace = 'public'::regnamespace and relation.relname = any($1::text[])
         and privilege.grantee <> relation.relowner
       limit 1`,
      [futureAclObjects],
    );
    if (unexpectedAcl.rowCount !== 0) {
      throw new Error(`schema ${throughVersion} manifest validation failed: relation ACL`);
    }
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
  const manifestEntries = [...manifests.entries()];
  if (migrations.length === 0 || manifestEntries.length !== migrations.length) {
    throw new Error("migration manifest inventory is not an exact bijection");
  }
  for (const [index, migration] of migrations.entries()) {
    const manifestEntry = manifestEntries[index];
    const manifest = manifestEntry?.[1];
    if (migration.version !== index + 1 || manifestEntry?.[0] !== migration.version || manifest?.version !== migration.version) {
      throw new Error("migration manifest inventory is not ordered and contiguous");
    }
    if (manifest.name !== migration.name || manifest.checksum !== migration.checksum) {
      throw new Error("migration manifest inventory name or checksum mismatch");
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
    if (recordedVersions.length > 0) {
      const recordedMaximum = Math.max(...recordedVersions);
      const expectedRecorded = Array.from({ length: recordedMaximum }, (_, index) => index + 1);
      if (JSON.stringify(recordedVersions) !== JSON.stringify(expectedRecorded)) {
        throw new Error("database schema history is not contiguous");
      }
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
        await validateRegisteredCatalog(client, manifests, migration.version);
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
    if (applied.size > 0) {
      await client.query("begin");
      try {
        for (const version of [...applied.keys()].sort((left, right) => left - right)) {
          await manifests.get(version)?.validateAndConverge?.(client, maximumVersion);
        }
        const currentVersion = Math.max(...applied.keys());
        if (currentVersion !== maximumVersion) throw new Error("database schema is below this binary");
        await validateRegisteredCatalog(client, manifests, currentVersion);
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
