#!/usr/bin/env node

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const networkContracts = Object.freeze([
  Object.freeze({ name: "core-agent-backplane", resource: "backplane", internal: true }),
  Object.freeze({ name: "core-agent-egress", resource: "egress", internal: false }),
]);

function invalidNetwork() {
  return new Error("runtime network is invalid");
}

async function docker(args) {
  const { stdout } = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  if (typeof stdout !== "string") throw invalidNetwork();
  return stdout;
}

function validateInspection(raw, contract) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidNetwork();
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || value.Name !== contract.name
    || value.Driver !== "bridge"
    || value.Internal !== contract.internal
    || value.Attachable !== false
    || typeof value.Labels !== "object" || value.Labels === null || Array.isArray(value.Labels)
    || Object.keys(value.Labels).length !== 3
    || value.Labels["core-agent.managed"] !== "runtime-v1"
    || value.Labels["core-agent.resource"] !== contract.resource
    || value.Labels["core-agent.network"] !== contract.name
  ) throw invalidNetwork();
}

export async function prepareRuntimeNetwork({ runDocker = docker } = {}) {
  for (const contract of networkContracts) {
    const listed = (await runDocker([
      "network", "ls", "--filter", `name=^${contract.name}$`, "--format", "{{.Name}}",
    ])).trim();
    if (listed !== "" && listed !== contract.name) throw invalidNetwork();
    if (listed === "") {
      await runDocker([
        "network", "create", "--driver", "bridge",
        ...(contract.internal ? ["--internal"] : []),
        "--label", "core-agent.managed=runtime-v1",
        "--label", `core-agent.resource=${contract.resource}`,
        "--label", `core-agent.network=${contract.name}`,
        contract.name,
      ]);
    }
    validateInspection(await runDocker([
      "network", "inspect", "--format", "{{json .}}", contract.name,
    ]), contract);
  }
}

async function main() {
  if (process.argv.length !== 2) throw invalidNetwork();
  await prepareRuntimeNetwork();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("runtime network preparation failed\n");
    process.exitCode = 1;
  });
}
