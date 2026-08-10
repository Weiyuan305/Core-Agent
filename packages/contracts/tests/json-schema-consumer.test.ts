import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ContractSchemas } from "../src/index.js";

test("an independent strict Ajv consumer compiles every schema and valid fixture", async () => {
  const root = resolve(import.meta.dirname, "..");
  const schemaKeys = Object.keys(ContractSchemas).sort((left, right) => left.localeCompare(right));
  assert.equal(schemaKeys.length, 80);

  for (const schemaKey of schemaKeys) {
    const schema = JSON.parse(await readFile(
      resolve(root, `schemas/v1/${schemaKey}.schema.json`),
      "utf8",
    )) as object;
    const fixture = JSON.parse(await readFile(
      resolve(root, `fixtures/v1/valid/${schemaKey}.json`),
      "utf8",
    )) as { value: unknown };
    const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
    addFormats(ajv);
    ajv.addKeyword({
      keyword: "x-extensible-union",
      schemaType: "boolean",
      valid: true,
    });

    const validate = ajv.compile(schema);
    assert.equal(
      validate(fixture.value),
      true,
      `${schemaKey}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`,
    );
  }
});

test("README strict Ajv recipe registers formats and metadata before compile", async () => {
  const root = resolve(import.meta.dirname, "..");
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  const recipe = readme.match(/```ts\n(import Ajv2020[\s\S]*?)```/)?.[1];
  assert.ok(recipe, "README must contain the strict Ajv TypeScript recipe");
  assert.match(recipe, /import Ajv2020 from "ajv\/dist\/2020\.js";/);
  assert.match(recipe, /import addFormats from "ajv-formats";/);
  assert.match(
    recipe,
    /import tenantSchema from "@core-agent\/contracts\/schemas\/v1\/tenant\.schema\.json" with \{ type: "json" \};/,
  );
  assert.ok(recipe.indexOf("addFormats(ajv)") < recipe.indexOf("ajv.compile"));
  assert.ok(recipe.indexOf("ajv.addKeyword") < recipe.indexOf("ajv.compile"));

  const schema = JSON.parse(await readFile(resolve(root, "schemas/v1/tenant.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, validateFormats: true });
  addFormats(ajv);
  ajv.addKeyword({ keyword: "x-extensible-union", schemaType: "boolean", valid: true });
  assert.equal(typeof ajv.compile(schema), "function");
});
