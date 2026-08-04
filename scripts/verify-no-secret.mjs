import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const [sentinel, ...explicitArtifactPaths] = process.argv.slice(2);
if (sentinel === undefined || sentinel.length === 0 || Buffer.byteLength(sentinel) > 1024) {
  process.stderr.write("A non-empty bounded sentinel is required\n");
  process.exitCode = 2;
} else {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const tracked = trackedArtifactPaths(repositoryRoot);
  const explicit = await expandExplicitArtifacts(explicitArtifactPaths);
  const artifacts = new Map();
  for (const path of [...tracked, ...explicit]) artifacts.set(resolve(path), path);

  const matches = [];
  for (const [path, identifier] of artifacts) {
    if (await containsSentinel(path, Buffer.from(sentinel))) matches.push(identifier);
  }

  if (matches.length > 0) {
    process.stderr.write("Secret sentinel detected in artifact identifiers:\n");
    for (const identifier of matches.sort()) process.stderr.write(`- ${displayIdentifier(identifier, repositoryRoot)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("No secret sentinel matches found\n");
  }
}

function trackedArtifactPaths(repositoryRoot) {
  const result = spawnSync("git", ["-C", repositoryRoot, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write("Unable to enumerate tracked artifact identifiers\n");
    process.exit(2);
  }

  return result.stdout.toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && isTrackedArtifact(path))
    .map((path) => resolve(repositoryRoot, path));
}

function isTrackedArtifact(path) {
  const normalized = path.split(sep).join("/");
  const name = basename(normalized).toLowerCase();
  return normalized.includes("/fixtures/")
    || normalized.startsWith("fixtures/")
    || normalized.includes("/artifacts/")
    || normalized.startsWith("artifacts/")
    || normalized.includes("/logs/")
    || normalized.startsWith("logs/")
    || name.endsWith(".log")
    || name.includes("query-output")
    || (name.endsWith(".json") && (name.includes("docker-inspect") || name.includes("docker-inspection")));
}

async function expandExplicitArtifacts(paths) {
  const expanded = [];
  for (const input of paths) await collectArtifact(resolve(input), input, expanded);
  return expanded;
}

async function collectArtifact(path, identifier, output) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    process.stderr.write(`Artifact identifier is unavailable: ${basename(identifier)}\n`);
    process.exit(2);
  }
  if (metadata.isSymbolicLink()) {
    process.stderr.write(`Artifact identifier must not be a symbolic link: ${basename(identifier)}\n`);
    process.exit(2);
  }
  if (metadata.isFile()) {
    output.push(path);
    return;
  }
  if (!metadata.isDirectory()) {
    process.stderr.write(`Artifact identifier must be a regular file or directory: ${basename(identifier)}\n`);
    process.exit(2);
  }

  const directory = await opendir(path);
  for await (const entry of directory) {
    await collectArtifact(resolve(path, entry.name), resolve(identifier, entry.name), output);
  }
}

async function containsSentinel(path, sentinelBuffer) {
  let overlap = Buffer.alloc(0);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      process.stderr.write(`Tracked artifact identifier is not a regular file: ${basename(path)}\n`);
      process.exit(2);
    }
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const candidate = overlap.length === 0 ? bytes : Buffer.concat([overlap, bytes]);
      if (candidate.indexOf(sentinelBuffer) !== -1) return true;
      const overlapLength = Math.min(sentinelBuffer.length - 1, candidate.length);
      overlap = overlapLength === 0 ? Buffer.alloc(0) : Buffer.from(candidate.subarray(candidate.length - overlapLength));
    }
    return false;
  } catch {
    process.stderr.write(`Unable to scan artifact identifier: ${basename(path)}\n`);
    process.exit(2);
  }
}

function displayIdentifier(identifier, repositoryRoot) {
  const absolute = resolve(identifier);
  const repositoryRelative = relative(repositoryRoot, absolute);
  return repositoryRelative.length > 0 && !repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".."
    ? repositoryRelative
    : basename(absolute);
}
