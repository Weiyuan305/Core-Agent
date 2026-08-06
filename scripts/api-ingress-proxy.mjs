#!/usr/bin/env node

import { createConnection, createServer } from "node:net";
import { pathToFileURL } from "node:url";

const maximumConnections = 32;
const idleTimeoutMs = 6 * 60 * 1_000;

function ingressError() {
  return new Error("API ingress failed");
}

function validHost(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 255
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

function validPort(value, allowZero) {
  return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65_535;
}

export async function startApiIngressProxy({
  listenHost,
  listenPort,
  upstreamHost,
  upstreamPort,
} = {}) {
  if (
    !validHost(listenHost)
    || !validPort(listenPort, true)
    || !validHost(upstreamHost)
    || !validPort(upstreamPort, false)
  ) throw ingressError();

  const active = new Set();
  const server = createServer({ allowHalfOpen: false }, (client) => {
    if (active.size >= maximumConnections) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: upstreamHost, port: upstreamPort });
    const pair = Object.freeze({ client, upstream });
    active.add(pair);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.setTimeout(idleTimeoutMs, () => client.destroy());
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    const fail = () => {
      client.destroy();
      upstream.destroy();
    };
    const release = () => {
      if (client.destroyed && upstream.destroyed) active.delete(pair);
    };
    client.once("error", fail);
    upstream.once("error", fail);
    client.once("close", () => {
      upstream.destroy();
      release();
    });
    upstream.once("close", () => {
      client.destroy();
      release();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = maximumConnections;
  await new Promise((resolve, reject) => {
    const failed = () => reject(ingressError());
    server.once("error", failed);
    server.listen(listenPort, listenHost, () => {
      server.off("error", failed);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address !== "object" || !validPort(address.port, false)) {
    server.close();
    throw ingressError();
  }
  let closing;
  return Object.freeze({
    port: address.port,
    close() {
      if (closing !== undefined) return closing;
      for (const { client, upstream } of active) {
        client.destroy();
        upstream.destroy();
      }
      closing = new Promise((resolve) => server.close(() => resolve()));
      return closing;
    },
  });
}

async function main() {
  if (process.argv.length !== 2) throw ingressError();
  const ingress = await startApiIngressProxy({
    listenHost: "0.0.0.0", listenPort: 8787,
    upstreamHost: "api", upstreamPort: 8787,
  });
  const shutdown = () => {
    void ingress.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("API ingress failed\n");
    process.exitCode = 1;
  });
}
