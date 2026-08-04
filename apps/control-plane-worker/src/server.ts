import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSchemaVersion, createRedactor, createRuntimeDatabase, FileSecretStore, loadProviderCatalog, loadRuntimeEnvironment, RuntimeSupervisorClient } from "@core-agent/runtime-core";
import { Pool } from "pg";

import { HttpHermesReadinessClient } from "./hermes-readiness-client.js";
import { createWorkerRuntimeRepositories, runControlPlaneWorker, type WorkerClock, type WorkerLogger } from "./main.js";

const require = createRequire(import.meta.url);
const pino = require("pino") as () => WorkerLogger;

const clock: WorkerClock = {
  now: () => new Date(),
  wait: (milliseconds, signal) => new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait(); }, { once: true });
  }),
  scheduleEvery: (callback, milliseconds) => {
    const timer = setInterval(() => { void callback(); }, milliseconds);
    return () => clearInterval(timer);
  },
};

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
    await runControlPlaneWorker({
      db, workerId: configuration.workerId, clock, logger: pino(),
      repositories: createWorkerRuntimeRepositories(db, createRedactor([])),
      providerCatalog: loadProviderCatalog(providerJson),
      supervisorClient: new RuntimeSupervisorClient({ socketPath: configuration.supervisorSocket }),
      ingressSecretStore: new FileSecretStore(configuration.secretRoot),
      hermesClient: new HttpHermesReadinessClient(),
    }, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startControlPlaneWorker().catch(() => { process.exitCode = 1; });
}
