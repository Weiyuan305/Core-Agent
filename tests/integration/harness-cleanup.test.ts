import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { LEAK_SENTINEL, testHarnessInternals } from "./harness.js";

const databaseName = "core_agent_test_0123456789abcdef";
const repositoryRoot = join(import.meta.dirname, "..", "..");

async function runCleanupChild(
  scenario: "delayed-backends" | "delayed-backends-release" | "termination-failure" | "transient-drop",
  operation: "terminate" | "drop",
): Promise<{
  readonly code: number | null;
  readonly diagnostics: readonly unknown[];
  readonly elapsedMs: number;
}> {
  const startedAt = Date.now();
  const diagnostics: unknown[] = [];
  const child = spawn(process.execPath, [
    "--import", join(repositoryRoot, "tests", "integration", "fixtures", "cleanup-test-database-child-pg-hook.mjs"),
    join(repositoryRoot, "scripts", "cleanup-test-database-child.mjs"),
    operation,
    "postgresql://127.0.0.1/core_agent_control",
    databaseName,
    "25",
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, CLEANUP_TEST_DATABASE_CHILD_SCENARIO: scenario },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", (message) => { diagnostics.push(message); });
  const [code] = await once(child, "close") as [number | null];
  return { code, diagnostics, elapsedMs: Date.now() - startedAt };
}

function terminalOperation(work: () => void | Promise<void>) {
  const completion = Promise.resolve().then(work);
  return { completion, terminateAndReap: async () => { await completion; } };
}

test("cleanup terminate child fails if exact target backends remain through its deadline", async () => {
  assert.notEqual((await runCleanupChild("delayed-backends", "terminate")).code, 0);
});

test("cleanup terminate child waits for an exact delayed backend to disappear before success", async () => {
  const result = await runCleanupChild("delayed-backends-release", "terminate");
  assert.equal(result.code, 0);
  assert.deepEqual(result.diagnostics, [
    {
      type: "remaining",
      remaining: "1",
      sql: "select count(*) as remaining\n         from pg_stat_activity\n         where datname = $1 and pid <> pg_backend_pid()",
      values: [databaseName],
    },
    {
      type: "remaining",
      remaining: "0",
      sql: "select count(*) as remaining\n         from pg_stat_activity\n         where datname = $1 and pid <> pg_backend_pid()",
      values: [databaseName],
    },
  ]);
  assert(result.elapsedMs < 500, `cleanup child exceeded its bounded deadline: ${result.elapsedMs}ms`);
});

test("cleanup terminate child does not treat a failed exact termination as success", async () => {
  assert.notEqual((await runCleanupChild("termination-failure", "terminate")).code, 0);
});

test("cleanup drop child retries an exact transient DROP failure before absence succeeds", async () => {
  assert.equal((await runCleanupChild("transient-drop", "drop")).code, 0);
});

test("isolated database teardown closes owned pools before exact active-backend termination and verifies absence", async () => {
  const calls: Array<{ readonly sql: string; readonly values?: readonly unknown[] } | string> = [];
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [
      {
        close: async () => { calls.push("owned pool closed"); },
        forceClose: async () => { assert.fail("settled pool must not be forced"); },
      },
      {
        close: async () => { calls.push("owned notifier closed"); },
        forceClose: async () => { assert.fail("settled notifier must not be forced"); },
      },
    ],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        if (/select exists/iu.test(sql)) return { rows: [{ exists: false }] };
        return { rows: [{ pg_terminate_backend: true }] };
      },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  });
  assert.deepEqual(calls.slice(0, 3), ["owned pool closed", "owned notifier closed", "admin connected"]);
  const queries = calls.filter((call): call is { readonly sql: string; readonly values?: readonly unknown[] } => typeof call !== "string");
  assert.match(queries[0]!.sql, /pg_terminate_backend[\s\S]*datname = \$1/iu);
  assert.deepEqual(queries[0]!.values, [databaseName]);
  assert.equal(queries.some(({ sql }) => sql === `drop database if exists "${databaseName}"`), true);
  assert.match(queries.at(-1)!.sql, /select exists[\s\S]*pg_database[\s\S]*datname = \$1/iu);
  assert.deepEqual(queries.at(-1)!.values, [databaseName]);
  assert.equal(calls.at(-1), "admin closed");
  assert.equal(queries.some(({ sql }) => /\blike\b|core_agent_test_%/iu.test(sql)), false);
});

test("isolated database teardown succeeds without active backends", async () => {
  let terminated = 0;
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => {
        if (/pg_terminate_backend/iu.test(sql)) terminated += 1;
        if (/select exists/iu.test(sql)) return { rows: [{ exists: false }] };
        return { rows: [] };
      },
      close: async () => undefined,
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  });
  assert.equal(terminated, 1);
});

test("isolated database teardown retries a delayed exact release within its deadline", async () => {
  let drops = 0;
  let closed = false;
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.startsWith("drop database")) {
          drops += 1;
          if (drops < 3) throw new Error("database still has an exact delayed backend");
        }
        if (/select exists/iu.test(sql)) return { rows: [{ exists: false }] };
        return { rows: [] };
      },
      close: async () => { closed = true; },
    }),
    timeoutMs: 100,
    retryDelayMs: 1,
  });
  assert.equal(drops, 3);
  assert.equal(closed, true);
});

test("isolated database teardown reports bounded failure and still closes its admin session", async () => {
  let closed = false;
  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.startsWith("drop database")) throw new Error(LEAK_SENTINEL);
        return { rows: [] };
      },
      close: async () => { closed = true; },
    }),
    timeoutMs: 15,
    retryDelayMs: 1,
  }), /^Error: Integration stage failed: database drop$/);
  assert.equal(closed, true);
});

