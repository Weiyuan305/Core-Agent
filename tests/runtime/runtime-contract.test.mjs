import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as smokeModule from "../../scripts/smoke-control-plane.mjs";
import {
  SMOKE_OUTPUT_KEYS,
  assertManagedContainerInspection,
  canonicalPayloadHash,
  parseSmokeArguments,
  readProtectedSecret,
  runBoundedChild,
  runControlPlaneSmoke,
  validateProductImageLock,
  validateSmokeEnvironment,
  validateSyntheticIdentifiers,
} from "../../scripts/smoke-control-plane.mjs";

const {
  createSmokeChildEnvironment,
  readSmokeEvents,
  stageProductImageLockSnapshot,
} = smokeModule;

const smokeWrapperSource = await readFile(
  new URL("../../scripts/smoke-control-plane.mjs", import.meta.url),
  "utf8"
);
const managedRuntimeSessionSource = await readFile(
  new URL("../../scripts/lib/managed-runtime-session.mjs", import.meta.url),
  "utf8",
);
const smokeSource = `${smokeWrapperSource}\n${managedRuntimeSessionSource}`;

const smokeEnvironment = Object.freeze({
  CORE_AGENT_REAL_HERMES_SMOKE: "1",
  CORE_AGENT_PLATFORM: "linux/arm64",
  CORE_AGENT_NODE_IMAGE: "node:22-bookworm-slim@sha256:" + "a".repeat(64),
  CORE_AGENT_POSTGRES_IMAGE: "postgres:17-bookworm@sha256:" + "b".repeat(64),
  CORE_AGENT_HERMES_IMAGE_LOCK_FILE: "/safe/config/reviewed-product-images.lock.json",
  CORE_AGENT_BOOTSTRAP_KEY_FILE: "/safe/bootstrap/key",
  CORE_AGENT_POSTGRES_BOOTSTRAP_PASSWORD_FILE: "/safe/database/bootstrap-password",
  CORE_AGENT_DATABASE_MIGRATOR_PASSWORD_FILE: "/safe/database/migrator-password",
  CORE_AGENT_DATABASE_APP_PASSWORD_FILE: "/safe/database/app-password",
  CORE_AGENT_DATABASE_IDENTITY_PASSWORD_FILE: "/safe/database/identity-password",
  CORE_AGENT_PROVIDER_SECRET_ROOT: "/safe/provider",
  CORE_AGENT_INGRESS_SECRET_ROOT: "/safe/ingress",
  CORE_AGENT_SUPERVISOR_STATE_ROOT: "/safe/state",
  CORE_AGENT_API_UID: "12000",
  CORE_AGENT_API_GID: "12000",
  CORE_AGENT_CREDENTIAL_MOUNT_UID: "0",
  CORE_AGENT_CREDENTIAL_MOUNT_GID: "0",
  CORE_AGENT_RUNTIME_UID: "501",
  CORE_AGENT_SUPERVISOR_SOCKET_GID: "20",
  CORE_AGENT_DOCKER_GID: "100",
  CORE_AGENT_DOCKER_SOCKET_SOURCE: "/var/run/docker.sock.raw",
});

test("smoke output is an allowlist of IDs, states, event types, and counts", () => {
  assert.deepEqual([...SMOKE_OUTPUT_KEYS].sort(), [
    "assistant_message_count",
    "conversation_id",
    "event_types",
    "profile_id",
    "run_id",
    "run_status",
    "runtime_id",
    "runtime_state",
    "tenant_id",
  ]);
  assert.doesNotMatch(smokeSource, /console\.(?:log|error)\([^)]*(?:prompt|content|key|secret|authorization)/i);
  assert.doesNotMatch(smokeSource, /fixtures\/(?:customer|student|production|real)/i);
});

test("REAL_HERMES smoke is explicit and rejects CLI and environment extras", () => {
  assert.throws(
    () => validateSmokeEnvironment({ ...smokeEnvironment, CORE_AGENT_REAL_HERMES_SMOKE: "0" }),
    /SMOKE_OPT_IN_REQUIRED/,
  );
  assert.throws(
    () => validateSmokeEnvironment({ ...smokeEnvironment, CORE_AGENT_SMOKE_CUSTOMER_FIXTURE: "customer.json" }),
    /SMOKE_ENVIRONMENT_INVALID/,
  );
  assert.throws(
    () => validateSmokeEnvironment({ ...smokeEnvironment, CORE_AGENT_RUNTIME_GID: "20" }),
    /SMOKE_ENVIRONMENT_INVALID/,
  );
  for (const name of ["CORE_AGENT_RUNTIME_UID", "CORE_AGENT_SUPERVISOR_SOCKET_GID", "CORE_AGENT_DOCKER_GID"]) {
    assert.throws(
      () => validateSmokeEnvironment({ ...smokeEnvironment, [name]: "0" }),
      /SMOKE_ENVIRONMENT_INVALID/,
    );
  }
  assert.deepEqual(parseSmokeArguments(["--keep-runtime"]), { keepRuntime: true });
  assert.throws(() => parseSmokeArguments(["--keep-runtime", "--keep-runtime"]), /SMOKE_ARGUMENT_INVALID/);
  assert.throws(() => parseSmokeArguments(["--tenant", "anything"]), /SMOKE_ARGUMENT_INVALID/);
});

