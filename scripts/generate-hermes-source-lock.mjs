#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const officialRepository = "https://github.com/NousResearch/hermes-agent.git";
const lockKeys = Object.freeze([
  "license",
  "license_sha256",
  "product_tree",
  "schema_version",
  "source_mode",
  "upstream_commit",
  "upstream_ref",
  "upstream_repository",
  "upstream_tree",
]);
const gitObjectPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const tagRefPattern = /^refs\/tags\/[A-Za-z0-9._-]{1,128}$/u;
const maximumGitOutputBytes = 1024 * 1024;
const maximumLicenseBytes = 1024 * 1024;
const defaultRepositoryRoot = fileURLToPath(new URL("../", import.meta.url));

class HermesSourceError extends Error {
  constructor(code) {
    super(code);
    this.name = "HermesSourceError";
  }
}

function sourceError(code) {
  return new HermesSourceError(code);
}

function exactRecord(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== lockKeys.length
    || ownKeys.some((key) => typeof key !== "string" || !lockKeys.includes(key))
  ) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  const record = Object.create(null);
  for (const key of lockKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw sourceError("HERMES_SOURCE_LOCK_INVALID");
    }
    record[key] = descriptor.value;
  }
  return record;
}

export function validateHermesSourceLock(value) {
  const lock = exactRecord(value);
  if (
    lock.schema_version !== 1
    || lock.source_mode !== "git-subtree-squash"
    || lock.upstream_repository !== officialRepository
    || typeof lock.upstream_ref !== "string"
    || !tagRefPattern.test(lock.upstream_ref)
    || typeof lock.upstream_commit !== "string"
    || !gitObjectPattern.test(lock.upstream_commit)
    || typeof lock.upstream_tree !== "string"
    || !gitObjectPattern.test(lock.upstream_tree)
    || typeof lock.product_tree !== "string"
    || !gitObjectPattern.test(lock.product_tree)
    || lock.license !== "MIT"
    || typeof lock.license_sha256 !== "string"
    || !digestPattern.test(lock.license_sha256)
  ) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  return Object.freeze({
    schema_version: lock.schema_version,
    source_mode: lock.source_mode,
    upstream_repository: lock.upstream_repository,
    upstream_ref: lock.upstream_ref,
    upstream_commit: lock.upstream_commit,
    upstream_tree: lock.upstream_tree,
    product_tree: lock.product_tree,
    license: lock.license,
    license_sha256: lock.license_sha256,
  });
}

function defaultGitRunner(repositoryRoot) {
  return async (args) => spawnSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    maxBuffer: maximumGitOutputBytes,
    timeout: 10_000,
  });
}

async function invokeGit(runGit, args, code, acceptedStatuses = new Set([0])) {
  let result;
  try {
    result = await runGit(Object.freeze([...args]));
  } catch {
    throw sourceError(code);
  }
  if (
    result === null
    || typeof result !== "object"
    || !Number.isInteger(result.status)
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
    || Buffer.byteLength(result.stdout) > maximumGitOutputBytes
    || Buffer.byteLength(result.stderr) > maximumGitOutputBytes
    || !acceptedStatuses.has(result.status)
  ) {
    throw sourceError(code);
  }
  return result;
}

function parseGitObject(stdout, code) {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!gitObjectPattern.test(value)) throw sourceError(code);
  return value;
}

async function requireCleanSubtree(runGit) {
  const result = await invokeGit(
    runGit,
    ["diff", "--quiet", "--", "third_party/hermes-agent"],
    "HERMES_SOURCE_TREE_MISMATCH",
    new Set([0, 1]),
  );
  if (result.status !== 0 || result.stdout !== "") {
    throw sourceError("HERMES_SOURCE_TREE_MISMATCH");
  }
}

async function resolveGitObject(runGit, expression) {
  const result = await invokeGit(
    runGit,
    ["rev-parse", expression],
    "HERMES_SOURCE_TREE_MISMATCH",
  );
  return parseGitObject(result.stdout, "HERMES_SOURCE_TREE_MISMATCH");
}

