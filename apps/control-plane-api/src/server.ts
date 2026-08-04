import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRedactor,
  createRuntimeDatabase,
  loadProviderCatalog,
  loadRuntimeEnvironment,
} from "@core-agent/runtime-core";
import type { FastifyBaseLogger } from "fastify";
import { Pool } from "pg";

import { buildControlPlaneApp } from "./app.js";

const require = createRequire(import.meta.url);
const createPinoLogger = require("pino") as () => FastifyBaseLogger;

function configurationError(): Error {
  return new Error("Control Plane API configuration is invalid");
}

function managedAbsolutePath(value: string | undefined): string {
  if (
    value === undefined
    || value.length < 1
    || value.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(value)
    || resolve(value) !== value
  ) throw configurationError();
  return value;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw configurationError();
  }
}

export async function startControlPlaneServer(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = loadRuntimeEnvironment(environment);
  const imageLockPath = managedAbsolutePath(environment.CONTROL_PLANE_IMAGE_LOCK_FILE);
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  const db = createRuntimeDatabase(pool);
  const logger = createPinoLogger();
  try {
    const app = await buildControlPlaneApp({
      environment: configuration,
      db,
      providerCatalog: loadProviderCatalog(await readJson(configuration.providerCatalogFile)),
      imageLock: await readJson(imageLockPath),
      logger,
      redactor: createRedactor([]),
    });
    app.addHook("onClose", async () => db.destroy());
    await app.listen({ host: configuration.apiHost, port: configuration.apiPort });
    return app;
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startControlPlaneServer().catch(() => {
    process.exitCode = 1;
  });
}
