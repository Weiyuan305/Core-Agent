import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ContractSchemas } from "../src/registry.js";
import { CONTRACT_PACKAGE_VERSION } from "../src/index.js";

type JsonSchema = boolean | Record<string, unknown>;

export interface ReleaseVersionAuthorities {
  packageJsonVersion: string;
  exportedPackageVersion: string;
  compatibilityChangeVersion: string;
}

interface SnapshotPublicationOptions {
  copySchemaFile?: (source: string, destination: string) => Promise<void>;
  beforeSnapshotCommit?: (stagingDirectory: string) => Promise<void>;
}

interface ReleaseAcceptanceOptions extends SnapshotPublicationOptions {
  versionAuthorities?: ReleaseVersionAuthorities;
}

export interface BreakingChange {
  kind:
    | "property_removed"
    | "property_added_restricts_open_object"
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
    | "contains_restricted"
    | "contains_match_set_changed"
    | "min_contains_increased"
    | "max_contains_decreased"
    | "prefix_items_restricted"
    | "unevaluated_items_restricted"
    | "min_properties_increased"
    | "max_properties_decreased"
    | "additional_properties_restricted"
    | "pattern_properties_changed"
    | "property_names_restricted"
    | "dependent_required_added"
    | "dependent_schema_restricted"
    | "unevaluated_properties_restricted"
    | "unevaluated_items_evaluation_changed"
    | "unevaluated_properties_evaluation_changed"
    | "one_of_changed"
    | "all_of_tightened"
    | "not_changed"
    | "conditional_changed"
    | "reference_changed"
    | "definition_removed"
    | "schema_id_changed"
    | "schema_dialect_changed"
    | "boolean_schema_restricted"
    | "unsupported_assertion_changed";
  path: string;
  before?: unknown;
  after?: unknown;
}

const annotationKeywords = new Set([
  "$comment",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

const handledKeywords = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependentRequired",
  "dependentSchemas",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "then",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "x-extensible-union",
]);

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isSchemaObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareAscii)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSchemaSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const before = left.map(canonicalJson).sort(compareAscii);
  const after = right.map(canonicalJson).sort(compareAscii);
  return before.every((item, index) => item === after[index]);
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

function isMinimumIncreased(previous: unknown, current: unknown, defaultValue = 0): boolean {
  const after = finiteNumber(current);
  if (after === undefined) return false;
  return after > (finiteNumber(previous) ?? defaultValue);
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
  if (current === undefined || sameJson(previous, current)) return false;
  if (previous === undefined) return true;
  const before = normalizedTypes(previous);
  const after = normalizedTypes(current);
  if (before === undefined || after === undefined) return true;
  return [...before].some((item) => !after.has(item) && !(item === "integer" && after.has("number")));
}

function multipleOfNarrows(previous: unknown, current: unknown): boolean {
  if (current === undefined || sameJson(previous, current)) return false;
  const before = finiteNumber(previous);
  const after = finiteNumber(current);
  if (before === undefined || after === undefined || before <= 0 || after <= 0) return true;
  const ratio = before / after;
  return Math.abs(ratio - Math.round(ratio)) > Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isSchemaObject(value);
}

function isEmptySchema(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => (
    annotationKeywords.has(key) || key === "x-extensible-union"
  ));
}

function compareSubschema(
  previous: unknown,
  current: unknown,
  path: string,
  restrictionKind: BreakingChange["kind"],
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
    const unknownChanges = compareUnknownKeywords({}, current, path);
    if (unknownChanges.length > 0) return unknownChanges;
    return isEmptySchema(current) ? [] : [change(restrictionKind, path, previous, current)];
  }
  if (!isSchemaObject(previous)) {
    return sameJson(previous, current) ? [] : [change(restrictionKind, path, previous, current)];
  }
  return compareSchemas(previous, current, path);
}

