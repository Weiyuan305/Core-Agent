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

type RelationKind = "r" | "p" | "v" | "m" | "S";
type AclDisposition = "grant" | "revoke";
type RelationManifestEntry = readonly [schema: "public", name: string, kind: RelationKind, owner: "current_user"];
type RelationAclManifestEntry = readonly [
  disposition: AclDisposition, schema: "public", name: string, kind: RelationKind,
  grantee: string, privilege: string, grantable: boolean,
];
type RoutineAclManifestEntry = readonly [
  disposition: AclDisposition, schema: "public", name: string, kind: "f" | "p", arguments: string,
  grantee: string, privilege: "EXECUTE", grantable: boolean,
];

type ColumnShape = Readonly<{
  schema: "public";
  relation: string;
  relkind: Exclude<RelationKind, "S">;
  name: string;
  position: number;
  type: string;
  notNull: boolean;
  defaultExpression: string;
  collation: string;
  identity: string;
  generated: string;
}>;

type RelationSemanticShape = Readonly<{
  schema: "public";
  name: string;
  relkind: RelationKind;
  definition: string;
  partitionKey: string;
  parent: string;
  bound: string;
  dataType: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
}>;
type ConstraintShape = Readonly<{
  schema: "public";
  relation: string;
  relkind: "r" | "p";
  name: string;
  type: string;
  validated: boolean;
  definition: string;
}>;
type IndexShape = Readonly<{
  schema: "public";
  relation: string;
  relkind: "r" | "p" | "m";
  name: string;
  definition: string;
}>;
type ShapeAmendment<T> = Readonly<{
  action: "add" | "replace" | "revoke";
  before?: T;
  after?: T;
}>;
type LegacyColumnShape = readonly [relation: string, name: string, type: string, notNull: boolean, defaultExpression: string];
type LegacyConstraintShape = readonly [relation: string, name: string, type: string, validated: boolean, definition: string];
type LegacyIndexShape = readonly [relation: string, name: string, definition: string];

interface SchemaManifest {
  readonly checksum: string;
  readonly columns?: readonly (ColumnShape | LegacyColumnShape)[];
  readonly columnAmendments?: readonly ShapeAmendment<ColumnShape>[];
  readonly constraints?: readonly (ConstraintShape | LegacyConstraintShape)[];
  readonly constraintAmendments?: readonly ShapeAmendment<ConstraintShape>[];
  readonly indexes?: readonly (IndexShape | LegacyIndexShape)[];
  readonly indexAmendments?: readonly ShapeAmendment<IndexShape>[];
  readonly relationSemantics?: readonly RelationSemanticShape[];
  readonly relationSemanticAmendments?: readonly ShapeAmendment<RelationSemanticShape>[];
  readonly name: string;
  readonly objects?: readonly RelationManifestEntry[];
  readonly relationAcls?: readonly RelationAclManifestEntry[];
  readonly routines?: readonly (readonly [kind: string, name: string, arguments: string, result: string, securityDefiner: boolean, config: readonly string[], definitionHash: string])[];
  readonly routineAcls?: readonly RoutineAclManifestEntry[];
  readonly triggers?: readonly (readonly [relation: string, name: string, enabled: string, definition: string])[];
  readonly validateAndConverge?: (
    client: import("pg").PoolClient,
    maximumVersion: number,
    manifests: ReadonlyMap<number, SchemaManifest>,
    throughVersion: number,
  ) => Promise<void>;
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
  [11, "password_reset_transactions", "fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393"],
  [12, "email_verification_transactions", "42a2120802daa43b19f842e638e310c4285d927bc292186d996ff61af3d83767"],
] as const;

const schemaManifests = new Map<number, SchemaManifest>(schemaManifestEntries.map(([version, name, checksum]) => [
  version, { version, name, checksum },
]));

const ownedTables = (names: readonly string[]): readonly RelationManifestEntry[] =>
  names.map((name) => ["public", name, "r", "current_user"] as const);

schemaManifests.set(1, { ...schemaManifests.get(1)!, objects: ownedTables([
  "agent_runs", "actors", "conversations", "core_agent_schema_migrations", "memberships", "messages",
  "profiles", "runtime_containers", "secret_references", "sessions", "tenants",
]) });
schemaManifests.set(2, { ...schemaManifests.get(2)!, objects: ownedTables(["idempotency_records", "outbox", "worker_jobs"]) });
schemaManifests.set(3, { ...schemaManifests.get(3)!, objects: ownedTables(["audit_events", "product_events", "stream_cursors", "stream_sequences"]) });

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

const relationPrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const schema10RelationAclGrantCandidates: RelationAclManifestEntry[] = [
  ...applicationTables.flatMap((table) => relationPrivileges.slice(0, 4).map((privilege) =>
    ["grant", "public", table, "r", "core_agent_app", privilege, false] as const)),
  ["grant", "public", "core_agent_schema_migrations", "r", "core_agent_app", "SELECT", false],
  ...identityGrants.flatMap(([privileges, tables]) => tables.split(", ").flatMap((table) =>
    privileges.split(", ").map((privilege) =>
      ["grant", "public", table, "r", "core_agent_identity", privilege, false] as const))),
];
const schema10RelationAclGrants = [...new Map(schema10RelationAclGrantCandidates.map((entry) =>
  [entry.slice(1).join("|"), entry])).values()];
const schema10RelationGrantKeys = new Set(schema10RelationAclGrants.map((entry) => entry.slice(1).join("|")));
const schema10RelationAcls: readonly RelationAclManifestEntry[] = [
  ...schema10RelationAclGrants,
  ...schema10Tables.flatMap((table) => ["PUBLIC", "core_agent_app", "core_agent_identity"].flatMap((grantee) =>
    relationPrivileges.flatMap((privilege) => {
      const rule = ["revoke", "public", table, "r", grantee, privilege, false] as const;
      return schema10RelationGrantKeys.has(rule.slice(1).join("|")) ? [] : [rule];
    }))),
];

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

