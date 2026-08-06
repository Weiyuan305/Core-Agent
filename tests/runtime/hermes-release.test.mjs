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
import { parse as parseYaml } from "yaml";

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
const workflowUrl = new URL(
  "../../.github/workflows/publish-hermes-runtime.yml",
  import.meta.url,
);
const repositoryRootUrl = new URL("../../", import.meta.url);
const resolverPath = fileURLToPath(
  new URL("../../scripts/resolve-hermes-image.mjs", import.meta.url),
);

async function repositorySource(relativePath) {
  return readFile(new URL(relativePath, repositoryRootUrl), "utf8");
}

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

test("Hermes release parsing accepts standard OCI descriptor metadata", () => {
  const manifest = manifestFixture();
  manifest.annotations = { "org.opencontainers.image.ref.name": "v0.1.0" };
  for (const descriptor of manifest.manifests) {
    descriptor.mediaType = "application/vnd.oci.image.manifest.v1+json";
    descriptor.size = 1_024;
  }
  manifest.manifests[1].platform.variant = "v8";

  assert.deepEqual(parsePlatformManifest(manifest), {
    "linux/amd64": amd64Digest,
    "linux/arm64": arm64Digest,
  });
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

test("Hermes runtime publishing is manual, private, pinned, and multi-platform", async () => {
  const workflowSource = await readFile(workflowUrl, "utf8");
  const workflow = parseYaml(workflowSource);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read", packages: "write" });
  assert.equal(workflow.env.IMAGE_NAME, productRepository);
  assert.deepEqual(
    workflow.jobs.build.strategy.matrix.platform,
    ["linux/amd64", "linux/arm64"],
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.version.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.source_commit.required, true);
  assert.deepEqual(Object.keys(workflow.jobs), ["validate", "build", "publish"]);

  const uses = [];
  const runSteps = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (typeof step.uses === "string") uses.push(step.uses);
      if (typeof step.run === "string") runSteps.push(step.run);
    }
  }
  assert.ok(uses.length >= 8);
  const approvedActions = new Map([
    ["actions/checkout", "11bd71901bbe5b1630ceea73d27597364c9af683"],
    ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
    ["docker/setup-qemu-action", "96fe6ef7f33517b61c61be40b68a1882f3264fb8"],
    ["docker/setup-buildx-action", "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c"],
    ["docker/login-action", "dbcb813823bdd20940b903addbd779551569679f"],
    ["docker/build-push-action", "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a"],
    ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
    ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
  ]);
  for (const value of uses) {
    assert.match(value, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/iu);
    const [action, revision] = value.split("@");
    assert.equal(revision, approvedActions.get(action));
  }
  for (const run of runSteps) {
    assert.match(run, /^set -euo pipefail\n/u);
    assert.doesNotMatch(run, /\$\{\{\s*inputs\./u);
  }

  const publishUpload = workflow.jobs.publish.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.match(
    publishUpload.with.name,
    /^hermes-product-image-lock-/u,
  );
  assert.equal(publishUpload.with["if-no-files-found"], "error");
  assert.equal(publishUpload.with["retention-days"], 7);

  const buildStep = workflow.jobs.build.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith("docker/build-push-action@"),
  );
  assert.equal(buildStep.with.provenance, false);
  assert.equal(buildStep.with.sbom, false);

  for (const step of workflow.jobs.publish.steps) {
    if (typeof step.run === "string" && step.run.includes("$SOURCE_COMMIT")) {
      assert.equal(step.env.SOURCE_COMMIT, "${{ inputs.source_commit }}");
    }
  }

  assert.doesNotMatch(workflowSource, /(?:pull_request_target|repository_dispatch|:latest\b)/u);
  assert.match(workflowSource, /push-by-digest=true/u);
  assert.match(workflowSource, /name-canonical=true/u);
  assert.match(workflowSource, /git merge-base --is-ancestor/u);
  assert.match(workflowSource, /\.visibility/u);
  assert.match(workflowSource, /test "\$PACKAGE_VISIBILITY" = private/u);
  assert.match(workflowSource, /--existing-manifest/u);
  assert.match(workflowSource, /--published-manifest/u);
  assert.match(workflowSource, /sha-\$\{SHORT_COMMIT\}/u);
});

test("Hermes private release operations are explicit and keep credentials out of files", async () => {
  const readme = await repositorySource("README.md");
  const runbook = await repositorySource("docs/operations/runtime-v1-local-smoke.md");
  const environmentExample = await repositorySource(".env.runtime.example");
  const combined = `${readme}\n${runbook}\n${environmentExample}`;

  for (const marker of [
    "Publish Hermes Runtime",
    productRepository,
    "infra/hermes/product-images.lock.json",
    "read:packages",
    "docker login ghcr.io",
    "v0.1.3@sha256:",
  ]) {
    assert.ok(combined.includes(marker), marker);
  }
  assert.match(runbook, /private shell/iu);
  assert.match(runbook, /unset GHCR_READ_TOKEN/u);
  assert.match(runbook, /source commit/iu);
  assert.match(runbook, /both GHCR platform digests/iu);
  assert.match(runbook, /commit the candidate lock unchanged/iu);
  assert.match(runbook, /core-agent\/hermes-runtime:dev[^\n]+not AC10 evidence/iu);
  assert.match(
    environmentExample,
    /CORE_AGENT_HERMES_IMAGE_LOCK_FILE=\/absolute\/path\/to\/Core-Agent\/infra\/hermes\/product-images\.lock\.json/u,
  );
  assert.doesNotMatch(environmentExample, /(?:ghp_|github_pat_|Bearer\s+)/iu);
});

test("Hermes image resolver accepts one explicit reviewed product lock", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-lock-resolver-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "product-images.lock.json");
  const lock = createProductImageLock({
    repository: productRepository,
    version: "v0.1.0",
    sourceCommit: "c".repeat(40),
    platformDigests: {
      "linux/amd64": amd64Digest,
      "linux/arm64": arm64Digest,
    },
  });
  await writeFile(lockPath, serializeProductImageLock(lock), { mode: 0o600 });

  const resolved = spawnSync(process.execPath, [
    resolverPath,
    "--lock",
    lockPath,
    "--platform",
    "linux/arm64",
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(
    resolved.stdout,
    `${productRepository}:v0.1.0@${arm64Digest}\n`,
  );

  const duplicate = spawnSync(process.execPath, [
    resolverPath,
    "--lock",
    lockPath,
    "--lock",
    lockPath,
  ], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 10_000 });
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stderr, "Hermes image resolver arguments are invalid\n");
});
