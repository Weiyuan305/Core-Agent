import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "repositories");
const tenantOwnedTables = new Set([
  "tenants", "actors", "memberships", "profiles", "runtime_containers", "conversations", "sessions", "agent_runs", "messages",
]);

function findRepositoryQuerySafetyViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const rootPattern = /\b(selectFrom|insertInto|updateTable|deleteFrom)\(\s*["']([a-z_]+)(?:\s+as\s+[a-z_]+)?["']\s*\)/g;
  for (const match of source.matchAll(rootPattern)) {
    const [root, operation, table] = match;
    const start = match.index;
    if (start === undefined || operation === undefined || table === undefined) continue;
    const chain = readQueryChain(source, start + root.length);
    if (chain === undefined) {
      violations.push(`${file}: ${table} ${operation} has no bounded execute terminator`);
      continue;
    }

    if (operation === "insertInto" && tenantOwnedTables.has(table)) {
      const values = readMethodCall(chain, "values");
      if (values === undefined || !hasTopLevelTenantId(values)) {
        violations.push(`${file}: ${table} insert is missing an explicit tenant_id value`);
      }
    } else if (operation !== "insertInto" && tenantOwnedTables.has(table) && !/\.where\s*\(\s*["'](?:[a-z_][a-z0-9_]*\.)?tenant_id["']/i.test(chain)) {
      violations.push(`${file}: ${table} query is missing a tenant_id predicate`);
    }

    const joinPattern = /\.(?:inner|left|right|full)Join(?:Lateral)?\s*\(\s*["']([a-z_]+)(?:\s+as\s+[a-z_]+)?["']/g;
    for (const join of chain.matchAll(joinPattern)) {
      const joinedTable = join[1];
      const joinStart = join.index;
      if (joinedTable === undefined || joinStart === undefined || !tenantOwnedTables.has(joinedTable)) continue;
      const joinCall = readCallAt(chain, chain.indexOf("(", joinStart));
      const compositeTenantJoin = joinCall !== undefined
        && /\.onRef\s*\(\s*["'][^"']*tenant_id["']\s*,\s*["']=["']\s*,\s*["'][^"']*tenant_id["']\s*\)/.test(joinCall);
      if (!compositeTenantJoin) {
        violations.push(`${file}: ${joinedTable} join is missing a composite tenant_id condition`);
      }
    }
  }
  return violations;
}

function hasTopLevelTenantId(valuesCall: string): boolean {
  let objectDepth = 0;
  let quote: "\"" | "'" | "`" | undefined;
  for (let index = 0; index < valuesCall.length; index += 1) {
    const character = valuesCall[index];
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      objectDepth += 1;
      continue;
    }
    if (character === "}") {
      objectDepth -= 1;
      continue;
    }
    if (objectDepth !== 1 || !valuesCall.startsWith("tenant_id", index)) continue;
    const previous = valuesCall.slice(0, index).trimEnd().at(-1);
    const next = valuesCall.slice(index + "tenant_id".length).trimStart()[0];
    if ((previous === "{" || previous === ",") && (next === ":" || next === "," || next === "}")) return true;
  }
  return false;
}

function readQueryChain(source: string, start: number): string | undefined {
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote: "\"" | "'" | "`" | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round -= 1;
    else if (character === "[") square += 1;
    else if (character === "]") square -= 1;
    else if (character === "{") curly += 1;
    else if (character === "}") curly -= 1;
    if (round === 0 && square === 0 && curly === 0 && source.slice(index).match(/^\.execute[A-Za-z]*\s*\(\s*\)/) !== null) {
      const terminator = source.slice(index).match(/^\.execute[A-Za-z]*\s*\(\s*\)/)?.[0];
      return terminator === undefined ? undefined : source.slice(start, index + terminator.length);
    }
    if (round === 0 && square === 0 && curly === 0 && character === ";") return undefined;
  }
  return undefined;
}

function readMethodCall(chain: string, method: string): string | undefined {
  const match = new RegExp(`\\.${method}\\s*\\(`).exec(chain);
  if (match?.index === undefined) return undefined;
  return readCallAt(chain, chain.indexOf("(", match.index));
}

function readCallAt(source: string, openParenthesis: number): string | undefined {
  if (openParenthesis < 0) return undefined;
  let depth = 0;
  let quote: "\"" | "'" | "`" | undefined;
  for (let index = openParenthesis; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenthesis, index + 1);
    }
  }
  return undefined;
}

test("static gate detects unsafe inserts and throwing query terminators", () => {
  const unsafe = `
    await db.insertInto("runtime_containers").values({ container_id: runtimeId }).execute();
    await db.selectFrom("messages").select("message_id").executeTakeFirstOrThrow();
  `;
  assert.deepEqual(findRepositoryQuerySafetyViolations("unsafe.ts", unsafe), [
    "unsafe.ts: runtime_containers insert is missing an explicit tenant_id value",
    "unsafe.ts: messages query is missing a tenant_id predicate",
  ]);
});

test("static gate bounds each chain and rejects non-composite tenant joins", () => {
  const unsafe = `
    await db.selectFrom("conversations")
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    await db.selectFrom("messages")
      .innerJoin("agent_runs", "agent_runs.run_id", "messages.run_id")
      .execute();
  `;
  assert.deepEqual(findRepositoryQuerySafetyViolations("unsafe-join.ts", unsafe), [
    "unsafe-join.ts: messages query is missing a tenant_id predicate",
    "unsafe-join.ts: agent_runs join is missing a composite tenant_id condition",
  ]);
});

test("static gate accepts explicit insert scope and composite tenant joins", () => {
  const safe = `
    await db.insertInto("messages").values({ tenant_id: context.tenantId, message_id: messageId }).execute();
    await db.selectFrom("messages")
      .innerJoin("agent_runs", (join) => join
        .onRef("agent_runs.run_id", "=", "messages.run_id")
        .onRef("agent_runs.tenant_id", "=", "messages.tenant_id"))
      .where("messages.tenant_id", "=", context.tenantId)
      .executeTakeFirstOrThrow();
  `;
  assert.deepEqual(findRepositoryQuerySafetyViolations("safe.ts", safe), []);
});

test("static gate requires a top-level insert tenant and checks tenant joins from unowned roots", () => {
  const unsafe = `
    await db.insertInto("messages").values({ payload: { tenant_id: context.tenantId } }).execute();
    await db.selectFrom("diagnostics")
      .innerJoin("messages", "messages.message_id", "diagnostics.resource_id")
      .execute();
  `;
  assert.deepEqual(findRepositoryQuerySafetyViolations("nested.ts", unsafe), [
    "nested.ts: messages insert is missing an explicit tenant_id value",
    "nested.ts: messages join is missing a composite tenant_id condition",
  ]);
});

test("repository read and write queries retain a tenant scope", async () => {
  const sourceFiles = (await readdir(repositoryDirectory)).filter((name) => name.endsWith(".ts"));
  const violations: string[] = [];
  for (const file of sourceFiles) {
    violations.push(...findRepositoryQuerySafetyViolations(file, await readFile(join(repositoryDirectory, file), "utf8")));
  }
  assert.deepEqual(violations, []);
});