async function convergeSchema10Acls(
  client: import("pg").PoolClient,
  maximumVersion = 10,
  manifests: ReadonlyMap<number, SchemaManifest> = schemaManifests,
  throughVersion = maximumVersion,
): Promise<void> {
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
  await validateSchema10BaseShape(client, manifests, throughVersion);
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
  if (sequences.rows.filter((row) => schemaManifests.get(10)?.objects?.some((entry) => entry[2] === "S" && entry[1] === row.sequence_name)).some((row) => !row.owner_matches)) {
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

const oauthFlowKindConstraintBase: ConstraintShape = {
  schema: "public",
  relation: "oauth_transactions",
  relkind: "r",
  name: "oauth_transactions_flow_kind_check",
  type: "c",
  validated: true,
  definition: "CHECK (flow_kind = ANY (ARRAY['apple_sign_in'::text, 'apple_link'::text]))",
};

const publicRateLimitBucketConstraintBase: ConstraintShape = {
  schema: "public",
  relation: "public_rate_limits",
  relkind: "r",
  name: "public_rate_limits_bucket_kind_check",
  type: "c",
  validated: true,
  definition: "CHECK (bucket_kind = ANY (ARRAY['signup'::text, 'login'::text, 'reset'::text, 'apple_callback'::text, 'invitation_accept'::text, 'reauthenticate'::text]))",
};

const authSubjectProviderIdentityKindConstraintBase: ConstraintShape = {
  schema: "public", relation: "auth_subjects", relkind: "r",
  name: "auth_subjects_provider_identity_kind_check", type: "c", validated: true,
  definition: "CHECK (provider_identity_kind = ANY (ARRAY['email_password'::text, 'apple'::text]))",
};

schemaManifests.set(10, {
  ...schemaManifests.get(10)!,
  objects: ownedTables([
    "account_deletions", "auth_subjects", "core_sessions", "identity_invitations", "oauth_transactions",
    "platform_role_assignments", "private_identity_pii", "public_rate_limits",
  ]),
  relationAcls: schema10RelationAcls,
  triggers: schema10Triggers,
  routines: schema10Routines,
  routineAcls: schema10Routines.flatMap(([kind, name]) => ["PUBLIC", "core_agent_app", "core_agent_identity"].map((grantee) =>
    ["revoke", "public", name, kind, "", grantee, "EXECUTE", false] as const)),
  constraints: [oauthFlowKindConstraintBase, publicRateLimitBucketConstraintBase, authSubjectProviderIdentityKindConstraintBase],
  validateAndConverge: convergeSchema10Acls,
});

schemaManifests.set(11, {
  ...schemaManifests.get(11)!,
  constraintAmendments: [{
    action: "replace",
    before: oauthFlowKindConstraintBase,
    after: {
      ...oauthFlowKindConstraintBase,
      definition: "CHECK (flow_kind = ANY (ARRAY['apple_sign_in'::text, 'apple_link'::text, 'password_reset'::text]))",
    },
  }],
});

const schema12Table = "email_verification_transactions";
const schema12IdentityGrants = ["SELECT", "INSERT", "UPDATE"] as const;
const schema12RelationAcls: readonly RelationAclManifestEntry[] = [
  ...schema12IdentityGrants.map((privilege) =>
    ["grant", "public", schema12Table, "r", "core_agent_identity", privilege, false] as const),
];

schemaManifests.set(12, {
  ...schemaManifests.get(12)!,
  objects: ownedTables([schema12Table]),
  columns: [
    [schema12Table, "email_verification_transaction_id", "text", true, ""],
    [schema12Table, "start_idempotency_key", "text", true, ""],
    [schema12Table, "start_payload_hash", "text", true, ""],
    [schema12Table, "normalized_email_hmac", "bytea", true, ""],
    [schema12Table, "binding_ciphertext", "bytea", true, ""],
    [schema12Table, "expected_provider_subject_hmac", "bytea", false, ""],
    [schema12Table, "expected_provider_subject_ciphertext", "bytea", false, ""],
    [schema12Table, "verified_provider_subject_hmac", "bytea", false, ""],
    [schema12Table, "verified_subject_ciphertext", "bytea", false, ""],
    [schema12Table, "provider_verification_status", "text", true, "'pending'::text"],
    [schema12Table, "provider_verification_started_at", "timestamp with time zone", false, ""],
    [schema12Table, "provider_verification_attempt_expires_at", "timestamp with time zone", false, ""],
    [schema12Table, "provider_verification_proof_hmac", "bytea", false, ""],
    [schema12Table, "provider_verification_attempt_count", "integer", true, "0"],
    [schema12Table, "provider_verified_at", "timestamp with time zone", false, ""],
    [schema12Table, "provider_start_status", "text", true, ""],
    [schema12Table, "provider_start_attempt", "integer", true, "1"],
    [schema12Table, "provider_start_finalized_at", "timestamp with time zone", false, ""],
    [schema12Table, "provider_start_failed_at", "timestamp with time zone", false, ""],
    [schema12Table, "status", "text", true, ""],
    [schema12Table, "expires_at", "timestamp with time zone", true, ""],
    [schema12Table, "consumed_at", "timestamp with time zone", false, ""],
    [schema12Table, "created_at", "timestamp with time zone", true, ""],
    [schema12Table, "updated_at", "timestamp with time zone", true, ""],
  ],
  constraints: [
    [schema12Table, "email_verification_transacti_email_verification_transacti_check", "c", true, "CHECK (char_length(email_verification_transaction_id) >= 1 AND char_length(email_verification_transaction_id) <= 255)"],
    [schema12Table, "email_verification_transacti_expected_provider_subject_ci_check", "c", true, "CHECK (expected_provider_subject_ciphertext IS NULL OR octet_length(expected_provider_subject_ciphertext) >= 33 AND octet_length(expected_provider_subject_ciphertext) <= 65536)"],
    [schema12Table, "email_verification_transacti_expected_provider_subject_hm_check", "c", true, "CHECK (expected_provider_subject_hmac IS NULL OR octet_length(expected_provider_subject_hmac) = 32)"],
    [schema12Table, "email_verification_transacti_provider_verification_status_check", "c", true, "CHECK (provider_verification_status = ANY (ARRAY['pending'::text, 'verified'::text]))"],
    [schema12Table, "email_verification_transacti_provider_verification_proof__check", "c", true, "CHECK (provider_verification_proof_hmac IS NULL OR octet_length(provider_verification_proof_hmac) = 32)"],
    [schema12Table, "email_verification_provider_verification_attempt_count_check", "c", true, "CHECK (provider_verification_attempt_count >= 0 AND provider_verification_attempt_count <= 5)"],
    [schema12Table, "email_verification_transacti_verified_provider_subject_hm_check", "c", true, "CHECK (verified_provider_subject_hmac IS NULL OR octet_length(verified_provider_subject_hmac) = 32)"],
    [schema12Table, "email_verification_transactio_verified_subject_ciphertext_check", "c", true, "CHECK (verified_subject_ciphertext IS NULL OR octet_length(verified_subject_ciphertext) >= 33 AND octet_length(verified_subject_ciphertext) <= 65536)"],
    [schema12Table, "email_verification_provider_start_attempt_check", "c", true, "CHECK (provider_start_attempt >= 1 AND provider_start_attempt <= 100)"],
    [schema12Table, "email_verification_provider_start_state_check", "c", true, "CHECK (provider_start_status = 'reserved'::text AND provider_start_finalized_at IS NULL AND provider_start_failed_at IS NULL AND expected_provider_subject_hmac IS NULL AND expected_provider_subject_ciphertext IS NULL OR provider_start_status = 'finalized'::text AND provider_start_finalized_at IS NOT NULL AND provider_start_failed_at IS NULL AND expected_provider_subject_hmac IS NOT NULL AND expected_provider_subject_ciphertext IS NOT NULL OR provider_start_status = 'failed'::text AND provider_start_finalized_at IS NULL AND provider_start_failed_at IS NOT NULL AND expected_provider_subject_hmac IS NULL AND expected_provider_subject_ciphertext IS NULL)"],
    [schema12Table, "email_verification_provider_start_status_check", "c", true, "CHECK (provider_start_status = ANY (ARRAY['reserved'::text, 'finalized'::text, 'failed'::text]))"],
    [schema12Table, "email_verification_provider_verification_state_check", "c", true, "CHECK (provider_verification_status = 'pending'::text AND verified_provider_subject_hmac IS NULL AND verified_subject_ciphertext IS NULL AND provider_verified_at IS NULL AND (provider_verification_started_at IS NULL AND provider_verification_attempt_expires_at IS NULL AND provider_verification_proof_hmac IS NULL OR provider_verification_started_at IS NOT NULL AND provider_verification_attempt_expires_at IS NOT NULL AND provider_verification_proof_hmac IS NOT NULL AND provider_verification_attempt_expires_at > provider_verification_started_at AND provider_verification_attempt_expires_at <= expires_at) OR provider_verification_status = 'verified'::text AND verified_provider_subject_hmac IS NOT NULL AND verified_subject_ciphertext IS NOT NULL AND provider_verified_at IS NOT NULL AND provider_verification_started_at IS NOT NULL AND provider_verification_attempt_expires_at IS NOT NULL AND provider_verification_proof_hmac IS NOT NULL AND provider_verification_attempt_expires_at > provider_verification_started_at AND provider_verification_attempt_expires_at <= expires_at AND provider_verified_at >= provider_verification_started_at)"],
    [schema12Table, "email_verification_transactions_binding_ciphertext_check", "c", true, "CHECK (octet_length(binding_ciphertext) >= 33 AND octet_length(binding_ciphertext) <= 65536)"],
    [schema12Table, "email_verification_transactions_check", "c", true, "CHECK (expires_at > created_at)"],
    [schema12Table, "email_verification_transactions_check1", "c", true, "CHECK (status <> 'consumed'::text OR provider_verification_status = 'verified'::text)"],
    [schema12Table, "email_verification_transactions_check2", "c", true, "CHECK ((status = 'consumed'::text) = (consumed_at IS NOT NULL))"],
    [schema12Table, "email_verification_transactions_check3", "c", true, "CHECK (updated_at >= created_at)"],
    [schema12Table, "email_verification_transactions_normalized_email_hmac_check", "c", true, "CHECK (octet_length(normalized_email_hmac) = 32)"],
    [schema12Table, "email_verification_transactions_pkey", "p", true, "PRIMARY KEY (email_verification_transaction_id)"],
    [schema12Table, "email_verification_transactions_start_idempotency_key_check", "c", true, "CHECK (char_length(start_idempotency_key) >= 1 AND char_length(start_idempotency_key) <= 255)"],
    [schema12Table, "email_verification_transactions_start_idempotency_key_key", "u", true, "UNIQUE (start_idempotency_key)"],
    [schema12Table, "email_verification_transactions_start_payload_hash_check", "c", true, "CHECK (start_payload_hash ~ '^sha256:[a-f0-9]{64}$'::text)"],
    [schema12Table, "email_verification_transactions_status_check", "c", true, "CHECK (status = ANY (ARRAY['pending'::text, 'consumed'::text, 'expired'::text]))"],
  ],
  indexes: [
    [schema12Table, "email_verification_transactions_pending_expiry_idx", "CREATE INDEX email_verification_transactions_pending_expiry_idx ON public.email_verification_transactions USING btree (expires_at, email_verification_transaction_id) WHERE (status = 'pending'::text)"],
    [schema12Table, "email_verification_transactions_pkey", "CREATE UNIQUE INDEX email_verification_transactions_pkey ON public.email_verification_transactions USING btree (email_verification_transaction_id)"],
    [schema12Table, "email_verification_transactions_start_idempotency_key_key", "CREATE UNIQUE INDEX email_verification_transactions_start_idempotency_key_key ON public.email_verification_transactions USING btree (start_idempotency_key)"],
  ],
  relationAcls: schema12RelationAcls,
  columnAmendments: [
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_completion_status", position: 15, type: "text", notNull: true, defaultExpression: "'pending'::text", collation: "pg_catalog.\"default\"", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_completion_started_at", position: 16, type: "timestamp with time zone", notNull: false, defaultExpression: "", collation: "", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "expected_provider_subject_ciphertext", position: 17, type: "bytea", notNull: false, defaultExpression: "", collation: "", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_subject_ciphertext", position: 18, type: "bytea", notNull: false, defaultExpression: "", collation: "", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_completion_payload_hash", position: 19, type: "text", notNull: false, defaultExpression: "", collation: "pg_catalog.\"default\"", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_settlement_expires_at", position: 20, type: "timestamp with time zone", notNull: false, defaultExpression: "", collation: "", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_completed_at", position: 21, type: "timestamp with time zone", notNull: false, defaultExpression: "", collation: "", identity: "", generated: "" } },
    { action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r", name: "provider_evidence_at", position: 22, type: "timestamp with time zone", notNull: false, defaultExpression: "", collation: "", identity: "", generated: "" } },
  ],
  constraintAmendments: [{
    action: "replace",
    before: publicRateLimitBucketConstraintBase,
    after: {
      ...publicRateLimitBucketConstraintBase,
      definition: "CHECK (bucket_kind = ANY (ARRAY['signup'::text, 'login'::text, 'reset'::text, 'email_verification'::text, 'reset_complete'::text, 'apple_start'::text, 'apple_link'::text, 'apple_callback'::text, 'invitation_accept'::text, 'reauthenticate'::text]))",
    },
  }, {
    action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r",
      name: "oauth_transactions_expected_provider_subject_ciphertext_check", type: "c", validated: true,
      definition: "CHECK (expected_provider_subject_ciphertext IS NULL OR octet_length(expected_provider_subject_ciphertext) >= 33 AND octet_length(expected_provider_subject_ciphertext) <= 65536)" },
  }, {
    action: "replace", before: authSubjectProviderIdentityKindConstraintBase,
    after: { ...authSubjectProviderIdentityKindConstraintBase,
      definition: "CHECK (provider_identity_kind = ANY (ARRAY['email_password'::text, 'apple'::text, 'email_password_apple'::text]))" },
  }, {
    action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r",
      name: "oauth_transactions_provider_subject_ciphertext_check", type: "c", validated: true,
      definition: "CHECK (provider_subject_ciphertext IS NULL OR octet_length(provider_subject_ciphertext) >= 33 AND octet_length(provider_subject_ciphertext) <= 65536)" },
  }, {
    action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r",
      name: "oauth_transactions_provider_completion_status_check", type: "c", validated: true,
      definition: "CHECK (provider_completion_status = ANY (ARRAY['pending'::text, 'provider_started'::text, 'provider_completed'::text]))" },
  }, {
    action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r",
      name: "oauth_transactions_provider_completion_payload_hash_check", type: "c", validated: true,
      definition: "CHECK (provider_completion_payload_hash IS NULL OR provider_completion_payload_hash ~ '^sha256:[0-9a-f]{64}$'::text)" },
  }, {
    action: "add", after: { schema: "public", relation: "oauth_transactions", relkind: "r",
      name: "oauth_transactions_provider_completion_state_check", type: "c", validated: true,
      definition: "CHECK (flow_kind <> 'password_reset'::text AND provider_completion_status = 'pending'::text AND provider_completion_started_at IS NULL AND expected_provider_subject_ciphertext IS NULL AND provider_subject_ciphertext IS NULL AND provider_completion_payload_hash IS NULL AND provider_settlement_expires_at IS NULL AND provider_completed_at IS NULL AND provider_evidence_at IS NULL OR flow_kind = 'password_reset'::text AND status = 'pending'::text AND provider_completion_status = 'pending'::text AND provider_completion_started_at IS NULL AND expected_provider_subject_ciphertext IS NOT NULL AND provider_subject_ciphertext IS NULL AND provider_completion_payload_hash IS NULL AND provider_settlement_expires_at IS NULL AND provider_completed_at IS NULL AND provider_evidence_at IS NULL OR flow_kind = 'password_reset'::text AND status = 'expired'::text AND provider_completion_status = 'pending'::text AND provider_completion_started_at IS NULL AND expected_provider_subject_ciphertext IS NULL AND provider_subject_ciphertext IS NULL AND provider_completion_payload_hash IS NULL AND provider_settlement_expires_at IS NULL AND provider_completed_at IS NULL AND provider_evidence_at IS NULL OR flow_kind = 'password_reset'::text AND status = 'consumed'::text AND provider_completion_status = 'pending'::text AND provider_completion_started_at IS NULL AND expected_provider_subject_ciphertext IS NULL AND provider_subject_ciphertext IS NULL AND provider_completion_payload_hash IS NULL AND provider_settlement_expires_at IS NULL AND provider_completed_at IS NULL AND provider_evidence_at IS NULL OR flow_kind = 'password_reset'::text AND status = 'pending'::text AND provider_completion_status = 'provider_started'::text AND provider_completion_started_at IS NOT NULL AND expected_provider_subject_ciphertext IS NOT NULL AND provider_subject_ciphertext IS NOT NULL AND provider_completion_payload_hash IS NOT NULL AND provider_settlement_expires_at = (provider_completion_started_at + '00:30:00'::interval) AND provider_completed_at IS NULL AND provider_evidence_at IS NULL OR flow_kind = 'password_reset'::text AND (status = ANY (ARRAY['pending'::text, 'consumed'::text])) AND provider_completion_status = 'provider_completed'::text AND provider_completion_started_at IS NOT NULL AND expected_provider_subject_ciphertext IS NOT NULL AND provider_subject_ciphertext IS NOT NULL AND provider_completion_payload_hash IS NOT NULL AND provider_settlement_expires_at = (provider_completion_started_at + '00:30:00'::interval) AND provider_completed_at IS NOT NULL AND provider_evidence_at IS NOT NULL AND provider_evidence_at >= provider_completion_started_at AND provider_evidence_at <= provider_completed_at AND provider_completed_at <= provider_settlement_expires_at)" },
  }],
});

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error("migration manifest contains an invalid identifier");
  return `"${value}"`;
}

