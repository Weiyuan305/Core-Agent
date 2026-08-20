import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  RuntimeSupervisorClient,
  SUPERVISOR_DEADLINE_BUDGET,
  canonicalSupervisorRequestHash,
  validateSupervisorRequest,
  type ProvisionRuntimeCommandDataV1,
  type SupervisorRequestV1,
  type SupervisorResponseV1,
} from "@core-agent/runtime-core";

import { OperationJournal } from "../src/operation-journal.js";
import { RuntimeSupervisorServer } from "../src/server.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const imageRef = `managed/runtime@sha256:${"a".repeat(64)}`;
const singletonLockName = ".core-agent-runtime-supervisor.lock";
const socketTestTempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();

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

function provisionRequest(operationId: string): SupervisorRequestV1 {
  const data: ProvisionRuntimeCommandDataV1 = {
    protocol_version: 1,
    operation_id: operationId,
    kind: "provision",
    runtime: {
      tenant_id: "tenant_a",
      runtime_id: "runtime_a",
      generation: 1,
      image_ref: imageRef,
      platform: "linux/amd64",
      volume_ref: "volume_a",
      ingress_secret_ref: { reference_id: "ingress_a", version: 1, purpose: "hermes_ingress" },
      profiles: [{
        profile_id: "profile_a",
        hermes_profile_ref: "profile_a",
        description: "Synthetic profile",
        provider_config_id: "provider_a",
        provider_base_url: "https://provider.example/v1",
        model_id: "model_a",
        provider_secret_ref: { reference_id: "provider_a", version: 1, purpose: "model_provider" },
      }],
    },
  };
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function assertPendingJournal(journalRoot: string, value: SupervisorRequestV1): Promise<void> {
  const digest = createHash("sha256").update(value.operation_id).digest("hex");
  const path = join(journalRoot, `${digest}.json`);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(record, {
    operation_id: value.operation_id,
    protocol_version: 1,
    request_hash: value.request_hash,
    stage: "reserved",
    state: "pending",
  });
  assert.equal("completed_at" in record, false);
  assert.equal("response" in record, false);
  assert.equal(await readFile(path, "utf8"), `${canonicalJson(record)}\n`);
}

async function assertTerminalJournal(journalRoot: string, value: SupervisorRequestV1): Promise<void> {
  const digest = createHash("sha256").update(value.operation_id).digest("hex");
  const path = join(journalRoot, `${digest}.json`);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const text = await readFile(path, "utf8");
  const record = JSON.parse(text) as Record<string, unknown>;
  assert.equal(record.operation_id, value.operation_id);
  assert.equal(record.request_hash, value.request_hash);
  assert.equal(record.protocol_version, 1);
  assert.equal(typeof record.completed_at, "string");
  assert.deepEqual(record.response, accepted(value.operation_id));
  assert.equal("state" in record, false);
  assert.equal("stage" in record, false);
  assert.equal(text, `${canonicalJson(record)}\n`);
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

async function waitForTestSignal(signal: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`test signal deadline exceeded: ${label}`)), 2_000);
  });
  try {
    await Promise.race([signal, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let temporaryRoot: string;
let socketRoot: string;
let socketPath: string;

test.beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(repositoryRoot, ".supervisor-server-test-"));
  socketRoot = await mkdtemp(join(socketTestTempRoot, "core-supervisor-socket-"));
  socketPath = join(socketRoot, "supervisor.sock");
});

test.afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
  await rm(socketRoot, { recursive: true, force: true });
});

function buildServer(
  execute: (request: SupervisorRequestV1, signal: AbortSignal) => Promise<SupervisorResponseV1>,
  options: {
    maximumConcurrent?: number;
    admissionTimeoutMs?: number;
    effectTimeoutMs?: number;
    operationTimeoutMs?: number;
    cancellationSettlementTimeoutMs?: number;
    shutdownTimeoutMs?: number;
  } = {},
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

test("a settled retryable provision failure releases its reserved journal for exact retry", async () => {
  let dispatches = 0;
  const target = provisionRequest("operation_provision_retryable");
  const server = buildServer(async (value) => {
    dispatches += 1;
    if (dispatches === 1) return {
      protocol_version: 1,
      operation_id: value.operation_id,
      outcome: "failed",
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
      summary: "synthetic settled dependency failure",
    };
    return accepted(value.operation_id);
  });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const first = await client.execute(target);
    assert.equal(first.outcome, "failed");
    const digest = createHash("sha256").update(target.operation_id).digest("hex");
    await assert.rejects(lstat(join(temporaryRoot, "journal", `${digest}.json`)), { code: "ENOENT" });

    const second = await client.execute(target);
    assert.equal(second.outcome, "accepted");
    assert.equal(dispatches, 2);
    await assertTerminalJournal(join(temporaryRoot, "journal"), target);
  } finally {
    await server.close();
  }
});

