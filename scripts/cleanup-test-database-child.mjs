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
  statement_timeout: timeoutMs,
});
const deadline = Date.now() + timeoutMs;
const waitForRetry = async () => {
  const remaining = deadline - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
};
let status = 1;
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
  } else {
    while (Date.now() < deadline) {
      try {
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
      } catch { /* retry only the exact DROP and absence check */ }
      await waitForRetry();
    }
  }
} catch {
  status = 1;
} finally {
  try { await client.end(); } catch { status = 1; }
}
process.exit(status);
