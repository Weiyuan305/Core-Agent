import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
