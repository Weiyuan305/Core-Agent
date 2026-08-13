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
let status = 1;
try {
  await client.connect();
  if (operation === "terminate") {
    await client.query(
      `select pg_terminate_backend(pid)
       from pg_stat_activity
       where datname = $1 and pid <> pg_backend_pid()`,
      [databaseName],
    );
    status = 0;
  } else {
    await client.query(`drop database if exists "${databaseName}"`);
    const result = await client.query(
      "select exists (select 1 from pg_database where datname = $1) as exists",
      [databaseName],
    );
    status = result.rows[0]?.exists === false ? 0 : 1;
  }
} catch {
  status = 1;
} finally {
  await client.end().catch(() => undefined);
}
process.exit(status);