async function readLicense(sourceRoot) {
  const path = join(sourceRoot, "LICENSE");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maximumLicenseBytes
    ) {
      throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength <= 0 || bytes.byteLength > maximumLicenseBytes) {
      throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.split(/\r?\n/u, 1)[0] !== "MIT License") {
      throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error instanceof HermesSourceError) throw error;
    throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function serializeLock(lock) {
  validateHermesSourceLock(lock);
  const sorted = Object.fromEntries(
    Object.entries(lock).sort(([left], [right]) => left.localeCompare(right, "en")),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

async function writeAtomicLock(outputPath, lock) {
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(serializeLock(lock), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    if (error instanceof HermesSourceError) throw error;
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
}

export async function generateHermesSourceLock(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  const upstreamRef = options.upstreamRef;
  const upstreamCommitValue = options.upstreamCommit;
  if (
    typeof upstreamRef !== "string"
    || !tagRefPattern.test(upstreamRef)
    || typeof upstreamCommitValue !== "string"
    || !gitObjectPattern.test(upstreamCommitValue)
  ) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  const runGit = options.runGit ?? defaultGitRunner(repositoryRoot);
  if (typeof runGit !== "function") throw sourceError("HERMES_SOURCE_LOCK_INVALID");

  const resolvedCommit = await resolveGitObject(runGit, `${upstreamCommitValue}^{commit}`);
  if (resolvedCommit !== upstreamCommitValue) {
    throw sourceError("HERMES_SOURCE_TREE_MISMATCH");
  }
  const resolvedUpstreamTree = await resolveGitObject(runGit, `${upstreamCommitValue}^{tree}`);
  await requireCleanSubtree(runGit);
  const writtenTreeResult = await invokeGit(
    runGit,
    ["write-tree"],
    "HERMES_SOURCE_TREE_MISMATCH",
  );
  const writtenTree = parseGitObject(
    writtenTreeResult.stdout,
    "HERMES_SOURCE_TREE_MISMATCH",
  );
  const resolvedProductTree = await resolveGitObject(
    runGit,
    `${writtenTree}:third_party/hermes-agent`,
  );
  const licenseSha256 = await readLicense(join(repositoryRoot, "third_party", "hermes-agent"));
  const lock = validateHermesSourceLock({
    schema_version: 1,
    source_mode: "git-subtree-squash",
    upstream_repository: officialRepository,
    upstream_ref: upstreamRef,
    upstream_commit: upstreamCommitValue,
    upstream_tree: resolvedUpstreamTree,
    product_tree: resolvedProductTree,
    license: "MIT",
    license_sha256: licenseSha256,
  });
  const outputPath = options.outputPath
    ?? join(repositoryRoot, "infra", "hermes", "upstream-source.lock.json");
  if (typeof outputPath !== "string" || !isAbsolute(outputPath)) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  await writeAtomicLock(outputPath, lock);
  return lock;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) {
    throw sourceError("HERMES_SOURCE_LOCK_ARGUMENTS_INVALID");
  }
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      (key !== "--upstream-ref" && key !== "--upstream-commit")
      || values[key] !== undefined
      || typeof value !== "string"
      || value.length === 0
      || value.startsWith("--")
    ) {
      throw sourceError("HERMES_SOURCE_LOCK_ARGUMENTS_INVALID");
    }
    values[key] = value;
  }
  if (values["--upstream-ref"] === undefined || values["--upstream-commit"] === undefined) {
    throw sourceError("HERMES_SOURCE_LOCK_ARGUMENTS_INVALID");
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  await generateHermesSourceLock({
    upstreamRef: options["--upstream-ref"],
    upstreamCommit: options["--upstream-commit"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof HermesSourceError
      ? error.message
      : "HERMES_SOURCE_LOCK_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
