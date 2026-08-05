#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = join(repositoryRoot, "infra/runtime/compose.dev.yaml");
const runtimeBaseLockFile = join(repositoryRoot, "infra/runtime/base-images.lock.json");
const providerCatalogFile = join(repositoryRoot, "infra/runtime/providers.dev.json");
const composeProject = "core-agent-runtime-v1-smoke";
const apiOrigin = "http://127.0.0.1:8787";
const maximumPollMs = 5 * 60 * 1_000;
const maximumApiBodyBytes = 1024 * 1024;
const maximumSecretBytes = 64 * 1024;
const immutableReferencePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[a-f0-9]{64}$/u;
const safeArgumentPattern = /^[^\u0000\r\n]{1,4096}$/u;
const syntheticPattern = /^synthetic-[a-z0-9][a-z0-9-]{0,94}$/u;
const allowedCommands = new Set(["docker", "node"]);

export const SMOKE_OUTPUT_KEYS = Object.freeze([
  "assistant_message_count",
  "conversation_id",
  "event_types",
  "profile_id",
  "run_id",
  "run_status",
  "runtime_id",
  "runtime_state",
  "tenant_id",
]);

const requiredEnvironmentNames = Object.freeze([
  "CORE_AGENT_REAL_HERMES_SMOKE",
  "CORE_AGENT_PLATFORM",
  "CORE_AGENT_NODE_IMAGE",
  "CORE_AGENT_POSTGRES_IMAGE",
  "CORE_AGENT_HERMES_IMAGE_LOCK_FILE",
  "CORE_AGENT_BOOTSTRAP_KEY_FILE",
  "CORE_AGENT_PROVIDER_SECRET_ROOT",
  "CORE_AGENT_INGRESS_SECRET_ROOT",
  "CORE_AGENT_SUPERVISOR_SOCKET_ROOT",
  "CORE_AGENT_SUPERVISOR_STATE_ROOT",
  "CORE_AGENT_RUNTIME_UID",
  "CORE_AGENT_RUNTIME_GID",
  "CORE_AGENT_SUPERVISOR_SOCKET_GID",
  "CORE_AGENT_DOCKER_GID",
]);

const fixedIdentifiers = Object.freeze({
  actorDisplayName: "synthetic-runtime-v1-consultant",
  promptIdentifier: "synthetic-runtime-v1-smoke",
  profileDescription: "synthetic-runtime-v1-consultant",
});

class SmokeError extends Error {
  constructor(code, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "SmokeError";
    this.code = code;
  }
}

function smokeError(code, cause) {
  return new SmokeError(code, cause);
}

function exactRecord(value, keys, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw smokeError(code);
  }
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length
    || own.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) throw smokeError(code);
}

function dataProperty(value, key, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw smokeError(code);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw smokeError(code);
  return descriptor.value;
}

function optionalDataProperty(value, key, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw smokeError(code);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) throw smokeError(code);
  return descriptor.value;
}

export function parseSmokeArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw smokeError("SMOKE_ARGUMENT_INVALID");
  }
  if (argv.length === 0) return Object.freeze({ keepRuntime: false });
  if (argv.length === 1 && argv[0] === "--keep-runtime") return Object.freeze({ keepRuntime: true });
  throw smokeError("SMOKE_ARGUMENT_INVALID");
}

function requiredAbsolutePath(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw smokeError("SMOKE_ENVIRONMENT_INVALID");
  }
  return value;
}

function requiredNumericIdentity(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})$/u.test(value)) throw smokeError("SMOKE_ENVIRONMENT_INVALID");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 4_294_967_294) throw smokeError("SMOKE_ENVIRONMENT_INVALID");
}

export function validateSmokeEnvironment(environment) {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw smokeError("SMOKE_ENVIRONMENT_INVALID");
  }
  if (environment.CORE_AGENT_REAL_HERMES_SMOKE !== "1") throw smokeError("SMOKE_OPT_IN_REQUIRED");
  for (const key of Object.keys(environment)) {
    if (key.startsWith("CORE_AGENT_") && !requiredEnvironmentNames.includes(key)) {
      throw smokeError("SMOKE_ENVIRONMENT_INVALID");
    }
  }
  for (const name of requiredEnvironmentNames) {
    if (typeof environment[name] !== "string" || environment[name].length === 0) throw smokeError("SMOKE_ENVIRONMENT_INVALID");
  }
  if (!new Set(["linux/amd64", "linux/arm64"]).has(environment.CORE_AGENT_PLATFORM)) {
    throw smokeError("SMOKE_ENVIRONMENT_INVALID");
  }
  if (!immutableReferencePattern.test(environment.CORE_AGENT_NODE_IMAGE)
    || !immutableReferencePattern.test(environment.CORE_AGENT_POSTGRES_IMAGE)) {
    throw smokeError("SMOKE_ENVIRONMENT_INVALID");
  }
  for (const name of requiredEnvironmentNames.filter((name) => name.endsWith("_FILE") || name.endsWith("_ROOT"))) {
    requiredAbsolutePath(environment, name);
  }
  for (const name of requiredEnvironmentNames.filter((name) => name.endsWith("_UID") || name.endsWith("_GID"))) {
    requiredNumericIdentity(environment, name);
  }
  return environment;
}