test("concurrent Supervisor starts elect exactly one singleton owner before bind", async () => {
  const first = buildServer(async (value) => accepted(value.operation_id));
  const second = buildServer(async (value) => accepted(value.operation_id));
  const starts = await Promise.allSettled([first.start(), second.start()]);
  const winners = starts.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);
  const lockPath = join(socketRoot, singletonLockName);
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
  const lockPath = join(socketRoot, singletonLockName);
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
  const lockPath = join(socketRoot, singletonLockName);
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
  await chmod(socketRoot, 0o777);
  await assert.rejects(buildServer(async (value) => accepted(value.operation_id)).start(), /SUPERVISOR_REJECTED/);
  await chmod(socketRoot, 0o700);

  await writeFile(socketPath, "preserve-me", { mode: 0o600 });
  await assert.rejects(buildServer(async (value) => accepted(value.operation_id)).start(), /SUPERVISOR_REJECTED/);
  assert.equal(await readFile(socketPath, "utf8"), "preserve-me");
});

test("Unix service rejects deadline configuration outside the shared production budget", () => {
  const execute = async (value: SupervisorRequestV1) => accepted(value.operation_id);
  assert.throws(
    () => buildServer(execute, { operationTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.operationTimeoutMs + 1 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, {
      cancellationSettlementTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.cancellationSettlementTimeoutMs + 1,
    }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { cancellationSettlementTimeoutMs: 0 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { admissionTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.admissionTimeoutMs + 1 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { admissionTimeoutMs: 0 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { admissionTimeoutMs: 100, operationTimeoutMs: 100 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { effectTimeoutMs: SUPERVISOR_DEADLINE_BUDGET.effectTimeoutMs + 1 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { admissionTimeoutMs: 100, effectTimeoutMs: 100, operationTimeoutMs: 200 }),
    /SUPERVISOR_REJECTED/,
  );
  assert.throws(
    () => buildServer(execute, { admissionTimeoutMs: 50, effectTimeoutMs: 100, operationTimeoutMs: 100 }),
    /SUPERVISOR_REJECTED/,
  );
});

test("effect cancellation fires before the outer operation response window", async () => {
  let abortObserved = false;
  let markExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => { markExecutionStarted = resolve; });
  const server = buildServer(async (value, signal) => {
    markExecutionStarted();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        abortObserved = true;
        setTimeout(resolve, 150);
      }, { once: true });
    });
    return {
      protocol_version: 1,
      operation_id: value.operation_id,
      outcome: "failed",
      code: "DEPENDENCY_TIMEOUT",
      retryable: true,
      summary: "synthetic effect cancellation",
    };
  }, {
    admissionTimeoutMs: 250,
    effectTimeoutMs: 500,
    operationTimeoutMs: 1_200,
    cancellationSettlementTimeoutMs: 250,
  });
  await server.start();
  try {
    const responsePromise = new RuntimeSupervisorClient({ socketPath, timeoutMs: 2_000 })
      .execute(request("operation_effect_deadline"));
    await waitForTestSignal(executionStarted, "effect execution started");
    const response = await responsePromise;
    assert.equal(abortObserved, true);
    assert.equal(response.outcome, "failed");
    if (response.outcome === "failed") assert.equal(response.code, "DEPENDENCY_TIMEOUT");
  } finally {
    await server.close();
  }
});

test("journal attachment precedes capacity so retries consume no execution slots", async () => {
  let dispatches = 0;
  let markBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = buildServer(async (value) => {
    dispatches += 1;
    if (value.operation_id === "operation_slot_owner") {
      markBlocked();
      await released;
    }
    return accepted(value.operation_id);
  }, { maximumConcurrent: 2 });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const owner = client.execute(request("operation_slot_owner"));
    await blocked;
    const retries = Array.from({ length: 3 }, () => (
      client.execute(request("operation_slot_owner")).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
    ));
    const unrelatedResult = await client.execute(request("operation_slot_unrelated")).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert("value" in unrelatedResult, String("error" in unrelatedResult ? unrelatedResult.error : "missing response"));
    const unrelated = unrelatedResult.value;
    assert.equal(unrelated.outcome, "accepted");
    assert.equal(dispatches, 2);
    release();
    const ownerResponse = await owner;
    const replayed = await Promise.all(retries);
    assert.equal(replayed.every((result) => "value" in result), true);
    assert.deepEqual(replayed.map((result) => "value" in result ? result.value : undefined), [
      ownerResponse,
      ownerResponse,
      ownerResponse,
    ]);
    assert.equal(dispatches, 2);
  } finally {
    release();
    await server.close();
  }
});

