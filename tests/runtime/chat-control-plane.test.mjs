import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseChatArguments,
  runInteractiveChat,
  validateChatInput,
} from "../../scripts/lib/control-plane-chat.mjs";
import {
  createRetainedRuntimeCleanupDependencies,
} from "../../scripts/lib/managed-runtime-session.mjs";
import {
  createRetainedRuntimeReceipt,
  readRetainedRuntimeReceipt,
  removeRetainedRuntimeReceipt,
  RETAINED_RUNTIME_RECEIPT_NAME,
} from "../../scripts/lib/retained-runtime-receipt.mjs";
import {
  chatPublicErrorCode,
  runChatControlPlane,
} from "../../scripts/chat-control-plane.mjs";
import {
  cleanupPublicErrorCode,
  runRetainedRuntimeCleanup,
} from "../../scripts/cleanup-control-plane-chat.mjs";

const chatEntrypointSource = await readFile(
  new URL("../../scripts/chat-control-plane.mjs", import.meta.url),
  "utf8",
);
const cleanupEntrypointSource = await readFile(
  new URL("../../scripts/cleanup-control-plane-chat.mjs", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(await readFile(
  new URL("../../package.json", import.meta.url),
  "utf8",
));
const readmeSource = await readFile(new URL("../../README.md", import.meta.url), "utf8");
const localSmokeGuideSource = await readFile(
  new URL("../../docs/operations/runtime-v1-local-smoke.md", import.meta.url),
  "utf8",
);

test("chat arguments allow only the optional retained-runtime flag", () => {
  const defaults = parseChatArguments([]);
  const retained = parseChatArguments(["--keep-runtime"]);

  assert.deepEqual(defaults, { keepRuntime: false });
  assert.deepEqual(retained, { keepRuntime: true });
  assert.ok(Object.isFrozen(defaults));
  assert.ok(Object.isFrozen(retained));

  for (const argv of [
    ["--unknown"],
    ["--keep-runtime", "--keep-runtime"],
    ["--keep-runtime", "extra"],
    "--keep-runtime",
    [1],
  ]) {
    assert.throws(() => parseChatArguments(argv), /^Error: CHAT_ARGUMENT_INVALID$/u);
  }
});

test("chat input accepts bounded text and exact commands", () => {
  for (const value of [
    "anonymous synthetic question",
    "x".repeat(4_000),
    "/new",
    "/restart",
    "/exit",
  ]) {
    assert.equal(validateChatInput(value), value);
  }
});

test("chat input rejects unsafe text and command prefixes with fixed errors", () => {
  for (const value of [
    "",
    "   ",
    "x".repeat(4_001),
    "unsafe\u0000control",
    "unsafe\u001fcontrol",
    "unsafe\u007fcontrol",
    "\ud800",
    "/exit now",
    "/new conversation",
    "/restart api",
    null,
    1,
    {},
  ]) {
    assert.throws(() => validateChatInput(value), /^Error: CHAT_INPUT_INVALID$/u);
  }
});

function lineSource(lines, beforeYield = () => {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) {
        beforeYield(line);
        yield line;
      }
    },
  };
}

function textSink() {
  let value = "";
  return {
    write(chunk) {
      assert.equal(typeof chunk, "string");
      value += chunk;
    },
    value() {
      return value;
    },
  };
}

