#!/usr/bin/env node

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validateLocalDockerContextEndpoint } from "./preflight-runtime-docker-socket.mjs";

const execFileAsync = promisify(execFile);
const networkContracts = Object.freeze([
  Object.freeze({ name: "core-agent-backplane", resource: "backplane", internal: true }),
  Object.freeze({
    name: "core-agent-egress",
    resource: "egress",
    internal: false,
    subnet: "172.31.240.0/24",
    gateway: "172.31.240.1",
    options: Object.freeze({ "com.docker.network.bridge.enable_ip_masquerade": "true" }),
  }),
]);

function invalidNetwork() {
  return new Error("runtime network is invalid");
}

function unsafeDockerEnvironment() {
  return new Error("runtime network preparation failed");
}

function assertLocalDockerEnvironment(environment) {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw unsafeDockerEnvironment();
  }
  if (Object.getOwnPropertyDescriptor(environment, "DOCKER_HOST") !== undefined) {
    throw unsafeDockerEnvironment();
  }
}

async function assertSelectedLocalDockerContext(runDocker) {
  try {
    const raw = await runDocker([
      "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}",
    ]);
    validateLocalDockerContextEndpoint(JSON.parse(raw));
  } catch {
    throw unsafeDockerEnvironment();
  }
}

function exactRecord(value, expected) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => value[key] === item);
}

async function docker(args, environment) {
  const { stdout } = await execFileAsync("docker", args, {
    encoding: "utf8",
    env: { ...environment },
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
  if (contract.resource === "egress" && (
    value.Scope !== "local"
    || value.Ingress !== false
    || value.EnableIPv6 !== false
    || !exactRecord(value.Options, contract.options)
    || typeof value.IPAM !== "object" || value.IPAM === null || Array.isArray(value.IPAM)
    || Object.keys(value.IPAM).length !== 3
    || value.IPAM.Driver !== "default"
    || !(value.IPAM.Options === null || exactRecord(value.IPAM.Options, {}))
    || !Array.isArray(value.IPAM.Config) || value.IPAM.Config.length !== 1
    || !exactRecord(value.IPAM.Config[0], { Subnet: contract.subnet, Gateway: contract.gateway })
  )) throw invalidNetwork();
}

export async function prepareRuntimeNetwork({ environment = process.env, runDocker } = {}) {
  assertLocalDockerEnvironment(environment);
  const invokeDocker = runDocker ?? ((args) => docker(args, environment));
  await assertSelectedLocalDockerContext(invokeDocker);
  for (const contract of networkContracts) {
    const listed = (await invokeDocker([
      "network", "ls", "--filter", `name=^${contract.name}$`, "--format", "{{.Name}}",
    ])).trim();
    if (listed !== "" && listed !== contract.name) throw invalidNetwork();
    if (listed === "") {
      await invokeDocker([
        "network", "create", "--driver", "bridge",
        ...(contract.internal ? ["--internal"] : []),
        ...(contract.resource === "egress" ? [
          "--subnet", contract.subnet,
          "--gateway", contract.gateway,
          "--opt", "com.docker.network.bridge.enable_ip_masquerade=true",
        ] : []),
        "--label", "core-agent.managed=runtime-v1",
        "--label", `core-agent.resource=${contract.resource}`,
        "--label", `core-agent.network=${contract.name}`,
        contract.name,
      ]);
    }
    validateInspection(await invokeDocker([
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
