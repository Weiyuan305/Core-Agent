#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const lockPath = fileURLToPath(new URL("../infra/runtime/base-images.lock.json", import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const referencePattern = /^.+@sha256:[a-f0-9]{64}$/u;
const targetPlatforms = Object.freeze(["linux/amd64", "linux/arm64"]);
const indexMediaTypes = new Set([
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
]);
const manifestMediaTypes = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);

export const APPROVED_IMAGES = Object.freeze({
  node: "node:22-bookworm-slim",
  postgres: "postgres:17-bookworm",
});

function invalidManifest() {
  return new Error("registry manifest is invalid");
}

function dataProperty(value, key) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidManifest();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw invalidManifest();
  return descriptor.value;
}

function optionalDataProperty(value, key) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidManifest();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) throw invalidManifest();
  return descriptor.value;
}

export function platformDigests(raw) {
  let index;
  try {
    index = JSON.parse(raw);
  } catch {
    throw invalidManifest();
  }
  if (dataProperty(index, "schemaVersion") !== 2) throw invalidManifest();
  if (!indexMediaTypes.has(dataProperty(index, "mediaType"))) throw invalidManifest();
  const manifests = dataProperty(index, "manifests");
  if (!Array.isArray(manifests)) throw invalidManifest();
  const matches = new Map();
  for (const manifest of manifests) {
    const digest = dataProperty(manifest, "digest");
    const mediaType = dataProperty(manifest, "mediaType");
    const size = dataProperty(manifest, "size");
    const platform = dataProperty(manifest, "platform");
    const os = dataProperty(platform, "os");
    const architecture = dataProperty(platform, "architecture");
    const variant = optionalDataProperty(platform, "variant");
    if (
      typeof os !== "string"
      || typeof architecture !== "string"
      || !manifestMediaTypes.has(mediaType)
      || !Number.isSafeInteger(size)
      || size < 1
    ) throw invalidManifest();
    const key = `${os}/${architecture}`;
    if (!targetPlatforms.includes(key)) continue;
    if (
      (key === "linux/amd64" && variant !== undefined)
      || (key === "linux/arm64" && variant !== undefined && variant !== "v8")
    ) throw invalidManifest();
    if (typeof digest !== "string" || !digestPattern.test(digest) || matches.has(key)) throw invalidManifest();
    matches.set(key, digest);
  }
  if (matches.size !== targetPlatforms.length) throw invalidManifest();
  return Object.fromEntries(targetPlatforms.map((platform) => [platform, matches.get(platform)]));
}

export async function inspectRegistryRaw(image, run = execFileAsync) {
  if (!Object.values(APPROVED_IMAGES).includes(image)) throw new Error("runtime image is not approved");
  const { stdout } = await run(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", image],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
  );
  if (typeof stdout !== "string") throw invalidManifest();
  return stdout;
}

export async function resolveRuntimeImages({
  inspectRaw = inspectRegistryRaw,
  writeFile: write = writeFile,
  rename: move = rename,
  unlink: remove = unlink,
  randomSuffix = () => randomBytes(12).toString("hex"),
  destination = lockPath,
} = {}) {
  const images = {};
  for (const [name, source] of Object.entries(APPROVED_IMAGES)) {
    const digests = platformDigests(await inspectRaw(source));
    const platforms = Object.fromEntries(targetPlatforms.map((platform) => {
      const reference = `${source}@${digests[platform]}`;
      if (!referencePattern.test(reference)) throw invalidManifest();
      return [platform, reference];
    }));
    images[name] = { source, platforms };
  }
  const lock = { schemaVersion: 1, images };
  const temporaryPath = join(dirname(destination), `${destination.slice(destination.lastIndexOf("/") + 1)}.tmp-${randomSuffix()}`);
  let temporaryExists = false;
  try {
    await write(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o644 });
    temporaryExists = true;
    await move(temporaryPath, destination);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await remove(temporaryPath).catch(() => undefined);
  }
  return lock;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("resolve-runtime-images accepts no arguments");
  await resolveRuntimeImages();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("runtime image resolution failed\n");
    process.exitCode = 1;
  });
}
