#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { Client } from "pg";

const identifierPattern = /^[a-z][a-z0-9_]{0,62}$/u;
const principalPattern = /^core_agent_[a-z0-9_]+$/u;

function scanError() {
  return new Error("database sentinel scan failed");
}

function quotedIdentifier(value) {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw scanError();
  return `"${value}"`;
}

function validateInput(databaseUrl, sentinel) {
  if (typeof databaseUrl !== "string" || databaseUrl.includes("%")) throw scanError();
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw scanError();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || !principalPattern.test(url.username)
    || !principalPattern.test(url.pathname.slice(1))
    || url.pathname !== `/${url.pathname.slice(1)}`
    || (url.port !== "" && !/^\d{1,5}$/u.test(url.port))
    || typeof sentinel !== "string"
    || sentinel.length < 16
    || Buffer.byteLength(sentinel) > 256
    || /[\u0000-\u001f\u007f]/u.test(sentinel)
  ) throw scanError();
  const port = url.port === "" ? 5432 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw scanError();
  return {
    host: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
    port,
    user: url.username,
    database: url.pathname.slice(1),
  };
}

export async function scanRuntimeDatabase({
  databaseUrl,
  sentinel,
  createClient = (configuration) => new Client(configuration),
}) {
  const connection = validateInput(databaseUrl, sentinel);
  const client = createClient({
    ...connection,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  try {
    await client.connect();
    const metadata = await client.query(`select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('text', 'character varying', 'json', 'jsonb')
      order by table_name, ordinal_position`);
    if (!Array.isArray(metadata.rows)) throw scanError();
    for (const row of metadata.rows) {
      const table = quotedIdentifier(row?.table_name);
      const column = quotedIdentifier(row?.column_name);
      const result = await client.query(
        `select exists(select 1 from ${table} where strpos(${column}::text, $1) > 0) as present`,
        [sentinel],
      );
      if (result.rows?.length !== 1 || typeof result.rows[0]?.present !== "boolean" || result.rows[0].present) {
        throw scanError();
      }
    }
  } catch {
    throw scanError();
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  if (process.argv.length !== 3) throw scanError();
  const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
  if (databaseUrl === undefined) throw scanError();
  await scanRuntimeDatabase({ databaseUrl, sentinel: process.argv[2] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("database sentinel scan failed\n");
    process.exitCode = 1;
  });
}
