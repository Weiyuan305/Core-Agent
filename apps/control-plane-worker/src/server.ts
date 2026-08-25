import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { assertSchemaVersion, assertSecretReferenceId, createRedactor, createRuntimeDatabase, databaseConnectionOptions, FileSecretStore, HermesClient, loadProviderCatalog, loadRuntimeEnvironment, loadRuntimeImageLock, readProtectedDatabasePassword, RuntimeSupervisorClient } from "@core-agent/runtime-core";
import { Pool } from "pg";

import { HttpHermesReadinessClient } from "./hermes-readiness-client.js";
import { IdentityProviderDeletionClient } from "./identity-provider-deletion-client.js";
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

export interface IdentityFinalizerConfiguration {
  readonly databaseUrl: string;
  readonly databasePasswordFile: string;
  readonly providerUrl: string;
  readonly providerServiceRoleKeyFile: string;
}

function databaseTarget(value: string): { host: string; port: number; database: string; user: string } {
  try {
    const parsed = new URL(value);
    const port = parsed.port === "" ? 5432 : Number(parsed.port);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    const user = decodeURIComponent(parsed.username);
    if (parsed.protocol !== "postgresql:" || parsed.hostname.length === 0 || parsed.password !== ""
      || parsed.search !== "" || parsed.hash !== "" || database.length === 0 || database.includes("/")
      || user.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error();
    }
    return { host: parsed.hostname, port, database, user };
  } catch {
    throw new Error("Identity finalizer configuration is invalid");
  }
}

export function loadIdentityFinalizerConfiguration(
  environment: NodeJS.ProcessEnv,
): IdentityFinalizerConfiguration | undefined {
  const names = [
    "IDENTITY_DATABASE_URL",
    "IDENTITY_DATABASE_PASSWORD_FILE",
    "IDENTITY_PROVIDER_URL",
    "IDENTITY_PROVIDER_SERVICE_ROLE_KEY_FILE",
  ] as const;
  const values = names.map((name) => environment[name]?.trim()).map((value) => value === "" ? undefined : value);
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error("Identity finalizer configuration is incomplete");
  }
  const applicationDatabaseUrl = environment.CONTROL_PLANE_DATABASE_URL?.trim();
  if (applicationDatabaseUrl === undefined || applicationDatabaseUrl === "") {
    throw new Error("Identity finalizer configuration is incomplete");
  }
  const applicationTarget = databaseTarget(applicationDatabaseUrl);
  const identityTarget = databaseTarget(values[0]!);
  if (applicationTarget.host !== identityTarget.host || applicationTarget.port !== identityTarget.port
    || applicationTarget.database !== identityTarget.database || applicationTarget.user === identityTarget.user) {
    throw new Error("Identity finalizer configuration is invalid");
  }
  return Object.freeze({
    databaseUrl: values[0]!, databasePasswordFile: values[1]!,
    providerUrl: values[2]!, providerServiceRoleKeyFile: values[3]!,
  });
}

export async function startControlPlaneWorker(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configuration = loadRuntimeEnvironment(environment);
  const providerPath = resolve(configuration.providerCatalogFile);
  if (providerPath !== configuration.providerCatalogFile) throw new Error("Control Plane Worker configuration is invalid");
  let providerJson: unknown;
  try { providerJson = JSON.parse(await readFile(providerPath, "utf8")) as unknown; }
  catch { throw new Error("Control Plane Worker configuration is invalid"); }
  const imageLockPath = resolve(environment.CONTROL_PLANE_IMAGE_LOCK_FILE ?? "");
  if (imageLockPath !== environment.CONTROL_PLANE_IMAGE_LOCK_FILE) throw new Error("Control Plane Worker configuration is invalid");
  let imageLockJson: unknown;
  try { imageLockJson = JSON.parse(await readFile(imageLockPath, "utf8")) as unknown; }
  catch { throw new Error("Control Plane Worker configuration is invalid"); }
  const imageLock = loadRuntimeImageLock(imageLockJson);
  const runtimePlatform = environment.CONTROL_PLANE_RUNTIME_PLATFORM;
  if (runtimePlatform !== "linux/amd64" && runtimePlatform !== "linux/arm64") {
    throw new Error("Control Plane Worker configuration is invalid");
  }
  const ingressSecretReferenceId = environment.CONTROL_PLANE_INGRESS_SECRET_REFERENCE_ID ?? "";
  try { assertSecretReferenceId(ingressSecretReferenceId); }
  catch { throw new Error("Control Plane Worker configuration is invalid"); }
  const databasePassword = await readProtectedDatabasePassword(configuration.databasePasswordFile);
  const identityConfiguration = loadIdentityFinalizerConfiguration(environment);
  const identityPassword = identityConfiguration === undefined
    ? undefined
    : await readProtectedDatabasePassword(identityConfiguration.databasePasswordFile);
  const applicationConnection = databaseConnectionOptions(configuration.databaseUrl, databasePassword);
  const identityConnection = identityConfiguration === undefined || identityPassword === undefined
    ? undefined
    : databaseConnectionOptions(identityConfiguration.databaseUrl, identityPassword);
  const identityProviderDeletion = identityConfiguration === undefined ? undefined : new IdentityProviderDeletionClient({
    providerUrl: identityConfiguration.providerUrl,
    serviceRoleKeyFile: identityConfiguration.providerServiceRoleKeyFile,
  });
  const pool = new Pool(applicationConnection);
  const db = createRuntimeDatabase(pool);
  const identityPool = identityConnection === undefined
    ? undefined
    : new Pool(identityConnection);
  const identityDb = identityPool === undefined ? undefined : createRuntimeDatabase(identityPool);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await assertSchemaVersion(db);
    if (identityDb !== undefined) await assertSchemaVersion(identityDb);
    const providerCatalog = loadProviderCatalog(providerJson);
    await runControlPlaneWorker({
      db, ...(identityDb === undefined ? {} : { identityDb }),
      ...(identityProviderDeletion === undefined ? {} : { identityProviderDeletion }),
      workerId: createWorkerLeaseOwner(configuration.workerId), clock: createWorkerClock(), logger: pino(),
      repositories: createWorkerRuntimeRepositories(db, providerCatalog, createRedactor([]), {
        imageRef: imageLock.platforms[runtimePlatform].reference,
        platform: runtimePlatform,
        ingressSecretReferenceId,
        providerCatalog,
      }),
      providerCatalog,
      supervisorClient: new RuntimeSupervisorClient({ socketPath: configuration.supervisorSocket }),
      ingressSecretStore: new FileSecretStore(configuration.secretRoot),
      hermesClient: new HttpHermesReadinessClient(),
      executionHermesClient: new HermesClient(),
    }, controller.signal);
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await identityDb?.destroy();
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startControlPlaneWorker().catch(() => { process.exitCode = 1; });
}
