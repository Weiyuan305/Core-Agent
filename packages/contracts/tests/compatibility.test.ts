import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  acceptV1Release,
  acceptInitialV1Baseline,
  checkCompatibilityDirectories,
  compareSchemas,
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

test("does not report semantic no-ops or supported widening", () => {
  const cases: Array<[unknown, unknown]> = [
    [{ type: "integer" }, { type: "number" }],
    [{ type: "number", multipleOf: 4 }, { type: "number", multipleOf: 2 }],
    [{ type: "string" }, { type: "string", minLength: 0 }],
    [{ const: { a: 1, b: 2 } }, { const: { b: 2, a: 1 } }],
    [{ oneOf: [{ const: "a" }, { const: "b" }] }, { oneOf: [{ const: "b" }, { const: "a" }] }],
    [{ allOf: [{ type: "string" }, { maxLength: 10 }] }, { allOf: [{ maxLength: 10 }, { type: "string" }] }],
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

  assert.equal(await acceptInitialV1Baseline(schemas, baseline), 28);
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

test("compatibility rejects a deleted baseline schema", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-compat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const schemas = resolve(directory, "schemas");
  const baseline = resolve(directory, "compat");
  await writeSchemaManifest(schemas);
  await writeSchemaManifest(baseline);
  await unlink(resolve(baseline, "tenant.schema.json"));

  assert.equal(
    (await checkCompatibilityDirectories(schemas, baseline))
      .some((item) => item.includes("tenant.schema.json") && item.includes("missing")),
    true,
  );
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
  assert.equal(await acceptV1Release(schemas, baseline, "1.1.0"), 28);
  await assert.rejects(
    acceptV1Release(schemas, baseline, "1.1.0"),
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
  await assert.rejects(acceptV1Release(schemas, baseline, "1.1.0"), /compatibility check failed/i);
});
