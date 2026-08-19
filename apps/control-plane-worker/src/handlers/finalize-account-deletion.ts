import type { HandlerResult } from "../dispatch-job.js";

export interface AccountDeletionFinalizationJob {
  readonly tenantId: string;
  readonly jobId: string;
  readonly payloadRef: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly effectState: "pre_effect" | "unsafe_to_replay";
  readonly recoveryOnly: boolean;
}

export interface AccountDeletionFinalizationPort {
  load(job: AccountDeletionFinalizationJob, cursor: string | null, limit: number): Promise<{
    readonly kind: "due" | "not_due" | "cancelled" | "deleted" | "not_found";
    readonly providerSubjects: readonly string[];
    readonly nextCursor: string | null;
    readonly done: boolean;
  }>;
  markEffectDispatched(job: AccountDeletionFinalizationJob): Promise<boolean>;
  inspectProviderSubject(providerSubject: string): Promise<"present" | "absent">;
  deleteProviderSubject(providerSubject: string): Promise<void>;
  finalize(job: AccountDeletionFinalizationJob): Promise<"deleted" | "already_terminal" | "not_due">;
  succeed(job: AccountDeletionFinalizationJob): Promise<boolean>;
  retry(job: AccountDeletionFinalizationJob, summary: string): Promise<boolean>;
  fail(job: AccountDeletionFinalizationJob, summary: string): Promise<boolean>;
}

function boundedSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : "Account deletion finalization failed";
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(token|password|secret)=\S+/giu, "$1=[REDACTED]")
    .slice(0, 1_000) || "Account deletion finalization failed";
}

async function settleFailure(
  port: AccountDeletionFinalizationPort,
  job: AccountDeletionFinalizationJob,
  error: unknown,
): Promise<HandlerResult> {
  const summary = boundedSummary(error);
  if (job.attemptCount < job.maxAttempts) {
    if (!await port.retry(job, summary)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "retry", summary };
  }
  if (!await port.fail(job, summary)) return { kind: "failed", summary: "Worker job lease lost" };
  return { kind: "failed", summary };
}

export async function handleFinalizeAccountDeletion(
  port: AccountDeletionFinalizationPort,
  job: AccountDeletionFinalizationJob,
  signal: AbortSignal,
): Promise<HandlerResult> {
  try {
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    let facts = await port.load(job, null, 50);
    if (facts.kind !== "due") {
      if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "succeeded" };
    }
    if (job.effectState === "pre_effect" && !await port.markEffectDispatched(job)) {
      return { kind: "failed", summary: "Worker job lease lost" };
    }
    let cursor: string | null = null;
    for (;;) {
      for (const providerSubject of facts.providerSubjects) {
        if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
        const authority = await port.inspectProviderSubject(providerSubject);
        if (authority === "present") await port.deleteProviderSubject(providerSubject);
      }
      if (facts.done) break;
      if (facts.nextCursor === null || facts.nextCursor === cursor) {
        throw new Error("Account deletion provider page cursor did not advance");
      }
      cursor = facts.nextCursor;
      facts = await port.load(job, cursor, 50);
      if (facts.kind !== "due") throw new Error("Account deletion finalization authority changed while paging");
    }
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    const finalized = await port.finalize(job);
    if (finalized === "not_due") throw new Error("Account deletion database deadline changed");
    if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "succeeded" };
  } catch (error) {
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    return settleFailure(port, job, error);
  }
}