test("REAL_HERMES rejects ambient Docker endpoint overrides before any Docker call", async () => {
  for (const dockerHost of [
    "ssh://operator@example.invalid/var/run/docker.sock",
    "tcp://127.0.0.1:2375",
  ]) {
    const calls = [];
    await assert.rejects(
      runControlPlaneSmoke({
        environment: { ...smokeEnvironment, DOCKER_HOST: dockerHost },
        argv: [],
        dependencies: {
          validatePrerequisites: async () => calls.push("docker-context-inspect-returned-unix"),
        },
      }),
      (error) => error?.code === "SMOKE_DOCKER_HOST_UNSUPPORTED"
        && error.message === "SMOKE_DOCKER_HOST_UNSUPPORTED"
        && !error.message.includes(dockerHost),
    );
    assert.deepEqual(calls, [], "DOCKER_HOST must fail before even a Unix context inspection or any Docker call");
  }
});

test("REAL_HERMES child environment never propagates ambient DOCKER_HOST", () => {
  const previous = Object.getOwnPropertyDescriptor(process.env, "DOCKER_HOST");
  process.env.DOCKER_HOST = "ssh://operator@example.invalid/var/run/docker.sock";
  try {
    const childEnvironment = createSmokeChildEnvironment(smokeEnvironment);
    assert.equal(Object.hasOwn(childEnvironment, "DOCKER_HOST"), false);
  } finally {
    if (previous === undefined) delete process.env.DOCKER_HOST;
    else Object.defineProperty(process.env, "DOCKER_HOST", previous);
  }
});

test("REAL_HERMES child environment carries the closed API target and credential source identities", () => {
  validateSmokeEnvironment(smokeEnvironment);
  const childEnvironment = createSmokeChildEnvironment(smokeEnvironment);
  assert.deepEqual(
    Object.fromEntries([
      "CORE_AGENT_API_UID",
      "CORE_AGENT_API_GID",
      "CORE_AGENT_CREDENTIAL_MOUNT_UID",
      "CORE_AGENT_CREDENTIAL_MOUNT_GID",
    ].map((name) => [name, childEnvironment[name]])),
    {
      CORE_AGENT_API_UID: "12000",
      CORE_AGENT_API_GID: "12000",
      CORE_AGENT_CREDENTIAL_MOUNT_UID: "0",
      CORE_AGENT_CREDENTIAL_MOUNT_GID: "0",
    },
  );
  for (const override of [
    { CORE_AGENT_API_UID: "0" },
    { CORE_AGENT_API_UID: "999" },
    { CORE_AGENT_API_UID: "12003" },
    { CORE_AGENT_API_UID: "12004" },
    { CORE_AGENT_API_GID: "0" },
    { CORE_AGENT_CREDENTIAL_MOUNT_UID: "0", CORE_AGENT_CREDENTIAL_MOUNT_GID: "12000" },
    { CORE_AGENT_CREDENTIAL_MOUNT_UID: "12000", CORE_AGENT_CREDENTIAL_MOUNT_GID: "0" },
    { CORE_AGENT_CREDENTIAL_MOUNT_UID: "12001", CORE_AGENT_CREDENTIAL_MOUNT_GID: "12001" },
  ]) {
    assert.throws(() => validateSmokeEnvironment({ ...smokeEnvironment, ...override }), /SMOKE_ENVIRONMENT_INVALID/u);
  }
});

test("REAL_HERMES smoke accepts only fixed synthetic identifiers", () => {
  assert.doesNotThrow(() => validateSyntheticIdentifiers({
    tenantId: "synthetic-runtime-v1-tenant",
    tenantDisplayName: "synthetic-runtime-v1-tenant",
    actorId: "synthetic-runtime-v1-actor",
    actorDisplayName: "synthetic-runtime-v1-consultant",
    membershipId: "synthetic-runtime-v1-membership",
    profileId: "synthetic-runtime-v1-profile",
    profileDescription: "synthetic-runtime-v1-consultant",
    hermesProfileRef: "synthetic-runtime-v1-profile",
    promptIdentifier: "synthetic-runtime-v1-smoke",
  }));
  for (const [field, value] of [
    ["tenantId", "customer-1"],
    ["tenantDisplayName", "Example Company"],
    ["profileId", "consultant-1"],
    ["promptIdentifier", "hello"],
  ]) {
    assert.throws(
      () => validateSyntheticIdentifiers({
        tenantId: "synthetic-runtime-v1-tenant",
        tenantDisplayName: "synthetic-runtime-v1-tenant",
        actorId: "synthetic-runtime-v1-actor",
        actorDisplayName: "synthetic-runtime-v1-consultant",
        membershipId: "synthetic-runtime-v1-membership",
        profileId: "synthetic-runtime-v1-profile",
        profileDescription: "synthetic-runtime-v1-consultant",
        hermesProfileRef: "synthetic-runtime-v1-profile",
        promptIdentifier: "synthetic-runtime-v1-smoke",
        [field]: value,
      }),
      /SMOKE_SYNTHETIC_INPUT_REQUIRED/,
    );
  }
});

