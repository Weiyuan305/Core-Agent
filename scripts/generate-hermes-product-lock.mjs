#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const versionPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const sourceCommitPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const productRepository = "ghcr.io/weiyuan305/core-agent-hermes-runtime";
const supportedPlatforms = Object.freeze(["linux/amd64", "linux/arm64"]);
const acceptedManifestMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const maximumManifestBytes = 1024 * 1024;

class ReleaseError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseError";
  }
}

export function validateReleaseVersion(value) {
  if (typeof value !== "string" || !versionPattern.test(value) || value === "latest") {
    throw new ReleaseError("RELEASE_VERSION_INVALID");
  }
  return value;
}

export function validateSourceCommit(value) {
  if (typeof value !== "string" || !sourceCommitPattern.test(value)) {
    throw new ReleaseError("RELEASE_SOURCE_COMMIT_INVALID");
  }
  return value;
}

function exactDataRecord(
  value,
  keys,
  code = "RELEASE_MANIFEST_INVALID",
  allowedKeys = keys,
) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ReleaseError(code);
  }

  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    || keys.some((key) => !actualKeys.includes(key))
  ) {
    throw new ReleaseError(code);
  }

  const values = Object.create(null);
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new ReleaseError(code);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function exactArrayValues(value, length, code = "RELEASE_MANIFEST_INVALID") {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) {
    throw new ReleaseError(code);
  }

  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), "length"];
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => !expectedKeys.includes(key))) {
    throw new ReleaseError(code);
  }

  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new ReleaseError(code);
    }
    return descriptor.value;
  });
}

function validateDigest(value, code = "RELEASE_MANIFEST_INVALID") {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new ReleaseError(code);
  }
  return value;
}

export function parsePlatformManifest(value) {
  const manifest = exactDataRecord(
    value,
    ["schemaVersion", "mediaType", "manifests"],
    "RELEASE_MANIFEST_INVALID",
    ["schemaVersion", "mediaType", "manifests", "annotations", "artifactType", "subject"],
  );
  if (
    manifest.schemaVersion !== 2
    || typeof manifest.mediaType !== "string"
    || !acceptedManifestMediaTypes.has(manifest.mediaType)
  ) {
    throw new ReleaseError("RELEASE_MANIFEST_INVALID");
  }

  const descriptors = exactArrayValues(manifest.manifests, supportedPlatforms.length);
  const discovered = Object.create(null);
  for (const descriptorValue of descriptors) {
    const descriptor = exactDataRecord(
      descriptorValue,
      ["digest", "platform"],
      "RELEASE_MANIFEST_INVALID",
      ["mediaType", "digest", "size", "urls", "annotations", "data", "artifactType", "platform"],
    );
    const platform = exactDataRecord(
      descriptor.platform,
      ["os", "architecture"],
      "RELEASE_MANIFEST_INVALID",
      ["os", "architecture", "os.version", "os.features", "variant"],
    );
    if (typeof platform.os !== "string" || typeof platform.architecture !== "string") {
      throw new ReleaseError("RELEASE_MANIFEST_INVALID");
    }
    if (
      platform.variant !== undefined
      && !(platform.architecture === "arm64" && platform.variant === "v8")
    ) {
      throw new ReleaseError("RELEASE_MANIFEST_INVALID");
    }
    const platformName = `${platform.os}/${platform.architecture}`;
    if (!supportedPlatforms.includes(platformName) || discovered[platformName] !== undefined) {
      throw new ReleaseError("RELEASE_MANIFEST_INVALID");
    }
    discovered[platformName] = validateDigest(descriptor.digest);
  }

  if (supportedPlatforms.some((platform) => discovered[platform] === undefined)) {
    throw new ReleaseError("RELEASE_MANIFEST_INVALID");
  }

  return Object.freeze({
    "linux/amd64": discovered["linux/amd64"],
    "linux/arm64": discovered["linux/arm64"],
  });
}

function validatePlatformDigests(value) {
  const platforms = exactDataRecord(
    value,
    ["linux/amd64", "linux/arm64"],
    "RELEASE_PLATFORM_DIGESTS_INVALID",
  );
  return Object.freeze({
    "linux/amd64": validateDigest(platforms["linux/amd64"], "RELEASE_PLATFORM_DIGESTS_INVALID"),
    "linux/arm64": validateDigest(platforms["linux/arm64"], "RELEASE_PLATFORM_DIGESTS_INVALID"),
  });
}

export function createProductImageLock(input) {
  const candidate = exactDataRecord(
    input,
    ["repository", "version", "sourceCommit", "platformDigests"],
    "RELEASE_INPUT_INVALID",
  );
  if (candidate.repository !== productRepository) {
    throw new ReleaseError("RELEASE_REPOSITORY_INVALID");
  }
  const version = validateReleaseVersion(candidate.version);
  validateSourceCommit(candidate.sourceCommit);
  const platformDigests = validatePlatformDigests(candidate.platformDigests);

  return Object.freeze({
    schemaVersion: 1,
    repository: productRepository,
    tag: version,
    platforms: Object.freeze({
      "linux/amd64": Object.freeze({
        reference: `${productRepository}:${version}@${platformDigests["linux/amd64"]}`,
      }),
      "linux/arm64": Object.freeze({
        reference: `${productRepository}:${version}@${platformDigests["linux/arm64"]}`,
      }),
    }),
  });
}