export function validateSyntheticIdentifiers(identifiers) {
  exactRecord(identifiers, [
    "tenantId", "tenantDisplayName", "actorId", "actorDisplayName", "membershipId",
    "profileId", "profileDescription", "hermesProfileRef", "promptIdentifier",
  ], "SMOKE_SYNTHETIC_INPUT_REQUIRED");
  for (const value of Object.values(identifiers)) {
    if (typeof value !== "string" || !syntheticPattern.test(value)) throw smokeError("SMOKE_SYNTHETIC_INPUT_REQUIRED");
  }
  if (identifiers.promptIdentifier !== fixedIdentifiers.promptIdentifier) {
    throw smokeError("SMOKE_SYNTHETIC_INPUT_REQUIRED");
  }
  return identifiers;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validateSecretMetadata(metadata, uid) {
  if (
    !metadata.isFile()
    || metadata.nlink !== 1n
    || metadata.uid !== BigInt(uid)
    || (metadata.mode & 0o7777n) !== 0o600n
    || metadata.size < 1n
    || metadata.size > BigInt(maximumSecretBytes)
  ) throw smokeError("SMOKE_SECRET_FILE_INVALID");
}

async function validateProtectedAncestors(path, dependencies, uid) {
  let current = dirname(path);
  while (true) {
    const metadata = await dependencies.lstat(current, { bigint: true }).catch(() => { throw smokeError("SMOKE_SECRET_FILE_INVALID"); });
    if (
      !metadata.isDirectory()
      || (metadata.uid !== 0n && metadata.uid !== BigInt(uid))
      || (metadata.mode & 0o22n) !== 0n
    ) throw smokeError("SMOKE_SECRET_FILE_INVALID");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function readProtectedSecret(path, dependencies = {}) {
  const io = {
    getuid: dependencies.getuid ?? (() => process.getuid?.()),
    lstat: dependencies.lstat ?? lstat,
    open: dependencies.open ?? open,
  };
  const uid = io.getuid();
  if (!Number.isSafeInteger(uid) || typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw smokeError("SMOKE_SECRET_FILE_INVALID");
  }
  await validateProtectedAncestors(path, io, uid);
  const namedBefore = await io.lstat(path, { bigint: true }).catch(() => { throw smokeError("SMOKE_SECRET_FILE_INVALID"); });
  validateSecretMetadata(namedBefore, uid);
  let handle;
  try {
    handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw smokeError("SMOKE_SECRET_FILE_INVALID");
  }
  const scratch = Buffer.alloc(Number(namedBefore.size));
  try {
    const openedBefore = await handle.stat({ bigint: true });
    validateSecretMetadata(openedBefore, uid);
    if (!sameFileSnapshot(namedBefore, openedBefore)) throw smokeError("SMOKE_SECRET_FILE_INVALID");
    let offset = 0;
    while (offset < scratch.length) {
      const { bytesRead } = await handle.read(scratch, offset, scratch.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > scratch.length - offset) {
        throw smokeError("SMOKE_SECRET_FILE_INVALID");
      }
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== scratch.length) throw smokeError("SMOKE_SECRET_FILE_INVALID");
    const openedAfter = await handle.stat({ bigint: true });
    const namedAfter = await io.lstat(path, { bigint: true });
    validateSecretMetadata(openedAfter, uid);
    validateSecretMetadata(namedAfter, uid);
    if (!sameFileSnapshot(openedBefore, openedAfter) || !sameFileSnapshot(openedAfter, namedAfter)) {
      throw smokeError("SMOKE_SECRET_FILE_INVALID");
    }
    await validateProtectedAncestors(path, io, uid);
    const end = scratch.at(-1) === 0x0a ? scratch.length - 1 : scratch.length;
    const value = Buffer.from(scratch.subarray(0, end));
    if (value.length < 1 || value.includes(0x00) || value.includes(0x0a) || value.includes(0x0d)) {
      value.fill(0);
      throw smokeError("SMOKE_SECRET_FILE_INVALID");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      value.fill(0);
      throw smokeError("SMOKE_SECRET_FILE_INVALID");
    }
    return value;
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw smokeError("SMOKE_SECRET_FILE_INVALID");
  } finally {
    scratch.fill(0);
    await handle.close().catch(() => undefined);
  }
}

function validateChildInvocation(command, args) {
  if (!allowedCommands.has(command) || !Array.isArray(args) || args.length > 64) {
    throw smokeError("SMOKE_CHILD_COMMAND_INVALID");
  }
  if (args.some((argument) => typeof argument !== "string" || !safeArgumentPattern.test(argument))) {
    throw smokeError("SMOKE_CHILD_COMMAND_INVALID");
  }
  if (command === "node" && args[0] !== undefined) {
    const script = resolve(repositoryRoot, args[0]);
    if (relative(repositoryRoot, script).startsWith("..") || !script.startsWith(`${repositoryRoot}/scripts/`)) {
      throw smokeError("SMOKE_CHILD_COMMAND_INVALID");
    }
  }
}

export async function runBoundedChild(command, args, options = {}) {
  validateChildInvocation(command, args);
  const timeout = options.timeoutMs ?? 15_000;
  const maxBuffer = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximumPollMs
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 64 * 1024 * 1024) {
    throw smokeError("SMOKE_CHILD_COMMAND_INVALID");
  }
  try {
    const result = await (options.run ?? execFileAsync)(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: options.environment,
      maxBuffer,
      shell: false,
      signal: options.signal,
      timeout,
      windowsHide: true,
    });
    if (typeof result?.stdout !== "string" || typeof result?.stderr !== "string") {
      throw smokeError("SMOKE_CHILD_FAILED");
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw smokeError("SMOKE_CHILD_FAILED");
  }
}

async function runBoundedChildToFile(command, args, fileHandle, options = {}) {
  validateChildInvocation(command, args);
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumPollMs) {
    throw smokeError("SMOKE_CHILD_COMMAND_INVALID");
  }
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: options.environment,
      shell: false,
      stdio: ["ignore", fileHandle.fd, "ignore"],
      windowsHide: true,
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolvePromise();
      else rejectPromise(smokeError("SMOKE_CHILD_FAILED"));
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("timeout"));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", finish);
    child.once("exit", (code, signal) => finish(code === 0 && signal === null ? undefined : new Error("exit")));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
  });
}

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.some((_, index) => !(index in value))) throw smokeError("SMOKE_PAYLOAD_INVALID");
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) throw smokeError("SMOKE_PAYLOAD_INVALID");
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw smokeError("SMOKE_PAYLOAD_INVALID");
  }
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => {
    if (item === undefined) throw smokeError("SMOKE_PAYLOAD_INVALID");
    return `${JSON.stringify(key)}:${canonicalize(item)}`;
  }).join(",")}}`;
}

export function canonicalPayloadHash(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export function validateProductImageLock(value, platform) {
  const code = "SMOKE_PRODUCT_IMAGE_LOCK_INVALID";
  exactRecord(value, ["schemaVersion", "repository", "tag", "platforms"], code);
  if (
    value.schemaVersion !== 1
    || typeof value.repository !== "string"
    || !/^[a-z0-9./:_-]{3,255}$/u.test(value.repository)
    || !/core-agent.*hermes-runtime/u.test(value.repository)
    || value.repository === "nousresearch/hermes-agent"
    || typeof value.tag !== "string"
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(value.tag)
  ) throw smokeError(code);
  exactRecord(value.platforms, ["linux/amd64", "linux/arm64"], code);
  for (const name of ["linux/amd64", "linux/arm64"]) {
    exactRecord(value.platforms[name], ["reference"], code);
    const expectedPrefix = `${value.repository}:${value.tag}@sha256:`;
    if (typeof value.platforms[name].reference !== "string"
      || !value.platforms[name].reference.startsWith(expectedPrefix)
      || !immutableReferencePattern.test(value.platforms[name].reference)) throw smokeError(code);
  }
  if (platform !== "linux/amd64" && platform !== "linux/arm64") throw smokeError(code);
  return value.platforms[platform].reference;
}

function validateProductLockMetadata(metadata) {
  if (
    !metadata.isFile()
    || metadata.nlink !== 1n
    || metadata.size < 1n
    || metadata.size > BigInt(maximumApiBodyBytes)
  ) throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
}

export async function stageProductImageLockSnapshot(sourcePath, platform, stateRoot, dependencies = {}) {
  const io = {
    afterSourceRead: dependencies.afterSourceRead,
    chmod: dependencies.chmod ?? chmod,
    lstat: dependencies.lstat ?? lstat,
    mkdtemp: dependencies.mkdtemp ?? mkdtemp,
    open: dependencies.open ?? open,
    rmdir: dependencies.rmdir ?? rmdir,
    unlink: dependencies.unlink ?? unlink,
  };
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath
    || typeof stateRoot !== "string" || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) {
    throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
  }
  let sourceHandle;
  let sourceBytes;
  try {
    const namedBefore = await io.lstat(sourcePath, { bigint: true });
    validateProductLockMetadata(namedBefore);
    sourceHandle = await io.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = await sourceHandle.stat({ bigint: true });
    validateProductLockMetadata(openedBefore);
    if (!sameFileSnapshot(namedBefore, openedBefore)) throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    sourceBytes = await sourceHandle.readFile();
    if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length !== Number(openedBefore.size)) {
      throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    }
    await io.afterSourceRead?.();
    const openedAfter = await sourceHandle.stat({ bigint: true });
    const namedAfter = await io.lstat(sourcePath, { bigint: true });
    validateProductLockMetadata(openedAfter);
    validateProductLockMetadata(namedAfter);
    if (!sameFileSnapshot(openedBefore, openedAfter) || !sameFileSnapshot(openedAfter, namedAfter)) {
      throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    }
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
  } finally {
    await sourceHandle?.close().catch(() => undefined);
  }

  let directory;
  let snapshotPath;
  let snapshotHandle;
  try {
    const productLock = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes), "SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    const imageRef = validateProductImageLock(productLock, platform);
    directory = await io.mkdtemp(join(stateRoot, ".core-agent-product-lock-"));
    await io.chmod(directory, 0o700);
    snapshotPath = join(directory, "reviewed-product-images.lock.json");
    snapshotHandle = await io.open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    );
    await snapshotHandle.writeFile(sourceBytes);
    await snapshotHandle.sync();
    await snapshotHandle.chmod(0o444);
    const writtenMetadata = await snapshotHandle.stat({ bigint: true });
    if (!writtenMetadata.isFile() || writtenMetadata.nlink !== 1n
      || (writtenMetadata.mode & 0o7777n) !== 0o444n
      || writtenMetadata.size !== BigInt(sourceBytes.length)) {
      throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    }
    await snapshotHandle.close();
    snapshotHandle = undefined;
    const namedSnapshot = await io.lstat(snapshotPath, { bigint: true });
    snapshotHandle = await io.open(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedSnapshot = await snapshotHandle.stat({ bigint: true });
    if (!sameFileSnapshot(writtenMetadata, namedSnapshot) || !sameFileSnapshot(namedSnapshot, openedSnapshot)) {
      throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    }
    const copied = await snapshotHandle.readFile();
    try {
      if (!Buffer.isBuffer(copied) || copied.length !== sourceBytes.length
        || !createHash("sha256").update(copied).digest().equals(createHash("sha256").update(sourceBytes).digest())) {
        throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
      }
      const verifiedOpenedSnapshot = await snapshotHandle.stat({ bigint: true });
      const verifiedNamedSnapshot = await io.lstat(snapshotPath, { bigint: true });
      if (!sameFileSnapshot(openedSnapshot, verifiedOpenedSnapshot)
        || !sameFileSnapshot(verifiedOpenedSnapshot, verifiedNamedSnapshot)) {
        throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
      }
    } finally {
      if (Buffer.isBuffer(copied)) copied.fill(0);
    }
    await snapshotHandle.close();
    snapshotHandle = undefined;
    let cleaned = false;
    return Object.freeze({
      imageRef,
      path: snapshotPath,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        let cleanupError;
        try {
          await io.unlink(snapshotPath);
        } catch (error) {
          if (error?.code !== "ENOENT") cleanupError = error;
        }
        try {
          await io.rmdir(directory);
        } catch (error) {
          if (error?.code !== "ENOENT" && cleanupError === undefined) cleanupError = error;
        }
        if (cleanupError !== undefined) throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_CLEANUP_FAILED");
      },
    });
  } catch (error) {
    await snapshotHandle?.close().catch(() => undefined);
    if (snapshotPath !== undefined) await io.unlink(snapshotPath).catch(() => undefined);
    if (directory !== undefined) await io.rmdir(directory).catch(() => undefined);
    if (error instanceof SmokeError) throw error;
    throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
  } finally {
    sourceBytes?.fill(0);
  }
}

function validateRuntimeBaseLock(lock, environment) {
  const code = "SMOKE_PLATFORM_LOCK_INVALID";
  exactRecord(lock, ["schemaVersion", "images"], code);
  if (lock.schemaVersion !== 1) throw smokeError(code);
  exactRecord(lock.images, ["node", "postgres"], code);
  for (const [name, environmentName] of [["node", "CORE_AGENT_NODE_IMAGE"], ["postgres", "CORE_AGENT_POSTGRES_IMAGE"]]) {
    const image = lock.images[name];
    exactRecord(image, ["source", "platforms"], code);
    if (typeof image.source !== "string") throw smokeError(code);
    exactRecord(image.platforms, ["linux/amd64", "linux/arm64"], code);
    for (const reference of Object.values(image.platforms)) {
      if (typeof reference !== "string" || !immutableReferencePattern.test(reference)) throw smokeError(code);
    }
    if (image.platforms[environment.CORE_AGENT_PLATFORM] !== environment[environmentName]) throw smokeError(code);
  }
}

function parseJson(raw, code) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > maximumApiBodyBytes) throw smokeError(code);
  try {
    return JSON.parse(raw);
  } catch {
    throw smokeError(code);
  }
}

function exactStringRecord(value, expected, code) {
  exactRecord(value, Object.keys(expected), code);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw smokeError(code);
  }
}

export function assertManagedContainerInspection(inspection, expected) {
  const code = "SMOKE_CONTAINER_INVALID";
  const config = dataProperty(inspection, "Config", code);
  if (dataProperty(config, "Image", code) !== expected.imageRef) throw smokeError(code);
  const labels = dataProperty(config, "Labels", code);
  const requiredLabels = {
    "core-agent.managed": "runtime-v1",
    "core-agent.resource": "runtime",
    "core-agent.tenant-id": expected.tenantId,
    "core-agent.runtime-id": expected.runtimeId,
    "core-agent.image-ref": expected.imageRef,
    "core-agent.network": "core-agent-backplane",
  };
  for (const [key, value] of Object.entries(requiredLabels)) {
    if (dataProperty(labels, key, code) !== value) throw smokeError(code);
  }
  const entrypoint = dataProperty(config, "Entrypoint", code);
  const command = dataProperty(config, "Cmd", code);
  if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || entrypoint[0] !== "/opt/core-agent/gateway-entrypoint.sh"
    || !Array.isArray(command) || command.length !== 0) throw smokeError(code);
  const environment = dataProperty(config, "Env", code);
  if (!Array.isArray(environment) || environment.some((item) => typeof item !== "string")) throw smokeError(code);
  for (const secret of expected.secretValues) {
    const text = secret.toString("utf8");
    if (environment.some((item) => item === text || item.endsWith(`=${text}`))) throw smokeError(code);
  }
  const host = dataProperty(inspection, "HostConfig", code);
  if (dataProperty(host, "NetworkMode", code) !== "core-agent-backplane") throw smokeError(code);
  const bindings = dataProperty(host, "PortBindings", code);
  if (typeof bindings !== "object" || bindings === null || Reflect.ownKeys(bindings).length !== 0) throw smokeError(code);
  const networkSettings = dataProperty(inspection, "NetworkSettings", code);
  const ports = dataProperty(networkSettings, "Ports", code);
  if (typeof ports !== "object" || ports === null || Object.values(ports).some((value) => value !== null && value !== undefined)) {
    throw smokeError(code);
  }
  const networks = dataProperty(networkSettings, "Networks", code);
  if (typeof networks !== "object" || networks === null
    || Reflect.ownKeys(networks).length !== 1 || !Object.hasOwn(networks, "core-agent-backplane")) throw smokeError(code);
}

function composeArgs(...args) {
  return ["compose", "--project-name", composeProject, "-f", composeFile, ...args];
}

export function createSmokeChildEnvironment(environment, productImageLockSnapshotPath) {
  const safe = {};
  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "XDG_CONFIG_HOME"]) {
    if (typeof process.env[name] === "string") safe[name] = process.env[name];
  }
  for (const name of requiredEnvironmentNames) {
    if (name !== "CORE_AGENT_REAL_HERMES_SMOKE") safe[name] = environment[name];
  }
  if (productImageLockSnapshotPath !== undefined) {
    if (typeof productImageLockSnapshotPath !== "string" || !isAbsolute(productImageLockSnapshotPath)
      || resolve(productImageLockSnapshotPath) !== productImageLockSnapshotPath) {
      throw smokeError("SMOKE_PRODUCT_IMAGE_LOCK_INVALID");
    }
    safe.CORE_AGENT_HERMES_IMAGE_LOCK_FILE = productImageLockSnapshotPath;
  }
  return safe;
}

async function delay(ms, signal) {
  await new Promise((resolvePromise, rejectPromise) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      rejectPromise(smokeError("SMOKE_ABORTED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

function abortSignal(signal, timeoutMs) {
  return signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function responseText(response) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/u.test(rawLength) || Number(rawLength) > maximumApiBodyBytes)) {
    throw smokeError("SMOKE_API_RESPONSE_INVALID");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maximumApiBodyBytes) throw smokeError("SMOKE_API_RESPONSE_INVALID");
  return body;
}

async function requestJson(path, options) {
  let response;
  try {
    const authorization = `Bearer ${options.bootstrapKey.toString("utf8")}`;
    response = await fetch(`${apiOrigin}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization,
        ...(options.tenantId === undefined ? {} : { "x-core-agent-tenant-id": options.tenantId }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: abortSignal(options.signal, options.timeoutMs ?? 15_000),
    });
  } catch {
    throw smokeError("SMOKE_API_REQUEST_FAILED");
  }
  const body = parseJson(await responseText(response), "SMOKE_API_RESPONSE_INVALID");
  if (!options.statuses.includes(response.status)) throw smokeError("SMOKE_API_STATUS_INVALID");
  return body;
}

