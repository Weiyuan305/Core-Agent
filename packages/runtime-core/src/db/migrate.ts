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

async function convergeSchema10Acls(client: import("pg").PoolClient): Promise<void> {
  const catalog = await client.query<{ owner_matches: boolean; table_name: string }>(
    `select relation.relname as table_name, owner.rolname = current_user as owner_matches
     from pg_class relation
     join pg_namespace namespace on namespace.oid = relation.relnamespace
     join pg_roles owner on owner.oid = relation.relowner
     where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
     order by relation.relname`,
  );
  if (
    catalog.rows.length !== schema10Tables.length
    || catalog.rows.some((row, index) => row.table_name !== schema10Tables[index] || !row.owner_matches)
  ) throw new Error("schema 10 ACL convergence failed: catalog");

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

export async function applyMigrations(pool: Pool, directory: string): Promise<void> {
  const migrations = await readMigrations(directory);
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
        await client.query(
          "insert into core_agent_schema_migrations (version, name, checksum, applied_at) values ($1, $2, $3, now())",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    if (applied.has(10) || migrations.some((migration) => migration.version === 10)) {
      await client.query("begin");
      try {
        await convergeSchema10Acls(client);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        if (error instanceof Error && error.message.startsWith("schema 10 ACL convergence failed:")) throw error;
        throw new Error("schema 10 ACL convergence failed");
      }
    }
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtext('core-agent-schema-migrations'))");
    client.release();
  }
}
