import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  RuntimeSupervisorClient,
  canonicalSupervisorRequestHash,
  validateSupervisorRequest,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import { OperationJournal } from "../src/operation-journal.js";
import { RuntimeSupervisorServer } from "../src/server.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imageRef = `managed/runtime@sha256:${"a".repeat(64)}`;
const singletonLockName = ".core-agent-runtime-supervisor.lock";

function request(operationId: string): SupervisorRequestV1 {
  const data = {
    protocol_version: 1 as const,
    operation_id: operationId,
    kind: "inspect" as const,
    tenant_id: "tenant_a",
    runtime_id: "runtime_a",
    generation: 1,
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function accepted(operationId: string): SupervisorResponseV1 {
  return {
    protocol_version: 1,
    operation_id: operationId,
    outcome: "accepted",
    observation: {
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 1,
      exists: true,
      lifecycle: "running",
      health: "healthy",
      image_ref: imageRef,
      private_origin: "http://172.30.0.7:8642",
    },
  };
}

let temporaryRoot: string;
let socketPath: string;

test.beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".supervisor-server-test-"));
  socketPath = join(temporaryRoot, "supervisor.sock");
});

test.afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function buildServer(
  execute: (request: SupervisorRequestV1, signal: AbortSignal) => Promise<SupervisorResponseV1>,
  options: { operationTimeoutMs?: number; shutdownTimeoutMs?: number } = {},
) {
  return new RuntimeSupervisorServer({
    socketPath,
    journal: new OperationJournal({ directory: join(temporaryRoot, "journal") }),
    validateRequest: validateSupervisorRequest,
    execute,
    ...options,
  });
}

test("Unix service validates, journals, frames one response, and creates a 0660 socket", async () => {
  let dispatches = 0;
  const server = buildServer(async (value) => {
    dispatches += 1;
    return accepted(value.operation_id);
  });
  await server.start();
  try {
    assert.equal((await lstat(socketPath)).mode & 0o777, 0o660);
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const first = await client.execute(request("operation_server_replay"));
    const replay = await client.execute(request("operation_server_replay"));
    assert.deepEqual(replay, first);
    assert.equal(dispatches, 1);
  } finally {
    await server.close();
  }
});

test("concurrent Supervisor starts elect exactly one singleton owner before bind", async () => {
  const first = buildServer(async (value) => accepted(value.operation_id));
  const second = buildServer(async (value) => accepted(value.operation_id));
  const starts = await Promise.allSettled([first.start(), second.start()]);
  const winners = starts.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);
  const lockPath = join(temporaryRoot, singletonLockName);
  try {
    assert.equal(winners.length, 1);
    assert.equal((await lstat(lockPath)).mode & 0o777, 0o600);
    const owner = winners[0] === 0 ? first : second;
    const reply = await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 })
      .execute(request("operation_singleton_winner"));
    assert.equal(reply.outcome, "accepted");
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("a second Supervisor cannot disturb the first live owner or its socket", async () => {
  const first = buildServer(async (value) => accepted(value.operation_id));
  const second = buildServer(async (value) => accepted(value.operation_id));
  await first.start();
  try {
    await assert.rejects(second.start(), /SUPERVISOR_REJECTED/);
    const reply = await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 })
      .execute(request("operation_first_owner_survives"));
    assert.equal(reply.outcome, "accepted");
  } finally {
    await second.close();
    await first.close();
  }
});