test("isolated database teardown does not mask owned-pool or admin-close failures", async () => {
  let dropped = false;
  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => { throw new Error(LEAK_SENTINEL); },
      forceClose: async () => undefined,
    }],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.startsWith("drop database")) dropped = true;
        if (/select exists/iu.test(sql)) return { rows: [{ exists: false }] };
        return { rows: [] };
      },
      close: async () => undefined,
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  }), /^Error: Integration stage failed: owned database connections$/);
  assert.equal(dropped, true);

  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => /select exists/iu.test(sql)
        ? { rows: [{ exists: false }] }
        : { rows: [] },
      close: async () => { throw new Error(LEAK_SENTINEL); },
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  }), /^Error: Integration stage failed: database admin close$/);
});

test("integration setup failure retains its cause and surfaces exact cleanup categories", () => {
  const setupError = new Error("synthetic setup failure");
  assert.equal(testHarnessInternals.combineSetupAndCleanupFailure(setupError, []), setupError);
  const combined = testHarnessInternals.combineSetupAndCleanupFailure(
    setupError,
    ["database drop", "temporary directory"],
  );
  assert.equal(combined.message, "Integration setup failed; cleanup failed: database drop, temporary directory");
  assert.equal(combined.cause, setupError);
  assert.doesNotMatch(combined.message, new RegExp(LEAK_SENTINEL));
});

test("integration setup cleanup is wired through the category-preserving failure path", async () => {
  const setupError = new Error("synthetic setup failure");
  await assert.rejects(
    testHarnessInternals.cleanupAfterSetupFailure(setupError, [
      { category: "database drop", work: async () => { throw new Error(LEAK_SENTINEL); } },
      { category: "temporary directory", work: async () => undefined },
    ]),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Integration setup failed; cleanup failed: database drop");
      assert.equal(error.cause, setupError);
      assert.doesNotMatch(error.message, new RegExp(LEAK_SENTINEL));
      return true;
    },
  );
});

test("production isolated database creation preserves setup cause and every cleanup category", async () => {
  const setupCause = "Integration stage failed: database create";
  await assert.rejects(
    testHarnessInternals.createIsolatedDatabase({
      configuredUrl: "postgresql://test:test@127.0.0.1/core_agent_control",
      databaseName,
      createSession: {
        connect: async () => undefined,
        query: async () => { throw new Error(LEAK_SENTINEL); },
        close: async () => { throw new Error(LEAK_SENTINEL); },
      },
      controlPool: {
        query: async () => undefined,
        end: async () => undefined,
      },
      cleanupControlPool: {
        query: async () => { throw new Error(LEAK_SENTINEL); },
        end: async () => { throw new Error(LEAK_SENTINEL); },
      },
      timeoutMs: 25,
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Integration setup failed; cleanup failed: create_session_close, drop_database, admin_close");
      assert.deepEqual(
        (error as Error & { readonly cleanupFailures?: readonly string[] }).cleanupFailures,
        ["create_session_close", "drop_database", "admin_close"],
      );
      assert(error.cause instanceof Error);
      assert.equal(error.cause.message, setupCause);
      assert.doesNotMatch(error.message, new RegExp(LEAK_SENTINEL));
      return true;
    },
  );
});

test("production create child is force-terminated and reaped before categorized cleanup returns", async () => {
  const calls: string[] = [];
  let stable = true;
  await assert.rejects(
    testHarnessInternals.createIsolatedDatabase({
      configuredUrl: "postgresql://test@127.0.0.1/core_agent_control",
      databaseName,
      createOwnedProcess: () => ({
        completion: new Promise<number>(() => undefined),
        terminateAndReap: async () => { calls.push("create reaped"); },
      }),
      createCleanupOwnedProcess: () => ({
        completion: Promise.resolve(0).then((status) => { calls.push("database dropped"); return status; }),
        terminateAndReap: async () => { assert.fail("settled cleanup child must not need termination"); },
      }),
      timeoutMs: 25,
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Integration stage failed: database create");
      return true;
    },
  );
  const returned = [...calls];
  await delay(30);
  stable = calls.length === returned.length;
  assert.equal(stable, true);
  assert.deepEqual(calls, ["create reaped", "database dropped"]);
});

test("failed production create leaves no timed-out database cleanup mutation after return", async () => {
  let lateMutation = 0;
  let cleanupReaped = 0;
  let timer: NodeJS.Timeout | undefined;
  await assert.rejects(
    testHarnessInternals.createIsolatedDatabase({
      configuredUrl: "postgresql://test@127.0.0.1/core_agent_control",
      databaseName,
      createOwnedProcess: () => ({
        completion: Promise.resolve(1),
        terminateAndReap: async () => undefined,
      }),
      createCleanupOwnedProcess: () => ({
        completion: new Promise<number>((resolve) => {
          timer = setTimeout(() => { lateMutation += 1; resolve(0); }, 50);
        }),
        terminateAndReap: async () => {
          cleanupReaped += 1;
          if (timer !== undefined) clearTimeout(timer);
        },
        failureCategory: () => "admin_close",
      }),
      timeoutMs: 10,
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Integration setup failed; cleanup failed: admin_close");
      assert.equal(error.cause instanceof Error, true);
      return true;
    },
  );
  assert.equal(cleanupReaped, 1);
  assert.equal(lateMutation, 0);
  await delay(60);
  assert.equal(lateMutation, 0);
});

test("production create child rejects embedded credentials before launch", async () => {
  let launches = 0;
  await assert.rejects(testHarnessInternals.createIsolatedDatabase({
    configuredUrl: "postgresql://test:embedded@127.0.0.1/core_agent_control",
    databaseName,
    createOwnedProcess: () => {
      launches += 1;
      throw new Error("must not launch");
    },
    timeoutMs: 25,
  }), /Integration stage failed: database create/u);
  assert.equal(launches, 0);
});

test("isolated database teardown settles a delayed owned close without forcing it", async () => {
  const calls: string[] = [];
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => { await delay(5); calls.push("owned closed"); },
      forceClose: async () => { assert.fail("delayed close must not be forced"); },
    }],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string) => /select exists/iu.test(sql)
        ? { rows: [{ exists: false }] }
        : { rows: [] },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 100,
    retryDelayMs: 1,
  });
  assert.deepEqual(calls, ["owned closed", "admin connected", "admin closed"]);
});

