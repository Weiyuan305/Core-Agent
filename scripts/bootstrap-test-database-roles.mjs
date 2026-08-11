#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

const { Client } = pg;
const minimumCredentialBytes = 24;
const maximumCredentialBytes = 256;

function failure() {
  return new Error("test database role bootstrap failed");
}

function approvedDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw failure();
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "postgresql:"
    || parsed.username !== "core_agent_ci"
    || parsed.password !== ""
    || parsed.hostname !== "127.0.0.1"
    || parsed.pathname !== "/core_agent_runtime"
    || parsed.search !== ""
    || parsed.hash !== ""
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || value !== `postgresql://core_agent_ci@127.0.0.1:${port}/core_agent_runtime`
  ) throw failure();
  return value;
}

async function readCredential(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw failure();
  const before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(maximumCredentialBytes + 1);
  try {
    const held = await handle.stat();
    const callerUid = process.getuid?.();
    if (
      callerUid === undefined
      || !held.isFile()
      || held.uid !== callerUid
      || held.nlink !== 1
      || ![0o400, 0o600].includes(held.mode & 0o7777)
      || held.size < minimumCredentialBytes
      || held.size > maximumCredentialBytes
      || before.dev !== held.dev
      || before.ino !== held.ino
      || before.nlink !== held.nlink
    ) throw failure();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path);
    if (bytesRead !== held.size || after.dev !== held.dev || after.ino !== held.ino || after.nlink !== held.nlink) {
      throw failure();
    }
    const material = buffer.subarray(0, bytesRead);
    if ([...material].some((byte) => byte < 0x21 || byte > 0x7e)) throw failure();
    return material.toString("utf8");
  } finally {
    buffer.fill(0);
    await handle.close().catch(() => undefined);
  }
}

const prerequisiteRolesSql = `
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_agent_app') THEN
    CREATE ROLE core_agent_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_agent_identity') THEN
    CREATE ROLE core_agent_identity NOLOGIN;
  END IF;
END
$bootstrap$;
`;

export async function bootstrapTestDatabaseRoles({
  environment = process.env,
  clientFactory = (options) => new Client(options),
} = {}) {
  let client;
  try {
    const databaseUrl = approvedDatabaseUrl(environment.CONTROL_PLANE_TEST_DATABASE_URL);
    const password = await readCredential(environment.CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE);
    client = clientFactory({ connectionString: databaseUrl, password, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await client.query(prerequisiteRolesSql);
  } catch {
    throw failure();
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  bootstrapTestDatabaseRoles().catch(() => {
    process.stderr.write("test database role bootstrap failed\n");
    process.exitCode = 1;
  });
}
