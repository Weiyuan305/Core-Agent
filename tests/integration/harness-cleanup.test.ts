import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { LEAK_SENTINEL, testHarnessInternals } from "./harness.js";

const databaseName = "core_agent_test_0123456789abcdef";

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

test("tracked PostgreSQL pool uses public lifecycle events and force-closes only its owned clients", async () => {
  const pool = new EventEmitter();
  const released: string[] = [];
  const ownedOne = { release: (destroy?: boolean) => { released.push(`owned one:${String(destroy)}`); } };
  const ownedRemoved = { release: (destroy?: boolean) => { released.push(`owned removed:${String(destroy)}`); } };
  const foreign = { release: (destroy?: boolean) => { released.push(`foreign:${String(destroy)}`); } };
  let releaseClose: (() => void) | undefined;
  const tracked = testHarnessInternals.trackPostgresPool(
    pool,
    async () => { await new Promise<void>((resolve) => { releaseClose = resolve; }); },
  );
  pool.emit("connect", ownedOne);
  pool.emit("connect", ownedRemoved);
  pool.emit("remove", ownedRemoved);
  const close = tracked.close(new AbortController().signal);
  await tracked.forceClose();
  releaseClose?.();
  await close;
  foreign.release(false);
  assert.deepEqual(released, ["owned one:true", "foreign:false"]);
  assert.equal("_clients" in pool, false);
});
