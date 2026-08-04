import { createReadStream } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const [sentinel, ...explicitArtifactPaths] = process.argv.slice(2);
if (sentinel === undefined || sentinel.length === 0 || Buffer.byteLength(sentinel) > 1024) {
  process.exitCode = 2;
} else {
  const sentinelBuffer = Buffer.from(sentinel);
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const tracked = trackedArtifactPaths(repositoryRoot);
  const explicit = await expandExplicitArtifacts(explicitArtifactPaths);
  const artifacts = new Map();
  for (const path of [...tracked, ...explicit]) artifacts.set(resolve(path), path);

  const matches = [];
  for (const [path, identifier] of artifacts) {
    if (await containsSentinel(path, sentinelBuffer)) matches.push(identifier);
  }

  if (matches.length > 0) {
    emitIdentifiers(
      matches.sort().map((identifier) => displayIdentifier(identifier, repositoryRoot)),
      sentinel,
      sentinelBuffer,
    );
    process.exitCode = 1;
  }
}

function trackedArtifactPaths(repositoryRoot) {
  const result = spawnSync("git", ["-C", repositoryRoot, "ls-files", "-z"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
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
    emitIdentifiers([basename(identifier)], sentinel, Buffer.from(sentinel));
    process.exit(2);
  }
  if (metadata.isSymbolicLink()) {
    emitIdentifiers([basename(identifier)], sentinel, Buffer.from(sentinel));
    process.exit(2);
  }
  if (metadata.isFile()) {
    output.push(path);
    return;
  }
  if (!metadata.isDirectory()) {
    emitIdentifiers([basename(identifier)], sentinel, Buffer.from(sentinel));
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
      emitIdentifiers([basename(path)], sentinel, sentinelBuffer);
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
    emitIdentifiers([basename(path)], sentinel, sentinelBuffer);
    process.exit(2);
  }
}

function emitIdentifiers(identifiers, sentinelText, sentinelBuffer) {
  const output = Buffer.from(`${identifiers
    .map((identifier) => JSON.stringify(identifier.split(sentinelText).join("[REDACTED]")))
    .join("\n")}\n`);
  if (output.includes(sentinelBuffer)) return;
  process.stderr.write(output);
}

function displayIdentifier(identifier, repositoryRoot) {
  const absolute = resolve(identifier);
  const repositoryRelative = relative(repositoryRoot, absolute);
  return repositoryRelative.length > 0 && !repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".."
    ? repositoryRelative
    : basename(absolute);
}
