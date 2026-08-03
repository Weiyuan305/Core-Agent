import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  acceptV1Release,
  acceptInitialV1Baseline,
  checkCompatibilityDirectories,
  compareSchemas,
  type ReleaseVersionAuthorities,
} from "../scripts/check-compatibility.js";
import { ContractSchemas } from "../src/index.js";

const expectedSchemaFiles = Object.keys(ContractSchemas).map((key) => `${key}.schema.json`);

async function writeSchemaManifest(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(expectedSchemaFiles.map((fileName) => (
    writeFile(resolve(directory, fileName), "{\n  \"type\": \"object\"\n}\n", "utf8")
  )));
}

async function writeTenantSchema(
  directory: string,
  schema: boolean | Record<string, unknown>,
): Promise<void> {
  await writeFile(
    resolve(directory, "tenant.schema.json"),
    `${JSON.stringify(schema, undefined, 2)}\n`,
    "utf8",
  );
}

function releaseAuthorities(version: string): ReleaseVersionAuthorities {
  return {
    packageJsonVersion: version,
    exportedPackageVersion: version,
    compatibilityChangeVersion: version,
  };
}

async function writeMarkedSchemaManifest(directory: string, marker: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(expectedSchemaFiles.map((fileName) => (
    writeFile(
      resolve(directory, fileName),
      `${JSON.stringify({ type: "object", title: marker }, undefined, 2)}\n`,
      "utf8",
    )
  )));
}

function assertAjvCompatibilityWitness(
  previous: boolean | Record<string, unknown>,
  current: boolean | Record<string, unknown>,
  value: unknown,
): void {
  const previousValidator = new Ajv2020({ strict: true }).compile(previous);
  const currentValidator = new Ajv2020({ strict: true }).compile(current);
  assert.equal(previousValidator(value), true, "witness must be accepted by the previous schema");
  assert.equal(currentValidator(value), false, "witness must be rejected by the current schema");
}

test("detects property removal, type change, required addition, and union narrowing", () => {
  assert.deepEqual(compareSchemas(
    { type: "object", additionalProperties: false, properties: { id: { type: "string" } } },
    { type: "object", additionalProperties: false, properties: {} },
  ).map((item) => item.kind), ["property_removed"]);
  assert.deepEqual(compareSchemas({ type: "string" }, { type: "number" }).map((item) => item.kind), ["type_changed"]);
  assert.deepEqual(compareSchemas({ type: "object", properties: { note: { type: "string" } } }, { type: "object", required: ["note"], properties: { note: { type: "string" } } }).map((item) => item.kind), ["required_added"]);
  assert.deepEqual(compareSchemas({ anyOf: [{ const: "a" }, { const: "b" }] }, { anyOf: [{ const: "a" }] }).map((item) => item.kind), ["union_narrowed"]);
});

test("detects const changes, enum narrowing, and non-extensible union growth", () => {
  assert.deepEqual(compareSchemas({ const: "a" }, { const: "b" }).map((item) => item.kind), ["const_changed"]);
  assert.deepEqual(compareSchemas({ enum: ["a", "b"] }, { enum: ["a"] }).map((item) => item.kind), ["enum_narrowed"]);
  assert.deepEqual(compareSchemas({ anyOf: [{ const: "a" }] }, { anyOf: [{ const: "a" }, { const: "b" }] }).map((item) => item.kind), ["union_growth_not_extensible"]);
});

test("detects numeric bound and multipleOf tightening", () => {
  const cases = [
    {
      previous: { type: "number", minimum: 1 },
      current: { type: "number", minimum: 2 },
      kind: "lower_bound_tightened",
    },
    {
      previous: { type: "number", minimum: 1 },
      current: { type: "number", exclusiveMinimum: 1 },
      kind: "lower_bound_tightened",
    },
    {
      previous: { type: "number", maximum: 10 },
      current: { type: "number", maximum: 9 },
      kind: "upper_bound_tightened",
    },
    {
      previous: { type: "number", maximum: 10 },
      current: { type: "number", exclusiveMaximum: 10 },
      kind: "upper_bound_tightened",
    },
    {
      previous: { type: "number", multipleOf: 2 },
      current: { type: "number", multipleOf: 4 },
      kind: "multiple_of_changed",
    },
  ] as const;

  for (const { previous, current, kind } of cases) {
    assert.deepEqual(compareSchemas(previous, current).map((item) => item.kind), [kind]);
  }
});

test("detects string constraint tightening", () => {
  const cases = [
    {
      previous: { type: "string", minLength: 1 },
      current: { type: "string", minLength: 2 },
      kind: "min_length_increased",
    },
    {
      previous: { type: "string", maxLength: 255 },
      current: { type: "string", maxLength: 64 },
      kind: "max_length_decreased",
    },
    {
      previous: { type: "string" },
      current: { type: "string", pattern: "^[a-z]+$" },
      kind: "pattern_changed",
    },
    {
      previous: { type: "string", format: "date-time" },
      current: { type: "string", format: "uuid" },
      kind: "format_changed",
    },
  ] as const;

  for (const { previous, current, kind } of cases) {
    assert.deepEqual(compareSchemas(previous, current).map((item) => item.kind), [kind]);
  }
});

test("detects array constraint and item schema tightening", () => {
  assert.deepEqual(
    compareSchemas(
      { type: "array", minItems: 0 },
      { type: "array", minItems: 1 },
    ).map((item) => item.kind),
    ["min_items_increased"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "array", maxItems: 10 },
      { type: "array", maxItems: 5 },
    ).map((item) => item.kind),
    ["max_items_decreased"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "array" },
      { type: "array", uniqueItems: true },
    ).map((item) => item.kind),
    ["unique_items_enabled"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "array", items: { type: "string", maxLength: 255 } },
      { type: "array", items: { type: "string", maxLength: 64 } },
    ).map((item) => [item.kind, item.path]),
    [["max_length_decreased", "$.items.maxLength"]],
  );
});