function platformDigestsFromLock(value) {
  const lock = exactDataRecord(
    value,
    ["schemaVersion", "repository", "tag", "platforms"],
    "RELEASE_LOCK_INVALID",
  );
  if (lock.schemaVersion !== 1 || lock.repository !== productRepository) {
    throw new ReleaseError("RELEASE_LOCK_INVALID");
  }
  const version = validateReleaseVersion(lock.tag);
  const platforms = exactDataRecord(
    lock.platforms,
    ["linux/amd64", "linux/arm64"],
    "RELEASE_LOCK_INVALID",
  );
  const digests = Object.create(null);
  for (const platform of supportedPlatforms) {
    const entry = exactDataRecord(platforms[platform], ["reference"], "RELEASE_LOCK_INVALID");
    const prefix = `${productRepository}:${version}@`;
    if (typeof entry.reference !== "string" || !entry.reference.startsWith(prefix)) {
      throw new ReleaseError("RELEASE_LOCK_INVALID");
    }
    digests[platform] = validateDigest(entry.reference.slice(prefix.length), "RELEASE_LOCK_INVALID");
  }
  return Object.freeze({
    "linux/amd64": digests["linux/amd64"],
    "linux/arm64": digests["linux/arm64"],
  });
}

export function serializeProductImageLock(lock) {
  platformDigestsFromLock(lock);
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function assertCompatibleExistingManifest(lock, existingManifest) {
  const expected = platformDigestsFromLock(lock);
  const actual = parsePlatformManifest(existingManifest);
  if (supportedPlatforms.some((platform) => actual[platform] !== expected[platform])) {
    throw new ReleaseError("RELEASE_TAG_CONFLICT");
  }
}

function parseCliArguments(argv) {
  const valueOptions = new Set([
    "--version",
    "--source-commit",
    "--repository",
    "--amd64-digest",
    "--arm64-digest",
    "--output",
    "--existing-manifest",
    "--published-manifest",
  ]);
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--validate-release") {
      if (result.validateRelease === true) throw new ReleaseError("RELEASE_CLI_INVALID");
      result.validateRelease = true;
      continue;
    }
    if (!valueOptions.has(option) || result[option] !== undefined) {
      throw new ReleaseError("RELEASE_CLI_INVALID");
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new ReleaseError("RELEASE_CLI_INVALID");
    }
    result[option] = value;
    index += 1;
  }
  return result;
}

async function readManifestFile(path) {
  let handle;
  let bytes;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximumManifestBytes) {
      throw new ReleaseError("RELEASE_MANIFEST_FILE_INVALID");
    }
    bytes = await handle.readFile();
    if (bytes.byteLength <= 0 || bytes.byteLength > maximumManifestBytes) {
      throw new ReleaseError("RELEASE_MANIFEST_FILE_INVALID");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("RELEASE_MANIFEST_FILE_INVALID");
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => {});
  }
}

async function writeLockFile(path, lock) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(serializeProductImageLock(lock), "utf8");
    await handle.sync();
  } catch {
    throw new ReleaseError("RELEASE_LOCK_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArguments(argv);
  const version = options["--version"];
  const sourceCommit = options["--source-commit"];
  if (options.validateRelease === true) {
    if (Reflect.ownKeys(options).length !== 3) throw new ReleaseError("RELEASE_CLI_INVALID");
    validateReleaseVersion(version);
    validateSourceCommit(sourceCommit);
    return;
  }

  const comparisonPaths = [options["--existing-manifest"], options["--published-manifest"]]
    .filter((value) => value !== undefined);
  if (
    comparisonPaths.length > 1
    || Reflect.ownKeys(options).some((key) => ![
      "--repository",
      "--version",
      "--source-commit",
      "--amd64-digest",
      "--arm64-digest",
      "--output",
      "--existing-manifest",
      "--published-manifest",
    ].includes(key))
  ) {
    throw new ReleaseError("RELEASE_CLI_INVALID");
  }
  for (const required of [
    "--repository",
    "--version",
    "--source-commit",
    "--amd64-digest",
    "--arm64-digest",
    "--output",
  ]) {
    if (options[required] === undefined) throw new ReleaseError("RELEASE_CLI_INVALID");
  }

  const lock = createProductImageLock({
    repository: options["--repository"],
    version,
    sourceCommit,
    platformDigests: {
      "linux/amd64": options["--amd64-digest"],
      "linux/arm64": options["--arm64-digest"],
    },
  });
  if (comparisonPaths.length === 1) {
    assertCompatibleExistingManifest(lock, await readManifestFile(comparisonPaths[0]));
  }
  await writeLockFile(options["--output"], lock);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = error instanceof ReleaseError ? error.message : "RELEASE_OPERATION_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
