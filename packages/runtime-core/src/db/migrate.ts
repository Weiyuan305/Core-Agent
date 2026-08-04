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
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtext('core-agent-schema-migrations'))");
    client.release();
  }
}