test("detects object constraint, closure, and property schema tightening", () => {
  assert.deepEqual(
    compareSchemas(
      { type: "object", minProperties: 0 },
      { type: "object", minProperties: 1 },
    ).map((item) => item.kind),
    ["min_properties_increased"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object", maxProperties: 10 },
      { type: "object", maxProperties: 5 },
    ).map((item) => item.kind),
    ["max_properties_decreased"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object", properties: {} },
      { type: "object", properties: {}, additionalProperties: false },
    ).map((item) => item.kind),
    ["additional_properties_restricted"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object", properties: { name: { type: "string", maxLength: 255 } } },
      { type: "object", properties: { name: { type: "string", maxLength: 64 } } },
    ).map((item) => [item.kind, item.path]),
    [["max_length_decreased", "$.properties.name.maxLength"]],
  );
});

test("conservatively detects oneOf, allOf, not, and conditional changes", () => {
  assert.deepEqual(
    compareSchemas(
      { oneOf: [{ const: "a" }, { const: "b" }] },
      { oneOf: [{ const: "a" }] },
    ).map((item) => item.kind),
    ["one_of_changed"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "string" },
      { type: "string", allOf: [{ maxLength: 64 }] },
    ).map((item) => item.kind),
    ["all_of_tightened"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "string" },
      { type: "string", not: { const: "blocked" } },
    ).map((item) => item.kind),
    ["not_changed"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object" },
      { type: "object", if: { required: ["kind"] }, then: { required: ["value"] } },
    ).map((item) => item.kind),
    ["conditional_changed"],
  );
});

test("reports all three compatibility review probes", () => {
  assert.notDeepEqual(
    compareSchemas({ type: "integer", minimum: 1 }, { type: "integer", minimum: 2 }),
    [],
  );
  assert.notDeepEqual(
    compareSchemas({ type: "string", maxLength: 255 }, { type: "string", maxLength: 64 }),
    [],
  );
  assert.notDeepEqual(
    compareSchemas(
      { type: "object", properties: {} },
      { type: "object", properties: {}, additionalProperties: false },
    ),
    [],
  );
});

test("allows supported constraint relaxation", () => {
  assert.deepEqual(
    compareSchemas(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          values: {
            type: "array",
            minItems: 2,
            maxItems: 5,
            uniqueItems: true,
            items: { type: "string", minLength: 2, maxLength: 10 },
          },
          count: { type: "number", minimum: 2, maximum: 5 },
        },
      },
      {
        type: "object",
        additionalProperties: true,
        properties: {
          values: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            uniqueItems: false,
            items: { type: "string", minLength: 1, maxLength: 11 },
          },
          count: { type: "number", minimum: 1, maximum: 6 },
        },
      },
    ),
    [],
  );
});

test("applies open and closed object property compatibility in the correct direction", () => {
  assert.deepEqual(
    compareSchemas(
      { type: "object", properties: {} },
      { type: "object", properties: { note: { type: "string" } } },
    ).map((item) => item.kind),
    ["property_added_restricts_open_object"],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object", properties: { note: { type: "string" } } },
      { type: "object", properties: {} },
    ),
    [],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object", additionalProperties: false, properties: {} },
      { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
    ),
    [],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "object", additionalProperties: false, properties: { note: { type: "string" } } },
      { type: "object", additionalProperties: false, properties: {} },
    ).map((item) => item.kind),
    ["property_removed"],
  );
  assert.deepEqual(
    compareSchemas(
      {
        type: "object",
        additionalProperties: false,
        patternProperties: { "^note$": { type: "string" } },
        properties: {},
      },
      {
        type: "object",
        additionalProperties: false,
        patternProperties: { "^note$": { type: "string" } },
        properties: { note: { type: "string", maxLength: 10 } },
      },
    ).map((item) => item.kind),
    ["property_added_restricts_open_object"],
  );
});

test("allows explicitly extensible union growth", () => {
  assert.deepEqual(compareSchemas(
    { anyOf: [{ const: "a" }], "x-extensible-union": true },
    { anyOf: [{ const: "a" }, { const: "b" }], "x-extensible-union": true },
  ), []);
  assert.deepEqual(compareSchemas(
    {
      anyOf: [{ $id: "urn:branch:a", const: "a" }],
      "x-extensible-union": true,
    },
    {
      anyOf: [
        { $id: "urn:branch:a", const: "a" },
        { $id: "urn:branch:b", const: "b" },
      ],
      "x-extensible-union": true,
    },
  ), []);
});

