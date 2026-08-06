import { describe, expect, it } from "vitest";

import {
  CLIENT_FRAME_MAX_BYTES,
  decodeClientFrame,
  encodeClientFrame,
  isValidClientMessage,
  type ClientFrame,
} from "../src/shared/protocol.js";

describe("client frame protocol", () => {
  it.each<ClientFrame>([
    { type: "run.started" },
    { type: "message.delta", delta: "你好" },
    { type: "message.completed" },
    { type: "run.completed" },
    { type: "run.failed", code: "CLIENT_RUN_FAILED" },
  ])("round-trips an allowlisted $type frame", (frame) => {
    expect(decodeClientFrame(encodeClientFrame(frame))).toEqual(frame);
  });

  it.each([
    { type: "message.delta", delta: "" },
    { type: "message.delta", delta: "ok", extra: true },
    { type: "unknown" },
    { type: "run.failed", code: "raw upstream body" },
  ])("rejects an invalid frame without reflecting it: %j", (value) => {
    expect(() => decodeClientFrame(JSON.stringify(value))).toThrowError("CLIENT_FRAME_INVALID");
  });

  it("rejects frames above the byte limit", () => {
    const value = JSON.stringify({ type: "message.delta", delta: "x".repeat(CLIENT_FRAME_MAX_BYTES) });
    expect(() => decodeClientFrame(value)).toThrowError("CLIENT_FRAME_INVALID");
  });
});

describe("synthetic browser input", () => {
  it.each(["hello", "你好", "a".repeat(4_000)])("accepts bounded visible text", (value) => {
    expect(isValidClientMessage(value)).toBe(true);
  });

  it.each(["", "a".repeat(4_001), "bad\u0000text", "bad\ntext", "/new"]) (
    "rejects invalid input",
    (value) => expect(isValidClientMessage(value)).toBe(false),
  );
});
