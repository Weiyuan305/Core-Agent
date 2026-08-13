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
  assert.deepEqual(calls, ["held force failed", "admin connected", "pool close settled", "admin closed"]);
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
