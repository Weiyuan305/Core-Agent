import type { ClaimedJob, ProvisionFailureResult } from "@core-agent/runtime-core";

import type { HandlerResult } from "./dispatch-job.js";

export type NonReconcileRecoveryJob = ClaimedJob & { jobKind: "provision_runtime" | "dispatch_outbox" };

export interface NonReconcileRecoveryPort {
  failRuntime(job: NonReconcileRecoveryJob, summary: string): Promise<ProvisionFailureResult>;
  complete(job: NonReconcileRecoveryJob): Promise<boolean>;
}

export async function handleNonReconcileRecovery(
  port: NonReconcileRecoveryPort,
  job: NonReconcileRecoveryJob,
): Promise<HandlerResult | undefined> {
  if (!job.recoveryOnly) return undefined;
  if (job.jobKind === "provision_runtime") {
    const text = "Final-attempt recovery cannot safely replay runtime provisioning";
    const result = await port.failRuntime(job, text);
    if (result.kind === "lease_lost") return { kind: "failed", summary: "Worker job lease lost" };
    if (result.kind === "superseded") return { kind: "succeeded" };
    return { kind: "failed", summary: text };
  }
  if (!await port.complete(job)) return { kind: "failed", summary: "Worker job lease lost" };
  return { kind: "succeeded" };
}