function createSyntheticIdentifiers(randomSuffix = () => randomBytes(8).toString("hex")) {
  const suffix = randomSuffix();
  if (!/^[a-f0-9]{16}$/u.test(suffix)) throw smokeError("SMOKE_SYNTHETIC_INPUT_REQUIRED");
  return validateSyntheticIdentifiers({
    tenantId: `synthetic-runtime-v1-${suffix}`,
    tenantDisplayName: `synthetic-runtime-v1-${suffix}`,
    actorId: `synthetic-runtime-v1-actor-${suffix}`,
    actorDisplayName: fixedIdentifiers.actorDisplayName,
    membershipId: `synthetic-runtime-v1-member-${suffix}`,
    profileId: `synthetic-runtime-v1-profile-${suffix}`,
    profileDescription: fixedIdentifiers.profileDescription,
    hermesProfileRef: `synthetic-runtime-v1-profile-${suffix}`,
    promptIdentifier: fixedIdentifiers.promptIdentifier,
  });
}

function withPayloadHash(payload) {
  return Object.freeze({ ...payload, payload_hash: canonicalPayloadHash(payload) });
}

function provisioningRequest(identifiers, imageRef, platform, provider) {
  const timestamp = new Date().toISOString();
  return withPayloadHash({
    schema_version: 1,
    idempotency_key: `synthetic-provision-${identifiers.tenantId}`,
    client_request_id: `synthetic-provision-${identifiers.tenantId}`,
    identity_graph: {
      schema_version: 1,
      tenant: {
        schema_version: 1, resource_version: 1, tenant_id: identifiers.tenantId,
        tenant_mode: "b2b", display_name: identifiers.tenantDisplayName, status: "provisioning",
        created_at: timestamp, updated_at: timestamp,
      },
      actors: [{
        schema_version: 1, resource_version: 1, actor_id: identifiers.actorId,
        actor_kind: "human", display_name: identifiers.actorDisplayName, status: "active",
        created_at: timestamp, updated_at: timestamp,
      }],
      memberships: [{
        schema_version: 1, resource_version: 1, membership_id: identifiers.membershipId,
        tenant_id: identifiers.tenantId, actor_id: identifiers.actorId, roles: ["consultant"], status: "active",
        created_at: timestamp, updated_at: timestamp,
      }],
      profiles: [{
        schema_version: 1, resource_version: 1, profile_id: identifiers.profileId,
        tenant_id: identifiers.tenantId, owner_actor_id: identifiers.actorId,
        profile_kind: "consultant", status: "provisioning", hermes_profile_ref: identifiers.hermesProfileRef,
        created_at: timestamp, updated_at: timestamp,
      }],
    },
    provider_config_id: provider.provider_config_id,
    model_id: provider.model_ids[0],
    runtime: { image_ref: imageRef, platform, ingress_secret_ref: "hermes_ingress" },
    profile_runtime_config: [{ profile_id: identifiers.profileId, description: identifiers.profileDescription }],
  });
}

