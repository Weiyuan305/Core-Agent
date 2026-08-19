import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import { buildClientGatewayApp, type BuildClientGatewayAppOptions } from "./app.js";
import { createRuntimeChatPort, type ManagedChatPort, type ManagedSession } from "./runtime-chat-port.js";

const DEFAULT_WEB_PORT = 4_173;
const WEB_PORT_ENVIRONMENT_NAME = "CORE_AGENT_WEB_PORT";
const SYNTHETIC_DEMO_ENVIRONMENT_NAME = "CORE_AGENT_WEB_SYNTHETIC_DEMO";
const PUBLIC_AUTH_ENVIRONMENT_NAME = "CORE_AGENT_WEB_PUBLIC_AUTH";
const IDENTITY_GATEWAY_URL_ENVIRONMENT_NAME = "CORE_AGENT_WEB_IDENTITY_GATEWAY_URL";
const PUBLIC_ORIGIN_ENVIRONMENT_NAME = "CORE_AGENT_WEB_PUBLIC_ORIGIN";

interface ManagedSessionRunnerOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly use: (session: ManagedSession) => Promise<unknown>;
}

interface LifecycleApp {
  readonly listen: (options: { readonly host: "127.0.0.1"; readonly port: number }) => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

interface LifecycleDependencies {
  readonly runManagedSession: (options: ManagedSessionRunnerOptions) => Promise<unknown>;
  readonly createPort: (session: ManagedSession) => ManagedChatPort;
  readonly buildApp: (options: BuildClientGatewayAppOptions) => Promise<LifecycleApp>;
}

export interface RunControlPlaneWebOptions {
  readonly controller?: AbortController;
  readonly environment?: NodeJS.ProcessEnv;
  readonly output?: (line: string) => void;
  readonly dependencies?: LifecycleDependencies;
}

function configurationError(): Error {
  return new Error("WEB_CONFIGURATION_INVALID");
}

function resolveWebPort(environment: NodeJS.ProcessEnv): number {
  const value = environment[WEB_PORT_ENVIRONMENT_NAME];
  if (value === undefined) return DEFAULT_WEB_PORT;
  if (!/^[1-9]\d{3,4}$/u.test(value)) throw configurationError();
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) throw configurationError();
  return port;
}

function managedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw configurationError();
  }
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (![
      WEB_PORT_ENVIRONMENT_NAME,
      SYNTHETIC_DEMO_ENVIRONMENT_NAME,
      PUBLIC_AUTH_ENVIRONMENT_NAME,
      IDENTITY_GATEWAY_URL_ENVIRONMENT_NAME,
      PUBLIC_ORIGIN_ENVIRONMENT_NAME,
    ].includes(key)) result[key] = value;
  }
  result.CORE_AGENT_REAL_HERMES_SMOKE = "1";
  return result;
}

type WebMode =
  | { readonly kind: "synthetic" }
  | { readonly kind: "public_auth"; readonly identityGatewayUrl: string; readonly publicOrigin: string };

function exactFlag(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw configurationError();
}

function exactOrigin(value: string | undefined, upstream: boolean): string {
  if (value === undefined) throw configurationError();
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (
      (upstream && (parsed.protocol !== "http:" || !loopback))
      || (!upstream && parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || (upstream && parsed.port === "")
    ) throw configurationError();
    return parsed.origin;
  } catch (error) {
    if (error instanceof Error && error.message === "WEB_CONFIGURATION_INVALID") throw error;
    throw configurationError();
  }
}

function resolveWebMode(environment: NodeJS.ProcessEnv): WebMode {
  const synthetic = exactFlag(environment[SYNTHETIC_DEMO_ENVIRONMENT_NAME]);
  const publicAuth = exactFlag(environment[PUBLIC_AUTH_ENVIRONMENT_NAME]);
  if (synthetic === publicAuth) throw configurationError();
  if (synthetic) {
    if (environment.NODE_ENV === "production") throw configurationError();
    return Object.freeze({ kind: "synthetic" });
  }
  return Object.freeze({
    kind: "public_auth",
    identityGatewayUrl: exactOrigin(environment[IDENTITY_GATEWAY_URL_ENVIRONMENT_NAME], true),
    publicOrigin: exactOrigin(environment[PUBLIC_ORIGIN_ENVIRONMENT_NAME], false),
  });
}

function resolveClientRoot(): string {
  const moduleDirectory = fileURLToPath(new URL(".", import.meta.url));
  return import.meta.url.endsWith(".ts")
    ? resolve(moduleDirectory, "../../dist/client")
    : resolve(moduleDirectory, "../../client");
}

async function loadManagedSessionRunner(options: ManagedSessionRunnerOptions): Promise<unknown> {
  const moduleUrl = new URL(
    "../../../../../scripts/lib/managed-runtime-session.mjs",
    import.meta.url,
  );
  const loaded: unknown = await import(moduleUrl.href);
  if (
    typeof loaded !== "object"
    || loaded === null
    || !("runManagedRuntimeSession" in loaded)
    || typeof loaded.runManagedRuntimeSession !== "function"
  ) throw configurationError();
  return loaded.runManagedRuntimeSession(options);
}

const defaultDependencies: LifecycleDependencies = Object.freeze({
  runManagedSession: loadManagedSessionRunner,
  createPort: createRuntimeChatPort,
  buildApp: (options: BuildClientGatewayAppOptions) => (
    buildClientGatewayApp(options) as Promise<FastifyInstance>
  ),
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

export async function runControlPlaneWeb(options: RunControlPlaneWebOptions = {}): Promise<void> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw configurationError();
  const environment = options.environment ?? process.env;
  const port = resolveWebPort(environment);
  const mode = resolveWebMode(environment);
  const controller = options.controller ?? new AbortController();
  if (!(controller instanceof AbortController)) throw configurationError();
  const output = options.output ?? ((line: string) => console.log(line));
  if (typeof output !== "function") throw configurationError();
  const dependencies = options.dependencies ?? defaultDependencies;

  const serve = async (app: LifecycleApp): Promise<void> => {
    try {
      await app.listen({ host: "127.0.0.1", port });
      output(`WEB_READY http://127.0.0.1:${port}`);
      await waitForAbort(controller.signal);
    } finally {
      await app.close();
    }
  };

  if (mode.kind === "public_auth") {
    await serve(await dependencies.buildApp({
      authProxy: { origin: mode.identityGatewayUrl, publicOrigin: mode.publicOrigin },
      staticRoot: resolveClientRoot(),
    }));
    return;
  }

  await dependencies.runManagedSession({
    environment: managedEnvironment(environment),
    signal: controller.signal,
    use: async (session) => serve(await dependencies.buildApp({
      port: dependencies.createPort(session),
      staticRoot: resolveClientRoot(),
    })),
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (!Array.isArray(argv) || argv.length !== 0 || argv.some((value) => typeof value !== "string")) {
    process.stderr.write("WEB_CONFIGURATION_INVALID\n");
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    await runControlPlaneWeb({ controller });
  } catch {
    process.stderr.write("WEB_FAILED\n");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void main();
}
