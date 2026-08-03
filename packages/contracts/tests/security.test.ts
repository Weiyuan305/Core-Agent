import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const credentialOrPersonalDataPatterns = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /"(?:api_key|access_token|refresh_token|authorization)"\s*:/i,
  /"(?:phone|mobile|passport|credit_card|bank_account)"\s*:/i,
];

const forbiddenPublicSchemaFields = [
  "hidden_reasoning", "chain_of_thought", "raw_input", "raw_output", "api_key", "access_token", "stack",
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
  for (const root of roots) {
    for (const path of await filesBelow(root)) {
      const content = await readFile(path, "utf8");
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
