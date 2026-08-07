import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalPayloadHash,
  createSyntheticConversationRequest,
  createSyntheticRunRequest,
  createManagedRuntimeDependencies,
  readSmokeEvents,
  restartApiWorkerTopology,
  runControlPlaneSmoke,
  runManagedRuntimeSession,
  smokePublicErrorCode,
  waitForApiReadiness,
} from "../../scripts/lib/managed-runtime-session.mjs";
import * as managedRuntimeModule from "../../scripts/lib/managed-runtime-session.mjs";
import * as smokeWrapper from "../../scripts/smoke-control-plane.mjs";

const wrapperSource = await readFile(
  new URL("../../scripts/smoke-control-plane.mjs", import.meta.url),
  "utf8",
);

test("managed Runtime implementation is behind a thin smoke compatibility wrapper", () => {
  assert.equal(typeof createManagedRuntimeDependencies, "function");
  assert.equal(smokeWrapper.runControlPlaneSmoke, runControlPlaneSmoke);
  assert.equal(smokeWrapper.createManagedRuntimeDependencies, createManagedRuntimeDependencies);
  assert.equal(smokeWrapper.smokePublicErrorCode, smokePublicErrorCode);

  for (const forbidden of [
    /\bdocker\b/iu,
    /readProtectedSecret/u,
    /SELECT|INSERT|UPDATE|DELETE FROM/u,
    /provider_secret_ref/u,
    /text\/event-stream/u,
    /message\.delta/u,
  ]) {
    assert.doesNotMatch(wrapperSource, forbidden);
  }
  assert.match(wrapperSource, /export \* from "\.\/lib\/managed-runtime-session\.mjs"/u);
  assert.match(wrapperSource, /process\.once\("SIGINT"/u);
  assert.match(wrapperSource, /process\.once\("SIGTERM"/u);
});

test("managed topology rebuilds current service images before migration and startup", async () => {
  const startControlPlaneTopology = managedRuntimeModule.startControlPlaneTopology;
  assert.equal(typeof startControlPlaneTopology, "function");
  const calls = [];
  await startControlPlaneTopology((command, args, options) => {
    calls.push([command, args, options]);
  });
  assert.deepEqual(calls, [[
    "docker",
    [
      "compose",
      "--project-name",
      "core-agent-runtime-v1-smoke",
      "-f",
      "infra/runtime/compose.dev.yaml",
      "up",
      "-d",
      "--build",
      "postgres",
      "migrate",
      "api",
      "api-ingress",
      "worker",
      "supervisor",
    ],
    { timeoutMs: 180_000, maxOutputBytes: 4 * 1024 * 1024 },
  ]]);
});

test("smoke public errors remain fixed and never reflect unknown failures", () => {
  assert.equal(smokePublicErrorCode(new Error("private failure detail")), "SMOKE_FAILED");
  assert.equal(smokePublicErrorCode({ code: "PRIVATE_DETAIL" }), "SMOKE_FAILED");
});

const managedContext = Object.freeze({
  tenantId: "synthetic-managed-tenant",
  profileId: "synthetic-managed-profile",
  runtimeId: `runtime_${"a".repeat(32)}`,
});
const managedRuntime = Object.freeze({ observed_state: "ready" });

function lifecycleFixture(overrides = {}) {
  const calls = [];
  const dependencies = {
    validatePrerequisites: async () => calls.push("validatePrerequisites"),
    startTopology: async () => calls.push("startTopology"),
    prepareProvisioningContext: () => {
      calls.push("prepareProvisioningContext");
      return managedContext;
    },
    provision: async (context) => {
      assert.equal(context, managedContext);
      calls.push("provision");
    },
    pollRuntime: async (context) => {
      assert.equal(context, managedContext);
      calls.push("pollRuntime");
      return managedRuntime;
    },
    deleteRuntime: async () => calls.push("deleteRuntime"),
    waitForContainerRemoval: async () => calls.push("waitForContainerRemoval"),
    stopTopology: async () => calls.push("stopTopology"),
    releaseProductImageLockSnapshot: async () => calls.push("releaseProductImageLockSnapshot"),
    releaseSecrets: async () => calls.push("releaseSecrets"),
    ...overrides,
  };
  return { calls, dependencies };
}

test("managed Runtime session owns one ordered lifecycle and default cleanup", async () => {
  const fixture = lifecycleFixture();
  const value = await runManagedRuntimeSession({
    environment: {},
    keepRuntime: false,
    dependencies: fixture.dependencies,
    use: async (session) => {
      fixture.calls.push("use");
      assert.ok(Object.isFrozen(session));
      assert.equal(session.context, managedContext);
      assert.equal(session.runtime, managedRuntime);
      assert.equal(session.operations, fixture.dependencies);
      return "synthetic-use-result";
    },
  });

  assert.equal(value, "synthetic-use-result");
  assert.deepEqual(fixture.calls, [
    "validatePrerequisites",
    "startTopology",
    "prepareProvisioningContext",
    "provision",
    "pollRuntime",
    "use",
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Runtime session continues cleanup and preserves its first cleanup error", async () => {
  const deleteFailure = new Error("private delete detail");
  const fixture = lifecycleFixture({
    deleteRuntime: async () => {
      fixture.calls.push("deleteRuntime");
      throw deleteFailure;
    },
    waitForContainerRemoval: async () => {
      fixture.calls.push("waitForContainerRemoval");
      throw new Error("private wait detail");
    },
    stopTopology: async () => {
      fixture.calls.push("stopTopology");
      throw new Error("private stop detail");
    },
  });

  await assert.rejects(
    runManagedRuntimeSession({
      environment: {},
      keepRuntime: false,
      dependencies: fixture.dependencies,
      use: async () => fixture.calls.push("use"),
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED"
      && error.message === "SMOKE_STAGE_FAILED"
      && error.cause === deleteFailure,
  );
  assert.deepEqual(fixture.calls.slice(-5), [
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Runtime session cleans after use failure and always releases secrets", async () => {
  const useFailure = new Error("private use detail");
  const fixture = lifecycleFixture();
  await assert.rejects(
    runManagedRuntimeSession({
      environment: {},
      keepRuntime: false,
      dependencies: fixture.dependencies,
      use: async () => {
        fixture.calls.push("use");
        throw useFailure;
      },
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === useFailure,
  );
  assert.deepEqual(fixture.calls.slice(-5), [
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Runtime kept success preserves topology and snapshot but zeroizes secrets", async () => {
  const fixture = lifecycleFixture();
  await runManagedRuntimeSession({
    environment: {},
    keepRuntime: true,
    dependencies: fixture.dependencies,
    use: async () => fixture.calls.push("use"),
  });
  assert.deepEqual(fixture.calls, [
    "validatePrerequisites",
    "startTopology",
    "prepareProvisioningContext",
    "provision",
    "pollRuntime",
    "use",
    "releaseSecrets",
  ]);
});

test("managed Runtime retention is committed only after its retention hook succeeds", async () => {
  const successful = lifecycleFixture();
  await runManagedRuntimeSession({
    environment: {},
    keepRuntime: true,
    dependencies: successful.dependencies,
    prepareRetention: async ({ context, runtime, operations }) => {
      assert.equal(context, managedContext);
      assert.equal(runtime, managedRuntime);
      assert.equal(operations, successful.dependencies);
      successful.calls.push("prepareRetention");
    },
    use: async () => successful.calls.push("use"),
  });
  assert.deepEqual(successful.calls, [
    "validatePrerequisites",
    "startTopology",
    "prepareProvisioningContext",
    "provision",
    "pollRuntime",
    "use",
    "prepareRetention",
    "releaseSecrets",
  ]);

  const failed = lifecycleFixture();
  const retentionFailure = new Error("private receipt failure");
  await assert.rejects(
    runManagedRuntimeSession({
      environment: {},
      keepRuntime: true,
      dependencies: failed.dependencies,
      prepareRetention: async () => {
        failed.calls.push("prepareRetention");
        throw retentionFailure;
      },
      use: async () => failed.calls.push("use"),
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === retentionFailure,
  );
  assert.deepEqual(failed.calls, [
    "validatePrerequisites",
    "startTopology",
    "prepareProvisioningContext",
    "provision",
    "pollRuntime",
    "use",
    "prepareRetention",
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Run requests hash the caller's bounded synthetic content", () => {
  const request = createSyntheticRunRequest(
    { tenantId: "synthetic-runtime-v1-0123456789abcdef" },
    "caller supplied synthetic follow-up",
    { nonce: "0123456789abcdef" },
  );
  assert.equal(request.input_message.content, "caller supplied synthetic follow-up");
  assert.equal(
    request.payload_hash,
    canonicalPayloadHash({
      schema_version: request.schema_version,
      idempotency_key: request.idempotency_key,
      client_request_id: request.client_request_id,
      input_message: request.input_message,
    }),
  );
  assert.match(request.idempotency_key, /^synthetic-run-.+-0123456789abcdef$/u);
  assert.match(request.input_message.client_message_id, /^synthetic-message-.+-0123456789abcdef$/u);

  for (const content of ["", "   ", "x".repeat(4_001), "unsafe\u0000control"]) {
    assert.throws(
      () => createSyntheticRunRequest(
        { tenantId: "synthetic-runtime-v1-0123456789abcdef" },
        content,
        { nonce: "0123456789abcdef" },
      ),
      /SMOKE_MESSAGE_CONTENT_INVALID/,
    );
  }
});

test("managed explicit retry requests bind one stable child to the failed parent", () => {
  const identifiers = { tenantId: "synthetic-runtime-v1-0123456789abcdef" };
  const options = {
    nonce: "fedcba9876543210",
    parentRunId: "synthetic-failed-parent",
  };
  const first = createSyntheticRunRequest(identifiers, "server held message", options);
  const replay = createSyntheticRunRequest(identifiers, "server held message", options);
  assert.deepEqual(replay, first);
  assert.equal(first.parent_run_id, "synthetic-failed-parent");
  assert.equal(first.idempotency_key, "synthetic-run-synthetic-runtime-v1-0123456789abcdef-fedcba9876543210");
  assert.equal(
    first.payload_hash,
    canonicalPayloadHash({
      schema_version: first.schema_version,
      idempotency_key: first.idempotency_key,
      client_request_id: first.client_request_id,
      input_message: first.input_message,
      parent_run_id: first.parent_run_id,
    }),
  );
  assert.throws(
    () => createSyntheticRunRequest(identifiers, "server held message", {
      parentRunId: "synthetic-failed-parent",
    }),
    /SMOKE_SYNTHETIC_INPUT_REQUIRED/,
  );
});

test("managed Conversation requests use a fresh idempotency identity for /new", () => {
  const identifiers = {
    tenantId: "synthetic-runtime-v1-0123456789abcdef",
    profileId: "synthetic-runtime-v1-profile-0123456789abcdef",
  };
  const first = createSyntheticConversationRequest(identifiers, "0123456789abcdef");
  const second = createSyntheticConversationRequest(identifiers, "fedcba9876543210");
  assert.notEqual(first.idempotency_key, second.idempotency_key);
  assert.notEqual(first.payload_hash, second.payload_hash);
  assert.equal(first.tenant_id, identifiers.tenantId);
  assert.equal(first.profile_id, identifiers.profileId);
});

function sessionProductEvent({
  eventType,
  sequence,
  runId,
  tenantId = "synthetic-managed-tenant",
  conversationId = "synthetic-managed-conversation",
  payload,
}) {
  return {
    schema_version: 1,
    event_id: `synthetic-managed-event-${sequence}`,
    occurred_at: "2026-08-06T12:00:00.000Z",
    sequence,
    tenant_id: tenantId,
    request_id: "synthetic-managed-request",
    trace_id: "synthetic-managed-trace",
    correlation_id: "synthetic-managed-correlation",
    causation_id: "synthetic-managed-causation",
    conversation_id: conversationId,
    run_id: runId,
    event_type: eventType,
    payload,
  };
}

function sessionEventStream(events) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("managed SSE emits deltas only for the active Run in one Conversation", async () => {
  const deltas = [];
  const events = await readSmokeEvents({
    conversationId: "synthetic-managed-conversation",
    tenantId: "synthetic-managed-tenant",
    runId: "synthetic-managed-run-b",
    bootstrapKey: Buffer.from("synthetic-managed-key"),
    onDelta: async (delta) => deltas.push(delta),
    fetchImpl: async () => sessionEventStream([
      sessionProductEvent({
        eventType: "message.delta",
        sequence: 1,
        runId: "synthetic-managed-run-a",
        payload: { message_id: "synthetic-message-a", delta: "hidden old delta" },
      }),
      sessionProductEvent({
        eventType: "run.completed",
        sequence: 2,
        runId: "synthetic-managed-run-a",
        payload: { run_id: "synthetic-managed-run-a", status: "succeeded" },
      }),
      sessionProductEvent({
        eventType: "message.delta",
        sequence: 3,
        runId: "synthetic-managed-run-b",
        payload: { message_id: "synthetic-message-b", delta: "visible current delta" },
      }),
      sessionProductEvent({
        eventType: "run.completed",
        sequence: 4,
        runId: "synthetic-managed-run-b",
        payload: { run_id: "synthetic-managed-run-b", status: "succeeded" },
      }),
    ]),
  });
  assert.deepEqual(deltas, ["visible current delta"]);
  assert.deepEqual(events, {
    eventTypes: ["message.delta", "run.completed"],
    terminal: { status: "succeeded" },
  });
});

test("managed SSE applies safety limits only to the active Run", async () => {
  const deltas = [];
  const events = await readSmokeEvents({
    conversationId: "synthetic-managed-conversation",
    tenantId: "synthetic-managed-tenant",
    runId: "synthetic-managed-run-current",
    bootstrapKey: Buffer.from("synthetic-managed-key"),
    onDelta: async (delta) => deltas.push(delta),
    limits: { maximumEvents: 2, maximumRetainedBytes: 1_000_000 },
    fetchImpl: async () => sessionEventStream([
      sessionProductEvent({
        eventType: "message.delta",
        sequence: 1,
        runId: "synthetic-managed-run-old",
        payload: { message_id: "synthetic-message-old", delta: "ignored old delta one" },
      }),
      sessionProductEvent({
        eventType: "message.delta",
        sequence: 2,
        runId: "synthetic-managed-run-old",
        payload: { message_id: "synthetic-message-old", delta: "ignored old delta two" },
      }),
      sessionProductEvent({
        eventType: "run.completed",
        sequence: 3,
        runId: "synthetic-managed-run-old",
        payload: { run_id: "synthetic-managed-run-old", status: "succeeded" },
      }),
      sessionProductEvent({
        eventType: "message.delta",
        sequence: 4,
        runId: "synthetic-managed-run-current",
        payload: { message_id: "synthetic-message-current", delta: "visible current delta" },
      }),
      sessionProductEvent({
        eventType: "run.completed",
        sequence: 5,
        runId: "synthetic-managed-run-current",
        payload: { run_id: "synthetic-managed-run-current", status: "succeeded" },
      }),
    ]),
  });

  assert.deepEqual(deltas, ["visible current delta"]);
  assert.deepEqual(events, {
    eventTypes: ["message.delta", "run.completed"],
    terminal: { status: "succeeded" },
  });
});

test("managed SSE returns an allowlisted failed terminal and maps legacy absence", async () => {
  const common = {
    conversationId: "synthetic-managed-conversation",
    tenantId: "synthetic-managed-tenant",
    runId: "synthetic-managed-run-b",
    bootstrapKey: Buffer.from("synthetic-managed-key"),
  };
  const failed = await readSmokeEvents({
    ...common,
    fetchImpl: async () => sessionEventStream([
      sessionProductEvent({
        eventType: "run.failed",
        sequence: 1,
        runId: common.runId,
        payload: {
          run_id: common.runId,
          status: "failed",
          failure_code: "MODEL_BUSY",
        },
      }),
    ]),
  });
  assert.deepEqual(failed, {
    eventTypes: ["run.failed"],
    terminal: { status: "failed", failureCode: "MODEL_BUSY" },
  });

  const legacy = await readSmokeEvents({
    ...common,
    fetchImpl: async () => sessionEventStream([
      sessionProductEvent({
        eventType: "run.failed",
        sequence: 1,
        runId: common.runId,
        payload: { run_id: common.runId, status: "failed" },
      }),
    ]),
  });
  assert.deepEqual(legacy.terminal, {
    status: "failed",
    failureCode: "RUN_FAILURE_UNKNOWN",
  });

  await assert.rejects(
    readSmokeEvents({
      ...common,
      fetchImpl: async () => sessionEventStream([
        sessionProductEvent({
          eventType: "run.failed",
          sequence: 1,
          runId: common.runId,
          payload: {
            run_id: common.runId,
            status: "failed",
            failure_code: "raw-provider-body",
          },
        }),
      ]),
    }),
    /SMOKE_SSE_FAILED/,
  );
});

test("managed SSE rejects mismatched scope before emitting a delta", async () => {
  const deltas = [];
  await assert.rejects(
    readSmokeEvents({
      conversationId: "synthetic-managed-conversation",
      tenantId: "synthetic-managed-tenant",
      runId: "synthetic-managed-run-b",
      bootstrapKey: Buffer.from("synthetic-managed-key"),
      onDelta: (delta) => deltas.push(delta),
      fetchImpl: async () => sessionEventStream([
        sessionProductEvent({
          eventType: "message.delta",
          sequence: 1,
          tenantId: "synthetic-other-tenant",
          runId: "synthetic-managed-run-b",
          payload: { message_id: "synthetic-message-b", delta: "must not emit" },
        }),
      ]),
    }),
    /SMOKE_SSE_FAILED/,
  );
  assert.deepEqual(deltas, []);
});

test("managed API and Worker restart uses one exact Compose command, readiness, then a bounded stability window", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  await restartApiWorkerTopology({
    child: async (command, args) => calls.push([command, args]),
    waitUntilReady: async () => calls.push("ready"),
    stabilize: async (milliseconds, receivedSignal) => calls.push(["stable", milliseconds, receivedSignal]),
    signal,
  });
  assert.deepEqual(calls, [
    ["docker", [
      "compose",
      "--project-name",
      "core-agent-runtime-v1-smoke",
      "-f",
      "infra/runtime/compose.dev.yaml",
      "up",
      "-d",
      "--force-recreate",
      "api",
      "worker",
    ]],
    "ready",
    ["stable", 2_000, signal],
  ]);
});

test("managed API readiness retries bounded startup failures and stops at its deadline", async () => {
  const calls = [];
  let attempts = 0;
  await waitForApiReadiness({
    attempt: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("synthetic startup race");
    },
    pause: async (milliseconds) => calls.push(milliseconds),
    now: () => 0,
    timeoutMs: 1_000,
    pollMs: 25,
  });
  assert.equal(attempts, 3);
  assert.deepEqual(calls, [25, 25]);

  const times = [0, 11];
  await assert.rejects(
    waitForApiReadiness({
      attempt: async () => { throw new Error("synthetic unavailable"); },
      pause: async () => assert.fail("deadline failure must not pause"),
      now: () => times.shift() ?? 11,
      timeoutMs: 10,
      pollMs: 1,
    }),
    /SMOKE_API_REQUEST_FAILED/u,
  );
});
