import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { LEAK_SENTINEL, testHarnessInternals } from "./harness.js";

const databaseName = "core_agent_test_0123456789abcdef";

test("isolated database teardown closes owned pools before exact active-backend termination and verifies absence", async () => {
  const calls: Array<{ readonly sql: string; readonly values?: readonly unknown[] } | string> = [];
  await testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [
      async () => { calls.push("owned pool closed"); },
      async () => { calls.push("owned notifier closed"); },
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
    closeOwned: [async () => { throw new Error(LEAK_SENTINEL); }],
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

test("isolated database teardown uses one deadline and cancels admin work before returning", async () => {
  const calls: string[] = [];
  let cancelled = false;
  const startedAt = Date.now();
  await assert.rejects(testHarnessInternals.dropIsolatedDatabase({
    databaseName,
    closeOwned: [async () => { await delay(20); calls.push("owned closed"); }],
    createAdminSession: () => ({
      connect: async () => {
        await delay(25);
        if (!cancelled) calls.push("admin connected");
      },
      query: async () => { calls.push("unexpected query"); return { rows: [] }; },
      close: async () => { cancelled = true; calls.push("admin closed"); },
    }),
    timeoutMs: 35,
    retryDelayMs: 1,
  }), /^Error: Integration stage failed: database drop$/);
  assert(Date.now() - startedAt < 80);
  const returnedCalls = [...calls];
  await delay(40);
  assert.deepEqual(calls, returnedCalls);
  assert.deepEqual(calls, ["owned closed", "admin closed"]);
});