test("detects every advanced assertion keyword recursively", () => {
  const cases: Array<{
    name: string;
    previous: boolean | Record<string, unknown>;
    current: boolean | Record<string, unknown>;
    kind: string;
    path: string;
  }> = [
    {
      name: "unchanged ref with tightened defs",
      previous: { $defs: { Name: { type: "string", maxLength: 255 } }, $ref: "#/$defs/Name" },
      current: { $defs: { Name: { type: "string", maxLength: 64 } }, $ref: "#/$defs/Name" },
      kind: "max_length_decreased",
      path: "$.$defs.Name.maxLength",
    },
    {
      name: "patternProperties",
      previous: { type: "object" },
      current: { type: "object", patternProperties: { "^x-": { type: "string" } } },
      kind: "pattern_properties_changed",
      path: "$.patternProperties",
    },
    {
      name: "patternProperties removal can close formerly matched properties",
      previous: { type: "object", additionalProperties: false, patternProperties: { "^x-": true } },
      current: { type: "object", additionalProperties: false },
      kind: "pattern_properties_changed",
      path: "$.patternProperties",
    },
    {
      name: "propertyNames",
      previous: { type: "object" },
      current: { type: "object", propertyNames: { pattern: "^[a-z]+$" } },
      kind: "property_names_restricted",
      path: "$.propertyNames",
    },
    {
      name: "contains",
      previous: { type: "array" },
      current: { type: "array", contains: { const: "x" } },
      kind: "contains_restricted",
      path: "$.contains",
    },
    {
      name: "minContains",
      previous: { type: "array", contains: true },
      current: { type: "array", contains: true, minContains: 2 },
      kind: "min_contains_increased",
      path: "$.minContains",
    },
    {
      name: "maxContains",
      previous: { type: "array", contains: true },
      current: { type: "array", contains: true, maxContains: 2 },
      kind: "max_contains_decreased",
      path: "$.maxContains",
    },
    {
      name: "maxContains with minContains zero",
      previous: { type: "array" },
      current: { type: "array", contains: true, minContains: 0, maxContains: 2 },
      kind: "max_contains_decreased",
      path: "$.maxContains",
    },
    {
      name: "dependentRequired",
      previous: { type: "object" },
      current: { type: "object", dependentRequired: { student_id: ["case_id"] } },
      kind: "dependent_required_added",
      path: "$.dependentRequired.student_id.case_id",
    },
    {
      name: "dependentSchemas",
      previous: { type: "object" },
      current: { type: "object", dependentSchemas: { student_id: { required: ["case_id"] } } },
      kind: "dependent_schema_restricted",
      path: "$.dependentSchemas.student_id",
    },
    {
      name: "prefixItems",
      previous: { type: "array" },
      current: { type: "array", prefixItems: [{ type: "string" }] },
      kind: "prefix_items_restricted",
      path: "$.prefixItems[0]",
    },
    {
      name: "unevaluatedItems",
      previous: { type: "array" },
      current: { type: "array", unevaluatedItems: false },
      kind: "unevaluated_items_restricted",
      path: "$.unevaluatedItems",
    },
    {
      name: "unevaluatedProperties",
      previous: { type: "object" },
      current: { type: "object", unevaluatedProperties: false },
      kind: "unevaluated_properties_restricted",
      path: "$.unevaluatedProperties",
    },
    {
      name: "boolean anyOf",
      previous: { anyOf: [true] },
      current: { anyOf: [false] },
      kind: "boolean_schema_restricted",
      path: "$.anyOf[0]",
    },
  ];

  for (const { name, previous, current, kind, path } of cases) {
    assert.equal(
      compareSchemas(previous, current).some((item) => item.kind === kind && item.path === path),
      true,
      name,
    );
  }
});

test("normalizes effective minContains and protects finite maxContains composition", () => {
  const minimumCases = [
    {
      name: "object predicate",
      previous: { type: "array", contains: { const: "x" }, minContains: 0, maxContains: 10 },
      current: { type: "array", contains: { const: "x" }, maxContains: 10 },
    },
    {
      name: "boolean predicate",
      previous: { type: "array", contains: true, minContains: 0, maxContains: 10 },
      current: { type: "array", contains: true, maxContains: 10 },
    },
  ];
  for (const { name, previous, current } of minimumCases) {
    assertAjvCompatibilityWitness(previous, current, []);
    assert.equal(
      compareSchemas(previous, current).some((item) => item.kind === "min_contains_increased"),
      true,
      name,
    );
  }

  const previous = {
    type: "array",
    contains: { const: "x" },
    minContains: 0,
    maxContains: 1,
  };
  const current = {
    type: "array",
    contains: true,
    minContains: 0,
    maxContains: 1,
  };
  assertAjvCompatibilityWitness(previous, current, ["x", "y"]);
  assert.deepEqual(
    compareSchemas(previous, current).map((item) => [item.kind, item.path]),
    [["contains_match_set_changed", "$.contains"]],
  );
});

