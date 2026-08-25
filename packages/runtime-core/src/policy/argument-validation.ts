import { canonicalizeToolArguments } from "./canonical-json.js";

export type ReviewedInputSchema = Readonly<Record<string, unknown>>;

function invalidCatalog(): never { throw new Error("Policy MCP catalog is not permitted"); }
const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) invalidCatalog();
  if (!("value" in descriptor) || !descriptor.enumerable) invalidCatalog();
  return descriptor.value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object") invalidCatalog();
  if (Array.isArray(value)) invalidCatalog();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidCatalog();
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) invalidCatalog();
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): string[] => {
  const keys = Reflect.ownKeys(value) as string[];
  if (keys.some((key) => !allowed.includes(key))) invalidCatalog();
  for (const key of keys) own(value, key);
  return keys;
};

function finiteBound(value: unknown, integer = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) invalidCatalog();
  return value as number;
}

function normalizeSchema(value: unknown, depth = 0): ReviewedInputSchema {
  if (depth > 8) invalidCatalog();
  const input = record(value);
  const typeValue = own(input, "type");
  if (typeof typeValue !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(typeValue)) invalidCatalog();
  const type = typeValue as string;
  const common = ["type", "enum", "const"];
  const typeKeys: Record<string, readonly string[]> = {
    object: [...common, "properties", "required", "additionalProperties", "minProperties", "maxProperties"],
    array: [...common, "items", "minItems", "maxItems"],
    string: [...common, "minLength", "maxLength", "pattern"],
    number: [...common, "minimum", "maximum"], integer: [...common, "minimum", "maximum"],
    boolean: common, null: common,
  };
  exactKeys(input, typeKeys[type]!);
  const output: Record<string, unknown> = { type };
  if ("enum" in input) {
    const enumValue = own(input, "enum");
    if (!Array.isArray(enumValue)) invalidCatalog();
    const values = enumValue as unknown[];
    if (values.length < 1 || values.length > 32 || new Set(values.map((entry) => JSON.stringify(entry))).size !== values.length) invalidCatalog();
    if (values.some((entry) => entry !== null && !["string", "number", "boolean"].includes(typeof entry))) invalidCatalog();
    output.enum = Object.freeze([...values]);
  }
  if ("const" in input) {
    const constant = own(input, "const");
    if (constant !== null && !["string", "number", "boolean"].includes(typeof constant)) invalidCatalog();
    output.const = constant;
  }
  if (type === "object") {
    if (own(input, "additionalProperties") !== false) invalidCatalog();
    const properties = record(own(input, "properties"));
    const propertyNames = (Reflect.ownKeys(properties) as string[]).sort();
    if (propertyNames.length > 32 || propertyNames.some((name) => !/^[a-z][a-z0-9_]{0,63}$/u.test(name))) invalidCatalog();
    const normalizedProperties: Record<string, unknown> = Object.create(null);
    for (const name of propertyNames) normalizedProperties[name] = normalizeSchema(own(properties, name), depth + 1);
    const requiredValue = "required" in input ? own(input, "required") : [];
    if (!Array.isArray(requiredValue) || requiredValue.some((name) => typeof name !== "string") || new Set(requiredValue).size !== requiredValue.length || requiredValue.some((name) => !propertyNames.includes(name))) invalidCatalog();
    output.additionalProperties = false;
    output.properties = Object.freeze(normalizedProperties);
    output.required = Object.freeze([...(requiredValue as string[])].sort());
    const minimum = finiteBound(input.minProperties, true); const maximum = finiteBound(input.maxProperties, true);
    if (minimum !== undefined) output.minProperties = minimum;
    if (maximum !== undefined) output.maxProperties = maximum;
  } else if (type === "array") {
    output.items = normalizeSchema(own(input, "items"), depth + 1);
    const minimum = finiteBound(input.minItems, true); const maximum = finiteBound(input.maxItems, true);
    if (minimum !== undefined) output.minItems = minimum;
    if (maximum !== undefined) output.maxItems = maximum;
  } else if (type === "string") {
    const minimum = finiteBound(input.minLength, true); const maximum = finiteBound(input.maxLength, true);
    if (minimum !== undefined) output.minLength = minimum;
    if (maximum !== undefined) output.maxLength = maximum;
    if (input.pattern !== undefined) {
      if (typeof input.pattern !== "string" || input.pattern.length > 128) invalidCatalog();
      const pattern = input.pattern as string;
      try { new RegExp(pattern, "u"); } catch { invalidCatalog(); }
      output.pattern = pattern;
    }
  } else if (type === "number" || type === "integer") {
    const minimum = finiteBound(input.minimum); const maximum = finiteBound(input.maximum);
    if (minimum !== undefined) output.minimum = minimum;
    if (maximum !== undefined) output.maximum = maximum;
  }
  const minimum = output.minimum ?? output.minLength ?? output.minItems ?? output.minProperties;
  const maximum = output.maximum ?? output.maxLength ?? output.maxItems ?? output.maxProperties;
  if (typeof minimum === "number" && minimum < 0 && type !== "number" && type !== "integer") invalidCatalog();
  if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) invalidCatalog();
  return Object.freeze(output);
}

export function validateReviewedInputSchema(value: unknown): ReviewedInputSchema {
  const schema = normalizeSchema(value);
  if (schema.type !== "object") invalidCatalog();
  return schema;
}

function matches(value: unknown, schema: ReviewedInputSchema): boolean {
  if (schema.const !== undefined && !Object.is(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string"
      && value.length >= (schema.minLength as number | undefined ?? 0)
      && value.length <= (schema.maxLength as number | undefined ?? Number.MAX_SAFE_INTEGER)
      && (schema.pattern === undefined || new RegExp(schema.pattern as string, "u").test(value));
    case "number": case "integer": return typeof value === "number" && Number.isFinite(value)
      && (schema.type !== "integer" || Number.isSafeInteger(value))
      && value >= (schema.minimum as number | undefined ?? -Infinity)
      && value <= (schema.maximum as number | undefined ?? Infinity);
    case "array": return Array.isArray(value)
      && value.length >= (schema.minItems as number | undefined ?? 0)
      && value.length <= (schema.maxItems as number | undefined ?? 128)
      && value.every((entry) => matches(entry, schema.items as ReviewedInputSchema));
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      const properties = schema.properties as Record<string, ReviewedInputSchema>;
      const required = schema.required as readonly string[];
      return keys.length >= (schema.minProperties as number | undefined ?? 0)
        && keys.length <= (schema.maxProperties as number | undefined ?? 128)
        && keys.every((key) => Object.hasOwn(properties, key))
        && required.every((key) => Object.hasOwn(value, key))
        && keys.every((key) => matches((value as Record<string, unknown>)[key], properties[key]!));
    }
    default: return false;
  }
}

export function argumentsMatchReviewedSchema(argumentsValue: unknown, schema: ReviewedInputSchema): boolean {
  try { return matches(canonicalizeToolArguments(argumentsValue).value, schema); } catch { return false; }
}
