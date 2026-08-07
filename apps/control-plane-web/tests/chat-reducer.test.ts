import { describe, expect, it } from "vitest";

import { initialChatState, reduceChatState } from "../src/client/state/chat-reducer.js";

const firstId = `chat_${"a".repeat(32)}`;

function bootstrapped() {
  return reduceChatState(initialChatState(), {
    type: "bootstrap.loaded",
    conversationIds: [firstId],
    selectedConversationId: firstId,
  });
}

describe("chat reducer", () => {
  it("keeps an editable draft while a run streams", () => {
    const submitted = reduceChatState(bootstrapped(), { type: "run.started", localMessage: "hello" });
    const streaming = reduceChatState(submitted, { type: "run.frame", frame: { type: "run.started" } });
    const edited = reduceChatState(streaming, { type: "draft.changed", value: "next" });
    expect(edited.conversations[firstId]?.draft).toBe("next");
    expect(edited.conversations[firstId]?.status).toBe("streaming");
  });

  it("inserts the consultant once and appends deltas to one assistant turn", () => {
    let state = reduceChatState(bootstrapped(), { type: "run.started", localMessage: "请给建议" });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "run.started" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "message.delta", delta: "先" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "message.delta", delta: "准备" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "message.completed" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "run.completed" } });

    expect(state.conversations[firstId]?.turns.map((turn) => [turn.role, turn.content])).toEqual([
      ["consultant", "请给建议"],
      ["assistant", "先准备"],
    ]);
    expect(state.conversations[firstId]?.status).toBe("idle");
  });

  it("retains partial content and its public failure reason", () => {
    let state = reduceChatState(bootstrapped(), { type: "run.started", localMessage: "重试这条" });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "run.started" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "message.delta", delta: "部分内容" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "run.failed", reason: "REPLY_INTERRUPTED" } });
    expect(state.conversations[firstId]?.status).toBe("failed");
    expect(state.conversations[firstId]?.lastSubmittedMessage).toBe("重试这条");
    expect(state.conversations[firstId]?.turns).toHaveLength(2);
    expect(state.conversations[firstId]?.turns.at(-1)).toMatchObject({
      content: "部分内容",
      delivery: "failed",
      failureReason: "REPLY_INTERRUPTED",
    });
  });

  it("starts an explicit retry without duplicating the consultant turn", () => {
    let state = reduceChatState(bootstrapped(), { type: "run.started", localMessage: "只出现一次" });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "run.started" } });
    state = reduceChatState(state, { type: "run.frame", frame: { type: "run.failed", reason: "BUSY" } });
    state = reduceChatState(state, { type: "retry.started" });
    expect(state.conversations[firstId]?.turns.map((turn) => turn.role)).toEqual([
      "consultant",
      "assistant",
      "assistant",
    ]);
    expect(state.conversations[firstId]?.turns.filter((turn) => turn.role === "consultant")).toHaveLength(1);
    expect(state.conversations[firstId]?.status).toBe("submitting");
  });

  it("rejects impossible reducer transitions", () => {
    expect(() => reduceChatState(bootstrapped(), {
      type: "run.frame",
      frame: { type: "message.delta", delta: "out of order" },
    })).toThrowError("CLIENT_STATE_INVALID");
  });
});
