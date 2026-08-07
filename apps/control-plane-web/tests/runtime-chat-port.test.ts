import { describe, expect, it, vi } from "vitest";

import { createRuntimeChatPort } from "../src/server/runtime-chat-port.js";

describe("managed Runtime chat adapter", () => {
  it("uses the exact session context and starts only after Run creation", async () => {
    const order: string[] = [];
    const context = Object.freeze({ tenantId: "synthetic-runtime-v1-test" });
    const operations = {
      createConversation: vi.fn(async (received) => {
        expect(received).toBe(context);
        return "conversation_internal";
      }),
      createRun: vi.fn(async (received, conversationId, content) => {
        expect(received).toBe(context);
        expect(conversationId).toBe("conversation_internal");
        expect(content).toBe("synthetic prompt");
        order.push("created");
        return "run_internal";
      }),
      readEvents: vi.fn(async (received, conversationId, runId, onDelta) => {
        expect(received).toBe(context);
        expect(conversationId).toBe("conversation_internal");
        expect(runId).toBe("run_internal");
        order.push("events");
        onDelta("hello");
        return {
          eventTypes: ["run.started", "message.delta", "message.completed", "run.completed"],
          terminal: { status: "succeeded" },
        };
      }),
      restartApiWorker: vi.fn(async () => undefined),
    };
    const port = createRuntimeChatPort({ context, operations });
    await expect(port.createConversation()).resolves.toBe("conversation_internal");
    await expect(port.runPrompt("conversation_internal", "synthetic prompt", {
      onStarted: () => order.push("started"),
      onDelta: (delta) => order.push(delta),
    })).resolves.toEqual({ status: "succeeded", runId: "run_internal" });
    expect(order).toEqual(["created", "started", "events", "hello"]);
    await port.restartApiWorker();
    expect(operations.restartApiWorker).toHaveBeenCalledOnce();
  });

  it.each([
    ["createConversation", "CLIENT_CONVERSATION_FAILED"],
    ["runPrompt", "CLIENT_RUN_FAILED"],
    ["restartApiWorker", "CLIENT_RESTART_FAILED"],
  ] as const)("maps %s errors without reflecting the cause", async (operation, expected) => {
    const raw = "provider-secret-and-body";
    const operations = {
      createConversation: async () => {
        if (operation === "createConversation") throw new Error(raw);
        return "conversation_internal";
      },
      createRun: async () => {
        if (operation === "runPrompt") throw new Error(raw);
        return "run_internal";
      },
      readEvents: async () => ["run.completed"],
      restartApiWorker: async () => {
        if (operation === "restartApiWorker") throw new Error(raw);
      },
    };
    const port = createRuntimeChatPort({ context: {}, operations });
    const action = operation === "createConversation"
      ? port.createConversation()
      : operation === "runPrompt"
        ? port.runPrompt("conversation_internal", "synthetic", { onStarted() {}, onDelta() {} })
        : port.restartApiWorker();
    await expect(action).rejects.toThrowError(expected);
    await expect(action).rejects.not.toThrowError(raw);
  });

  it("rejects a non-terminal managed event sequence", async () => {
    const port = createRuntimeChatPort({
      context: {},
      operations: {
        createConversation: async () => "conversation_internal",
        createRun: async () => "run_internal",
        readEvents: async () => ({
          eventTypes: ["run.started", "run.failed"],
          terminal: { status: "failed", failureCode: "MODEL_BUSY" },
        }),
        restartApiWorker: async () => undefined,
      },
    });
    await expect(port.runPrompt("conversation_internal", "synthetic", {
      onStarted() {},
      onDelta() {},
    })).resolves.toEqual({
      status: "failed",
      runId: "run_internal",
      failureCode: "MODEL_BUSY",
    });
  });

  it("passes one parent Run only through the server-only retry boundary", async () => {
    const createRun = vi.fn(async (
      _context,
      _conversationId,
      _content,
      options,
    ) => {
      expect(options).toEqual({ parentRunId: "run_failed_parent" });
      return "run_child";
    });
    const port = createRuntimeChatPort({
      context: {},
      operations: {
        createConversation: async () => "conversation_internal",
        createRun,
        readEvents: async () => ({
          eventTypes: ["run.started", "run.completed"],
          terminal: { status: "succeeded" },
        }),
        restartApiWorker: async () => undefined,
      },
    });

    await expect(port.runPrompt(
      "conversation_internal",
      "server held original",
      { onStarted() {}, onDelta() {} },
      { parentRunId: "run_failed_parent" },
    )).resolves.toEqual({ status: "succeeded", runId: "run_child" });
    expect(createRun).toHaveBeenCalledOnce();
  });
});
