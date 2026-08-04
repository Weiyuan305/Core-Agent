import { DomainError, type DependencyFailure } from "./idempotency.js";
import { redactSummary } from "./redaction.js";

export interface RetryDecision {
  disposition: "retry" | "permanent";
  nextAttemptAt?: Date;
  summary: string;
}

export function retryDecision(
  failure: DependencyFailure,
  attemptCount: number,
  maxAttempts: number,
  now: Date,
  random: () => number,
): RetryDecision {
  const summary = redactSummary(failure.summary, 1000);
  if (!failure.retryable || attemptCount >= maxAttempts) return { disposition: "permanent", summary };
  const ceilingMs = Math.min(60_000, 500 * 2 ** Math.max(0, attemptCount - 1));
  const jitterMs = Math.floor(ceilingMs * 0.25 * random());
  return { disposition: "retry", nextAttemptAt: new Date(now.getTime() + ceilingMs + jitterMs), summary };
}

export function classifyDependencyFailure(error: unknown): DependencyFailure {
  if (error instanceof DomainError && (
    error.code === "DEPENDENCY_UNAVAILABLE" || error.code === "DEPENDENCY_TIMEOUT" || error.code === "SUPERVISOR_REJECTED"
  )) return { code: error.code, retryable: error.retryable, summary: error.message };
  if (error instanceof Error) return { code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary: error.message };
  return { code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary: "Dependency failed" };
}
