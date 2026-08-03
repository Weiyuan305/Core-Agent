import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
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

test("detects property removal, type change, required addition, and union narrowing", () => {
  assert.deepEqual(compareSchemas({ type: "object", properties: { id: { type: "string" } } }, { type: "object", properties: {} }).map((item) => item.kind), ["property_removed"]);
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

test("allows optional properties and explicitly extensible union growth", () => {
  assert.deepEqual(compareSchemas({ type: "object", properties: {} }, { type: "object", properties: { note: { type: "string" } } }), []);
  assert.deepEqual(compareSchemas(
    { anyOf: [{ const: "a" }], "x-extensible-union": true },
    { anyOf: [{ const: "a" }, { const: "b" }], "x-extensible-union": true },
  ), []);
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
