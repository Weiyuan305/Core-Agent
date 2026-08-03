import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ContractSchemas } from "../src/registry.js";

export interface BreakingChange {
  kind: "property_removed" | "type_changed" | "required_added" | "const_changed" | "enum_narrowed" | "union_narrowed" | "union_growth_not_extensible";
  path: string;
  before?: unknown;
  after?: unknown;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compareSchemas(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path = "$",
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  if (previous.type !== undefined && !sameJson(current.type, previous.type)) {
    changes.push({ kind: "type_changed", path, before: previous.type, after: current.type });
  }
  if (previous.const !== undefined && !sameJson(current.const, previous.const)) {
    changes.push({ kind: "const_changed", path, before: previous.const, after: current.const });
  }

  const previousRequired = new Set(Array.isArray(previous.required) ? previous.required as string[] : []);
  const currentRequired = new Set(Array.isArray(current.required) ? current.required as string[] : []);
  for (const key of currentRequired) {
    if (!previousRequired.has(key)) changes.push({ kind: "required_added", path: `${path}.required.${key}` });
  }

  const previousProperties = (previous.properties ?? {}) as Record<string, Record<string, unknown>>;
  const currentProperties = (current.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(previousProperties)) {
    if (!(key in currentProperties)) {
      changes.push({ kind: "property_removed", path: `${path}.properties.${key}` });
    } else {
      changes.push(...compareSchemas(value, currentProperties[key]!, `${path}.properties.${key}`));
    }
  }

  const previousEnum = Array.isArray(previous.enum) ? previous.enum : undefined;
  const currentEnum = Array.isArray(current.enum) ? current.enum : undefined;
  if (
    previousEnum !== undefined
    && (currentEnum === undefined || previousEnum.some((item) => !currentEnum.some((candidate) => sameJson(item, candidate))))
  ) {
    changes.push({ kind: "enum_narrowed", path: `${path}.enum` });
  }

  const previousUnion = Array.isArray(previous.anyOf) ? previous.anyOf as Record<string, unknown>[] : undefined;
  const currentUnion = Array.isArray(current.anyOf) ? current.anyOf as Record<string, unknown>[] : undefined;
  if (previousUnion !== undefined) {
    if (currentUnion === undefined) {
      return [...changes, { kind: "union_narrowed", path: `${path}.anyOf` }];
    }
    const branchKey = (item: Record<string, unknown>) => {
      if (typeof item.$id === "string") return `$id:${item.$id}`;
      if (item.const !== undefined) return `const:${JSON.stringify(item.const)}`;
      return `shape:${JSON.stringify(item)}`;
    };
    const before = new Map(previousUnion.map((item) => [branchKey(item), item]));
    const after = new Map(currentUnion.map((item) => [branchKey(item), item]));
    for (const [key, branch] of before) {
      const next = after.get(key);
      if (next === undefined) {
        changes.push({ kind: "union_narrowed", path: `${path}.anyOf.${key}` });
      } else {
        changes.push(...compareSchemas(branch, next, `${path}.anyOf.${key}`));
      }
    }
    if (
      [...after.keys()].some((key) => !before.has(key))
      && previous["x-extensible-union"] !== true
    ) {
      changes.push({ kind: "union_growth_not_extensible", path: `${path}.anyOf` });
    }
  }
  return changes;
}

const expectedSchemaFiles = Object.keys(ContractSchemas)
  .map((key) => `${key}.schema.json`)
  .sort((left, right) => left.localeCompare(right));

async function schemaManifestFailures(directory: string, label: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const actual = new Map(entries.map((entry) => [entry.name, entry]));
  const expected = new Set(expectedSchemaFiles);
  const failures: string[] = [];

  for (const fileName of expectedSchemaFiles) {
    const entry = actual.get(fileName);
    if (entry === undefined) failures.push(`${label} ${fileName}: missing`);
    else if (!entry.isFile()) failures.push(`${label} ${fileName}: not a file`);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!expected.has(entry.name)) failures.push(`${label} ${entry.name}: unexpected`);
  }
  return failures;
}

export async function acceptInitialV1Baseline(
  schemaDirectory: string,
  compatibilityDirectory: string,
): Promise<number> {
  const schemaFailures = await schemaManifestFailures(schemaDirectory, "generated schema manifest");
  if (schemaFailures.length > 0) {
    throw new Error(`Generated schema manifest mismatch:\n${schemaFailures.join("\n")}`);
  }

  await mkdir(compatibilityDirectory, { recursive: true });
  const existing = await readdir(compatibilityDirectory);
  if (existing.length > 0) {
    throw new Error("Initial v1 compatibility baseline already exists; refusing to overwrite it");
  }

  for (const fileName of expectedSchemaFiles) {
    await copyFile(
      resolve(schemaDirectory, fileName),
      resolve(compatibilityDirectory, fileName),
    );
  }
  return expectedSchemaFiles.length;
}

export async function checkCompatibilityDirectories(
  schemaDirectory: string,
  compatibilityDirectory: string,
): Promise<string[]> {
  const manifestFailures = [
    ...await schemaManifestFailures(schemaDirectory, "generated schema manifest"),
    ...await schemaManifestFailures(compatibilityDirectory, "compatibility schema manifest"),
  ];
  if (manifestFailures.length > 0) return manifestFailures;

  const failures: string[] = [];
  for (const fileName of expectedSchemaFiles) {
    const baselinePath = resolve(compatibilityDirectory, fileName);
    const currentPath = resolve(schemaDirectory, fileName);
    let previous: Record<string, unknown>;
    let current: Record<string, unknown>;
    try {
      previous = JSON.parse(await readFile(baselinePath, "utf8")) as Record<string, unknown>;
      current = JSON.parse(await readFile(currentPath, "utf8")) as Record<string, unknown>;
    } catch {
      failures.push(`${fileName}: unreadable schema`);
      continue;
    }
    for (const change of compareSchemas(previous, current)) {
      failures.push(`${fileName}: ${change.kind} at ${change.path}`);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const schemaDirectory = resolve(root, "schemas/v1");
  const compatibilityDirectory = resolve(root, "compat/v1");

  if (process.argv.includes("--accept-initial-v1")) {
    const count = await acceptInitialV1Baseline(schemaDirectory, compatibilityDirectory);
    console.log(`Accepted ${count} initial v1 compatibility baselines`);
    return;
  }

  const failures = await checkCompatibilityDirectories(schemaDirectory, compatibilityDirectory);
  if (failures.length > 0) {
    console.error(`Schema compatibility check failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Compatibility check failed");
    process.exitCode = 1;
  });
}
