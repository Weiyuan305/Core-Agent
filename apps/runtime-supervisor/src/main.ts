import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import Dockerode from "dockerode";

import {
  FileSecretStore,
  loadProviderCatalog,
} from "@core-agent/runtime-core";

import { DockerRuntimeAdapter } from "./docker-adapter.js";
import { OperationJournal } from "./operation-journal.js";
import { validateSupervisorPolicy } from "./policy.js";
import { RuntimeSupervisorServer } from "./server.js";

const configurationKeys = {
  socketPath: "CORE_AGENT_SUPERVISOR_SOCKET_PATH",
  journalRoot: "CORE_AGENT_SUPERVISOR_JOURNAL_ROOT",
  stagingRoot: "CORE_AGENT_SUPERVISOR_STAGING_ROOT",
  ingressRoot: "CORE_AGENT_SUPERVISOR_INGRESS_ROOT",
  secretRoot: "CORE_AGENT_SECRET_ROOT",
  dockerSocketPath: "CORE_AGENT_DOCKER_SOCKET_PATH",
  imageLockPath: "CORE_AGENT_IMAGE_LOCK_PATH",
  providerCatalogPath: "CORE_AGENT_PROVIDER_CATALOG_PATH",
} as const;

export interface SupervisorConfiguration {
  readonly socketPath: string;
  readonly journalRoot: string;
  readonly stagingRoot: string;
  readonly ingressRoot: string;
  readonly secretRoot: string;
  readonly dockerSocketPath: string;
  readonly imageLockPath: string;
  readonly providerCatalogPath: string;
}

function configurationError(): Error {
  return new Error("SUPERVISOR_REJECTED: Runtime Supervisor configuration is invalid");
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

export function readSupervisorConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): SupervisorConfiguration {
  return Object.fromEntries(
    Object.entries(configurationKeys).map(([field, key]) => [field, managedAbsolutePath(environment[key])]),
  ) as unknown as SupervisorConfiguration;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, { encoding: "utf8" })) as unknown;
  } catch {
    throw configurationError();
  }
}

export async function startRuntimeSupervisor(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<RuntimeSupervisorServer> {
  const configuration = readSupervisorConfiguration(environment);
  const imageLock = await readJson(configuration.imageLockPath);
  const providerCatalog = loadProviderCatalog(await readJson(configuration.providerCatalogPath));
  const adapter = new DockerRuntimeAdapter({
    docker: new Dockerode({ socketPath: configuration.dockerSocketPath }),
    secretStore: new FileSecretStore(configuration.secretRoot),
    imageLock,
    providerCatalog,
    stagingRoot: configuration.stagingRoot,
    ingressRoot: configuration.ingressRoot,
  });
  const server = new RuntimeSupervisorServer({
    socketPath: configuration.socketPath,
    journal: new OperationJournal({ directory: configuration.journalRoot }),
    validateRequest: (value) => validateSupervisorPolicy(value, { imageLock, providerCatalog }),
    execute: (request, signal) => adapter.execute(request, signal),
  });
  await server.start();
  return server;
}

async function run(): Promise<void> {
  let server: RuntimeSupervisorServer;
  try {
    server = await startRuntimeSupervisor();
  } catch {
    process.exitCode = 1;
    return;
  }
  const shutdown = (): void => {
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run();
}
