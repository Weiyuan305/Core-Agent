#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const minimumCredentialBytes = 24;
const maximumCredentialBytes = 256;

export const DATABASE_CREDENTIAL_FILES = Object.freeze({
  api: "api-app-password",
  hbaBootstrap: "hba-bootstrap-password",
  identity: "identity-password",
  migrator: "migrator-password",
  postgresBootstrap: "postgres-bootstrap-password",
  runtimeApplication: "runtime-application-password",
  runtimeBootstrap: "runtime-bootstrap-password",
  runtimeMigrator: "runtime-migrator-password",
  worker: "worker-app-password",
});

function failure() {
  return new Error("database credential projection failed");
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

async function readCredential(path, expectedUid, expectedGid) {
  const namedBefore = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(maximumCredentialBytes + 1);
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== expectedUid
      || before.gid !== expectedGid
      || ![0o400, 0o600].includes(before.mode & 0o7777)
      || before.size < minimumCredentialBytes
      || before.size > maximumCredentialBytes
      || !sameSnapshot(namedBefore, before)
    ) throw failure();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const [after, namedAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (bytesRead !== before.size || !sameSnapshot(before, after) || !sameSnapshot(after, namedAfter)) throw failure();
    const material = Buffer.from(buffer.subarray(0, bytesRead));
    if ([...material].some((byte) => byte < 0x21 || byte > 0x7e)) {
      material.fill(0);
      throw failure();
    }
    return material;
  } finally {
    buffer.fill(0);
    await handle.close().catch(() => undefined);
  }
}

async function projectFile(outputRoot, filename, material, identity) {
  const target = join(outputRoot, filename);
  const temporary = join(outputRoot, `.${filename}.${randomBytes(12).toString("hex")}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(material);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o400);
    await chown(temporary, identity.uid, identity.gid);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function projectRuntimeDatabaseCredentials({
  sourcePaths,
  outputRoot,
  sourceUid,
  sourceGid,
  targetIdentities,
}) {
  const materials = [];
  try {
    const root = absolute(outputRoot);
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.uid !== process.getuid?.()) throw failure();
    await chmod(root, 0o711);
    const expectedSourceUid = numericIdentity(sourceUid);
    const expectedSourceGid = numericIdentity(sourceGid);
    const apiUid = numericIdentity(targetIdentities?.api?.uid);
    const apiGid = numericIdentity(targetIdentities?.api?.gid);
    if (!(
      (expectedSourceUid === 0 && expectedSourceGid === 0)
      || (expectedSourceUid === apiUid && expectedSourceGid === apiGid)
    )) throw failure();
    const source = {
      bootstrap: absolute(sourcePaths?.bootstrap),
      migrator: absolute(sourcePaths?.migrator),
      application: absolute(sourcePaths?.application),
      identity: absolute(sourcePaths?.identity),
    };
    for (const path of Object.values(source)) {
      materials.push(await readCredential(path, expectedSourceUid, expectedSourceGid));
    }
    if (new Set(materials.map((material) => material.toString("base64"))).size !== materials.length) throw failure();
    const [bootstrap, migrator, application, identity] = materials;
    const projections = {
      postgresBootstrap: bootstrap,
      runtimeBootstrap: bootstrap,
      runtimeApplication: application,
      runtimeMigrator: migrator,
      hbaBootstrap: bootstrap,
      migrator,
      api: application,
      worker: application,
      identity,
    };
    for (const purpose of Object.keys(DATABASE_CREDENTIAL_FILES)) {
      const target = targetIdentities?.[purpose];
      if (target === undefined) throw failure();
      await projectFile(root, DATABASE_CREDENTIAL_FILES[purpose], projections[purpose], {
        uid: numericIdentity(target.uid),
        gid: numericIdentity(target.gid),
      });
    }
    const finalRoot = await stat(root);
    if (!finalRoot.isDirectory() || (finalRoot.mode & 0o7777) !== 0o711) throw failure();
  } catch {
    throw failure();
  } finally {
    for (const material of materials) material.fill(0);
  }
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw failure();
  return value;
}

export async function runDatabaseCredentialProjector(environment = process.env) {
  await projectRuntimeDatabaseCredentials({
    sourcePaths: {
      bootstrap: "/run/core-agent/credential-sources/bootstrap",
      migrator: "/run/core-agent/credential-sources/migrator",
      application: "/run/core-agent/credential-sources/application",
      identity: "/run/core-agent/credential-sources/identity",
    },
    outputRoot: "/run/core-agent/database-credentials",
    sourceUid: required(environment, "CORE_AGENT_CREDENTIAL_SOURCE_UID"),
    sourceGid: required(environment, "CORE_AGENT_CREDENTIAL_SOURCE_GID"),
    targetIdentities: {
      postgresBootstrap: { uid: 999, gid: 999 },
      hbaBootstrap: { uid: 999, gid: 999 },
      runtimeBootstrap: { uid: 12003, gid: 12003 },
      runtimeApplication: { uid: 12003, gid: 12003 },
      runtimeMigrator: { uid: 12003, gid: 12003 },
      identity: { uid: 12003, gid: 12003 },
      migrator: { uid: 12004, gid: 12004 },
      api: {
        uid: required(environment, "CORE_AGENT_API_UID"),
        gid: required(environment, "CORE_AGENT_API_GID"),
      },
      worker: {
        uid: required(environment, "CORE_AGENT_WORKER_UID"),
        gid: required(environment, "CORE_AGENT_WORKER_GID"),
      },
    },
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDatabaseCredentialProjector().catch(() => {
    process.stderr.write("database credential projection failed\n");
    process.exitCode = 1;
  });
}
