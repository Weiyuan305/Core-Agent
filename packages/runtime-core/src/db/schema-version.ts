import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "./database.js";

export const EXPECTED_SCHEMA_VERSION = 5;

export async function readSchemaVersion(db: Kysely<RuntimeDatabase>): Promise<number> {
  const row = await db.selectFrom("core_agent_schema_migrations")
    .select(({ fn }) => fn.max<number>("version").as("version"))
    .executeTakeFirst();
  return row?.version ?? 0;
}

export async function assertSchemaVersion(
  db: Kysely<RuntimeDatabase>,
  expected = EXPECTED_SCHEMA_VERSION,
): Promise<void> {
  const actual = await readSchemaVersion(db);
  if (actual < expected) throw new Error("database schema is behind: " + actual);
  if (actual > expected) throw new Error("database schema is ahead: " + actual);
}
