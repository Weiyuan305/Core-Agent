import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChatArguments,
  runInteractiveChat,
  validateChatInput,
} from "../../scripts/lib/control-plane-chat.mjs";

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