test("Supervisor recovers only a dead-PID singleton record and releases its nonce", async () => {
  const lockPath = join(temporaryRoot, singletonLockName);
  await writeFile(lockPath, `${JSON.stringify({
    protocol_version: 1,
    pid: 2_147_483_647,
    nonce: "a".repeat(64),
  })}\n`, { mode: 0o600 });
  const server = buildServer(async (value) => accepted(value.operation_id));
  await server.start();
  const owned = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; nonce: string };
  assert.equal(owned.pid, process.pid);
  assert.notEqual(owned.nonce, "a".repeat(64));
  await server.close();
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("Supervisor never unlinks a connectable current-uid socket after stale-lock recovery", async () => {
  const raw = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    raw.once("error", reject);
    raw.listen(socketPath, resolve);
  });
  const lockPath = join(temporaryRoot, singletonLockName);
  await writeFile(lockPath, `${JSON.stringify({
    protocol_version: 1,
    pid: 2_147_483_647,
    nonce: "b".repeat(64),
  })}\n`, { mode: 0o600 });
  const supervisor = buildServer(async (value) => accepted(value.operation_id));
  try {
    await assert.rejects(supervisor.start(), /SUPERVISOR_REJECTED/);
    assert.equal((await lstat(socketPath)).isSocket(), true);
  } finally {
    await supervisor.close();
    await new Promise<void>((resolve) => raw.close(() => resolve()));
  }
});

test("Unix service refuses unsafe parents and never unlinks a non-socket", async () => {
  await chmod(temporaryRoot, 0o777);
  await assert.rejects(buildServer(async (value) => accepted(value.operation_id)).start(), /SUPERVISOR_REJECTED/);
  await chmod(temporaryRoot, 0o700);

  await writeFile(socketPath, "preserve-me", { mode: 0o600 });
  await assert.rejects(buildServer(async (value) => accepted(value.operation_id)).start(), /SUPERVISOR_REJECTED/);
  assert.equal(await readFile(socketPath, "utf8"), "preserve-me");
});

test("Unix service caps execution at four and waits for abort settlement before journaling", async () => {
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capped = buildServer(async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await released;
    active -= 1;
    return accepted(value.operation_id);
  });
  await capped.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 2_000 });
    const responses = Array.from({ length: 5 }, (_, index) => client.execute(request(`operation_cap_${index}`)));
    const deadline = Date.now() + 1_000;
    while (maximum < 4 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(maximum, 4);
    assert.equal(active, 4);
    release();
    assert.equal((await Promise.all(responses)).every((item) => item.outcome === "accepted"), true);
    assert.equal(maximum, 4);
  } finally {
    release();
    await capped.close();
  }

  socketPath = join(temporaryRoot, "deadline.sock");
  let aborted = false;
  let dispatches = 0;
  let mutations = 0;
  let releaseTimed!: () => void;
  const timedReleased = new Promise<void>((resolve) => { releaseTimed = resolve; });
  let observeAbort!: () => void;
  const abortObserved = new Promise<void>((resolve) => { observeAbort = resolve; });
  const timed = buildServer(async (value, signal) => {
    dispatches += 1;
    signal.addEventListener("abort", () => {
      aborted = true;
      observeAbort();
    }, { once: true });
    await timedReleased;
    mutations += 1;
    return accepted(value.operation_id);
  }, { operationTimeoutMs: 25, shutdownTimeoutMs: 100 });
  await timed.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    let firstSettled = false;
    const first = client.execute(request("operation_deadline")).finally(() => { firstSettled = true; });
    await abortObserved;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(firstSettled, false);
    assert.equal(dispatches, 1);
    assert.equal(mutations, 0);
    assert.equal((await readdir(join(temporaryRoot, "journal"))).some((name) => name.endsWith(".json")), false);

    let replaySettled = false;
    const replay = client.execute(request("operation_deadline")).finally(() => { replaySettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replaySettled, false);
    assert.equal(dispatches, 1);

    releaseTimed();
    const [response, replayed] = await Promise.all([first, replay]);
    assert.equal(response.outcome, "accepted");
    assert.deepEqual(replayed, response);
    assert.equal(mutations, 1);
    assert.equal((await readdir(join(temporaryRoot, "journal"))).some((name) => name.endsWith(".json")), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mutations, 1);
  } finally {
    releaseTimed();
    await timed.close();
  }
});
