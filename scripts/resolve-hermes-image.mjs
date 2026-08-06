#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function hostToImagePlatform(_hostPlatform, hostArchitecture) {
  if (hostArchitecture === "x64") return "linux/amd64";
  if (hostArchitecture === "arm64") return "linux/arm64";
  throw new Error(`Unsupported host architecture: ${hostArchitecture}`);
}

export function validateImageLock(lock) {
  if (lock?.schemaVersion !== 1) {
    throw new Error("Unsupported Hermes image lock schema");
  }
  if (!lock.repository || !lock.tag || !lock.platforms) {
    throw new Error("Hermes image lock is missing required fields");
  }

  for (const platform of ["linux/amd64", "linux/arm64"]) {
    const reference = lock.platforms[platform]?.reference;
    const expectedPrefix = `${lock.repository}:${lock.tag}@`;
    if (!reference?.startsWith(expectedPrefix)) {
      throw new Error(`Invalid Hermes image reference for ${platform}`);
    }
    const digest = reference.slice(expectedPrefix.length);
    if (!digestPattern.test(digest)) {
      throw new Error(`Invalid Hermes image digest for ${platform}`);
    }
  }
}

export function resolveHermesImage(lock, platform) {
  validateImageLock(lock);
  const reference = lock.platforms[platform]?.reference;
  if (!reference) {
    throw new Error(`No locked Hermes image for ${platform}`);
  }
  return reference;
}

function parseArguments(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      (name !== "--platform" && name !== "--lock")
      || options[name] !== undefined
      || typeof value !== "string"
      || value.length === 0
      || value.startsWith("--")
    ) {
      throw new Error("Hermes image resolver arguments are invalid");
    }
    options[name] = value;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const lockLocation = options["--lock"]
    ?? new URL("../infra/hermes/base-images.lock.json", import.meta.url);
  let lock;
  try {
    lock = JSON.parse(await readFile(lockLocation, "utf8"));
  } catch {
    throw new Error("Hermes image lock could not be loaded");
  }
  const platform = options["--platform"]
    ?? hostToImagePlatform(process.platform, process.arch);

  process.stdout.write(`${resolveHermesImage(lock, platform)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
