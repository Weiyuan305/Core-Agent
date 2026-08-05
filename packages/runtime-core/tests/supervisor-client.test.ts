import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as runtimeCore from "../src/index.js";
import {
  FakeRuntimeSupervisorServer,
  RuntimeSupervisorClient,
  canonicalSupervisorRequestHash,
  type ProvisionRuntimeCommandDataV1,
  type SupervisorRequestV1,
} from "../src/index.js";

const imageRef = `nousresearch/hermes-agent:v2026.7.30@sha256:${"a".repeat(64)}`;

function provisionData(overrides: Partial<ProvisionRuntimeCommandDataV1["runtime"]> = {}): ProvisionRuntimeCommandDataV1 {
  return {
    protocol_version: 1,
    operation_id: "operation_provision_1",
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
      ...overrides,
    },
  };
}

function signed(data: ProvisionRuntimeCommandDataV1 = provisionData()): SupervisorRequestV1 {
  return { ...data, request_hash: canonicalSupervisorRequestHash(data) };
}

let temporaryDirectory: string;
let socketPath: string;

test.beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "core-agent-supervisor-"));
  socketPath = join(temporaryDirectory, "supervisor.sock");
});

test.afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("Supervisor client handles one response delivered through arbitrary partial reads", async () => {
  const server = new FakeRuntimeSupervisorServer({ socketPath, responseChunkBytes: 1 });
  await server.start();
  try {
    const request = signed();
    const response = await new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 }).execute(request);
    assert.equal(response.outcome, "accepted");
    assert.equal(response.operation_id, request.operation_id);
    assert.deepEqual(server.requests, [request]);
  } finally {
    await server.close();
  }
});

test("Supervisor fake replays the same operation hash and rejects a changed hash", async () => {
  let dispatches = 0;
  const server = new FakeRuntimeSupervisorServer({
    socketPath,
    dispatch: (request) => {
      dispatches += 1;
      return {
        protocol_version: 1,
        operation_id: request.operation_id,
        outcome: "rejected",
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: true,
        summary: "Synthetic dependency outage",
      };
    },
  });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const request = signed();
    const first = await client.execute(request);
    const replay = await client.execute(request);
    assert.deepEqual(replay, first);
    assert.equal(dispatches, 1);
    assert.equal(server.requests.length, 1);

    const changedData = provisionData({ generation: 2 });
    const changed = signed({ ...changedData, operation_id: request.operation_id });
    const rejected = await client.execute(changed);
    assert.deepEqual(rejected, {
      protocol_version: 1,
      operation_id: request.operation_id,
      outcome: "rejected",
      code: "SUPERVISOR_REJECTED",
      retryable: false,
      summary: "Operation ID was already used for different request metadata",
    });
    assert.equal(dispatches, 1);
  } finally {
    await server.close();
  }
});

test("Supervisor fake reserves an operation before concurrent dispatch completes", async () => {
  let dispatches = 0;
  let enterDispatch!: () => void;
  let releaseDispatch!: () => void;
  const dispatchEntered = new Promise<void>((resolve) => {
    enterDispatch = resolve;
  });
  const dispatchReleased = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const server = new FakeRuntimeSupervisorServer({
    socketPath,
    dispatch: async (request) => {
      dispatches += 1;
      enterDispatch();
      await dispatchReleased;
      return {
        protocol_version: 1,
        operation_id: request.operation_id,
        outcome: "rejected",
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: true,
        summary: "Synthetic dependency outage",
      };
    },
  });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const request = signed();
    const firstPromise = client.execute(request);
    await dispatchEntered;

    const replayPromise = client.execute(request);
    const changedData = provisionData({ generation: 2 });
    const changed = signed({ ...changedData, operation_id: request.operation_id });
    const changedPromise = client.execute(changed);
    const stillWaiting = Symbol("still waiting");
    const changedBeforeRelease = await Promise.race([
      changedPromise,
      new Promise<typeof stillWaiting>((resolve) => setTimeout(() => resolve(stillWaiting), 100)),
    ]);
    const dispatchesBeforeRelease = dispatches;

    releaseDispatch();
    const [first, replay, changedResponse] = await Promise.all([firstPromise, replayPromise, changedPromise]);
    assert.notEqual(changedBeforeRelease, stillWaiting);
    assert.equal(dispatchesBeforeRelease, 1);
    assert.deepEqual(replay, first);
    assert.deepEqual(changedResponse, {
      protocol_version: 1,
      operation_id: request.operation_id,
      outcome: "rejected",
      code: "SUPERVISOR_REJECTED",
      retryable: false,
      summary: "Operation ID was already used for different request metadata",
    });
    assert.equal(dispatches, 1);
    assert.equal(server.requests.length, 1);
  } finally {
    releaseDispatch();
    await server.close();
  }
});

