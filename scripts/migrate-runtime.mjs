import { resolve } from "node:path";

import {
  applyMigrations,
  databaseConnectionOptions,
  readProtectedDatabasePassword,
} from "@core-agent/runtime-core";
import { Pool } from "pg";

const databaseUrl = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("CONTROL_PLANE_DATABASE_URL is required");
}
const passwordFile = process.env.CONTROL_PLANE_DATABASE_PASSWORD_FILE?.trim();
if (passwordFile === undefined || passwordFile.length === 0) {
  throw new Error("CONTROL_PLANE_DATABASE_PASSWORD_FILE is required");
}

const databasePassword = await readProtectedDatabasePassword(passwordFile);
const pool = new Pool(databaseConnectionOptions(databaseUrl, databasePassword));
try {
  await applyMigrations(pool, resolve("packages/runtime-core/migrations"));
} finally {
  await pool.end();
}
