import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  generateHermesSourceLock,
  validateHermesSourceLock,
} from "../../scripts/generate-hermes-source-lock.mjs";
import { verifyHermesSource } from "../../scripts/verify-hermes-source.mjs";

const officialRepository = "https://github.com/NousResearch/hermes-agent.git";
const officialRef = "refs/tags/v2026.7.30";
const upstreamCommit = "1".repeat(40);
const upstreamTree = "2".repeat(40);
const productTree = "3".repeat(40);
const indexTree = "5".repeat(40);
const licenseDigest = "4".repeat(64);
const allowedErrors = new Set([
  "HERMES_SOURCE_LOCK_INVALID",
  "HERMES_SOURCE_TREE_MISMATCH",
  "HERMES_SOURCE_LICENSE_INVALID",
  "HERMES_SOURCE_CONTENT_REJECTED",
]);
const requiredPaths = Object.freeze([
  "LICENSE",
  "pyproject.toml",
  "uv.lock",
  "Dockerfile",
  "gateway/platforms/api_server.py",
]);
const helperPath = fileURLToPath(
  new URL("../../scripts/generate-hermes-source-lock.mjs", import.meta.url),
);

function validLock(overrides = {}) {
  return {
    schema_version: 1,
    source_mode: "git-subtree-squash",
    upstream_repository: officialRepository,
    upstream_ref: officialRef,
    upstream_commit: upstreamCommit,
    upstream_tree: upstreamTree,
    product_tree: productTree,
    license: "MIT",
    license_sha256: licenseDigest,
    ...overrides,
  };
}

function assertClosedError(action, expectedCode) {
  assert.throws(action, (error) => {
    assert.equal(error?.message, expectedCode);
    assert.ok(allowedErrors.has(error.message));
    assert.doesNotMatch(error.message, /private|stderr|third_party/u);
    return true;
  });
}

async function assertClosedRejection(action, expectedCode) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.message, expectedCode);
    assert.ok(allowedErrors.has(error.message));
    assert.doesNotMatch(error.message, /private|stderr|third_party/u);
    return true;
  });
}

async function createRepositoryFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-source-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const sourceRoot = join(root, "third_party", "hermes-agent");
  const lockPath = join(root, "infra", "hermes", "upstream-source.lock.json");
  await mkdir(join(sourceRoot, "gateway", "platforms"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "infra", "hermes"), { recursive: true, mode: 0o700 });
  await writeFile(join(sourceRoot, "LICENSE"), "MIT License\n\nfixture\n", { mode: 0o600 });
  for (const path of requiredPaths.slice(1)) {
    const target = join(sourceRoot, ...path.split("/"));
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, "fixture\n", { mode: 0o600 });
  }
  return { root, sourceRoot, lockPath };
}

function gitResult(stdout = "", status = 0, stderr = "") {
  return Object.freeze({ status, stdout, stderr });
}

function verifierGit({ currentProductTree = productTree, trackedPaths = requiredPaths } = {}) {
  const calls = [];
  const runGit = async (args) => {
    calls.push([...args]);
    if (JSON.stringify(args) === JSON.stringify(["diff", "--quiet", "--", "third_party/hermes-agent"])) {
      return gitResult();
    }
    if (JSON.stringify(args) === JSON.stringify(["write-tree"])) {
      return gitResult(`${indexTree}\n`);
    }
    if (JSON.stringify(args) === JSON.stringify(["rev-parse", `${indexTree}:third_party/hermes-agent`])) {
      return gitResult(`${currentProductTree}\n`);
    }
    if (JSON.stringify(args) === JSON.stringify(["ls-files", "-z", "--", "third_party/hermes-agent"])) {
      const output = trackedPaths
        .map((path) => `third_party/hermes-agent/${path}`)
        .join("\0");
      return gitResult(`${output}\0`);
    }
    return gitResult("", 1, "private git stderr must not escape");
  };
  return { calls, runGit };
}

function generationGit() {
  const calls = [];
  const runGit = async (args) => {
    calls.push([...args]);
    const key = JSON.stringify(args);
    if (key === JSON.stringify(["rev-parse", `${upstreamCommit}^{commit}`])) {
      return gitResult(`${upstreamCommit}\n`);
    }
    if (key === JSON.stringify(["rev-parse", `${upstreamCommit}^{tree}`])) {
      return gitResult(`${upstreamTree}\n`);
    }
    if (key === JSON.stringify(["diff", "--quiet", "--", "third_party/hermes-agent"])) {
      return gitResult();
    }
    if (key === JSON.stringify(["write-tree"])) return gitResult(`${indexTree}\n`);
    if (key === JSON.stringify(["rev-parse", `${indexTree}:third_party/hermes-agent`])) {
      return gitResult(`${productTree}\n`);
    }
    return gitResult("", 1, "private git stderr must not escape");
  };
  return { calls, runGit };
}