function conversationRequest(identifiers) {
  return withPayloadHash({
    schema_version: 1,
    idempotency_key: `synthetic-conversation-${identifiers.tenantId}`,
    tenant_id: identifiers.tenantId,
    profile_id: identifiers.profileId,
  });
}

function runRequest(identifiers) {
  return withPayloadHash({
    schema_version: 1,
    idempotency_key: `synthetic-run-${identifiers.tenantId}`,
    client_request_id: `synthetic-run-${identifiers.tenantId}`,
    input_message: {
      client_message_id: `synthetic-message-${identifiers.tenantId}`,
      content: identifiers.promptIdentifier,
    },
  });
}

function runtimeCommand(identifiers, command, version) {
  return withPayloadHash({
    schema_version: 1,
    idempotency_key: `synthetic-${command}-${identifiers.tenantId}`,
    expected_resource_version: version,
    command,
  });
}

function validateProviderCatalog(value) {
  if (!Array.isArray(value) || value.length !== 1) throw smokeError("SMOKE_PROVIDER_CATALOG_INVALID");
  const provider = value[0];
  exactRecord(provider, [
    "provider_config_id", "base_url", "model_ids", "credential_secret_ref", "timeout_ms", "max_safe_retries",
  ], "SMOKE_PROVIDER_CATALOG_INVALID");
  if (typeof provider.provider_config_id !== "string"
    || !Array.isArray(provider.model_ids) || provider.model_ids.length !== 1 || typeof provider.model_ids[0] !== "string"
    || typeof provider.credential_secret_ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(provider.credential_secret_ref)) {
    throw smokeError("SMOKE_PROVIDER_CATALOG_INVALID");
  }
  return provider;
}

