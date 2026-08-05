#!/usr/bin/env node

import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function preparationError() {
  return new Error("runtime path preparation failed");
}

function identity(environment, name, fallback) {
  const raw = environment[name] ?? String(fallback);
  if (!/^(?:0|[1-9]\d{0,9})$/u.test(raw)) throw preparationError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 4_294_967_294) throw preparationError();
  return value;
}

function absolutePath(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw preparationError();
  return value;
}

async function metadata(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

function requireIdentity(value, uid, gid, mode, kind) {
  const expectedKind = kind === "directory" ? value.isDirectory() : value.isFile();
  if (!expectedKind || value.uid !== uid || value.gid !== gid || (value.mode & 0o7777) !== mode) {
    throw preparationError();
  }
}

async function ensurePrivateDirectory(path, uid, gid) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw preparationError();
  }
  requireIdentity(await metadata(path), uid, gid, 0o700, "directory");
}

function pathsOverlap(left, right) {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === "" || (!fromLeft.startsWith("..") && !isAbsolute(fromLeft))
    || (!fromRight.startsWith("..") && !isAbsolute(fromRight));
}

export function resolveRuntimePathPolicy(environment = process.env) {
  try {
    const bootstrapPath = absolutePath(environment, "CORE_AGENT_BOOTSTRAP_KEY_FILE");
    const socketRoot = absolutePath(environment, "CORE_AGENT_SUPERVISOR_SOCKET_ROOT");
    const stateRoot = absolutePath(environment, "CORE_AGENT_SUPERVISOR_STATE_ROOT");
    if (pathsOverlap(socketRoot, stateRoot)) throw preparationError();
    const runtimeUid = environment.CORE_AGENT_RUNTIME_UID === undefined
      ? undefined
      : identity(environment, "CORE_AGENT_RUNTIME_UID", 0);
    return {
      bootstrapPath,
      socketRoot,
      stateRoot,
      bootstrapUid: runtimeUid ?? 12000,
      bootstrapGid: identity(environment, "CORE_AGENT_RUNTIME_GID", 12000),
      supervisorUid: runtimeUid ?? 12002,
      supervisorGid: identity(environment, "CORE_AGENT_SUPERVISOR_SOCKET_GID", 12002),
    };
  } catch {
    throw preparationError();
  }
}

export async function prepareRuntimePaths({ environment = process.env } = {}) {
  try {
    const policy = resolveRuntimePathPolicy(environment);

    requireIdentity(await metadata(policy.bootstrapPath), policy.bootstrapUid, policy.bootstrapGid, 0o600, "file");
    await ensurePrivateDirectory(policy.socketRoot, policy.supervisorUid, policy.supervisorGid);
    await ensurePrivateDirectory(policy.stateRoot, policy.supervisorUid, policy.supervisorGid);
  } catch {
    throw preparationError();
  }
}

async function main() {
  if (process.argv.length !== 2) throw preparationError();
  await prepareRuntimePaths();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("runtime path preparation failed\n");
    process.exitCode = 1;
  });
}
