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
    "capability",
    "capability-version",
    "pack-product",
    "pack-member",
    "pack-version",
    "tenant-pack-release",
    "entitlement",
    "entitlement-assignment",
    "entitlement-snapshot",
    "profile-snapshot-pointer",
    "capability-service-projection",
    "company-service-summary",
    "student-service-summary",
    "company-assignment-summary",
    "select-tenant-pack-release-request",
    "grant-entitlement-request",
    "change-entitlement-status-request",
    "assign-pack-seat-request",
    "revoke-pack-seat-request",
    "tenant",
    "actor",
    "membership",
    "profile",
    "identity-graph",
    "runtime-container",
    "conversation",
    "session",
    "agent-run",
    "message",
    "task",
    "approval",
    "trusted-request-context",
    "signed-trusted-request-context",
    "product-event-envelope",
    "product-event",
    "message-created-event",
    "catalog-event",
    "audit-event",
    "error-envelope",
    "idempotency-request",
    "idempotency-record",
    "versioned-write-request",
    "create-agent-run-request",
    "auth-subject",
    "platform-role-assignment",
    "invitation",
    "core-session",
    "account-deletion",
    "email-sign-up-request",
    "email-sign-up-response",
    "email-verification-request",
    "email-verification-response",
    "email-sign-in-request",
    "email-sign-in-response",
    "password-reset-request",
    "password-reset-completion-request",
    "password-reset-response",
    "apple-authorization-start-request",
    "apple-authorization-start-response",
    "apple-authorization-callback-request",
    "apple-authorization-callback-response",
    "apple-identity-link-start-request",
    "apple-identity-link-start-response",
    "apple-identity-link-request",
    "apple-identity-link-response",
    "auth-session-view",
    "session-inspect-request",
    "session-inspect-response",
    "session-revoke-request",
    "session-revoke-response",
    "reauthentication-request",
    "reauthentication-response",
    "invitation-acceptance-request",
    "invitation-acceptance-response",
    "invitation-email-registration-request",
    "invitation-email-registration-response",
    "invitation-inspect-request",
    "invitation-inspect-response",
    "invitation-revoke-request",
    "invitation-revoke-response",
    "company-create-request",
    "company-create-response",
    "company-consultant-role-grant-request",
    "company-consultant-role-grant-response",
    "company-consultant-role-remove-request",
    "company-consultant-role-remove-response",
    "company-member-invite-request",
    "company-member-invite-response",
    "company-member-view",
    "company-member-list-request",
    "company-member-list-response",
    "company-member-suspend-request",
    "company-member-suspend-response",
    "company-member-revoke-request",
    "company-member-revoke-response",
    "account-deletion-request",
    "account-deletion-response",
    "account-deletion-cancel-request",
    "account-deletion-cancel-response",
  ]);
});

test("serialized schemas declare JSON Schema 2020-12", () => {
  const document = JSON.parse(serializeSchema(ContractSchemas.tenant));
  assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(document.$id, "core-agent://v1/tenant");
});

test("every generated schema has recursively unique canonical ids", () => {
  for (const [schemaKey, schema] of Object.entries(ContractSchemas)) {
    const document = JSON.parse(serializeSchema(schema)) as unknown;
    const pathsById = new Map<string, string[]>();
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      if (!Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record.$id === "string") {
          const paths = pathsById.get(record.$id) ?? [];
          paths.push(path);
          pathsById.set(record.$id, paths);
        }
        for (const [key, item] of Object.entries(record)) visit(item, `${path}.${key}`);
        return;
      }
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    };
    visit(document, "$");

    const duplicates = [...pathsById]
      .filter(([, paths]) => paths.length > 1)
      .map(([id, paths]) => ({ id, paths }));
    assert.deepEqual(duplicates, [], schemaKey);
  }
});

test("every generated schema id is an absolute URI", () => {
  const isAbsoluteUri = (value: string): boolean => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  };

  for (const [schemaKey, schema] of Object.entries(ContractSchemas)) {
    const document = JSON.parse(serializeSchema(schema)) as unknown;
    const invalid: Array<{ path: string; value: unknown }> = [];
    const visit = (value: unknown, path: string): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      const record = value as Record<string, unknown>;
      if ("$id" in record && (
        typeof record.$id !== "string" || !isAbsoluteUri(record.$id)
      )) {
        invalid.push({ path: `${path}.$id`, value: record.$id });
      }
      for (const [key, item] of Object.entries(record)) visit(item, `${path}.${key}`);
    };
    visit(document, "$");
    assert.deepEqual(invalid, [], schemaKey);
  }
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