function quoteCatalogIdentifier(value: string): string {
  if (value.includes("\0")) throw new Error("migration catalog contains an invalid identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

type OwnedObject = Readonly<{ kind: RelationKind; version: number }>;

function orderedManifests(manifests: ReadonlyMap<number, SchemaManifest>, throughVersion: number): SchemaManifest[] {
  return [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .sort((left, right) => left.version - right.version);
}

function collectOwnedObjects(manifests: ReadonlyMap<number, SchemaManifest>, throughVersion: number): Map<string, OwnedObject> {
  const owned = new Map<string, OwnedObject>();
  for (const manifest of orderedManifests(manifests, throughVersion)) {
    for (const [schema, name, kind] of manifest.objects ?? []) {
      const key = `${schema}|${name}`;
      if (owned.has(key)) throw new Error("migration manifest contains duplicate object ownership");
      owned.set(key, { kind, version: manifest.version });
    }
  }
  return owned;
}

function normalizeColumn(
  entry: ColumnShape | LegacyColumnShape,
  index: number,
  owned: ReadonlyMap<string, OwnedObject>,
): ColumnShape {
  if (!Array.isArray(entry)) return normalizeColumnSemantics(entry as ColumnShape);
  const [relation, name, type, notNull, defaultExpression] = entry;
  const owner = owned.get(`public|${relation}`);
  if (owner === undefined || owner.kind === "S") throw new Error("migration manifest contains a column for an unowned relation");
  return normalizeColumnSemantics({ schema: "public", relation, relkind: owner.kind, name, position: index + 1, type, notNull, defaultExpression } as ColumnShape);
}

function defaultColumnCollation(type: string): string {
  return /^(?:text|character(?: varying)?(?:\([0-9]+\))?|varchar(?:\([0-9]+\))?|name)$/u.test(type)
    ? 'pg_catalog."default"'
    : "";
}

function normalizeColumnSemantics(shape: ColumnShape): ColumnShape {
  return {
    ...shape,
    collation: shape.collation ?? defaultColumnCollation(shape.type),
    identity: shape.identity ?? "",
    generated: shape.generated ?? "",
  };
}

function normalizeConstraint(
  entry: ConstraintShape | LegacyConstraintShape,
  _index: number,
  owned: ReadonlyMap<string, OwnedObject>,
): ConstraintShape {
  if (!Array.isArray(entry)) return entry as ConstraintShape;
  const [relation, name, type, validated, definition] = entry;
  const owner = owned.get(`public|${relation}`);
  if (owner === undefined || (owner.kind !== "r" && owner.kind !== "p")) {
    throw new Error("migration manifest contains a constraint for an unsupported relation");
  }
  return { schema: "public", relation, relkind: owner.kind, name, type, validated, definition };
}

function normalizeIndex(entry: IndexShape | LegacyIndexShape, _index: number, owned: ReadonlyMap<string, OwnedObject>): IndexShape {
  if (!Array.isArray(entry)) return entry as IndexShape;
  const [relation, name, definition] = entry;
  const owner = owned.get(`public|${relation}`);
  if (owner === undefined || !new Set<RelationKind>(["r", "p", "m"]).has(owner.kind)) {
    throw new Error("migration manifest contains an index for an unsupported relation");
  }
  return { schema: "public", relation, relkind: owner.kind as IndexShape["relkind"], name, definition };
}

function shapeKey(shape: { schema: string; relation: string; relkind: string; name: string }): string {
  return `${shape.schema}|${shape.relation}|${shape.relkind}|${shape.name}`;
}

function canonicalShape(shape: unknown): readonly unknown[] | undefined {
  if (shape === undefined || shape === null || typeof shape !== "object") return undefined;
  const value = shape as Record<string, unknown>;
  const identity = [value.schema, value.relation, value.relkind, value.name];
  if ("position" in value) {
    return [...identity, value.position, value.type, value.notNull, value.defaultExpression,
      value.collation ?? defaultColumnCollation(String(value.type)), value.identity ?? "", value.generated ?? ""];
  }
  if ("validated" in value) {
    return [...identity, value.type, value.validated, value.definition];
  }
  if ("definition" in value) return [...identity, value.definition];
  return undefined;
}

function sameShape(left: unknown, right: unknown): boolean {
  const leftTuple = canonicalShape(left);
  const rightTuple = canonicalShape(right);
  return leftTuple !== undefined && rightTuple !== undefined
    && leftTuple.length === rightTuple.length
    && leftTuple.every((value, index) => value === rightTuple[index]);
}

function foldShapes<T extends { schema: "public"; relation: string; relkind: string; name: string }>(
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
  field: "columns" | "constraints" | "indexes",
  amendmentField: "columnAmendments" | "constraintAmendments" | "indexAmendments",
  normalize: (entry: never, index: number, owned: ReadonlyMap<string, OwnedObject>) => T,
): Map<string, T> {
  const owned = collectOwnedObjects(manifests, throughVersion);
  const folded = new Map<string, T>();
  for (const manifest of orderedManifests(manifests, throughVersion)) {
    for (const [index, entry] of (manifest[field] ?? []).entries()) {
      const normalizedIndex = field === "columns" && Array.isArray(entry)
        ? (manifest.columns ?? []).slice(0, index).filter((candidate) =>
          Array.isArray(candidate) && candidate[0] === entry[0]).length
        : index;
      const shape = normalize(entry as never, normalizedIndex, owned);
      const object = owned.get(`${shape.schema}|${shape.relation}`);
      if (object?.version !== manifest.version || object.kind !== shape.relkind) {
        throw new Error(`schema ${manifest.version} manifest validation failed: ${field} ownership`);
      }
      const key = shapeKey(shape);
      if (folded.has(key)) throw new Error(`schema ${manifest.version} manifest validation failed: duplicate ${field}`);
      folded.set(key, shape);
    }
    for (const amendment of (manifest[amendmentField] ?? []) as unknown as readonly ShapeAmendment<T>[]) {
      const before = field === "columns" && amendment.before !== undefined
        ? normalizeColumnSemantics(amendment.before as unknown as ColumnShape) as unknown as T
        : amendment.before;
      const after = field === "columns" && amendment.after !== undefined
        ? normalizeColumnSemantics(amendment.after as unknown as ColumnShape) as unknown as T
        : amendment.after;
      const shape = after ?? before;
      if (shape === undefined) throw new Error(`schema ${manifest.version} manifest validation failed: empty ${field} amendment`);
      const object = owned.get(`${shape.schema}|${shape.relation}`);
      if (object === undefined || object.kind !== shape.relkind || object.version >= manifest.version) {
        throw new Error(`schema ${manifest.version} manifest validation failed: ${field} amendment ownership`);
      }
      const key = shapeKey(shape);
      const current = folded.get(key);
      if (amendment.action === "add") {
        if (before !== undefined || after === undefined || current !== undefined) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid ${field} add`);
        }
        folded.set(key, after);
      } else if (amendment.action === "replace") {
        if (before === undefined || after === undefined || shapeKey(before) !== shapeKey(after)
          || current === undefined || !sameShape(current, before)) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid ${field} replace`);
        }
        folded.set(key, after);
      } else {
        if (before === undefined || after !== undefined || current === undefined || !sameShape(current, before)) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid ${field} revoke`);
        }
        folded.delete(key);
      }
    }
  }
  return folded;
}

function relationSemanticKey(shape: Pick<RelationSemanticShape, "schema" | "name" | "relkind">): string {
  return `${shape.schema}|${shape.name}|${shape.relkind}`;
}

function canonicalRelationSemantic(shape: RelationSemanticShape | undefined): readonly unknown[] | undefined {
  return shape === undefined ? undefined : [
    shape.schema, shape.name, shape.relkind, shape.definition, shape.partitionKey, shape.parent, shape.bound,
    shape.dataType, shape.start, shape.increment, shape.min, shape.max, shape.cache, shape.cycle,
  ];
}

function sameRelationSemantic(left: RelationSemanticShape | undefined, right: RelationSemanticShape | undefined): boolean {
  const leftTuple = canonicalRelationSemantic(left);
  const rightTuple = canonicalRelationSemantic(right);
  return leftTuple !== undefined && rightTuple !== undefined
    && leftTuple.length === rightTuple.length && leftTuple.every((value, index) => value === rightTuple[index]);
}

function defaultRelationSemantic(schema: "public", name: string, relkind: RelationKind): RelationSemanticShape {
  return {
    schema, name, relkind, definition: "", partitionKey: "", parent: "", bound: "", dataType: "",
    start: "", increment: "", min: "", max: "", cache: "", cycle: false,
  };
}

function foldRelationSemantics(
  manifests: ReadonlyMap<number, SchemaManifest>, throughVersion: number,
): Map<string, RelationSemanticShape> {
  const owned = collectOwnedObjects(manifests, throughVersion);
  const folded = new Map<string, RelationSemanticShape>();
  for (const manifest of orderedManifests(manifests, throughVersion)) {
    for (const semantic of manifest.relationSemantics ?? []) {
      const object = owned.get(`${semantic.schema}|${semantic.name}`);
      if (object?.version !== manifest.version || object.kind !== semantic.relkind) {
        throw new Error(`schema ${manifest.version} manifest validation failed: relation semantic ownership`);
      }
      const key = relationSemanticKey(semantic);
      if (folded.has(key)) {
        throw new Error(`schema ${manifest.version} manifest validation failed: duplicate relation semantics`);
      }
      folded.set(key, semantic);
    }
    for (const [schema, name, relkind] of manifest.objects ?? []) {
      if (manifest.version > 10) {
        const key = relationSemanticKey({ schema, name, relkind });
        if (!folded.has(key)) folded.set(key, defaultRelationSemantic(schema, name, relkind));
      }
    }
    for (const amendment of manifest.relationSemanticAmendments ?? []) {
      const shape = amendment.after ?? amendment.before;
      if (shape === undefined) throw new Error(`schema ${manifest.version} manifest validation failed: empty relation semantic amendment`);
      const object = owned.get(`${shape.schema}|${shape.name}`);
      if (object === undefined || object.kind !== shape.relkind || object.version >= manifest.version) {
        throw new Error(`schema ${manifest.version} manifest validation failed: relation semantic amendment ownership`);
      }
      const key = relationSemanticKey(shape);
      const current = folded.get(key);
      if (amendment.action === "add") {
        if (amendment.before !== undefined || amendment.after === undefined || current !== undefined) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid relation semantic add`);
        }
        folded.set(key, amendment.after);
      } else if (amendment.action === "replace") {
        if (amendment.before === undefined || amendment.after === undefined
          || relationSemanticKey(amendment.before) !== relationSemanticKey(amendment.after)
          || current === undefined || !sameRelationSemantic(current, amendment.before)) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid relation semantic replace`);
        }
        folded.set(key, amendment.after);
      } else {
        if (amendment.before === undefined || amendment.after !== undefined
          || current === undefined || !sameRelationSemantic(current, amendment.before)) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid relation semantic revoke`);
        }
        throw new Error(`schema ${manifest.version} manifest validation failed: invalid relation semantic revoke`);
      }
    }
  }
  for (const manifest of orderedManifests(manifests, throughVersion)) {
    if (manifest.version <= 10) continue;
    for (const [schema, name, relkind] of manifest.objects ?? []) {
      if (!folded.has(relationSemanticKey({ schema, name, relkind }))) {
        throw new Error(`schema ${manifest.version} manifest validation failed: missing relation semantics`);
      }
    }
  }
  return folded;
}

