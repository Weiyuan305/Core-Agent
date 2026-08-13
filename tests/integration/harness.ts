import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

import type { ProductEvent } from "@core-agent/contracts";
import {
  HermesClient,
  RuntimeSupervisorClient,
  applyMigrations,
  createRedactor,
  createRuntimeDatabase,
  type RuntimeDatabase,
  type SecretMaterial,
  type SecretReference,
  type SecretStore,
} from "@core-agent/runtime-core";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { Client, Pool } from "pg";

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
const externalStageTimeoutMs = 6_000;
const cleanupStageTimeoutMs = 2_000;
const sentinelScanNodeBudget = 100_000;

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
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

interface DatabaseCreateSession {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface DatabaseAdminSession {
  connect(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  close(): Promise<void>;
}

interface OwnedDatabaseResource {
  close(signal: AbortSignal): Promise<void>;
  forceClose(): Promise<void>;
}

interface PoolLifecycleClient {
  release(destroy?: boolean): void;
}

interface PoolLifecycleEvents {
  on(event: "acquire" | "remove", listener: (client: PoolLifecycleClient) => void): unknown;
  on(event: "release", listener: (error: Error | undefined, client: PoolLifecycleClient) => void): unknown;
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

function runBeforeDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("Integration stage timed out"));
  return runWithDeadline(work, remaining);
}

async function settlesBefore(promise: Promise<void>, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
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
  gracefulDeadline: number,
  finalDeadline: number,
): Promise<void> {
  const controller = new AbortController();
  let failure: unknown;
  const close = Promise.resolve()
    .then(() => resource.close(controller.signal))
    .catch((error: unknown) => { failure = error; });
  let forceFailure: unknown;
  if (!await settlesBefore(close, gracefulDeadline)) {
    controller.abort();
    const abortGraceDeadline = Math.min(finalDeadline, Date.now() + 5);
    if (!await settlesBefore(close, abortGraceDeadline)) {
      try {
        await resource.forceClose();
      } catch (error) {
        forceFailure = error;
      }
      await close;
    }
  }
  if (forceFailure !== undefined && failure !== undefined) {
    throw new AggregateError([forceFailure, failure], "Integration owned database close failed");
  }
  if (forceFailure !== undefined) throw forceFailure;
  if (failure !== undefined) throw failure;
}

function trackPostgresPool(
  pool: PoolLifecycleEvents,
  close: () => Promise<void>,
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
  pool.on("acquire", (client) => {
    checkedOut.add(client);
    if (state === "forcing") scheduleForce(client);
  });
  pool.on("release", (_error, client) => releaseOwnership(client));
  pool.on("remove", (client) => releaseOwnership(client));
  let closePromise: Promise<void> | undefined;
  let closeSettlement: Promise<void> | undefined;
  let forcePromise: Promise<void> | undefined;
  const startClose = (): Promise<void> => {
    if (closePromise === undefined) {
      if (state === "open") state = "closing";
      closePromise = Promise.resolve().then(close);
      closeSettlement = closePromise.then(
        () => undefined,
        () => undefined,
      ).then(() => {
        if (state === "closing") state = "settled";
      });
    }
    return closePromise;
  };
  return {
    close: async () => {
      await startClose();
    },
    forceClose: async () => {
      forcePromise ??= Promise.resolve().then(async () => {
        startClose();
        state = "forcing";
        for (const client of [...checkedOut]) scheduleForce(client);
        await closeSettlement;
        while (drainTasks.size > 0) {
          await Promise.all([...drainTasks]);
        }
        state = "settled";
        if (forceFailures.length > 0) {
          throw new AggregateError(forceFailures, "Integration owned database force close failed");
        }
      });
      await forcePromise;
    },
  };
}

async function dropIsolatedDatabase(options: {
  readonly databaseName: string;
  readonly controlDatabaseUrl?: string;
  readonly closeOwned: readonly OwnedDatabaseResource[];
  readonly createAdminSession?: () => DatabaseAdminSession;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
}): Promise<void> {
  assert.match(options.databaseName, databaseNamePattern);
  const timeoutMs = options.timeoutMs ?? externalStageTimeoutMs;
  const retryDelayMs = options.retryDelayMs ?? 50;
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert(Number.isSafeInteger(retryDelayMs) && retryDelayMs > 0 && retryDelayMs <= 250);
  const finalDeadline = Date.now() + timeoutMs;
  const closeReserveMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 4)));
  const operationDeadline = finalDeadline - closeReserveMs;
  const ownedDeadline = Date.now() + Math.max(1, Math.floor((operationDeadline - Date.now()) / 2));
  const ownedFailures: string[] = [];
  for (const [index, resource] of options.closeOwned.entries()) {
    try {
      await settleOwnedDatabaseResource(resource, ownedDeadline, operationDeadline);
    } catch {
      ownedFailures.push(`owned database connection ${index + 1}`);
    }
  }
  const client = options.createAdminSession === undefined
    ? new Client({
        connectionString: options.controlDatabaseUrl,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: Math.min(timeoutMs, 1_000),
        statement_timeout: Math.min(timeoutMs, 1_000),
      })
    : undefined;
  if (options.createAdminSession === undefined && options.controlDatabaseUrl === undefined) {
    throw new Error("Integration stage failed: database drop");
  }
  const admin = options.createAdminSession?.() ?? {
    connect: () => client!.connect(),
    query: async (sql: string, values?: readonly unknown[]) => {
      const result = await client!.query(sql, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Record<string, unknown>[] };
    },
    close: () => client!.end(),
  };
  let dropped = false;
  let closeFailed = false;
  try {
    await runBeforeDeadline(operationDeadline, () => admin.connect());
    while (!dropped) {
      try {
        await runBeforeDeadline(operationDeadline, () => admin.query(
          `select pg_terminate_backend(pid)
           from pg_stat_activity
           where datname = $1 and pid <> pg_backend_pid()`,
          [options.databaseName],
        ));
        await runBeforeDeadline(operationDeadline, () => admin.query(`drop database if exists "${options.databaseName}"`));
        const verification = await runBeforeDeadline(operationDeadline, () => admin.query(
          "select exists (select 1 from pg_database where datname = $1) as exists",
          [options.databaseName],
        ));
        dropped = verification.rows[0]?.exists === false;
      } catch {
        dropped = false;
      }
      if (dropped) break;
      if (Date.now() >= operationDeadline) throw new Error("Integration stage failed: database drop");
      await runBeforeDeadline(operationDeadline, () => sleep(retryDelayMs));
    }
  } catch {
    throw new Error("Integration stage failed: database drop");
  } finally {
    try {
      await runBeforeDeadline(finalDeadline, () => admin.close());
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) throw new Error("Integration stage failed: database admin close");
  if (ownedFailures.length > 0) throw new Error("Integration stage failed: owned database connections");
}

