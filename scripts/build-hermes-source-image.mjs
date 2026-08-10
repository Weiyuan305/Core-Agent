#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateHermesSourceLock } from "./generate-hermes-source-lock.mjs";
import { hostToImagePlatform } from "./resolve-hermes-image.mjs";
import { verifyHermesSource } from "./verify-hermes-source.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const supportedPlatforms = new Set(["linux/amd64", "linux/arm64"]);
const productTagPattern = /^core-agent\/hermes-runtime:[a-z0-9][a-z0-9._-]{0,127}$/u;
const sourceCommitPattern = /^[a-f0-9]{40}$/u;
const sourceVerificationCodes = new Set([
  "HERMES_SOURCE_LOCK_INVALID",
  "HERMES_SOURCE_TREE_MISMATCH",
  "HERMES_SOURCE_LICENSE_INVALID",
  "HERMES_SOURCE_CONTENT_REJECTED",
]);

class HermesSourceBuildError extends Error {
  constructor(code) {
    super(code);
    this.name = "HermesSourceBuildError";
  }
}

function buildError(code) {
  return new HermesSourceBuildError(code);
}

function validatePlatform(platform) {
  if (typeof platform !== "string" || !supportedPlatforms.has(platform)) {
    throw buildError("HERMES_SOURCE_BUILD_PLATFORM_INVALID");
  }
  return platform;
}

function validateProductTag(tag) {
  if (
    typeof tag !== "string"
    || !productTagPattern.test(tag)
    || tag === "core-agent/hermes-runtime:latest"
  ) {
    throw buildError("HERMES_SOURCE_BUILD_TAG_INVALID");
  }
  return tag;
}

function validateSourceCommit(commit) {
  if (typeof commit !== "string" || !sourceCommitPattern.test(commit)) {
    throw buildError("HERMES_SOURCE_LOCK_INVALID");
  }
  return commit;
}

function validateCoreAgentCommit(commit) {
  if (typeof commit !== "string" || !sourceCommitPattern.test(commit)) {
    throw buildError("HERMES_SOURCE_BUILD_CORE_COMMIT_INVALID");
  }
  return commit;
}

function readCoreAgentCommit() {
  let result;
  try {
    result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1_024,
    });
  } catch {
    throw buildError("HERMES_SOURCE_BUILD_CORE_COMMIT_INVALID");
  }
  if (result?.error || result?.status !== 0) {
    throw buildError("HERMES_SOURCE_BUILD_CORE_COMMIT_INVALID");
  }
  return validateCoreAgentCommit(result.stdout?.trim());
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw buildError("HERMES_SOURCE_BUILD_ARGUMENT_INVALID");
  }
  const values = Object.create(null);
  const argumentsOnly = argv.slice(2);
  if (argumentsOnly.length % 2 !== 0) {
    throw buildError("HERMES_SOURCE_BUILD_ARGUMENT_INVALID");
  }
  for (let index = 0; index < argumentsOnly.length; index += 2) {
    const name = argumentsOnly[index];
    const value = argumentsOnly[index + 1];
    if (
      (name !== "--platform" && name !== "--tag")
      || values[name] !== undefined
      || typeof value !== "string"
      || value.length === 0
      || value.startsWith("--")
    ) {
      throw buildError("HERMES_SOURCE_BUILD_ARGUMENT_INVALID");
    }
    values[name] = value;
  }
  if (values["--tag"] === undefined) {
    throw buildError("HERMES_SOURCE_BUILD_ARGUMENT_INVALID");
  }
  return values;
}

export function deriveSourceImageTag(sourceCommit, platform) {
  const commit = validateSourceCommit(sourceCommit);
  const selectedPlatform = validatePlatform(platform);
  return `core-agent/hermes-source:${commit.slice(0, 12)}-${selectedPlatform.replace("/", "-")}`;
}

export function buildSourceImageArgs({ platform, sourceCommit, sourceTag }) {
  const selectedPlatform = validatePlatform(platform);
  const commit = validateSourceCommit(sourceCommit);
  if (sourceTag !== deriveSourceImageTag(commit, selectedPlatform)) {
    throw buildError("HERMES_SOURCE_BUILD_TAG_INVALID");
  }
  return [
    "buildx",
    "build",
    "--platform",
    selectedPlatform,
    "--load",
    "--build-arg",
    `HERMES_GIT_SHA=${commit}`,
    "--tag",
    sourceTag,
    "--file",
    "third_party/hermes-agent/Dockerfile",
    "third_party/hermes-agent",
  ];
}