type FoldedRelationAcl = readonly [schema: "public", name: string, kind: RelationKind, grantee: string, privilege: string, grantable: boolean];
type FoldedRoutineAcl = readonly [schema: "public", name: string, kind: "f" | "p", arguments: string, grantee: string, privilege: "EXECUTE", grantable: boolean];

function foldManifestAcls(
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
  field: "relationAcls" | "routineAcls",
): Map<string, FoldedRelationAcl | FoldedRoutineAcl> {
  const folded = new Map<string, FoldedRelationAcl | FoldedRoutineAcl>();
  for (const manifest of orderedManifests(manifests, throughVersion)) {
    if (field === "routineAcls") {
      for (const [kind, name, arguments_] of manifest.routines ?? []) {
        const defaultAcl: FoldedRoutineAcl = ["public", name, kind as "f" | "p", arguments_, "PUBLIC", "EXECUTE", false];
        folded.set(defaultAcl.slice(0, -1).join("|"), defaultAcl);
      }
    }
    const seen = new Set<string>();
    for (const entry of manifest[field] ?? []) {
      const [disposition, ...acl] = entry as RelationAclManifestEntry | RoutineAclManifestEntry;
      const state = acl as unknown as FoldedRelationAcl | FoldedRoutineAcl;
      const key = state.slice(0, -1).join("|");
      if (seen.has(key)) throw new Error(`schema ${manifest.version} manifest validation failed: duplicate ${field}`);
      seen.add(key);
      if (disposition === "grant") {
        folded.set(key, state);
      } else {
        if (!folded.has(key) && manifest.version > 10) {
          throw new Error(`schema ${manifest.version} manifest validation failed: invalid ${field} revoke`);
        }
        folded.delete(key);
      }
    }
  }
  return folded;
}