async function validateImageAvailable(reference, child) {
  const raw = await child("docker", ["image", "inspect", reference], { maxOutputBytes: 4 * 1024 * 1024 });
  const parsed = parseJson(raw, "SMOKE_IMAGE_INSPECTION_INVALID");
  if (!Array.isArray(parsed) || parsed.length !== 1) throw smokeError("SMOKE_IMAGE_INSPECTION_INVALID");
  const repoDigests = dataProperty(parsed[0], "RepoDigests", "SMOKE_IMAGE_INSPECTION_INVALID");
  const at = reference.lastIndexOf("@sha256:");
  const tag = reference.lastIndexOf(":", at);
  const canonicalRepoDigest = `${reference.slice(0, tag)}${reference.slice(at)}`;
  if (!Array.isArray(repoDigests)
    || !repoDigests.every((item) => typeof item === "string")
    || (!repoDigests.includes(reference) && !repoDigests.includes(canonicalRepoDigest))) {
    throw smokeError("SMOKE_IMAGE_INSPECTION_INVALID");
  }
  return parsed[0];
}

function assertProductImageConfiguration(inspection) {
  const code = "SMOKE_PRODUCT_IMAGE_INVALID";
  const config = dataProperty(inspection, "Config", code);
  const entrypoint = dataProperty(config, "Entrypoint", code);
  if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || entrypoint[0] !== "/opt/core-agent/gateway-entrypoint.sh") {
    throw smokeError(code);
  }
}

const productEventRequiredFields = Object.freeze([
  "schema_version", "event_id", "occurred_at", "sequence", "tenant_id", "request_id", "trace_id",
  "correlation_id", "causation_id", "event_type", "payload",
]);
const productEventOptionalFields = new Set([
  "profile_id", "conversation_id", "run_id", "task_id", "approval_id", "student_ref", "case_ref", "capability_id",
]);
const strictUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

function validateProductEventEnvelope(event, expected) {
  const code = "SMOKE_SSE_FAILED";
  if (typeof event !== "object" || event === null || Array.isArray(event) || Object.getPrototypeOf(event) !== Object.prototype) {
    throw smokeError(code);
  }
  const ownKeys = Reflect.ownKeys(event);
  if (ownKeys.some((key) => typeof key !== "string"
    || (!productEventRequiredFields.includes(key) && !productEventOptionalFields.has(key)))) throw smokeError(code);
  for (const key of productEventRequiredFields) dataProperty(event, key, code);
  for (const key of ownKeys) dataProperty(event, key, code);
  for (const key of ["event_id", "tenant_id", "request_id", "trace_id", "correlation_id", "causation_id", "event_type"]) {
    if (typeof event[key] !== "string" || event[key].length < 1 || event[key].length > 255) throw smokeError(code);
  }
  for (const key of productEventOptionalFields) {
    if (Object.hasOwn(event, key) && key.endsWith("_id")
      && (typeof event[key] !== "string" || event[key].length < 1 || event[key].length > 255)) throw smokeError(code);
  }
  if (event.schema_version !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 0
    || typeof event.occurred_at !== "string" || !strictUtcTimestampPattern.test(event.occurred_at)
    || !Number.isFinite(Date.parse(event.occurred_at))
    || event.tenant_id !== expected.tenantId
    || (Object.hasOwn(event, "conversation_id") && event.conversation_id !== expected.conversationId)
    || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    throw smokeError(code);
  }
  if (!/^[a-z][a-z0-9_.]{0,127}$/u.test(event.event_type)) throw smokeError(code);
  if (event.event_type === "run.completed" || event.event_type === "run.failed") {
    const expectedStatus = event.event_type === "run.completed" ? "succeeded" : "failed";
    const payloadKeys = Object.keys(event.payload);
    if (payloadKeys.some((key) => !["run_id", "status", "summary"].includes(key))
      || !Object.hasOwn(event.payload, "run_id") || !Object.hasOwn(event.payload, "status")
      || event.run_id !== expected.runId || event.payload.run_id !== expected.runId
      || event.payload.status !== expectedStatus
      || (Object.hasOwn(event.payload, "summary") && (typeof event.payload.summary !== "string" || event.payload.summary.length > 4_000))) {
      throw smokeError(code);
    }
  }
  return event.event_type;
}

