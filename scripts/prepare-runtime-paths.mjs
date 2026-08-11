#!/usr/bin/env node

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

function sameIdentityAndLinkCount(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function pathsOverlap(left, right) {
  const fromLeft = relative(left, right);
  const fromRight = relative(right, left);
  return fromLeft === "" || (!fromLeft.startsWith("..") && !isAbsolute(fromLeft))
    || (!fromRight.startsWith("..") && !isAbsolute(fromRight));
}

async function requireProtectedAncestors(canonicalPath) {
  const callerUid = process.getuid?.();
  if (callerUid === undefined) throw preparationError();
  let path = dirname(canonicalPath);
  while (true) {
    const value = await lstat(path);
    if (
      !value.isDirectory()
      || (value.uid !== 0 && value.uid !== callerUid)
      || (value.mode & 0o022) !== 0
    ) throw preparationError();
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
}

async function canonicalExisting(path) {
  const canonical = await realpath(path);
  if (canonical !== path) throw preparationError();
  return canonical;
}

async function inspectProjection({ path, kind, uid, gid, mode, modes, minimumSize, maximumSize }) {
  const canonical = await canonicalExisting(path);
  await requireProtectedAncestors(canonical);
  const namedBefore = await lstat(canonical);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (kind === "directory" ? constants.O_DIRECTORY : 0);
  const handle = await open(canonical, flags);
  try {
    const held = await handle.stat();
    const namedAfter = await lstat(canonical);
    const expectedKind = kind === "directory" ? held.isDirectory() : held.isFile();
    if (
      !expectedKind
      || (kind === "file" && held.nlink !== 1)
      || held.uid !== uid
      || held.gid !== gid
      || (modes === undefined
        ? (held.mode & 0o7777) !== mode
        : !modes.includes(held.mode & 0o7777))
      || (minimumSize !== undefined && held.size < minimumSize)
      || (maximumSize !== undefined && held.size > maximumSize)
      || !sameIdentityAndLinkCount(namedBefore, held)
      || !sameIdentityAndLinkCount(held, namedAfter)
    ) throw preparationError();
    return canonical;
  } finally {
    await handle.close();
  }
}

async function canonicalCreatableDirectory(path) {
  const parent = dirname(path);
  const canonicalParent = await canonicalExisting(parent);
  await requireProtectedAncestors(join(canonicalParent, basename(path)));
  if (join(canonicalParent, basename(path)) !== path) throw preparationError();
  return path;
}

function requirePurposeSeparation(projections) {
  for (let left = 0; left < projections.length; left += 1) {
    for (let right = left + 1; right < projections.length; right += 1) {
      if (pathsOverlap(projections[left].canonical, projections[right].canonical)) throw preparationError();
    }
  }
}

export function resolveRuntimePathPolicy(environment = process.env) {
  try {
    if (environment.CORE_AGENT_WORKER_UID !== undefined || environment.CORE_AGENT_WORKER_GID !== undefined) {
      throw preparationError();
    }
    const runtimeUid = identity(environment, "CORE_AGENT_RUNTIME_UID", 12002);
    const runtimeGid = identity(environment, "CORE_AGENT_SUPERVISOR_SOCKET_GID", 12002);
    const apiUid = identity(environment, "CORE_AGENT_API_UID", 12000);
    const apiGid = identity(environment, "CORE_AGENT_API_GID", 12000);
    if ([999, 12003, 12004].includes(apiUid) || [999, 12003, 12004].includes(runtimeUid)) {
      throw preparationError();
    }
    return {
      bootstrapPath: absolutePath(environment, "CORE_AGENT_BOOTSTRAP_KEY_FILE"),
      databaseCredentialPaths: {
        bootstrap: absolutePath(environment, "CORE_AGENT_POSTGRES_BOOTSTRAP_PASSWORD_FILE"),
        migrator: absolutePath(environment, "CORE_AGENT_DATABASE_MIGRATOR_PASSWORD_FILE"),
        application: absolutePath(environment, "CORE_AGENT_DATABASE_APP_PASSWORD_FILE"),
        identity: absolutePath(environment, "CORE_AGENT_DATABASE_IDENTITY_PASSWORD_FILE"),
      },
      providerRoot: absolutePath(environment, "CORE_AGENT_PROVIDER_SECRET_ROOT"),
      ingressRoot: absolutePath(environment, "CORE_AGENT_INGRESS_SECRET_ROOT"),
      stateRoot: absolutePath(environment, "CORE_AGENT_SUPERVISOR_STATE_ROOT"),
      bootstrapUid: apiUid,
      bootstrapGid: apiGid,
      apiUid,
      apiGid,
      workerUid: runtimeUid,
      workerGid: runtimeGid,
      supervisorUid: runtimeUid,
      supervisorGid: runtimeGid,
    };
  } catch {
    throw preparationError();
  }
}

export async function prepareRuntimePaths({ environment = process.env } = {}) {
  try {
    const policy = resolveRuntimePathPolicy(environment);
    const existing = [
      { purpose: "bootstrap", path: policy.bootstrapPath, kind: "file", uid: policy.bootstrapUid, gid: policy.bootstrapGid, mode: 0o600 },
      ...Object.entries(policy.databaseCredentialPaths).map(([purpose, path]) => ({
        purpose: `database-${purpose}`,
        path,
        kind: "file",
        uid: policy.bootstrapUid,
        gid: policy.bootstrapGid,
        modes: [0o400, 0o600],
        minimumSize: 24,
        maximumSize: 256,
      })),
      { purpose: "provider", path: policy.providerRoot, kind: "directory", uid: policy.supervisorUid, gid: policy.supervisorGid, mode: 0o700 },
      { purpose: "ingress", path: policy.ingressRoot, kind: "directory", uid: policy.supervisorUid, gid: policy.supervisorGid, mode: 0o700 },
    ];
    const creatable = [
      { purpose: "state", path: policy.stateRoot, kind: "directory", uid: policy.supervisorUid, gid: policy.supervisorGid, mode: 0o700 },
    ];

    const inspected = [];
    for (const projection of existing) {
      inspected.push({ ...projection, canonical: await inspectProjection(projection) });
    }
    for (const projection of creatable) {
      let canonical;
      try {
        canonical = await canonicalExisting(projection.path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        canonical = await canonicalCreatableDirectory(projection.path);
      }
      inspected.push({ ...projection, canonical });
    }
    requirePurposeSeparation(inspected);

    for (const projection of creatable) {
      try {
        await mkdir(projection.path, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const canonical = await inspectProjection(projection);
      if (canonical !== projection.path) throw preparationError();
    }
    for (const name of ["staging", "ingress"]) {
      const projection = {
        purpose: `state-${name}`,
        path: join(policy.stateRoot, name),
        kind: "directory",
        uid: policy.supervisorUid,
        gid: policy.supervisorGid,
        mode: 0o700,
      };
      try {
        await mkdir(projection.path, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (await inspectProjection(projection) !== projection.path) throw preparationError();
    }
    requirePurposeSeparation(await Promise.all(inspected.map(async (projection) => ({
      ...projection,
      canonical: await inspectProjection(projection),
    }))));
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
