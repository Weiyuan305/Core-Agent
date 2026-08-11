#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const minimumKeyBytes = 33;
const maximumKeyBytes = 513;
const privilegedApplicationUids = new Set([999, 12003, 12004]);

function failure() {
  return new Error("API bootstrap key projection failed");
}

function numericIdentity(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 4_294_967_294) throw failure();
  return number;
}

function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw failure();
  return value;
}

function sameSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readSource(path, expectedUid, expectedGid) {
  const namedBefore = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(maximumKeyBytes + 1);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== expectedUid
      || before.gid !== expectedGid
      || ![0o400, 0o600].includes(before.mode & 0o7777)
      || before.size < minimumKeyBytes
      || before.size > maximumKeyBytes
      || !sameSnapshot(namedBefore, before)
    ) throw failure();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const [after, namedAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (bytesRead !== before.size || !sameSnapshot(before, after) || !sameSnapshot(after, namedAfter)) throw failure();
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    buffer.fill(0);
    await handle.close().catch(() => undefined);
  }
}

async function writeProjection(root, material, uid, gid, chownImplementation) {
  const target = join(root, "bootstrap-key");
  const temporary = join(root, `.bootstrap-key.${randomBytes(12).toString("hex")}.tmp`);
  let projected = false;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(material);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await chownImplementation(temporary, uid, gid);
    await rename(temporary, target);
    projected = true;
  } finally {
    if (!projected) await unlink(temporary).catch(() => undefined);
  }
}

export async function projectRuntimeApiBootstrapKey({
  sourcePath,
  outputRoot,
  sourceUid,
  sourceGid,
  targetUid,
  targetGid,
  chownImplementation = chown,
}) {
  let material;
  try {
    const source = absolute(sourcePath);
    const root = absolute(outputRoot);
    if (source === root) throw failure();
    const expectedSourceUid = numericIdentity(sourceUid);
    const expectedSourceGid = numericIdentity(sourceGid);
    const apiUid = numericIdentity(targetUid);
    const apiGid = numericIdentity(targetGid);
    if (
      apiUid === 0
      || apiGid === 0
      || privilegedApplicationUids.has(apiUid)
      || !((expectedSourceUid === 0 && expectedSourceGid === 0) || (expectedSourceUid === apiUid && expectedSourceGid === apiGid))
    ) throw failure();
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.uid !== process.getuid?.()) throw failure();
    if ((await readdir(root)).some((entry) => entry !== "bootstrap-key")) throw failure();
    material = await readSource(source, expectedSourceUid, expectedSourceGid);
    await chmod(root, 0o711);
    if (typeof chownImplementation !== "function") throw failure();
    await writeProjection(root, material, apiUid, apiGid, chownImplementation);
    const [finalRoot, output] = await Promise.all([stat(root), stat(join(root, "bootstrap-key"))]);
    if (
      !finalRoot.isDirectory()
      || (finalRoot.mode & 0o7777) !== 0o711
      || !output.isFile()
      || output.nlink !== 1
      || output.uid !== apiUid
      || output.gid !== apiGid
      || (output.mode & 0o7777) !== 0o600
      || output.size !== material.length
    ) throw failure();
  } catch {
    throw failure();
  } finally {
    material?.fill(0);
  }
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw failure();
  return value;
}

export async function runApiBootstrapKeyProjector(environment = process.env) {
  await projectRuntimeApiBootstrapKey({
    sourcePath: "/run/core-agent/bootstrap-source/bootstrap-key",
    outputRoot: "/run/core-agent/projected-api-bootstrap",
    sourceUid: required(environment, "CORE_AGENT_CREDENTIAL_SOURCE_UID"),
    sourceGid: required(environment, "CORE_AGENT_CREDENTIAL_SOURCE_GID"),
    targetUid: required(environment, "CORE_AGENT_API_UID"),
    targetGid: required(environment, "CORE_AGENT_API_GID"),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runApiBootstrapKeyProjector().catch(() => {
    process.stderr.write("API bootstrap key projection failed\n");
    process.exitCode = 1;
  });
}