export async function readSmokeEvents({
  conversationId,
  tenantId,
  runId,
  bootstrapKey,
  signal,
  fetchImpl = fetch,
  limits = {},
}) {
  const maximumEvents = limits.maximumEvents ?? 1_000;
  const maximumRetainedBytes = limits.maximumRetainedBytes ?? maximumApiBodyBytes;
  if (typeof conversationId !== "string" || typeof tenantId !== "string" || typeof runId !== "string"
    || !Buffer.isBuffer(bootstrapKey)
    || !Number.isSafeInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 10_000
    || !Number.isSafeInteger(maximumRetainedBytes) || maximumRetainedBytes < 1 || maximumRetainedBytes > 16 * maximumApiBodyBytes) {
    throw smokeError("SMOKE_SSE_FAILED");
  }
  let response;
  try {
    response = await fetchImpl(`${apiOrigin}/internal/v1/conversations/${encodeURIComponent(conversationId)}/events?after_sequence=0`, {
      headers: {
        authorization: `Bearer ${bootstrapKey.toString("utf8")}`,
        "x-core-agent-tenant-id": tenantId,
      },
      signal: abortSignal(signal, maximumPollMs),
    });
  } catch {
    throw smokeError("SMOKE_SSE_FAILED");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (response.status !== 200 || response.body === null || contentType !== "text/event-stream") {
    throw smokeError("SMOKE_SSE_FAILED");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const eventTypes = [];
  let pending = "";
  let retainedBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw smokeError("SMOKE_SSE_FAILED");
      pending += decoder.decode(next.value, { stream: true }).replace(/\r\n/gu, "\n");
      if (Buffer.byteLength(pending, "utf8") > maximumApiBodyBytes) throw smokeError("SMOKE_SSE_FAILED");
      let separator = pending.indexOf("\n\n");
      while (separator >= 0) {
        const frame = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data !== undefined) {
          retainedBytes += Buffer.byteLength(data, "utf8");
          if (eventTypes.length >= maximumEvents || retainedBytes > maximumRetainedBytes) throw smokeError("SMOKE_SSE_FAILED");
          const event = parseJson(data, "SMOKE_SSE_FAILED");
          const eventType = validateProductEventEnvelope(event, { conversationId, tenantId, runId });
          eventTypes.push(eventType);
          if (eventType === "run.completed" || eventType === "run.failed") {
            await reader.cancel().catch(() => undefined);
            return Object.freeze([...eventTypes]);
          }
        }
        separator = pending.indexOf("\n\n");
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof SmokeError) throw error;
    throw smokeError("SMOKE_SSE_FAILED");
  }
}

function deriveManagedNames(tenantId, runtimeId, generation) {
  const suffix = createHash("sha256").update(`${tenantId}\0${runtimeId}`).digest("hex").slice(0, 16);
  return Object.freeze({
    container: `core-agent-runtime-${suffix}-g${generation}`,
    volume: `core-agent-data-${suffix}`,
  });
}

function deriveProvisionedRuntimeId(tenantId) {
  return `runtime_${createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 32)}`;
}

async function scanDumpForSecrets(filePath, secretValues) {
  const metadata = await stat(filePath, { bigint: true });
  if (!metadata.isFile() || (metadata.mode & 0o7777n) !== 0o600n || metadata.size > 64n * 1024n * 1024n) {
    throw smokeError("SMOKE_DATABASE_DUMP_INVALID");
  }
  const bytes = await readFile(filePath);
  try {
    for (const secret of secretValues) {
      if (secret.length > 0 && bytes.includes(secret)) throw smokeError("SMOKE_SECRET_SENTINEL_FOUND");
    }
  } finally {
    bytes.fill(0);
  }
}

