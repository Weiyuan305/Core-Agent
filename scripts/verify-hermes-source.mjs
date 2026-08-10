#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateHermesSourceLock } from "./generate-hermes-source-lock.mjs";

const gitObjectPattern = /^[a-f0-9]{40}$/u;
const maximumGitOutputBytes = 4 * 1024 * 1024;
const maximumLockBytes = 64 * 1024;
const maximumLicenseBytes = 1024 * 1024;
const defaultRepositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const forbiddenSegments = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".env",
]);
const forbiddenExtensions = Object.freeze([".pem", ".key", ".p12", ".pfx"]);
const requiredPaths = new Set([
  "LICENSE",
  "pyproject.toml",
  "uv.lock",
  "Dockerfile",
  "gateway/platforms/api_server.py",
]);

class HermesSourceVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "HermesSourceVerificationError";
  }
}

function sourceError(code) {
  return new HermesSourceVerificationError(code);
}

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
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

function parseGitObject(stdout) {
  const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!gitObjectPattern.test(value)) {
    throw sourceError("HERMES_SOURCE_TREE_MISMATCH");
  }
  return value;
}

async function readLock(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size <= 0
      || metadata.size > maximumLockBytes
    ) {
      throw sourceError("HERMES_SOURCE_LOCK_INVALID");
    }
    const bytes = await handle.readFile();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return validateHermesSourceLock(JSON.parse(text));
  } catch (error) {
    if (error instanceof HermesSourceVerificationError) throw error;
    if (error?.message?.startsWith?.("HERMES_SOURCE_")) {
      throw sourceError("HERMES_SOURCE_LOCK_INVALID");
    }
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function licenseDigest(sourceRoot) {
  let handle;
  try {
    handle = await open(
      join(sourceRoot, "LICENSE"),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.split(/\r?\n/u, 1)[0] !== "MIT License") {
      throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error instanceof HermesSourceVerificationError) throw error;
    throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseTrackedPaths(stdout) {
  if (!stdout.endsWith("\0")) {
    throw sourceError("HERMES_SOURCE_CONTENT_REJECTED");
  }
  const paths = stdout.slice(0, -1).split("\0");
  if (paths.length === 0 || paths.some((path) => path.length === 0)) {
    throw sourceError("HERMES_SOURCE_CONTENT_REJECTED");
  }
  const relativePaths = new Set();
  const prefix = "third_party/hermes-agent/";
  for (const path of paths) {
    if (!path.startsWith(prefix)) throw sourceError("HERMES_SOURCE_CONTENT_REJECTED");
    const relativePath = path.slice(prefix.length);
    const segments = relativePath.split("/");
    if (
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
      || segments.some((segment) => forbiddenSegments.has(segment.toLowerCase()))
    ) {
      throw sourceError("HERMES_SOURCE_CONTENT_REJECTED");
    }
    const basename = segments.at(-1).toLowerCase();
    if (forbiddenExtensions.some((extension) => basename.endsWith(extension))) {
      throw sourceError("HERMES_SOURCE_CONTENT_REJECTED");
    }
    relativePaths.add(relativePath);
  }
  if ([...requiredPaths].some((path) => !relativePaths.has(path))) {
    throw sourceError("HERMES_SOURCE_CONTENT_REJECTED");
  }
  return relativePaths;
}

export async function verifyHermesSource(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot;
  if (typeof repositoryRoot !== "string" || !isAbsolute(repositoryRoot)) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  const sourceRoot = join(repositoryRoot, "third_party", "hermes-agent");
  const lockPath = join(repositoryRoot, "infra", "hermes", "upstream-source.lock.json");
  const sourceMetadata = await exists(sourceRoot);
  const lockMetadata = await exists(lockPath);
  if (sourceMetadata === null && lockMetadata === null) return null;
  if (
    sourceMetadata === null
    || lockMetadata === null
    || !sourceMetadata.isDirectory()
    || sourceMetadata.isSymbolicLink()
    || !lockMetadata.isFile()
    || lockMetadata.isSymbolicLink()
  ) {
    throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  }
  const lock = await readLock(lockPath);
  const runGit = options.runGit ?? defaultGitRunner(repositoryRoot);
  if (typeof runGit !== "function") throw sourceError("HERMES_SOURCE_LOCK_INVALID");

  const diff = await invokeGit(
    runGit,
    ["diff", "--quiet", "--", "third_party/hermes-agent"],
    "HERMES_SOURCE_TREE_MISMATCH",
    new Set([0, 1]),
  );
  if (diff.status !== 0 || diff.stdout !== "") {
    throw sourceError("HERMES_SOURCE_TREE_MISMATCH");
  }
  const writtenTree = parseGitObject(
    (await invokeGit(runGit, ["write-tree"], "HERMES_SOURCE_TREE_MISMATCH")).stdout,
  );
  const currentTree = parseGitObject(
    (await invokeGit(
      runGit,
      ["rev-parse", `${writtenTree}:third_party/hermes-agent`],
      "HERMES_SOURCE_TREE_MISMATCH",
    )).stdout,
  );
  if (currentTree !== lock.product_tree) {
    throw sourceError("HERMES_SOURCE_TREE_MISMATCH");
  }
  if (await licenseDigest(sourceRoot) !== lock.license_sha256) {
    throw sourceError("HERMES_SOURCE_LICENSE_INVALID");
  }
  const tracked = await invokeGit(
    runGit,
    ["ls-files", "-z", "--", "third_party/hermes-agent"],
    "HERMES_SOURCE_CONTENT_REJECTED",
  );
  parseTrackedPaths(tracked.stdout);
  return lock;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw sourceError("HERMES_SOURCE_LOCK_INVALID");
  await verifyHermesSource();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof HermesSourceVerificationError
      ? error.message
      : "HERMES_SOURCE_LOCK_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
