import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDockerArgs,
  runBuild
} from "../../scripts/build-hermes-image.mjs";
import { resolveHermesImage } from "../../scripts/resolve-hermes-image.mjs";

const dockerfile = await readFile(
  new URL("../../infra/hermes/Dockerfile", import.meta.url),
  "utf8"
);
const managedConfig = await readFile(
  new URL("../../infra/hermes/managed/config.yaml", import.meta.url),
  "utf8"
);

test("Dockerfile requires an externally resolved immutable base image", () => {
  assert.match(dockerfile, /^ARG HERMES_BASE_IMAGE$/m);
  assert.match(dockerfile, /^FROM \$\{HERMES_BASE_IMAGE\}$/m);
  assert.doesNotMatch(dockerfile, /FROM\s+nousresearch\/hermes-agent:latest/);
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.title="Core-Agent Hermes Runtime"$/m
  );
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.description="Pinned Hermes runtime distribution for Core-Agent"$/m
  );
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.vendor="Core-Agent"$/m
  );
  assert.match(dockerfile, /^USER root$/m);
  assert.match(dockerfile, /COPY infra\/hermes\/managed\/config\.yaml \/etc\/hermes\/config\.yaml/);
  assert.match(
    dockerfile,
    /RUN chmod 0755 \/etc\/hermes \\\n+    && chmod 0644 \/etc\/hermes\/config\.yaml/
  );
});

test("managed config starts with a deliberately narrow tool surface", () => {
  assert.equal(managedConfig, `gateway:
  multiplex_profiles: true

platform_toolsets:
  api_server:
    - clarify
  cli:
    - clarify

plugins:
  enabled: []

security:
  redact_secrets: true

skills:
  write_approval: true

memory:
  write_approval: true
`);
  assert.doesNotMatch(
    managedConfig,
    /(?:^|\n)\s*(?:-\s+)?(?:terminal|file|browser|code_execution)\s*(?::|$)/m
  );
});

test("build command includes the resolved base reference and product tag", () => {
  const args = buildDockerArgs({
    baseImage: "nousresearch/hermes-agent:v1@sha256:abc",
    platform: "linux/arm64",
    productTag: "core-agent/hermes-runtime:test"
  });

  assert.deepEqual(args, [
    "build",
    "--platform",
    "linux/arm64",
    "--build-arg",
    "HERMES_BASE_IMAGE=nousresearch/hermes-agent:v1@sha256:abc",
    "--tag",
    "core-agent/hermes-runtime:test",
    "--file",
    "infra/hermes/Dockerfile",
    "."
  ]);
});

test("build runner resolves the locked base image before invoking Docker", async () => {
  const lock = JSON.parse(await readFile(
    new URL("../../infra/hermes/base-images.lock.json", import.meta.url),
    "utf8"
  ));
  const baseImage = resolveHermesImage(lock, "linux/arm64");
  let invocation;

  await runBuild({
    argv: ["node", "build-hermes-image.mjs", "--platform", "linux/arm64", "--tag", "core-agent/hermes-runtime:test"],
    runDocker(command, args, options) {
      invocation = { args, command, options };
      return { status: 0 };
    }
  });

  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args, buildDockerArgs({
    baseImage,
    platform: "linux/arm64",
    productTag: "core-agent/hermes-runtime:test"
  }));
  assert.equal(invocation.options.cwd, new URL("../..", import.meta.url).pathname);
  assert.equal(invocation.options.stdio, "inherit");
});

test("build runner reports Docker spawn and nonzero failures", async () => {
  const options = {
    argv: ["node", "build-hermes-image.mjs", "--platform", "linux/arm64"]
  };

  await assert.rejects(
    runBuild({
      ...options,
      runDocker: () => ({ error: new Error("Docker unavailable") })
    }),
    /Docker unavailable/
  );
  await assert.rejects(
    runBuild({
      ...options,
      runDocker: () => ({ status: 17 })
    }),
    /docker build failed with exit code 17/
  );
});

const composeConfig = await readFile(
  new URL("../../infra/hermes/compose.dev.yaml", import.meta.url),
  "utf8"
);

test("development runtime is private and keeps state outside the image", () => {
  assert.match(
    composeConfig,
    /    ports:\n      - "127\.0\.0\.1:\$\{CORE_AGENT_API_SERVER_PORT:-18642\}:8642"\n    volumes:/
  );
  assert.match(composeConfig, /company-demo-hermes-data:\/opt\/data/);
  assert.match(composeConfig, /read_only:\s+true/);
  assert.match(composeConfig, /- \/run:size=64m,mode=0755,exec/);
  assert.match(composeConfig, /no-new-privileges:true/);
  assert.match(
    composeConfig,
    /    cap_add:\n      - CHOWN\n      - DAC_OVERRIDE\n      - SETGID\n      - SETUID\n    cap_drop:/
  );
  assert.match(composeConfig, /cap_drop:\s*\n\s+- ALL/);
  assert.doesNotMatch(composeConfig, /docker\.sock/);
});

test("API server cannot start without an explicit key", () => {
  assert.match(
    composeConfig,
    /CORE_AGENT_API_SERVER_KEY:\?set CORE_AGENT_API_SERVER_KEY/
  );
});

test("CI validates runtime contracts without building or publishing images", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/runtime-contract.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /^permissions:\n  contents: read\n\njobs:/m);
  assert.match(workflow, /^\s+node-version: 22$/m);
  assert.match(workflow, /^\s+run: npm test$/m);
  assert.match(
    workflow,
    /^\s+CORE_AGENT_API_SERVER_KEY: ci-contract-test-only-not-a-secret-0000000000000000$/m
  );
  assert.match(
    workflow,
    /^\s+run: docker compose -f infra\/hermes\/compose\.dev\.yaml config --quiet$/m
  );

  const dockerCommands = workflow
    .split("\n")
    .filter((line) => /^\s+run:\s+docker(?:\s|$)/.test(line));
  assert.deepEqual(dockerCommands, [
    "        run: docker compose -f infra/hermes/compose.dev.yaml config --quiet"
  ]);
  const runCommands = workflow
    .split("\n")
    .filter((line) => /^\s+run:/.test(line));
  assert.deepEqual(runCommands, [
    "        run: npm test",
    "        run: docker compose -f infra/hermes/compose.dev.yaml config --quiet"
  ]);
  const actions = workflow
    .split("\n")
    .filter((line) => /^\s+uses:/.test(line));
  assert.deepEqual(actions, [
    "        uses: actions/checkout@v4",
    "        uses: actions/setup-node@v4"
  ]);
  assert.doesNotMatch(workflow, /docker\s+build|docker\s+compose\s+up/i);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./i);
});