test("REAL_HERMES secret reader requires owner-only single-link regular files and clears its read buffer", async () => {
  const bytes = Buffer.from("synthetic-secret-sentinel-00000001\n", "utf8");
  const snapshots = [];
  const metadata = {
    dev: 1n, ino: 2n, nlink: 1n, uid: BigInt(process.getuid()),
    mode: 0o100600n, size: BigInt(bytes.length), mtimeNs: 3n, ctimeNs: 4n,
    isFile: () => true, isDirectory: () => false,
  };
  const result = await readProtectedSecret("/safe/bootstrap/key", {
    getuid: () => process.getuid(),
    lstat: async (path) => path === "/safe/bootstrap/key"
      ? metadata
      : { ...metadata, uid: 0n, mode: 0o040755n, isFile: () => false, isDirectory: () => true },
    open: async () => ({
      stat: async () => metadata,
      read: async (target) => {
        bytes.copy(target);
        snapshots.push(target);
        return { bytesRead: bytes.length };
      },
      close: async () => undefined,
    }),
  });
  assert.equal(result.toString("utf8"), "synthetic-secret-sentinel-00000001");
  result.fill(0);
  assert.equal(snapshots.length, 1);
  assert(snapshots[0].every((value) => value === 0));

  for (const changed of [
    { mode: 0o100644n },
    { nlink: 2n },
    { uid: BigInt(process.getuid()) + 1n },
    { isFile: () => false },
  ]) {
    await assert.rejects(
      readProtectedSecret("/safe/bootstrap/key", {
        getuid: () => process.getuid(),
        lstat: async (path) => path === "/safe/bootstrap/key"
          ? { ...metadata, ...changed }
          : { ...metadata, uid: 0n, mode: 0o040755n, isFile: () => false, isDirectory: () => true },
        open: async () => assert.fail("unsafe file must not be opened"),
      }),
      /SMOKE_SECRET_FILE_INVALID/,
    );
  }
});

test("REAL_HERMES child seam is argv-only, bounded, and abortable", async () => {
  let invocation;
  const output = await runBoundedChild("docker", ["compose", "version"], {
    timeoutMs: 1_000,
    maxOutputBytes: 128,
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "ok\n", stderr: "" };
    },
  });
  assert.equal(output, "ok\n");
  assert.deepEqual(invocation.command, "docker");
  assert.deepEqual(invocation.args, ["compose", "version"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.timeout, 1_000);
  assert.equal(invocation.options.maxBuffer, 128);
  const nodeOutput = await runBoundedChild("node", ["scripts/prepare-runtime-network.mjs"], {
    run: async () => ({ stdout: "node-ok\n", stderr: "" }),
  });
  assert.equal(nodeOutput, "node-ok\n");
  await assert.rejects(
    runBoundedChild("sh", ["-c", "docker ps"], { run: async () => assert.fail("must not run") }),
    /SMOKE_CHILD_COMMAND_INVALID/,
  );
});

test("REAL_HERMES managed container inspection enforces digest labels private network and closed command", () => {
  const imageRef = "core-agent/hermes-runtime:v1@sha256:" + "c".repeat(64);
  const inspected = {
    Config: {
      Image: imageRef,
      Env: ["API_SERVER_ENABLED=true"],
      Entrypoint: ["/opt/core-agent/gateway-entrypoint.sh"],
      Cmd: [],
      Labels: {
        "core-agent.managed": "runtime-v1",
        "core-agent.resource": "runtime",
        "core-agent.tenant-id": "synthetic-runtime-v1-tenant",
        "core-agent.runtime-id": "runtime-1",
        "core-agent.image-ref": imageRef,
        "core-agent.network": "core-agent-backplane",
      },
    },
    HostConfig: { NetworkMode: "core-agent-backplane", PortBindings: {} },
    NetworkSettings: { Ports: {}, Networks: { "core-agent-backplane": {}, "core-agent-egress": {} } },
  };
  assert.doesNotThrow(() => assertManagedContainerInspection(inspected, {
    imageRef,
    tenantId: "synthetic-runtime-v1-tenant",
    runtimeId: "runtime-1",
    secretValues: [Buffer.from("synthetic-secret-sentinel-00000001")],
  }));
  assert.throws(
    () => assertManagedContainerInspection({
      ...inspected,
      Config: { ...inspected.Config, Cmd: ["sh", "-c", "anything"] },
    }, {
      imageRef,
      tenantId: "synthetic-runtime-v1-tenant",
      runtimeId: "runtime-1",
      secretValues: [],
    }),
    /SMOKE_CONTAINER_INVALID/,
  );
});

test("REAL_HERMES workflow uses exact Compose project and cleans up after failure", async () => {
  const calls = [];
  const dependencies = {
    validatePrerequisites: async () => calls.push("validate"),
    startTopology: async () => calls.push("start:core-agent-runtime-v1-smoke"),
    provision: async () => {
      calls.push("provision");
      throw new Error("synthetic stage failure");
    },
    deleteRuntime: async () => calls.push("delete"),
    waitForContainerRemoval: async () => calls.push("wait-delete"),
    stopTopology: async ({ projectName, removeVolumes }) => calls.push(`stop:${projectName}:${removeVolumes}`),
    emit: () => assert.fail("failure must not emit stdout"),
    stage: () => undefined,
  };
  await assert.rejects(
    runControlPlaneSmoke({ environment: smokeEnvironment, argv: [], dependencies }),
    /SMOKE_STAGE_FAILED/,
  );
  assert.deepEqual(calls, [
    "validate",
    "start:core-agent-runtime-v1-smoke",
    "provision",
    "stop:core-agent-runtime-v1-smoke:false",
  ]);
});

const successfulContext = Object.freeze({
  tenantId: "synthetic-runtime-v1-tenant-success",
  tenantDisplayName: "synthetic-runtime-v1-tenant-success",
  actorId: "synthetic-runtime-v1-actor-success",
  actorDisplayName: "synthetic-runtime-v1-consultant",
  membershipId: "synthetic-runtime-v1-membership-success",
  profileId: "synthetic-runtime-v1-profile-success",
  profileDescription: "synthetic-runtime-v1-consultant",
  hermesProfileRef: "synthetic-runtime-v1-profile-success",
  promptIdentifier: "synthetic-runtime-v1-smoke",
  runtimeId: "runtime_" + "d".repeat(32),
});

