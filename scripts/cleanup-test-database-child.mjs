#!/usr/bin/env node

import { Client } from "pg";

const [operation, controlDatabaseUrl, databaseName, timeoutText] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
let parsedControlUrl;
try { parsedControlUrl = new URL(controlDatabaseUrl); } catch { /* rejected below */ }
if (!new Set(["terminate", "drop"]).has(operation)
  || controlDatabaseUrl === undefined
  || parsedControlUrl?.password !== ""
  || !/^core_agent_test_[a-f0-9]{16}$/u.test(databaseName ?? "")
  || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) process.exit(2);

const client = new Client({
  connectionString: controlDatabaseUrl,
  connectionTimeoutMillis: timeoutMs,
  query_timeout: timeoutMs,
  // The parent owns the total kill-and-reap deadline. Give PostgreSQL that
  // same bound: deleting a populated disposable database can legitimately
  // take more than one second, while a late backend makes plain DROP fail
  // immediately and leaves time for the exact retry loop below.
  statement_timeout: timeoutMs,
});
const deadline = Date.now() + timeoutMs;
const waitForRetry = async () => {
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
};
// Exit codes are part of the parent/child cleanup protocol. A terminate
// deadline is distinct from an execution failure: the parent may still prove
// exact cleanup by dropping the database and verifying its absence. Invalid
// input and provider/query failures remain terminal.
let status = 3;
try {
  await client.connect();
  if (operation === "terminate") {
    const terminated = await client.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    if (terminated.rows.some((row) => row.pg_terminate_backend !== true)) throw new Error("exact backend termination failed");
    while (Date.now() < deadline) {
      const remaining = await client.query(
        `select count(*) as remaining
         from pg_stat_activity
         where datname = $1 and pid <> pg_backend_pid()`,
        [databaseName],
      );
      if (Number(remaining.rows[0]?.remaining) === 0) {
        status = 0;
        break;
      }
      await waitForRetry();
    }
    if (status !== 0) status = 4;
  } else {
    while (Date.now() < deadline) {
      try {
        const terminated = await client.query(
          `select pg_terminate_backend(pid)
           from pg_stat_activity
           where datname = $1 and pid <> pg_backend_pid()`,
          [databaseName],
        );
        if (terminated.rows.some((row) => row.pg_terminate_backend !== true)) {
          await waitForRetry();
          continue;
        }
        const remaining = await client.query(
          `select count(*) as remaining
           from pg_stat_activity
           where datname = $1 and pid <> pg_backend_pid()`,
          [databaseName],
        );
        if (Number(remaining.rows[0]?.remaining) !== 0) {
          await waitForRetry();
          continue;
        }
        // Plain DROP returns immediately with 55006 if a backend appears after
        // the zero-count check. Retrying that race is safer than relying on
        // DROP ... WITH (FORCE), which can itself wait indefinitely while a
        // terminating backend is being reaped.
        await client.query(`drop database if exists "${databaseName}"`);
        const result = await client.query(
          "select exists (select 1 from pg_database where datname = $1) as exists",
          [databaseName],
        );
        if (result.rows[0]?.exists === false) {
          await new Promise((resolve) => {
            if (process.send === undefined) resolve();
            else process.send("drop_complete", () => resolve());
          });
          status = 0;
          break;
        }
      } catch { /* retry the exact termination, DROP, and absence checks */ }
      await waitForRetry();
    }
  }
} catch {
  status = 3;
} finally {
  try { await client.end(); } catch { status = 3; }
}
process.exit(status);