test("fails closed when evaluation annotations change under unevaluated closure", () => {
  const cases: Array<{
    name: string;
    previous: Record<string, unknown>;
    current: Record<string, unknown>;
    value: unknown;
    kind: string;
  }> = [
    {
      name: "properties removal",
      previous: { type: "object", properties: { x: true }, unevaluatedProperties: false },
      current: { type: "object", unevaluatedProperties: false },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "items removal",
      previous: { type: "array", items: true, unevaluatedItems: false },
      current: { type: "array", unevaluatedItems: false },
      value: [1],
      kind: "unevaluated_items_evaluation_changed",
    },
    {
      name: "same ref defs target property removal",
      previous: {
        type: "object",
        $defs: { Scope: { type: "object", properties: { x: true } } },
        $ref: "#/$defs/Scope",
        unevaluatedProperties: false,
      },
      current: {
        type: "object",
        $defs: { Scope: { type: "object" } },
        $ref: "#/$defs/Scope",
        unevaluatedProperties: false,
      },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "prefixItems removal",
      previous: {
        type: "array",
        prefixItems: [true],
        minItems: 1,
        maxItems: 1,
        unevaluatedItems: false,
      },
      current: { type: "array", minItems: 1, maxItems: 1, unevaluatedItems: false },
      value: [1],
      kind: "unevaluated_items_evaluation_changed",
    },
    {
      name: "dependentSchemas annotation removal",
      previous: {
        type: "object",
        properties: { flag: true },
        dependentSchemas: { flag: { type: "object", properties: { x: true } } },
        unevaluatedProperties: false,
      },
      current: {
        type: "object",
        properties: { flag: true },
        unevaluatedProperties: false,
      },
      value: { flag: true, x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "patternProperties annotation removal",
      previous: {
        type: "object",
        patternProperties: { "^x$": true },
        unevaluatedProperties: false,
      },
      current: { type: "object", unevaluatedProperties: false },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "additionalProperties annotation removal",
      previous: {
        type: "object",
        additionalProperties: true,
        unevaluatedProperties: false,
      },
      current: { type: "object", unevaluatedProperties: false },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "allOf annotation removal",
      previous: {
        type: "object",
        allOf: [{ type: "object", properties: { x: true } }],
        unevaluatedProperties: false,
      },
      current: { type: "object", unevaluatedProperties: false },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
  ];

  for (const { name, previous, current, value, kind } of cases) {
    assertAjvCompatibilityWitness(previous, current, value);
    assert.equal(
      compareSchemas(previous, current).some((item) => item.kind === kind),
      true,
      name,
    );
  }
  assert.equal(
    compareSchemas(
      { type: "array", contains: true, unevaluatedItems: false },
      { type: "array", unevaluatedItems: false },
    ).some((item) => item.kind === "unevaluated_items_evaluation_changed"),
    true,
    "contains annotation change",
  );
});

test("fails closed when annotation loss is composed with a changed restrictive unevaluated schema", () => {
  const cases: Array<{
    name: string;
    previous: Record<string, unknown>;
    current: Record<string, unknown>;
    value: unknown;
    kind: string;
  }> = [
    {
      name: "properties removal",
      previous: { type: "object", properties: { x: true }, unevaluatedProperties: false },
      current: { type: "object", unevaluatedProperties: { type: "string" } },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "items removal",
      previous: { type: "array", items: true, unevaluatedItems: false },
      current: { type: "array", unevaluatedItems: { type: "string" } },
      value: [1],
      kind: "unevaluated_items_evaluation_changed",
    },
    {
      name: "same-ref defs target annotation removal",
      previous: {
        type: "object",
        $defs: { Scope: { type: "object", properties: { x: true } } },
        $ref: "#/$defs/Scope",
        unevaluatedProperties: false,
      },
      current: {
        type: "object",
        $defs: { Scope: { type: "object" } },
        $ref: "#/$defs/Scope",
        unevaluatedProperties: { type: "string" },
      },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "prefixItems removal",
      previous: {
        type: "array",
        prefixItems: [true],
        minItems: 1,
        maxItems: 1,
        unevaluatedItems: false,
      },
      current: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        unevaluatedItems: { type: "string" },
      },
      value: [1],
      kind: "unevaluated_items_evaluation_changed",
    },
    {
      name: "dependentSchemas annotation removal",
      previous: {
        type: "object",
        properties: { flag: true },
        dependentSchemas: { flag: { type: "object", properties: { x: true } } },
        unevaluatedProperties: false,
      },
      current: {
        type: "object",
        properties: { flag: true },
        unevaluatedProperties: { type: "string" },
      },
      value: { flag: true, x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "patternProperties annotation removal",
      previous: {
        type: "object",
        patternProperties: { "^x$": true },
        unevaluatedProperties: false,
      },
      current: { type: "object", unevaluatedProperties: { type: "string" } },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
    {
      name: "additionalProperties annotation removal",
      previous: {
        type: "object",
        additionalProperties: true,
        unevaluatedProperties: false,
      },
      current: { type: "object", unevaluatedProperties: { type: "string" } },
      value: { x: 1 },
      kind: "unevaluated_properties_evaluation_changed",
    },
  ];

  for (const { name, previous, current, value, kind } of cases) {
    assertAjvCompatibilityWitness(previous, current, value);
    assert.equal(
      compareSchemas(previous, current).some((item) => item.kind === kind),
      true,
      name,
    );
  }

  assert.deepEqual(
    compareSchemas(
      { type: "object", properties: { x: true }, unevaluatedProperties: false },
      {
        type: "object",
        properties: { x: true },
        unevaluatedProperties: { type: "string" },
      },
    ),
    [],
    "changing only false to a schema is a genuine widening",
  );
});

test("compares schema resource identity and dialect at nested resource boundaries", () => {
  const changes = compareSchemas(
    {
      $id: "urn:root:before",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { Embedded: { $id: "urn:nested:before", type: "string" }, IdFree: { type: "string" } },
    },
    {
      $id: "urn:root:after",
      $schema: "https://json-schema.org/draft/2019-09/schema",
      $defs: {
        Embedded: { $id: "urn:nested:after", type: "string" },
        IdFree: { $id: "urn:new", type: "string" },
      },
    },
  );
  assert.deepEqual(
    changes.map((item) => [item.kind, item.path]),
    [
      ["schema_id_changed", "$.$id"],
      ["schema_dialect_changed", "$.$schema"],
      ["schema_id_changed", "$.$defs.Embedded.$id"],
      ["schema_id_changed", "$.$defs.IdFree.$id"],
    ],
  );
});

test("reports resource metadata before boolean widening short-circuits", () => {
  assert.deepEqual(
    compareSchemas(
      {
        $id: "urn:root",
        $schema: "https://json-schema.org/draft/2020-12/schema",
      },
      true,
    ).map((item) => [item.kind, item.path]),
    [
      ["schema_id_changed", "$.$id"],
      ["schema_dialect_changed", "$.$schema"],
    ],
  );
  assert.deepEqual(
    compareSchemas(
      { $defs: { Nested: { $id: "urn:nested", type: "string" } } },
      { $defs: { Nested: true } },
    ).map((item) => [item.kind, item.path]),
    [["schema_id_changed", "$.$defs.Nested.$id"]],
  );
});

test("reports resource metadata loss through every schema-valued boolean shortcut", () => {
  const metadata = {
    $id: "urn:embedded:resource",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "string",
  };
  const cases: Array<{
    name: string;
    previous: Record<string, unknown>;
    current: Record<string, unknown>;
    path: string;
  }> = [
    { name: "items", previous: { items: metadata }, current: { items: true }, path: "$.items" },
    {
      name: "prefixItems",
      previous: { prefixItems: [metadata] },
      current: { prefixItems: [true] },
      path: "$.prefixItems[0]",
    },
    {
      name: "dependentSchemas",
      previous: { dependentSchemas: { flag: metadata } },
      current: { dependentSchemas: { flag: true } },
      path: "$.dependentSchemas.flag",
    },
    {
      name: "additionalProperties",
      previous: { additionalProperties: metadata },
      current: { additionalProperties: true },
      path: "$.additionalProperties",
    },
    {
      name: "contains",
      previous: { contains: metadata },
      current: { contains: true },
      path: "$.contains",
    },
    {
      name: "properties removal",
      previous: { properties: { value: metadata } },
      current: {},
      path: "$.properties.value",
    },
    {
      name: "anyOf object to true",
      previous: { anyOf: [metadata] },
      current: { anyOf: [true] },
      path: "$.anyOf[0]",
    },
    {
      name: "anyOf object absent beside true",
      previous: { anyOf: [metadata, true] },
      current: { anyOf: [true] },
      path: "$.anyOf[0]",
    },
  ];

  for (const { name, previous, current, path } of cases) {
    assert.deepEqual(
      compareSchemas(previous, current)
        .filter((item) => item.kind === "schema_id_changed" || item.kind === "schema_dialect_changed")
        .map((item) => [item.kind, item.path]),
      [
        ["schema_id_changed", `${path}.$id`],
        ["schema_dialect_changed", `${path}.$schema`],
      ],
      name,
    );
  }
});

test("preserves embedded resource metadata required by an external reference", () => {
  const externalId = "urn:embedded:any-of-resource";
  const previous = {
    allOf: [{ $ref: externalId }],
    anyOf: [{ $id: externalId, type: "string" }, true],
  };
  const current = {
    allOf: [{ $ref: externalId }],
    anyOf: [true],
  };
  assert.doesNotThrow(() => new Ajv2020({ strict: true }).compile(previous));
  assert.throws(() => new Ajv2020({ strict: true }).compile(current), /can't resolve reference/);
  assert.deepEqual(
    compareSchemas(previous, current)
      .filter((item) => item.kind === "schema_id_changed")
      .map((item) => [item.kind, item.path]),
    [["schema_id_changed", "$.anyOf[0].$id"]],
  );
});

test("compares stable embedded resources even when enclosing anyOf remains true", () => {
  const externalId = "https://example.test/nested";
  const previous = {
    allOf: [{ $ref: externalId }],
    anyOf: [{ $id: externalId, type: "string" }, true],
  };
  const current = {
    allOf: [{ $ref: externalId }],
    anyOf: [{ $id: externalId, type: "string", minLength: 2 }, true],
  };
  const previousValidator = new Ajv2020({ strict: true }).compile(previous);
  const currentValidator = new Ajv2020({ strict: true }).compile(current);
  assert.equal(previousValidator("a"), true);
  assert.equal(currentValidator("a"), false);
  assert.deepEqual(
    compareSchemas(previous, current).map((item) => item.kind),
    ["min_length_increased"],
  );
});

test("matches absolute stable resources independently of path and order", () => {
  const resource = { $id: "urn:stable:moved", type: "string", minLength: 2 };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      "moved from anyOf to defs",
      { anyOf: [resource, true] },
      { $defs: { Moved: resource }, anyOf: [true] },
    ],
    [
      "reordered within anyOf",
      { anyOf: [resource, true] },
      { anyOf: [true, resource] },
    ],
    [
      "widened behind true",
      { anyOf: [resource, true] },
      { anyOf: [{ ...resource, minLength: 1 }, true] },
    ],
  ];
  for (const [name, previous, current] of cases) {
    assert.deepEqual(compareSchemas(previous, current), [], name);
  }
});

test("finds stable-resource tightening and unknown assertions through nested applicator routes", () => {
  const cases: Array<{
    name: string;
    previous: Record<string, unknown>;
    current: Record<string, unknown>;
    kind: string;
  }> = [
    {
      name: "items then anyOf",
      previous: {
        items: { anyOf: [{ $id: "urn:stable:items", type: "string" }, true] },
      },
      current: {
        items: {
          anyOf: [{ $id: "urn:stable:items", type: "string", minLength: 2 }, true],
        },
      },
      kind: "min_length_increased",
    },
    {
      name: "resource nested inside another resource",
      previous: {
        $defs: {
          Outer: {
            $id: "urn:stable:outer",
            anyOf: [{ $id: "urn:stable:inner", type: "number" }, true],
          },
        },
      },
      current: {
        $defs: {
          Outer: {
            $id: "urn:stable:outer",
            anyOf: [{ $id: "urn:stable:inner", type: "number", maximum: 10 }, true],
          },
        },
      },
      kind: "upper_bound_tightened",
    },
    {
      name: "properties then anyOf unknown assertion",
      previous: {
        properties: {
          value: { anyOf: [{ $id: "urn:stable:unknown", type: "string" }, true] },
        },
      },
      current: {
        properties: {
          value: {
            anyOf: [{
              $id: "urn:stable:unknown",
              type: "string",
              "x-unknown-assertion": true,
            }, true],
          },
        },
      },
      kind: "unsupported_assertion_changed",
    },
  ];

  for (const { name, previous, current, kind } of cases) {
    assert.equal(
      compareSchemas(previous, current).some((item) => item.kind === kind),
      true,
      name,
    );
  }
});

test("keeps embedded resource deletion and rename as metadata breaks", () => {
  const previous = {
    anyOf: [{ $id: "urn:stable:before", type: "string" }, true],
  };
  const removed = { anyOf: [true] };
  const renamed = {
    anyOf: [{ $id: "urn:stable:after", type: "string" }, true],
  };
  assert.equal(
    compareSchemas(previous, removed).some((item) => item.kind === "schema_id_changed"),
    true,
  );
  assert.equal(
    compareSchemas(previous, renamed).some((item) => item.kind === "schema_id_changed"),
    true,
  );
});

test("fails closed on unchanged relative schema ids before equality shortcuts", () => {
  const relative = { $id: "child", type: "string" };
  assert.deepEqual(
    compareSchemas(relative, relative).map((item) => [item.kind, item.path, item.before, item.after]),
    [["relative_schema_id_unsupported", "$.$id", "child", "child"]],
  );
});

test("rejects relative resource ids when enclosing absolute bases change", () => {
  const previous = {
    $id: "https://example.test/parent-a/",
    anyOf: [{ $id: "child", type: "string" }, true],
  };
  const current = {
    $id: "https://example.test/parent-b/",
    anyOf: [{ $id: "child", type: "string" }, true],
  };
  assert.deepEqual(
    compareSchemas(previous, current).map((item) => [item.kind, item.path, item.before, item.after]),
    [["relative_schema_id_unsupported", "$.anyOf[0].$id", "child", "child"]],
  );
});

test("finds relative schema ids recursively through map, value, and array applicators", () => {
  const schema = {
    $id: "core-agent://v1/absolute-root",
    $defs: { Nested: { $id: "child", type: "string" } },
    items: { $id: "../child", type: "string" },
    anyOf: [{ $id: "#fragment", type: "string" }, true],
  };
  assert.deepEqual(
    compareSchemas(schema, schema).map((item) => [item.kind, item.path, item.before]),
    [
      ["relative_schema_id_unsupported", "$.$defs.Nested.$id", "child"],
      ["relative_schema_id_unsupported", "$.anyOf[0].$id", "#fragment"],
      ["relative_schema_id_unsupported", "$.items.$id", "../child"],
    ],
  );
});

test("reserves exact array resource matches before metadata-neutral pairing", () => {
  const resourceA = { $id: "urn:resource:a", type: "string" };
  const resourceB = { $id: "urn:resource:b", type: "string" };
  const changes = compareSchemas(
    { anyOf: [resourceA, resourceB] },
    { anyOf: [resourceB] },
  );
  assert.deepEqual(
    changes
      .filter((item) => item.kind === "schema_id_changed")
      .map((item) => [item.path, item.before, item.after]),
    [["$.anyOf[0].$id", "urn:resource:a", undefined]],
  );
  assert.deepEqual(
    changes
      .filter((item) => item.kind === "union_narrowed")
      .map((item) => [item.path, item.before, item.after]),
    [["$.anyOf[0]", resourceA, undefined]],
  );
});

test("does not report semantic no-ops or supported widening", () => {
  const cases: Array<[unknown, unknown]> = [
    [{ type: "integer" }, { type: "number" }],
    [{ type: "number", multipleOf: 4 }, { type: "number", multipleOf: 2 }],
    [{ type: "string" }, { type: "string", minLength: 0 }],
    [{ const: { a: 1, b: 2 } }, { const: { b: 2, a: 1 } }],
    [{ oneOf: [{ const: "a" }, { const: "b" }] }, { oneOf: [{ const: "b" }, { const: "a" }] }],
    [{ allOf: [{ type: "string" }, { maxLength: 10 }] }, { allOf: [{ maxLength: 10 }, { type: "string" }] }],
    [{ const: "a" }, { enum: ["a", "b"] }],
    [{ anyOf: [true] }, { anyOf: [true, false] }],
    [
      { type: "object", patternProperties: { "^note$": { type: "string" } } },
      {
        type: "object",
        patternProperties: { "^note$": { type: "string" } },
        properties: { note: { type: "string" } },
      },
    ],
  ];
  for (const [previous, current] of cases) {
    assert.deepEqual(
      compareSchemas(previous as Record<string, unknown>, current as Record<string, unknown>),
      [],
    );
  }
  assert.deepEqual(
    compareSchemas(
      { type: "number", multipleOf: 2 },
      { type: "number", multipleOf: 4 },
    ).map((item) => item.kind),
    ["multiple_of_changed"],
  );
  assert.notDeepEqual(compareSchemas({ enum: ["a", "b"] }, { const: "a" }), []);
  assert.notDeepEqual(compareSchemas({ const: "a" }, { enum: ["b"] }), []);
  assert.deepEqual(
    compareSchemas(
      {
        type: "object",
        patternProperties: {
          "^note": { type: "string" },
          "note$": { maxLength: 10 },
        },
      },
      {
        type: "object",
        patternProperties: {
          "^note": { type: "string" },
          "note$": { maxLength: 10 },
        },
        properties: { note: { type: "number" } },
      },
    ).map((item) => item.kind),
    ["property_added_restricts_open_object"],
  );
});

test("fails closed for unknown assertions but ignores documented annotations and x metadata", () => {
  assert.deepEqual(
    compareSchemas(
      { type: "string", title: "Before", "x-extensible-union": false },
      { type: "string", title: "After", description: "docs", "x-extensible-union": true },
    ),
    [],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "string" },
      { type: "string", futureAssertion: 1 },
    ).map((item) => [item.kind, item.path]),
    [["unsupported_assertion_changed", "$.futureAssertion"]],
  );
  assert.deepEqual(
    compareSchemas(
      { type: "string" },
      { type: "string", "x-unknown-assertion": true },
    ).map((item) => [item.kind, item.path]),
    [["unsupported_assertion_changed", "$.x-unknown-assertion"]],
  );
});

