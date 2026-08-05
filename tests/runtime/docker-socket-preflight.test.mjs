import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const preflightUrl = pathToFileURL(new URL("../../scripts/preflight-runtime-docker-socket.mjs", import.meta.url).pathname).href;

async function loadPreflight() {
  const module = await import(`${preflightUrl}?test=${Date.now()}`).catch(() => undefined);
  assert(module, "runtime Docker socket preflight module must exist");
  return module;
}

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("socket policy accepts only an absolute daemon-side source and the exact final identity", async () => {
  const preflight = await loadPreflight();
  const environment = {
    CORE_AGENT_DOCKER_SOCKET_SOURCE: "/var/run/docker.sock.raw",
    CORE_AGENT_DOCKER_SOCKET_PATH: "/var/run/docker.sock",
    CORE_AGENT_RUNTIME_UID: "501",
    CORE_AGENT_SUPERVISOR_SOCKET_GID: "20",
    CORE_AGENT_DOCKER_GID: "0",
  };
  assert.deepEqual(preflight.resolveDockerSocketPolicy(environment, {
    uid: 501,
    gid: 20,
    groups: [0, 20],
  }), {
    source: "/var/run/docker.sock.raw",
    target: "/var/run/docker.sock",
    runtimeUid: 501,
    runtimeGid: 20,
    dockerGid: 0,
  });
  for (const source of ["docker.sock", "tcp://127.0.0.1:2375", "/", "/var/run/../docker.sock", "/var/run/docker.sock\nother"]) {
    assert.throws(
      () => preflight.resolveDockerSocketPolicy({ ...environment, CORE_AGENT_DOCKER_SOCKET_SOURCE: source }, { uid: 501, gid: 20, groups: [0, 20] }),
      /runtime Docker socket preflight failed/u,
      source,
    );
  }
  assert.throws(
    () => preflight.resolveDockerSocketPolicy(environment, { uid: 502, gid: 20, groups: [0, 20] }),
    /runtime Docker socket preflight failed/u,
  );
  assert.throws(
    () => preflight.resolveDockerSocketPolicy(environment, { uid: 501, gid: 20, groups: [20] }),
    /runtime Docker socket preflight failed/u,
  );
});

test("socket policy accepts local Unix Docker contexts and rejects remote transports", async () => {
  const preflight = await loadPreflight();
  assert.equal(
    preflight.validateLocalDockerContextEndpoint("unix:///Users/synthetic/.colima/default/docker.sock"),
    "/Users/synthetic/.colima/default/docker.sock",
  );
  assert.equal(preflight.validateLocalDockerContextEndpoint("unix:///var/run/docker.sock"), "/var/run/docker.sock");
  for (const endpoint of [
    "ssh://operator@example.invalid/var/run/docker.sock",
    "tcp://127.0.0.1:2375",
    "npipe:////./pipe/docker_engine",
    "unix://relative/docker.sock",
    "unix:///var/run/../docker.sock",
  ]) assert.throws(() => preflight.validateLocalDockerContextEndpoint(endpoint), /runtime Docker socket preflight failed/u, endpoint);
});

test("socket preflight validates socket metadata and sends only a bounded Docker _ping", async (t) => {
  const preflight = await loadPreflight();
  const root = await mkdtemp(join(tmpdir(), "core-agent-docker-ping-"));
  const socketPath = join(root, "docker.sock");
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("OK");
  });
  t.after(async () => {
    await close(server);
    await rm(root, { recursive: true, force: true });
  });
  await listen(server, socketPath);
  await chmod(socketPath, 0o660);

  const metadata = await preflight.inspectDockerSocket(socketPath, process.getgid());
  assert.equal(metadata.path, socketPath);
  await preflight.pingDockerSocket(socketPath, { timeoutMs: 500 });
  assert.deepEqual(requests, [{ method: "GET", url: "/_ping" }]);
});

test("Docker _ping fails closed on timeout and non-exact responses", async (t) => {
  const preflight = await loadPreflight();
  const root = await mkdtemp(join(tmpdir(), "core-agent-docker-ping-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const wrongPath = join(root, "wrong.sock");
  const wrong = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("NOT OK");
  });
  await listen(wrong, wrongPath);
  await assert.rejects(preflight.pingDockerSocket(wrongPath, { timeoutMs: 500 }), /runtime Docker socket preflight failed/u);
  await close(wrong);

  const stalledPath = join(root, "stalled.sock");
  const stalled = createServer(() => undefined);
  await listen(stalled, stalledPath);
  await assert.rejects(preflight.pingDockerSocket(stalledPath, { timeoutMs: 25 }), /runtime Docker socket preflight failed/u);
  await close(stalled);
});
