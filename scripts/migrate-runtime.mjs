import { resolve } from "node:path";

import { applyMigrations } from "@core-agent/runtime-core";
import { Pool } from "pg";

const databaseUrl = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("CONTROL_PLANE_DATABASE_URL is required");
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  await applyMigrations(pool, resolve("packages/runtime-core/migrations"));
} finally {
  await pool.end();
}