test("isolated database teardown aborts a hung close and waits for its settlement", async () => {
  const calls: string[] = [];
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async (signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
          calls.push("owned aborted");
          resolve();
        }, { once: true }));
      },
      forceClose: async () => { assert.fail("abort-aware close must settle before force"); },
    }],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => /select exists/iu.test(sql)
        ? { rows: [{ exists: false }] }
        : { rows: [] },
      close: async () => undefined,
    }),
    timeoutMs: 60,
    retryDelayMs: 1,
  });
  assert.deepEqual(calls, ["owned aborted"]);
});

test("isolated database teardown force-terminates an abort-ignoring close with no post-return work", async () => {
  const calls: string[] = [];
  let releaseClose: (() => void) | undefined;
  const startedAt = Date.now();
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => {
        await new Promise<void>((resolve) => { releaseClose = resolve; });
        calls.push("owned settled");
      },
      forceClose: async () => {
        calls.push("owned forced");
        releaseClose?.();
      },
    }],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string) => /select exists/iu.test(sql)
        ? { rows: [{ exists: false }] }
        : { rows: [] },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
  });
  assert(Date.now() - startedAt < 100);
  const returnedCalls = [...calls];
  await delay(40);
  assert.deepEqual(calls, returnedCalls);
  assert.deepEqual(calls, ["owned forced", "owned settled", "admin connected", "admin closed"]);
});

test("tracked PostgreSQL pool never forces a released idle client even when remove is delayed", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  const idle = { release: (destroy?: boolean) => { released.push(`idle:${String(destroy)}`); } };
  const tracked = testHarnessInternals.trackPostgresPool(pool, async () => undefined);
  pool.emit("connect", idle);
  pool.emit("acquire", idle);
  pool.emit("release", undefined, idle);
  await tracked.forceClose();
  pool.emit("remove", idle);
  assert.deepEqual(released, []);
  assert.equal("_clients" in pool, false);
});

test("production PostgreSQL pool teardown aborts and reaps a pre-auth connection before return", async () => {
  const sockets = new Set<Socket>();
  let acceptConnection: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => { acceptConnection = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
    acceptConnection?.();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const ownedPool = testHarnessInternals.createOwnedPostgresPool({
    host: "127.0.0.1",
    port: address.port,
    user: "synthetic",
    password: "synthetic",
    database: "synthetic",
    max: 1,
    connectionTimeoutMillis: 6_000,
  });
  const pool = ownedPool.pool;
  let acquired = 0;
  pool.on("acquire", () => { acquired += 1; });
  const connecting = pool.connect().then(
    (client) => { client.release(); },
    () => undefined,
  );
  await accepted;
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    () => pool.end(),
    ownedPool.terminatePreAuthConnections,
  );
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [tracked],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => /select exists/iu.test(sql)
        ? { rows: [{ exists: false }] }
        : { rows: [] },
      close: async () => undefined,
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  });
  try {
    const outcome = await Promise.race([
      teardown.then(() => "returned", () => "rejected"),
      delay(250).then(() => "still-running"),
    ]);
    assert.notEqual(outcome, "still-running");
    await teardown.catch(() => undefined);
    await connecting;
    assert.equal(acquired, 0);
    assert.equal(sockets.size, 0);
    await delay(30);
    assert.equal(sockets.size, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await connecting;
    await teardown.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
});

test("owned PostgreSQL pool rejects a TLS transport replacement before an external peer can escape teardown", async () => {
  const rawPeers = new Set<Socket>();
  const externalPeers = new Set<Socket>();
  let acceptRaw: (() => void) | undefined;
  let observeExternalTls: (() => void) | undefined;
  const rawAccepted = new Promise<void>((resolve) => { acceptRaw = resolve; });
  const externalTlsObserved = new Promise<void>((resolve) => { observeExternalTls = resolve; });
  const rawServer = createServer((socket) => {
    rawPeers.add(socket);
    socket.once("close", () => rawPeers.delete(socket));
    socket.once("data", () => {
      socket.write("S");
      acceptRaw?.();
    });
  });
  const externalServer = createServer((socket) => {
    externalPeers.add(socket);
    socket.once("close", () => externalPeers.delete(socket));
    socket.once("data", () => observeExternalTls?.());
  });
  await Promise.all([rawServer, externalServer].map((server) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  })));
  const rawAddress = rawServer.address();
  const externalAddress = externalServer.address();
  assert(rawAddress !== null && typeof rawAddress !== "string");
  assert(externalAddress !== null && typeof externalAddress !== "string");
  const externalSocket = createConnection({ host: "127.0.0.1", port: externalAddress.port });
  await new Promise<void>((resolve, reject) => {
    externalSocket.once("connect", resolve);
    externalSocket.once("error", reject);
  });
  let connecting: Promise<void> | undefined;
  let teardown: Promise<void> | undefined;
  let ownedPool: ReturnType<typeof testHarnessInternals.createOwnedPostgresPool> | undefined;
  let poolWasCreated = false;
  try {
    try {
      ownedPool = testHarnessInternals.createOwnedPostgresPool({
        host: "127.0.0.1",
        port: rawAddress.port,
        user: "synthetic",
        password: "synthetic",
        database: "synthetic",
        max: 1,
        connectionTimeoutMillis: 6_000,
        ssl: { rejectUnauthorized: false, socket: externalSocket } as never,
      });
      poolWasCreated = true;
    } catch (error) {
      assert.match(String(error), /TLS configuration contains an unsafe field: socket/u);
      return;
    }
    const pool = ownedPool.pool;
    connecting = pool.connect().then(
      (client) => { client.release(); },
      () => undefined,
    );
    await rawAccepted;
    await externalTlsObserved;
    const tracked = testHarnessInternals.trackPostgresPool(
      pool,
      () => pool.end(),
      ownedPool.terminatePreAuthConnections,
    );
    teardown = testHarnessInternals.dropIsolatedDatabase({
      databaseName,
      closeOwned: [tracked],
      createAdminSession: () => ({
        connect: async () => undefined,
        query: async (sql: string) => /select exists/iu.test(sql)
          ? { rows: [{ exists: false }] }
          : { rows: [] },
        close: async () => undefined,
      }),
      timeoutMs: 50,
      retryDelayMs: 1,
    });
    const outcome = await Promise.race([
      teardown.then(() => "returned", () => "rejected"),
      delay(250).then(() => "still-running"),
    ]);
    assert.notEqual(outcome, "still-running");
    assert.equal(externalPeers.size, 0, "teardown returned while the replacement TLS peer remained open");
  } finally {
    externalSocket.destroy();
    for (const socket of rawPeers) socket.destroy();
    for (const socket of externalPeers) socket.destroy();
    await connecting;
    await teardown?.catch(() => undefined);
    await ownedPool?.pool.end().catch(() => undefined);
    await Promise.all([rawServer, externalServer].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    })));
  }
  assert.equal(poolWasCreated, false);
});

