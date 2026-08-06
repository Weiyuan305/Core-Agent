#!/usr/bin/env node

import { lstat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dockerSocketTarget = "/var/run/docker.sock";
const maximumPathBytes = 4_096;
const maximumPingBytes = 16;
const productionPingTimeoutMs = 3_000;

function preflightError() {
  return new Error("runtime Docker socket preflight failed");
}

function numericIdentity(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,9})$/u.test(value)) throw preflightError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4_294_967_294) throw preflightError();
  return parsed;
}

function absoluteSocketPath(value) {
  if (
    typeof value !== "string"
    || value === "/"
    || Buffer.byteLength(value, "utf8") > maximumPathBytes
    || !isAbsolute(value)
    || resolve(value) !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw preflightError();
  return value;
}

export function validateLocalDockerContextEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) throw preflightError();
  return absoluteSocketPath(endpoint.slice("unix://".length));
}

export function resolveDockerSocketPolicy(environment = process.env, identity = {
  uid: process.getuid?.(),
  gid: process.getgid?.(),
  groups: process.getgroups?.(),
}) {
  try {
    const source = absoluteSocketPath(environment.CORE_AGENT_DOCKER_SOCKET_SOURCE);
    if (environment.CORE_AGENT_DOCKER_SOCKET_PATH !== dockerSocketTarget) throw preflightError();
    const runtimeUid = numericIdentity(environment.CORE_AGENT_RUNTIME_UID);
    const runtimeGid = numericIdentity(environment.CORE_AGENT_SUPERVISOR_SOCKET_GID);
    const dockerGid = numericIdentity(environment.CORE_AGENT_DOCKER_GID);
    if (
      identity?.uid !== runtimeUid
      || identity.gid !== runtimeGid
      || !Array.isArray(identity.groups)
      || !identity.groups.includes(dockerGid)
    ) throw preflightError();
    return { source, target: dockerSocketTarget, runtimeUid, runtimeGid, dockerGid };
  } catch {
    throw preflightError();
  }
}

export async function inspectDockerSocket(socketPath, dockerGid, inspect = lstat) {
  try {
    const path = absoluteSocketPath(socketPath);
    if (!Number.isSafeInteger(dockerGid) || dockerGid < 0 || dockerGid > 4_294_967_294) throw preflightError();
    const metadata = await inspect(path);
    if (!metadata.isSocket() || metadata.gid !== dockerGid || (metadata.mode & 0o777) !== 0o660) throw preflightError();
    return { path, uid: metadata.uid, gid: metadata.gid, mode: metadata.mode & 0o777 };
  } catch {
    throw preflightError();
  }
}

export async function pingDockerSocket(socketPath, { timeoutMs = productionPingTimeoutMs } = {}) {
  const path = absoluteSocketPath(socketPath);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > productionPingTimeoutMs) throw preflightError();
  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let response;
    let timer;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response?.destroy();
      rejectPromise(preflightError());
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const request = httpRequest({
      socketPath: path,
      method: "GET",
      path: "/_ping",
      headers: { accept: "text/plain", connection: "close", host: "docker" },
    }, (incoming) => {
      response = incoming;
      if (incoming.statusCode !== 200) {
        incoming.resume();
        fail();
        return;
      }
      const chunks = [];
      let size = 0;
      incoming.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maximumPingBytes) {
          fail();
          return;
        }
        chunks.push(bytes);
      });
      incoming.once("end", () => {
        if (settled) return;
        const body = Buffer.concat(chunks, size);
        if (body.length !== 2 || body[0] !== 0x4f || body[1] !== 0x4b) fail();
        else succeed();
      });
      incoming.once("error", fail);
    });
    request.once("error", fail);
    request.end();
    timer = setTimeout(() => {
      request.destroy(preflightError());
      fail();
    }, timeoutMs);
  });
}

export async function preflightRuntimeDockerSocket({ environment = process.env } = {}) {
  const policy = resolveDockerSocketPolicy(environment);
  await inspectDockerSocket(policy.target, policy.dockerGid);
  await pingDockerSocket(policy.target);
}

async function main() {
  if (process.argv.length !== 2) throw preflightError();
  await preflightRuntimeDockerSocket();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("runtime Docker socket preflight failed\n");
    process.exitCode = 1;
  });
}