async function createIsolatedDatabase(options: {
  readonly configuredUrl?: string;
  readonly databaseName?: string;
  readonly createSession?: DatabaseCreateSession;
  readonly controlPool?: DatabaseControlPool;
  readonly cleanupControlPool?: DatabaseControlPool;
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
  const controlPool = options.controlPool ?? new Pool({
    connectionString: controlUrl.toString(),
    max: 2,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
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
      childPool = new Pool({
        connectionString: isolated.databaseUrl,
        max: 12,
        connectionTimeoutMillis: externalStageTimeoutMs,
        query_timeout: externalStageTimeoutMs,
      });
      childPoolResource = trackPostgresPool(childPool, async () => {
        if (db !== undefined) await db.destroy();
        else await childPool!.end();
      });
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
      response = await fetch(`${this.#apiOrigin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${SYNTHETIC_BOOTSTRAP_KEY}`,
          ...(options.tenantId === undefined
            ? {}
            : { "x-core-agent-tenant-id": options.tenantId }),
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
            authorization: `Bearer ${SYNTHETIC_BOOTSTRAP_KEY}`,
            "x-core-agent-tenant-id": tenantId,
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
  dropIsolatedDatabase,
  runCleanupStages,
  trackPostgresPool,
});

export async function createIntegrationHarness(
  suite: string,
): Promise<IntegrationHarness> {
  return IntegrationHarness.create(suite);
}