test("owned PostgreSQL pool accepts only inert plain-data TLS configuration", async () => {
  const unsafe = [
    ["stream", { stream: () => new Socket() }],
    ["createConnection", { createConnection: () => new Socket() }],
    ["unknown", { unknown: true }],
  ] as const;
  for (const [field, ssl] of unsafe) {
    assert.throws(
      () => testHarnessInternals.createOwnedPostgresPool({ ssl } as never),
      new RegExp(`TLS configuration contains an unsafe field: ${field}`, "u"),
    );
  }
  const accessor = Object.defineProperty({}, "rejectUnauthorized", { get: () => false, enumerable: true });
  assert.throws(
    () => testHarnessInternals.createOwnedPostgresPool({ ssl: accessor } as never),
    /TLS configuration must contain only plain data properties/u,
  );
  const inherited = Object.create({ rejectUnauthorized: false }) as Record<string, unknown>;
  assert.throws(
    () => testHarnessInternals.createOwnedPostgresPool({ ssl: inherited } as never),
    /TLS configuration must be a plain object/u,
  );
  assert.throws(
    () => testHarnessInternals.createOwnedPostgresPool({ ssl: { rejectUnauthorized: "false" } } as never),
    /TLS configuration field rejectUnauthorized must be a boolean/u,
  );

  let indexGetterHits = 0;
  const accessorArray = new Array<string>(1);
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get: () => {
      indexGetterHits += 1;
      return "synthetic-ca";
    },
  });
  let accessorError: unknown;
  let accessorPool: ReturnType<typeof testHarnessInternals.createOwnedPostgresPool> | undefined;
  try {
    accessorPool = testHarnessInternals.createOwnedPostgresPool({ ssl: { ca: accessorArray } } as never);
  } catch (error) {
    accessorError = error;
  } finally {
    await accessorPool?.pool.end();
  }
  assert.equal(indexGetterHits, 0);
  assert.match(String(accessorError), /TLS configuration field ca must be an exact inert array/u);

  const sparse = new Array<string>(1);
  const customPrototype = ["synthetic-ca"];
  Object.setPrototypeOf(customPrototype, null);
  const symbolKey = ["synthetic-ca"];
  Object.defineProperty(symbolKey, Symbol("hidden"), { value: "synthetic", enumerable: true });
  const hiddenKey = ["synthetic-ca"];
  Object.defineProperty(hiddenKey, "hidden", { value: "synthetic", enumerable: false });
  const extraKey = ["synthetic-ca"] as string[] & { extra?: string };
  extraKey.extra = "synthetic";
  const abnormalLength = ["synthetic-ca"];
  Object.defineProperty(abnormalLength, "length", { writable: false });
  for (const candidate of [sparse, customPrototype, symbolKey, hiddenKey, extraKey, abnormalLength]) {
    assert.throws(
      () => testHarnessInternals.createOwnedPostgresPool({ ssl: { ca: candidate } } as never),
      /TLS configuration field ca must be an exact inert array/u,
    );
  }

  for (const field of ["ca", "cert", "key"] as const) {
    const sourceBuffer = Buffer.from("synthetic-tls-material");
    const sourceArray: Array<string | Buffer> = [sourceBuffer, "synthetic-tls-material"];
    const aliasPool = testHarnessInternals.createOwnedPostgresPool({ ssl: { [field]: sourceArray } } as never);
    const accepted = (aliasPool.pool as unknown as {
      readonly options: { readonly ssl: Record<string, unknown> };
    }).options.ssl[field];
    assert(Array.isArray(accepted));
    assert.equal(Object.isFrozen(accepted), true);
    assert.notEqual(accepted, sourceArray);
    assert(Buffer.isBuffer(accepted[0]));
    assert.notEqual(accepted[0], sourceBuffer);
    sourceBuffer.fill(0x78);
    sourceArray[0] = "mutated";
    sourceArray[1] = "mutated";
    assert.equal((accepted[0] as Buffer).toString("utf8"), "synthetic-tls-material");
    assert.equal(accepted[1], "synthetic-tls-material");
    await aliasPool.pool.end();
  }

  const getterObservations: Array<{
    readonly field: "ca" | "cert" | "key";
    readonly form: "array" | "direct";
    readonly byteLengthHits: number;
    readonly lengthHits: number;
  }> = [];
  for (const field of ["ca", "cert", "key"] as const) {
    for (const form of ["direct", "array"] as const) {
      const expectedMaterial = Buffer.from(`synthetic-${field}-${form}`);
      const sourceBuffer = Buffer.from(expectedMaterial);
      const sourceByteLength = expectedMaterial.length;
      let byteLengthHits = 0;
      let lengthHits = 0;
      Object.defineProperty(sourceBuffer, "byteLength", {
        configurable: true,
        get: () => {
          byteLengthHits += 1;
          return sourceByteLength;
        },
      });
      Object.defineProperty(sourceBuffer, "length", {
        configurable: true,
        get: () => {
          lengthHits += 1;
          return sourceByteLength;
        },
      });
      const sourceValue = form === "direct" ? sourceBuffer : [sourceBuffer];
      const getterPool = testHarnessInternals.createOwnedPostgresPool({
        ssl: { [field]: sourceValue },
      } as never);
      const acceptedValue = (getterPool.pool as unknown as {
        readonly options: { readonly ssl: Record<string, unknown> };
      }).options.ssl[field];
      const acceptedBuffer = form === "direct"
        ? acceptedValue
        : Array.isArray(acceptedValue) ? acceptedValue[0] : undefined;
      assert(Buffer.isBuffer(acceptedBuffer));
      assert.notEqual(acceptedBuffer, sourceBuffer);
      assert.equal(acceptedBuffer.toString("utf8"), expectedMaterial.toString("utf8"));
      if (form === "array") {
        assert(Array.isArray(acceptedValue));
        assert.equal(Object.isFrozen(acceptedValue), true);
        assert.notEqual(acceptedValue, sourceValue);
      }
      sourceBuffer[0] = 0x78;
      assert.equal(acceptedBuffer.toString("utf8"), expectedMaterial.toString("utf8"));
      getterObservations.push({ field, form, byteLengthHits, lengthHits });
      await getterPool.pool.end();
    }
  }
  assert.deepEqual(
    getterObservations,
    ["ca", "cert", "key"].flatMap((field) => ["direct", "array"].map((form) => ({
      field,
      form,
      byteLengthHits: 0,
      lengthHits: 0,
    }))),
  );

  const prototypeLookalikeObservations: Array<{
    readonly field: "ca" | "cert" | "key";
    readonly form: "array" | "direct";
    readonly message: string;
    readonly byteLengthHits: number;
    readonly lengthHits: number;
    readonly toStringTagHits: number;
  }> = [];
  for (const field of ["ca", "cert", "key"] as const) {
    for (const form of ["direct", "array"] as const) {
      let byteLengthHits = 0;
      let lengthHits = 0;
      let toStringTagHits = 0;
      const lookalike = Object.create(Buffer.prototype) as object;
      Object.defineProperties(lookalike, {
        byteLength: {
          configurable: true,
          get: () => {
            byteLengthHits += 1;
            return 1;
          },
        },
        length: {
          configurable: true,
          get: () => {
            lengthHits += 1;
            return 1;
          },
        },
        [Symbol.toStringTag]: {
          configurable: true,
          get: () => {
            toStringTagHits += 1;
            return "Buffer";
          },
        },
      });
      const input = form === "direct" ? lookalike : [lookalike];
      let caught: unknown;
      try {
        testHarnessInternals.createOwnedPostgresPool({ ssl: { [field]: input } } as never);
      } catch (error) {
        caught = error;
      }
      prototypeLookalikeObservations.push({
        field,
        form,
        message: caught instanceof Error ? caught.message : "non-error",
        byteLengthHits,
        lengthHits,
        toStringTagHits,
      });
    }
  }
  assert.deepEqual(
    prototypeLookalikeObservations,
    ["ca", "cert", "key"].flatMap((field) => ["direct", "array"].map((form) => ({
      field,
      form,
      message: `Integration PostgreSQL pool TLS configuration field ${field} must contain strings or buffers`,
      byteLengthHits: 0,
      lengthHits: 0,
      toStringTagHits: 0,
    }))),
  );

  for (const field of ["ca", "cert", "key"] as const) {
    for (const form of ["direct", "array"] as const) {
      const maximum = Buffer.alloc(1_048_576);
      const maximumValue = form === "direct" ? maximum : [maximum];
      const maximumPool = testHarnessInternals.createOwnedPostgresPool({
        ssl: { [field]: maximumValue },
      } as never);
      await maximumPool.pool.end();

      const oversized = Buffer.alloc(1_048_577);
      const oversizedValue = form === "direct" ? oversized : [oversized];
      assert.throws(
        () => testHarnessInternals.createOwnedPostgresPool({ ssl: { [field]: oversizedValue } } as never),
        new RegExp(`TLS configuration field ${field} is too large`, "u"),
      );
    }

    let fakeByteLengthHits = 0;
    const fakeBuffer = Object.defineProperty({ [Symbol.toStringTag]: "Buffer" }, "byteLength", {
      enumerable: true,
      get: () => {
        fakeByteLengthHits += 1;
        return 1;
      },
    });
    for (const candidate of [new Uint8Array([1]), fakeBuffer]) {
      assert.throws(
        () => testHarnessInternals.createOwnedPostgresPool({ ssl: { [field]: candidate } } as never),
        new RegExp(`TLS configuration field ${field} must contain strings or buffers`, "u"),
      );
      assert.throws(
        () => testHarnessInternals.createOwnedPostgresPool({ ssl: { [field]: [candidate] } } as never),
        new RegExp(`TLS configuration field ${field} must contain strings or buffers`, "u"),
      );
    }
    assert.equal(fakeByteLengthHits, 0);
  }

  const ownedPool = testHarnessInternals.createOwnedPostgresPool({
    ssl: { rejectUnauthorized: false, servername: "localhost", minVersion: "TLSv1.2", maxVersion: "TLSv1.3" },
  });
  await ownedPool.pool.end();
  await ownedPool.terminatePreAuthConnections();
  await ownedPool.terminatePreAuthConnections();
});

