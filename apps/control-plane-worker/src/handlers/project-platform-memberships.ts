import type { PlatformMembershipProjectionPage } from "@core-agent/runtime-core";

import type { HandlerResult } from "../dispatch-job.js";

interface PlatformMembershipProjectionJob {
  readonly tenantId: string;
  readonly jobId: string;
  readonly payloadRef: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export interface PlatformMembershipProjectionPort {
  project(
    assignmentId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PlatformMembershipProjectionPage>;
  succeed(job: PlatformMembershipProjectionJob): Promise<boolean>;
  retry(job: PlatformMembershipProjectionJob, summary: string): Promise<boolean>;
  fail(job: PlatformMembershipProjectionJob, summary: string): Promise<boolean>;
}

function boundedSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : "Platform Membership projection failed";
  return text.replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]").slice(0, 1000)
    || "Platform Membership projection failed";
}

export async function handleProjectPlatformMemberships(
  port: PlatformMembershipProjectionPort,
  job: PlatformMembershipProjectionJob,
  signal: AbortSignal,
): Promise<HandlerResult> {
  try {
    let cursor: string | null = null;
    while (true) {
      if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
      const page = await port.project(job.payloadRef, cursor, 100);
      if (page.done) break;
      if (page.nextCursor === null || page.nextCursor === cursor) {
        throw new Error("Platform Membership projection cursor did not advance");
      }
      cursor = page.nextCursor;
    }
    if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "succeeded" };
  } catch (error) {
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    const summary = boundedSummary(error);
    if (job.attemptCount < job.maxAttempts) {
      if (!await port.retry(job, summary)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "retry", summary };
    }
    if (!await port.fail(job, summary)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "failed", summary };
  }
}