export function buildProductImageArgs({
  platform,
  productTag,
  sourceTag,
  coreAgentCommit,
  sourceCommit,
}) {
  const selectedPlatform = validatePlatform(platform);
  const selectedProductTag = validateProductTag(productTag);
  const selectedCoreAgentCommit = validateCoreAgentCommit(coreAgentCommit);
  const selectedSourceCommit = validateSourceCommit(sourceCommit);
  if (
    typeof sourceTag !== "string"
    || !/^core-agent\/hermes-source:[a-f0-9]{12}-linux-(?:amd64|arm64)$/u.test(sourceTag)
    || !sourceTag.endsWith(`-${selectedPlatform.replace("/", "-")}`)
  ) {
    throw buildError("HERMES_SOURCE_BUILD_TAG_INVALID");
  }
  return [
    "buildx",
    "build",
    "--platform",
    selectedPlatform,
    "--load",
    "--build-arg",
    `HERMES_SOURCE_IMAGE=${sourceTag}`,
    "--build-arg",
    `CORE_AGENT_GIT_SHA=${selectedCoreAgentCommit}`,
    "--build-arg",
    `HERMES_GIT_SHA=${selectedSourceCommit}`,
    "--tag",
    selectedProductTag,
    "--file",
    "infra/hermes/Dockerfile",
    ".",
  ];
}

function runDockerBuild(runDocker, args) {
  let result;
  try {
    result = runDocker("docker", args, {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  } catch {
    throw buildError("HERMES_SOURCE_BUILD_DOCKER_UNAVAILABLE");
  }
  if (result?.error) {
    throw buildError("HERMES_SOURCE_BUILD_DOCKER_UNAVAILABLE");
  }
  if (result === null || typeof result !== "object" || result.status !== 0) {
    throw buildError("HERMES_SOURCE_BUILD_FAILED");
  }
}

async function verifiedSourceLock(verifySource) {
  try {
    return validateHermesSourceLock(await verifySource());
  } catch (error) {
    const code = error?.message;
    throw buildError(
      sourceVerificationCodes.has(code) ? code : "HERMES_SOURCE_LOCK_INVALID",
    );
  }
}

export async function runBuild({
  argv = process.argv,
  hostArchitecture = process.arch,
  hostPlatform = process.platform,
  verifySource = () => verifyHermesSource(),
  resolveCoreAgentCommit = () => readCoreAgentCommit(),
  runDocker = (command, args, options) => spawnSync(command, args, options),
} = {}) {
  const options = parseArguments(argv);
  let platform = options["--platform"];
  if (platform === undefined) {
    try {
      platform = hostToImagePlatform(hostPlatform, hostArchitecture);
    } catch {
      throw buildError("HERMES_SOURCE_BUILD_PLATFORM_INVALID");
    }
  }
  platform = validatePlatform(platform);
  const productTag = validateProductTag(options["--tag"]);
  if (
    typeof verifySource !== "function"
    || typeof resolveCoreAgentCommit !== "function"
    || typeof runDocker !== "function"
  ) {
    throw buildError("HERMES_SOURCE_BUILD_ARGUMENT_INVALID");
  }

  const lock = await verifiedSourceLock(verifySource);
  let coreAgentCommit;
  try {
    coreAgentCommit = validateCoreAgentCommit(await resolveCoreAgentCommit());
  } catch {
    throw buildError("HERMES_SOURCE_BUILD_CORE_COMMIT_INVALID");
  }
  const sourceTag = deriveSourceImageTag(lock.upstream_commit, platform);
  runDockerBuild(runDocker, buildSourceImageArgs({
    platform,
    sourceCommit: lock.upstream_commit,
    sourceTag,
  }));
  runDockerBuild(runDocker, buildProductImageArgs({
    platform,
    productTag,
    sourceTag,
    coreAgentCommit,
    sourceCommit: lock.upstream_commit,
  }));
}

export async function runBuildCli() {
  try {
    await runBuild();
  } catch (error) {
    const code = error instanceof HermesSourceBuildError
      ? error.message
      : "HERMES_SOURCE_BUILD_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuildCli();
}
