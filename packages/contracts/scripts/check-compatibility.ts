import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

async function jsonFileNames(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function acceptInitialV1Baseline(
  schemaDirectory: string,
  compatibilityDirectory: string,
): Promise<number> {
  await mkdir(compatibilityDirectory, { recursive: true });
  const existing = await jsonFileNames(compatibilityDirectory);
  if (existing.length > 0) {
    throw new Error("Initial v1 compatibility baseline already exists; refusing to overwrite it");
  }

  const schemaFiles = await jsonFileNames(schemaDirectory);
  if (schemaFiles.length === 0) {
    throw new Error("No generated JSON schemas are available for the initial v1 baseline");
  }
  for (const fileName of schemaFiles) {
    await copyFile(
      resolve(schemaDirectory, fileName),
      resolve(compatibilityDirectory, fileName),
    );
  }
  return schemaFiles.length;
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

  const baselineFiles = await jsonFileNames(compatibilityDirectory);
  if (baselineFiles.length === 0) {
    throw new Error("No v1 compatibility baseline found; run with --accept-initial-v1 once");
  }

  const failures: string[] = [];
  for (const fileName of baselineFiles) {
    const baselinePath = resolve(compatibilityDirectory, fileName);
    const currentPath = resolve(schemaDirectory, fileName);
    const currentText = await readFile(currentPath, "utf8").catch(() => undefined);
    if (currentText === undefined) {
      failures.push(`${fileName}: generated schema missing`);
      continue;
    }
    const previous = JSON.parse(await readFile(baselinePath, "utf8")) as Record<string, unknown>;
    const current = JSON.parse(currentText) as Record<string, unknown>;
    for (const change of compareSchemas(previous, current)) {
      failures.push(`${fileName}: ${change.kind} at ${change.path}`);
    }
  }

  if (failures.length > 0) {
    console.error(`Breaking schema changes:\n${failures.join("\n")}`);
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
