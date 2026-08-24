import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseTransactionRetryAbortedError,
  DatabaseTransactionRetryExhaustedError,
  isRetryableDatabaseTransactionError,
  withDatabaseTransactionRetry,
} from "../src/db/transaction-retry.js";

function database(attempt: (number: number) => Promise<unknown>) {
  let builders = 0;
  let executions = 0;
  const db = {
    transaction() {
      builders += 1;
      const builder = {
        setIsolationLevel(level: string) { assert.equal(level, "serializable"); return builder; },
        async execute(work: (trx: unknown) => Promise<unknown>) {
          executions += 1;
          await attempt(executions);
          return work({ execution: executions });
        },
      };
      return builder;
    },
  };
  return { db, counts: () => ({ builders, executions }) };
}

test("database transaction retry uses three fresh transactions for 40P01 and 40001 only", async () => {
  const setup = database(async (attempt) => {
    if (attempt <= 2) throw Object.freeze({ code: attempt === 1 ? "40P01" : "40001" });
  });
  const result = await withDatabaseTransactionRetry(setup.db as never, async (trx) => (trx as { execution: number }).execution, { isolationLevel: "serializable" });
  assert.equal(result, 3);
  assert.deepEqual(setup.counts(), { builders: 3, executions: 3 });
});

test("database transaction retry classification never invokes accessors or reflects error messages", async () => {
  let codeReads = 0;
  const accessor = Object.defineProperty({ message: "private database detail" }, "code", { get() { codeReads += 1; return "40P01"; } });
  assert.equal(isRetryableDatabaseTransactionError(accessor), false);
  assert.equal(codeReads, 0);

  const setup = database(async () => { throw accessor; });
  await assert.rejects(withDatabaseTransactionRetry(setup.db as never, async () => undefined), (error: unknown) => error === accessor);
  assert.equal(codeReads, 0);
  assert.deepEqual(setup.counts(), { builders: 1, executions: 1 });

  const exhausted = database(async () => { throw { code: "40P01", message: "private database detail" }; });
  await assert.rejects(
    withDatabaseTransactionRetry(exhausted.db as never, async () => undefined),
    (error: unknown) => error instanceof DatabaseTransactionRetryExhaustedError && !error.message.includes("private"),
  );
  assert.deepEqual(exhausted.counts(), { builders: 3, executions: 3 });
});

test("database transaction retry is abort-aware before opening another transaction", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  const setup = database(async () => undefined);
  await assert.rejects(
    withDatabaseTransactionRetry(setup.db as never, async () => undefined, { signal: controller.signal }),
    (error: unknown) => error instanceof DatabaseTransactionRetryAbortedError && !error.message.includes("private"),
  );
  assert.deepEqual(setup.counts(), { builders: 0, executions: 0 });
});

test("database transaction retry backs off and aborts before opening another transaction", async () => {
  const controller = new AbortController();
  const setup = database(async () => { throw Object.freeze({ code: "40001" }); });
  const abortTimer = setTimeout(() => controller.abort(new Error("private abort reason")), 5);
  try {
    await assert.rejects(
      withDatabaseTransactionRetry(setup.db as never, async () => undefined, { signal: controller.signal }),
      (error: unknown) => error instanceof DatabaseTransactionRetryAbortedError && !error.message.includes("private"),
    );
  } finally {
    clearTimeout(abortTimer);
  }
  assert.deepEqual(setup.counts(), { builders: 1, executions: 1 });
});