test("interactive chat serializes Runs, resets Conversation, and restarts through its port", async () => {
  const prompts = [
    "first synthetic question",
    "follow-up synthetic question",
    "isolated synthetic question",
  ];
  const secretDeltas = ["first-secret-delta", "follow-up-secret-delta", "isolated-secret-delta"];
  const calls = [];
  let conversationIndex = 0;
  let runActive = false;
  const output = textSink();
  const errorOutput = textSink();
  const input = lineSource([
    prompts[0],
    prompts[1],
    "/new",
    prompts[2],
    "/restart",
    "/exit",
  ], () => assert.equal(runActive, false, "the next line must wait for the active Run"));
  const port = {
    async createConversation() {
      conversationIndex += 1;
      const conversationId = `synthetic-conversation-${conversationIndex}`;
      calls.push(["createConversation", conversationId]);
      return conversationId;
    },
    async runPrompt(conversationId, content, onDelta) {
      runActive = true;
      calls.push(["runPrompt", conversationId, content]);
      const promptIndex = prompts.indexOf(content);
      assert.notEqual(promptIndex, -1);
      await Promise.resolve();
      onDelta(secretDeltas[promptIndex]);
      runActive = false;
    },
    async restartApiWorker() {
      calls.push(["restartApiWorker"]);
    },
  };

  const result = await runInteractiveChat({ port, input, output, errorOutput });

  assert.deepEqual(result, { conversationId: "synthetic-conversation-2" });
  assert.deepEqual(calls, [
    ["createConversation", "synthetic-conversation-1"],
    ["runPrompt", "synthetic-conversation-1", prompts[0]],
    ["runPrompt", "synthetic-conversation-1", prompts[1]],
    ["createConversation", "synthetic-conversation-2"],
    ["runPrompt", "synthetic-conversation-2", prompts[2]],
    ["restartApiWorker"],
  ]);
  assert.equal(output.value(), `${secretDeltas[0]}\n${secretDeltas[1]}\n${secretDeltas[2]}\n`);
  assert.ok(errorOutput.value().includes("CHAT_ANONYMOUS_SYNTHETIC_ONLY"));
  for (const privateText of [...prompts, ...secretDeltas]) {
    assert.ok(!errorOutput.value().includes(privateText));
  }
});

function basePort(overrides = {}) {
  return {
    async createConversation() {
      return "synthetic-conversation-1";
    },
    async runPrompt(_conversationId, _content, onDelta) {
      onDelta("synthetic-answer");
    },
    async restartApiWorker() {},
    ...overrides,
  };
}

test("interactive chat treats EOF as exit after creating its initial Conversation", async () => {
  const output = textSink();
  const errorOutput = textSink();
  const result = await runInteractiveChat({
    port: basePort(),
    input: lineSource([]),
    output,
    errorOutput,
  });

  assert.deepEqual(result, { conversationId: "synthetic-conversation-1" });
  assert.equal(output.value(), "");
  assert.equal(errorOutput.value().match(/CHAT_ANONYMOUS_SYNTHETIC_ONLY/gu)?.length, 1);
});

test("interactive chat rejects an already-aborted session before port or terminal work", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const output = textSink();
  const errorOutput = textSink();

  await assert.rejects(
    runInteractiveChat({
      port: basePort({
        async createConversation() {
          calls += 1;
          return "synthetic-conversation-1";
        },
      }),
      input: lineSource(["unread synthetic question"]),
      output,
      errorOutput,
      signal: controller.signal,
    }),
    /^Error: CHAT_ABORTED$/u,
  );
  assert.equal(calls, 0);
  assert.equal(output.value(), "");
  assert.equal(errorOutput.value(), "");
});

test("interactive chat stops input when a Run is aborted", async () => {
  const controller = new AbortController();
  const seen = [];

  await assert.rejects(
    runInteractiveChat({
      port: basePort({
        async runPrompt(_conversationId, content) {
          seen.push(content);
          controller.abort();
          throw new Error("private transport detail");
        },
      }),
      input: lineSource(["first synthetic question", "must not be read"]),
      output: textSink(),
      errorOutput: textSink(),
      signal: controller.signal,
    }),
    /^Error: CHAT_ABORTED$/u,
  );
  assert.deepEqual(seen, ["first synthetic question"]);
});

test("interactive chat bounds Run failures and does not accept later input", async () => {
  const seen = [];
  await assert.rejects(
    runInteractiveChat({
      port: basePort({
        async runPrompt(_conversationId, content) {
          seen.push(content);
          throw new Error("private provider response");
        },
      }),
      input: lineSource(["first synthetic question", "must not be read"]),
      output: textSink(),
      errorOutput: textSink(),
    }),
    /^Error: CHAT_RUN_FAILED$/u,
  );
  assert.deepEqual(seen, ["first synthetic question"]);
});

