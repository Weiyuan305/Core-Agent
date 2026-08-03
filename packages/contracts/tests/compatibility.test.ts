import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  acceptInitialV1Baseline,
  compareSchemas,
} from "../scripts/check-compatibility.js";

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
  await mkdir(schemas);
  const schemaDocument = `${JSON.stringify({ type: "string" }, null, 2)}\n`;
  await writeFile(resolve(schemas, "demo.schema.json"), schemaDocument, "utf8");

  assert.equal(await acceptInitialV1Baseline(schemas, baseline), 1);
  assert.equal(await readFile(resolve(baseline, "demo.schema.json"), "utf8"), schemaDocument);
  await assert.rejects(
    acceptInitialV1Baseline(schemas, baseline),
    /refusing to overwrite/i,
  );
});