function createDefaultDependencies(environment, signal) {
  const identifiers = createSyntheticIdentifiers();
  const state = {
    bootstrapKey: undefined,
    providerSecret: undefined,
    ingressSecret: undefined,
    imageRef: undefined,
    productImageLockSnapshot: undefined,
    provider: undefined,
    runtime: undefined,
  };
  const childEnv = () => createSmokeChildEnvironment(environment, state.productImageLockSnapshot?.path);
  const child = (command, args, options = {}) => runBoundedChild(command, args, {
    ...options,
    environment: childEnv(),
    signal: options.cleanup === true ? undefined : signal,
  });
  const secretValues = () => [state.bootstrapKey, state.providerSecret, state.ingressSecret].filter(Buffer.isBuffer);

  return {
    stage(name) {
      process.stderr.write(`SMOKE_STAGE_${name.toUpperCase()}\n`);
    },
    emit(value) {
      exactRecord(value, SMOKE_OUTPUT_KEYS, "SMOKE_OUTPUT_INVALID");
      process.stdout.write(`${JSON.stringify(value)}\n`);
    },
    async validatePrerequisites() {
      await child("docker", ["version", "--format", "{{json .Server.Version}}"]);
      await child("docker", ["compose", "version", "--short"]);
      const [baseLockRaw, providerRaw] = await Promise.all([
        readFile(runtimeBaseLockFile, "utf8"),
        readFile(providerCatalogFile, "utf8"),
      ]).catch(() => { throw smokeError("SMOKE_CONFIGURATION_INVALID"); });
      const baseLock = parseJson(baseLockRaw, "SMOKE_PLATFORM_LOCK_INVALID");
      validateRuntimeBaseLock(baseLock, environment);
      state.provider = validateProviderCatalog(parseJson(providerRaw, "SMOKE_PROVIDER_CATALOG_INVALID"));
      await child("node", ["scripts/prepare-runtime-network.mjs"]);
      await child("node", ["scripts/prepare-runtime-paths.mjs"]);
      state.productImageLockSnapshot = await stageProductImageLockSnapshot(
        environment.CORE_AGENT_HERMES_IMAGE_LOCK_FILE,
        environment.CORE_AGENT_PLATFORM,
        environment.CORE_AGENT_SUPERVISOR_STATE_ROOT,
      );
      state.imageRef = state.productImageLockSnapshot.imageRef;
      const productInspection = await validateImageAvailable(state.imageRef, child);
      assertProductImageConfiguration(productInspection);
      await validateImageAvailable(environment.CORE_AGENT_NODE_IMAGE, child);
      await validateImageAvailable(environment.CORE_AGENT_POSTGRES_IMAGE, child);
      state.bootstrapKey = await readProtectedSecret(environment.CORE_AGENT_BOOTSTRAP_KEY_FILE);
      state.providerSecret = await readProtectedSecret(join(
        environment.CORE_AGENT_PROVIDER_SECRET_ROOT,
        `${state.provider.credential_secret_ref}.v1`,
      ));
      state.ingressSecret = await readProtectedSecret(join(environment.CORE_AGENT_INGRESS_SECRET_ROOT, "hermes_ingress.v1"));
      await child("docker", composeArgs("config", "--quiet"));
    },
    async startTopology() {
      await child("docker", composeArgs("up", "-d", "postgres", "migrate", "api", "worker", "supervisor"), {
        timeoutMs: 180_000,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      await requestJson("/health/ready", { bootstrapKey: state.bootstrapKey, statuses: [200], signal });
    },
    prepareProvisioningContext() {
      return Object.freeze({ ...identifiers, runtimeId: deriveProvisionedRuntimeId(identifiers.tenantId) });
    },
    async provision(context) {
      if (context?.tenantId !== identifiers.tenantId
        || context.runtimeId !== deriveProvisionedRuntimeId(identifiers.tenantId)) {
        throw smokeError("SMOKE_PROVISION_RESPONSE_INVALID");
      }
      const request = provisioningRequest(identifiers, state.imageRef, environment.CORE_AGENT_PLATFORM, state.provider);
      const response = await requestJson("/internal/v1/tenant-provisioning", {
        method: "POST", body: request, bootstrapKey: state.bootstrapKey, statuses: [202], signal,
      });
      const tenant = dataProperty(response, "tenant", "SMOKE_PROVISION_RESPONSE_INVALID");
      const runtime = dataProperty(response, "runtime", "SMOKE_PROVISION_RESPONSE_INVALID");
      if (dataProperty(tenant, "tenant_id", "SMOKE_PROVISION_RESPONSE_INVALID") !== identifiers.tenantId) {
        throw smokeError("SMOKE_PROVISION_RESPONSE_INVALID");
      }
      const runtimeId = dataProperty(runtime, "container_id", "SMOKE_PROVISION_RESPONSE_INVALID");
      if (runtimeId !== context.runtimeId) throw smokeError("SMOKE_PROVISION_RESPONSE_INVALID");
    },
    async pollRuntime(context) {
      const deadline = Date.now() + maximumPollMs;
      while (Date.now() < deadline) {
        const runtime = await requestJson(`/internal/v1/tenants/${encodeURIComponent(context.tenantId)}/runtime`, {
          bootstrapKey: state.bootstrapKey, tenantId: context.tenantId, statuses: [200], signal,
        });
        state.runtime = runtime;
        if (runtime.observed_state === "ready" && runtime.health_status === "healthy") return runtime;
        if (runtime.observed_state === "failed" || runtime.observed_state === "deleted") throw smokeError("SMOKE_RUNTIME_FAILED");
        await delay(1_000, signal);
      }
      throw smokeError("SMOKE_RUNTIME_TIMEOUT");
    },
    async createConversation(context) {
      const response = await requestJson("/internal/v1/conversations", {
        method: "POST", body: conversationRequest(identifiers), bootstrapKey: state.bootstrapKey,
        tenantId: context.tenantId, statuses: [201], signal,
      });
      const conversationId = dataProperty(response, "conversation_id", "SMOKE_CONVERSATION_RESPONSE_INVALID");
      if (typeof conversationId !== "string") throw smokeError("SMOKE_CONVERSATION_RESPONSE_INVALID");
      return conversationId;
    },
    async createRun(context, conversationId) {
      const response = await requestJson(`/internal/v1/conversations/${encodeURIComponent(conversationId)}/runs`, {
        method: "POST", body: runRequest(identifiers), bootstrapKey: state.bootstrapKey,
        tenantId: context.tenantId, statuses: [202], signal,
      });
      const runId = dataProperty(response, "run_id", "SMOKE_RUN_RESPONSE_INVALID");
      if (typeof runId !== "string") throw smokeError("SMOKE_RUN_RESPONSE_INVALID");
      return runId;
    },
    async readEvents(context, conversationId, runId) {
      return readSmokeEvents({ conversationId, tenantId: context.tenantId, runId, bootstrapKey: state.bootstrapKey, signal });
    },
    async queryRun(context, runId) {
      return requestJson(`/internal/v1/runs/${encodeURIComponent(runId)}`, {
        bootstrapKey: state.bootstrapKey, tenantId: context.tenantId, statuses: [200], signal,
      });
    },
    async countAssistantMessages(context, runId) {
      const query = `select count(*) from messages where tenant_id = '${context.tenantId}' and run_id = '${runId}' and role = 'assistant' and status = 'completed'`;
      const raw = await child("docker", composeArgs("exec", "-T", "postgres", "psql", "-At", "-U", "core_agent_app", "-d", "core_agent_runtime", "-c", query));
      const value = raw.trim();
      if (!/^\d+$/u.test(value)) throw smokeError("SMOKE_DATABASE_EVIDENCE_INVALID");
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 1) throw smokeError("SMOKE_DATABASE_EVIDENCE_INVALID");
      return count;
    },
    async inspectRuntime(context, runtime) {
      const names = deriveManagedNames(context.tenantId, context.runtimeId, runtime.generation);
      const rawId = await child("docker", [
        "ps", "--all", "--quiet",
        "--filter", "label=core-agent.managed=runtime-v1",
        "--filter", "label=core-agent.resource=runtime",
        "--filter", `label=core-agent.tenant-id=${context.tenantId}`,
        "--filter", `label=core-agent.runtime-id=${context.runtimeId}`,
      ]);
      const ids = rawId.trim() === "" ? [] : rawId.trim().split("\n");
      if (ids.length !== 1) throw smokeError("SMOKE_CONTAINER_INVALID");
      const rawInspection = await child("docker", ["inspect", ids[0]], { maxOutputBytes: 4 * 1024 * 1024 });
      const parsed = parseJson(rawInspection, "SMOKE_CONTAINER_INVALID");
      if (!Array.isArray(parsed) || parsed.length !== 1 || dataProperty(parsed[0], "Name", "SMOKE_CONTAINER_INVALID") !== `/${names.container}`) {
        throw smokeError("SMOKE_CONTAINER_INVALID");
      }
      assertManagedContainerInspection(parsed[0], {
        imageRef: state.imageRef,
        tenantId: context.tenantId,
        runtimeId: context.runtimeId,
        secretValues: secretValues(),
      });
      const initializers = await child("docker", [
        "ps", "--all", "--quiet",
        "--filter", "label=core-agent.managed=runtime-v1",
        "--filter", "label=core-agent.resource=runtime-initializer",
        "--filter", `label=core-agent.tenant-id=${context.tenantId}`,
        "--filter", `label=core-agent.runtime-id=${context.runtimeId}`,
      ]);
      if (initializers.trim() !== "") throw smokeError("SMOKE_CONTAINER_INVALID");
    },
    async scanDatabase() {
      const directory = await mkdtemp(join(tmpdir(), "core-agent-runtime-smoke-"));
      const dumpPath = join(directory, "application.dump.sql");
      await chmod(directory, 0o700);
      const handle = await open(dumpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await runBoundedChildToFile("docker", composeArgs(
          "exec", "-T", "postgres", "pg_dump", "-U", "core_agent_app", "-d", "core_agent_runtime",
          "--no-owner", "--no-privileges", "--schema=public",
        ), handle, { environment: childEnv(), signal, timeoutMs: 120_000 });
        await handle.sync();
        await handle.close();
        await scanDumpForSecrets(dumpPath, secretValues());
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(dumpPath).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
      }
    },
    async deleteRuntime(context) {
      const runtime = await requestJson(`/internal/v1/tenants/${encodeURIComponent(context.tenantId)}/runtime`, {
        bootstrapKey: state.bootstrapKey, tenantId: context.tenantId, statuses: [200], timeoutMs: 15_000,
      });
      const version = dataProperty(runtime, "resource_version", "SMOKE_CLEANUP_FAILED");
      if (!Number.isSafeInteger(version) || version < 1) throw smokeError("SMOKE_CLEANUP_FAILED");
      await requestJson(`/internal/v1/tenants/${encodeURIComponent(context.tenantId)}/runtime-commands`, {
        method: "POST", body: runtimeCommand(identifiers, "delete", version), bootstrapKey: state.bootstrapKey,
        tenantId: context.tenantId, statuses: [202], timeoutMs: 15_000,
      });
    },
    async waitForContainerRemoval(context) {
      const deadline = Date.now() + maximumPollMs;
      let removed = false;
      while (Date.now() < deadline) {
        const raw = await child("docker", [
          "ps", "--all", "--quiet",
          "--filter", "label=core-agent.managed=runtime-v1",
          "--filter", "label=core-agent.resource=runtime",
          "--filter", `label=core-agent.tenant-id=${context.tenantId}`,
          "--filter", `label=core-agent.runtime-id=${context.runtimeId}`,
        ], { cleanup: true });
        if (raw.trim() === "") {
          removed = true;
          break;
        }
        await delay(1_000);
      }
      if (!removed) throw smokeError("SMOKE_CLEANUP_FAILED");
      const names = deriveManagedNames(context.tenantId, context.runtimeId, 1);
      const volumeRaw = await child("docker", ["volume", "inspect", names.volume], { cleanup: true, maxOutputBytes: 1024 * 1024 });
      const volumes = parseJson(volumeRaw, "SMOKE_CLEANUP_FAILED");
      if (!Array.isArray(volumes) || volumes.length !== 1) throw smokeError("SMOKE_CLEANUP_FAILED");
      const labels = dataProperty(volumes[0], "Labels", "SMOKE_CLEANUP_FAILED");
      if (dataProperty(labels, "core-agent.managed", "SMOKE_CLEANUP_FAILED") !== "runtime-v1"
        || dataProperty(labels, "core-agent.resource", "SMOKE_CLEANUP_FAILED") !== "runtime-volume"
        || dataProperty(labels, "core-agent.tenant-id", "SMOKE_CLEANUP_FAILED") !== context.tenantId
        || dataProperty(labels, "core-agent.runtime-id", "SMOKE_CLEANUP_FAILED") !== context.runtimeId) {
        throw smokeError("SMOKE_CLEANUP_FAILED");
      }
    },
    async stopTopology({ projectName, removeVolumes }) {
      if (projectName !== composeProject || removeVolumes !== false) throw smokeError("SMOKE_CLEANUP_FAILED");
      await child("docker", composeArgs("down", "--remove-orphans", "--timeout", "30"), {
        cleanup: true, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024,
      });
    },
    async releaseSecrets() {
      for (const secret of secretValues()) secret.fill(0);
      state.bootstrapKey = undefined;
      state.providerSecret = undefined;
      state.ingressSecret = undefined;
      const snapshot = state.productImageLockSnapshot;
      state.productImageLockSnapshot = undefined;
      await snapshot?.cleanup();
    },
  };
}

function validateOutput(value) {
  exactRecord(value, SMOKE_OUTPUT_KEYS, "SMOKE_OUTPUT_INVALID");
  for (const key of ["conversation_id", "profile_id", "run_id", "runtime_id", "tenant_id"]) {
    if (typeof value[key] !== "string" || value[key].length < 1 || value[key].length > 255) throw smokeError("SMOKE_OUTPUT_INVALID");
  }
  if (!Array.isArray(value.event_types) || value.event_types.some((item) => typeof item !== "string")) throw smokeError("SMOKE_OUTPUT_INVALID");
  if (!Number.isSafeInteger(value.assistant_message_count) || value.assistant_message_count < 1) throw smokeError("SMOKE_OUTPUT_INVALID");
  if (value.runtime_state !== "ready" || value.run_status !== "succeeded") throw smokeError("SMOKE_OUTPUT_INVALID");
  return value;
}

export async function runControlPlaneSmoke({
  environment = process.env,
  argv = process.argv.slice(2),
  dependencies,
  signal,
} = {}) {
  validateSmokeEnvironment(environment);
  const { keepRuntime } = parseSmokeArguments(argv);
  const ownedAbort = signal === undefined ? new AbortController() : undefined;
  const activeSignal = signal ?? ownedAbort.signal;
  const deps = dependencies ?? createDefaultDependencies(environment, activeSignal);
  let topologyOwned = false;
  let context;
  let output;
  let primaryError;
  try {
    deps.stage?.("preflight");
    await deps.validatePrerequisites();
    deps.stage?.("topology");
    topologyOwned = true;
    await deps.startTopology({ projectName: composeProject });
    deps.stage?.("provision");
    context = deps.prepareProvisioningContext?.();
    const provisionedContext = await deps.provision(context);
    if (context === undefined) context = provisionedContext;
    const runtime = await deps.pollRuntime(context);
    deps.stage?.("run");
    const conversationId = await deps.createConversation(context);
    const runId = await deps.createRun(context, conversationId);
    const eventTypes = await deps.readEvents(context, conversationId, runId);
    const run = await deps.queryRun(context, runId);
    const runStatus = dataProperty(run, "status", "SMOKE_RUN_RESPONSE_INVALID");
    if (eventTypes.at(-1) !== "run.completed" || runStatus !== "succeeded") throw smokeError("SMOKE_RUN_FAILED");
    const assistantMessageCount = await deps.countAssistantMessages(context, runId);
    await deps.inspectRuntime(context, runtime);
    await deps.scanDatabase(context);
    output = validateOutput({
      assistant_message_count: assistantMessageCount,
      conversation_id: conversationId,
      event_types: [...eventTypes],
      profile_id: context.profileId,
      run_id: runId,
      run_status: runStatus,
      runtime_id: context.runtimeId,
      runtime_state: runtime.observed_state,
      tenant_id: context.tenantId,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupError;
    const rememberCleanupError = (error) => {
      if (cleanupError === undefined) cleanupError = error;
    };
    if (!keepRuntime) {
      try {
        deps.stage?.("cleanup");
      } catch (error) {
        rememberCleanupError(error);
      }
      if (context !== undefined) {
        try {
          await deps.deleteRuntime(context);
        } catch (error) {
          rememberCleanupError(error);
        }
        try {
          await deps.waitForContainerRemoval(context);
        } catch (error) {
          rememberCleanupError(error);
        }
      }
      if (topologyOwned) {
        try {
          await deps.stopTopology({ projectName: composeProject, removeVolumes: false });
        } catch (error) {
          rememberCleanupError(error);
        }
      }
    }
    try {
      await deps.releaseSecrets?.();
    } catch (error) {
      rememberCleanupError(error);
    }
    if (primaryError === undefined && cleanupError !== undefined) primaryError = cleanupError;
  }
  if (primaryError !== undefined) throw smokeError("SMOKE_STAGE_FAILED", primaryError);
  deps.emit(output);
  return output;
}

async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runControlPlaneSmoke({ signal: controller.signal });
  } catch (error) {
    const code = error instanceof SmokeError ? error.code : "SMOKE_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