test("interactive chat stops after an output write failure without reflecting content", async () => {
  const seen = [];
  const privateDelta = "private assistant delta";
  await assert.rejects(
    runInteractiveChat({
      port: basePort({
        async runPrompt(_conversationId, content, onDelta) {
          seen.push(content);
          onDelta(privateDelta);
        },
      }),
      input: lineSource(["first synthetic question", "must not be read"]),
      output: {
        write(chunk) {
          assert.equal(chunk, privateDelta);
          throw new Error("private terminal detail");
        },
      },
      errorOutput: textSink(),
    }),
    /^Error: CHAT_OUTPUT_FAILED$/u,
  );
  assert.deepEqual(seen, ["first synthetic question"]);
});

test("interactive chat bounds input-source and restart failures", async () => {
  const failingInput = {
    async *[Symbol.asyncIterator]() {
      throw new Error("private input detail");
    },
  };
  await assert.rejects(
    runInteractiveChat({
      port: basePort(), input: failingInput, output: textSink(), errorOutput: textSink(),
    }),
    /^Error: CHAT_INPUT_FAILED$/u,
  );

  await assert.rejects(
    runInteractiveChat({
      port: basePort({
        async restartApiWorker() {
          throw new Error("private Docker detail");
        },
      }),
      input: lineSource(["/restart", "must not be read"]),
      output: textSink(),
      errorOutput: textSink(),
    }),
    /^Error: CHAT_RESTART_FAILED$/u,
  );
});

const retainedReceipt = Object.freeze({
  schemaVersion: 1,
  composeProject: "core-agent-runtime-v1-smoke",
  tenantId: "synthetic-runtime-v1-0123456789abcdef",
  profileId: "synthetic-runtime-v1-profile-0123456789abcdef",
  runtimeId: `runtime_${createHash("sha256")
    .update("synthetic-runtime-v1-0123456789abcdef", "utf8")
    .digest("hex")
    .slice(0, 32)}`,
  lockSnapshotName: ".core-agent-product-lock-0123456789abcdef",
});

