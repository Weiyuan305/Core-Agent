import { constants, createReadStream } from "node:fs";
import { lstat, open, opendir, readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const arguments_ = process.argv.slice(2);
let sentinelText;
let sentinelBuffer;
let explicitArtifactPaths;

async function main() {
  if (arguments_[0] === "--identity-acceptance-report") {
    if (arguments_.length !== 2) return invalid();
    const valid = await validateIdentityAcceptanceReport(resolve(arguments_[1]));
    if (!valid) process.exitCode = 1;
    return;
  } else if (arguments_[0] === "--secret-file") {
    if (arguments_.length < 2) return invalid();
    sentinelBuffer = await readProtectedSentinel(resolve(arguments_[1]));
    explicitArtifactPaths = arguments_.slice(2);
  } else {
    [sentinelText, ...explicitArtifactPaths] = arguments_;
    if (sentinelText === undefined || sentinelText.length === 0 || Buffer.byteLength(sentinelText) > 1024) return invalid();
    sentinelBuffer = Buffer.from(sentinelText);
  }
  try {
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
        sentinelText,
        sentinelBuffer,
      );
      process.exitCode = 1;
    }
  } finally {
    if (sentinelText === undefined) sentinelBuffer.fill(0);
  }
}

const acceptanceReportKeys = new Set([
  "schema_version", "acceptance_mode", "started_at", "finished_at", "status",
  "cleanup_status", "known_limitations", "stages", "failure_code",
]);
const acceptanceStageKeys = new Set(["code", "status", "duration_ms"]);
const acceptanceStageCodes = new Set([
  "PREFLIGHT", "EMAIL_VERIFICATION", "PASSWORD_SIGN_IN", "PASSWORD_REAUTHENTICATION",
  "PASSWORD_RESET", "APPLE_SAME_EMAIL_LINK", "APPLE_RELAY_MANUAL_LINK", "GLOBAL_LOGOUT", "CLEANUP",
]);
const acceptanceStageOrder = [
  "PREFLIGHT", "EMAIL_VERIFICATION", "PASSWORD_SIGN_IN", "PASSWORD_REAUTHENTICATION",
  "PASSWORD_RESET", "APPLE_SAME_EMAIL_LINK", "APPLE_RELAY_MANUAL_LINK", "GLOBAL_LOGOUT",
];

function exactObject(value, allowed, required) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

async function validateIdentityAcceptanceReport(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== process.getuid?.() || (metadata.mode & 0o7777) !== 0o600
      || metadata.size < 1 || metadata.size > 64 * 1024) {
      return false;
    }
    const report = JSON.parse(await readFile(path, "utf8"));
    const required = [
      "schema_version", "acceptance_mode", "started_at", "finished_at", "status",
      "cleanup_status", "known_limitations", "stages",
    ];
    if (!exactObject(report, acceptanceReportKeys, required)
      || report.schema_version !== 1 || report.acceptance_mode !== "real_supabase_apple"
      || !Array.isArray(report.known_limitations) || report.known_limitations.length !== 1
      || report.known_limitations[0] !== "MFA_NOT_ENABLED" || !Array.isArray(report.stages)
      || report.stages.length < 2 || report.stages.length > acceptanceStageCodes.size) return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.started_at)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.finished_at)
      || !Number.isFinite(Date.parse(report.started_at)) || !Number.isFinite(Date.parse(report.finished_at))
      || Date.parse(report.finished_at) < Date.parse(report.started_at)) return false;
    if (report.status !== "passed" && report.status !== "failed") return false;
    if (report.cleanup_status !== "passed" && report.cleanup_status !== "failed") return false;
    if (!report.stages.every((stage) => exactObject(stage, acceptanceStageKeys, [...acceptanceStageKeys])
      && acceptanceStageCodes.has(stage.code) && (stage.status === "passed" || stage.status === "failed")
      && Number.isSafeInteger(stage.duration_ms) && stage.duration_ms >= 0)) return false;
    const codes = report.stages.map((stage) => stage.code);
    if (new Set(codes).size !== codes.length || codes.at(-1) !== "CLEANUP") return false;
    const execution = report.stages.slice(0, -1);
    if (execution.some((stage, index) => stage.code !== acceptanceStageOrder[index])) return false;
    const failedExecution = execution.findIndex((stage) => stage.status === "failed");
    if (failedExecution !== -1 && (failedExecution !== execution.length - 1
      || execution.slice(0, failedExecution).some((stage) => stage.status !== "passed"))) return false;
    if (report.status === "passed") return !("failure_code" in report)
      && report.cleanup_status === "passed" && report.stages.length === acceptanceStageCodes.size
      && report.stages.every((stage) => stage.status === "passed");
    return typeof report.failure_code === "string"
      && /^(?:PREFLIGHT|EMAIL_VERIFICATION|PASSWORD_SIGN_IN|PASSWORD_REAUTHENTICATION|PASSWORD_RESET|APPLE_SAME_EMAIL_LINK|APPLE_RELAY_MANUAL_LINK|GLOBAL_LOGOUT|CLEANUP)_FAILED$/u.test(report.failure_code)
      && report.stages.some((stage) => stage.status === "failed")
      && (failedExecution !== -1 || report.stages.at(-1)?.status === "failed");
  } catch {
    return false;
  }
}

function invalid() {
  process.exitCode = 2;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readProtectedSentinel(path) {
  const namedBefore = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(1025);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > 1024
      || !sameFile(namedBefore, before)) throw new Error("unsafe sentinel file");
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const [after, namedAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (bytesRead !== before.size || !sameFile(before, after) || !sameFile(after, namedAfter)) {
      throw new Error("unstable sentinel file");
    }
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    buffer.fill(0);
    await handle.close().catch(() => undefined);
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
    emitIdentifiers([basename(identifier)], sentinelText, sentinelBuffer);
    process.exit(2);
  }
  if (metadata.isSymbolicLink()) {
    emitIdentifiers([basename(identifier)], sentinelText, sentinelBuffer);
    process.exit(2);
  }
  if (metadata.isFile()) {
    output.push(path);
    return;
  }
  if (!metadata.isDirectory()) {
    emitIdentifiers([basename(identifier)], sentinelText, sentinelBuffer);
    process.exit(2);
  }

  try {
    const directory = await opendir(path);
    for await (const entry of directory) {
      await collectArtifact(resolve(path, entry.name), resolve(identifier, entry.name), output);
    }
  } catch {
    emitIdentifiers([basename(identifier)], sentinelText, sentinelBuffer);
    process.exit(2);
  }
}

async function containsSentinel(path, sentinelBuffer) {
  let overlap = Buffer.alloc(0);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      emitIdentifiers([basename(path)], sentinelText, sentinelBuffer);
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
    emitIdentifiers([basename(path)], sentinelText, sentinelBuffer);
    process.exit(2);
  }
}

function emitIdentifiers(identifiers, protectedText, protectedBuffer) {
  const output = Buffer.from(`${identifiers
    .map((identifier) => JSON.stringify(
      protectedText === undefined ? identifier : identifier.split(protectedText).join("[REDACTED]"),
    ))
    .join("\n")}\n`);
  if (output.includes(protectedBuffer)) return;
  process.stderr.write(output);
}

function displayIdentifier(identifier, repositoryRoot) {
  const absolute = resolve(identifier);
  const repositoryRelative = relative(repositoryRoot, absolute);
  return repositoryRelative.length > 0 && !repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".."
    ? repositoryRelative
    : basename(absolute);
}

try {
  await main();
} catch {
  // Never delegate scanner failures to Node's uncaught-exception formatter.
  process.exitCode = 2;
}
