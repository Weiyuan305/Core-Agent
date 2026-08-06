import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

import {
  assertCompatibleExistingManifest,
  createProductImageLock,
  parsePlatformManifest,
  serializeProductImageLock,
  validateReleaseVersion,
  validateSourceCommit,
} from "../../scripts/generate-hermes-product-lock.mjs";
import { validateProductImageLock } from "../../scripts/smoke-control-plane.mjs";

const { loadRuntimeImageLock } = await tsImport(
  "../../packages/runtime-core/src/config/image-lock.ts",
  import.meta.url,
);

const productRepository = "ghcr.io/weiyuan305/core-agent-hermes-runtime";
const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const helperPath = fileURLToPath(
  new URL("../../scripts/generate-hermes-product-lock.mjs", import.meta.url),
);

function manifestFixture() {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        digest: amd64Digest,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        digest: arm64Digest,
        platform: { os: "linux", architecture: "arm64" },
      },
    ],
  };
}

function runHelper(args) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
}

function candidateArguments(outputPath) {
  return [
    "--repository",
    productRepository,
    "--version",
    "v0.1.0",
    "--source-commit",
    "c".repeat(40),
    "--amd64-digest",
    amd64Digest,
    "--arm64-digest",
    arm64Digest,
    "--output",
    outputPath,
  ];
}

test("Hermes releases accept only canonical immutable identities", () => {
  assert.equal(validateReleaseVersion("v0.1.0"), "v0.1.0");
  assert.equal(validateSourceCommit("a".repeat(40)), "a".repeat(40));

  for (const value of [
    "latest",
    "0.1.0",
    "v01.0.0",
    "v0.1",
    "v0.1.0-rc.1",
    "v0.1.0\n",
  ]) {
    assert.throws(
      () => validateReleaseVersion(value),
      /RELEASE_VERSION_INVALID/,
    );
  }

  for (const value of ["a".repeat(39), "A".repeat(40), "g".repeat(40), "main"]) {
    assert.throws(
      () => validateSourceCommit(value),
      /RELEASE_SOURCE_COMMIT_INVALID/,
    );
  }
});

test("Hermes release manifests create one deterministic frozen product lock", () => {
  const platformDigests = parsePlatformManifest(manifestFixture());
  assert.deepEqual(platformDigests, {
    "linux/amd64": amd64Digest,
    "linux/arm64": arm64Digest,
  });
  assert.ok(Object.isFrozen(platformDigests));

  const lock = createProductImageLock({
    repository: productRepository,
    version: "v0.1.0",
    sourceCommit: "c".repeat(40),
    platformDigests,
  });
  assert.deepEqual(lock, {
    schemaVersion: 1,
    repository: productRepository,
    tag: "v0.1.0",
    platforms: {
      "linux/amd64": {
        reference: `${productRepository}:v0.1.0@${amd64Digest}`,
      },
      "linux/arm64": {
        reference: `${productRepository}:v0.1.0@${arm64Digest}`,
      },
    },
  });
  assert.ok(Object.isFrozen(lock));
  assert.ok(Object.isFrozen(lock.platforms));
  assert.ok(Object.isFrozen(lock.platforms["linux/amd64"]));
  assert.equal(serializeProductImageLock(lock), `${JSON.stringify(lock, null, 2)}\n`);
  assert.doesNotThrow(() => assertCompatibleExistingManifest(lock, manifestFixture()));
});

