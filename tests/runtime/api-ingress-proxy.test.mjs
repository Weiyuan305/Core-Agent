import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import test from "node:test";

import { startApiIngressProxy } from "../../scripts/api-ingress-proxy.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return address.port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("API ingress transparently proxies a bounded TCP connection to one fixed upstream", async (t) => {
  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const ingress = await startApiIngressProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    upstreamHost: "127.0.0.1",
    upstreamPort,
  });
  t.after(async () => {
    await ingress.close();
    await close(upstream);
  });

  const response = await new Promise((resolve, reject) => {
    const client = createConnection({ host: "127.0.0.1", port: ingress.port });
    client.once("error", reject);
    client.once("connect", () => client.write("synthetic-api-ingress-probe"));
    client.once("data", (chunk) => {
      resolve(chunk.toString("utf8"));
      client.end();
    });
  });
  assert.equal(response, "synthetic-api-ingress-probe");
});

test("API ingress executable keeps production endpoints fixed and rejects arguments", async () => {
  const source = await readFile(new URL("../../scripts/api-ingress-proxy.mjs", import.meta.url), "utf8");
  assert.match(source, /listenHost: "0\.0\.0\.0", listenPort: 8787/u);
  assert.match(source, /upstreamHost: "api", upstreamPort: 8787/u);
  assert.match(source, /process\.argv\.length !== 2/u);
  assert.doesNotMatch(source, /process\.env/u);
});