function validateManifestDeclarations(manifests: ReadonlyMap<number, SchemaManifest>, throughVersion: number): void {
  collectOwnedObjects(manifests, throughVersion);
  foldShapes(manifests, throughVersion, "columns", "columnAmendments", normalizeColumn as never);
  foldShapes(manifests, throughVersion, "constraints", "constraintAmendments", normalizeConstraint as never);
  foldShapes(manifests, throughVersion, "indexes", "indexAmendments", normalizeIndex as never);
  foldRelationSemantics(manifests, throughVersion);
  foldManifestAcls(manifests, throughVersion, "relationAcls");
  foldManifestAcls(manifests, throughVersion, "routineAcls");
  for (const manifest of orderedManifests(manifests, throughVersion)) {
    for (const [, schema, name, kind, arguments_] of manifest.routineAcls ?? []) {
      quoteIdentifier(schema);
      quoteIdentifier(name);
      if (!new Set(["f", "p"]).has(kind) || /\0|;|--|\/\*|\*\//u.test(arguments_)) {
        throw new Error(`schema ${manifest.version} manifest validation failed: routine ACL declaration`);
      }
    }
  }
}

function reverseSchema10Amendments<T extends { schema: "public"; relation: string; relkind: string; name: string }>(
  current: Map<string, T>,
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
  field: "columnAmendments" | "constraintAmendments" | "indexAmendments",
): Map<string, T> {
  const owned = collectOwnedObjects(manifests, throughVersion);
  for (const manifest of orderedManifests(manifests, throughVersion).reverse()) {
    for (const amendment of [...(manifest[field] ?? [])].reverse() as unknown as ShapeAmendment<T>[]) {
      const before = field === "columnAmendments" && amendment.before !== undefined
        ? normalizeColumnSemantics(amendment.before as unknown as ColumnShape) as unknown as T
        : amendment.before;
      const after = field === "columnAmendments" && amendment.after !== undefined
        ? normalizeColumnSemantics(amendment.after as unknown as ColumnShape) as unknown as T
        : amendment.after;
      const shape = after ?? before;
      if (shape === undefined) continue;
      const object = owned.get(`${shape.schema}|${shape.relation}`);
      if (object === undefined || object.version > 10) continue;
      const key = shapeKey(shape);
      const existing = current.get(key);
      if (amendment.action === "add") {
        if (after === undefined || !sameShape(existing, after)) {
          throw new Error(`schema 10 manifest validation failed: ${field.replace("Amendments", "")}`);
        }
        current.delete(key);
      } else if (amendment.action === "replace") {
        if (before === undefined || after === undefined || !sameShape(existing, after)) {
          throw new Error(`schema 10 manifest validation failed: ${field.replace("Amendments", "")}`);
        }
        current.set(key, before);
      } else {
        if (before === undefined || existing !== undefined) {
          throw new Error(`schema 10 manifest validation failed: ${field.replace("Amendments", "")}`);
        }
        current.set(key, before);
      }
    }
  }
  return current;
}

function md5Lines(lines: readonly string[]): string {
  return createHash("md5").update(lines.join("\n")).digest("hex");
}