test("Hermes release manifest validation rejects ambiguous or unsafe input", () => {
  const duplicate = manifestFixture();
  duplicate.manifests[1].platform.architecture = "amd64";
  assert.throws(() => parsePlatformManifest(duplicate), /RELEASE_MANIFEST_INVALID/);

  const missing = manifestFixture();
  missing.manifests.pop();
  assert.throws(() => parsePlatformManifest(missing), /RELEASE_MANIFEST_INVALID/);

  const windows = manifestFixture();
  windows.manifests[0].platform.os = "windows";
  assert.throws(() => parsePlatformManifest(windows), /RELEASE_MANIFEST_INVALID/);

  const unknownArchitecture = manifestFixture();
  unknownArchitecture.manifests[0].platform.architecture = "s390x";
  assert.throws(() => parsePlatformManifest(unknownArchitecture), /RELEASE_MANIFEST_INVALID/);

  const malformedDigest = manifestFixture();
  malformedDigest.manifests[0].digest = "sha256:not-a-digest";
  assert.throws(() => parsePlatformManifest(malformedDigest), /RELEASE_MANIFEST_INVALID/);

  let accessorInvocations = 0;
  const descriptorWithAccessor = manifestFixture().manifests[0];
  Object.defineProperty(descriptorWithAccessor, "unsafe", {
    enumerable: true,
    get() {
      accessorInvocations += 1;
      return "never";
    },
  });
  const accessorManifest = manifestFixture();
  accessorManifest.manifests[0] = descriptorWithAccessor;
  assert.throws(() => parsePlatformManifest(accessorManifest), /RELEASE_MANIFEST_INVALID/);
  assert.equal(accessorInvocations, 0);

  const platformDigests = parsePlatformManifest(manifestFixture());
  assert.throws(
    () => createProductImageLock({
      repository: "ghcr.io/example/other-image",
      version: "v0.1.0",
      sourceCommit: "c".repeat(40),
      platformDigests,
    }),
    /RELEASE_REPOSITORY_INVALID/,
  );

  const lock = createProductImageLock({
    repository: productRepository,
    version: "v0.1.0",
    sourceCommit: "c".repeat(40),
    platformDigests,
  });
  const changedManifest = manifestFixture();
  changedManifest.manifests[1].digest = `sha256:${"d".repeat(64)}`;
  assert.throws(
    () => assertCompatibleExistingManifest(lock, changedManifest),
    /RELEASE_TAG_CONFLICT/,
  );
});

test("Hermes release CLI writes one private consumer-compatible lock", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-release-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const outputPath = join(root, "product-images.lock.json");
  const manifestPath = join(root, "published-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifestFixture()), { mode: 0o600 });

  const validation = runHelper([
    "--validate-release",
    "--version",
    "v0.1.0",
    "--source-commit",
    "c".repeat(40),
  ]);
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(validation.stdout, "");
  assert.equal(validation.stderr, "");

  const result = runHelper([
    ...candidateArguments(outputPath),
    "--published-manifest",
    manifestPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  const metadata = await lstat(outputPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
  const lock = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(
    loadRuntimeImageLock(lock).platforms["linux/arm64"].reference,
    `${productRepository}:v0.1.0@${arm64Digest}`,
  );
  assert.equal(
    validateProductImageLock(lock, "linux/arm64"),
    `${productRepository}:v0.1.0@${arm64Digest}`,
  );
});

test("Hermes release CLI fails closed without reflecting manifest or path data", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-release-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const outputPath = join(root, "candidate.lock.json");
  const manifestPath = join(root, "private-value-must-not-be-echoed.json");
  const changed = manifestFixture();
  changed.manifests[1].digest = `sha256:${"d".repeat(64)}`;
  await writeFile(manifestPath, JSON.stringify(changed), { mode: 0o600 });

  const conflict = runHelper([
    ...candidateArguments(outputPath),
    "--existing-manifest",
    manifestPath,
  ]);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.stdout, "");
  assert.equal(conflict.stderr, "RELEASE_TAG_CONFLICT\n");
  await assert.rejects(() => lstat(outputPath), { code: "ENOENT" });

  const symlinkPath = join(root, "manifest-link.json");
  await symlink(manifestPath, symlinkPath);
  const symlinked = runHelper([
    ...candidateArguments(outputPath),
    "--published-manifest",
    symlinkPath,
  ]);
  assert.equal(symlinked.status, 1);
  assert.equal(symlinked.stderr, "RELEASE_MANIFEST_FILE_INVALID\n");
  assert.doesNotMatch(symlinked.stderr, /private-value|manifest-link/u);

  const invalid = runHelper(["--version", "private-value-must-not-be-echoed"]);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr, "RELEASE_CLI_INVALID\n");
  assert.doesNotMatch(invalid.stderr, /private-value/u);

  await writeFile(outputPath, "occupied", { mode: 0o600 });
  const occupied = runHelper(candidateArguments(outputPath));
  assert.equal(occupied.status, 1);
  assert.equal(occupied.stderr, "RELEASE_LOCK_WRITE_FAILED\n");
  assert.equal(await readFile(outputPath, "utf8"), "occupied");
  assert.ok((constants.O_NOFOLLOW ?? 0) >= 0);
});
