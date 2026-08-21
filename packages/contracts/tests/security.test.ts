import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import Schema from "typebox/schema";

import { ContractSchemas } from "../src/index.js";

const credentialOrPersonalDataPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]+\.invalid\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /"(?:api_key|access_token|refresh_token|authorization)"\s*:/i,
  /"(?:phone|mobile|passport|credit_card|bank_account)"\s*:/i,
];

const forbiddenPublicSchemaFields = [
  "hidden_reasoning", "chain_of_thought", "raw_input", "raw_output", "api_key", "access_token", "stack",
];
const forbiddenAuthResponseFields = [
  "password", "email", "provider_subject", "access_token", "refresh_token",
  "authorization", "raw_claims", "key_id", "provider_error_body",
];
const forbiddenServiceSummaryFields = [
  "artifact_ref", "contract_ref", "capability_id", "capability_ids",
  "external_order_ref", "price", "receipt", "tool_schema", "secret",
  "failure_summary", "container_id", "image_id",
];

function matchingCredentialOrPersonalDataPattern(content: string): RegExp | undefined {
  return credentialOrPersonalDataPatterns.find((pattern) => pattern.test(content));
}

function forbiddenPublicSchemaField(document: unknown): string | undefined {
  if (Array.isArray(document)) {
    for (const value of document) {
      const field = forbiddenPublicSchemaField(value);
      if (field !== undefined) return field;
    }
    return undefined;
  }
  if (document === null || typeof document !== "object") return undefined;

  const object = document as Record<string, unknown>;
  const properties = object.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const field of forbiddenPublicSchemaFields) {
      if (Object.hasOwn(properties, field)) return field;
    }
  }
  for (const value of Object.values(object)) {
    const field = forbiddenPublicSchemaField(value);
    if (field !== undefined) return field;
  }
  return undefined;
}

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files.sort();
}

test("credential and personal-data scans allow lookalike JSON keys", () => {
  const allowed = [
    '{"microphone": "synthetic"}',
    '{"automobile": "synthetic"}',
    "phone: synthetic",
    "mobile=synthetic",
    "synthetic@auth.invalid",
  ];
  for (const content of allowed) {
    assert.equal(matchingCredentialOrPersonalDataPattern(content), undefined, content);
  }
});

test("credential and personal-data scans reject exact quoted JSON keys", () => {
  const forbiddenFields = [
    "phone", "mobile", "passport", "credit_card", "bank_account",
    "api_key", "access_token", "refresh_token", "authorization",
  ];
  for (const field of forbiddenFields) {
    const content = `{"${field}": "synthetic"}`;
    assert.notEqual(matchingCredentialOrPersonalDataPattern(content), undefined, content);
  }
});

test("public schema scans allow forbidden words in schema values", () => {
  const document = {
    properties: {
      status: { const: "stack", enum: ["stack"], description: "stack" },
    },
  };
  assert.equal(forbiddenPublicSchemaField(document), undefined);
});

test("public schema scans reject nested forbidden property names", () => {
  const document = {
    properties: {
      result: {
        properties: {
          stack: { type: "string" },
        },
      },
    },
  };
  assert.equal(forbiddenPublicSchemaField(document), "stack");
});

test("fixtures and schemas contain no credential or personal-data patterns", async () => {
  const roots = [resolve(import.meta.dirname, "../fixtures"), resolve(import.meta.dirname, "../schemas")];
  const syntheticSecretFixture = resolve(
    import.meta.dirname,
    "../fixtures/v1/invalid/message-secret-field.json",
  );
  for (const root of roots) {
    for (const path of await filesBelow(root)) {
      let content = await readFile(path, "utf8");
      if (path === syntheticSecretFixture) {
        const fixture = JSON.parse(content) as { value: { api_key?: unknown } };
        assert.equal(fixture.value.api_key, "sentinel");
        delete fixture.value.api_key;
        content = JSON.stringify(fixture);
      }
      const pattern = matchingCredentialOrPersonalDataPattern(content);
      assert.equal(pattern, undefined, `${path} matched ${pattern}`);
    }
  }
});

test("public schemas do not expose hidden reasoning or raw tool payload fields", async () => {
  const files = await filesBelow(resolve(import.meta.dirname, "../schemas"));
  for (const path of files) {
    const document = JSON.parse(await readFile(path, "utf8"));
    const field = forbiddenPublicSchemaField(document);
    assert.equal(field, undefined, `${path} exposes ${field}`);
  }
});

test("public runtime schemas reject secrets and client-forged tenant scope", () => {
  const message = ContractSchemas.message;
  const createAgentRunRequest = ContractSchemas["create-agent-run-request"];
  assert.notEqual(message, undefined);
  assert.notEqual(createAgentRunRequest, undefined);
  assert.equal(Schema.Check(message!, {
    schema_version: 1,
    resource_version: 1,
    created_at: "2026-08-03T12:00:00.000Z",
    updated_at: "2026-08-03T12:00:00.000Z",
    message_id: "msg_01",
    tenant_id: "tenant_01",
    conversation_id: "conversation_01",
    run_id: "run_01",
    role: "user",
    status: "completed",
    content: "Synthetic hello",
    api_key: "sentinel",
  }), false);
  assert.equal(Schema.Check(createAgentRunRequest!, {
    schema_version: 1,
    idempotency_key: "idem_01",
    payload_hash: `sha256:${"a".repeat(64)}`,
    client_request_id: "client_01",
    tenant_id: "tenant_forged",
    input_message: { client_message_id: "client_message_01", content: "Synthetic hello" },
  }), false);
});

test("public auth response schemas expose no authentication PII, tokens, claims, or key ids", () => {
  const responseKeys = Object.keys(ContractSchemas).filter((key) => (
    key === "auth-session-view" || key.endsWith("-response")
  ));
  assert.equal(responseKeys.length > 0, true);
  for (const key of responseKeys) {
    const document = ContractSchemas[key as keyof typeof ContractSchemas] as unknown;
    const visit = (value: unknown): string | undefined => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const field = visit(item);
          if (field !== undefined) return field;
        }
        return undefined;
      }
      if (value === null || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      if (record.properties !== null && typeof record.properties === "object") {
        for (const field of forbiddenAuthResponseFields) {
          if (Object.hasOwn(record.properties as object, field)) return field;
        }
      }
      for (const item of Object.values(record)) {
        const field = visit(item);
        if (field !== undefined) return field;
      }
      return undefined;
    };
    assert.equal(visit(document), undefined, key);
  }
});

test("public entitlement summaries expose no catalog, commercial, tool, secret, or runtime internals", () => {
  for (const key of [
    "company-service-summary",
    "student-service-summary",
    "company-assignment-summary",
  ] as const) {
    const document = ContractSchemas[key] as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(document);
    for (const field of forbiddenServiceSummaryFields) {
      assert.equal(serialized.includes(`\"${field}\"`), false, `${key} exposes ${field}`);
    }
  }
});