test("initial v1 baseline copies generated schemas once and refuses overwrite", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat");
  await writeSchemaManifest(schemas);
  const schemaDocument = await readFile(resolve(schemas, "tenant.schema.json"), "utf8");

  assert.equal(await acceptInitialV1Baseline(schemas, baseline), expectedSchemaFiles.length);
  assert.equal(await readFile(resolve(baseline, "tenant.schema.json"), "utf8"), schemaDocument);
  await assert.rejects(
    acceptInitialV1Baseline(schemas, baseline),
    /refusing to overwrite/i,
  );
});

test("initial v1 baseline refuses non-file and non-JSON directory entries", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat");
  await writeSchemaManifest(schemas);
  await mkdir(baseline);

  await writeFile(resolve(baseline, "README.txt"), "occupied\n", "utf8");
  await assert.rejects(acceptInitialV1Baseline(schemas, baseline), /refusing to overwrite/i);
  await unlink(resolve(baseline, "README.txt"));

  await mkdir(resolve(baseline, "nested"));
  await assert.rejects(acceptInitialV1Baseline(schemas, baseline), /refusing to overwrite/i);
});

test("compatibility allows current schemas added after the immutable baseline", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await writeSchemaManifest(baseline);
  for (const fileName of [
    "create-agent-run-request.schema.json",
    "message-created-event.schema.json",
    "message.schema.json",
  ]) {
    await unlink(resolve(baseline, fileName));
  }
  await writeSchemaManifest(resolve(baseline, "releases/0.2.0"));

  assert.deepEqual(await checkCompatibilityDirectories(schemas, baseline), []);
});