function branchIdentity(schema: JsonSchema): string | undefined {
  if (!isSchemaObject(schema)) return undefined;
  if (typeof schema.$id === "string") return `$id:${schema.$id}`;
  if (schema.const !== undefined) return `const:${canonicalJson(schema.const)}`;
  const properties = isSchemaObject(schema.properties) ? schema.properties : undefined;
  const eventType = properties?.event_type;
  if (isSchemaObject(eventType)) {
    if (eventType.const !== undefined) return `event_type:${canonicalJson(eventType.const)}`;
    if (Array.isArray(eventType.anyOf)) {
      const values = eventType.anyOf
        .filter(isSchemaObject)
        .map((branch) => branch.const)
        .filter((value) => value !== undefined);
      if (values.length === eventType.anyOf.length) {
        return `event_type_union:${canonicalJson(values)}`;
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
  const before = Array.isArray(previous.anyOf) && previous.anyOf.every(isJsonSchema)
    ? previous.anyOf
    : undefined;
  const after = Array.isArray(current.anyOf) && current.anyOf.every(isJsonSchema)
    ? current.anyOf
    : undefined;
  if (after === undefined || after.includes(true) || sameSchemaSet(before, after)) return [];
  if (
    before !== undefined
    && sameSchemaSet(
      before.filter((branch) => branch !== false),
      after.filter((branch) => branch !== false),
    )
  ) return [];
  if (before === undefined) {
    return after.includes(true)
      ? []
      : [change("union_narrowed", `${path}.anyOf`, previous.anyOf, current.anyOf)];
  }

  const changes: BreakingChange[] = [];
  const matchedAfter = new Set<number>();
  for (const [beforeIndex, branch] of before.entries()) {
    let matchIndex = after.findIndex((candidate, index) => (
      !matchedAfter.has(index)
      && compareSchemas(branch, candidate, `${path}.anyOf[${beforeIndex}]`).length === 0
    ));
    if (matchIndex >= 0) {
      matchedAfter.add(matchIndex);
      continue;
    }

    const identity = branchIdentity(branch);
    if (identity !== undefined) {
      matchIndex = after.findIndex((candidate, index) => (
        !matchedAfter.has(index) && branchIdentity(candidate) === identity
      ));
    } else if (before.length === after.length && !matchedAfter.has(beforeIndex)) {
      matchIndex = beforeIndex;
    }
    if (matchIndex < 0) {
      changes.push(change("union_narrowed", `${path}.anyOf[${beforeIndex}]`, branch, undefined));
      continue;
    }
    matchedAfter.add(matchIndex);
    const nested = compareSchemas(branch, after[matchIndex]!, `${path}.anyOf[${beforeIndex}]`);
    changes.push(...(nested.length > 0
      ? nested
      : [change("union_narrowed", `${path}.anyOf[${beforeIndex}]`, branch, after[matchIndex])]));
  }

  if (after.some((_, index) => !matchedAfter.has(index)) && previous["x-extensible-union"] !== true) {
    changes.push(change("union_growth_not_extensible", `${path}.anyOf`, previous.anyOf, current.anyOf));
  }
  return changes;
}

function compareDefinitions(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const before = isSchemaObject(previous.$defs) ? previous.$defs : {};
  const after = isSchemaObject(current.$defs) ? current.$defs : {};
  const changes: BreakingChange[] = [];
  for (const key of Object.keys(before).sort(compareAscii)) {
    const definitionPath = `${path}.$defs.${key}`;
    if (!(key in after)) {
      changes.push(change("definition_removed", definitionPath, before[key], undefined));
    } else if (isJsonSchema(before[key]) && isJsonSchema(after[key])) {
      changes.push(...compareSchemas(before[key], after[key], definitionPath));
    } else if (!sameJson(before[key], after[key])) {
      changes.push(change("unsupported_assertion_changed", definitionPath, before[key], after[key]));
    }
  }
  return changes;
}

function comparePatternProperties(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  if (sameJson(previous.patternProperties, current.patternProperties)) return [];
  return [change(
    "pattern_properties_changed",
    `${path}.patternProperties`,
    previous.patternProperties,
    current.patternProperties,
  )];
}

function matchingPatternSchemas(schema: Record<string, unknown>, propertyName: string): unknown[] {
  if (!isSchemaObject(schema.patternProperties)) return [];
  return Object.keys(schema.patternProperties)
    .sort(compareAscii)
    .filter((pattern) => {
      try {
        return new RegExp(pattern).test(propertyName);
      } catch {
        return true;
      }
    })
    .map((pattern) => (schema.patternProperties as Record<string, unknown>)[pattern]);
}

function compareDependentRequired(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const before = isSchemaObject(previous.dependentRequired) ? previous.dependentRequired : {};
  const after = isSchemaObject(current.dependentRequired) ? current.dependentRequired : {};
  const changes: BreakingChange[] = [];
  for (const key of Object.keys(after).sort(compareAscii)) {
    const beforeNames = new Set(Array.isArray(before[key]) ? before[key] as string[] : []);
    const afterNames = Array.isArray(after[key]) ? after[key] as string[] : [];
    for (const name of [...afterNames].sort(compareAscii)) {
      if (!beforeNames.has(name)) {
        changes.push(change(
          "dependent_required_added",
          `${path}.dependentRequired.${key}.${name}`,
          before[key],
          after[key],
        ));
      }
    }
  }
  return changes;
}

function compareDependentSchemas(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const before = isSchemaObject(previous.dependentSchemas) ? previous.dependentSchemas : {};
  const after = isSchemaObject(current.dependentSchemas) ? current.dependentSchemas : {};
  const changes: BreakingChange[] = [];
  for (const key of Object.keys(after).sort(compareAscii)) {
    const dependencyPath = `${path}.dependentSchemas.${key}`;
    if (!(key in before)) {
      if (after[key] !== true && !(isSchemaObject(after[key]) && isEmptySchema(after[key]))) {
        changes.push(change("dependent_schema_restricted", dependencyPath, undefined, after[key]));
      }
    } else {
      changes.push(...compareSubschema(
        before[key],
        after[key],
        dependencyPath,
        "dependent_schema_restricted",
      ));
    }
  }
  return changes;
}

function comparePrefixItems(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const before = Array.isArray(previous.prefixItems) ? previous.prefixItems : [];
  const after = Array.isArray(current.prefixItems) ? current.prefixItems : [];
  const changes: BreakingChange[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const beforeSchema = before[index] ?? previous.items;
    const afterSchema = after[index] ?? current.items;
    changes.push(...compareSubschema(
      beforeSchema,
      afterSchema,
      `${path}.prefixItems[${index}]`,
      "prefix_items_restricted",
    ));
  }
  return changes;
}

function compareUnknownKeywords(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...keys]
    .sort(compareAscii)
    .filter((key) => (
      !handledKeywords.has(key)
      && !annotationKeywords.has(key)
      && !sameJson(previous[key], current[key])
    ))
    .map((key) => change(
      "unsupported_assertion_changed",
      `${path}.${key}`,
      previous[key],
      current[key],
    ));
}

function compareSchemaMetadata(
  previous: JsonSchema,
  current: JsonSchema,
  path: string,
): BreakingChange[] {
  const before = isSchemaObject(previous) ? previous : {};
  const after = isSchemaObject(current) ? current : {};
  const changes: BreakingChange[] = [];
  if (!sameJson(before.$id, after.$id)) {
    changes.push(change("schema_id_changed", `${path}.$id`, before.$id, after.$id));
  }
  if (!sameJson(before.$schema, after.$schema)) {
    changes.push(change("schema_dialect_changed", `${path}.$schema`, before.$schema, after.$schema));
  }
  return changes;
}

function isRestrictiveUnevaluated(value: unknown): boolean {
  return value !== undefined
    && value !== true
    && !(isSchemaObject(value) && isEmptySchema(value));
}

function hasRemovedMapEntry(previous: unknown, current: unknown): boolean {
  const before = isSchemaObject(previous) ? previous : {};
  const after = isSchemaObject(current) ? current : {};
  return Object.keys(before).some((key) => !(key in after));
}

function anyKeywordChanged(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  keywords: readonly string[],
): boolean {
  return keywords.some((keyword) => !sameJson(previous[keyword], current[keyword]));
}

function compareEvaluationAnnotations(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
  path: string,
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  if (
    sameJson(previous.unevaluatedProperties, current.unevaluatedProperties)
    && isRestrictiveUnevaluated(current.unevaluatedProperties)
    && (
      hasRemovedMapEntry(previous.properties, current.properties)
      || anyKeywordChanged(previous, current, [
        "$defs",
        "$ref",
        "additionalProperties",
        "allOf",
        "anyOf",
        "dependentSchemas",
        "else",
        "if",
        "oneOf",
        "patternProperties",
        "then",
      ])
    )
  ) {
    changes.push(change(
      "unevaluated_properties_evaluation_changed",
      `${path}.unevaluatedProperties`,
      previous.unevaluatedProperties,
      current.unevaluatedProperties,
    ));
  }
  if (
    sameJson(previous.unevaluatedItems, current.unevaluatedItems)
    && isRestrictiveUnevaluated(current.unevaluatedItems)
    && anyKeywordChanged(previous, current, [
      "$defs",
      "$ref",
      "allOf",
      "anyOf",
      "contains",
      "else",
      "if",
      "items",
      "oneOf",
      "prefixItems",
      "then",
    ])
  ) {
    changes.push(change(
      "unevaluated_items_evaluation_changed",
      `${path}.unevaluatedItems`,
      previous.unevaluatedItems,
      current.unevaluatedItems,
    ));
  }
  return changes;
}

export function compareSchemas(
  previous: JsonSchema,
  current: JsonSchema,
  path = "$",
): BreakingChange[] {
  if (sameJson(previous, current)) return [];
  const metadataChanges = compareSchemaMetadata(previous, current, path);
  if (current === true || previous === false) return metadataChanges;
  if (current === false) {
    return [...metadataChanges, change("boolean_schema_restricted", path, previous, current)];
  }
  if (previous === true) previous = {};

  const changes: BreakingChange[] = [...metadataChanges];
  changes.push(...compareEvaluationAnnotations(previous, current, path));
  if (typeNarrows(previous.type, current.type)) {
    changes.push(change("type_changed", path, previous.type, current.type));
  }
  if (current.const !== undefined && !sameJson(current.const, previous.const)) {
    changes.push(change("const_changed", `${path}.const`, previous.const, current.const));
  }
  if (current.$ref !== undefined && !sameJson(current.$ref, previous.$ref)) {
    changes.push(change("reference_changed", `${path}.$ref`, previous.$ref, current.$ref));
  }
  changes.push(...compareDefinitions(previous, current, path));

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
  if (multipleOfNarrows(previous.multipleOf, current.multipleOf)) {
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
  const currentRequired = Array.isArray(current.required) ? current.required as string[] : [];
  for (const key of [...currentRequired].sort(compareAscii)) {
    if (!previousRequired.has(key)) {
      changes.push(change("required_added", `${path}.required.${key}`, previous.required, current.required));
    }
  }

  const previousProperties = isSchemaObject(previous.properties) ? previous.properties : {};
  const currentProperties = isSchemaObject(current.properties) ? current.properties : {};
  for (const key of Object.keys(previousProperties).sort(compareAscii)) {
    const propertyPath = `${path}.properties.${key}`;
    if (!(key in currentProperties)) {
      const currentFallback = current.additionalProperties;
      const currentPatterns = matchingPatternSchemas(current, key);
      if (
        (currentFallback === false && currentPatterns.length === 0)
        || currentPatterns.some((patternSchema) => (
          compareSubschema(previousProperties[key], patternSchema, propertyPath, "property_removed").length > 0
        ))
        || (isSchemaObject(currentFallback)
          && compareSubschema(previousProperties[key], currentFallback, propertyPath, "property_removed").length > 0)
      ) {
        changes.push(change("property_removed", propertyPath, previousProperties[key], undefined));
      }
    } else if (isJsonSchema(previousProperties[key]) && isJsonSchema(currentProperties[key])) {
      changes.push(...compareSchemas(previousProperties[key], currentProperties[key], propertyPath));
    }
  }
  for (const key of Object.keys(currentProperties).sort(compareAscii)) {
    if (key in previousProperties) continue;
    const previousFallback = previous.additionalProperties;
    const previousPatterns = matchingPatternSchemas(previous, key);
    const repeatsMatchingPattern = previousPatterns.some((patternSchema) => (
      sameJson(patternSchema, currentProperties[key])
    ));
    if (
      (previousPatterns.length > 0 && !repeatsMatchingPattern && compareSubschema(
        true,
        currentProperties[key],
        `${path}.properties.${key}`,
        "property_added_restricts_open_object",
      ).length > 0)
      || (previousPatterns.length === 0
        && previousFallback !== false
        && compareSubschema(
          previousFallback,
          currentProperties[key],
          `${path}.properties.${key}`,
          "property_added_restricts_open_object",
        ).length > 0)
    ) {
      changes.push(change(
        "property_added_restricts_open_object",
        `${path}.properties.${key}`,
        previousFallback,
        currentProperties[key],
      ));
    }
  }

  changes.push(...comparePatternProperties(previous, current, path));
  changes.push(...compareSubschema(
    previous.additionalProperties,
    current.additionalProperties,
    `${path}.additionalProperties`,
    "additional_properties_restricted",
  ));
  changes.push(...compareSubschema(
    previous.propertyNames,
    current.propertyNames,
    `${path}.propertyNames`,
    "property_names_restricted",
  ));
  changes.push(...compareDependentRequired(previous, current, path));
  changes.push(...compareDependentSchemas(previous, current, path));
  changes.push(...compareSubschema(
    previous.items,
    current.items,
    `${path}.items`,
    "items_restricted",
  ));
  changes.push(...comparePrefixItems(previous, current, path));

  if (previous.contains === undefined && current.contains !== undefined) {
    if (current.minContains !== 0) {
      changes.push(change("contains_restricted", `${path}.contains`, previous.contains, current.contains));
    } else if (finiteNumber(current.maxContains) !== undefined) {
      changes.push(change(
        "max_contains_decreased",
        `${path}.maxContains`,
        previous.maxContains,
        current.maxContains,
      ));
    }
  } else if (previous.contains !== undefined && current.contains !== undefined) {
    changes.push(...compareSubschema(
      previous.contains,
      current.contains,
      `${path}.contains`,
      "contains_restricted",
    ));
    if (
      !sameJson(previous.contains, current.contains)
      && finiteNumber(current.maxContains) !== undefined
    ) {
      changes.push(change(
        "contains_match_set_changed",
        `${path}.contains`,
        previous.contains,
        current.contains,
      ));
    }
  }
  if (
    current.contains !== undefined
    && previous.contains !== undefined
    && (finiteNumber(current.minContains) ?? 1) > (finiteNumber(previous.minContains) ?? 1)
  ) {
    changes.push(change("min_contains_increased", `${path}.minContains`, previous.minContains, current.minContains));
  }
  if (
    current.contains !== undefined
    && previous.contains !== undefined
    && isMaximumDecreased(previous.maxContains, current.maxContains)
  ) {
    changes.push(change("max_contains_decreased", `${path}.maxContains`, previous.maxContains, current.maxContains));
  }
  changes.push(...compareSubschema(
    previous.unevaluatedItems,
    current.unevaluatedItems,
    `${path}.unevaluatedItems`,
    "unevaluated_items_restricted",
  ));
  changes.push(...compareSubschema(
    previous.unevaluatedProperties,
    current.unevaluatedProperties,
    `${path}.unevaluatedProperties`,
    "unevaluated_properties_restricted",
  ));

  const previousEnum = Array.isArray(previous.enum) ? previous.enum : undefined;
  const currentEnum = Array.isArray(current.enum) ? current.enum : undefined;
  if (currentEnum !== undefined && (
    (previousEnum === undefined
      && previous.const === undefined)
    || (previous.const !== undefined
      && !currentEnum.some((candidate) => sameJson(previous.const, candidate)))
    || (previousEnum !== undefined
      && previousEnum.some((item) => !currentEnum.some((candidate) => sameJson(item, candidate))))
  )) {
    changes.push(change("enum_narrowed", `${path}.enum`, previous.enum, current.enum));
  }

  changes.push(...compareAnyOf(previous, current, path));
  if (current.oneOf !== undefined && !sameSchemaSet(previous.oneOf, current.oneOf)) {
    changes.push(change("one_of_changed", `${path}.oneOf`, previous.oneOf, current.oneOf));
  }
  if (current.allOf !== undefined && !sameSchemaSet(previous.allOf, current.allOf)) {
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
  changes.push(...compareUnknownKeywords(previous, current, path));
  return changes;
}

const expectedSchemaFiles = Object.keys(ContractSchemas)
  .map((key) => `${key}.schema.json`)
  .sort(compareAscii);

async function schemaManifestFailures(
  directory: string,
  label: string,
  allowReleasesDirectory = false,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const actual = new Map(entries.map((entry) => [entry.name, entry]));
  const expected = new Set(expectedSchemaFiles);
  const failures: string[] = [];

  for (const fileName of expectedSchemaFiles) {
    const entry = actual.get(fileName);
    if (entry === undefined) failures.push(`${label} ${fileName}: missing`);
    else if (!entry.isFile()) failures.push(`${label} ${fileName}: not a file`);
  }
  for (const entry of entries.sort((left, right) => compareAscii(left.name, right.name))) {
    if (expected.has(entry.name)) continue;
    if (allowReleasesDirectory && entry.name === "releases" && entry.isDirectory()) continue;
    failures.push(`${label} ${entry.name}: unexpected`);
  }
  return failures;
}

interface ReleaseSnapshot {
  version: string;
  directory: string;
}

async function discoverReleaseSnapshots(
  compatibilityDirectory: string,
): Promise<{ snapshots: ReleaseSnapshot[]; failures: string[] }> {
  const releasesDirectory = resolve(compatibilityDirectory, "releases");
  let entries;
  try {
    entries = await readdir(releasesDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { snapshots: [], failures: [] };
    return {
      snapshots: [],
      failures: [`unable to read releases directory: ${errorCode(error) ?? "unknown error"}`],
    };
  }
  const snapshots: ReleaseSnapshot[] = [];
  const failures: string[] = [];
  for (const entry of entries.sort((left, right) => compareAscii(left.name, right.name))) {
    if (!entry.isDirectory()) {
      failures.push(`release ${entry.name}: unexpected non-directory entry`);
      continue;
    }
    if (!validPackageVersion(entry.name)) {
      failures.push(`release ${entry.name}: invalid package version directory`);
      continue;
    }
    const directory = resolve(releasesDirectory, entry.name);
    snapshots.push({ version: entry.name, directory });
    failures.push(...await schemaManifestFailures(directory, `release ${entry.name} schema manifest`));
  }
  return { snapshots, failures };
}

function errorCode(error: unknown): string | undefined {
  return isSchemaObject(error) && typeof error.code === "string" ? error.code : undefined;
}

async function targetExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function assertOwnedStagingDirectory(
  stagingDirectory: string,
  parentDirectory: string,
  stagingPrefix: string,
): void {
  const stagingName = basename(stagingDirectory);
  if (
    dirname(stagingDirectory) !== parentDirectory
    || !stagingName.startsWith(stagingPrefix)
    || stagingName.length <= stagingPrefix.length
  ) {
    throw new Error(`Refusing unsafe staging cleanup target: ${stagingDirectory}`);
  }
}

async function verifyStagedSnapshot(
  sourceDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  const manifestFailures = await schemaManifestFailures(stagingDirectory, "staged schema manifest");
  if (manifestFailures.length > 0) {
    throw new Error(`Staged schema manifest mismatch:\n${manifestFailures.join("\n")}`);
  }
  for (const fileName of expectedSchemaFiles) {
    const source = await readFile(resolve(sourceDirectory, fileName), "utf8");
    const staged = await readFile(resolve(stagingDirectory, fileName), "utf8");
    if (source !== staged) throw new Error(`Staged schema content mismatch: ${fileName}`);
    try {
      JSON.parse(staged);
    } catch {
      throw new Error(`Staged schema is not valid JSON: ${fileName}`);
    }
  }
}

async function publishExactSnapshot(
  sourceDirectory: string,
  targetDirectory: string,
  refusalMessage: string,
  options: SnapshotPublicationOptions,
): Promise<number> {
  if (await targetExists(targetDirectory)) throw new Error(refusalMessage);
  const parentDirectory = dirname(targetDirectory);
  const stagingPrefix = `.${basename(targetDirectory)}.staging-`;
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(resolve(parentDirectory, stagingPrefix));
  assertOwnedStagingDirectory(stagingDirectory, parentDirectory, stagingPrefix);
  let committed = false;
  try {
    const copySchemaFile = options.copySchemaFile ?? copyFile;
    for (const fileName of expectedSchemaFiles) {
      await copySchemaFile(
        resolve(sourceDirectory, fileName),
        resolve(stagingDirectory, fileName),
      );
    }
    await verifyStagedSnapshot(sourceDirectory, stagingDirectory);
    await options.beforeSnapshotCommit?.(stagingDirectory);
    try {
      await rename(stagingDirectory, targetDirectory);
    } catch (error: unknown) {
      if (["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) {
        throw new Error(refusalMessage);
      }
      throw error;
    }
    committed = true;
    return expectedSchemaFiles.length;
  } finally {
    if (!committed) {
      assertOwnedStagingDirectory(stagingDirectory, parentDirectory, stagingPrefix);
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

export async function acceptInitialV1Baseline(
  schemaDirectory: string,
  compatibilityDirectory: string,
  options: SnapshotPublicationOptions = {},
): Promise<number> {
  const schemaFailures = await schemaManifestFailures(schemaDirectory, "generated schema manifest");
  if (schemaFailures.length > 0) {
    throw new Error(`Generated schema manifest mismatch:\n${schemaFailures.join("\n")}`);
  }

  return publishExactSnapshot(
    schemaDirectory,
    compatibilityDirectory,
    "Initial v1 compatibility baseline already exists; refusing to overwrite it",
    options,
  );
}

async function compareSnapshot(
  schemaDirectory: string,
  snapshotDirectory: string,
  label: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const fileName of expectedSchemaFiles) {
    let previous: JsonSchema;
    let current: JsonSchema;
    try {
      previous = JSON.parse(await readFile(resolve(snapshotDirectory, fileName), "utf8")) as JsonSchema;
      current = JSON.parse(await readFile(resolve(schemaDirectory, fileName), "utf8")) as JsonSchema;
    } catch {
      failures.push(`${label} ${fileName}: unreadable schema`);
      continue;
    }
    for (const schemaChange of compareSchemas(previous, current)) {
      failures.push(`${label} ${fileName}: ${schemaChange.kind} at ${schemaChange.path}`);
    }
  }
  return failures;
}

export async function checkCompatibilityDirectories(
  schemaDirectory: string,
  compatibilityDirectory: string,
): Promise<string[]> {
  const releases = await discoverReleaseSnapshots(compatibilityDirectory);
  const manifestFailures = [
    ...await schemaManifestFailures(schemaDirectory, "generated schema manifest"),
    ...await schemaManifestFailures(compatibilityDirectory, "compatibility schema manifest", true),
    ...releases.failures,
  ];
  if (manifestFailures.length > 0) return manifestFailures;

  const failures = await compareSnapshot(schemaDirectory, compatibilityDirectory, "initial v1");
  for (const snapshot of releases.snapshots) {
    failures.push(...await compareSnapshot(
      schemaDirectory,
      snapshot.directory,
      `release ${snapshot.version}`,
    ));
  }
  return failures;
}

function validPackageVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version);
}

async function loadReleaseVersionAuthorities(): Promise<ReleaseVersionAuthorities> {
  const root = resolve(import.meta.dirname, "..");
  const packageDocument = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ) as { version?: unknown };
  const compatibilityChange = JSON.parse(
    await readFile(resolve(root, "compatibility-change.json"), "utf8"),
  ) as { package_version?: unknown };
  if (
    typeof packageDocument.version !== "string"
    || typeof compatibilityChange.package_version !== "string"
  ) {
    throw new Error("Release version authorities must contain string package versions");
  }
  return {
    packageJsonVersion: packageDocument.version,
    exportedPackageVersion: CONTRACT_PACKAGE_VERSION,
    compatibilityChangeVersion: compatibilityChange.package_version,
  };
}

function assertReleaseVersionAuthorities(
  requestedVersion: string,
  authorities: ReleaseVersionAuthorities,
): void {
  const versions = [
    authorities.packageJsonVersion,
    authorities.exportedPackageVersion,
    authorities.compatibilityChangeVersion,
  ];
  if (!versions.every((version) => version === versions[0])) {
    throw new Error(
      "Release version authorities disagree: "
      + `package.json=${authorities.packageJsonVersion}, `
      + `CONTRACT_PACKAGE_VERSION=${authorities.exportedPackageVersion}, `
      + `compatibility-change.json=${authorities.compatibilityChangeVersion}`,
    );
  }
  if (requestedVersion !== versions[0]) {
    throw new Error(
      `Release version ${requestedVersion} does not match package version authority ${versions[0]}`,
    );
  }
}

export async function acceptV1Release(
  schemaDirectory: string,
  compatibilityDirectory: string,
  packageVersion: string,
  options: ReleaseAcceptanceOptions = {},
): Promise<number> {
  if (!validPackageVersion(packageVersion)) {
    throw new Error(`Invalid package version for v1 release snapshot: ${packageVersion}`);
  }
  const authorities = options.versionAuthorities ?? await loadReleaseVersionAuthorities();
  assertReleaseVersionAuthorities(packageVersion, authorities);
  const releasesDirectory = resolve(compatibilityDirectory, "releases");
  const releaseDirectory = resolve(releasesDirectory, packageVersion);
  if (await targetExists(releaseDirectory)) {
    throw new Error(`V1 release ${packageVersion} already exists; refusing to overwrite it`);
  }
  const failures = await checkCompatibilityDirectories(schemaDirectory, compatibilityDirectory);
  if (failures.length > 0) {
    throw new Error(`Compatibility check failed; release snapshot was not accepted:\n${failures.join("\n")}`);
  }

  return publishExactSnapshot(
    schemaDirectory,
    releaseDirectory,
    `V1 release ${packageVersion} already exists; refusing to overwrite it`,
    options,
  );
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const schemaDirectory = resolve(root, "schemas/v1");
  const compatibilityDirectory = resolve(root, "compat/v1");
  const args = process.argv.slice(2);

  if (args.includes("--accept-initial-v1")) {
    if (args.length !== 1) throw new Error("--accept-initial-v1 does not accept other arguments");
    const count = await acceptInitialV1Baseline(schemaDirectory, compatibilityDirectory);
    console.log(`Accepted ${count} initial v1 compatibility baselines`);
    return;
  }

  const releaseArgument = args.indexOf("--accept-v1-release");
  if (releaseArgument >= 0) {
    if (args.length !== 2 || releaseArgument !== 0 || args[1] === undefined) {
      throw new Error("Usage: --accept-v1-release <package-version>");
    }
    const count = await acceptV1Release(schemaDirectory, compatibilityDirectory, args[1]);
    console.log(`Accepted ${count} v1 compatibility schemas for release ${args[1]}`);
    return;
  }
  if (args.length > 0) throw new Error(`Unknown compatibility argument: ${args[0]}`);

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
