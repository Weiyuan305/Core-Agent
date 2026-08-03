import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  assertReleaseVersionAuthorities,
  loadReleaseVersionAuthorities,
} from "./check-compatibility.js";
import { CONTRACT_PACKAGE_VERSION } from "../src/index.js";
import { ContractSchemas } from "../src/registry.js";

const execFile = promisify(execFileCallback);
const compatibilityRoot = "packages/contracts/compat/v1";
const expectedSchemaFiles = Object.keys(ContractSchemas)
  .map((key) => `${key}.schema.json`)
  .sort();

export interface CompatibilityHistoryChange {
  status: string;
  path: string;
  previousPath?: string;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestFailures(label: string, files: readonly string[]): string[] {
  const actual = new Set(files);
  const expected = new Set(expectedSchemaFiles);
  const failures: string[] = [];
  for (const fileName of expectedSchemaFiles) {
    if (!actual.has(fileName)) failures.push(`${label} ${fileName}: missing`);
  }
  for (const fileName of [...actual].sort(compareAscii)) {
    if (!expected.has(fileName)) failures.push(`${label} ${fileName}: unexpected`);
  }
  return failures;
}

function validPackageVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version);
}

export function compatibilityHistoryFailures(
  changes: readonly CompatibilityHistoryChange[],
  authoritativeReleaseVersion = CONTRACT_PACKAGE_VERSION,
): string[] {
  const failures: string[] = [];
  const initialAdditions: string[] = [];
  const releaseAdditions = new Map<string, string[]>();
  const sortedChanges = [...changes].sort((left, right) => compareAscii(
    `${left.previousPath ?? ""}\0${left.path}\0${left.status}`,
    `${right.previousPath ?? ""}\0${right.path}\0${right.status}`,
  ));

  for (const change of sortedChanges) {
    if (change.status !== "A") {
      const rename = change.previousPath === undefined
        ? change.path
        : `${change.previousPath} -> ${change.path}`;
      failures.push(`compatibility history is append-only: ${change.status} ${rename}`);
      continue;
    }

    const initialMatch = new RegExp(`^${compatibilityRoot}/([^/]+\\.schema\\.json)$`)
      .exec(change.path);
    if (initialMatch?.[1] !== undefined) {
      initialAdditions.push(initialMatch[1]);
      continue;
    }
    const releaseMatch = new RegExp(`^${compatibilityRoot}/releases/([^/]+)/([^/]+)$`)
      .exec(change.path);
    if (releaseMatch?.[1] !== undefined && releaseMatch[2] !== undefined) {
      const [version, fileName] = [releaseMatch[1], releaseMatch[2]];
      if (!validPackageVersion(version)) {
        failures.push(`compatibility release addition has invalid package version: ${change.path}`);
        continue;
      }
      const files = releaseAdditions.get(version) ?? [];
      files.push(fileName);
      releaseAdditions.set(version, files);
      continue;
    }
    failures.push(`compatibility history addition is outside an allowed snapshot: ${change.path}`);
  }

  if (initialAdditions.length > 0) {
    failures.push(...manifestFailures("initial compatibility introduction", initialAdditions));
  }
  for (const version of [...releaseAdditions.keys()].sort(compareAscii)) {
    if (version !== authoritativeReleaseVersion) {
      failures.push(
        `compatibility release ${version} does not match package version authority ${authoritativeReleaseVersion}`,
      );
      continue;
    }
    failures.push(...manifestFailures(
      `release ${version} compatibility introduction`,
      releaseAdditions.get(version) ?? [],
    ));
  }
  return failures;
}

export function parseGitNameStatus(output: string): CompatibilityHistoryChange[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split("\t");
      const rawStatus = fields[0] ?? "";
      const status = rawStatus.slice(0, 1);
      if ((status === "R" || status === "C") && fields[1] !== undefined && fields[2] !== undefined) {
        return { status, previousPath: fields[1], path: fields[2] };
      }
      if (fields[1] === undefined) throw new Error(`Unreadable git name-status line: ${line}`);
      return { status, path: fields[1] };
    });
}

function validBaseRef(baseRef: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._/-]*$/.test(baseRef) && !baseRef.includes("..");
}

export async function checkCompatibilityHistory(
  baseRef: string,
  repositoryDirectory = resolve(import.meta.dirname, "../../.."),
): Promise<string[]> {
  if (!validBaseRef(baseRef)) throw new Error(`Invalid compatibility history base ref: ${baseRef}`);
  const authorities = await loadReleaseVersionAuthorities();
  assertReleaseVersionAuthorities(authorities.packageJsonVersion, authorities);
  const result = await execFile(
    "git",
    [
      "-C",
      repositoryDirectory,
      "diff",
      "--name-status",
      "--find-renames",
      "--no-ext-diff",
      `${baseRef}..HEAD`,
      "--",
      compatibilityRoot,
    ],
    { encoding: "utf8" },
  );
  return compatibilityHistoryFailures(
    parseGitNameStatus(result.stdout),
    authorities.packageJsonVersion,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const repositoryIndex = args.indexOf("--repository");
  const allowedLength = repositoryIndex >= 0 ? 4 : 2;
  if (
    baseIndex < 0
    || args[baseIndex + 1] === undefined
    || args.length !== allowedLength
    || (repositoryIndex >= 0 && args[repositoryIndex + 1] === undefined)
  ) {
    throw new Error("Usage: --base <sha-or-ref> [--repository <path>]");
  }
  const failures = await checkCompatibilityHistory(
    args[baseIndex + 1]!,
    repositoryIndex >= 0 ? resolve(args[repositoryIndex + 1]!) : undefined,
  );
  if (failures.length > 0) {
    console.error(`Compatibility history check failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log("Compatibility history check passed");
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Compatibility history check failed");
    process.exitCode = 1;
  });
}