test("compatibility rejects an extra current schema", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat");
  await writeSchemaManifest(schemas);
  await writeSchemaManifest(baseline);
  await writeFile(resolve(schemas, "internal-helper.schema.json"), "{}\n", "utf8");

  assert.equal(
    (await checkCompatibilityDirectories(schemas, baseline))
      .some((item) => item.includes("internal-helper.schema.json") && item.includes("unexpected")),
    true,
  );
});

test("accepted v1 releases make compatibility checks cumulative", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await writeTenantSchema(schemas, {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { anyOf: [{ const: "a" }], "x-extensible-union": true },
    },
  });
  await acceptInitialV1Baseline(schemas, baseline);

  await writeTenantSchema(schemas, {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        anyOf: [{ const: "a" }, { const: "b" }],
        "x-extensible-union": true,
      },
      note: { type: "string" },
    },
  });
  assert.deepEqual(await checkCompatibilityDirectories(schemas, baseline), []);
  assert.equal(await acceptV1Release(schemas, baseline, "1.1.0", {
    versionAuthorities: releaseAuthorities("1.1.0"),
  }), expectedSchemaFiles.length);
  await assert.rejects(
    acceptV1Release(schemas, baseline, "1.1.0", {
      versionAuthorities: releaseAuthorities("1.1.0"),
    }),
    /refusing to overwrite/i,
  );

  await writeTenantSchema(schemas, {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        anyOf: [{ const: "a" }, { const: "b" }],
        "x-extensible-union": true,
      },
    },
  });
  assert.deepEqual(
    compareSchemas(
      JSON.parse(await readFile(resolve(baseline, "tenant.schema.json"), "utf8")),
      JSON.parse(await readFile(resolve(schemas, "tenant.schema.json"), "utf8")),
    ),
    [],
    "the initial-only comparison intentionally passes",
  );
  assert.equal(
    (await checkCompatibilityDirectories(schemas, baseline)).some((item) => (
      item.includes("release 1.1.0")
      && item.includes("tenant.schema.json")
      && item.includes("property_removed")
    )),
    true,
  );
});

