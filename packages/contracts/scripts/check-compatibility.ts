import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ContractSchemas } from "../src/registry.js";

export interface BreakingChange {
  kind:
    | "property_removed"
    | "type_changed"
    | "required_added"
    | "const_changed"
    | "enum_narrowed"
    | "union_narrowed"
    | "union_growth_not_extensible"
    | "lower_bound_tightened"
    | "upper_bound_tightened"
    | "multiple_of_changed"
    | "min_length_increased"
    | "max_length_decreased"
    | "pattern_changed"
    | "format_changed"
    | "min_items_increased"
    | "max_items_decreased"
    | "unique_items_enabled"
    | "items_restricted"
    | "min_properties_increased"
    | "max_properties_decreased"
    | "additional_properties_restricted"
    | "one_of_changed"
    | "all_of_tightened"
    | "not_changed"
    | "conditional_changed"
    | "reference_changed";
  path: string;
  before?: unknown;
  after?: unknown;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function change(
  kind: BreakingChange["kind"],
  path: string,
  before: unknown,
  after: unknown,
): BreakingChange {
  return { kind, path, before, after };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface NumericBound {
  value: number;
  exclusive: boolean;
}

function lowerBound(schema: Record<string, unknown>): NumericBound | undefined {
  const inclusive = finiteNumber(schema.minimum);
  const exclusive = finiteNumber(schema.exclusiveMinimum);
  if (inclusive === undefined) {
    return exclusive === undefined ? undefined : { value: exclusive, exclusive: true };
  }
  if (exclusive === undefined || inclusive > exclusive) {
    return { value: inclusive, exclusive: false };
  }
  return { value: exclusive, exclusive: exclusive >= inclusive };
}

function upperBound(schema: Record<string, unknown>): NumericBound | undefined {
  const inclusive = finiteNumber(schema.maximum);
  const exclusive = finiteNumber(schema.exclusiveMaximum);
  if (inclusive === undefined) {
    return exclusive === undefined ? undefined : { value: exclusive, exclusive: true };
  }
  if (exclusive === undefined || inclusive < exclusive) {
    return { value: inclusive, exclusive: false };
  }
  return { value: exclusive, exclusive: exclusive <= inclusive };
}

function isLowerBoundTighter(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const before = lowerBound(previous);
  const after = lowerBound(current);
  if (after === undefined) return false;
  if (before === undefined) return true;
  return after.value > before.value
    || (after.value === before.value && after.exclusive && !before.exclusive);
}

function isUpperBoundTighter(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const before = upperBound(previous);
  const after = upperBound(current);
  if (after === undefined) return false;
  if (before === undefined) return true;
  return after.value < before.value
    || (after.value === before.value && after.exclusive && !before.exclusive);
}

function isMinimumIncreased(previous: unknown, current: unknown): boolean {
  const after = finiteNumber(current);
  if (after === undefined) return false;
  const before = finiteNumber(previous);
  return before === undefined || after > before;
}

function isMaximumDecreased(previous: unknown, current: unknown): boolean {
  const after = finiteNumber(current);
  if (after === undefined) return false;
  const before = finiteNumber(previous);
  return before === undefined || after < before;
}

function normalizedTypes(value: unknown): Set<string> | undefined {
  if (typeof value === "string") return new Set([value]);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return new Set(value);
  }
  return undefined;
}

function typeNarrows(previous: unknown, current: unknown): boolean {
  if (current === undefined) return false;
  if (sameJson(previous, current)) return false;
  if (previous === undefined) return true;
  const before = normalizedTypes(previous);
  const after = normalizedTypes(current);
  if (before === undefined || after === undefined) return true;
  return [...before].some((item) => !after.has(item));
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptySchema(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

function compareSubschema(
  previous: unknown,
  current: unknown,
  path: string,
  restrictionKind: "items_restricted" | "additional_properties_restricted",
): BreakingChange[] {
  if (current === undefined || current === true) return [];
  if (current === false) {
    return previous === false ? [] : [change(restrictionKind, path, previous, current)];
  }
  if (!isSchemaObject(current)) {
    return sameJson(previous, current) ? [] : [change(restrictionKind, path, previous, current)];
  }
  if (previous === false) return [];
  if (previous === undefined || previous === true) {
    return isEmptySchema(current) ? [] : [change(restrictionKind, path, previous, current)];
  }
  if (!isSchemaObject(previous)) {
    return sameJson(previous, current) ? [] : [change(restrictionKind, path, previous, current)];
  }
  return compareSchemas(previous, current, path);
}

function branchIdentity(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.$id === "string") return `$id:${schema.$id}`;
  if (schema.const !== undefined) return `const:${JSON.stringify(schema.const)}`;
  const properties = isSchemaObject(schema.properties) ? schema.properties : undefined;
  const eventType = properties?.event_type;
  if (isSchemaObject(eventType)) {
    if (eventType.const !== undefined) return `event_type:${JSON.stringify(eventType.const)}`;
    if (Array.isArray(eventType.anyOf)) {
      const values = eventType.anyOf
        .filter(isSchemaObject)
        .map((branch) => branch.const)
        .filter((value) => value !== undefined);
      if (values.length === eventType.anyOf.length) {
        return `event_type_union:${JSON.stringify(values)}`;
      }
    }
  }
  return undefined;
}

function compareAnyOf(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const before = Array.isArray(previous.anyOf)
    ? previous.anyOf.filter(isSchemaObject)
    : undefined;
  const after = Array.isArray(current.anyOf)
    ? current.anyOf.filter(isSchemaObject)
    : undefined;
  if (after === undefined) return [];
  if (before === undefined) {
    return [change("union_narrowed", `${path}.anyOf`, previous.anyOf, current.anyOf)];
  }

  const changes: BreakingChange[] = [];
  const matchedAfter = new Set<number>();
  for (const [beforeIndex, branch] of before.entries()) {
    let matchIndex = after.findIndex((candidate) => (
      compareSchemas(branch, candidate, `${path}.anyOf[${beforeIndex}]`).length === 0
    ));
    if (matchIndex >= 0) {
      matchedAfter.add(matchIndex);
      continue;
    }

    const identity = branchIdentity(branch);
    if (identity !== undefined) {
      matchIndex = after.findIndex((candidate) => branchIdentity(candidate) === identity);
    } else if (before.length === after.length) {
      matchIndex = beforeIndex;
    }
    if (matchIndex < 0) {
      changes.push(change(
        "union_narrowed",
        `${path}.anyOf[${beforeIndex}]`,
        branch,
        undefined,
      ));
      continue;
    }
    matchedAfter.add(matchIndex);
    const nested = compareSchemas(branch, after[matchIndex]!, `${path}.anyOf[${beforeIndex}]`);
    changes.push(...(nested.length > 0
      ? nested
      : [change("union_narrowed", `${path}.anyOf[${beforeIndex}]`, branch, after[matchIndex])]));
  }

  if (
    after.some((_, index) => !matchedAfter.has(index))
    && previous["x-extensible-union"] !== true
  ) {
    changes.push(change(
      "union_growth_not_extensible",
      `${path}.anyOf`,
      previous.anyOf,
      current.anyOf,
    ));
  }
  return changes;
}

export function compareSchemas(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path = "$",
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  if (typeNarrows(previous.type, current.type)) {
    changes.push(change("type_changed", path, previous.type, current.type));
  }
  if (current.const !== undefined && !sameJson(current.const, previous.const)) {
    changes.push(change("const_changed", `${path}.const`, previous.const, current.const));
  }
  if (current.$ref !== undefined && !sameJson(current.$ref, previous.$ref)) {
    changes.push(change("reference_changed", `${path}.$ref`, previous.$ref, current.$ref));
  }

  if (isLowerBoundTighter(previous, current)) {
    changes.push(change(
      "lower_bound_tightened",
      `${path}.${current.exclusiveMinimum === undefined ? "minimum" : "exclusiveMinimum"}`,
      lowerBound(previous),
      lowerBound(current),
    ));
  }
  if (isUpperBoundTighter(previous, current)) {
    changes.push(change(
      "upper_bound_tightened",
      `${path}.${current.exclusiveMaximum === undefined ? "maximum" : "exclusiveMaximum"}`,
      upperBound(previous),
      upperBound(current),
    ));
  }
  if (current.multipleOf !== undefined && !sameJson(previous.multipleOf, current.multipleOf)) {
    changes.push(change("multiple_of_changed", `${path}.multipleOf`, previous.multipleOf, current.multipleOf));
  }
  if (isMinimumIncreased(previous.minLength, current.minLength)) {
    changes.push(change("min_length_increased", `${path}.minLength`, previous.minLength, current.minLength));
  }
  if (isMaximumDecreased(previous.maxLength, current.maxLength)) {
    changes.push(change("max_length_decreased", `${path}.maxLength`, previous.maxLength, current.maxLength));
  }
  if (current.pattern !== undefined && !sameJson(previous.pattern, current.pattern)) {
    changes.push(change("pattern_changed", `${path}.pattern`, previous.pattern, current.pattern));
  }
  if (current.format !== undefined && !sameJson(previous.format, current.format)) {
    changes.push(change("format_changed", `${path}.format`, previous.format, current.format));
  }
  if (isMinimumIncreased(previous.minItems, current.minItems)) {
    changes.push(change("min_items_increased", `${path}.minItems`, previous.minItems, current.minItems));
  }
  if (isMaximumDecreased(previous.maxItems, current.maxItems)) {
    changes.push(change("max_items_decreased", `${path}.maxItems`, previous.maxItems, current.maxItems));
  }
  if (current.uniqueItems === true && previous.uniqueItems !== true) {
    changes.push(change("unique_items_enabled", `${path}.uniqueItems`, previous.uniqueItems, current.uniqueItems));
  }
  if (isMinimumIncreased(previous.minProperties, current.minProperties)) {
    changes.push(change("min_properties_increased", `${path}.minProperties`, previous.minProperties, current.minProperties));
  }
  if (isMaximumDecreased(previous.maxProperties, current.maxProperties)) {
    changes.push(change("max_properties_decreased", `${path}.maxProperties`, previous.maxProperties, current.maxProperties));
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

  changes.push(...compareSubschema(
    previous.additionalProperties,
    current.additionalProperties,
    `${path}.additionalProperties`,
    "additional_properties_restricted",
  ));
  changes.push(...compareSubschema(
    previous.items,
    current.items,
    `${path}.items`,
    "items_restricted",
  ));

  const previousEnum = Array.isArray(previous.enum) ? previous.enum : undefined;
  const currentEnum = Array.isArray(current.enum) ? current.enum : undefined;
  if (currentEnum !== undefined && (
    previousEnum === undefined
    || previousEnum.some((item) => !currentEnum.some((candidate) => sameJson(item, candidate)))
  )) {
    changes.push(change("enum_narrowed", `${path}.enum`, previous.enum, current.enum));
  }

  changes.push(...compareAnyOf(previous, current, path));

  if (current.oneOf !== undefined && !sameJson(previous.oneOf, current.oneOf)) {
    changes.push(change("one_of_changed", `${path}.oneOf`, previous.oneOf, current.oneOf));
  }
  if (current.allOf !== undefined && !sameJson(previous.allOf, current.allOf)) {
    changes.push(change("all_of_tightened", `${path}.allOf`, previous.allOf, current.allOf));
  }
  if (current.not !== undefined && !sameJson(previous.not, current.not)) {
    changes.push(change("not_changed", `${path}.not`, previous.not, current.not));
  }
  if (
    (current.if !== undefined || current.then !== undefined || current.else !== undefined)
    && (
      !sameJson(previous.if, current.if)
      || !sameJson(previous.then, current.then)
      || !sameJson(previous.else, current.else)
    )
  ) {
    changes.push(change(
      "conditional_changed",
      `${path}.if`,
      { if: previous.if, then: previous.then, else: previous.else },
      { if: current.if, then: current.then, else: current.else },
    ));
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
