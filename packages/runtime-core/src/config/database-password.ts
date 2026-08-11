import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ClientConfig } from "pg";

const minimumPasswordBytes = 24;
const maximumPasswordBytes = 256;

function invalid(): Error {
  return new Error("Database credential file is invalid");
}

export async function readProtectedDatabasePassword(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw invalid();
  const before = await lstat(path).catch(() => { throw invalid(); });
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw invalid(); });
  const buffer = Buffer.alloc(maximumPasswordBytes + 1);
  try {
    const held = await handle.stat();
    const callerUid = process.getuid?.();
    if (
      callerUid === undefined
      || !held.isFile()
      || held.uid !== callerUid
      || held.nlink !== 1
      || ![0o400, 0o600].includes(held.mode & 0o7777)
      || held.size < minimumPasswordBytes
      || held.size > maximumPasswordBytes
      || before.dev !== held.dev
      || before.ino !== held.ino
      || before.nlink !== held.nlink
    ) throw invalid();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await lstat(path).catch(() => { throw invalid(); });
    if (
      bytesRead !== held.size
      || after.dev !== held.dev
      || after.ino !== held.ino
      || after.nlink !== held.nlink
    ) throw invalid();
    const material = buffer.subarray(0, bytesRead);
    if ([...material].some((byte) => byte < 0x21 || byte > 0x7e)) throw invalid();
    return material.toString("utf8");
  } catch {
    throw invalid();
  } finally {
    buffer.fill(0);
    await handle.close().catch(() => undefined);
  }
}

export function databaseConnectionOptions(databaseUrl: string, password: string): ClientConfig {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw invalid();
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const user = decodeURIComponent(parsed.username);
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  if (
    parsed.protocol !== "postgresql:"
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.hostname.length === 0
    || user.length === 0
    || database.length === 0
    || database.includes("/")
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || password.length < minimumPasswordBytes
  ) throw invalid();
  return {
    host: parsed.hostname,
    port,
    database,
    user,
    password,
    connectionTimeoutMillis: 5_000,
  };
}