test("Supervisor fake finalizes a rejected dispatch as one replayable failure", async () => {
  let dispatches = 0;
  const server = new FakeRuntimeSupervisorServer({
    socketPath,
    dispatch: async () => {
      dispatches += 1;
      throw new Error("sentinel dispatch failure");
    },
  });
  await server.start();
  try {
    const client = new RuntimeSupervisorClient({ socketPath, timeoutMs: 1_000 });
    const request = signed();
    const [first, replay] = await Promise.all([client.execute(request), client.execute(request)]);
    assert.deepEqual(first, {
      protocol_version: 1,
      operation_id: request.operation_id,
      outcome: "failed",
      code: "DEPENDENCY_UNAVAILABLE",
      retryable: true,
      summary: "Synthetic Supervisor dispatch failed",
    });
    assert.deepEqual(replay, first);
    assert.equal(dispatches, 1);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("Supervisor client applies a bounded timeout and redacts transport details", async () => {
  const acceptedSockets = new Set<Socket>();
  const server = createServer((socket) => {
    acceptedSockets.add(socket);
    socket.on("close", () => {
      acceptedSockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(
      new RuntimeSupervisorClient({ socketPath, timeoutMs: 25 }).execute(signed()),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /DEPENDENCY_TIMEOUT/);
        assert.doesNotMatch(error.message, /core-agent-supervisor|operation_provision_1|tenant_a/);
        return true;
      },
    );
    assert.throws(
      () => new RuntimeSupervisorClient({ socketPath, timeoutMs: runtimeCore.MAX_SUPERVISOR_TIMEOUT_MS + 1 }),
      /DEPENDENCY_TIMEOUT/,
    );
  } finally {
    for (const socket of acceptedSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Supervisor production deadline budget orders effect, operation, and client wait", () => {
  const exported = runtimeCore as unknown as Record<string, unknown>;
  const budget = exported.SUPERVISOR_DEADLINE_BUDGET as undefined | {
    readonly initializerTimeoutMs: number;
    readonly verifierTimeoutMs: number;
    readonly reconciliationTimeoutMs: number;
    readonly effectOverheadMs: number;
    readonly effectTimeoutMs: number;
    readonly operationTimeoutMs: number;
    readonly cancellationSettlementTimeoutMs: number;
    readonly admissionTimeoutMs: number;
    readonly clientTimeoutMs: number;
  };

  assert(budget !== undefined);
  assert.equal(Object.isFrozen(budget), true);
  assert(budget.initializerTimeoutMs > 0);
  assert(budget.verifierTimeoutMs > 0);
  assert(budget.reconciliationTimeoutMs > 0);
  assert(budget.effectOverheadMs > 0);
  assert(
    budget.initializerTimeoutMs
      + budget.verifierTimeoutMs
      + (budget.reconciliationTimeoutMs * 3)
      + budget.effectOverheadMs
      < budget.effectTimeoutMs,
  );
  assert(budget.effectTimeoutMs < budget.operationTimeoutMs);
  assert(budget.cancellationSettlementTimeoutMs > 0);
  assert(budget.admissionTimeoutMs > 0);
  assert(budget.admissionTimeoutMs < budget.effectTimeoutMs);
  assert(
    budget.admissionTimeoutMs
      + budget.operationTimeoutMs
      + budget.cancellationSettlementTimeoutMs
      < budget.clientTimeoutMs,
  );
  assert.equal(runtimeCore.MAX_SUPERVISOR_TIMEOUT_MS, budget.clientTimeoutMs);
});

test("Supervisor default client accepts an operation beyond the former ten-second ceiling", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const server = new FakeRuntimeSupervisorServer({
    socketPath,
    dispatch: async (request) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10_001));
      return {
        protocol_version: 1,
        operation_id: request.operation_id,
        outcome: "accepted",
        observation: {
          tenant_id: request.kind === "provision" ? request.runtime.tenant_id : request.tenant_id,
          runtime_id: request.kind === "provision" ? request.runtime.runtime_id : request.runtime_id,
          generation: request.kind === "provision" ? request.runtime.generation : request.generation,
          exists: true,
          lifecycle: "running",
          health: "healthy",
          image_ref: request.kind === "provision" ? request.runtime.image_ref : imageRef,
        },
      };
    },
  });
  await server.start();
  try {
    const pending = new RuntimeSupervisorClient({ socketPath }).execute(signed());
    while (server.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    context.mock.timers.tick(10_001);
    const response = await pending;
    assert.equal(response.outcome, "accepted");
  } finally {
    await server.close();
  }
});
