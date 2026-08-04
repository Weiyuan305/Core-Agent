import {
  canTransitionAgentRun,
  canTransitionContainerObservedState,
  type AgentRun,
  type RuntimeContainer,
} from "@core-agent/contracts";

import { DomainError } from "./idempotency.js";
import { createRedactor, redactSummary } from "./redaction.js";

export function assertRuntimeObservedTransition(
  from: RuntimeContainer["observed_state"],
  to: RuntimeContainer["observed_state"],
): void {
  if (!canTransitionContainerObservedState(from, to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Runtime observed-state transition is not allowed");
  }
}

export function assertAgentRunTransition(from: AgentRun["status"], to: AgentRun["status"]): void {
  if (["succeeded", "failed", "cancelled"].includes(from) || !canTransitionAgentRun(from, to)) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Agent Run transition is not allowed");
  }
}

export function redactedFailureSummary(value: string): string {
  return redactSummary(value, 1000, createRedactor([]));
}
