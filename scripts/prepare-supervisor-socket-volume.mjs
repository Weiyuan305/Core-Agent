#!/usr/bin/env node

import { chmod, chown, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const socketRoot = "/run/core-agent/supervisor";

function preparationError() {
  return new Error("Supervisor socket volume preparation failed");
}

function identity(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/u.test(value)) throw preparationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 4_294_967_294) throw preparationError();
  return parsed;
}

function directory(metadata) {
  return metadata !== undefined
    && metadata.isDirectory()
    && (metadata.mode & 0o170000n) === 0o040000n;
}

export async function prepareSupervisorSocketVolume({
  environment = process.env,
  inspect = lstat,
  changeOwner = chown,
  changeMode = chmod,
} = {}) {
  try {
    const uid = identity(environment.CORE_AGENT_RUNTIME_UID);
    const gid = identity(environment.CORE_AGENT_SUPERVISOR_SOCKET_GID);
    const before = await inspect(socketRoot, { bigint: true });
    if (!directory(before)) throw preparationError();
    await changeOwner(socketRoot, uid, gid);
    await changeMode(socketRoot, 0o700);
    const after = await inspect(socketRoot, { bigint: true });
    if (
      !directory(after)
      || after.uid !== BigInt(uid)
      || after.gid !== BigInt(gid)
      || (after.mode & 0o7777n) !== 0o700n
    ) throw preparationError();
  } catch {
    throw preparationError();
  }
}

async function main() {
  if (process.argv.length !== 2) throw preparationError();
  await prepareSupervisorSocketVolume();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Supervisor socket volume preparation failed\n");
    process.exitCode = 1;
  });
}
