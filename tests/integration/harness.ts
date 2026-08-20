import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection, Socket } from "node:net";
import { spawn } from "node:child_process";

import type { ProductEvent, TrustedRequestContext } from "@core-agent/contracts";
import {
  HermesClient,
  RuntimeSupervisorClient,
  applyMigrations,
  canonicalJson,
  createRedactor,
  createRuntimeDatabase,
  deriveAgentRunId,
  deriveConversationId,
  encodeSignedTrustedContext,
  type RuntimeDatabase,
  type SecretMaterial,
  type SecretReference,
  type SecretStore,
} from "@core-agent/runtime-core";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";

import { buildControlPlaneApp } from "../../apps/control-plane-api/src/app.js";
import type {
  EventNotifier,
  EventWaitInput,
} from "../../apps/control-plane-api/src/sse.js";
import { HttpHermesReadinessClient } from "../../apps/control-plane-worker/src/hermes-readiness-client.js";
import {
  createWorkerRuntimeRepositories,
  runControlPlaneWorker,
  type WorkerClock,
  type WorkerLogger,
} from "../../apps/control-plane-worker/src/main.js";
import {
  encodeSupervisorFrame,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";
import { FakeHermes } from "./fakes/fake-hermes.js";
import {
  createFakeSupervisorState,
  FakeSupervisor,
  type FakeSupervisorState,
} from "./fakes/fake-supervisor.js";
import {
  SYNTHETIC_BOOTSTRAP_KEY,
  SYNTHETIC_INGRESS_KEY,
  syntheticB2BProvisioningRequest,
  syntheticConversationRequest,
  syntheticImageLock,
  syntheticProviderCatalog,
  syntheticRunRequest,
} from "./fixtures/synthetic-tenant.js";

export const LEAK_SENTINEL = "synthetic-leak-sentinel-4d83f17f";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDirectory = join(
  repositoryRoot,
  "packages",
  "runtime-core",
  "migrations",
);
const integrationTemporaryRoot = join(
  repositoryRoot,
  "tests",
  "integration",
  ".tmp",
);
const databaseNamePattern = /^core_agent_test_[a-f0-9]{16}$/;
// A fresh Docker Desktop VM can spend more than twelve seconds starting and
// reaping the two isolated PostgreSQL cleanup children while the test runner
// is CPU-bound. Keep the successful path unchanged, but reserve a realistic
// terminal deadline so cleanup does not report failure after the exact target
// has already been removed.
const externalStageTimeoutMs = 20_000;
const cleanupStageTimeoutMs = 2_000;
const sentinelScanNodeBudget = 100_000;
const integrationTrustedContextKey = generateKeyPairSync("ed25519");
const integrationTrustedContextKeyId = "key_integration_trusted_context";

type JsonRecord = Record<string, unknown>;

interface WakeHint {
  readonly tenant_id: string;
  readonly stream_id: string;
  readonly last_committed_sequence: number;
}

interface NotifierWaiter {
  readonly input: EventWaitInput;
  readonly finish: () => void;
}

interface DatabaseControlPool {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

interface DatabaseCreateSession {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface OwnedTerminalProcess {
  readonly completion: Promise<number>;
  failureCategory?(): "drop_database" | "admin_close";
  terminateAndReap(): Promise<void>;
}

function spawnOwnedTerminalProcess(scriptName: string, args: readonly string[]): OwnedTerminalProcess {
  const child = spawn(process.execPath, [
    join(repositoryRoot, "scripts", scriptName),
    ...args,
  ], { cwd: repositoryRoot, env: process.env, stdio: "ignore", detached: process.platform !== "win32" });
  let terminateRequested = false;
  const completion = new Promise<number>((resolve) => {
    let spawnFailed = false;
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code) => resolve(!spawnFailed && code === 0 ? 0 : 1));
  });
  return {
    completion,
    terminateAndReap: async () => {
      if (child.exitCode === null && !terminateRequested) {
        terminateRequested = true;
        try {
          if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
      }
      await completion;
    },
  };
}

function spawnOwnedCleanupProcess(args: readonly string[]): OwnedTerminalProcess {
  const child = spawn(process.execPath, [
    join(repositoryRoot, "scripts", "cleanup-test-database-child.mjs"), ...args,
  ], { cwd: repositoryRoot, env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"], detached: process.platform !== "win32" });
  let dropComplete = false;
  let terminateRequested = false;
  child.on("message", (message) => {
    if (message === "drop_complete") dropComplete = true;
  });
  const completion = new Promise<number>((resolve) => {
    let spawnFailed = false;
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code) => resolve(!spawnFailed && code === 0 ? 0 : 1));
  });
  return {
    completion,
    failureCategory: () => dropComplete ? "admin_close" : "drop_database",
    terminateAndReap: async () => {
      if (child.exitCode === null && !terminateRequested) {
        terminateRequested = true;
        try {
          if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { child.kill("SIGKILL"); }
      }
      await completion;
    },
  };
}

interface DatabaseAdminSession {
  connect(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  close(): Promise<void>;
  forceTerminate?(): TerminalOperation;
}

interface OwnedDatabaseResource {
  close(signal: AbortSignal): Promise<void>;
  forceClose(): Promise<void>;
  forceTerminate?(): TerminalOperation;
}

interface TerminalOperation {
  readonly completion: Promise<void>;
  terminateAndReap(): Promise<void>;
}

interface PoolLifecycleClient {
  release(destroy?: boolean): void;
}

interface PoolLifecycleEvents {
  on(event: "acquire" | "remove", listener: (client: PoolLifecycleClient) => void): unknown;
  on(event: "release", listener: (error: Error | undefined, client: PoolLifecycleClient) => void): unknown;
  removeListener(event: "acquire" | "remove", listener: (client: PoolLifecycleClient) => void): unknown;
  removeListener(event: "release", listener: (error: Error | undefined, client: PoolLifecycleClient) => void): unknown;
}

interface OwnedPostgresPool {
  readonly pool: Pool;
  terminatePreAuthConnections(): Promise<void>;
}

interface CleanupStage {
  readonly category: string;
  readonly work: () => Promise<void>;
  readonly failureCategory?: (error: unknown) => string;
  readonly timeoutMs?: number;
}

interface SentinelScan {
  readonly detected: boolean;
  readonly incomplete: boolean;
  readonly incompleteCategories: readonly string[];
}

interface StructuredLogCapture {
  readonly category: string;
  readonly fields: unknown;
  readonly message: string | undefined;
  readonly sentinelScan: SentinelScan;
}

function runWithDeadline<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Integration stage timed out")));
    }, timeoutMs);
    void Promise.resolve().then(work).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function boundedExternal<T>(
  category: string,
  work: () => Promise<T>,
  timeoutMs = externalStageTimeoutMs,
): Promise<T> {
  try {
    return await runWithDeadline(work, timeoutMs);
  } catch {
    throw new Error(`Integration stage failed: ${category}`);
  }
}

async function runCleanupStages(
  stages: readonly CleanupStage[],
  timeoutMs = cleanupStageTimeoutMs,
): Promise<string[]> {
  const failures: string[] = [];
  for (const stage of stages) {
    try {
      await runWithDeadline(stage.work, stage.timeoutMs ?? timeoutMs);
    } catch (error) {
      let category = stage.category;
      try {
        category = stage.failureCategory?.(error) ?? category;
      } catch {
        category = stage.category;
      }
      failures.push(category);
    }
  }
  return failures;
}

class PostgresEventNotifier implements EventNotifier {
  readonly #client: Client;
  readonly #waiters = new Set<NotifierWaiter>();
  readonly hints: WakeHint[] = [];
  waitCount = 0;
  #dropCount = 0;

  public constructor(databaseUrl: string) {
    this.#client = new Client({ connectionString: databaseUrl });
    this.#client.on("error", () => {
      // Teardown can terminate LISTEN connections after close has begun.
    });
  }

  public async start(): Promise<void> {
    this.#client.on("notification", (message) => {
      if (message.channel !== "core_agent_events" || message.payload === undefined) return;
      let hint: WakeHint;
      try {
        const value = JSON.parse(message.payload) as unknown;
        if (
          typeof value !== "object"
          || value === null
          || typeof (value as WakeHint).tenant_id !== "string"
          || typeof (value as WakeHint).stream_id !== "string"
          || !Number.isSafeInteger((value as WakeHint).last_committed_sequence)
        ) return;
        hint = value as WakeHint;
      } catch {
        return;
      }
      this.hints.push(Object.freeze({ ...hint }));
      if (this.#dropCount > 0) {
        this.#dropCount -= 1;
        return;
      }
      for (const waiter of [...this.#waiters]) {
        if (
          waiter.input.tenantId === hint.tenant_id
          && waiter.input.streamId === hint.stream_id
        ) waiter.finish();
      }
    });
    await this.#client.connect();
    await this.#client.query("listen core_agent_events");
  }

  public dropNext(count = 1): void {
    this.#dropCount += count;
  }

  public async wait(input: EventWaitInput): Promise<void> {
    if (input.signal.aborted) return;
    this.waitCount += 1;
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", finish);
        this.#waiters.delete(waiter);
        resolve();
      };
      const waiter: NotifierWaiter = { input, finish };
      const timer = setTimeout(finish, 75);
      this.#waiters.add(waiter);
      input.signal.addEventListener("abort", finish, { once: true });
      if (input.signal.aborted) finish();
    });
  }

  public async close(): Promise<void> {
    for (const waiter of [...this.#waiters]) waiter.finish();
    await this.#client.end();
  }
}

function sleep(milliseconds: number): Promise<void> {
  assert(milliseconds <= 250, "integration sleeps must not exceed 250ms");
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function until<T>(
  load: () => Promise<T>,
  accepts: (value: T) => boolean,
  category: string,
  timeoutMs = 6_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await load();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${category}`);
    await sleep(25);
  }
}

function databaseUrlFor(controlUrl: URL, databaseName: string): string {
  const value = new URL(controlUrl);
  value.pathname = `/${databaseName}`;
  return value.toString();
}

function combineSetupAndCleanupFailure(error: unknown, cleanupFailures: readonly string[]): Error {
  if (cleanupFailures.length === 0) {
    return error instanceof Error ? error : new Error("Integration setup failed");
  }
  const combined = new Error(
    `Integration setup failed; cleanup failed: ${cleanupFailures.join(", ")}`,
    { cause: error },
  );
  Object.defineProperty(combined, "cleanupFailures", {
    configurable: false,
    enumerable: true,
    value: Object.freeze([...cleanupFailures]),
    writable: false,
  });
  return combined;
}

async function cleanupAfterSetupFailure(error: unknown, stages: readonly CleanupStage[]): Promise<never> {
  const cleanupFailures = await runCleanupStages(stages);
  throw combineSetupAndCleanupFailure(error, cleanupFailures);
}

function runBeforeDeadline<T>(deadline: number, work: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) return Promise.reject(new Error("Integration stage timed out"));
  return runWithDeadline(work, remaining);
}

async function settlesBefore(promise: Promise<void>, deadline: number, now: () => number = Date.now): Promise<boolean> {
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleOwnedDatabaseResource(
  resource: OwnedDatabaseResource,
  gracefulBudgetMs: number,
  forceBudgetMs: number,
  now: () => number = Date.now,
): Promise<{ readonly close: Promise<void>; readonly failure: () => unknown; readonly terminal: () => boolean }> {
  const controller = new AbortController();
  let failure: unknown;
  let terminal = false;
  const close = Promise.resolve()
    .then(() => resource.close(controller.signal))
    .catch((error: unknown) => { failure = error; })
    .finally(() => { terminal = true; });
  if (!await settlesBefore(close, now() + gracefulBudgetMs, now)) {
    controller.abort();
    const abortGraceBudgetMs = Math.min(5, Math.max(1, Math.floor(forceBudgetMs / 2)));
    const abortGraceDeadline = now() + abortGraceBudgetMs;
    if (!await settlesBefore(close, abortGraceDeadline, now)) {
      try {
        const force = Promise.resolve().then(() => resource.forceClose());
        // Start the force deadline after the abort observation. Reusing a
        // deadline captured before that timer fires makes a delayed event-loop
        // turn misclassify an immediately successful force close as a timeout.
        const forceDeadline = now() + Math.max(1, forceBudgetMs - abortGraceBudgetMs);
        if (!await settlesBefore(force.then(() => undefined, () => undefined), forceDeadline, now)) {
          failure = new Error("Integration owned database force timed out");
        } else {
          await force;
        }
      } catch (error) {
        failure = failure === undefined
          ? error
          : new AggregateError([failure, error], "Integration owned database close failed");
      }
    }
  }
  // The later owned-terminal phase has its own reserved slice. Only observe an
  // immediately settled close here; do not spend that later phase's budget.
  await Promise.resolve();
  return { close, failure: () => failure, terminal: () => terminal };
}

function trackPostgresPool(
  pool: PoolLifecycleEvents,
  close: () => Promise<void>,
  terminatePreAuthConnections: () => Promise<void> = async () => undefined,
): OwnedDatabaseResource {
  type PoolOwnershipState = "open" | "closing" | "forcing" | "settled";
  let state: PoolOwnershipState = "open";
  const checkedOut = new Set<PoolLifecycleClient>();
  const forced = new WeakSet<PoolLifecycleClient>();
  const drainTasks = new Set<Promise<void>>();
  const forceFailures: unknown[] = [];
  const releaseOwnership = (client: PoolLifecycleClient): void => {
    checkedOut.delete(client);
  };
  const scheduleForce = (client: PoolLifecycleClient): void => {
    let task: Promise<void>;
    task = Promise.resolve().then(() => {
      if (state !== "forcing" || !checkedOut.has(client) || forced.has(client)) return;
      checkedOut.delete(client);
      forced.add(client);
      try {
        client.release(true);
      } catch (error) {
        forceFailures.push(error);
      }
    }).finally(() => drainTasks.delete(task));
    drainTasks.add(task);
  };
  const onAcquire = (client: PoolLifecycleClient): void => {
    checkedOut.add(client);
    if (state === "forcing") scheduleForce(client);
  };
  const onRelease = (_error: Error | undefined, client: PoolLifecycleClient): void => releaseOwnership(client);
  const onRemove = (client: PoolLifecycleClient): void => releaseOwnership(client);
  pool.on("acquire", onAcquire);
  pool.on("release", onRelease);
  pool.on("remove", onRemove);
  let rawClosePromise: Promise<void> | undefined;
  let terminalClosePromise: Promise<void> | undefined;
  const settle = (): void => {
    if (state === "settled") return;
    state = "settled";
    checkedOut.clear();
    drainTasks.clear();
    pool.removeListener("acquire", onAcquire);
    pool.removeListener("release", onRelease);
    pool.removeListener("remove", onRemove);
  };
  const startClose = (): Promise<void> => {
    if (rawClosePromise === undefined) {
      if (state === "open") state = "closing";
      rawClosePromise = Promise.resolve().then(close);
      terminalClosePromise = (async () => {
        let closeFailure: unknown;
        try {
          await rawClosePromise;
        } catch (error) {
          closeFailure = error;
        }
        while (drainTasks.size > 0) await Promise.all([...drainTasks]);
        settle();
        if (closeFailure !== undefined && forceFailures.length > 0) {
          throw new AggregateError(
            [closeFailure, ...forceFailures],
            "Integration owned database close failed",
          );
        }
        if (closeFailure !== undefined) throw closeFailure;
        if (forceFailures.length > 0) {
          throw new AggregateError(forceFailures, "Integration owned database force close failed");
        }
      })();
    }
    return terminalClosePromise!;
  };
  return {
    close: async () => {
      await startClose();
    },
    forceClose: async () => {
      startClose();
      if (state === "settled") return;
      state = "forcing";
      for (const client of [...checkedOut]) scheduleForce(client);
      while (drainTasks.size > 0) await Promise.all([...drainTasks]);
    },
    forceTerminate: () => {
      const completion = (async () => {
        if (state !== "settled") {
          state = "forcing";
          for (const client of [...checkedOut]) scheduleForce(client);
          while (drainTasks.size > 0) await Promise.all([...drainTasks]);
        }
        await startClose();
      })();
      return {
        completion,
        terminateAndReap: async () => {
          await terminatePreAuthConnections();
          if (state !== "settled") {
            state = "forcing";
            for (const client of [...checkedOut]) scheduleForce(client);
            while (drainTasks.size > 0) await Promise.all([...drainTasks]);
          }
          await completion;
        },
      };
    },
  };
}

function createOwnedPostgresPool(options: PoolConfig): OwnedPostgresPool {
  const poolOptions = cloneOwnedPostgresPoolConfig(options);
  const preAuthSockets = new Set<Socket>();
  class OwnedClient extends Client {
    public readonly ownedPreAuthSocket: Socket;

    public constructor(config?: ClientConfig) {
      let ownedSocket: Socket | undefined;
      super({
        ...config,
        stream: () => {
          const socket = new Socket();
          ownedSocket = socket;
          preAuthSockets.add(socket);
          socket.once("close", () => preAuthSockets.delete(socket));
          return socket;
        },
      });
      assert(ownedSocket !== undefined);
      this.ownedPreAuthSocket = ownedSocket;
    }
  }
  const pool = new Pool({
    ...poolOptions,
    Client: OwnedClient as unknown as NonNullable<PoolConfig["Client"]>,
  });
  pool.on("connect", (client) => {
    preAuthSockets.delete((client as OwnedClient).ownedPreAuthSocket);
  });
  return {
    pool,
    terminatePreAuthConnections: async () => {
      const sockets = [...preAuthSockets];
      await Promise.all(sockets.map(async (socket) => {
        if (socket.closed) return;
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        if (!socket.destroyed) socket.destroy();
        await closed;
      }));
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

const inertTlsFields = new Set([
  "ca", "cert", "ciphers", "key", "maxVersion", "minVersion", "passphrase",
  "rejectUnauthorized", "servername",
]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArraySet = Uint8Array.prototype.set;

function cloneBoundedTlsBytes(value: unknown, field: string): string | Buffer | readonly (string | Buffer)[] {
  const cloneOne = (item: unknown): string | Buffer => {
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > 1_048_576) {
        throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} is too large`);
      }
      return item;
    }
    if (Buffer.isBuffer(item)) {
      if (typedArrayByteLengthGetter === undefined) {
        throw new Error("Integration PostgreSQL pool TLS buffer validation is unavailable");
      }
      let byteLength: number;
      try {
        byteLength = Reflect.apply(typedArrayByteLengthGetter, item, []) as number;
      } catch {
        throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} must contain strings or buffers`);
      }
      if (byteLength > 1_048_576) {
        throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} is too large`);
      }
      const clone = Buffer.alloc(byteLength);
      Reflect.apply(typedArraySet, clone, [item]);
      return clone;
    }
    throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} must contain strings or buffers`);
  };
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} must be an exact inert array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.enumerable
      || lengthDescriptor.configurable
      || !lengthDescriptor.writable
    ) {
      throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} must be an exact inert array`);
    }
    const length = lengthDescriptor.value as number;
    if (length > 32) {
      throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} has too many entries`);
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1
      || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)))
    ) {
      throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} must be an exact inert array`);
    }
    const clone: Array<string | Buffer> = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`Integration PostgreSQL pool TLS configuration field ${field} must be an exact inert array`);
      }
      clone.push(cloneOne(descriptor.value));
    }
    return Object.freeze(clone);
  }
  return cloneOne(value);
}