async function validateSchema10BaseShape(
  client: import("pg").PoolClient,
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
): Promise<void> {
  const columnRows = (await client.query<{
    collation: string; generated: string; identity: string;
    default_expression: string; kind: Exclude<RelationKind, "S">; name: string; not_null: boolean;
    position: number; relation: string; schema: "public"; type: string;
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            attribute.attname as name, attribute.attnum as position,
            format_type(attribute.atttypid, attribute.atttypmod) as type,
            attribute.attnotnull as not_null,
            coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') as default_expression,
            case when catalog_collation.oid is null then ''
              else format('%I.%I', collation_namespace.nspname, catalog_collation.collname) end as collation,
            attribute.attidentity as identity, attribute.attgenerated as generated
     from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_attribute attribute on attribute.attrelid = relation.oid
       and attribute.attnum > 0 and not attribute.attisdropped
     left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
     left join pg_collation catalog_collation on catalog_collation.oid = attribute.attcollation and attribute.attcollation <> 0
     left join pg_namespace collation_namespace on collation_namespace.oid = catalog_collation.collnamespace
     where namespace.nspname = 'public' and relation.relname = any($1::text[])
     order by relation.relname, attribute.attnum`,
    [schema10Tables],
  )).rows.map((row) => ({
    schema: row.schema, relation: row.relation, relkind: row.kind, name: row.name, position: row.position,
    type: row.type, notNull: row.not_null, defaultExpression: row.default_expression,
    collation: row.collation, identity: row.identity, generated: row.generated,
  } satisfies ColumnShape));
  const baseColumns = reverseSchema10Amendments(
    new Map(columnRows.map((shape) => [shapeKey(shape), shape])), manifests, throughVersion, "columnAmendments",
  );
  const columnHash = md5Lines([...baseColumns.values()]
    .sort((left, right) => left.relation.localeCompare(right.relation) || left.position - right.position)
    .map((shape) => `${shape.relation}|${shape.name}|${shape.type}|${shape.notNull ? "t" : "f"}|${shape.defaultExpression}`));
  if (columnHash !== "26c38a64c8f7a6473cfd916bf896a2be") {
    throw new Error("schema 10 manifest validation failed: column");
  }

  const constraintRows = (await client.query<{
    definition: string; kind: "r" | "p"; name: string; relation: string; schema: "public"; type: string; validated: boolean;
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            catalog_constraint.conname as name, catalog_constraint.contype as type,
            catalog_constraint.convalidated as validated, pg_get_constraintdef(catalog_constraint.oid, true) as definition
     from pg_constraint catalog_constraint join pg_class relation on relation.oid = catalog_constraint.conrelid
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public' and relation.relname = any($1::text[])
     order by relation.relname, catalog_constraint.conname`,
    [schema10Tables],
  )).rows.map((row) => ({
    schema: row.schema, relation: row.relation, relkind: row.kind, name: row.name,
    type: row.type, validated: row.validated, definition: row.definition,
  } satisfies ConstraintShape));
  const baseConstraints = reverseSchema10Amendments(
    new Map(constraintRows.map((shape) => [shapeKey(shape), shape])), manifests, throughVersion, "constraintAmendments",
  );
  const constraintHash = md5Lines([...baseConstraints.values()]
    .sort((left, right) => left.relation.localeCompare(right.relation) || left.name.localeCompare(right.name))
    .map((shape) => `${shape.relation}|${shape.name}|${shape.type}|${shape.validated ? "t" : "f"}|${shape.definition}`));
  if (constraintHash !== "3c16529462719fc465cb21215eba4569") {
    throw new Error("schema 10 manifest validation failed: constraint");
  }

  const indexRows = (await client.query<{
    definition: string; kind: "r" | "p" | "m"; name: string; relation: string; schema: "public";
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            index_relation.relname as name, pg_get_indexdef(index_relation.oid) as definition
     from pg_index catalog_index join pg_class relation on relation.oid = catalog_index.indrelid
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_class index_relation on index_relation.oid = catalog_index.indexrelid
     where namespace.nspname = 'public' and relation.relname = any($1::text[])
     order by relation.relname, index_relation.relname`,
    [schema10Tables],
  )).rows.map((row) => ({
    schema: row.schema, relation: row.relation, relkind: row.kind, name: row.name, definition: row.definition,
  } satisfies IndexShape));
  const baseIndexes = reverseSchema10Amendments(
    new Map(indexRows.map((shape) => [shapeKey(shape), shape])), manifests, throughVersion, "indexAmendments",
  );
  const indexHash = md5Lines([...baseIndexes.values()]
    .sort((left, right) => left.relation.localeCompare(right.relation) || left.name.localeCompare(right.name))
    .map((shape) => `${shape.relation}|${shape.name}|${shape.definition}`));
  if (indexHash !== "e35bb22408d7b171971cf0cd4aa4b5f5") {
    throw new Error("schema 10 manifest validation failed: index");
  }
}

async function convergeManifestAcls(client: import("pg").PoolClient, manifest: SchemaManifest): Promise<void> {
  // Schema 10 has a single set-based, fail-closed convergence routine above. Forward manifests
  // use the same declarative rules directly so their SQL and reviewed ACL state remain atomic.
  if (manifest.version <= 10) return;
  for (const [disposition, schema, name, kind, grantee, privilege, grantable] of manifest.relationAcls ?? []) {
    if (!new Set<RelationKind>(["r", "p", "v", "m", "S"]).has(kind)
      || !new Set(["PUBLIC", "core_agent_app", "core_agent_identity", "core_agent_worker"]).has(grantee)
      || !new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "USAGE"]).has(privilege)
      || (disposition === "revoke" && grantable)) throw new Error(`schema ${manifest.version} manifest validation failed: relation ACL declaration`);
    const target = kind === "S" ? "sequence" : "table";
    const verb = disposition === "grant" ? "grant" : "revoke";
    const suffix = disposition === "grant" ? "to" : "from";
    if (disposition === "grant") {
      await client.query(`revoke grant option for ${privilege} on ${target} ${quoteIdentifier(schema)}.${quoteIdentifier(name)} from ${grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee)}`);
    }
    await client.query(`${verb} ${privilege} on ${target} ${quoteIdentifier(schema)}.${quoteIdentifier(name)} ${suffix} ${grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee)}${disposition === "grant" && grantable ? " with grant option" : ""}`);
  }
  for (const [disposition, schema, name, kind, arguments_, grantee, privilege, grantable] of manifest.routineAcls ?? []) {
    if (!new Set(["f", "p"]).has(kind) || /\0|;|--|\/\*|\*\//u.test(arguments_)
      || !new Set(["PUBLIC", "core_agent_app", "core_agent_identity", "core_agent_worker"]).has(grantee)
      || privilege !== "EXECUTE" || (disposition === "revoke" && grantable)) {
      throw new Error(`schema ${manifest.version} manifest validation failed: routine ACL declaration`);
    }
    const matches = await client.query<{ identity: string }>(
      `select format('%I.%I(%s)', namespace.nspname, routine.proname,
          pg_get_function_identity_arguments(routine.oid)) as identity
       from pg_proc routine join pg_namespace namespace on namespace.oid = routine.pronamespace
       where namespace.nspname = $1 and routine.proname = $2 and routine.prokind = $3
         and pg_get_function_identity_arguments(routine.oid) = $4`,
      [schema, name, kind, arguments_],
    );
    if (matches.rows.length !== 1) {
      throw new Error(`schema ${manifest.version} manifest validation failed: routine ACL identity`);
    }
    const identity = matches.rows[0]!.identity;
    const verb = disposition === "grant" ? "grant" : "revoke";
    const suffix = disposition === "grant" ? "to" : "from";
    if (disposition === "grant") {
      await client.query(`revoke grant option for EXECUTE on ${kind === "p" ? "procedure" : "function"} ${identity} from ${grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee)}`);
    }
    await client.query(`${verb} EXECUTE on ${kind === "p" ? "procedure" : "function"} ${identity} ${suffix} ${grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(grantee)}${disposition === "grant" && grantable ? " with grant option" : ""}`);
  }
}

type ColumnAclCatalogEntry = Readonly<{
  column: string;
  grantable: boolean;
  grantee: string | null;
  granteeOid: string;
  kind: Exclude<RelationKind, "S">;
  privilege: string;
  relation: string;
  schema: string;
}>;

async function readOwnedColumnAcls(
  client: import("pg").PoolClient,
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
): Promise<ColumnAclCatalogEntry[]> {
  const ownedObjects = collectOwnedObjects(manifests, throughVersion);
  const ownedRelations = new Map([...ownedObjects.entries()]
    .filter(([, object]) => object.kind !== "S")
    .map(([key, object]) => [key, object.kind as Exclude<RelationKind, "S">]));
  const rows = (await client.query<{
    column_name: string; grantable: boolean; grantee: string | null; grantee_oid: string;
    kind: Exclude<RelationKind, "S">; privilege: string; relation: string; schema: string;
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            attribute.attname as column_name, privilege.grantee::text as grantee_oid,
            grantee.rolname as grantee, privilege.privilege_type as privilege,
            privilege.is_grantable as grantable
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_attribute attribute on attribute.attrelid = relation.oid
       and attribute.attnum <> 0 and not attribute.attisdropped
     cross join lateral aclexplode(attribute.attacl) privilege
     left join pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm')
     order by namespace.nspname, relation.relname, relation.relkind, attribute.attnum,
              privilege.grantee, privilege.privilege_type, privilege.is_grantable`,
  )).rows;
  return rows.filter((row) => ownedRelations.get(`${row.schema}|${row.relation}`) === row.kind)
    .map((row) => ({
      column: row.column_name,
      grantable: row.grantable,
      grantee: row.grantee,
      granteeOid: row.grantee_oid,
      kind: row.kind,
      privilege: row.privilege,
      relation: row.relation,
      schema: row.schema,
    }));
}

async function convergeOwnedColumnAcls(
  client: import("pg").PoolClient,
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
): Promise<void> {
  const columnAcls = await readOwnedColumnAcls(client, manifests, throughVersion);
  const allowedPrivileges = new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);
  const groups = new Map<string, {
    columns: string[]; grantee: string; privilege: string; relation: string; schema: string;
  }>();
  for (const acl of columnAcls) {
    if (!allowedPrivileges.has(acl.privilege)) {
      throw new Error(`schema ${throughVersion} manifest validation failed: column ACL privilege`);
    }
    const grantee = acl.granteeOid === "0" ? "PUBLIC" : acl.grantee;
    if (grantee === null) {
      throw new Error(`schema ${throughVersion} manifest validation failed: column ACL grantee`);
    }
    const key = [acl.schema, acl.relation, grantee, acl.privilege].join("|");
    const group = groups.get(key) ?? {
      columns: [], grantee, privilege: acl.privilege, relation: acl.relation, schema: acl.schema,
    };
    group.columns.push(acl.column);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].sort((left, right) =>
    [left.schema, left.relation, left.grantee, left.privilege].join("|")
      .localeCompare([right.schema, right.relation, right.grantee, right.privilege].join("|")))) {
    const columns = [...new Set(group.columns)].sort().map(quoteCatalogIdentifier).join(", ");
    const grantee = group.grantee === "PUBLIC" ? "PUBLIC" : quoteCatalogIdentifier(group.grantee);
    await client.query(
      `revoke ${group.privilege} (${columns}) on table ${quoteCatalogIdentifier(group.schema)}.${quoteCatalogIdentifier(group.relation)} from ${grantee} cascade`,
    );
  }
}