test("retained Runtime receipt is exclusive, owner-only, and closed-shape", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-receipt-"));
  try {
    await createRetainedRuntimeReceipt(stateRoot, retainedReceipt);
    const receiptPath = join(stateRoot, RETAINED_RUNTIME_RECEIPT_NAME);
    const metadata = await stat(receiptPath, { bigint: true });
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1n);
    assert.equal(metadata.mode & 0o7777n, 0o600n);
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(receiptPath, "utf8"))),
      ["schemaVersion", "composeProject", "tenantId", "profileId", "runtimeId", "lockSnapshotName"],
    );
    const loaded = await readRetainedRuntimeReceipt(stateRoot);
    assert.deepEqual(loaded, retainedReceipt);
    assert.ok(Object.isFrozen(loaded));

    await assert.rejects(
      createRetainedRuntimeReceipt(stateRoot, retainedReceipt),
      /^Error: CHAT_RETENTION_FAILED$/u,
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("retained Runtime receipt fails closed on mode drift and removes only exact content", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-receipt-"));
  try {
    await createRetainedRuntimeReceipt(stateRoot, retainedReceipt);
    const receiptPath = join(stateRoot, RETAINED_RUNTIME_RECEIPT_NAME);
    await chmod(receiptPath, 0o644);
    await assert.rejects(
      readRetainedRuntimeReceipt(stateRoot),
      /^Error: CHAT_CLEANUP_FAILED$/u,
    );
    await chmod(receiptPath, 0o600);
    await assert.rejects(
      removeRetainedRuntimeReceipt(stateRoot, { ...retainedReceipt, runtimeId: `runtime_${"b".repeat(32)}` }),
      /^Error: CHAT_CLEANUP_FAILED$/u,
    );
    assert.deepEqual(await readRetainedRuntimeReceipt(stateRoot), retainedReceipt);
    await removeRetainedRuntimeReceipt(stateRoot, retainedReceipt);
    await assert.rejects(stat(receiptPath), (error) => error?.code === "ENOENT");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("chat entrypoint is a thin readline and managed-session adapter", () => {
  assert.match(chatEntrypointSource, /from "node:readline\/promises"/u);
  assert.match(chatEntrypointSource, /runManagedRuntimeSession/u);
  assert.match(chatEntrypointSource, /runInteractiveChat/u);
  assert.match(chatEntrypointSource, /process\.once\("SIGINT"/u);
  assert.match(chatEntrypointSource, /process\.once\("SIGTERM"/u);
  assert.doesNotMatch(chatEntrypointSource, /process\.once\("(?:SIGHUP|SIGQUIT)"/u);
  assert.doesNotMatch(chatEntrypointSource, /\bdocker\b/iu);
  assert.doesNotMatch(chatEntrypointSource, /readProtectedSecret/u);
});

function validChatEnvironment(stateRoot) {
  const digest = "a".repeat(64);
  return {
    CORE_AGENT_REAL_HERMES_SMOKE: "1",
    CORE_AGENT_PLATFORM: "linux/arm64",
    CORE_AGENT_NODE_IMAGE: `registry.example/core-agent-node:v1@sha256:${digest}`,
    CORE_AGENT_POSTGRES_IMAGE: `registry.example/core-agent-postgres:v1@sha256:${digest}`,
    CORE_AGENT_HERMES_IMAGE_LOCK_FILE: "/synthetic/reviewed-product-images.lock.json",
    CORE_AGENT_BOOTSTRAP_KEY_FILE: "/synthetic/bootstrap-key.v1",
    CORE_AGENT_POSTGRES_BOOTSTRAP_PASSWORD_FILE: "/synthetic/database/postgres-bootstrap-password",
    CORE_AGENT_DATABASE_MIGRATOR_PASSWORD_FILE: "/synthetic/database/migrator-password",
    CORE_AGENT_DATABASE_APP_PASSWORD_FILE: "/synthetic/database/app-password",
    CORE_AGENT_DATABASE_IDENTITY_PASSWORD_FILE: "/synthetic/database/identity-password",
    CORE_AGENT_PROVIDER_SECRET_ROOT: "/synthetic/provider-secrets",
    CORE_AGENT_INGRESS_SECRET_ROOT: "/synthetic/ingress-secrets",
    CORE_AGENT_SUPERVISOR_STATE_ROOT: stateRoot,
    CORE_AGENT_API_UID: "10000",
    CORE_AGENT_API_GID: "10000",
    CORE_AGENT_CREDENTIAL_MOUNT_UID: "0",
    CORE_AGENT_CREDENTIAL_MOUNT_GID: "0",
    CORE_AGENT_RUNTIME_UID: "10001",
    CORE_AGENT_SUPERVISOR_SOCKET_GID: "10002",
    CORE_AGENT_DOCKER_GID: "10003",
    CORE_AGENT_DOCKER_SOCKET_SOURCE: "/synthetic/docker.sock",
  };
}

function chatLifecycleFixture() {
  const calls = [];
  const context = Object.freeze({
    tenantId: retainedReceipt.tenantId,
    profileId: retainedReceipt.profileId,
    runtimeId: retainedReceipt.runtimeId,
  });
  const dependencies = {
    validatePrerequisites: async () => calls.push("validatePrerequisites"),
    startTopology: async () => calls.push("startTopology"),
    prepareProvisioningContext: () => context,
    provision: async () => calls.push("provision"),
    pollRuntime: async () => ({ observed_state: "ready" }),
    createConversation: async () => {
      calls.push("createConversation");
      return "synthetic-conversation-1";
    },
    createRun: async (_context, conversationId, content) => {
      calls.push(["createRun", conversationId, content]);
      return "synthetic-run-1";
    },
    readEvents: async (_context, conversationId, runId, onDelta) => {
      calls.push(["readEvents", conversationId, runId]);
      onDelta("synthetic assistant answer");
      return {
        eventTypes: ["message.delta", "run.completed"],
        terminal: { status: "succeeded" },
      };
    },
    restartApiWorker: async () => calls.push("restartApiWorker"),
    deleteRuntime: async () => calls.push("deleteRuntime"),
    waitForContainerRemoval: async () => calls.push("waitForContainerRemoval"),
    stopTopology: async () => calls.push("stopTopology"),
    releaseProductImageLockSnapshot: async () => calls.push("releaseProductImageLockSnapshot"),
    releaseSecrets: async () => calls.push("releaseSecrets"),
  };
  return { calls, context, dependencies };
}

test("chat entrypoint composes terminal prompts with the managed Runtime lifecycle", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-entry-"));
  try {
    const fixture = chatLifecycleFixture();
    const output = textSink();
    const errorOutput = textSink();
    await runChatControlPlane({
      environment: validChatEnvironment(stateRoot),
      argv: [],
      dependencies: fixture.dependencies,
      lineInput: lineSource(["synthetic user question", "/exit"]),
      output,
      errorOutput,
    });
    assert.equal(output.value(), "synthetic assistant answer\n");
    assert.deepEqual(fixture.calls, [
      "validatePrerequisites",
      "startTopology",
      "provision",
      "createConversation",
      ["createRun", "synthetic-conversation-1", "synthetic user question"],
      ["readEvents", "synthetic-conversation-1", "synthetic-run-1"],
      "deleteRuntime",
      "waitForContainerRemoval",
      "stopTopology",
      "releaseProductImageLockSnapshot",
      "releaseSecrets",
    ]);
    assert.ok(!errorOutput.value().includes("synthetic user question"));
    assert.ok(!errorOutput.value().includes("synthetic assistant answer"));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("chat retained mode writes its receipt before preserving managed resources", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-entry-"));
  try {
    const fixture = chatLifecycleFixture();
    await runChatControlPlane({
      environment: validChatEnvironment(stateRoot),
      argv: ["--keep-runtime"],
      dependencies: fixture.dependencies,
      lineInput: lineSource(["/exit"]),
      output: textSink(),
      errorOutput: textSink(),
    });
    assert.deepEqual(await readRetainedRuntimeReceipt(stateRoot), retainedReceipt);
    assert.deepEqual(fixture.calls, [
      "validatePrerequisites",
      "startTopology",
      "provision",
      "createConversation",
      "releaseSecrets",
    ]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("chat retained mode falls back to full cleanup when its exclusive receipt already exists", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-entry-"));
  try {
    await createRetainedRuntimeReceipt(stateRoot, retainedReceipt);
    const fixture = chatLifecycleFixture();
    await assert.rejects(
      runChatControlPlane({
        environment: validChatEnvironment(stateRoot),
        argv: ["--keep-runtime"],
        dependencies: fixture.dependencies,
        lineInput: lineSource(["/exit"]),
        output: textSink(),
        errorOutput: textSink(),
      }),
      (error) => chatPublicErrorCode(error) === "CHAT_RETENTION_FAILED",
    );
    assert.deepEqual(fixture.calls.slice(-5), [
      "deleteRuntime",
      "waitForContainerRemoval",
      "stopTopology",
      "releaseProductImageLockSnapshot",
      "releaseSecrets",
    ]);
    assert.deepEqual(await readRetainedRuntimeReceipt(stateRoot), retainedReceipt);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

function retainedCleanupFixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      validatePrerequisites: async (receipt) => calls.push(["validatePrerequisites", receipt.runtimeId]),
      deleteRuntime: async (context) => calls.push(["deleteRuntime", context.runtimeId]),
      waitForContainerRemoval: async (context) => calls.push(["waitForContainerRemoval", context.runtimeId]),
      stopTopology: async (options) => calls.push(["stopTopology", options]),
      releaseProductImageLockSnapshot: async (receipt) => calls.push([
        "releaseProductImageLockSnapshot",
        receipt.lockSnapshotName,
      ]),
      releaseSecrets: async () => calls.push(["releaseSecrets"]),
      ...overrides,
    },
  };
}

test("retained cleanup entrypoint accepts no targets and exposes only bounded failures", () => {
  assert.match(cleanupEntrypointSource, /runRetainedRuntimeCleanup/u);
  assert.match(cleanupEntrypointSource, /process\.once\("SIGINT"/u);
  assert.match(cleanupEntrypointSource, /process\.once\("SIGTERM"/u);
  assert.doesNotMatch(cleanupEntrypointSource, /process\.argv\.slice\(3\)/u);
  assert.equal(cleanupPublicErrorCode(new Error("private cleanup detail")), "CHAT_CLEANUP_FAILED");
  assert.equal(rootPackage.scripts["chat:control-plane"], "node scripts/chat-control-plane.mjs");
  assert.equal(rootPackage.scripts["chat:cleanup"], "node scripts/cleanup-control-plane-chat.mjs");
});

test("retained cleanup removes the exact receipt only after every cleanup operation succeeds", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-cleanup-"));
  try {
    await createRetainedRuntimeReceipt(stateRoot, retainedReceipt);
    const fixture = retainedCleanupFixture();
    await runRetainedRuntimeCleanup({
      environment: validChatEnvironment(stateRoot),
      argv: [],
      dependencies: fixture.dependencies,
    });
    assert.deepEqual(fixture.calls, [
      ["validatePrerequisites", retainedReceipt.runtimeId],
      ["deleteRuntime", retainedReceipt.runtimeId],
      ["waitForContainerRemoval", retainedReceipt.runtimeId],
      ["stopTopology", { projectName: retainedReceipt.composeProject, removeVolumes: false }],
      ["releaseProductImageLockSnapshot", retainedReceipt.lockSnapshotName],
      ["releaseSecrets"],
    ]);
    await assert.rejects(
      stat(join(stateRoot, RETAINED_RUNTIME_RECEIPT_NAME)),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("retained cleanup continues after failure and preserves the receipt for retry", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-cleanup-"));
  try {
    await createRetainedRuntimeReceipt(stateRoot, retainedReceipt);
    const firstFailure = new Error("private delete failure");
    const fixture = retainedCleanupFixture({
      deleteRuntime: async (context) => {
        fixture.calls.push(["deleteRuntime", context.runtimeId]);
        throw firstFailure;
      },
      waitForContainerRemoval: async (context) => {
        fixture.calls.push(["waitForContainerRemoval", context.runtimeId]);
        throw new Error("private wait failure");
      },
    });
    await assert.rejects(
      runRetainedRuntimeCleanup({
        environment: validChatEnvironment(stateRoot),
        argv: [],
        dependencies: fixture.dependencies,
      }),
      (error) => cleanupPublicErrorCode(error) === "CHAT_CLEANUP_FAILED" && error.cause === firstFailure,
    );
    assert.deepEqual(fixture.calls.slice(-5), [
      ["deleteRuntime", retainedReceipt.runtimeId],
      ["waitForContainerRemoval", retainedReceipt.runtimeId],
      ["stopTopology", { projectName: retainedReceipt.composeProject, removeVolumes: false }],
      ["releaseProductImageLockSnapshot", retainedReceipt.lockSnapshotName],
      ["releaseSecrets"],
    ]);
    assert.deepEqual(await readRetainedRuntimeReceipt(stateRoot), retainedReceipt);

    let calls = 0;
    await assert.rejects(
      runRetainedRuntimeCleanup({
        environment: validChatEnvironment(stateRoot),
        argv: ["synthetic-target"],
        dependencies: { validatePrerequisites: async () => { calls += 1; } },
      }),
      /^Error: CHAT_CLEANUP_FAILED$/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("retained cleanup dependencies use exact bounded targets and zero bootstrap material", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "core-agent-chat-cleanup-deps-"));
  try {
    const childCalls = [];
    const requestCalls = [];
    const snapshotCalls = [];
    const bootstrapKey = Buffer.from("synthetic-bootstrap-key");
    const dependencies = createRetainedRuntimeCleanupDependencies(
      validChatEnvironment(stateRoot),
      retainedReceipt,
      undefined,
      {
        child: async (command, args, options) => {
          childCalls.push([command, args, options]);
          if (args[0] === "context") return JSON.stringify("unix:///synthetic/docker.sock");
          if (args[0] === "ps") return "";
          if (args[0] === "volume") {
            return JSON.stringify([{ Labels: {
              "core-agent.managed": "runtime-v1",
              "core-agent.resource": "runtime-volume",
              "core-agent.tenant-id": retainedReceipt.tenantId,
              "core-agent.runtime-id": retainedReceipt.runtimeId,
            } }]);
          }
          return "synthetic-ok";
        },
        requestJson: async (path, options) => {
          requestCalls.push([path, options]);
          if (options.method === "POST") return {};
          return {
            container_id: retainedReceipt.runtimeId,
            desired_state: "running",
            observed_state: "ready",
            resource_version: 7,
          };
        },
        readProtectedSecret: async () => bootstrapKey,
        loadRetainedSnapshot: async () => Object.freeze({
          paths: Object.freeze({ directory: "/synthetic/snapshot", path: "/synthetic/snapshot/lock.json" }),
          metadata: undefined,
        }),
        releaseRetainedSnapshot: async (snapshot) => snapshotCalls.push(snapshot.paths.directory),
      },
    );
    const context = {
      tenantId: retainedReceipt.tenantId,
      profileId: retainedReceipt.profileId,
      runtimeId: retainedReceipt.runtimeId,
    };

    await dependencies.validatePrerequisites(retainedReceipt);
    await dependencies.deleteRuntime(context);
    await dependencies.waitForContainerRemoval(context);
    await dependencies.stopTopology({ projectName: retainedReceipt.composeProject, removeVolumes: false });
    await dependencies.releaseProductImageLockSnapshot(retainedReceipt);
    await dependencies.releaseSecrets();

    assert.equal(requestCalls.length, 2);
    assert.match(requestCalls[0][0], /\/runtime$/u);
    assert.match(requestCalls[1][0], /\/runtime-commands$/u);
    assert.equal(requestCalls[1][1].body.command, "delete");
    assert.equal(requestCalls[1][1].body.expected_resource_version, 7);
    assert.ok(childCalls.some(([, args]) => args.includes("label=core-agent.managed=runtime-v1")));
    assert.ok(childCalls.some(([, args]) => args.includes("down") && args.includes("--remove-orphans")));
    assert.ok(childCalls.every(([, args]) => !args.includes("--volumes")));
    assert.deepEqual(snapshotCalls, ["/synthetic/snapshot"]);
    assert.ok(bootstrapKey.every((byte) => byte === 0));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("operations docs distinguish strict smoke from interactive synthetic chat", () => {
  for (const source of [readmeSource, localSmokeGuideSource]) {
    assert.match(source, /CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane/u);
    assert.match(source, /CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:control-plane/u);
    assert.match(source, /npm run chat:cleanup/u);
  }
  for (const command of ["/new", "/restart", "/exit", "--keep-runtime"]) {
    assert.ok(localSmokeGuideSource.includes(`\`${command}\``));
  }
  assert.match(localSmokeGuideSource, /anonymous synthetic/iu);
  assert.match(localSmokeGuideSource, /API and Worker only/iu);
  assert.match(localSmokeGuideSource, /does not write.*transcript/isu);
});
