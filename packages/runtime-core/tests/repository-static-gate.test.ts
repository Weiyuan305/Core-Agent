import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "repositories");
const tenantOwnedTables = new Set([
  "tenants", "actors", "memberships", "profiles", "runtime_containers", "conversations", "sessions", "agent_runs", "messages",
]);

test("repository read and write queries retain a tenant scope", async () => {
  const sourceFiles = (await readdir(repositoryDirectory)).filter((name) => name.endsWith(".ts"));
  const violations: string[] = [];
  for (const file of sourceFiles) {
    const source = await readFile(join(repositoryDirectory, file), "utf8");
    const queryPattern = /(?:selectFrom|updateTable|deleteFrom)\("([a-z_]+)"\)([\s\S]*?)(?:executeTakeFirst|execute)\(\)/g;
    for (const match of source.matchAll(queryPattern)) {
      const [, table, chain] = match;
      if (tenantOwnedTables.has(table) && !chain.includes('.where("tenant_id"')) {
        violations.push(`${file}: ${table} query is missing a tenant_id predicate`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
