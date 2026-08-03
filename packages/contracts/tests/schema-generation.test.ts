import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { findSchemaDrift } from "../scripts/generate-schemas.js";
import { ContractSchemas, serializeSchema } from "../src/index.js";

test("registry keys and schema ids are unique", () => {
  const ids = Object.values(ContractSchemas).map((schema) => schema.$id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(Object.keys(ContractSchemas).every((key) => /^[a-z0-9-]+$/.test(key)), true);
});

test("registry publishes exactly the planned v1 contracts", () => {
  assert.deepEqual(Object.keys(ContractSchemas), [
    "resource-metadata",
    "trace-context",
    "page-request",
    "page-info",
    "student-ref",
    "case-ref",
    "entitlement-snapshot-ref",
    "consent-snapshot-ref",
    "tenant",
    "actor",
    "membership",
    "profile",
    "identity-graph",
    "runtime-container",
    "conversation",
    "session",
    "agent-run",
    "task",
    "approval",
    "trusted-request-context",
    "signed-trusted-request-context",
    "product-event-envelope",
    "product-event",
    "audit-event",
    "error-envelope",
    "idempotency-request",
    "idempotency-record",
    "versioned-write-request",
  ]);
});

test("serialized schemas declare JSON Schema 2020-12", () => {
  const document = JSON.parse(serializeSchema(ContractSchemas.tenant));
  assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(document.$id, "core-agent://v1/tenant");
});

test("committed generated schemas have no drift", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/generate-schemas.ts", "--check"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("schema drift detects unexpected and missing schema files", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "contracts-schemas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL("../schemas/v1", import.meta.url), directory, { recursive: true });

  await writeFile(resolve(directory, "internal-helper.schema.json"), "{}\n", "utf8");
  assert.equal(
    (await findSchemaDrift(directory)).some((item) => item.includes("internal-helper.schema.json") && item.includes("unexpected")),
    true,
  );

  await unlink(resolve(directory, "internal-helper.schema.json"));
  await unlink(resolve(directory, "tenant.schema.json"));
  assert.equal(
    (await findSchemaDrift(directory)).some((item) => item.includes("tenant.schema.json") && item.includes("missing")),
    true,
  );
});
