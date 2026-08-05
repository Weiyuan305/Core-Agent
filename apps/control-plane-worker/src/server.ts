import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { assertSchemaVersion, createRedactor, createRuntimeDatabase, FileSecretStore, HermesClient, loadProviderCatalog, loadRuntimeEnvironment, RuntimeSupervisorClient } from "@core-agent/runtime-core";
import { Pool } from "pg";

import { HttpHermesReadinessClient } from "./hermes-readiness-client.js";
import { createWorkerRuntimeRepositories, runControlPlaneWorker, type WorkerClock, type WorkerLogger } from "./main.js";

const require = createRequire(import.meta.url);
const pino = require("pino") as () => WorkerLogger;

export function createWorkerClock(): WorkerClock {
  return {
  now: () => new Date(),
  wait: (milliseconds, signal) => new Promise<void>((resolveWait) => {
    if (signal.aborted) { resolveWait(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveWait();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  }),
  scheduleEvery: (callback, milliseconds) => {
    const timer = setInterval(() => { void callback(); }, milliseconds);
    return () => clearInterval(timer);
  },
  };
}

export function createWorkerLeaseOwner(workerId: string, uuid: () => string = randomUUID): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(workerId)) {
    throw new Error("CONTROL_PLANE_WORKER_ID must be a bounded worker identifier");
  }
  const incarnation = uuid();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(incarnation)) {
    throw new Error("Worker incarnation is invalid");
  }
  return `${workerId}:${incarnation}`;
}

export async function startControlPlaneWorker(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configuration = loadRuntimeEnvironment(environment);
  const providerPath = resolve(configuration.providerCatalogFile);
  if (providerPath !== configuration.providerCatalogFile) throw new Error("Control Plane Worker configuration is invalid");
  let providerJson: unknown;
  try { providerJson = JSON.parse(await readFile(providerPath, "utf8")) as unknown; }
  catch { throw new Error("Control Plane Worker configuration is invalid"); }
  const pool = new Pool({ connectionString: configuration.databaseUrl });
  const db = createRuntimeDatabase(pool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await assertSchemaVersion(db);
    const providerCatalog = loadProviderCatalog(providerJson);
    await runControlPlaneWorker({
      db, workerId: createWorkerLeaseOwner(configuration.workerId), clock: createWorkerClock(), logger: pino(),
      repositories: createWorkerRuntimeRepositories(db, providerCatalog, createRedactor([])),
      providerCatalog,
      supervisorClient: new RuntimeSupervisorClient({ socketPath: configuration.supervisorSocket }),
      ingressSecretStore: new FileSecretStore(configuration.secretRoot),
      hermesClient: new HttpHermesReadinessClient(),
      executionHermesClient: new HermesClient(),
    }, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startControlPlaneWorker().catch(() => { process.exitCode = 1; });
}