test("release manifests are exact and release traversal is deterministic", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await acceptInitialV1Baseline(schemas, baseline);

  const later = resolve(baseline, "releases/1.2.0");
  const earlier = resolve(baseline, "releases/1.1.0");
  await writeSchemaManifest(later);
  await writeSchemaManifest(earlier);
  await writeTenantSchema(later, { type: "string" });
  await writeTenantSchema(earlier, { type: "number" });
  const failures = await checkCompatibilityDirectories(schemas, baseline);
  const releaseFailures = failures.filter((item) => item.includes("release "));
  assert.match(releaseFailures[0]!, /release 1\.1\.0/);
  assert.match(releaseFailures.at(-1)!, /release 1\.2\.0/);

  await unlink(resolve(earlier, "approval.schema.json"));
  await writeFile(resolve(earlier, "extra.schema.json"), "{}\n", "utf8");
  const manifestFailures = await checkCompatibilityDirectories(schemas, baseline);
  assert.equal(manifestFailures.some((item) => item.includes("release 1.1.0") && item.includes("approval.schema.json") && item.includes("missing")), true);
  assert.equal(manifestFailures.some((item) => item.includes("release 1.1.0") && item.includes("extra.schema.json") && item.includes("unexpected")), true);
});

test("release acceptance rejects invalid versions and incompatible candidates", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await acceptInitialV1Baseline(schemas, baseline);
  await assert.rejects(acceptV1Release(schemas, baseline, "../escape"), /package version/i);
  await writeTenantSchema(schemas, { type: "string" });
  await assert.rejects(acceptV1Release(schemas, baseline, "1.1.0", {
    versionAuthorities: releaseAuthorities("1.1.0"),
  }), /compatibility check failed/i);
});

test("initial snapshot publication cleans an interrupted staging copy and permits retry", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  let copies = 0;

  await assert.rejects(
    acceptInitialV1Baseline(schemas, baseline, {
      copySchemaFile: async (source, destination) => {
        copies += 1;
        if (copies === 4) throw new Error("injected copy interruption");
        await copyFile(source, destination);
      },
    }),
    /injected copy interruption/,
  );
  await assert.rejects(stat(baseline), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(resolve(directory, "compat"))).filter((name) => name.includes(".staging-")),
    [],
  );
  assert.equal(await acceptInitialV1Baseline(schemas, baseline), expectedSchemaFiles.length);
});