test("owned PostgreSQL TLS handshake stalls are terminal on IPv4 and IPv6", async (t) => {
  for (const host of ["127.0.0.1", "::1"] as const) {
    await t.test(host, async () => {
      const peers = new Set<Socket>();
      let observeTls: (() => void) | undefined;
      const tlsObserved = new Promise<void>((resolve) => { observeTls = resolve; });
      const server = createServer((socket) => {
        peers.add(socket);
        socket.once("close", () => peers.delete(socket));
        socket.once("data", () => {
          socket.write("S");
          socket.once("data", () => observeTls?.());
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      const address = server.address();
      assert(address !== null && typeof address !== "string");
      const ssl = { rejectUnauthorized: false, servername: "localhost" };
      const ownedPool = testHarnessInternals.createOwnedPostgresPool({
        host,
        port: address.port,
        user: "synthetic",
        password: "synthetic",
        database: "synthetic",
        max: 1,
        connectionTimeoutMillis: 6_000,
        ssl,
      });
      Object.assign(ssl, { socket: Object.freeze({}), createConnection: () => assert.fail("source TLS configuration was retained") });
      const connecting = ownedPool.pool.connect().then(
        (client) => { client.release(); },
        () => undefined,
      );
      try {
        await tlsObserved;
        await ownedPool.terminatePreAuthConnections();
        await ownedPool.terminatePreAuthConnections();
        await ownedPool.pool.end();
        await connecting;
        assert.equal(peers.size, 0);
        await delay(30);
        assert.equal(peers.size, 0);
      } finally {
        for (const socket of peers) socket.destroy();
        await connecting;
        await ownedPool.pool.end().catch(() => undefined);
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
    });
  }
});

test("owned PostgreSQL pool rejects every top-level custom transport seam", () => {
  assert.throws(
    () => testHarnessInternals.createOwnedPostgresPool({ stream: () => new Socket() } as never),
    /requires the owned connector/u,
  );
  assert.throws(
    () => testHarnessInternals.createOwnedPostgresPool({ Client: class extends EventEmitter {} } as never),
    /requires the owned connector/u,
  );
});

test("tracked PostgreSQL pool forces one held checkout exactly once and never touches a foreign client", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  const held = { release: (destroy?: boolean) => { released.push(`held:${String(destroy)}`); } };
  const foreign = { release: (destroy?: boolean) => { released.push(`foreign:${String(destroy)}`); } };
  const tracked = testHarnessInternals.trackPostgresPool(pool, async () => undefined);
  pool.emit("acquire", held);
  await tracked.forceClose();
  await tracked.forceClose();
  foreign.release(false);
  assert.deepEqual(released, ["held:true", "foreign:false"]);
});

test("release and remove racing the force handoff prevent a double release", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  const second = { release: (destroy?: boolean) => { released.push(`second:${String(destroy)}`); } };
  const first = { release: (destroy?: boolean) => {
    released.push(`first:${String(destroy)}`);
    pool.emit("release", undefined, second);
    pool.emit("remove", second);
  } };
  const tracked = testHarnessInternals.trackPostgresPool(pool, async () => undefined);
  pool.emit("acquire", first);
  pool.emit("acquire", second);
  await tracked.forceClose();
  assert.deepEqual(released, ["first:true"]);
});

test("force-close aggregates failures while processing every exact held checkout", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  const first = { release: () => { released.push("first"); throw new Error("first force failed"); } };
  const second = { release: () => { released.push("second"); throw new Error("second force failed"); } };
  const third = { release: () => { released.push("third"); } };
  const tracked = testHarnessInternals.trackPostgresPool(pool, async () => undefined);
  pool.emit("acquire", first);
  pool.emit("acquire", second);
  pool.emit("acquire", third);
  await tracked.forceClose();
  await assert.rejects(tracked.close(new AbortController().signal), (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.deepEqual(released, ["first", "second", "third"]);
});

test("force failure still waits for the original pool close and leaves no post-return mutation", async () => {
  const pool = new EventEmitter();
  const calls: string[] = [];
  let releaseClose: (() => void) | undefined;
  const held = { release: () => {
    calls.push("held force failed");
    setTimeout(() => {
      calls.push("pool close settled");
      releaseClose?.();
    }, 10);
    throw new Error("synthetic force failure");
  } };
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { releaseClose = resolve; }); },
  );
  pool.emit("acquire", held);
  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [tracked],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string) => /select exists/iu.test(sql)
        ? { rows: [{ exists: false }] }
        : { rows: [] },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
  }), /^Error: Integration stage failed: owned database connections$/);
  assert.equal(calls[0], "held force failed");
  assert.equal(calls.at(-1), "admin closed");
  assert.deepEqual(new Set(calls), new Set(["held force failed", "admin connected", "pool close settled", "admin closed"]));
  const returnedCalls = [...calls];
  await delay(30);
  assert.deepEqual(calls, returnedCalls);
});

