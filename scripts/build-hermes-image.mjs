#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  hostToImagePlatform,
  resolveHermesImage
} from "./resolve-hermes-image.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export function buildDockerArgs({ baseImage, platform, productTag }) {
  return [
    "build",
    "--platform",
    platform,
    "--build-arg",
    `HERMES_BASE_IMAGE=${baseImage}`,
    "--tag",
    productTag,
    "--file",
    "infra/hermes/Dockerfile",
    "."
  ];
}

function flagValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

export async function runBuild({
  argv = process.argv,
  hostArchitecture = process.arch,
  hostPlatform = process.platform,
  runDocker = (command, args, options) => spawnSync(command, args, options)
} = {}) {
  const lockUrl = new URL("../infra/hermes/base-images.lock.json", import.meta.url);
  const lock = JSON.parse(await readFile(lockUrl, "utf8"));
  const platform = flagValue(
    argv,
    "--platform",
    hostToImagePlatform(hostPlatform, hostArchitecture)
  );
  const productTag = flagValue(
    argv,
    "--tag",
    "core-agent/hermes-runtime:dev"
  );
  const baseImage = resolveHermesImage(lock, platform);
  const result = runDocker(
    "docker",
    buildDockerArgs({ baseImage, platform, productTag }),
    { cwd: repositoryRoot, stdio: "inherit" }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker build failed with exit code ${result.status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBuild().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
