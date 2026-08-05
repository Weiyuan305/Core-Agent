#!/usr/bin/env node

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const networkName = "core-agent-backplane";
const labels = Object.freeze({
  "core-agent.managed": "runtime-v1",
  "core-agent.resource": "backplane",
  "core-agent.network": networkName,
});

function invalidNetwork() {
  return new Error("runtime backplane is invalid");
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

function validateInspection(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidNetwork();
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || value.Name !== networkName
    || value.Driver !== "bridge"
    || value.Internal !== true
    || value.Attachable !== false
    || typeof value.Labels !== "object" || value.Labels === null || Array.isArray(value.Labels)
    || Object.keys(value.Labels).length !== Object.keys(labels).length
    || Object.entries(labels).some(([key, expected]) => value.Labels[key] !== expected)
  ) throw invalidNetwork();
}

export async function prepareRuntimeNetwork({ runDocker = docker } = {}) {
  const listed = (await runDocker([
    "network", "ls", "--filter", `name=^${networkName}$`, "--format", "{{.Name}}",
  ])).trim();
  if (listed !== "" && listed !== networkName) throw invalidNetwork();
  if (listed === "") {
    await runDocker([
      "network", "create", "--driver", "bridge", "--internal",
      "--label", "core-agent.managed=runtime-v1",
      "--label", "core-agent.resource=backplane",
      "--label", `core-agent.network=${networkName}`,
      networkName,
    ]);
  }
  validateInspection(await runDocker([
    "network", "inspect", "--format", "{{json .}}", networkName,
  ]));
}

async function main() {
  if (process.argv.length !== 2) throw invalidNetwork();
  await prepareRuntimeNetwork();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("runtime backplane preparation failed\n");
    process.exitCode = 1;
  });
}