function cloneOwnedTlsConfiguration(value: unknown): PoolConfig["ssl"] {
  if (value === undefined || typeof value === "boolean") return value;
  if (value === null || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("Integration PostgreSQL pool TLS configuration must be a plain object");
  }
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error("Integration PostgreSQL pool TLS configuration must contain only string fields");
    }
    if (!inertTlsFields.has(key)) {
      throw new Error(`Integration PostgreSQL pool TLS configuration contains an unsafe field: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Integration PostgreSQL pool TLS configuration must contain only plain data properties");
    }
    const fieldValue = descriptor.value;
    switch (key) {
      case "rejectUnauthorized":
        if (typeof fieldValue !== "boolean") {
          throw new Error("Integration PostgreSQL pool TLS configuration field rejectUnauthorized must be a boolean");
        }
        clone[key] = fieldValue;
        break;
      case "servername":
        if (typeof fieldValue !== "string" || fieldValue.length < 1 || fieldValue.length > 253 || fieldValue.includes("\0")) {
          throw new Error("Integration PostgreSQL pool TLS configuration field servername must be a bounded non-empty string");
        }
        clone[key] = fieldValue;
        break;
      case "minVersion":
      case "maxVersion":
        if (fieldValue !== "TLSv1.2" && fieldValue !== "TLSv1.3") {
          throw new Error(`Integration PostgreSQL pool TLS configuration field ${key} must be TLSv1.2 or TLSv1.3`);
        }
        clone[key] = fieldValue;
        break;
      case "ciphers":
        if (typeof fieldValue !== "string" || fieldValue.length < 1 || fieldValue.length > 8_192 || fieldValue.includes("\0")) {
          throw new Error("Integration PostgreSQL pool TLS configuration field ciphers must be a bounded non-empty string");
        }
        clone[key] = fieldValue;
        break;
      case "passphrase":
        if (typeof fieldValue !== "string" || fieldValue.length > 4_096 || fieldValue.includes("\0")) {
          throw new Error("Integration PostgreSQL pool TLS configuration field passphrase must be a bounded string");
        }
        clone[key] = fieldValue;
        break;
      case "ca":
      case "cert":
      case "key":
        clone[key] = cloneBoundedTlsBytes(fieldValue, key);
        break;
      default:
        assert.fail(`unhandled inert TLS field: ${key}`);
    }
  }
  return clone as PoolConfig["ssl"];
}

function cloneOwnedPostgresPoolConfig(options: PoolConfig): PoolConfig {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new Error("Integration PostgreSQL pool configuration must be a plain object");
  }
  const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string") {
      throw new Error("Integration PostgreSQL pool configuration must contain only string fields");
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Integration PostgreSQL pool configuration must contain only plain data properties");
    }
    if ((key === "stream" || key === "Client") && descriptor.value !== undefined) {
      throw new Error("Integration PostgreSQL pool requires the owned connector");
    }
    if (key === "ssl") {
      clone[key] = cloneOwnedTlsConfiguration(descriptor.value);
    } else {
      clone[key] = descriptor.value;
    }
  }
  return clone as PoolConfig;
}

async function settleTerminalOperation(operation: TerminalOperation, budgetMs: number): Promise<void> {
  if (!await settlesBefore(operation.completion, Date.now() + budgetMs)) {
    await operation.terminateAndReap();
  }
  await operation.completion;
}

function databaseCleanupBudgets(timeoutMs: number, productionBudget: boolean, hasOwnedResources: boolean) {
  const phaseBudget = (fraction: number): number => Math.max(5, Math.floor(timeoutMs * fraction));
  return Object.freeze({
    gracefulBudgetMs: phaseBudget(productionBudget ? 0.05 : 0.1),
    forceBudgetMs: phaseBudget(productionBudget ? 0.05 : 0.1),
    terminateBudgetMs: phaseBudget(hasOwnedResources
      ? (productionBudget ? 0.3 : 0.2)
      : 0.3),
    ownedTerminalBudgetMs: phaseBudget(productionBudget ? 0.15 : 0.2),
    dropBudgetMs: phaseBudget(hasOwnedResources
      ? (productionBudget ? 0.4 : 0.3)
      : 0.65),
    adminCloseBudgetMs: phaseBudget(productionBudget && hasOwnedResources
      ? 0.05
      : hasOwnedResources ? 0.1 : 0.05),
  });
}

async function dropIsolatedDatabase(options: {
  readonly databaseName: string;
  readonly controlDatabaseUrl?: string;
  readonly closeOwned: readonly OwnedDatabaseResource[];
  readonly createAdminSession?: () => DatabaseAdminSession;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly now?: () => number;
}): Promise<void> {
  assert.match(options.databaseName, databaseNamePattern);
  const timeoutMs = options.timeoutMs ?? externalStageTimeoutMs;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const now = options.now ?? Date.now;
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert(Number.isSafeInteger(retryDelayMs) && retryDelayMs > 0 && retryDelayMs <= 250);
  // Each terminal phase owns a fresh bounded slice. A slow terminate or owned-resource
  // handoff therefore cannot consume the DROP/absence or admin-close budget.
  const productionBudget = timeoutMs >= externalStageTimeoutMs;
  // The production path spends most of its fixed budget on the two killable
  // PostgreSQL child operations. Docker-forwarded connect/query/close can
  // legitimately exceed the smaller in-process slices under scheduler load;
  // graceful and force handoff remain independently bounded and terminal.
  const hasOwnedResources = options.closeOwned.length > 0;
  const {
    gracefulBudgetMs,
    forceBudgetMs,
    terminateBudgetMs,
    ownedTerminalBudgetMs,
    dropBudgetMs,
    adminCloseBudgetMs,
  } = databaseCleanupBudgets(timeoutMs, productionBudget, hasOwnedResources);
  // When there are no owned resources, transfer their unused slices to the
  // killable children while preserving a viable startup slice and total bound.
  const ownedFailures: string[] = [];
  const ownedSettlements: Array<{
    readonly index: number;
    readonly close: Promise<void>;
    readonly failure: () => unknown;
    readonly terminal: () => boolean;
  }> = [];
  for (const [index, resource] of options.closeOwned.entries()) {
    try {
      const settlement = await settleOwnedDatabaseResource(resource, gracefulBudgetMs, forceBudgetMs, now);
      ownedSettlements.push({ index, ...settlement });
    } catch {
      ownedFailures.push(`owned database connection ${index + 1}`);
    }
  }
  const settleOwnedTerminally = async (): Promise<void> => {
    const terminalDeadline = now() + ownedTerminalBudgetMs;
    await Promise.all(ownedSettlements.map(async (settlement) => {
      const terminal = settlement.terminal()
        || await settlesBefore(settlement.close, Math.min(terminalDeadline, now() + 25), now);
      if (!terminal) {
        const resource = options.closeOwned[settlement.index]!;
        try {
          if (resource.forceTerminate === undefined) throw new Error("missing terminal owner protocol");
          const remaining = Math.max(1, terminalDeadline - now());
          await settleTerminalOperation(resource.forceTerminate(), remaining);
        } catch {
          ownedFailures.push(`owned database connection ${settlement.index + 1}`);
        }
      } else {
        await settlement.close;
      }
      if (settlement.failure() !== undefined) ownedFailures.push(`owned database connection ${settlement.index + 1}`);
    }));
  };
  if (options.createAdminSession === undefined) {
    if (options.controlDatabaseUrl === undefined) throw new Error("Integration stage failed: database drop");
    let cleanupControlUrl: URL;
    try { cleanupControlUrl = new URL(options.controlDatabaseUrl); }
    catch { throw new Error("Integration stage failed: database drop"); }
    if (cleanupControlUrl.password !== "") throw new Error("Integration stage failed: database drop");
    type CleanupChildStatus = "completed" | "incomplete" | "failed";
    const runCleanupChild = async (operation: "terminate" | "drop", budgetMs: number): Promise<CleanupChildStatus> => {
      const deadline = Date.now() + budgetMs;
      const transientSpawnCodes = new Set(["EAGAIN", "EMFILE", "ENFILE"]);
      while (true) {
        const remaining = Math.max(1, deadline - Date.now());
        const child = spawn(process.execPath, [
          join(repositoryRoot, "scripts", "cleanup-test-database-child.mjs"),
          operation,
          options.controlDatabaseUrl!,
          options.databaseName,
          String(remaining),
        ], {
          cwd: repositoryRoot,
          env: process.env,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          detached: process.platform !== "win32",
        });
        let dropComplete = false;
        child.on("message", (message) => {
          if (message === "drop_complete") dropComplete = true;
        });
        let timer: NodeJS.Timeout | undefined;
        const outcome = await new Promise<{
          readonly status: CleanupChildStatus;
          readonly transientSpawnFailure: boolean;
        }>((resolve) => {
          let settled = false;
          const finish = (status: CleanupChildStatus, transientSpawnFailure = false): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            resolve({ status, transientSpawnFailure });
          };
          child.once("error", (error: NodeJS.ErrnoException) => {
            finish("failed", error.code !== undefined && transientSpawnCodes.has(error.code));
          });
          child.once("close", (code) => {
            if (operation === "drop" && dropComplete) finish("completed");
            else if (code === 0) finish("completed");
            else if (operation === "terminate" && (code === 4 || code === null)) finish("incomplete");
            else finish("failed");
          });
          timer = setTimeout(() => {
            try {
              if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch { child.kill("SIGKILL"); }
          }, remaining);
        });
        if (!outcome.transientSpawnFailure || Date.now() >= deadline) return outcome.status;
        await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    };
    await settleOwnedTerminally();
    // One killable child repeatedly terminates only exact target-database
    // backends, performs a plain DROP, and proves catalog absence. Keeping the
    // terminate and DROP loop in one process closes the late-backend race
    // without relying on an uninterruptible DROP ... WITH (FORCE).
    const dropStatus = await runCleanupChild("drop", terminateBudgetMs + dropBudgetMs);
    const failures = [
      ...(dropStatus === "completed" ? [] : ["database drop"]),
      ...(ownedFailures.length > 0 ? ["owned database connections"] : []),
    ];
    if (failures.length === 1) throw new Error(`Integration stage failed: ${failures[0]}`);
    if (failures.length > 1) throw new Error(`Integration teardown failed: ${failures.join(", ")}`);
    return;
  }
  const admin = options.createAdminSession();
  let dropped = false;
  let closeFailed = false;
  let adminReady = false;
  let databaseFailed = false;
  try {
    try {
      const terminateDeadline = now() + terminateBudgetMs;
      await runBeforeDeadline(terminateDeadline, () => admin.connect(), now);
      adminReady = true;
      await runBeforeDeadline(terminateDeadline, () => admin.query(
        `select pg_terminate_backend(pid)
         from pg_stat_activity
         where datname = $1 and pid <> pg_backend_pid()`,
        [options.databaseName],
      ), now);
    } catch {
      databaseFailed = true;
    }
    await settleOwnedTerminally();
    if (!adminReady) throw new Error("Integration stage failed: database drop");
    const dropDeadline = now() + dropBudgetMs;
    while (!dropped) {
      try {
        await runBeforeDeadline(dropDeadline, () => admin.query(`drop database if exists "${options.databaseName}"`), now);
        const verification = await runBeforeDeadline(dropDeadline, () => admin.query(
          "select exists (select 1 from pg_database where datname = $1) as exists",
          [options.databaseName],
        ), now);
        dropped = verification.rows[0]?.exists === false;
      } catch {
        dropped = false;
      }
      if (dropped) break;
      if (now() >= dropDeadline) throw new Error("Integration stage failed: database drop");
      if (retryDelayMs === 1) await Promise.resolve();
      else await runBeforeDeadline(dropDeadline, () => sleep(retryDelayMs), now);
    }
    if (databaseFailed) throw new Error("Integration stage failed: database drop");
  } catch {
    databaseFailed = true;
  } finally {
    try {
      const closeDeadline = now() + adminCloseBudgetMs;
      await runBeforeDeadline(closeDeadline, () => admin.close(), now);
    } catch {
      closeFailed = true;
      try {
        if (admin.forceTerminate === undefined) throw new Error("missing admin terminal protocol");
        await settleTerminalOperation(admin.forceTerminate(), adminCloseBudgetMs);
      } catch {
        // The stable admin-close category already records terminalization failure.
      }
    }
  }
  const failureCategories = [
    ...(databaseFailed ? ["database drop"] : []),
    ...(ownedFailures.length > 0 ? ["owned database connections"] : []),
    ...(closeFailed ? ["database admin close"] : []),
  ];
  if (failureCategories.length === 1) throw new Error(`Integration stage failed: ${failureCategories[0]}`);
  if (failureCategories.length > 1) throw new Error(`Integration teardown failed: ${failureCategories.join(", ")}`);
}

async function createIsolatedDatabase(options: {
  readonly configuredUrl?: string;
  readonly databaseName?: string;
  readonly createSession?: DatabaseCreateSession;
  readonly controlPool?: DatabaseControlPool;
  readonly cleanupControlPool?: DatabaseControlPool;
  readonly createOwnedProcess?: (input: {
    readonly controlDatabaseUrl: string;
    readonly databaseName: string;
    readonly timeoutMs: number;
  }) => OwnedTerminalProcess;
  readonly createCleanupOwnedProcess?: (input: {
    readonly controlDatabaseUrl: string;
    readonly databaseName: string;
    readonly timeoutMs: number;
  }) => OwnedTerminalProcess;
  readonly timeoutMs?: number;
} = {}): Promise<{
  readonly controlPool: DatabaseControlPool;
  readonly controlDatabaseUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
}> {
  const configured = options.configuredUrl
    ?? process.env.CONTROL_PLANE_TEST_DATABASE_URL;
  if (configured === undefined) {
    throw new Error("CONTROL_PLANE_TEST_DATABASE_URL is required for integration tests");
  }
  const controlUrl = new URL(configured);
  if (!controlUrl.pathname.slice(1).startsWith("core_agent_")) {
    throw new Error("Integration control PostgreSQL database is not disposable");
  }
  const databaseName = options.databaseName
    ?? `core_agent_test_${randomBytes(8).toString("hex")}`;
  assert.match(databaseName, databaseNamePattern);
  const timeoutMs = options.timeoutMs ?? externalStageTimeoutMs;
  if (options.createSession === undefined && controlUrl.password !== "") {
    throw new Error("Integration stage failed: database create");
  }
  const createOwnedProcess = options.createOwnedProcess ?? ((input): OwnedTerminalProcess =>
    spawnOwnedTerminalProcess("create-test-database-child.mjs", [
      input.controlDatabaseUrl, input.databaseName, String(input.timeoutMs),
    ]));
  const createCleanupOwnedProcess = options.createCleanupOwnedProcess ?? ((input): OwnedTerminalProcess =>
    spawnOwnedCleanupProcess([
      "drop", input.controlDatabaseUrl, input.databaseName, String(input.timeoutMs),
    ]));
  const createClient = options.createSession === undefined
    ? new Client({
        connectionString: controlUrl.toString(),
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        statement_timeout: timeoutMs,
      })
    : undefined;
  const createSession = options.createSession ?? {
    connect: () => createClient!.connect(),
    query: (sql: string) => createClient!.query(sql),
    close: () => createClient!.end(),
  };
  if (options.createSession === undefined) {
    let createProcess: OwnedTerminalProcess | undefined;
    try {
      createProcess = createOwnedProcess({
        controlDatabaseUrl: controlUrl.toString(), databaseName, timeoutMs,
      });
      const status = await runWithDeadline(() => createProcess!.completion, timeoutMs);
      if (status !== 0) throw new Error("Integration stage failed: database create");
    } catch (error) {
      const createError = error instanceof Error && error.message === "Integration stage failed: database create"
        ? error
        : new Error("Integration stage failed: database create", { cause: error });
      const cleanupFailures: string[] = [];
      if (createProcess !== undefined) {
        try { await createProcess.terminateAndReap(); }
        catch { cleanupFailures.push("create_cancellation"); }
      }
      if (!cleanupFailures.includes("create_cancellation")) {
        let cleanupProcess: OwnedTerminalProcess | undefined;
        try {
          cleanupProcess = createCleanupOwnedProcess({
            controlDatabaseUrl: controlUrl.toString(), databaseName, timeoutMs,
          });
          const status = await runWithDeadline(() => cleanupProcess!.completion, timeoutMs);
          if (status !== 0) cleanupFailures.push(cleanupProcess.failureCategory?.() ?? "drop_database");
        } catch {
          cleanupFailures.push(cleanupProcess?.failureCategory?.() ?? "drop_database");
          if (cleanupProcess !== undefined) {
            try { await cleanupProcess.terminateAndReap(); }
            catch { cleanupFailures.push("admin_close"); }
          }
        }
      }
      throw combineSetupAndCleanupFailure(createError, cleanupFailures);
    }
    const controlPool = options.controlPool ?? new Pool({
      connectionString: controlUrl.toString(), max: 2,
      connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs,
    });
    return {
      controlPool,
      controlDatabaseUrl: controlUrl.toString(),
      databaseName,
      databaseUrl: databaseUrlFor(controlUrl, databaseName),
    };
  }
  const controlPool = options.controlPool ?? new Pool({
    connectionString: controlUrl.toString(), max: 2,
    connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs,
  });
  let createOperation: Promise<void> | undefined;
  try {
    await boundedExternal(
      "database create connect",
      () => createSession.connect(),
      timeoutMs,
    );
    createOperation = Promise.resolve().then(async () => {
      await createSession.query(`create database "${databaseName}"`);
    });
    await boundedExternal(
      "database create",
      () => createOperation,
      timeoutMs,
    );
    await boundedExternal(
      "database create session close",
      () => createSession.close(),
      timeoutMs,
    );
  } catch (error) {
    const cleanupFailures: string[] = [];
    let cancellationConfirmed = false;
    try {
      const results = await runWithDeadline(
        () => Promise.allSettled([
          createSession.close(),
          createOperation ?? Promise.resolve(),
        ]),
        timeoutMs,
      );
      cancellationConfirmed = true;
      if (results[0]?.status !== "fulfilled") cleanupFailures.push("create_session_close");
    } catch {
      cancellationConfirmed = false;
      cleanupFailures.push("create_cancellation");
    }
    if (!cancellationConfirmed) {
      cleanupFailures.push(...await runCleanupStages([
        { category: "control_pool_close", work: () => controlPool.end() },
        ...(options.cleanupControlPool === undefined ? [] : [{
          category: "admin_close",
          work: () => options.cleanupControlPool!.end(),
        }]),
      ], timeoutMs));
      throw combineSetupAndCleanupFailure(error, cleanupFailures);
    }
    const cleanupControlPool = options.cleanupControlPool ?? new Pool({
      connectionString: controlUrl.toString(),
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs,
    });
    cleanupFailures.push(...await runCleanupStages([
      {
        category: "drop_database",
        work: async () => {
          await cleanupControlPool.query(
            `drop database if exists "${databaseName}" with (force)`,
          );
        },
      },
      { category: "control_pool_close", work: () => controlPool.end() },
      ...(cleanupControlPool === controlPool ? [] : [{
        category: "admin_close",
        work: () => cleanupControlPool.end(),
      }]),
    ], timeoutMs));
    throw combineSetupAndCleanupFailure(error, cleanupFailures);
  }
  return {
    controlPool,
    controlDatabaseUrl: controlUrl.toString(),
    databaseName,
    databaseUrl: databaseUrlFor(controlUrl, databaseName),
  };
}

function rewriteToFakeHermes(
  fake: FakeHermes,
  onAttempt: (kind: "readiness" | "execution") => void,
): typeof fetch {
  return async (input, init) => {
    let kind: "readiness" | "execution" = "execution";
    try {
      const body = JSON.parse(String(init?.body)) as { stream?: unknown };
      if (body.stream === false) kind = "readiness";
    } catch {
      // The real client and fake server remain responsible for body validity.
    }
    onAttempt(kind);
    const managed = new URL(String(input));
    const target = new URL(fake.origin);
    target.pathname = managed.pathname;
    target.search = managed.search;
    return fetch(target, init);
  };
}

function safeStructuredValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): { readonly snapshot: unknown; readonly incomplete: boolean } {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || value === undefined
  ) return { snapshot: value, incomplete: false };
  if (typeof value === "bigint") {
    return { snapshot: "bigint", incomplete: false };
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return { snapshot: typeof value, incomplete: false };
  }
  if (depth >= 6) {
    return { snapshot: typeof value, incomplete: true };
  }
  if (seen.has(value)) return { snapshot: "circular", incomplete: false };
  seen.add(value);
  let keys: readonly PropertyKey[];
  try { keys = Reflect.ownKeys(value); }
  catch {
    return {
      snapshot: { category: "unscannable" },
      incomplete: true,
    };
  }
  let isArray: boolean;
  try { isArray = Array.isArray(value); }
  catch {
    return {
      snapshot: { category: "unscannable" },
      incomplete: true,
    };
  }
  if (!isArray) {
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return {
          snapshot: { category: "nonplain" },
          incomplete: false,
        };
      }
    } catch {
      return {
        snapshot: { category: "unscannable" },
        incomplete: true,
      };
    }
  }
  if (isArray) {
    const result: unknown[] = [];
    let incomplete = false;
    for (const key of keys) {
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) continue;
      if (result.length >= 100) {
        incomplete = true;
        break;
      }
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
      catch {
        return {
          snapshot: { category: "unscannable" },
          incomplete: true,
        };
      }
      if (descriptor !== undefined && "value" in descriptor) {
        const child = safeStructuredValue(descriptor.value, depth + 1, seen);
        result.push(child.snapshot);
        incomplete ||= child.incomplete;
      } else if (descriptor === undefined) {
        incomplete = true;
      }
    }
    return { snapshot: result, incomplete };
  }
  const result: Record<string, unknown> = Object.create(null);
  let incomplete = keys.length > 100;
  for (const key of keys.slice(0, 100)) {
    if (typeof key !== "string") continue;
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
    catch {
      return {
        snapshot: { category: "unscannable" },
        incomplete: true,
      };
    }
    if (descriptor !== undefined && "value" in descriptor && descriptor.enumerable) {
      const child = safeStructuredValue(descriptor.value, depth + 1, seen);
      result[key] = child.snapshot;
      incomplete ||= child.incomplete;
    } else if (descriptor === undefined) {
      incomplete = true;
    }
  }
  return { snapshot: result, incomplete };
}

function scanSentinel(...roots: readonly unknown[]): SentinelScan {
  const pending = [...roots];
  const seen = new WeakSet<object>();
  let visited = 0;
  let incomplete = false;
  const incompleteCategories = new Set<string>();
  while (pending.length > 0) {
    visited += 1;
    if (visited > sentinelScanNodeBudget) {
      return {
        detected: false,
        incomplete: true,
        incompleteCategories: ["budget"],
      };
    }
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes(LEAK_SENTINEL)) {
        return {
          detected: true,
          incomplete,
          incompleteCategories: [...incompleteCategories].sort(),
        };
      }
      continue;
    }
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    let prototype: object | null;
    try { prototype = Object.getPrototypeOf(value); }
    catch {
      incomplete = true;
      incompleteCategories.add("prototype");
      continue;
    }
    const seenPrototypes = new Set<object>();
    while (prototype !== null && !seenPrototypes.has(prototype)) {
      seenPrototypes.add(prototype);
      let prototypeKeys: readonly PropertyKey[];
      try { prototypeKeys = Reflect.ownKeys(prototype); }
      catch {
        incomplete = true;
        incompleteCategories.add("prototype_keys");
        break;
      }
      for (const key of prototypeKeys) {
        let descriptor: PropertyDescriptor | undefined;
        try { descriptor = Object.getOwnPropertyDescriptor(prototype, key); }
        catch {
          incomplete = true;
          incompleteCategories.add("prototype_descriptor");
          continue;
        }
        if (descriptor === undefined) {
          incomplete = true;
          incompleteCategories.add("prototype_descriptor");
        } else if (
          key === "toJSON"
          && "value" in descriptor
          && typeof descriptor.value === "function"
        ) {
          incomplete = true;
          incompleteCategories.add("prototype_to_json");
        } else if (
          !(prototype === Object.prototype && key === "__proto__")
          && !("value" in descriptor)
        ) {
          incomplete = true;
          incompleteCategories.add("prototype_accessor");
        }
      }
      try { prototype = Object.getPrototypeOf(prototype); }
      catch {
        incomplete = true;
        incompleteCategories.add("prototype");
        break;
      }
    }
    let keys: readonly PropertyKey[];
    try { keys = Reflect.ownKeys(value); }
    catch {
      incomplete = true;
      incompleteCategories.add("own_keys");
      continue;
    }
    for (const key of keys) {
      if (typeof key === "string" && key.includes(LEAK_SENTINEL)) {
        return {
          detected: true,
          incomplete,
          incompleteCategories: [...incompleteCategories].sort(),
        };
      }
      let descriptor: PropertyDescriptor | undefined;
      try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
      catch {
        incomplete = true;
        incompleteCategories.add("descriptor");
        continue;
      }
      if (descriptor === undefined) {
        incomplete = true;
        incompleteCategories.add("descriptor");
      } else if ("value" in descriptor) {
        if (
          key === "toJSON"
          && typeof descriptor.value === "function"
        ) {
          incomplete = true;
          incompleteCategories.add("to_json");
        } else {
          pending.push(descriptor.value);
        }
      } else if (
        descriptor.enumerable
      ) {
        incomplete = true;
        incompleteCategories.add("accessor");
      }
    }
  }
  return {
    detected: false,
    incomplete,
    incompleteCategories: [...incompleteCategories].sort(),
  };
}

function apiLogCaptureSurface(fields: unknown): {
  readonly fields: unknown;
  readonly incomplete: boolean;
} {
  if (typeof fields !== "object" || fields === null) {
    return { fields, incomplete: false };
  }
  let isArray: boolean;
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    isArray = Array.isArray(fields);
    if (isArray) return { fields, incomplete: false };
    prototype = Object.getPrototypeOf(fields);
    keys = Reflect.ownKeys(fields);
  } catch {
    return {
      fields: { category: "unscannable" },
      incomplete: true,
    };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { fields, incomplete: false };
  }
  const projected: Record<PropertyKey, unknown> = Object.create(null);
  let incomplete = false;
  for (const key of keys) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(fields, key); }
    catch {
      incomplete = true;
      continue;
    }
    if (descriptor === undefined) {
      incomplete = true;
      continue;
    }
    if (!("value" in descriptor)) {
      if (descriptor.enumerable) incomplete = true;
      continue;
    }
    if (key === "req" && typeof descriptor.value === "object" && descriptor.value !== null) {
      const request = descriptor.value as {
        readonly headers?: Record<string, unknown>;
        readonly host?: unknown;
        readonly ip?: unknown;
        readonly method?: unknown;
        readonly socket?: { readonly remotePort?: unknown };
        readonly url?: unknown;
      };
      try {
        projected[key] = {
          method: request.method,
          url: request.url,
          version: request.headers?.["accept-version"],
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      } catch {
        projected[key] = { category: "request_serializer_failed" };
        incomplete = true;
      }
    } else if (
      key === "res"
      && typeof descriptor.value === "object"
      && descriptor.value !== null
    ) {
      try {
        projected[key] = {
          statusCode: (descriptor.value as { readonly statusCode?: unknown }).statusCode,
        };
      } catch {
        projected[key] = { category: "response_serializer_failed" };
        incomplete = true;
      }
    } else {
      projected[key] = descriptor.value;
    }
  }
  return { fields: projected, incomplete };
}

function captureStructuredLog(
  records: unknown[],
  category: string,
  fields: unknown,
  message?: string,
  forceIncomplete = false,
): void {
  let capture: StructuredLogCapture;
  try {
    const scan = scanSentinel(fields, message);
    const structured = safeStructuredValue(fields);
    const incompleteCategories = new Set(scan.incompleteCategories);
    if (forceIncomplete) incompleteCategories.add("capture_surface");
    if (structured.incomplete) incompleteCategories.add("structured_snapshot");
    capture = Object.freeze({
      category,
      fields: structured.snapshot,
      message,
      sentinelScan: Object.freeze({
        ...scan,
        incomplete: scan.incomplete || forceIncomplete || structured.incomplete,
        incompleteCategories: [...incompleteCategories].sort(),
      }),
    } satisfies StructuredLogCapture);
  } catch {
    capture = incompleteStructuredLogCapture(category);
  }
  records.push(capture);
}

function incompleteStructuredLogCapture(category: string): StructuredLogCapture {
  return Object.freeze({
    category,
    fields: Object.freeze({ category: "unscannable" }),
    message: undefined,
    sentinelScan: Object.freeze({
      detected: false,
      incomplete: true,
      incompleteCategories: ["capture_failure"],
    }),
  } satisfies StructuredLogCapture);
}

function assertStructuredLogsSentinelFree(records: readonly unknown[]): void {
  for (const record of records) {
    try {
      if (
        typeof record !== "object"
        || record === null
        || !("sentinelScan" in record)
      ) throw new Error("invalid capture");
      const scan = (record as { sentinelScan?: SentinelScan }).sentinelScan;
      if (scan?.detected !== false || scan.incomplete !== false) {
        throw new Error("incomplete capture");
      }
    } catch {
      throw new Error("sentinel category: structured logs");
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(records); }
  catch { throw new Error("sentinel category: structured logs"); }
  if (serialized.includes(LEAK_SENTINEL)) {
    throw new Error("sentinel category: structured logs");
  }
}

function capturingLogger(records: unknown[]): FastifyBaseLogger {
  const capture = (fields: unknown, message?: string): void => {
    try {
      const surface = apiLogCaptureSurface(fields);
      captureStructuredLog(
        records,
        "api_log",
        surface.fields,
        message,
        surface.incomplete,
      );
    } catch {
      records.push(incompleteStructuredLogCapture("api_log"));
    }
  };
  const logger = {
    level: "silent",
    child() { return logger; },
    info: capture,
    error: capture,
    warn: capture,
    debug: capture,
    fatal: capture,
    trace: capture,
    silent: capture,
  };
  return logger as unknown as FastifyBaseLogger;
}

function workerClock(): WorkerClock {
  return {
    now: () => new Date(),
    wait: (milliseconds, signal) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(milliseconds, 50));
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }),
    scheduleEvery: (callback, milliseconds) => {
      const timer = setInterval(() => {
        void callback();
      }, Math.min(milliseconds, 100));
      return () => clearInterval(timer);
    },
  };
}

class SyntheticSecretStore implements SecretStore {
  public async get(reference: SecretReference): Promise<SecretMaterial> {
    if (reference.purpose !== "hermes_ingress") {
      throw new Error("Synthetic store serves only Hermes ingress material");
    }
    let released = false;
    return {
      reference,
      withBytes(consumer) {
        if (released) throw new Error("Synthetic material was released");
        return consumer(Buffer.from(SYNTHETIC_INGRESS_KEY, "utf8"));
      },
      text() {
        if (released) throw new Error("Synthetic material was released");
        return SYNTHETIC_INGRESS_KEY;
      },
      release() {
        released = true;
      },
    };
  }
}

export interface ProvisionedSyntheticTenant {
  readonly tenant_id: string;
  readonly runtime_id: string;
  readonly profile_ids: readonly string[];
  readonly request: ReturnType<typeof syntheticB2BProvisioningRequest>;
}

export interface EventReadResult {
  readonly events: readonly ProductEvent[];
  readonly lastSequence: number;
}

export class IntegrationHarness {
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly db: Kysely<RuntimeDatabase>;
  readonly fakeHermes: FakeHermes;
  readonly supervisorState: FakeSupervisorState;
  readonly errorEnvelopes: unknown[] = [];
  readonly structuredLogs: unknown[] = [];
  readonly hermesTransportAttempts: ("readiness" | "execution")[] = [];
  readonly worker: {
    readonly untilRuntimeReady: (runtimeId: string) => Promise<void>;
    readonly untilRuntimeStatus: (
      runtimeId: string,
      status: string,
    ) => Promise<JsonRecord>;
    readonly untilRunStatus: (runId: string, status: string) => Promise<JsonRecord>;
    readonly untilRunJobStatus: (runId: string, status: string) => Promise<JsonRecord>;
  };

  readonly #suite: string;
  readonly #controlPool: DatabaseControlPool;
  readonly #controlDatabaseUrl: string;
  readonly #childPool: Pool;
  readonly #childPoolResource: OwnedDatabaseResource;
  readonly #directory: string;
  readonly #socketPath: string;
  readonly #bootstrapKeyFile: string;
  #app: FastifyInstance | undefined;
  #apiOrigin: string | undefined;
  #notifier: PostgresEventNotifier | undefined;
  #supervisor: FakeSupervisor;
  #workerController: AbortController | undefined;
  #workerPromise: Promise<void> | undefined;
  #workerFailed = false;
  #workerIdCounter = 0;
  #resourceCounter = 0;
  #closed = false;

  private constructor(input: {
    readonly suite: string;
    readonly controlPool: DatabaseControlPool;
    readonly controlDatabaseUrl: string;
    readonly databaseName: string;
    readonly databaseUrl: string;
    readonly childPool: Pool;
    readonly childPoolResource: OwnedDatabaseResource;
    readonly db: Kysely<RuntimeDatabase>;
    readonly directory: string;
    readonly socketPath: string;
    readonly bootstrapKeyFile: string;
    readonly fakeHermes: FakeHermes;
    readonly supervisorState: FakeSupervisorState;
    readonly supervisor: FakeSupervisor;
  }) {
    this.#suite = input.suite;
    this.#controlPool = input.controlPool;
    this.#controlDatabaseUrl = input.controlDatabaseUrl;
    this.databaseName = input.databaseName;
    this.databaseUrl = input.databaseUrl;
    this.#childPool = input.childPool;
    this.#childPoolResource = input.childPoolResource;
    this.db = input.db;
    this.#directory = input.directory;
    this.#socketPath = input.socketPath;
    this.#bootstrapKeyFile = input.bootstrapKeyFile;
    this.fakeHermes = input.fakeHermes;
    this.supervisorState = input.supervisorState;
    this.#supervisor = input.supervisor;
    this.worker = Object.freeze({
      untilRuntimeReady: async (runtimeId) => {
        await this.#untilRuntime(runtimeId, "ready");
      },
      untilRuntimeStatus: (runtimeId, status) => this.#untilRuntime(runtimeId, status),
      untilRunStatus: (runId, status) => this.#untilRun(runId, status),
      untilRunJobStatus: (runId, status) => until(
        async () => await this.db.selectFrom("worker_jobs").selectAll()
          .where("run_id", "=", runId).executeTakeFirst(),
        (value) => value?.status === status,
        `run job ${status}`,
      ) as Promise<JsonRecord>,
    });
  }

  public get fakeSupervisor(): FakeSupervisor {
    return this.#supervisor;
  }

  public get notifier(): PostgresEventNotifier {
    if (this.#notifier === undefined) throw new Error("API notifier is unavailable");
    return this.#notifier;
  }

  public static async create(suite: string): Promise<IntegrationHarness> {
    const isolated = await createIsolatedDatabase();
    let childPool: Pool | undefined;
    let childPoolResource: OwnedDatabaseResource | undefined;
    let db: Kysely<RuntimeDatabase> | undefined;
    let directory: string | undefined;
    let fakeHermes: FakeHermes | undefined;
    let supervisor: FakeSupervisor | undefined;
    try {
      const ownedChildPool = createOwnedPostgresPool({
        connectionString: isolated.databaseUrl,
        max: 12,
        connectionTimeoutMillis: externalStageTimeoutMs,
        query_timeout: externalStageTimeoutMs,
      });
      childPool = ownedChildPool.pool;
      childPoolResource = trackPostgresPool(childPool, async () => {
        if (db !== undefined) await db.destroy();
        else await childPool!.end();
      }, ownedChildPool.terminatePreAuthConnections);
      await boundedExternal(
        "database migrations",
        () => applyMigrations(childPool!, migrationsDirectory),
      );
      db = createRuntimeDatabase(childPool);
      await boundedExternal("temporary root", async () => {
        await mkdir(integrationTemporaryRoot, { recursive: true, mode: 0o700 });
        await chmod(integrationTemporaryRoot, 0o700);
      });
      directory = await boundedExternal(
        "temporary directory create",
        () => mkdtemp(join(integrationTemporaryRoot, `${suite}-`)),
      );
      await boundedExternal("temporary directory permissions", () => chmod(directory!, 0o700));
      const bootstrapKeyFile = join(directory, "bootstrap-key");
      await boundedExternal("bootstrap file", () => writeFile(
        bootstrapKeyFile,
        `${SYNTHETIC_BOOTSTRAP_KEY}\n`,
        { mode: 0o600 },
      ));
      fakeHermes = new FakeHermes({ ingressKey: SYNTHETIC_INGRESS_KEY });
      await boundedExternal("Hermes start", () => fakeHermes!.start());
      const socketRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
      const socketPath = join(socketRoot, `ca-t16-${randomBytes(6).toString("hex")}.sock`);
      const supervisorState = createFakeSupervisorState();
      supervisor = new FakeSupervisor({
        socketPath,
        imageLock: syntheticImageLock,
        providerCatalog: syntheticProviderCatalog,
        privateOrigin: "http://core-agent-runtime-task16:8642",
        state: supervisorState,
        forbiddenSecretBytes: [
          SYNTHETIC_BOOTSTRAP_KEY,
          SYNTHETIC_INGRESS_KEY,
          LEAK_SENTINEL,
        ],
      });
      await boundedExternal("Supervisor start", () => supervisor!.start());
      const harness = new IntegrationHarness({
        suite,
        controlPool: isolated.controlPool,
        controlDatabaseUrl: isolated.controlDatabaseUrl,
        databaseName: isolated.databaseName,
        databaseUrl: isolated.databaseUrl,
        childPool,
        childPoolResource,
        db,
        directory,
        socketPath,
        bootstrapKeyFile,
        fakeHermes,
        supervisorState,
        supervisor,
      });
      await harness.#startApi();
      await harness.startWorker();
      return harness;
    } catch (error) {
      await cleanupAfterSetupFailure(error, [
        { category: "supervisor", work: async () => { await supervisor?.close(); } },
        { category: "hermes", work: async () => { await fakeHermes?.close(); } },
        { category: "database drop", work: async () => {
          await dropIsolatedDatabase({
            databaseName: isolated.databaseName,
            controlDatabaseUrl: isolated.controlDatabaseUrl,
            closeOwned: childPoolResource === undefined ? [] : [childPoolResource],
          });
        }, timeoutMs: externalStageTimeoutMs + 1_000 },
        { category: "control pool", work: () => isolated.controlPool.end() },
        { category: "temporary directory", work: async () => {
          if (directory !== undefined) await rm(directory, { recursive: true, force: true });
        } },
      ]);
    }
  }

  public async startWorker(workerId?: string): Promise<void> {
    if (this.#workerPromise !== undefined) throw new Error("Worker is already running");
    this.#workerIdCounter += 1;
    const controller = new AbortController();
    const fetchImpl = rewriteToFakeHermes(
      this.fakeHermes,
      (kind) => this.hermesTransportAttempts.push(kind),
    );
    const redactor = createRedactor([
      SYNTHETIC_BOOTSTRAP_KEY,
      SYNTHETIC_INGRESS_KEY,
      LEAK_SENTINEL,
    ]);
    const logger: WorkerLogger = {
      info: (fields, message) => {
        captureStructuredLog(this.structuredLogs, "worker_log", fields, message);
      },
      error: (fields, message) => {
        captureStructuredLog(this.structuredLogs, "worker_log", fields, message);
      },
    };
    this.#workerController = controller;
    this.#workerFailed = false;
    this.#workerPromise = runControlPlaneWorker({
      db: this.db,
      workerId: workerId ?? `worker_task16_${this.#workerIdCounter}`,
      clock: workerClock(),
      logger,
      repositories: createWorkerRuntimeRepositories(
        this.db,
        syntheticProviderCatalog,
        redactor,
      ),
      providerCatalog: syntheticProviderCatalog,
      supervisorClient: new RuntimeSupervisorClient({
        socketPath: this.#socketPath,
        timeoutMs: 750,
      }),
      ingressSecretStore: new SyntheticSecretStore(),
      hermesClient: new HttpHermesReadinessClient(fetchImpl, 1_000),
      executionHermesClient: new HermesClient({ fetch: fetchImpl }),
    }, controller.signal).catch(() => {
      this.#workerFailed = true;
    });
  }

  public async stopWorker(): Promise<void> {
    this.#workerController?.abort();
    try {
      await boundedExternal(
        "worker stop",
        async () => { await this.#workerPromise; },
        cleanupStageTimeoutMs,
      );
    } finally {
      this.#workerController = undefined;
      this.#workerPromise = undefined;
    }
    if (this.#workerFailed) throw new Error("Worker loop crashed");
  }

  public async restartApi(): Promise<void> {
    await this.#closeApi();
    await this.#startApi();
  }

  public async restartSupervisor(): Promise<void> {
    await boundedExternal(
      "Supervisor restart close",
      () => this.#supervisor.close(),
      cleanupStageTimeoutMs,
    );
    this.#supervisor = new FakeSupervisor({
      socketPath: this.#socketPath,
      imageLock: syntheticImageLock,
      providerCatalog: syntheticProviderCatalog,
      privateOrigin: "http://core-agent-runtime-task16:8642",
      state: this.supervisorState,
      forbiddenSecretBytes: [
        SYNTHETIC_BOOTSTRAP_KEY,
        SYNTHETIC_INGRESS_KEY,
        LEAK_SENTINEL,
      ],
    });
    await boundedExternal(
      "Supervisor restart start",
      () => this.#supervisor.start(),
      cleanupStageTimeoutMs,
    );
  }

  public async executeSupervisor(
    request: SupervisorRequestV1,
  ): Promise<SupervisorResponseV1> {
    return new RuntimeSupervisorClient({
      socketPath: this.#socketPath,
      timeoutMs: 750,
    }).execute(request);
  }

  public async sendUnsafeSupervisorRequest(value: unknown): Promise<void> {
    const frame = encodeSupervisorFrame(value);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: this.#socketPath, allowHalfOpen: true });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Unsafe Supervisor probe timed out"));
      }, 750);
      const finish = (): void => {
        clearTimeout(timeout);
        socket.destroy();
        resolve();
      };
      socket.once("connect", () => socket.end(frame));
      socket.once("end", finish);
      socket.once("close", finish);
      socket.once("error", finish);
    });
  }

  public async provisionSyntheticB2B(): Promise<ProvisionedSyntheticTenant> {
    const tenantId = this.#nextId("tenant");
    const request = syntheticB2BProvisioningRequest(tenantId);
    const response = await this.requestJson("POST", "/internal/v1/tenant-provisioning", {
      payload: request,
    });
    assert.equal(response.status, 202);
    const body = response.body as {
      runtime: { container_id: string };
      tenant: { tenant_id: string };
    };
    return {
      tenant_id: body.tenant.tenant_id,
      runtime_id: body.runtime.container_id,
      profile_ids: request.identity_graph.profiles.map((profile) => profile.profile_id),
      request,
    };
  }

  public async createConversation(input: {
    readonly tenant_id: string;
    readonly profile_id: string;
  }): Promise<{ readonly conversation_id: string }> {
    const suffix = this.#nextId("conversation");
    const request = syntheticConversationRequest(
      input.tenant_id,
      input.profile_id,
      suffix,
    );
    const response = await this.requestJson("POST", "/internal/v1/conversations", {
      tenantId: input.tenant_id,
      payload: request,
    });
    assert.equal(response.status, 201);
    return response.body as { readonly conversation_id: string };
  }

  public async createRun(
    conversationId: string,
    content: string,
    options: { readonly tenantId?: string; readonly parentRunId?: string } = {},
  ): Promise<{ readonly run_id: string; readonly tenant_id: string }> {
    const tenantId = options.tenantId ?? await this.#tenantForConversation(conversationId);
    const request = syntheticRunRequest(
      this.#nextId("run"),
      content,
      options.parentRunId,
    );
    const response = await this.requestJson(
      "POST",
      `/internal/v1/conversations/${encodeURIComponent(conversationId)}/runs`,
      { tenantId, payload: request },
    );
    assert.equal(response.status, 202);
    return response.body as { readonly run_id: string; readonly tenant_id: string };
  }

  public async getRun(
    runId: string,
    tenantId?: string,
  ): Promise<JsonRecord> {
    const authority = tenantId ?? await this.#tenantForRun(runId);
    const response = await this.requestJson(
      "GET",
      `/internal/v1/runs/${encodeURIComponent(runId)}`,
      { tenantId: authority },
    );
    assert.equal(response.status, 200);
    return response.body as JsonRecord;
  }

  public async requestJson(
    method: string,
    path: string,
    options: { readonly tenantId?: string; readonly payload?: unknown } = {},
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    if (this.#apiOrigin === undefined) throw new Error("API is unavailable");
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), externalStageTimeoutMs);
    let response: Response;
    let body: unknown;
    try {
      const trustedContext = options.tenantId === undefined
        ? undefined
        : await this.#trustedContextHeader(method, path, options.tenantId, options.payload);
      response = await fetch(`${this.#apiOrigin}${path}`, {
        method,
        headers: {
          ...(trustedContext === undefined
            ? {
              authorization: `Bearer ${SYNTHETIC_BOOTSTRAP_KEY}`,
              ...(options.tenantId === undefined ? {} : { "x-core-agent-tenant-id": options.tenantId }),
            }
            : { "x-core-agent-context": trustedContext }),
          ...(options.payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
        signal: controller.signal,
      });
      body = await response.json() as unknown;
    } catch {
      throw new Error("Integration stage failed: API request");
    } finally {
      clearTimeout(deadline);
    }
    if (
      typeof body === "object"
      && body !== null
      && typeof (body as { code?: unknown }).code === "string"
    ) this.errorEnvelopes.push(body);
    return { status: response.status, body };
  }

  public async readEvents(
    conversationId: string,
    options: {
      readonly afterSequence: number;
      readonly stopAfterType: ProductEvent["event_type"];
      readonly tenantId?: string;
    },
  ): Promise<EventReadResult> {
    if (this.#apiOrigin === undefined) throw new Error("API is unavailable");
    const tenantId = options.tenantId ?? await this.#tenantForConversation(conversationId);
    const notifier = this.notifier;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 6_000);
    try {
      const response = await fetch(
        `${this.#apiOrigin}/internal/v1/conversations/${encodeURIComponent(conversationId)}/events?after_sequence=${options.afterSequence}`,
        {
          headers: {
            "x-core-agent-context": await this.#trustedContextHeader(
              "GET",
              `/internal/v1/conversations/${encodeURIComponent(conversationId)}/events`,
              tenantId,
            ),
          },
          signal: controller.signal,
        },
      );
      assert.equal(response.status, 200);
      assert(response.body !== null);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const events: ProductEvent[] = [];
      let pending = "";
      let lastSequence = options.afterSequence;
      while (true) {
        const next = await reader.read();
        if (next.done) throw new Error("SSE ended before target event");
        pending += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
        let separator = pending.indexOf("\n\n");
        while (separator >= 0) {
          const frame = pending.slice(0, separator);
          pending = pending.slice(separator + 2);
          const lines = frame.split("\n");
          const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
          const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
          if (id !== undefined && data !== undefined) {
            const event = JSON.parse(data) as ProductEvent;
            events.push(event);
            lastSequence = Number(id);
            if (event.event_type === options.stopAfterType) {
              const waitCountAtTarget = notifier.waitCount;
              await until(
                async () => notifier.waitCount,
                (waitCount) => waitCount > waitCountAtTarget,
                "SSE notifier registration",
                1_000,
              );
              controller.abort();
              await reader.cancel().catch(() => undefined);
              await sleep(50);
              return { events, lastSequence };
            }
          }
          separator = pending.indexOf("\n\n");
        }
      }
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures = await runCleanupStages([
      { category: "worker", work: () => this.stopWorker() },
      { category: "api", work: () => this.#closeApi() },
      { category: "supervisor", work: () => this.#supervisor.close() },
      { category: "hermes", work: () => this.fakeHermes.close() },
      { category: "lease", work: () => this.#assertNoUnhandledLease() },
      {
        category: "sentinel",
        work: () => this.#assertSentinelAbsent(),
        failureCategory: (error) => {
          const message = error instanceof Error ? error.message : "";
          return message.startsWith("sentinel category:") ? message : "sentinel";
        },
      },
      { category: "database drop", work: async () => {
        await dropIsolatedDatabase({
          databaseName: this.databaseName,
          controlDatabaseUrl: this.#controlDatabaseUrl,
          closeOwned: [this.#childPoolResource],
        });
      }, timeoutMs: externalStageTimeoutMs + 1_000 },
      { category: "control pool", work: () => this.#controlPool.end() },
      {
        category: "temporary directory",
        work: () => rm(this.#directory, { recursive: true, force: true }),
      },
    ]);
    if (failures.length > 0) throw new Error(`Integration teardown failed: ${failures.join(", ")}`);
  }

  async #startApi(): Promise<void> {
    const notifier = new PostgresEventNotifier(this.databaseUrl);
    await boundedExternal("event notifier start", () => notifier.start());
    const app = await boundedExternal("API build", () => buildControlPlaneApp({
      environment: {
        databaseUrl: this.databaseUrl,
        bootstrapKeyFile: this.#bootstrapKeyFile,
        apiHost: "127.0.0.1",
        apiPort: 8787,
        secretRoot: this.#directory,
        supervisorSocket: this.#socketPath,
        providerCatalogFile: join(this.#directory, "providers.json"),
        workerId: "worker_task16",
      },
      db: this.db,
      providerCatalog: syntheticProviderCatalog,
      imageLock: syntheticImageLock,
      logger: capturingLogger(this.structuredLogs),
      redactor: createRedactor([
        SYNTHETIC_BOOTSTRAP_KEY,
        SYNTHETIC_INGRESS_KEY,
        LEAK_SENTINEL,
      ]),
      eventNotifier: notifier,
      trustedContext: {
        keys: [{
          keyId: integrationTrustedContextKeyId,
          publicKey: integrationTrustedContextKey.publicKey,
          status: "active",
          activatedAt: "2026-08-18T00:00:00.000Z",
        }],
        expectedIssuer: "identity-gateway",
        expectedAudience: "control-plane-api",
      },
    }));
    try {
      const address = await boundedExternal(
        "API listen",
        () => app.listen({ host: "127.0.0.1", port: 0 }),
      );
      this.#app = app;
      this.#apiOrigin = address.replace(/\/$/, "");
      this.#notifier = notifier;
    } catch (error) {
      await runCleanupStages([
        { category: "API", work: () => app.close() },
        { category: "notifier", work: () => notifier.close() },
      ]);
      throw error;
    }
  }

  async #trustedContextHeader(
    method: string,
    rawPath: string,
    tenantId: string,
    payload?: unknown,
  ): Promise<string | undefined> {
    const path = rawPath.split("?", 1)[0]!;
    const conversationCreate = method === "POST" && path === "/internal/v1/conversations";
    const runCreate = method === "POST" && /^\/internal\/v1\/conversations\/[^/]+\/runs$/u.test(path);
    const runRead = method === "GET" && /^\/internal\/v1\/runs\/[^/]+$/u.test(path);
    const eventRead = method === "GET" && /^\/internal\/v1\/conversations\/[^/]+\/events$/u.test(path);
    if (!conversationCreate && !runCreate && !runRead && !eventRead) return undefined;

    const pathParts = path.split("/").map((part) => decodeURIComponent(part));
    const payloadRecord = typeof payload === "object" && payload !== null
      ? payload as Record<string, unknown>
      : {};
    const conversationId = conversationCreate
      ? deriveConversationId(tenantId, typeof payloadRecord.idempotency_key === "string" ? payloadRecord.idempotency_key : "invalid")
      : runRead
        ? (await this.db.selectFrom("agent_runs").select("conversation_id")
          .where("tenant_id", "=", tenantId).where("run_id", "=", pathParts.at(-1)!).executeTakeFirst())?.conversation_id
          ?? "conversation_context_absent"
        : pathParts[4]!;
    const storedConversation = await this.db.selectFrom("conversations")
      .select(["profile_id", "created_by_actor_id"])
      .where("tenant_id", "=", tenantId).where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    const requestedProfileId = conversationCreate && typeof payloadRecord.profile_id === "string"
      ? payloadRecord.profile_id
      : storedConversation?.profile_id;
    const fallbackProfile = await this.db.selectFrom("profiles")
      .select(["profile_id", "owner_actor_id"])
      .where("tenant_id", "=", tenantId).where("status", "=", "active")
      .orderBy("profile_id", "asc").executeTakeFirst();
    const selectedProfile = requestedProfileId === undefined
      ? fallbackProfile
      : await this.db.selectFrom("profiles").select(["profile_id", "owner_actor_id"])
        .where("tenant_id", "=", tenantId).where("profile_id", "=", requestedProfileId)
        .executeTakeFirst();
    const actorId = storedConversation?.created_by_actor_id
      ?? selectedProfile?.owner_actor_id
      ?? fallbackProfile?.owner_actor_id
      ?? `actor_context_${tenantId}`;
    const memberships = await this.db.selectFrom("memberships")
      .select(["membership_id", "roles"])
      .where("tenant_id", "=", tenantId).where("actor_id", "=", actorId).where("status", "=", "active")
      .orderBy("membership_id", "asc").execute();
    const membership = memberships.find((candidate) => candidate.roles.length > 0);
    const tenant = await this.db.selectFrom("tenants").select("tenant_mode")
      .where("tenant_id", "=", tenantId).executeTakeFirst();
    const container = await this.db.selectFrom("runtime_containers").select("container_id")
      .where("tenant_id", "=", tenantId).orderBy("container_id", "asc").executeTakeFirst();
    const completeRunPayload = runCreate && typeof payload === "object" && payload !== null
      ? payload as Parameters<typeof deriveAgentRunId>[2]
      : undefined;
    const runId = runCreate && completeRunPayload !== undefined
      ? deriveAgentRunId(tenantId, conversationId, completeRunPayload)
      : runRead
        ? pathParts.at(-1)!
        : `run_context_${conversationId}`;
    const issuedAt = (await this.#childPool.query<{ now: Date }>(
      "select clock_timestamp() as now",
    )).rows[0]?.now;
    if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
      throw new Error("Integration trusted-context database clock is unavailable");
    }
    const context: TrustedRequestContext = {
      schema_version: 1,
      tenant_mode: tenant?.tenant_mode === "b2c" ? "b2c" : "b2b",
      tenant_id: tenantId,
      actor_id: actorId,
      original_actor_id: actorId,
      membership_id: membership?.membership_id ?? `membership_context_${tenantId}`,
      effective_role: membership?.roles[0] === "admin" || membership?.roles[0] === "consultant"
        ? membership.roles[0]
        : "student",
      profile_id: requestedProfileId ?? fallbackProfile?.profile_id ?? `profile_context_${tenantId}`,
      entitlement_snapshot_ref: {
        snapshot_id: "snapshot_integration_context",
        version: 1,
        evaluated_at: issuedAt.toISOString(),
      },
      capability_ids: ["capability_integration_context"],
      container_id: container?.container_id ?? `container_context_${tenantId}`,
      conversation_id: conversationId,
      run_id: runId,
      request_id: `request_context_${runId}`,
      trace_id: `trace_context_${runId}`,
      client_request_id: runCreate && typeof payloadRecord.client_request_id === "string"
        ? payloadRecord.client_request_id
        : `client_context_${runId}`,
      context_id: `context_${runId}`,
      issuer: "identity-gateway",
      audience: ["control-plane-api"],
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + 300_000).toISOString(),
      key_id: integrationTrustedContextKeyId,
    };
    return encodeSignedTrustedContext({
      schema_version: 1,
      algorithm: "EdDSA",
      key_id: integrationTrustedContextKeyId,
      payload: context,
      signature: sign(
        null,
        Buffer.from(canonicalJson(context), "utf8"),
        integrationTrustedContextKey.privateKey,
      ).toString("base64url"),
    });
  }

  async #closeApi(): Promise<void> {
    const app = this.#app;
    const notifier = this.#notifier;
    this.#app = undefined;
    this.#apiOrigin = undefined;
    this.#notifier = undefined;
    const failures = await runCleanupStages([
      {
        category: "API connections",
        work: async () => { app?.server.closeAllConnections(); },
      },
      { category: "notifier", work: async () => { await notifier?.close(); } },
      { category: "API", work: async () => { await app?.close(); } },
    ]);
    if (failures.length > 0) throw new Error(`API close failed: ${failures.join(", ")}`);
  }

  #nextId(prefix: string): string {
    this.#resourceCounter += 1;
    const suite = this.#suite.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
    return `${prefix}_${suite}_${this.#resourceCounter}_${randomBytes(3).toString("hex")}`;
  }

  async #tenantForConversation(conversationId: string): Promise<string> {
    const row = await this.db.selectFrom("conversations").select("tenant_id")
      .where("conversation_id", "=", conversationId).executeTakeFirstOrThrow();
    return row.tenant_id;
  }

  async #tenantForRun(runId: string): Promise<string> {
    const row = await this.db.selectFrom("agent_runs").select("tenant_id")
      .where("run_id", "=", runId).executeTakeFirstOrThrow();
    return row.tenant_id;
  }

  async #untilRuntime(runtimeId: string, status: string): Promise<JsonRecord> {
    return until(
      async () => await this.db.selectFrom("runtime_containers").selectAll()
        .where("container_id", "=", runtimeId).executeTakeFirst(),
      (value) => value?.observed_state === status,
      `runtime ${status}`,
    ) as Promise<JsonRecord>;
  }

  async #untilRun(runId: string, status: string): Promise<JsonRecord> {
    return until(
      async () => await this.db.selectFrom("agent_runs").selectAll()
        .where("run_id", "=", runId).executeTakeFirst(),
      (value) => value?.status === status,
      `run ${status}`,
    ) as Promise<JsonRecord>;
  }

  async #assertNoUnhandledLease(): Promise<void> {
    const jobs = await this.#childPool.query<{ count: string }>(
      "select count(*)::text as count from worker_jobs where status = 'running' and lease_expires_at > now()",
    );
    const outbox = await this.#childPool.query<{ count: string }>(
      "select count(*)::text as count from outbox where lease_owner is not null and lease_expires_at > now()",
    );
    assert.equal(jobs.rows[0]?.count, "0", "lease category: worker_jobs");
    assert.equal(outbox.rows[0]?.count, "0", "lease category: outbox");
  }

  async #assertSentinelAbsent(): Promise<void> {
    let columns;
    try {
      columns = await this.#childPool.query<{
      table_name: string;
      column_name: string;
      }>(`select table_name, column_name from information_schema.columns
        where table_schema = 'public' and data_type in ('text', 'json', 'jsonb')
        order by table_name, ordinal_position`);
    } catch {
      throw new Error("sentinel category: database metadata");
    }
    for (const column of columns.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(column.table_name) || !/^[a-z_][a-z0-9_]*$/.test(column.column_name)) {
        throw new Error("sentinel category: database metadata");
      }
      let result;
      try {
        result = await this.#childPool.query<{ present: boolean }>(
          `select exists(select 1 from "${column.table_name}" where "${column.column_name}"::text like $1) as present`,
          [`%${LEAK_SENTINEL}%`],
        );
      } catch {
        throw new Error("sentinel category: application database scan");
      }
      assert.equal(result.rows[0]?.present, false, "sentinel category: application database");
    }
    let events;
    let audit;
    try {
      events = await this.#childPool.query(
        "select event_type, payload from product_events",
      );
      audit = await this.#childPool.query(
        "select action, reason_summary from audit_events",
      );
    } catch {
      throw new Error("sentinel category: event audit scan");
    }
    const categories: readonly [string, unknown][] = [
      ["ErrorEnvelopes", this.errorEnvelopes],
      ["events", events.rows],
      ["audit", audit.rows],
      ["fake Supervisor requests", this.supervisorState.requests],
      ["fake Hermes requests", this.fakeHermes.requests],
      ["fake Hermes rejections", this.fakeHermes.rejections],
    ];
    assertStructuredLogsSentinelFree(this.structuredLogs);
    for (const [category, value] of categories) {
      let serialized: string;
      try { serialized = JSON.stringify(value); }
      catch { throw new Error(`sentinel category: ${category} serialization`); }
      assert.equal(serialized.includes(LEAK_SENTINEL), false, `sentinel category: ${category}`);
    }
  }
}

export const testHarnessInternals = Object.freeze({
  assertStructuredLogsSentinelFree,
  captureStructuredLog,
  capturingLogger,
  cleanupAfterSetupFailure,
  combineSetupAndCleanupFailure,
  createIsolatedDatabase,
  createOwnedPostgresPool,
  databaseCleanupBudgets,
  dropIsolatedDatabase,
  runCleanupStages,
  trackPostgresPool,
});

export async function createIntegrationHarness(
  suite: string,
): Promise<IntegrationHarness> {
  return IntegrationHarness.create(suite);
}
