import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("idempotency domain has no ambient wall-clock reads", async () => {
  const source = await readFile(join(sourceDirectory, "domain", "idempotency.ts"), "utf8");

  assert.doesNotMatch(source, /\bDate\.now\s*\(/);
  assert.doesNotMatch(source, /\bnew\s+Date\s*\(\s*\)/);
});

test("every idempotent service supplies its single transaction clock to admission", async () => {
  const serviceFiles = [
    "provision-tenant.ts",
    "create-conversation.ts",
    "create-agent-run.ts",
    "command-runtime.ts",
  ];

  for (const file of serviceFiles) {
    const source = await readFile(join(sourceDirectory, "services", file), "utf8");
    const admissions = [...source.matchAll(/beginIdempotentCommand(?:<[^>]+>)?\([\s\S]*?\n\s*}\);/g)];
    assert.equal(admissions.length, 1, `${file} must contain one bounded idempotency admission`);
    assert.match(admissions[0]![0], /\n\s*now,\s*\n/);
  }
});
