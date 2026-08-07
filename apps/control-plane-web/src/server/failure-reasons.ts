import type { AgentRunFailureCode } from "@core-agent/contracts";

import type { ClientRunFailureReason } from "../shared/protocol.js";

const publicReasonByFailureCode: Readonly<Record<AgentRunFailureCode, ClientRunFailureReason>> = Object.freeze({
  MODEL_BUSY: "BUSY",
  MODEL_SERVICE_UNAVAILABLE: "TEMPORARILY_UNAVAILABLE",
  MODEL_RESPONSE_TIMEOUT: "TOOK_TOO_LONG",
  MODEL_ACCESS_DENIED: "SERVICE_UNAVAILABLE",
  MODEL_NOT_AVAILABLE: "SERVICE_UNAVAILABLE",
  MODEL_RESPONSE_INVALID: "TEMPORARILY_UNAVAILABLE",
  MODEL_STREAM_INTERRUPTED: "REPLY_INTERRUPTED",
  MODEL_EMPTY_RESPONSE: "NO_REPLY",
  AGENT_RUNTIME_NOT_READY: "ASSISTANT_PREPARING",
  RUN_INTERNAL_ERROR: "UNKNOWN",
  RUN_FAILURE_UNKNOWN: "UNKNOWN",
});

export function mapAgentRunFailureCode(code: unknown): ClientRunFailureReason {
  if (typeof code !== "string" || !Object.hasOwn(publicReasonByFailureCode, code)) {
    return "UNKNOWN";
  }
  return publicReasonByFailureCode[code as AgentRunFailureCode];
}

export function isExplicitRetryReason(reason: ClientRunFailureReason): boolean {
  return reason !== "SERVICE_UNAVAILABLE" && reason !== "ASSISTANT_PREPARING";
}