test("concurrent release publishers accept one complete source without mixing", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initialSchemas = resolve(directory, "initial");
  const sourceA = resolve(directory, "source-a");
  const sourceB = resolve(directory, "source-b");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(initialSchemas);
  await acceptInitialV1Baseline(initialSchemas, baseline);
  await writeMarkedSchemaManifest(sourceA, "source-a");
  await writeMarkedSchemaManifest(sourceB, "source-b");

  let arrivals = 0;
  let openBarrier!: () => void;
  const barrier = new Promise<void>((resolveBarrier) => { openBarrier = resolveBarrier; });
  const beforeCommit = async (): Promise<void> => {
    arrivals += 1;
    if (arrivals === 2) openBarrier();
    await barrier;
  };
  const options = {
    versionAuthorities: releaseAuthorities("1.1.0"),
    beforeSnapshotCommit: beforeCommit,
  };
  const results = await Promise.allSettled([
    acceptV1Release(sourceA, baseline, "1.1.0", options),
    acceptV1Release(sourceB, baseline, "1.1.0", options),
  ]);
  assert.equal(arrivals, 2, "both publishers must stage before either atomic rename");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);

  const release = resolve(baseline, "releases/1.1.0");
  const markers = new Set<string>();
  for (const fileName of expectedSchemaFiles) {
    const schema = JSON.parse(await readFile(resolve(release, fileName), "utf8")) as { title: string };
    markers.add(schema.title);
  }
  assert.equal((await readdir(release)).length, expectedSchemaFiles.length);
  assert.equal(markers.size, 1);
  assert.equal(["source-a", "source-b"].includes([...markers][0]!), true);
  assert.deepEqual(
    (await readdir(resolve(baseline, "releases"))).filter((name) => name.includes(".staging-")),
    [],
  );
});

test("release copy interruption leaves no final and a clean retry succeeds", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-release-atomic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await acceptInitialV1Baseline(schemas, baseline);
  let copies = 0;
  const authorities = releaseAuthorities("1.1.0");
  await assert.rejects(
    acceptV1Release(schemas, baseline, "1.1.0", {
      versionAuthorities: authorities,
      copySchemaFile: async (source, destination) => {
        copies += 1;
        if (copies === 7) throw new Error("injected release copy interruption");
        await copyFile(source, destination);
      },
    }),
    /injected release copy interruption/,
  );
  const release = resolve(baseline, "releases/1.1.0");
  await assert.rejects(stat(release), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(resolve(baseline, "releases"))).filter((name) => name.includes(".staging-")),
    [],
  );
  assert.equal(await acceptV1Release(schemas, baseline, "1.1.0", {
    versionAuthorities: authorities,
  }), expectedSchemaFiles.length);
});

test("snapshot publication refuses an empty target created after staging without clobbering it", async (t) => {
  const modes = ["initial", "release"] as const;
  for (const mode of modes) {
    const directory = await mkdtemp(resolve(tmpdir(), `contracts-compat-empty-race-${mode}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const schemas = resolve(directory, "schemas");
    const baseline = resolve(directory, "compat/v1");
    await writeSchemaManifest(schemas);
    if (mode === "release") await acceptInitialV1Baseline(schemas, baseline);
    const target = mode === "initial" ? baseline : resolve(baseline, "releases/1.1.0");
    const parent = resolve(target, "..");
    const options = {
      beforeSnapshotCommit: async (): Promise<void> => { await mkdir(target); },
    };

    await assert.rejects(
      mode === "initial"
        ? acceptInitialV1Baseline(schemas, baseline, options)
        : acceptV1Release(schemas, baseline, "1.1.0", {
          ...options,
          versionAuthorities: releaseAuthorities("1.1.0"),
        }),
      /refusing to overwrite/i,
      mode,
    );
    assert.deepEqual(await readdir(target), [], `${mode} target must remain untouched`);
    assert.deepEqual(
      (await readdir(parent)).filter((name) => name.includes(".staging-") || name.endsWith(".claim")),
      [],
      `${mode} staging and claim state must be cleaned`,
    );

    await rm(target, { recursive: true });
    assert.equal(
      mode === "initial"
        ? await acceptInitialV1Baseline(schemas, baseline)
        : await acceptV1Release(schemas, baseline, "1.1.0", {
          versionAuthorities: releaseAuthorities("1.1.0"),
        }),
      expectedSchemaFiles.length,
      `${mode} retry`,
    );
  }
});

test("release publication binds CLI input to all version authorities", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await acceptInitialV1Baseline(schemas, baseline);

  await assert.rejects(
    acceptV1Release(schemas, baseline, "9.9.9"),
    /does not match package version authority/i,
  );
  await assert.rejects(
    acceptV1Release(schemas, baseline, "1.1.0", {
      versionAuthorities: {
        packageJsonVersion: "1.1.0",
        exportedPackageVersion: "1.1.0",
        compatibilityChangeVersion: "1.2.0",
      },
    }),
    /version authorities disagree/i,
  );
  await assert.rejects(stat(resolve(baseline, "releases/1.1.0")), { code: "ENOENT" });
  await assert.rejects(stat(resolve(baseline, "releases/9.9.9")), { code: "ENOENT" });
});

test("release discovery fails closed when the releases path is unreadable", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-read-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat/v1");
  await writeSchemaManifest(schemas);
  await acceptInitialV1Baseline(schemas, baseline);
  await writeFile(resolve(baseline, "releases"), "not a directory\n", "utf8");

  assert.equal(
    (await checkCompatibilityDirectories(schemas, baseline))
      .some((failure) => failure.includes("unable to read releases directory")),
    true,
  );
});
