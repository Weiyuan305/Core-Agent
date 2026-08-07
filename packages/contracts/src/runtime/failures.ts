import Type from "typebox";

import { type ContractViolation, violation } from "../common/validation.js";

export const AGENT_RUN_FAILURE_CODES = [
  "MODEL_BUSY",
  "MODEL_SERVICE_UNAVAILABLE",
  "MODEL_RESPONSE_TIMEOUT",
  "MODEL_ACCESS_DENIED",
  "MODEL_NOT_AVAILABLE",
  "MODEL_RESPONSE_INVALID",
  "MODEL_STREAM_INTERRUPTED",
  "MODEL_EMPTY_RESPONSE",
  "AGENT_RUNTIME_NOT_READY",
  "RUN_INTERNAL_ERROR",
  "RUN_FAILURE_UNKNOWN",
] as const;

export const AgentRunFailureCodeSchema = Type.Union(
  [
    Type.Literal("MODEL_BUSY"),
    Type.Literal("MODEL_SERVICE_UNAVAILABLE"),
    Type.Literal("MODEL_RESPONSE_TIMEOUT"),
    Type.Literal("MODEL_ACCESS_DENIED"),
    Type.Literal("MODEL_NOT_AVAILABLE"),
    Type.Literal("MODEL_RESPONSE_INVALID"),
    Type.Literal("MODEL_STREAM_INTERRUPTED"),
    Type.Literal("MODEL_EMPTY_RESPONSE"),
    Type.Literal("AGENT_RUNTIME_NOT_READY"),
    Type.Literal("RUN_INTERNAL_ERROR"),
    Type.Literal("RUN_FAILURE_UNKNOWN"),
  ],
);

export type AgentRunFailureCode = (typeof AGENT_RUN_FAILURE_CODES)[number];

export function validateAgentRunFailureState(run: {
  readonly status: string;
  readonly failure_code?: AgentRunFailureCode;
}): ContractViolation[] {
  if (run.status === "failed" && run.failure_code === undefined) {
    return [violation("RUN_FAILURE_CODE_REQUIRED", "failure_code", "Failed Agent Runs require a failure code")];
  }
  if (run.status !== "failed" && run.failure_code !== undefined) {
    return [violation("RUN_FAILURE_CODE_FORBIDDEN", "failure_code", "Only failed Agent Runs may carry a failure code")];
  }
  return [];
}