test("Hermes source lock accepts only one closed immutable provenance shape", () => {
  const lock = validateHermesSourceLock(validLock());
  assert.deepEqual(lock, validLock());
  assert.ok(Object.isFrozen(lock));

  const invalid = [
    { ...validLock(), extra: true },
    validLock({ upstream_repository: "https://example.invalid/hermes.git" }),
    validLock({ upstream_ref: "refs/heads/main" }),
    validLock({ upstream_commit: "A".repeat(40) }),
    validLock({ upstream_commit: "1".repeat(39) }),
    validLock({ upstream_tree: "2".repeat(39) }),
    validLock({ product_tree: "3".repeat(41) }),
    validLock({ license: "Apache-2.0" }),
    validLock({ license_sha256: "4".repeat(63) }),
  ];
  for (const value of invalid) {
    assertClosedError(
      () => validateHermesSourceLock(value),
      "HERMES_SOURCE_LOCK_INVALID",
    );
  }

  let accessorInvocations = 0;
  const hostile = validLock();
  Object.defineProperty(hostile, "upstream_commit", {
    enumerable: true,
    get() {
      accessorInvocations += 1;
      return upstreamCommit;
    },
  });
  assertClosedError(
    () => validateHermesSourceLock(hostile),
    "HERMES_SOURCE_LOCK_INVALID",
  );
  assert.equal(accessorInvocations, 0);
});

