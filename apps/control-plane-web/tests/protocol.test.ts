import { describe, expect, it } from "vitest";

import {
  CLIENT_FRAME_MAX_BYTES,
  decodeClientFrame,
  encodeClientFrame,
  isValidClientMessage,
  type ClientFrame,
} from "../src/shared/protocol.js";
import {
  isExplicitRetryReason,
  mapAgentRunFailureCode,
} from "../src/server/failure-reasons.js";

const publicReasons = [
  "BUSY",
  "TEMPORARILY_UNAVAILABLE",
  "TOOK_TOO_LONG",
  "SERVICE_UNAVAILABLE",
  "REPLY_INTERRUPTED",
  "NO_REPLY",
  "ASSISTANT_PREPARING",
  "UNKNOWN",
] as const;

describe("client frame protocol", () => {
  it.each<ClientFrame>([
    { type: "run.started" },
    { type: "message.delta", delta: "你好" },
    { type: "message.completed" },
    { type: "run.completed" },
    ...publicReasons.map((reason) => ({ type: "run.failed" as const, reason })),
  ])("round-trips an allowlisted $type frame", (frame) => {
    expect(decodeClientFrame(encodeClientFrame(frame))).toEqual(frame);
  });

  it.each([
    { type: "message.delta", delta: "" },
    { type: "message.delta", delta: "ok", extra: true },
    { type: "unknown" },
    { type: "run.failed", reason: "raw upstream body" },
    { type: "run.failed", reason: "UNKNOWN", code: "MODEL_BUSY" },
    { type: "run.failed", reason: "UNKNOWN", message: "provider body" },
    { type: "run.failed", reason: "UNKNOWN", run_id: "run_internal" },
    { type: "run.failed", reason: "UNKNOWN", provider: "private-provider" },
  ])("rejects an invalid frame without reflecting it: %j", (value) => {
    expect(() => decodeClientFrame(JSON.stringify(value))).toThrowError("CLIENT_FRAME_INVALID");
  });

  it("rejects frames above the byte limit", () => {
    const value = JSON.stringify({ type: "message.delta", delta: "x".repeat(CLIENT_FRAME_MAX_BYTES) });
    expect(() => decodeClientFrame(value)).toThrowError("CLIENT_FRAME_INVALID");
  });
});

describe("Agent Run failure projection", () => {
  it.each([
    ["MODEL_BUSY", "BUSY"],
    ["MODEL_SERVICE_UNAVAILABLE", "TEMPORARILY_UNAVAILABLE"],
    ["MODEL_RESPONSE_TIMEOUT", "TOOK_TOO_LONG"],
    ["MODEL_ACCESS_DENIED", "SERVICE_UNAVAILABLE"],
    ["MODEL_NOT_AVAILABLE", "SERVICE_UNAVAILABLE"],
    ["MODEL_RESPONSE_INVALID", "TEMPORARILY_UNAVAILABLE"],
    ["MODEL_STREAM_INTERRUPTED", "REPLY_INTERRUPTED"],
    ["MODEL_EMPTY_RESPONSE", "NO_REPLY"],
    ["AGENT_RUNTIME_NOT_READY", "ASSISTANT_PREPARING"],
    ["RUN_INTERNAL_ERROR", "UNKNOWN"],
    ["RUN_FAILURE_UNKNOWN", "UNKNOWN"],
    [undefined, "UNKNOWN"],
    ["MODEL_FUTURE_CODE", "UNKNOWN"],
  ] as const)("maps %s to %s", (internal, expected) => {
    expect(mapAgentRunFailureCode(internal)).toBe(expected);
  });

  it.each([
    ["BUSY", true],
    ["TEMPORARILY_UNAVAILABLE", true],
    ["TOOK_TOO_LONG", true],
    ["SERVICE_UNAVAILABLE", false],
    ["REPLY_INTERRUPTED", true],
    ["NO_REPLY", true],
    ["ASSISTANT_PREPARING", false],
    ["UNKNOWN", true],
  ] as const)("classifies explicit retry for %s", (reason, expected) => {
    expect(isExplicitRetryReason(reason)).toBe(expected);
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