async function validateRegisteredCatalog(
  client: import("pg").PoolClient,
  manifests: ReadonlyMap<number, SchemaManifest>,
  throughVersion: number,
): Promise<void> {
  if (throughVersion < 10) return;
  const expectedObjects = [...manifests.values()]
    .filter((manifest) => manifest.version <= throughVersion)
    .flatMap((manifest) => manifest.objects ?? [])
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]) || left[2].localeCompare(right[2]));
  const catalogResult = await client.query<{ kind: RelationKind; name: string; owner: string; schema: "public"; expected_owner: string }>(
    `select namespace.nspname as schema, relation.relname as name, relation.relkind as kind,
            owner.rolname as owner, current_user as expected_owner
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_roles owner on owner.oid = relation.relowner
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm', 'S')
     order by namespace.nspname, relation.relname, relation.relkind`,
  );
  const expectedOwner = catalogResult.rows[0]?.expected_owner ?? (await client.query<{ owner: string }>("select current_user as owner")).rows[0]!.owner;
  const normalizedExpectedObjects = expectedObjects.map(([schema, name, kind, owner]) =>
    [schema, name, kind, owner === "current_user" ? expectedOwner : owner] as const);
  const actualObjects = catalogResult.rows.map((row) => [row.schema, row.name, row.kind, row.owner] as const);
  if (JSON.stringify(actualObjects) !== JSON.stringify(normalizedExpectedObjects)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: relation catalog`);
  }
  const expectedRelationSemantics = [...foldRelationSemantics(manifests, throughVersion).values()]
    .sort((left, right) => relationSemanticKey(left).localeCompare(relationSemanticKey(right)));
  const semanticKeys = new Set(expectedRelationSemantics.map(relationSemanticKey));
  const actualRelationSemantics = (await client.query<{
    bound: string; cache: string; cycle: boolean; dataType: string; definition: string; increment: string;
    max: string; min: string; name: string; parent: string; partitionKey: string; relkind: RelationKind;
    schema: "public"; start: string;
  }>(
    `select namespace.nspname as schema, relation.relname as name, relation.relkind as relkind,
            case when relation.relkind in ('v', 'm') then pg_get_viewdef(relation.oid, true) else '' end as definition,
            case when relation.relkind = 'p' then pg_get_partkeydef(relation.oid) else '' end as "partitionKey",
            coalesce(parent_namespace.nspname || '.' || parent.relname, '') as parent,
            case when relation.relispartition then pg_get_expr(relation.relpartbound, relation.oid, true) else '' end as bound,
            coalesce(format_type(sequence.seqtypid, null), '') as "dataType",
            coalesce(sequence.seqstart::text, '') as start,
            coalesce(sequence.seqincrement::text, '') as increment,
            coalesce(sequence.seqmin::text, '') as min,
            coalesce(sequence.seqmax::text, '') as max,
            coalesce(sequence.seqcache::text, '') as cache,
            coalesce(sequence.seqcycle, false) as cycle
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     left join pg_inherits inheritance on inheritance.inhrelid = relation.oid
     left join pg_class parent on parent.oid = inheritance.inhparent
     left join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
     left join pg_sequence sequence on sequence.seqrelid = relation.oid
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm', 'S')
     order by namespace.nspname, relation.relname, relation.relkind`,
  )).rows.filter((row) => semanticKeys.has(relationSemanticKey(row)))
    .sort((left, right) => relationSemanticKey(left).localeCompare(relationSemanticKey(right)));
  if (actualRelationSemantics.length !== expectedRelationSemantics.length
    || actualRelationSemantics.some((row, index) => !sameRelationSemantic(row, expectedRelationSemantics[index]))) {
    throw new Error(`schema ${throughVersion} manifest validation failed: relation semantic catalog`);
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
  const expectedRoutineAcls = [...foldManifestAcls(manifests, throughVersion, "routineAcls").values()]
    .filter((entry): entry is FoldedRoutineAcl => entry.length === 7)
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));
  const actualRoutineAcls = (await client.query<{
    arguments: string; grantable: boolean; grantee: string; kind: string; name: string; privilege: string; schema: string;
  }>(
    `select namespace.nspname as schema, routine.proname as name, routine.prokind as kind,
            pg_get_function_identity_arguments(routine.oid) as arguments,
            coalesce(grantee.rolname, 'PUBLIC') as grantee,
            privilege.privilege_type as privilege, privilege.is_grantable as grantable
     from pg_proc routine
     join pg_namespace namespace on namespace.oid = routine.pronamespace
     cross join lateral aclexplode(coalesce(routine.proacl, acldefault('f', routine.proowner))) privilege
     left join pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public' and privilege.grantee <> routine.proowner
     order by namespace.nspname, routine.proname, routine.prokind, pg_get_function_identity_arguments(routine.oid),
              coalesce(grantee.rolname, 'PUBLIC'), privilege.privilege_type, privilege.is_grantable`,
  )).rows.map((row) => [row.schema, row.name, row.kind, row.arguments, row.grantee, row.privilege, row.grantable] as const);
  if (JSON.stringify(actualRoutineAcls) !== JSON.stringify(expectedRoutineAcls)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: routine ACL`);
  }

  const ownedObjects = collectOwnedObjects(manifests, throughVersion);
  const forwardRelationKeys = new Set([...ownedObjects.entries()]
    .filter(([, object]) => object.version > 10 && object.kind !== "S")
    .map(([key]) => key));
  const amendmentKeys = <T extends { schema: string; relation: string; relkind: string; name: string }>(
    field: "columnAmendments" | "constraintAmendments" | "indexAmendments",
  ): Set<string> => new Set(orderedManifests(manifests, throughVersion).flatMap((manifest) => {
    const amendments = (manifest[field] ?? []) as unknown as readonly ShapeAmendment<T>[];
    return amendments.flatMap((amendment) => [amendment.before, amendment.after]
      .filter((shape): shape is T => shape !== undefined).map((shape) => shapeKey(shape)));
  }));

  const expectedColumns = [...foldShapes<ColumnShape>(
    manifests, throughVersion, "columns", "columnAmendments", normalizeColumn as never,
  ).values()].filter((shape) => forwardRelationKeys.has(`${shape.schema}|${shape.relation}`)
    || amendmentKeys<ColumnShape>("columnAmendments").has(shapeKey(shape)))
    .sort((left, right) => shapeKey(left).localeCompare(shapeKey(right)) || left.position - right.position);
  const columnAmendmentKeys = amendmentKeys<ColumnShape>("columnAmendments");
  const actualColumns = (await client.query<{
    collation: string; generated: string; identity: string;
    default_expression: string; kind: Exclude<RelationKind, "S">; name: string; not_null: boolean;
    position: number; relation: string; schema: "public"; type: string;
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            attribute.attname as name, attribute.attnum as position,
            format_type(attribute.atttypid, attribute.atttypmod) as type,
            attribute.attnotnull as not_null,
            coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '') as default_expression,
            case when catalog_collation.oid is null then ''
              else format('%I.%I', collation_namespace.nspname, catalog_collation.collname) end as collation,
            attribute.attidentity as identity, attribute.attgenerated as generated
     from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_attribute attribute on attribute.attrelid = relation.oid
       and attribute.attnum > 0 and not attribute.attisdropped
     left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
     left join pg_collation catalog_collation on catalog_collation.oid = attribute.attcollation and attribute.attcollation <> 0
     left join pg_namespace collation_namespace on collation_namespace.oid = catalog_collation.collnamespace
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm')
     order by namespace.nspname, relation.relname, relation.relkind, attribute.attnum`,
  )).rows.map((row) => ({
    schema: row.schema, relation: row.relation, relkind: row.kind, name: row.name, position: row.position,
    type: row.type, notNull: row.not_null, defaultExpression: row.default_expression,
    collation: row.collation, identity: row.identity, generated: row.generated,
  } satisfies ColumnShape)).filter((shape) => forwardRelationKeys.has(`${shape.schema}|${shape.relation}`)
    || columnAmendmentKeys.has(shapeKey(shape)))
    .sort((left, right) => shapeKey(left).localeCompare(shapeKey(right)) || left.position - right.position);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: column catalog`);
  }

  const expectedConstraints = [...foldShapes<ConstraintShape>(
    manifests, throughVersion, "constraints", "constraintAmendments", normalizeConstraint as never,
  ).values()].filter((shape) => forwardRelationKeys.has(`${shape.schema}|${shape.relation}`)
    || amendmentKeys<ConstraintShape>("constraintAmendments").has(shapeKey(shape)))
    .sort((left, right) => shapeKey(left).localeCompare(shapeKey(right)));
  const constraintAmendmentKeys = amendmentKeys<ConstraintShape>("constraintAmendments");
  const actualConstraints = (await client.query<{
    definition: string; kind: "r" | "p"; name: string; relation: string; schema: "public"; type: string; validated: boolean;
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            catalog_constraint.conname as name, catalog_constraint.contype as type,
            catalog_constraint.convalidated as validated, pg_get_constraintdef(catalog_constraint.oid, true) as definition
     from pg_constraint catalog_constraint join pg_class relation on relation.oid = catalog_constraint.conrelid
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
     order by namespace.nspname, relation.relname, relation.relkind, catalog_constraint.conname`,
  )).rows.map((row) => ({
    schema: row.schema, relation: row.relation, relkind: row.kind, name: row.name,
    type: row.type, validated: row.validated, definition: row.definition,
  } satisfies ConstraintShape)).filter((shape) => forwardRelationKeys.has(`${shape.schema}|${shape.relation}`)
    || constraintAmendmentKeys.has(shapeKey(shape)))
    .sort((left, right) => shapeKey(left).localeCompare(shapeKey(right)));
  if (JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: constraint catalog`);
  }

  const expectedIndexes = [...foldShapes<IndexShape>(
    manifests, throughVersion, "indexes", "indexAmendments", normalizeIndex as never,
  ).values()].filter((shape) => forwardRelationKeys.has(`${shape.schema}|${shape.relation}`)
    || amendmentKeys<IndexShape>("indexAmendments").has(shapeKey(shape)))
    .sort((left, right) => shapeKey(left).localeCompare(shapeKey(right)));
  const indexAmendmentKeys = amendmentKeys<IndexShape>("indexAmendments");
  const actualIndexes = (await client.query<{
    definition: string; kind: "r" | "p" | "m"; name: string; relation: string; schema: "public";
  }>(
    `select namespace.nspname as schema, relation.relname as relation, relation.relkind as kind,
            index_relation.relname as name, pg_get_indexdef(index_relation.oid) as definition
     from pg_index catalog_index join pg_class relation on relation.oid = catalog_index.indrelid
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_class index_relation on index_relation.oid = catalog_index.indexrelid
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'm')
     order by namespace.nspname, relation.relname, relation.relkind, index_relation.relname`,
  )).rows.map((row) => ({
    schema: row.schema, relation: row.relation, relkind: row.kind, name: row.name, definition: row.definition,
  } satisfies IndexShape)).filter((shape) => forwardRelationKeys.has(`${shape.schema}|${shape.relation}`)
    || indexAmendmentKeys.has(shapeKey(shape)))
    .sort((left, right) => shapeKey(left).localeCompare(shapeKey(right)));
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: index catalog`);
  }
  const expectedRelationAcls = [...foldManifestAcls(manifests, throughVersion, "relationAcls").values()]
    .filter((entry): entry is FoldedRelationAcl => entry.length === 6)
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));
  const actualRelationAcls = (await client.query<{
    grantable: boolean; grantee: string; kind: RelationKind; name: string; privilege: string; schema: string;
  }>(
    `select namespace.nspname as schema, relation.relname as name, relation.relkind as kind,
            coalesce(grantee.rolname, 'PUBLIC') as grantee,
            privilege.privilege_type as privilege, privilege.is_grantable as grantable
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     cross join lateral aclexplode(coalesce(relation.relacl,
       acldefault(case relation.relkind when 'S' then 'S'::"char" else 'r'::"char" end, relation.relowner))) privilege
     left join pg_roles grantee on grantee.oid = privilege.grantee
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p', 'v', 'm', 'S')
       and privilege.grantee <> relation.relowner
     order by namespace.nspname, relation.relname, relation.relkind,
              coalesce(grantee.rolname, 'PUBLIC'), privilege.privilege_type, privilege.is_grantable`,
  )).rows.map((row) => [row.schema, row.name, row.kind, row.grantee, row.privilege, row.grantable] as const);
  if (JSON.stringify(actualRelationAcls) !== JSON.stringify(expectedRelationAcls)) {
    throw new Error(`schema ${throughVersion} manifest validation failed: relation ACL`);
  }
  if ((await readOwnedColumnAcls(client, manifests, throughVersion)).length !== 0) {
    throw new Error(`schema ${throughVersion} manifest validation failed: column ACL`);
  }
}

const migrationFilePattern = /^(?<version>[0-9]{3,})_(?<name>[a-z0-9][a-z0-9_-]*)\.sql$/;

function isTransactionControlStatement(tokens: readonly string[]): boolean {
  const [first, second, third, fourth] = tokens;
  if (new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE"]).has(first ?? "")) return true;
  if ((first === "START" || first === "PREPARE") && second === "TRANSACTION") return true;
  if (first === "SET" && second === "TRANSACTION") return true;
  return first === "SET" && second === "SESSION" && third === "CHARACTERISTICS" && fourth === "AS"
    && tokens[4] === "TRANSACTION";
}

function assertNoTopLevelTransactionControl(sql: string): void {
  let index = 0;
  let tokens: string[] = [];
  const finishStatement = () => {
    if (isTransactionControlStatement(tokens)) {
      throw new Error("migration SQL contains top-level transaction control");
    }
    tokens = [];
  };
  while (index < sql.length) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(current)) { index += 1; continue; }
    if (current === ";") { finishStatement(); index += 1; continue; }
    if (current === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") { depth += 1; index += 2; }
        else if (sql[index] === "*" && sql[index + 1] === "/") { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth !== 0) throw new Error("migration SQL contains an unterminated block comment");
      continue;
    }
    if (current === "'") {
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "\\") { index += Math.min(2, sql.length - index); continue; }
        if (sql[index] === "'" && sql[index + 1] === "'") { index += 2; continue; }
        if (sql[index] === "'") { index += 1; closed = true; break; }
        index += 1;
      }
      if (!closed) throw new Error("migration SQL contains an unterminated string literal");
      continue;
    }
    if (current === '"') {
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') { index += 2; continue; }
        if (sql[index] === '"') { index += 1; closed = true; break; }
        index += 1;
      }
      if (!closed) throw new Error("migration SQL contains an unterminated quoted identifier");
      continue;
    }
    if (current === "$") {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index))?.[0];
      if (delimiter !== undefined) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end < 0) throw new Error("migration SQL contains an unterminated dollar-quoted body");
        index = end + delimiter.length;
        continue;
      }
    }
    if (/[A-Za-z_]/u.test(current)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index))![0];
      if (tokens.length < 5) tokens.push(match.toUpperCase());
      index += match.length;
      continue;
    }
    index += 1;
  }
  finishStatement();
}

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
      assertNoTopLevelTransactionControl(sql);
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
  validateManifestDeclarations(manifests, maximumVersion);
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
        for (const manifest of orderedManifests(manifests, migration.version)) {
          await manifest.validateAndConverge?.(client, maximumVersion, manifests, migration.version);
          await convergeManifestAcls(client, manifest);
        }
        await convergeOwnedColumnAcls(client, manifests, migration.version);
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
          const manifest = manifests.get(version)!;
          await manifest.validateAndConverge?.(client, maximumVersion, manifests, Math.max(...applied.keys()));
          await convergeManifestAcls(client, manifest);
        }
        const currentVersion = Math.max(...applied.keys());
        if (currentVersion !== maximumVersion) throw new Error("database schema is below this binary");
        await convergeOwnedColumnAcls(client, manifests, currentVersion);
        await validateRegisteredCatalog(client, manifests, currentVersion);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        if (error instanceof Error && (
          error.message.startsWith("schema 10 ACL convergence failed:")
          || /^schema [0-9]+ manifest validation failed:/u.test(error.message)
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
