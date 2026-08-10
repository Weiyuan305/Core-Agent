import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runBuild } from "../../scripts/build-hermes-image.mjs";
import {
  buildProductImageArgs,
  buildSourceImageArgs,
  deriveSourceImageTag,
} from "../../scripts/build-hermes-source-image.mjs";

const upstreamCommit = "1".repeat(40);
const coreAgentCommit = "5".repeat(40);
const productTag = "core-agent/hermes-runtime:source-candidate";
const sourceTag = "core-agent/hermes-source:111111111111-linux-arm64";
const validSourceLock = Object.freeze({
  schema_version: 1,
  source_mode: "git-subtree-squash",
  upstream_repository: "https://github.com/NousResearch/hermes-agent.git",
  upstream_ref: "refs/tags/v2026.7.30",
  upstream_commit: upstreamCommit,
  upstream_tree: "2".repeat(40),
  product_tree: "3".repeat(40),
  license: "MIT",
  license_sha256: "4".repeat(64),
});

function invocationOptions(overrides = {}) {
  return {
    argv: [
      "node",
      "build-hermes-source-image.mjs",
      "--platform",
      "linux/arm64",
      "--tag",
      productTag,
    ],
    verifySource: async () => validSourceLock,
    resolveCoreAgentCommit: () => coreAgentCommit,
    ...overrides,
  };
}

async function rejectionCode(action, expectedCode) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.message, expectedCode);
    assert.doesNotMatch(error.message, /private|stderr|credential|example\.invalid/iu);
    return true;
  });
}