test("forcing drains a synchronous late acquire after the current release event stack", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  let settleClose: (() => void) | undefined;
  const late = { release: (destroy?: boolean) => {
    released.push(`late:${String(destroy)}`);
    pool.emit("release", undefined, late);
    settleClose?.();
  } };
  const first = { release: (destroy?: boolean) => {
    released.push(`first:${String(destroy)}`);
    pool.emit("remove", first);
    pool.emit("acquire", late);
  } };
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { settleClose = resolve; }); },
  );
  pool.emit("acquire", first);
  const close = tracked.close(new AbortController().signal);
  const fallback = setTimeout(() => {
    pool.emit("release", undefined, late);
    settleClose?.();
  }, 30);
  await tracked.forceClose();
  await close;
  clearTimeout(fallback);
  assert.deepEqual(released, ["first:true", "late:true"]);
});

test("forcing continuously drains an asynchronous late acquire", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  let settleClose: (() => void) | undefined;
  const late = { release: (destroy?: boolean) => {
    released.push(`late:${String(destroy)}`);
    pool.emit("release", undefined, late);
    settleClose?.();
  } };
  const first = { release: (destroy?: boolean) => {
    released.push(`first:${String(destroy)}`);
    pool.emit("remove", first);
    setTimeout(() => pool.emit("acquire", late), 0);
  } };
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { settleClose = resolve; }); },
  );
  pool.emit("acquire", first);
  const close = tracked.close(new AbortController().signal);
  const fallback = setTimeout(() => {
    pool.emit("release", undefined, late);
    settleClose?.();
  }, 30);
  await tracked.forceClose();
  await close;
  clearTimeout(fallback);
  assert.deepEqual(released, ["first:true", "late:true"]);
});

