#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapRuntimeDatabaseAuth } from "@core-agent/runtime-core";

function required(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error("Database authentication bootstrap failed");
  return value;
}

export async function runRuntimeDatabaseAuthBootstrap(environment = process.env) {
  const databaseUrl = required(environment, "CONTROL_PLANE_DATABASE_URL");
  try {
    if (new URL(databaseUrl).username !== "core_agent_bootstrap") {
      throw new Error("Database authentication bootstrap failed");
    }
  } catch {
    throw new Error("Database authentication bootstrap failed");
  }
  await bootstrapRuntimeDatabaseAuth({
    databaseUrl,
    bootstrapPasswordFile: required(environment, "CONTROL_PLANE_DATABASE_PASSWORD_FILE"),
    migratorPasswordFile: required(environment, "CORE_AGENT_MIGRATOR_DATABASE_PASSWORD_FILE"),
    applicationPasswordFile: required(environment, "CORE_AGENT_APP_DATABASE_PASSWORD_FILE"),
    identityPasswordFile: required(environment, "CORE_AGENT_IDENTITY_DATABASE_PASSWORD_FILE"),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRuntimeDatabaseAuthBootstrap().catch(() => {
    process.stderr.write("Database authentication bootstrap failed\n");
    process.exitCode = 1;
  });
}