test("Hermes source verification permits only the complete bootstrap absence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "core-agent-hermes-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.doesNotReject(() => verifyHermesSource({ repositoryRoot: root }));

  const sourceRoot = join(root, "third_party", "hermes-agent");
  await mkdir(sourceRoot, { recursive: true });
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: root }),
    "HERMES_SOURCE_LOCK_INVALID",
  );
  await rm(sourceRoot, { recursive: true, force: true });
  const lockPath = join(root, "infra", "hermes", "upstream-source.lock.json");
  await mkdir(join(root, "infra", "hermes"), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(validLock())}\n`, { mode: 0o600 });
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: root }),
    "HERMES_SOURCE_LOCK_INVALID",
  );
});

test("Hermes source verification binds the index tree and MIT license", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const { createHash } = await import("node:crypto");
  const licenseBytes = await readFile(join(fixture.sourceRoot, "LICENSE"));
  const actualDigest = createHash("sha256").update(licenseBytes).digest("hex");
  await writeFile(
    fixture.lockPath,
    `${JSON.stringify(validLock({ license_sha256: actualDigest }), null, 2)}\n`,
    { mode: 0o600 },
  );
  const git = verifierGit();
  const verified = await verifyHermesSource({ repositoryRoot: fixture.root, runGit: git.runGit });
  assert.deepEqual(verified, validLock({ license_sha256: actualDigest }));
  assert.ok(Object.isFrozen(verified));

  const mismatchedGit = verifierGit({ currentProductTree: "6".repeat(40) });
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: fixture.root, runGit: mismatchedGit.runGit }),
    "HERMES_SOURCE_TREE_MISMATCH",
  );

  await writeFile(
    fixture.lockPath,
    `${JSON.stringify(validLock({ license_sha256: "a".repeat(64) }), null, 2)}\n`,
    { mode: 0o600 },
  );
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: fixture.root, runGit: git.runGit }),
    "HERMES_SOURCE_LICENSE_INVALID",
  );
  await unlink(join(fixture.sourceRoot, "LICENSE"));
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: fixture.root, runGit: git.runGit }),
    "HERMES_SOURCE_LICENSE_INVALID",
  );
});

test("Hermes source verification rejects forbidden or incomplete tracked content", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const { createHash } = await import("node:crypto");
  const licenseBytes = await readFile(join(fixture.sourceRoot, "LICENSE"));
  const actualDigest = createHash("sha256").update(licenseBytes).digest("hex");
  await writeFile(
    fixture.lockPath,
    `${JSON.stringify(validLock({ license_sha256: actualDigest }), null, 2)}\n`,
    { mode: 0o600 },
  );

  for (const forbidden of [
    ".git/config",
    ".venv/bin/python",
    "venv/activate",
    "node_modules/pkg/index.js",
    "pkg/__pycache__/module.pyc",
    ".pytest_cache/state",
    "config/.env",
    "keys/private.pem",
    "keys/private.key",
    "keys/private.p12",
    "keys/private.pfx",
  ]) {
    const git = verifierGit({ trackedPaths: [...requiredPaths, forbidden] });
    await assertClosedRejection(
      () => verifyHermesSource({ repositoryRoot: fixture.root, runGit: git.runGit }),
      "HERMES_SOURCE_CONTENT_REJECTED",
    );
  }

  const incomplete = verifierGit({ trackedPaths: requiredPaths.slice(0, -1) });
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: fixture.root, runGit: incomplete.runGit }),
    "HERMES_SOURCE_CONTENT_REJECTED",
  );
});

test("Hermes source verification contains Git failures without reflecting diagnostics", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const { createHash } = await import("node:crypto");
  const licenseBytes = await readFile(join(fixture.sourceRoot, "LICENSE"));
  const actualDigest = createHash("sha256").update(licenseBytes).digest("hex");
  await writeFile(
    fixture.lockPath,
    `${JSON.stringify(validLock({ license_sha256: actualDigest }), null, 2)}\n`,
    { mode: 0o600 },
  );
  const runGit = async () => gitResult("", 1, "private stderr and path");
  await assertClosedRejection(
    () => verifyHermesSource({ repositoryRoot: fixture.root, runGit }),
    "HERMES_SOURCE_TREE_MISMATCH",
  );
});

test("Hermes source lock generation resolves Git objects and writes retryable deterministic private JSON", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const git = generationGit();
  await writeFile(`${fixture.lockPath}.tmp-${process.pid}`, "interrupted\n", { mode: 0o600 });
  const lock = await generateHermesSourceLock({
    repositoryRoot: fixture.root,
    upstreamRef: officialRef,
    upstreamCommit,
    runGit: git.runGit,
  });
  const bytes = await readFile(fixture.lockPath, "utf8");
  const parsed = JSON.parse(bytes);
  assert.deepEqual(parsed, lock);
  assert.ok(Object.isFrozen(lock));
  assert.equal(bytes, `${JSON.stringify(parsed, Object.keys(parsed).sort(), 2)}\n`);
  assert.equal((await lstat(fixture.lockPath)).mode & 0o777, 0o600);
  assert.deepEqual(git.calls, [
    ["rev-parse", `${upstreamCommit}^{commit}`],
    ["rev-parse", `${upstreamCommit}^{tree}`],
    ["diff", "--quiet", "--", "third_party/hermes-agent"],
    ["write-tree"],
    ["rev-parse", `${indexTree}:third_party/hermes-agent`],
  ]);
});

test("Hermes source lock generation rejects unresolved identity and invalid CLI arguments", async (context) => {
  const fixture = await createRepositoryFixture(context);
  const runGit = async (args) => {
    if (args[0] === "rev-parse") return gitResult(`${"9".repeat(40)}\n`);
    return gitResult();
  };
  await assertClosedRejection(
    () => generateHermesSourceLock({
      repositoryRoot: fixture.root,
      upstreamRef: officialRef,
      upstreamCommit,
      runGit,
    }),
    "HERMES_SOURCE_TREE_MISMATCH",
  );

  for (const args of [
    [],
    ["--upstream-ref", officialRef],
    ["--upstream-commit", upstreamCommit],
    ["--unknown", "private-value"],
    ["--upstream-ref", officialRef, "--upstream-ref", officialRef, "--upstream-commit", upstreamCommit],
  ]) {
    const result = spawnSync(process.execPath, [helperPath, ...args], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "HERMES_SOURCE_LOCK_ARGUMENTS_INVALID\n");
    assert.doesNotMatch(result.stderr, /private-value/u);
  }
});

test("root scripts and deterministic CI enforce the Hermes source verifier", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["hermes:source:lock"], "node scripts/generate-hermes-source-lock.mjs");
  assert.equal(packageJson.scripts["hermes:source:verify"], "node scripts/verify-hermes-source.mjs");
  assert.deepEqual(packageJson.workspaces, ["apps/*", "packages/*"]);

  const workflowSource = await readFile(
    new URL("../../.github/workflows/runtime-contract.yml", import.meta.url),
    "utf8",
  );
  const workflow = parseYaml(workflowSource);
  const unitSteps = workflow.jobs.unit.steps;
  const installIndex = unitSteps.findIndex((step) => step.run === "npm ci");
  const verifyIndex = unitSteps.findIndex((step) => step.run === "npm run hermes:source:verify");
  const checkIndex = unitSteps.findIndex((step) => step.run === "npm run check");
  assert.ok(installIndex >= 0);
  assert.ok(verifyIndex > installIndex);
  assert.ok(checkIndex > verifyIndex);
});
