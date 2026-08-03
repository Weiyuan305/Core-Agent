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