test("a late acquire normally released in the same event stack is never force-released", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  let settleClose: (() => void) | undefined;
  const late = { release: (destroy?: boolean) => { released.push(`late:${String(destroy)}`); } };
  const first = { release: (destroy?: boolean) => {
    released.push(`first:${String(destroy)}`);
    pool.emit("remove", first);
    pool.emit("acquire", late);
    pool.emit("release", undefined, late);
    queueMicrotask(() => settleClose?.());
  } };
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { settleClose = resolve; }); },
  );
  pool.emit("acquire", first);
  const close = tracked.close(new AbortController().signal);
  await tracked.forceClose();
  await close;
  assert.deepEqual(released, ["first:true"]);
});

test("forcing drains multiple late-acquire waves and repeated force calls remain at-most-once", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  let settleClose: (() => void) | undefined;
  const third = { release: (destroy?: boolean) => {
    released.push(`third:${String(destroy)}`);
    pool.emit("remove", third);
    settleClose?.();
  } };
  const second = { release: (destroy?: boolean) => {
    released.push(`second:${String(destroy)}`);
    pool.emit("remove", second);
    setTimeout(() => pool.emit("acquire", third), 0);
  } };
  const first = { release: (destroy?: boolean) => {
    released.push(`first:${String(destroy)}`);
    pool.emit("remove", first);
    queueMicrotask(() => pool.emit("acquire", second));
  } };
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { settleClose = resolve; }); },
  );
  pool.emit("acquire", first);
  const close = tracked.close(new AbortController().signal);
  const fallback = setTimeout(() => settleClose?.(), 40);
  await Promise.all([tracked.forceClose(), tracked.forceClose(), tracked.forceClose()]);
  await close;
  clearTimeout(fallback);
  assert.deepEqual(released, ["first:true", "second:true", "third:true"]);
});

test("a force failure from a late checkout is aggregated only after close settles", async () => {
  const pool = new EventEmitter();
  const calls: string[] = [];
  let settleClose: (() => void) | undefined;
  const late = { release: () => {
    calls.push("late force failed");
    setTimeout(() => {
      calls.push("pool close settled");
      settleClose?.();
    }, 5);
    throw new Error("late force failure");
  } };
  const first = { release: () => {
    calls.push("first forced");
    pool.emit("remove", first);
    queueMicrotask(() => pool.emit("acquire", late));
  } };
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { settleClose = resolve; }); },
  );
  pool.emit("acquire", first);
  const close = tracked.close(new AbortController().signal);
  await tracked.forceClose();
  await assert.rejects(close, (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    return true;
  });
  assert.deepEqual(calls, ["first forced", "late force failed", "pool close settled"]);
  const returnedCalls = [...calls];
  await delay(20);
  assert.deepEqual(calls, returnedCalls);
});

test("exact admin termination unblocks an owned close before DROP and absence verification", async () => {
  const calls: string[] = [];
  let settleClose: (() => void) | undefined;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => {
        calls.push("close started");
        await new Promise<void>((resolve) => { settleClose = resolve; });
        calls.push("close settled");
      },
      forceClose: async () => { calls.push("force attempted"); },
    }],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string, values?: readonly unknown[]) => {
        if (/pg_terminate_backend/iu.test(sql)) {
          calls.push(`terminate:${String(values?.[0])}`);
          settleClose?.();
          return { rows: [{ pg_terminate_backend: true }] };
        }
        if (sql.startsWith("drop database")) calls.push("drop");
        if (/select exists/iu.test(sql)) {
          calls.push("absence verified");
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
  });
  await Promise.race([
    teardown,
    delay(150).then(() => { throw new Error("admin termination was unreachable"); }),
  ]);
  assert.deepEqual(calls, [
    "close started", "force attempted", "admin connected", `terminate:${databaseName}`,
    "close settled", "drop", "absence verified", "admin closed",
  ]);
});

test("force failure does not skip exact termination close settlement DROP or absence", async () => {
  const calls: string[] = [];
  let settleClose: (() => void) | undefined;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => {
        await new Promise<void>((resolve) => { settleClose = resolve; });
        calls.push("close settled");
      },
      forceClose: async () => { calls.push("force failed"); throw new Error(LEAK_SENTINEL); },
    }],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string, values?: readonly unknown[]) => {
        if (/pg_terminate_backend/iu.test(sql)) {
          assert.deepEqual(values, [databaseName]);
          calls.push("exact terminated");
          settleClose?.();
        }
        if (sql.startsWith("drop database")) calls.push("drop");
        if (/select exists/iu.test(sql)) {
          calls.push("absence verified");
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
  });
  await assert.rejects(Promise.race([
    teardown,
    delay(150).then(() => { throw new Error("force failure skipped admin termination"); }),
  ]), /^Error: Integration stage failed: owned database connections$/);
  assert.deepEqual(calls, [
    "force failed", "admin connected", "exact terminated", "close settled",
    "drop", "absence verified", "admin closed",
  ]);
});

test("exact termination failure still waits for terminal close and attempts DROP and absence", async () => {
  const calls: string[] = [];
  let settleClose: (() => void) | undefined;
  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => {
        await new Promise<void>((resolve) => { settleClose = resolve; });
        calls.push("close settled");
      },
      forceClose: async () => { calls.push("force attempted"); },
    }],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string, values?: readonly unknown[]) => {
        if (/pg_terminate_backend/iu.test(sql)) {
          assert.deepEqual(values, [databaseName]);
          calls.push("exact termination failed");
          settleClose?.();
          throw new Error(LEAK_SENTINEL);
        }
        if (sql.startsWith("drop database")) calls.push("drop attempted");
        if (/select exists/iu.test(sql)) {
          calls.push("absence verified");
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
  }), /^Error: Integration stage failed: database drop$/);
  assert.deepEqual(calls, [
    "force attempted", "admin connected", "exact termination failed", "close settled",
    "drop attempted", "absence verified", "admin closed",
  ]);
});

