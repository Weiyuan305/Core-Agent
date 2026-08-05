import assert from "node:assert/strict";
import test from "node:test";

import {
  LEAK_SENTINEL,
  testHarnessInternals,
} from "./harness.js";

function sentinelError(work: () => void): Error {
  let captured: unknown;
  try {
    work();
  } catch (error) {
    captured = error;
  }
  assert(captured instanceof Error);
  assert.equal(captured.message, "sentinel category: structured logs");
  assert.doesNotMatch(captured.message, new RegExp(LEAK_SENTINEL));
  return captured;
}

test("structured log sentinel detection is lossless beyond bounded snapshots", () => {
  const nested = { value: LEAK_SENTINEL };
  let nestedValue: unknown = nested;
  for (let depth = 0; depth < 8; depth += 1) nestedValue = { nested: nestedValue };

  const objectBeyondSnapshot: Record<string, string> = {};
  for (let index = 0; index < 101; index += 1) {
    objectBeyondSnapshot[`field_${index}`] = index === 100 ? LEAK_SENTINEL : "safe";
  }
  const arrayBeyondSnapshot = Array.from(
    { length: 101 },
    (_, index) => index === 100 ? LEAK_SENTINEL : "safe",
  );
  const error = new Error(`nested failure ${LEAK_SENTINEL}`, {
    cause: { detail: LEAK_SENTINEL },
  });
  class NonPlainLogField {
    readonly detail = LEAK_SENTINEL;
  }

  for (const fields of [
    nestedValue,
    objectBeyondSnapshot,
    arrayBeyondSnapshot,
    error,
    new NonPlainLogField(),
  ]) {
    const records: unknown[] = [];
    testHarnessInternals.captureStructuredLog(records, "api_log", fields, "safe");
    sentinelError(() => {
      testHarnessInternals.assertStructuredLogsSentinelFree(records);
    });
  }
});

test("structured log inspection never invokes getters or toJSON", () => {
  let invoked = 0;
  const fields = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(fields, "secret", {
    enumerable: true,
    get() {
      invoked += 1;
      return LEAK_SENTINEL;
    },
  });
  Object.defineProperty(fields, "toJSON", {
    enumerable: true,
    value() {
      invoked += 1;
      return LEAK_SENTINEL;
    },
  });
  const records: unknown[] = [];
  testHarnessInternals.captureStructuredLog(records, "worker_log", fields, "safe");
  sentinelError(() => {
    testHarnessInternals.assertStructuredLogsSentinelFree(records);
  });
  assert.equal(invoked, 0);
});

test("structured log inspection fails closed on budget exhaustion and proxies", () => {
  for (const fields of [
    Array.from({ length: 100_001 }, () => "safe"),
    new Proxy({}, {
      ownKeys() {
        throw new Error(`proxy ${LEAK_SENTINEL}`);
      },
    }),
  ]) {
    const records: unknown[] = [];
    testHarnessInternals.captureStructuredLog(records, "api_log", fields, "safe");
    sentinelError(() => {
      testHarnessInternals.assertStructuredLogsSentinelFree(records);
    });
  }
});

test("bounded cleanup continues after a hanging close", async () => {
  const completed: string[] = [];
  const resources = { controlPoolOpen: true, databaseExists: true, poolOpen: true };
  const failures = await testHarnessInternals.runCleanupStages([
    {
      category: "hanging close",
      work: () => new Promise<void>(() => undefined),
    },
    {
      category: "database pool",
      work: async () => {
        resources.poolOpen = false;
        completed.push("database pool");
      },
    },
    {
      category: "database drop",
      work: async () => {
        assert.equal(resources.poolOpen, false);
        resources.databaseExists = false;
        completed.push("database drop");
      },
    },
    {
      category: "control pool",
      work: async () => {
        resources.controlPoolOpen = false;
        completed.push("control pool");
      },
    },
  ], 25);
  assert.deepEqual(completed, ["database pool", "database drop", "control pool"]);
  assert.deepEqual(failures, ["hanging close"]);
  assert.deepEqual(resources, {
    controlPoolOpen: false,
    databaseExists: false,
    poolOpen: false,
  });
});

test("partial setup cleanup drops its database after earlier close failures", async () => {
  const resources = { controlPoolOpen: true, databaseExists: true, poolOpen: true };
  const failures = await testHarnessInternals.runCleanupStages([
    {
      category: "Supervisor",
      work: async () => { throw new Error(`raw ${LEAK_SENTINEL}`); },
    },
    {
      category: "database pool",
      work: async () => { resources.poolOpen = false; },
    },
    {
      category: "database drop",
      work: async () => {
        assert.equal(resources.poolOpen, false);
        resources.databaseExists = false;
      },
    },
    {
      category: "control pool",
      work: async () => { resources.controlPoolOpen = false; },
    },
  ], 25);
  assert.deepEqual(failures, ["Supervisor"]);
  assert.deepEqual(resources, {
    controlPoolOpen: false,
    databaseExists: false,
    poolOpen: false,
  });
  assert.doesNotMatch(failures.join(","), new RegExp(LEAK_SENTINEL));
});

for (const failure of ["reject", "timeout"] as const) {
  test(`isolated database ${failure} closes its control pool and attempts exact cleanup`, async () => {
    const createCalls: string[] = [];
    const cleanupCalls: string[] = [];
    const createPool = {
      query(sql: string) {
        createCalls.push(sql);
        if (sql.startsWith("create database")) {
          return failure === "reject"
            ? Promise.reject(new Error("raw create failure"))
            : new Promise(() => undefined);
        }
        return Promise.resolve({ rows: [] });
      },
      end() {
        createCalls.push("end");
        return Promise.resolve();
      },
    };
    const cleanupPool = {
      query(sql: string) {
        cleanupCalls.push(sql);
        return Promise.resolve({ rows: [] });
      },
      end() {
        cleanupCalls.push("end");
        return Promise.resolve();
      },
    };

    await assert.rejects(
      testHarnessInternals.createIsolatedDatabase({
        configuredUrl: "postgresql://test:test@127.0.0.1/core_agent_control",
        databaseName: "core_agent_test_0123456789abcdef",
        controlPool: createPool,
        cleanupControlPool: cleanupPool,
        timeoutMs: 25,
      }),
      /^Error: Integration stage failed: database create$/,
    );
    assert(cleanupCalls.includes(
      'drop database if exists "core_agent_test_0123456789abcdef" with (force)',
    ));
    assert.equal(createCalls.at(-1), "end");
    assert.equal(cleanupCalls.at(-1), "end");
  });
}
