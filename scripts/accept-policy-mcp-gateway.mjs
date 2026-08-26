#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const acceptanceTest = join(repositoryRoot, "packages", "runtime-core", "tests", "policy-mcp-postgres.test.ts");

function disposableDatabase(environment) {
  const value = environment.CONTROL_PLANE_TEST_DATABASE_URL;
  try {
    const parsed = new URL(value);
    if (!parsed.pathname.slice(1).startsWith("core_agent_")) throw new Error();
    return value;
  } catch {
    throw new Error("POLICY_MCP_ACCEPTANCE_DISPOSABLE_DATABASE_REQUIRED");
  }
}

function runAttempt(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--test", "--test-concurrency=1", acceptanceTest,
    ], { cwd: repositoryRoot, env: environment, stdio: "inherit" });
    child.once("error", () => reject(new Error("POLICY_MCP_ACCEPTANCE_PROCESS_FAILED")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("POLICY_MCP_ACCEPTANCE_FAILED")));
  });
}

export async function runPolicyMcpGatewayAcceptance(environment = process.env) {
  disposableDatabase(environment);
  for (let attempt = 1; attempt <= 2; attempt += 1) await runAttempt(environment);
  return Object.freeze({
    attempts: 2,
    database: "disposable_postgresql",
    downstream: "synthetic_read_only",
    plugin: "real_python_hook",
    status: "PASS",
  });
}

async function main() {
  try {
    const report = await runPolicyMcpGatewayAcceptance();
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    process.stderr.write("POLICY_MCP_ACCEPTANCE_FAILED\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
