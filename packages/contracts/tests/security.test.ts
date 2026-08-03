import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

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

test("fixtures and schemas contain no credential or personal-data patterns", async () => {
  const roots = [resolve(import.meta.dirname, "../fixtures"), resolve(import.meta.dirname, "../schemas")];
  const forbidden = [
    /sk-[A-Za-z0-9_-]{16,}/,
    /Bearer\s+[A-Za-z0-9._-]+/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    /"(?:api_key|access_token|refresh_token|authorization)"\s*:/i,
    /(?:phone|mobile|passport|credit_card|bank_account)\s*[\":=]/i,
  ];
  for (const root of roots) {
    for (const path of await filesBelow(root)) {
      const content = await readFile(path, "utf8");
      for (const pattern of forbidden) assert.equal(pattern.test(content), false, `${path} matched ${pattern}`);
    }
  }
});

test("public schemas do not expose hidden reasoning or raw tool payload fields", async () => {
  const files = await filesBelow(resolve(import.meta.dirname, "../schemas"));
  const forbiddenFields = ["hidden_reasoning", "chain_of_thought", "raw_input", "raw_output", "api_key", "access_token", "stack"];
  for (const path of files) {
    const document = JSON.parse(await readFile(path, "utf8"));
    const serialized = JSON.stringify(document);
    for (const field of forbiddenFields) assert.equal(serialized.includes(`\"${field}\"`), false, `${path} exposes ${field}`);
  }
});