function successfulSmokeDependencies(overrides = {}) {
  const calls = [];
  let emitted;
  const dependencies = {
    validatePrerequisites: async () => calls.push("validate"),
    startTopology: async ({ projectName }) => calls.push(`start:${projectName}`),
    prepareProvisioningContext: () => {
      calls.push("prepare-context");
      return successfulContext;
    },
    provision: async (context) => {
      assert.equal(context, successfulContext);
      calls.push("provision");
    },
    pollRuntime: async (context) => {
      assert.equal(context, successfulContext);
      calls.push("poll");
      return { observed_state: "ready", health_status: "healthy", generation: 1 };
    },
    createConversation: async () => {
      calls.push("conversation");
      return "synthetic-conversation-success";
    },
    createRun: async (_context, _conversationId, content) => {
      assert.equal(content, "synthetic-runtime-v1-smoke");
      calls.push("run");
      return "synthetic-run-success";
    },
    readEvents: async (_context, _conversationId, runId) => {
      assert.equal(runId, "synthetic-run-success");
      calls.push("events");
      return {
        eventTypes: ["run.queued", "run.completed"],
        terminal: { status: "succeeded" },
      };
    },
    queryRun: async () => {
      calls.push("query-run");
      return { status: "succeeded" };
    },
    countAssistantMessages: async () => {
      calls.push("count-messages");
      return 1;
    },
    inspectRuntime: async () => calls.push("inspect"),
    scanDatabase: async () => calls.push("scan-database"),
    deleteRuntime: async (context) => {
      assert.equal(context, successfulContext);
      calls.push("delete");
    },
    waitForContainerRemoval: async (context) => {
      assert.equal(context, successfulContext);
      calls.push("wait-delete");
    },
    stopTopology: async ({ projectName, removeVolumes }) => calls.push(`stop:${projectName}:${removeVolumes}`),
    releaseSecrets: async () => calls.push("zeroize-secrets"),
    releaseProductImageLockSnapshot: async () => calls.push("release-snapshot"),
    emit: (value) => {
      calls.push("emit");
      emitted = value;
    },
    stage: () => undefined,
    ...overrides,
  };
  return { calls, dependencies, emitted: () => emitted };
}

test("REAL_HERMES full workflow emits exact output after ordered default cleanup", async () => {
  const fixture = successfulSmokeDependencies();
  const output = await runControlPlaneSmoke({ environment: smokeEnvironment, argv: [], dependencies: fixture.dependencies });
  assert.deepEqual(output, {
    assistant_message_count: 1,
    conversation_id: "synthetic-conversation-success",
    event_types: ["run.queued", "run.completed"],
    profile_id: successfulContext.profileId,
    run_id: "synthetic-run-success",
    run_status: "succeeded",
    runtime_id: successfulContext.runtimeId,
    runtime_state: "ready",
    tenant_id: successfulContext.tenantId,
  });
  assert.deepEqual(fixture.emitted(), output);
  assert.deepEqual(fixture.calls, [
    "validate", "start:core-agent-runtime-v1-smoke", "prepare-context", "provision", "poll",
    "conversation", "run", "events", "query-run", "count-messages", "inspect", "scan-database",
    "delete", "wait-delete", "stop:core-agent-runtime-v1-smoke:false", "release-snapshot", "zeroize-secrets", "emit",
  ]);
});

test("REAL_HERMES --keep-runtime skips topology cleanup, zeroizes secrets, and preserves its snapshot", async () => {
  const fixture = successfulSmokeDependencies();
  await runControlPlaneSmoke({
    environment: smokeEnvironment,
    argv: ["--keep-runtime"],
    dependencies: fixture.dependencies,
  });
  assert(!fixture.calls.includes("delete"));
  assert(!fixture.calls.includes("wait-delete"));
  assert(!fixture.calls.some((call) => call.startsWith("stop:")));
  assert(!fixture.calls.includes("release-snapshot"));
  assert.deepEqual(fixture.calls.slice(-2), ["zeroize-secrets", "emit"]);
});