test("admin connection failure is categorized after every owned close becomes terminal", async () => {
  const calls: string[] = [];
  let settleClose: (() => void) | undefined;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => {
        await new Promise<void>((resolve) => { settleClose = resolve; });
        calls.push("close settled");
      },
      forceClose: async () => { calls.push("force attempted"); },
    }],
    createAdminSession: () => ({
      connect: async () => {
        calls.push("admin connect failed");
        settleClose?.();
        throw new Error(LEAK_SENTINEL);
      },
      query: async () => { assert.fail("failed admin must not query"); },
      close: async () => { calls.push("admin closed"); },
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
  });
  await assert.rejects(Promise.race([
    teardown,
    delay(150).then(() => { throw new Error("admin connection remained unreachable"); }),
  ]), /^Error: Integration stage failed: database drop$/);
  assert.deepEqual(calls, ["force attempted", "admin connect failed", "close settled", "admin closed"]);
});

test("terminal Pool tracking detaches listeners and neutralizes a next-tick acquire", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  const client = { release: (destroy?: boolean) => { released.push(String(destroy)); } };
  const tracked = testHarnessInternals.trackPostgresPool(pool, async () => undefined);
  await tracked.close(new AbortController().signal);
  await tracked.forceClose();
  assert.equal(pool.listenerCount("acquire"), 0);
  assert.equal(pool.listenerCount("release"), 0);
  assert.equal(pool.listenerCount("remove"), 0);
  process.nextTick(() => pool.emit("acquire", client));
  await delay(0);
  await tracked.forceClose();
  assert.deepEqual(released, []);
});

test("hung close and hung force cannot consume the reserved exact-termination slice", async () => {
  const calls: string[] = [];
  let terminal = false;
  let clock = 0;
  let clockReads = 0;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => { await new Promise(() => undefined); },
      forceClose: async () => { await new Promise(() => undefined); },
      forceTerminate: () => terminalOperation(() => { terminal = true; calls.push("owned terminal"); }),
    }],
    createAdminSession: () => ({
      connect: async () => { calls.push("admin connected"); },
      query: async (sql: string) => {
        if (/pg_terminate_backend/iu.test(sql)) {
          clock += 1_000;
          calls.push("exact terminated");
        }
        if (sql.startsWith("drop database")) calls.push("drop attempted");
        if (/select exists/iu.test(sql)) {
          calls.push("absence verified");
          return { rows: [{ exists: false }] };
        }
        return { rows: [] };
      },
      close: async () => { calls.push("admin closed"); },
      forceTerminate: () => terminalOperation(() => { calls.push("admin terminal"); }),
    }),
    timeoutMs: 80,
    retryDelayMs: 1,
    now: () => { clockReads += 1; return clock; },
  });
  await assert.rejects(Promise.race([
    teardown,
    delay(150).then(() => { throw new Error("cleanup exceeded its terminal deadline"); }),
  ]), /^Error: Integration stage failed: owned database connections$/);
  assert.equal(terminal, true);
  assert.equal(clockReads > 0, true);
  assert.deepEqual(calls, [
    "admin connected", "exact terminated", "owned terminal",
    "drop attempted", "absence verified", "admin closed",
  ]);
});

test("hung admin connect is force-terminated and reaped before return", async () => {
  const calls: string[] = [];
  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [],
    createAdminSession: () => ({
      connect: async () => { await new Promise(() => undefined); },
      query: async () => { assert.fail("hung connect must not query"); },
      close: async () => { await new Promise(() => undefined); },
      forceTerminate: () => terminalOperation(() => { calls.push("admin reaped"); }),
    }),
    timeoutMs: 60,
    retryDelayMs: 1,
  }), /^Error: Integration teardown failed: database drop, database admin close$/);
  assert.deepEqual(calls, ["admin reaped"]);
  const stable = [...calls];
  await delay(30);
  assert.deepEqual(calls, stable);
});

test("timed-out owned terminalization cannot mutate after teardown returns", async () => {
  const calls: string[] = [];
  let finishTerminal: (() => void) | undefined;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [{
      close: async () => { await new Promise(() => undefined); },
      forceClose: async () => { await new Promise(() => undefined); },
      forceTerminate: () => {
        let cancelled = false;
        const completion = new Promise<void>((resolve) => { finishTerminal = () => {
          if (!cancelled) calls.push("late owned mutation");
          resolve();
        }; });
        return { completion, terminateAndReap: async () => { cancelled = true; finishTerminal?.(); await completion; } };
      },
    }],
    createAdminSession: () => ({
      connect: async () => undefined,
      query: async (sql: string) => /select exists/iu.test(sql) ? { rows: [{ exists: false }] } : { rows: [] },
      close: async () => undefined,
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  });
  await assert.rejects(teardown, /owned database connections/u);
  finishTerminal?.();
  await delay(10);
  assert.deepEqual(calls, []);
});

test("hung admin terminalization uses a concrete bounded reap protocol", async () => {
  const calls: string[] = [];
  let finishTerminal: (() => void) | undefined;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [],
    createAdminSession: () => ({
      connect: async () => { await new Promise(() => undefined); },
      query: async () => ({ rows: [] }),
      close: async () => { await new Promise(() => undefined); },
      forceTerminate: () => {
        let cancelled = false;
        const completion = new Promise<void>((resolve) => { finishTerminal = () => {
          if (!cancelled) calls.push("admin terminal settled");
          resolve();
        }; });
        return { completion, terminateAndReap: async () => { cancelled = true; finishTerminal?.(); await completion; } };
      },
    }),
    timeoutMs: 50,
    retryDelayMs: 1,
  });
  const outcome = Promise.race([
    teardown.then(() => "returned", () => "rejected"),
    delay(100).then(() => "still-running"),
  ]);
  assert.notEqual(await outcome, "still-running");
  finishTerminal?.();
  await teardown.catch(() => undefined);
  assert.deepEqual(calls, []);
});
