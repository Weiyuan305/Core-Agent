#!/usr/bin/env node

import { Client } from "pg";

const [controlDatabaseUrl, databaseName, timeoutText] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);
let parsedControlUrl;
try { parsedControlUrl = new URL(controlDatabaseUrl); } catch { /* rejected below */ }
if (parsedControlUrl?.password !== ""
  || !parsedControlUrl?.pathname.slice(1).startsWith("core_agent_")
  || !/^core_agent_test_[a-f0-9]{16}$/u.test(databaseName ?? "")
  || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) process.exit(2);

const client = new Client({
  connectionString: parsedControlUrl.toString(),
  connectionTimeoutMillis: timeoutMs,
  query_timeout: timeoutMs,
  statement_timeout: timeoutMs,
});
let status = 1;
try {
  await client.connect();
  await client.query(`create database "${databaseName}"`);
  status = 0;
} catch {
  status = 1;
} finally {
  await client.end().catch(() => undefined);
}
process.exit(status);