test("REAL_HERMES cleanup preserves its first error while continuing exact later cleanup", async () => {
  const deleteFailure = new Error("synthetic delete failure");
  const fixture = successfulSmokeDependencies({
    deleteRuntime: async () => {
      fixture.calls.push("delete");
      throw deleteFailure;
    },
    waitForContainerRemoval: async () => {
      fixture.calls.push("wait-delete");
      throw new Error("synthetic wait failure");
    },
    stopTopology: async ({ projectName, removeVolumes }) => {
      fixture.calls.push(`stop:${projectName}:${removeVolumes}`);
      throw new Error("synthetic stop failure");
    },
  });
  await assert.rejects(
    runControlPlaneSmoke({ environment: smokeEnvironment, argv: [], dependencies: fixture.dependencies }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === deleteFailure,
  );
  assert.deepEqual(fixture.calls.slice(-5), [
    "delete", "wait-delete", "stop:core-agent-runtime-v1-smoke:false", "release-snapshot", "zeroize-secrets",
  ]);
  assert.equal(fixture.emitted(), undefined);
});

test("REAL_HERMES recovers a response-loss orphan through its precomputed cleanup identity", async () => {
  const responseLoss = new Error("synthetic response lost after commit");
  const fixture = successfulSmokeDependencies({
    provision: async (context) => {
      assert.equal(context, successfulContext);
      fixture.calls.push("provision-response-lost");
      throw responseLoss;
    },
  });
  await assert.rejects(
    runControlPlaneSmoke({ environment: smokeEnvironment, argv: [], dependencies: fixture.dependencies }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === responseLoss,
  );
  assert.deepEqual(fixture.calls, [
    "validate", "start:core-agent-runtime-v1-smoke", "prepare-context", "provision-response-lost",
    "delete", "wait-delete", "stop:core-agent-runtime-v1-smoke:false", "release-snapshot", "zeroize-secrets",
  ]);
});

test("REAL_HERMES --keep-runtime releases a preflight snapshot before topology ownership", async () => {
  const preflightFailure = new Error("synthetic preflight failure after snapshot");
  const fixture = successfulSmokeDependencies({
    validatePrerequisites: async () => {
      fixture.calls.push("preflight-snapshot-staged");
      throw preflightFailure;
    },
  });
  await assert.rejects(
    runControlPlaneSmoke({
      environment: smokeEnvironment,
      argv: ["--keep-runtime"],
      dependencies: fixture.dependencies,
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === preflightFailure,
  );
  assert.deepEqual(fixture.calls, ["preflight-snapshot-staged", "release-snapshot", "zeroize-secrets"]);
});

test("REAL_HERMES --keep-runtime preserves a snapshot after partial topology ownership", async () => {
  const startFailure = new Error("synthetic partial topology failure");
  const fixture = successfulSmokeDependencies({
    startTopology: async ({ projectName }) => {
      fixture.calls.push(`partial-start:${projectName}`);
      throw startFailure;
    },
  });
  await assert.rejects(
    runControlPlaneSmoke({
      environment: smokeEnvironment,
      argv: ["--keep-runtime"],
      dependencies: fixture.dependencies,
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === startFailure,
  );
  assert.deepEqual(fixture.calls, [
    "validate", "partial-start:core-agent-runtime-v1-smoke", "zeroize-secrets",
  ]);
});

function productEvent(eventType, sequence, runId = "synthetic-run-success", payload = undefined) {
  return {
    schema_version: 1,
    event_id: `synthetic-event-${sequence}`,
    occurred_at: "2026-08-05T12:00:00.000Z",
    sequence,
    tenant_id: successfulContext.tenantId,
    request_id: "synthetic-request-success",
    trace_id: "synthetic-trace-success",
    correlation_id: "synthetic-correlation-success",
    causation_id: "synthetic-causation-success",
    conversation_id: "synthetic-conversation-success",
    run_id: runId,
    event_type: eventType,
    payload: payload ?? (eventType === "run.completed"
      ? { run_id: runId, status: "succeeded" }
      : { run_id: runId, status: "queued" }),
  };
}

function eventStreamResponse(events, contentType = "text/event-stream; charset=utf-8") {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": contentType } });
}

test("REAL_HERMES SSE requires a ProductEvent terminal envelope for the created run", async () => {
  assert.equal(typeof readSmokeEvents, "function", "readSmokeEvents must be exported as an injectable seam");
  const result = await readSmokeEvents({
    conversationId: "synthetic-conversation-success",
    tenantId: successfulContext.tenantId,
    runId: "synthetic-run-success",
    bootstrapKey: Buffer.from("synthetic-key"),
    fetchImpl: async () => eventStreamResponse([
      productEvent("run.queued", 1),
      productEvent("run.completed", 2),
    ]),
  });
  assert.deepEqual(result, {
    eventTypes: ["run.queued", "run.completed"],
    terminal: { status: "succeeded" },
  });
  for (const response of [
    eventStreamResponse([productEvent("run.completed", 1)], "application/json"),
    eventStreamResponse([productEvent("run.completed", 1, "synthetic-run-other")]),
    eventStreamResponse([{ event_type: "run.completed" }]),
  ]) {
    await assert.rejects(
      readSmokeEvents({
        conversationId: "synthetic-conversation-success",
        tenantId: successfulContext.tenantId,
        runId: "synthetic-run-success",
        bootstrapKey: Buffer.from("synthetic-key"),
        fetchImpl: async () => response,
      }),
      /SMOKE_SSE_FAILED/,
    );
  }
});

test("REAL_HERMES SSE bounds total events and aggregate retained bytes", async () => {
  assert.equal(typeof readSmokeEvents, "function", "readSmokeEvents must be exported as an injectable seam");
  const aggregateEvents = [
    productEvent("message.delta", 1, "synthetic-run-success", { message_id: "synthetic-message", delta: "x".repeat(300) }),
    productEvent("message.delta", 2, "synthetic-run-success", { message_id: "synthetic-message", delta: "y".repeat(300) }),
  ];
  const aggregateLimit = 1_200;
  assert(aggregateEvents.every((event) => Buffer.byteLength(JSON.stringify(event), "utf8") < aggregateLimit));
  assert(aggregateEvents.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"), 0) > aggregateLimit);
  await assert.rejects(
    readSmokeEvents({
      conversationId: "synthetic-conversation-success",
      tenantId: successfulContext.tenantId,
      runId: "synthetic-run-success",
      bootstrapKey: Buffer.from("synthetic-key"),
      fetchImpl: async () => eventStreamResponse([
        productEvent("run.queued", 1), productEvent("run.queued", 2), productEvent("run.queued", 3),
      ]),
      limits: { maximumEvents: 2, maximumRetainedBytes: 1_000_000 },
    }),
    /SMOKE_SSE_FAILED/,
  );
  await assert.rejects(
    readSmokeEvents({
      conversationId: "synthetic-conversation-success",
      tenantId: successfulContext.tenantId,
      runId: "synthetic-run-success",
      bootstrapKey: Buffer.from("synthetic-key"),
      fetchImpl: async () => eventStreamResponse(aggregateEvents),
      limits: { maximumEvents: 10, maximumRetainedBytes: aggregateLimit },
    }),
    /SMOKE_SSE_FAILED/,
  );
});

test("REAL_HERMES stages a stable read-only product-lock snapshot in the Supervisor state root", async (t) => {
  assert.equal(typeof stageProductImageLockSnapshot, "function", "snapshot staging must be exported as an injectable seam");
  assert.equal(typeof createSmokeChildEnvironment, "function", "child environment construction must be injectable");
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-smoke-state-test-"));
  await chmod(stateRoot, 0o700);
  const source = join(stateRoot, "reviewed-source.json");
  const snapshotTenantId = "synthetic-runtime-v1-0123456789abcdef";
  const emptyCollisionTenantId = "synthetic-runtime-v1-fedcba9876543210";
  const emptyCollisionDirectory = join(stateRoot, ".core-agent-product-lock-fedcba9876543210");
  const productLock = {
    schemaVersion: 1,
    repository: "core-agent/hermes-runtime",
    tag: "v2026.8.5",
    platforms: {
      "linux/amd64": { reference: "core-agent/hermes-runtime:v2026.8.5@sha256:" + "a".repeat(64) },
      "linux/arm64": { reference: "core-agent/hermes-runtime:v2026.8.5@sha256:" + "b".repeat(64) },
    },
  };
  await writeFile(source, `${JSON.stringify(productLock)}\n`, { mode: 0o600 });
  let snapshot;
  t.after(async () => {
    await snapshot?.cleanup().catch(() => undefined);
    await rmdir(emptyCollisionDirectory).catch(() => undefined);
    await unlink(source).catch(() => undefined);
    await rmdir(stateRoot).catch(() => undefined);
  });
  snapshot = await stageProductImageLockSnapshot(source, "linux/arm64", stateRoot, snapshotTenantId);
  assert.notEqual(snapshot.path, source);
  assert.equal(
    snapshot.path,
    `${stateRoot}/.core-agent-product-lock-0123456789abcdef/reviewed-product-images.lock.json`,
  );
  assert.equal((await stat(snapshot.path)).mode & 0o777, 0o444);
  assert.deepEqual(JSON.parse(await readFile(snapshot.path, "utf8")), productLock);
  assert.equal(snapshot.imageRef, productLock.platforms["linux/arm64"].reference);
  const childEnvironment = createSmokeChildEnvironment(smokeEnvironment, snapshot.path);
  assert.equal(childEnvironment.CORE_AGENT_HERMES_IMAGE_LOCK_FILE, snapshot.path);
  assert.equal(smokeEnvironment.CORE_AGENT_HERMES_IMAGE_LOCK_FILE, "/safe/config/reviewed-product-images.lock.json");
  await assert.rejects(
    stageProductImageLockSnapshot(source, "linux/arm64", stateRoot, snapshotTenantId),
    /SMOKE_PRODUCT_IMAGE_LOCK_INVALID/,
  );
  await mkdir(emptyCollisionDirectory, { mode: 0o700 });
  await assert.rejects(
    stageProductImageLockSnapshot(source, "linux/arm64", stateRoot, emptyCollisionTenantId),
    /SMOKE_PRODUCT_IMAGE_LOCK_INVALID/,
  );
  assert.equal((await stat(emptyCollisionDirectory)).isDirectory(), true);
  await rmdir(emptyCollisionDirectory);
  await assert.rejects(
    stageProductImageLockSnapshot(source, "linux/arm64", stateRoot, snapshotTenantId, {
      afterSourceRead: async () => writeFile(source, `${JSON.stringify({ ...productLock, tag: "mutated" })}\n`),
    }),
    /SMOKE_PRODUCT_IMAGE_LOCK_INVALID/,
  );
  await snapshot.cleanup();
  await assert.rejects(stat(snapshot.path), /ENOENT/);
  snapshot = undefined;
});

test("canonical smoke payload hashing is key-order deterministic", () => {
  assert.equal(
    canonicalPayloadHash({ b: [2, 1], a: { z: true, y: null } }),
    canonicalPayloadHash({ a: { y: null, z: true }, b: [2, 1] }),
  );
});

test("REAL_HERMES smoke accepts only a reviewed Core-Agent product image lock", () => {
  const productLock = {
    schemaVersion: 1,
    repository: "core-agent/hermes-runtime",
    tag: "v2026.8.5",
    platforms: {
      "linux/amd64": { reference: "core-agent/hermes-runtime:v2026.8.5@sha256:" + "a".repeat(64) },
      "linux/arm64": { reference: "core-agent/hermes-runtime:v2026.8.5@sha256:" + "b".repeat(64) },
    },
  };
  assert.equal(validateProductImageLock(productLock, "linux/arm64"), productLock.platforms["linux/arm64"].reference);
  assert.throws(
    () => validateProductImageLock({
      ...productLock,
      repository: "nousresearch/hermes-agent",
      platforms: {
        "linux/amd64": { reference: "nousresearch/hermes-agent:v2026.7.30@sha256:" + "a".repeat(64) },
        "linux/arm64": { reference: "nousresearch/hermes-agent:v2026.7.30@sha256:" + "b".repeat(64) },
      },
    }, "linux/arm64"),
    /SMOKE_PRODUCT_IMAGE_LOCK_INVALID/,
  );
});

test("control-plane API and Supervisor load one caller-supplied product image lock", async () => {
  const controlPlaneCompose = await readFile(
    new URL("../../infra/runtime/compose.dev.yaml", import.meta.url),
    "utf8",
  );
  const runtimeEnvironmentExample = await readFile(
    new URL("../../.env.runtime.example", import.meta.url),
    "utf8",
  );
  assert.match(runtimeEnvironmentExample, /^CORE_AGENT_HERMES_IMAGE_LOCK_FILE=\/absolute\/path\/to\/Core-Agent\/infra\/hermes\/product-images\.lock\.json$/m);
  assert.equal(
    controlPlaneCompose.match(/source: \$\{CORE_AGENT_HERMES_IMAGE_LOCK_FILE:\?set CORE_AGENT_HERMES_IMAGE_LOCK_FILE\}/g)?.length,
    2,
  );
  assert.equal(
    controlPlaneCompose.match(/target: \/run\/core-agent\/config\/hermes-images\.lock\.json/g)?.length,
    2,
  );
  assert.match(controlPlaneCompose, /CONTROL_PLANE_IMAGE_LOCK_FILE: \/run\/core-agent\/config\/hermes-images\.lock\.json/);
  assert.match(controlPlaneCompose, /CORE_AGENT_IMAGE_LOCK_PATH: \/run\/core-agent\/config\/hermes-images\.lock\.json/);
});

const dockerfile = await readFile(
  new URL("../../infra/hermes/Dockerfile", import.meta.url),
  "utf8"
);
const historicalDockerfile = await readFile(
  new URL("../../infra/hermes/Dockerfile.upstream-image", import.meta.url),
  "utf8",
);
const canonicalBuildAdapter = await readFile(
  new URL("../../scripts/build-hermes-image.mjs", import.meta.url),
  "utf8",
);
const upstreamSourceDockerfile = await readFile(
  new URL("../../third_party/hermes-agent/Dockerfile", import.meta.url),
  "utf8",
);
const vendoredApiServer = await readFile(
  new URL("../../third_party/hermes-agent/gateway/platforms/api_server.py", import.meta.url),
  "utf8",
);
const managedConfig = await readFile(
  new URL("../../infra/hermes/managed/config.yaml", import.meta.url),
  "utf8"
);

test("canonical Dockerfile requires the verified local source image and both revisions", () => {
  assert.match(dockerfile, /^ARG HERMES_SOURCE_IMAGE$/m);
  assert.match(dockerfile, /^FROM \$\{HERMES_SOURCE_IMAGE\}$/m);
  assert.match(dockerfile, /^ARG CORE_AGENT_GIT_SHA$/m);
  assert.match(dockerfile, /^ARG HERMES_GIT_SHA$/m);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{CORE_AGENT_GIT_SHA\}"/u);
  assert.match(dockerfile, /io\.core-agent\.hermes\.upstream\.revision="\$\{HERMES_GIT_SHA\}"/u);
  assert.doesNotMatch(dockerfile, /HERMES_BASE_IMAGE/u);
  assert.doesNotMatch(dockerfile, /FROM\s+nousresearch\/hermes-agent:latest/);
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.title="Core-Agent Hermes Runtime"$/m
  );
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.description="Source-built managed Hermes runtime for Core-Agent"/m
  );
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.vendor="Core-Agent"$/m
  );
  assert.match(dockerfile, /^USER root$/m);
  assert.match(dockerfile, /COPY infra\/hermes\/managed\/config\.yaml \/etc\/hermes\/config\.yaml/);
  assert.match(
    dockerfile,
    /RUN chmod 0755 \/etc\/hermes \\\n+    && chmod 0644 \/etc\/hermes\/config\.yaml/
  );
});

test("product image has fixed initializer and gateway entrypoints", () => {
  assert.match(dockerfile, /COPY infra\/hermes\/runtime\/initialize\.py \/opt\/core-agent\/initialize\.py/);
  assert.match(dockerfile, /COPY infra\/hermes\/runtime\/gateway-entrypoint\.sh \/opt\/core-agent\/gateway-entrypoint\.sh/);
  assert.match(dockerfile, /ENTRYPOINT \["\/opt\/core-agent\/gateway-entrypoint\.sh"\]/);
  assert.match(dockerfile, /ENV API_SERVER_ENABLED=true/);
  assert.match(dockerfile, /API_SERVER_HOST=0\.0\.0\.0/);
  assert.match(dockerfile, /API_SERVER_PORT=8642/);
  assert.match(dockerfile, /GATEWAY_MULTIPLEX_PROFILES=true/);
  assert.match(dockerfile, /chown root:root \/opt\/core-agent\/initialize\.py \/opt\/core-agent\/gateway-entrypoint\.sh/);
  assert.match(dockerfile, /chmod 0555 \/opt\/core-agent\/initialize\.py \/opt\/core-agent\/gateway-entrypoint\.sh/);
  assert.match(dockerfile, /install -d -m 01777 -o root -g root \/opt\/data/);
  assert.doesNotMatch(dockerfile, /API_SERVER_KEY=/);
});

test("source-built product preserves the accepted runtime security boundary", () => {
  assert.match(upstreamSourceDockerfile, /^RUN useradd -u 10000 -m -d \/opt\/data hermes$/mu);
  assert.match(upstreamSourceDockerfile, /^ENV HERMES_HOME=\/opt\/data$/mu);
  assert.match(upstreamSourceDockerfile, /^ENV HERMES_WRITE_SAFE_ROOT=\/opt\/data$/mu);
  assert.deepEqual(
    [...upstreamSourceDockerfile.matchAll(/^VOLUME\s+\[\s*"([^"]+)"\s*\]$/gmu)]
      .map((match) => match[1]),
    ["/opt/data"],
  );

  assert.match(dockerfile, /^USER hermes$/mu);
  assert.match(
    dockerfile,
    /^ENTRYPOINT \["\/opt\/core-agent\/gateway-entrypoint\.sh"\]$/mu,
  );
  assert.match(dockerfile, /install -d -m 01777 -o root -g root \/opt\/data/u);
  assert.doesNotMatch(dockerfile, /^VOLUME\b/mu);
  assert.doesNotMatch(
    `${upstreamSourceDockerfile}\n${dockerfile}`,
    /(?:API_SERVER_KEY|PROVIDER_(?:KEY|TOKEN)|BOOTSTRAP_(?:KEY|TOKEN)|CONTROL_PLANE_(?:KEY|TOKEN|SECRET))=/u,
  );
  assert.match(
    vendoredApiServer,
    /from core_agent_error_projection import project_terminal_failure/u,
  );
  assert.match(vendoredApiServer, /finish_chunk = project_terminal_failure\(failure, partial=is_partial\)/u);
  assert.match(vendoredApiServer, /error_chunk = project_terminal_failure\(_exc, partial=True\)/u);
});

test("historical official-image overlay remains diagnostics-only", () => {
  assert.match(historicalDockerfile, /^ARG HERMES_BASE_IMAGE$/mu);
  assert.match(historicalDockerfile, /^FROM \$\{HERMES_BASE_IMAGE\}$/mu);
  assert.match(historicalDockerfile, /install_error_projection\.py/u);
  assert.match(historicalDockerfile, /gateway-error-projection\.patch/u);
  assert.doesNotMatch(canonicalBuildAdapter, /(?:resolveHermesImage|base-images\.lock\.json|HERMES_BASE_IMAGE|Dockerfile\.upstream-image)/u);
  assert.match(canonicalBuildAdapter, /build-hermes-source-image\.mjs/u);
});

test("managed config starts with a deliberately narrow tool surface", () => {
  assert.equal(managedConfig, `gateway:
  multiplex_profiles: true

platform_toolsets:
  api_server:
    - clarify
  cli:
    - clarify

plugins:
  enabled: []

security:
  redact_secrets: true

skills:
  write_approval: true

memory:
  write_approval: true
`);
  assert.doesNotMatch(
    managedConfig,
    /(?:^|\n)\s*(?:-\s+)?(?:terminal|file|browser|code_execution)\s*(?::|$)/m
  );
});

const composeConfig = await readFile(
  new URL("../../infra/hermes/compose.dev.yaml", import.meta.url),
  "utf8"
);

test("development runtime is private and keeps state outside the image", () => {
  assert.match(
    composeConfig,
    /    ports:\n      - "127\.0\.0\.1:\$\{CORE_AGENT_API_SERVER_PORT:-18642\}:8642"\n    volumes:/
  );
  assert.match(composeConfig, /company-demo-hermes-data:\/opt\/data/);
  assert.match(composeConfig, /read_only:\s+true/);
  assert.match(composeConfig, /- \/run:size=64m,mode=0755,exec/);
  assert.match(composeConfig, /no-new-privileges:true/);
  assert.match(
    composeConfig,
    /    cap_add:\n      - CHOWN\n      - DAC_OVERRIDE\n      - SETGID\n      - SETUID\n    cap_drop:/
  );
  assert.match(composeConfig, /cap_drop:\s*\n\s+- ALL/);
  assert.doesNotMatch(composeConfig, /docker\.sock/);
  assert.doesNotMatch(composeConfig, /^\s+command:/m);
  assert.doesNotMatch(composeConfig, /API_SERVER_KEY/);
  assert.match(
    composeConfig,
    /    secrets:\n      - source: hermes_ingress\n        target: hermes_ingress/
  );
  assert.match(
    composeConfig,
    /  hermes_ingress:\n    file: \$\{CORE_AGENT_HERMES_INGRESS_SECRET_FILE:\?set CORE_AGENT_HERMES_INGRESS_SECRET_FILE\}/
  );
});

test("API server ingress is sourced only from the configured secret file", () => {
  assert.match(composeConfig, /CORE_AGENT_HERMES_INGRESS_SECRET_FILE:\?set/);
  assert.doesNotMatch(composeConfig, /CORE_AGENT_API_SERVER_KEY/);
});

test("CI validates runtime contracts without building or publishing images", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/runtime-contract.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^\s+node-version: 22\.13\.0$/m);
  assert.match(workflow, /^\s+fetch-depth: 0$/m);
  assert.match(workflow, /^\s+run: npm run contracts:check$/m);
  assert.match(workflow, /^\s+run: npm run check$/m);
  assert.match(workflow, /^\s+run: npm run test:postgres$/m);
  assert.match(workflow, /^\s+run: npm run test:integration$/m);
  assert.match(workflow, /^\s+run: npm run test:runtime$/m);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha \|\| github\.event\.before/);
  assert.match(
    workflow,
    /^\s+run: docker compose -f infra\/runtime\/compose\.dev\.yaml config --quiet$/m
  );
  const actions = workflow
    .split("\n")
    .filter((line) => /^\s+uses:/.test(line));
  assert(actions.length > 0);
  assert(actions.every((line) => /@[a-f0-9]{40}(?:\s+#\s+v\d+(?:\.\d+){2})?$/.test(line)));
  assert.doesNotMatch(workflow, /docker\s+build|docker\s+compose\s+up/i);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./i);
  assert.doesNotMatch(workflow, /CORE_AGENT_API_SERVER_KEY/);
});