test("Hermes source candidate uses exactly two isolated Buildx calls", async () => {
  assert.equal(
    deriveSourceImageTag(upstreamCommit, "linux/arm64"),
    sourceTag,
  );
  assert.deepEqual(
    buildSourceImageArgs({
      platform: "linux/arm64",
      sourceCommit: upstreamCommit,
      sourceTag,
    }),
    [
      "buildx",
      "build",
      "--platform",
      "linux/arm64",
      "--load",
      "--build-arg",
      `HERMES_GIT_SHA=${upstreamCommit}`,
      "--tag",
      sourceTag,
      "--file",
      "third_party/hermes-agent/Dockerfile",
      "third_party/hermes-agent",
    ],
  );
  assert.deepEqual(
    buildProductImageArgs({
      platform: "linux/arm64",
      productTag,
      sourceTag,
      coreAgentCommit,
      sourceCommit: upstreamCommit,
    }),
    [
      "buildx",
      "build",
      "--platform",
      "linux/arm64",
      "--load",
      "--build-arg",
      `HERMES_SOURCE_IMAGE=${sourceTag}`,
      "--build-arg",
      `CORE_AGENT_GIT_SHA=${coreAgentCommit}`,
      "--build-arg",
      `HERMES_GIT_SHA=${upstreamCommit}`,
      "--tag",
      productTag,
      "--file",
      "infra/hermes/Dockerfile",
      ".",
    ],
  );
  assert.throws(
    () => buildProductImageArgs({
      platform: "linux/arm64",
      productTag,
      sourceTag: "core-agent/hermes-source:111111111111-linux-amd64",
      coreAgentCommit,
      sourceCommit: upstreamCommit,
    }),
    /HERMES_SOURCE_BUILD_TAG_INVALID/u,
  );

  const events = [];
  const calls = [];
  await runBuild(invocationOptions({
    verifySource: async () => {
      events.push("verified");
      return validSourceLock;
    },
    runDocker(command, args, options) {
      events.push(`docker-${calls.length + 1}`);
      calls.push({ command, args, options });
      return { status: 0 };
    },
  }));

  assert.deepEqual(events, ["verified", "docker-1", "docker-2"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "docker");
  assert.equal(calls[1].command, "docker");
  assert.deepEqual(calls[0].args, buildSourceImageArgs({
    platform: "linux/arm64",
    sourceCommit: upstreamCommit,
    sourceTag,
  }));
  assert.deepEqual(calls[1].args, buildProductImageArgs({
    platform: "linux/arm64",
    productTag,
    sourceTag,
    coreAgentCommit,
    sourceCommit: upstreamCommit,
  }));
  assert.equal(calls[0].options.cwd, new URL("../..", import.meta.url).pathname);
  assert.equal(calls[1].options.cwd, calls[0].options.cwd);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(calls[1].options.stdio, "inherit");
});

test("Hermes source candidate defaults platform from the host", async () => {
  const calls = [];
  await runBuild({
    argv: ["node", "build-hermes-source-image.mjs", "--tag", productTag],
    hostArchitecture: "arm64",
    hostPlatform: "darwin",
    verifySource: async () => validSourceLock,
    resolveCoreAgentCommit: () => coreAgentCommit,
    runDocker(_command, args) {
      calls.push(args);
      return { status: 0 };
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => args.includes("linux/arm64")));
});

test("Hermes source candidate rejects arguments, remote tags, and unknown platforms", async () => {
  const noDocker = () => assert.fail("invalid input must fail before Docker");
  for (const argv of [
    ["node", "builder", "--tag", productTag, "--extra", "value"],
    ["node", "builder", "--tag", productTag, "--tag", productTag],
    ["node", "builder", "--platform", "linux/arm64"],
    ["node", "builder", "--tag"],
  ]) {
    await rejectionCode(
      () => runBuild(invocationOptions({ argv, runDocker: noDocker })),
      "HERMES_SOURCE_BUILD_ARGUMENT_INVALID",
    );
  }

  for (const tag of [
    "core-agent/hermes-runtime:latest",
    "ghcr.io/example.invalid/core-agent/hermes-runtime:candidate",
    "example.invalid/hermes-runtime:candidate",
    "core-agent/other:candidate",
    "core-agent/hermes-runtime:Candidate",
  ]) {
    await rejectionCode(
      () => runBuild(invocationOptions({
        argv: ["node", "builder", "--tag", tag],
        runDocker: noDocker,
      })),
      "HERMES_SOURCE_BUILD_TAG_INVALID",
    );
  }

  await rejectionCode(
    () => runBuild(invocationOptions({
      argv: [
        "node",
        "builder",
        "--platform",
        "linux/s390x",
        "--tag",
        productTag,
      ],
      runDocker: noDocker,
    })),
    "HERMES_SOURCE_BUILD_PLATFORM_INVALID",
  );
});

test("Hermes source candidate fails closed on source verification", async () => {
  let dockerCalls = 0;
  await rejectionCode(
    () => runBuild(invocationOptions({
      verifySource: async () => {
        throw new Error("HERMES_SOURCE_TREE_MISMATCH");
      },
      runDocker: () => {
        dockerCalls += 1;
        return { status: 0 };
      },
    })),
    "HERMES_SOURCE_TREE_MISMATCH",
  );
  assert.equal(dockerCalls, 0);

  await rejectionCode(
    () => runBuild(invocationOptions({
      verifySource: async () => ({
        ...validSourceLock,
        product_tree: "not-a-tree",
      }),
      runDocker: () => {
        dockerCalls += 1;
        return { status: 0 };
      },
    })),
    "HERMES_SOURCE_LOCK_INVALID",
  );
  assert.equal(dockerCalls, 0);
});

test("Hermes source candidate rejects an unresolved Core-Agent revision before Docker", async () => {
  let dockerCalls = 0;
  for (const value of ["main", "A".repeat(40), "5".repeat(39), "5".repeat(41)]) {
    await rejectionCode(
      () => runBuild(invocationOptions({
        resolveCoreAgentCommit: () => value,
        runDocker: () => {
          dockerCalls += 1;
          return { status: 0 };
        },
      })),
      "HERMES_SOURCE_BUILD_CORE_COMMIT_INVALID",
    );
  }
  assert.equal(dockerCalls, 0);
});

test("Hermes source candidate contains Docker failures and stops in order", async () => {
  for (const [failure, expectedCode] of [
    [{ error: new Error("private Docker socket path") }, "HERMES_SOURCE_BUILD_DOCKER_UNAVAILABLE"],
    [{ status: 17 }, "HERMES_SOURCE_BUILD_FAILED"],
  ]) {
    let calls = 0;
    await rejectionCode(
      () => runBuild(invocationOptions({
        runDocker: () => {
          calls += 1;
          return failure;
        },
      })),
      expectedCode,
    );
    assert.equal(calls, 1);
  }

  for (const [failure, expectedCode] of [
    [{ error: new Error("private Docker socket path") }, "HERMES_SOURCE_BUILD_DOCKER_UNAVAILABLE"],
    [{ status: 23 }, "HERMES_SOURCE_BUILD_FAILED"],
  ]) {
    let calls = 0;
    await rejectionCode(
      () => runBuild(invocationOptions({
        runDocker: () => {
          calls += 1;
          return calls === 1 ? { status: 0 } : failure;
        },
      })),
      expectedCode,
    );
    assert.equal(calls, 2);
  }
});

test("Hermes source and product build contexts exclude local private state", async () => {
  const sourceDockerfile = await readFile(
    new URL("../../infra/hermes/Dockerfile", import.meta.url),
    "utf8",
  );
  const historicalDockerfile = await readFile(
    new URL("../../infra/hermes/Dockerfile.upstream-image", import.meta.url),
    "utf8",
  );
  const canonicalAdapter = await readFile(
    new URL("../../scripts/build-hermes-image.mjs", import.meta.url),
    "utf8",
  );
  const rootIgnore = await readFile(new URL("../../.dockerignore", import.meta.url), "utf8");
  const upstreamIgnore = await readFile(
    new URL("../../third_party/hermes-agent/.dockerignore", import.meta.url),
    "utf8",
  );

  assert.match(sourceDockerfile, /^ARG HERMES_SOURCE_IMAGE$/mu);
  assert.match(sourceDockerfile, /^FROM \$\{HERMES_SOURCE_IMAGE\}$/mu);
  assert.match(sourceDockerfile, /^ARG CORE_AGENT_GIT_SHA$/mu);
  assert.match(sourceDockerfile, /^ARG HERMES_GIT_SHA$/mu);
  assert.match(sourceDockerfile, /org\.opencontainers\.image\.revision="\$\{CORE_AGENT_GIT_SHA\}"/u);
  assert.match(sourceDockerfile, /io\.core-agent\.hermes\.upstream\.revision="\$\{HERMES_GIT_SHA\}"/u);
  assert.match(sourceDockerfile, /^USER hermes$/mu);
  assert.match(sourceDockerfile, /ENTRYPOINT \["\/opt\/core-agent\/gateway-entrypoint\.sh"\]/u);
  assert.match(sourceDockerfile, /install -d -m 01777 -o root -g root \/opt\/data/u);
  assert.doesNotMatch(
    sourceDockerfile,
    /(?:install_error_projection\.py|gateway-error-projection\.patch|API_SERVER_KEY=)/u,
  );
  assert.match(historicalDockerfile, /^ARG HERMES_BASE_IMAGE$/mu);
  assert.match(historicalDockerfile, /^FROM \$\{HERMES_BASE_IMAGE\}$/mu);
  assert.match(historicalDockerfile, /install_error_projection\.py/u);
  assert.doesNotMatch(canonicalAdapter, /(?:base-images\.lock\.json|resolveHermesImage|HERMES_BASE_IMAGE|Dockerfile\.upstream-image)/u);
  assert.match(canonicalAdapter, /build-hermes-source-image\.mjs/u);

  for (const marker of [
    ".git",
    ".env",
    ".env.*",
    "node_modules",
    ".local-secrets",
    "infra/runtime/postgres-data",
    "screenshots",
    "**/screenshots",
    "*.dump",
    "**/*.dump",
  ]) {
    assert.ok(rootIgnore.split("\n").includes(marker), marker);
  }
  for (const marker of [
    ".git",
    ".env",
    ".env.*",
    "node_modules",
    ".venv",
    "**/.venv",
    "__pycache__",
    ".pytest_cache/",
    "data/",
    ".hermes-docker/",
    "hermes-config/",
    "runtime/",
  ]) {
    assert.ok(upstreamIgnore.split("\n").includes(marker), marker);
  }
});

test("canonical source build and rollback boundary are documented", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const adr = await readFile(
    new URL("../../docs/architecture/0008-vendored-hermes-source-and-upstream-sync.md", import.meta.url),
    "utf8",
  );
  const combined = `${readme}\n${adr}`;

  assert.match(combined, /npm run hermes:build/u);
  assert.match(combined, /infra\/hermes\/Dockerfile\.upstream-image/u);
  assert.match(combined, /historical[^\n]+diagnostic/iu);
  assert.match(combined, /product-images\.lock\.json[^\n]+unchanged/iu);
  assert.match(adr, /Status: Accepted; source build canonical, release cutover pending/u);
  assert.doesNotMatch(combined, /(?:Dockerfile\.upstream-image[^\n]+default|automatic[^\n]+product-images\.lock\.json)/iu);
});
