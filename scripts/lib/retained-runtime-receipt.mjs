import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const RETAINED_RUNTIME_RECEIPT_NAME = ".core-agent-retained-runtime.json";

const receiptKeys = Object.freeze([
  "schemaVersion",
  "composeProject",
  "tenantId",
  "profileId",
  "runtimeId",
  "lockSnapshotName",
]);
const tenantPattern = /^synthetic-runtime-v1-([a-f0-9]{16})$/u;
const runtimePattern = /^runtime_[a-f0-9]{32}$/u;
const maximumReceiptBytes = 4 * 1024;

function fixedError(code) {
  return new Error(code);
}

function validateStateRoot(stateRoot) {
  if (
    typeof stateRoot !== "string"
    || !isAbsolute(stateRoot)
    || resolve(stateRoot) !== stateRoot
    || /[\u0000-\u001f\u007f]/u.test(stateRoot)
  ) {
    throw new Error("invalid state root");
  }
  return stateRoot;
}

function dataRecord(value) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("invalid receipt");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== receiptKeys.length
    || ownKeys.some((key) => typeof key !== "string" || !receiptKeys.includes(key))
  ) {
    throw new Error("invalid receipt");
  }
  const values = {};
  for (const key of receiptKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid receipt");
    }
    values[key] = descriptor.value;
  }
  return values;
}

export function validateRetainedRuntimeReceipt(value) {
  const values = dataRecord(value);
  const match = typeof values.tenantId === "string" ? tenantPattern.exec(values.tenantId) : null;
  const expectedRuntimeId = match === null
    ? undefined
    : `runtime_${createHash("sha256").update(values.tenantId, "utf8").digest("hex").slice(0, 32)}`;
  if (
    values.schemaVersion !== 1
    || values.composeProject !== "core-agent-runtime-v1-smoke"
    || match === null
    || values.profileId !== `synthetic-runtime-v1-profile-${match[1]}`
    || typeof values.runtimeId !== "string"
    || !runtimePattern.test(values.runtimeId)
    || values.runtimeId !== expectedRuntimeId
    || values.lockSnapshotName !== `.core-agent-product-lock-${match[1]}`
  ) {
    throw new Error("invalid receipt");
  }
  return Object.freeze({
    schemaVersion: 1,
    composeProject: values.composeProject,
    tenantId: values.tenantId,
    profileId: values.profileId,
    runtimeId: values.runtimeId,
    lockSnapshotName: values.lockSnapshotName,
  });
}

function encodeReceipt(receipt) {
  return Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
}

function sameMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size;
}

function validateRootMetadata(metadata) {
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (!metadata.isDirectory() || metadata.uid !== expectedUid || (metadata.mode & 0o7777n) !== 0o700n) {
    throw new Error("invalid state root");
  }
}

function validateReceiptMetadata(metadata) {
  const expectedUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : metadata.uid;
  if (
    !metadata.isFile()
    || metadata.uid !== expectedUid
    || metadata.nlink !== 1n
    || (metadata.mode & 0o7777n) !== 0o600n
    || metadata.size < 1n
    || metadata.size > BigInt(maximumReceiptBytes)
  ) {
    throw new Error("invalid receipt metadata");
  }
}

async function validateRoot(stateRoot, io) {
  validateStateRoot(stateRoot);
  const metadata = await io.lstat(stateRoot, { bigint: true });
  validateRootMetadata(metadata);
}

export async function createRetainedRuntimeReceipt(stateRoot, value, dependencies = {}) {
  const io = {
    lstat: dependencies.lstat ?? lstat,
    open: dependencies.open ?? open,
    unlink: dependencies.unlink ?? unlink,
  };
  let handle;
  let created = false;
  let bytes;
  const receiptPath = join(stateRoot, RETAINED_RUNTIME_RECEIPT_NAME);
  try {
    await validateRoot(stateRoot, io);
    const receipt = validateRetainedRuntimeReceipt(value);
    bytes = encodeReceipt(receipt);
    handle = await io.open(
      receiptPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
    const opened = await handle.stat({ bigint: true });
    validateReceiptMetadata(opened);
    const named = await io.lstat(receiptPath, { bigint: true });
    validateReceiptMetadata(named);
    if (!sameMetadata(opened, named) || opened.size !== BigInt(bytes.length)) {
      throw new Error("receipt changed");
    }
  } catch {
    if (created) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      await io.unlink(receiptPath).catch(() => undefined);
    }
    throw fixedError("CHAT_RETENTION_FAILED");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

async function securelyReadReceipt(stateRoot, dependencies = {}) {
  const io = { lstat: dependencies.lstat ?? lstat, open: dependencies.open ?? open };
  const receiptPath = join(stateRoot, RETAINED_RUNTIME_RECEIPT_NAME);
  let handle;
  let bytes;
  try {
    await validateRoot(stateRoot, io);
    const namedBefore = await io.lstat(receiptPath, { bigint: true });
    validateReceiptMetadata(namedBefore);
    handle = await io.open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat({ bigint: true });
    validateReceiptMetadata(openedBefore);
    if (!sameMetadata(namedBefore, openedBefore)) throw new Error("receipt changed");
    bytes = await handle.readFile();
    if (!Buffer.isBuffer(bytes) || bytes.length !== Number(openedBefore.size)) throw new Error("receipt changed");
    const openedAfter = await handle.stat({ bigint: true });
    const namedAfter = await io.lstat(receiptPath, { bigint: true });
    validateReceiptMetadata(openedAfter);
    validateReceiptMetadata(namedAfter);
    if (!sameMetadata(openedBefore, openedAfter) || !sameMetadata(openedAfter, namedAfter)) {
      throw new Error("receipt changed");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const receipt = validateRetainedRuntimeReceipt(JSON.parse(decoded));
    return Object.freeze({ receipt, receiptPath, metadata: namedAfter });
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

export async function readRetainedRuntimeReceipt(stateRoot, dependencies = {}) {
  try {
    return (await securelyReadReceipt(stateRoot, dependencies)).receipt;
  } catch {
    throw fixedError("CHAT_CLEANUP_FAILED");
  }
}

export async function removeRetainedRuntimeReceipt(stateRoot, expectedValue, dependencies = {}) {
  const io = {
    lstat: dependencies.lstat ?? lstat,
    open: dependencies.open ?? open,
    unlink: dependencies.unlink ?? unlink,
  };
  try {
    const expected = validateRetainedRuntimeReceipt(expectedValue);
    const loaded = await securelyReadReceipt(stateRoot, io);
    if (JSON.stringify(loaded.receipt) !== JSON.stringify(expected)) throw new Error("receipt mismatch");
    const named = await io.lstat(loaded.receiptPath, { bigint: true });
    validateReceiptMetadata(named);
    if (!sameMetadata(loaded.metadata, named)) throw new Error("receipt changed");
    await io.unlink(loaded.receiptPath);
  } catch {
    throw fixedError("CHAT_CLEANUP_FAILED");
  }
}