test("busy admission is bounded and non-durable so a later retry can dispatch", async () => {
  let dispatches = 0;
  let markBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => { markBlocked = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = buildServer(async (value) => {
    dispatches += 1;
    if (value.operation_id === "operation_busy_owner") {
      markBlocked();
      await released;
    }
    return accepted(value.operation_id);
  }, { maximumConcurrent: 1, admissionTimeoutMs: 100 });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const owner = client.execute(request("operation_busy_owner")).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await blocked;
    const busyResult = await client.execute(request("operation_busy_retry")).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert("value" in busyResult, String("error" in busyResult ? busyResult.error : "missing response"));
    const busy = busyResult.value;
    assert.equal(busy.outcome, "failed");
    if (busy.outcome === "failed") {
      assert.equal(busy.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(busy.retryable, true);
    }
    assert.equal(dispatches, 1);
    const journalRoot = join(temporaryRoot, "journal");
    await assertPendingJournal(journalRoot, request("operation_busy_owner"));
    const ownerDigest = createHash("sha256").update("operation_busy_owner").digest("hex");
    const retryDigest = createHash("sha256").update("operation_busy_retry").digest("hex");
    assert.equal((await lstat(join(journalRoot, `${ownerDigest}.guard.sqlite`))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(journalRoot, `${retryDigest}.guard.sqlite`))).mode & 0o777, 0o600);
    await assert.rejects(lstat(join(journalRoot, `${retryDigest}.json`)), { code: "ENOENT" });

    release();
    assert("value" in await owner);
    const retried = await client.execute(request("operation_busy_retry"));
    assert.equal(retried.outcome, "accepted");
    assert.equal(dispatches, 2);
    await assertTerminalJournal(journalRoot, request("operation_busy_owner"));
    await assertTerminalJournal(journalRoot, request("operation_busy_retry"));
  } finally {
    release();
    await server.close();
  }
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

  socketPath = join(socketRoot, "deadline.sock");
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
  }, { admissionTimeoutMs: 100, effectTimeoutMs: 250, operationTimeoutMs: 500, shutdownTimeoutMs: 100 });
  await timed.start();
  try {
    const journalRecordsBefore = (await readdir(join(temporaryRoot, "journal")))
      .filter((name) => name.endsWith(".json")).length;
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    let firstSettled = false;
    const first = client.execute(request("operation_deadline")).finally(() => { firstSettled = true; });
    await waitForTestSignal(abortObserved, "effect deadline abort");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(firstSettled, false);
    assert.equal(dispatches, 1);
    assert.equal(mutations, 0);
    assert.equal(
      (await readdir(join(temporaryRoot, "journal"))).filter((name) => name.endsWith(".json")).length,
      journalRecordsBefore + 1,
    );
    await assertPendingJournal(join(temporaryRoot, "journal"), request("operation_deadline"));

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
    assert.equal(
      (await readdir(join(temporaryRoot, "journal"))).filter((name) => name.endsWith(".json")).length,
      journalRecordsBefore + 1,
    );
    await assertTerminalJournal(join(temporaryRoot, "journal"), request("operation_deadline"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mutations, 1);
  } finally {
    releaseTimed();
    await timed.close();
  }
});

test("an unsettled cancellation returns a bounded transient timeout without releasing its stable journal reservation", async () => {
  let dispatches = 0;
  let mutations = 0;
  let observeAbort!: () => void;
  const abortObserved = new Promise<void>((resolve) => { observeAbort = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = buildServer(async (value, signal) => {
    dispatches += 1;
    signal.addEventListener("abort", observeAbort, { once: true });
    await released;
    mutations += 1;
    return accepted(value.operation_id);
  }, {
    admissionTimeoutMs: 100,
    effectTimeoutMs: 250,
    operationTimeoutMs: 500,
    cancellationSettlementTimeoutMs: 100,
    shutdownTimeoutMs: 50,
  });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const first = client.execute(request("operation_unsettled_deadline"));
    await waitForTestSignal(abortObserved, "unsettled cancellation abort");
    const response = await first;
    assert.equal(response.outcome, "failed");
    if (response.outcome === "failed") assert.equal(response.code, "DEPENDENCY_TIMEOUT");
    assert.equal(dispatches, 1);
    assert.equal(mutations, 0);
    await assertPendingJournal(join(temporaryRoot, "journal"), request("operation_unsettled_deadline"));

    let replaySettled = false;
    const replay = client.execute(request("operation_unsettled_deadline")).finally(() => { replaySettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replaySettled, false);
    assert.equal(dispatches, 1);

    release();
    const replayed = await replay;
    assert.equal(replayed.outcome, "accepted");
    assert.equal(mutations, 1);
    await assertTerminalJournal(join(temporaryRoot, "journal"), request("operation_unsettled_deadline"));
  } finally {
    release();
    await server.close();
  }
});
