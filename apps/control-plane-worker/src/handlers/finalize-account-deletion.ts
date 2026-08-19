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

async function settleFailure(
  port: AccountDeletionFinalizationPort,
  job: AccountDeletionFinalizationJob,
  summary: string,
): Promise<HandlerResult> {
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
  let failureSummary = "Account deletion authority is unavailable";
  try {
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    let facts = await port.load(job, null, 50);
    if (facts.kind === "not_due") {
      return settleFailure(port, job, "Account deletion finalization is not due");
    }
    if (facts.kind === "not_found") {
      return settleFailure(port, job, "Account deletion authority is unavailable");
    }
    if (facts.kind === "cancelled" || facts.kind === "deleted") {
      if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
      return { kind: "succeeded" };
    }
    failureSummary = "Account deletion effect fencing is unavailable";
    if (job.effectState === "pre_effect" && !await port.markEffectDispatched(job)) {
      return { kind: "failed", summary: "Worker job lease lost" };
    }
    failureSummary = "Identity provider deletion is unavailable";
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
    failureSummary = "Account deletion Core finalization is unavailable";
    const finalized = await port.finalize(job);
    if (finalized === "not_due") throw new Error("Account deletion database deadline changed");
    failureSummary = "Account deletion job settlement is unavailable";
    if (!await port.succeed(job)) return { kind: "failed", summary: "Worker job lease lost" };
    return { kind: "succeeded" };
  } catch {
    if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
    return settleFailure(port, job, failureSummary);
  }
}
