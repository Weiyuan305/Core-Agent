import { DomainError, type DependencyFailure } from "./idempotency.js";
import { createRedactor, redactSummary, type Redactor } from "./redaction.js";

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
  redactor: Redactor = createRedactor([]),
): RetryDecision {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) throw new RangeError("attemptCount must be positive");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be positive");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must be a valid Date");
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) throw new RangeError("random must return a value from 0 inclusive through 1 exclusive");
  const summary = redactSummary(failure.summary, 1000, redactor);
  if (!failure.retryable || attemptCount >= maxAttempts) return { disposition: "permanent", summary };
  const ceilingMs = Math.min(60_000, 500 * 2 ** Math.max(0, attemptCount - 1));
  const jitterMs = Math.floor(ceilingMs * 0.25 * randomValue);
  return { disposition: "retry", nextAttemptAt: new Date(now.getTime() + ceilingMs + jitterMs), summary };
}

export function classifyDependencyFailure(error: unknown): DependencyFailure {
  if (error instanceof DomainError && (
    error.code === "DEPENDENCY_UNAVAILABLE" || error.code === "DEPENDENCY_TIMEOUT" || error.code === "SUPERVISOR_REJECTED"
  )) return { code: error.code, retryable: error.retryable, summary: error.message };
  if (error instanceof Error) return { code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary: error.message };
  return { code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary: "Dependency failed" };
}
