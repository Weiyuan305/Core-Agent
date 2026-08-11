#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { databaseConnectionOptions, readProtectedDatabasePassword } from "@core-agent/runtime-core";
import { Client } from "pg";

const canonicalHba = "# Managed by Core-Agent runtime authentication convergence.\nlocal all all trust\nhost all all all scram-sha-256\n";

function failure() {
  return new Error("PostgreSQL authentication convergence failed");
}

function records(text) {
  return text.split(/\r?\n/u)
    .map((line) => line.replace(/#.*/u, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/u));
}

export function canonicalizeRuntimePostgresHba(text) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) throw failure();
    const parsed = records(text);
    if (
      parsed.length === 2
      && JSON.stringify(parsed[0]) === JSON.stringify(["local", "all", "all", "trust"])
      && JSON.stringify(parsed[1]) === JSON.stringify(["host", "all", "all", "all", "scram-sha-256"])
    ) return canonicalHba;
    if (parsed.length !== 7) throw failure();
    const methods = new Set(parsed.filter((entry) => entry[0] === "host").map((entry) => entry.at(-1)));
    if (methods.size !== 1 || !["trust", "scram-sha-256"].includes([...methods][0])) throw failure();
    const method = [...methods][0];
    const expected = [
      ["local", "all", "all", "trust"],
      ["host", "all", "all", "127.0.0.1/32", method],
      ["host", "all", "all", "::1/128", method],
      ["local", "replication", "all", "trust"],
      ["host", "replication", "all", "127.0.0.1/32", method],
      ["host", "replication", "all", "::1/128", method],
      ["host", "all", "all", "all", method],
    ];
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw failure();
    return canonicalHba;
  } catch {
    throw failure();
  }
}

async function readProtectedHba(path) {
  const namedBefore = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > 64 * 1024
      || namedBefore.dev !== before.dev || namedBefore.ino !== before.ino
    ) throw failure();
    const buffer = Buffer.alloc(before.size);
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (bytesRead !== buffer.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw failure();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return canonicalizeRuntimePostgresHba(text);
    } finally {
      buffer.fill(0);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function replaceHba(path, content) {
  const temporary = `${path}.core-agent-${randomBytes(12).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function reloadRuntimePostgresAuth(client) {
  try {
    const reload = await client.query("select pg_reload_conf() as reloaded");
    if (reload.rows[0]?.reloaded !== true) throw failure();
  } catch {
    throw failure();
  }
}

function defaultBarrierClient({ options }) {
  return new Client(options);
}

async function freshProof(createClient, proof, options) {
  let client;
  try {
    client = createClient({ proof, options });
    await client.connect();
    if (proof === "correct") {
      const current = await client.query("select current_user");
      if (current.rows[0]?.current_user !== "core_agent_bootstrap") throw failure();
    }
    return { connected: true };
  } catch (error) {
    return { connected: false, code: error?.code };
  } finally {
    await client?.end().catch(() => undefined);
  }
}

export async function awaitRuntimePostgresScramBarrier({
  databaseUrl,
  password,
  createClient = defaultBarrierClient,
  timeoutMs = 10_000,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw failure();
    const correctOptions = {
      ...databaseConnectionOptions(databaseUrl, password),
      connectionTimeoutMillis: Math.min(timeoutMs, 1_000),
      query_timeout: 1_000,
      statement_timeout: 1_000,
    };
    const wrongOptions = { ...correctOptions, password: randomBytes(32).toString("base64url") };
    const { password: _discardedPassword, ...absentOptions } = correctOptions;
    const deadline = now() + timeoutMs;
    do {
      const [correct, wrong, absent] = await Promise.all([
        freshProof(createClient, "correct", correctOptions),
        freshProof(createClient, "wrong", wrongOptions),
        freshProof(createClient, "absent", absentOptions),
      ]);
      if (correct.connected && !wrong.connected && wrong.code === "28P01" && !absent.connected) return;
      if (now() >= deadline) break;
      await sleep(100);
    } while (now() <= deadline);
    throw failure();
  } catch {
    throw failure();
  }
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw failure();
  return value;
}

export async function convergeRuntimePostgresAuth(environment = process.env) {
  let client;
  try {
    const pgdata = required(environment, "PGDATA");
    if (!isAbsolute(pgdata) || resolve(pgdata) !== pgdata) throw failure();
    const databaseUrl = required(environment, "CONTROL_PLANE_DATABASE_URL");
    if (new URL(databaseUrl).username !== "core_agent_bootstrap") throw failure();
    const password = await readProtectedDatabasePassword(required(environment, "CONTROL_PLANE_DATABASE_PASSWORD_FILE"));
    client = new Client({
      ...databaseConnectionOptions(databaseUrl, password),
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    await client.connect();
    const hbaPath = join(pgdata, "pg_hba.conf");
    const canonical = await readProtectedHba(hbaPath);
    await replaceHba(hbaPath, canonical);
    await reloadRuntimePostgresAuth(client);
    const effective = await client.query(`
      select type, database, user_name, address, auth_method, error
      from pg_hba_file_rules
      order by line_number
    `);
    if (JSON.stringify(effective.rows) !== JSON.stringify([
      { type: "local", database: ["all"], user_name: ["all"], address: null, auth_method: "trust", error: null },
      { type: "host", database: ["all"], user_name: ["all"], address: "all", auth_method: "scram-sha-256", error: null },
    ])) throw failure();
    await awaitRuntimePostgresScramBarrier({ databaseUrl, password });
  } catch {
    throw failure();
  } finally {
    await client?.end().catch(() => undefined);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  convergeRuntimePostgresAuth().catch(() => {
    process.stderr.write("PostgreSQL authentication convergence failed\n");
    process.exitCode = 1;
  });
}
