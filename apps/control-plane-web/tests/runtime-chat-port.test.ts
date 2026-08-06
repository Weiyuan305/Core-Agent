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
        return ["run.started", "message.delta", "message.completed", "run.completed"];
      }),
      restartApiWorker: vi.fn(async () => undefined),
    };
    const port = createRuntimeChatPort({ context, operations });
    await expect(port.createConversation()).resolves.toBe("conversation_internal");
    await port.runPrompt("conversation_internal", "synthetic prompt", {
      onStarted: () => order.push("started"),
      onDelta: (delta) => order.push(delta),
    });
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
        readEvents: async () => ["run.started", "run.failed"],
        restartApiWorker: async () => undefined,
      },
    });
    await expect(port.runPrompt("conversation_internal", "synthetic", {
      onStarted() {},
      onDelta() {},
    })).rejects.toThrowError("CLIENT_RUN_FAILED");
  });
});
