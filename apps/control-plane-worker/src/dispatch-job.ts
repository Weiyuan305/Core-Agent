import type { ClaimedJob } from "@core-agent/runtime-core";

export type HandlerResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "retry"; readonly summary: string }
  | { readonly kind: "failed"; readonly summary: string };

export interface DispatchPort {
  readonly workerId: string;
  readonly heartbeatEveryMs: 10_000;
  scheduleHeartbeat(callback: () => Promise<void>, milliseconds: 10_000): () => void;
  heartbeat(job: ClaimedJob): Promise<"updated" | "lease_lost">;
  handle(job: ClaimedJob, signal: AbortSignal): Promise<HandlerResult>;
}

export async function dispatchJob(port: DispatchPort, job: ClaimedJob, parentSignal: AbortSignal): Promise<void> {
  if (parentSignal.aborted) return;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const clearHeartbeat = port.scheduleHeartbeat(async () => {
    if (controller.signal.aborted) return;
    try {
      if (await port.heartbeat(job) === "lease_lost") controller.abort(new Error("Worker job lease lost"));
    } catch {
      controller.abort(new Error("Worker job heartbeat failed"));
    }
  }, port.heartbeatEveryMs);
  try {
    await port.handle(job, controller.signal);
  } finally {
    clearHeartbeat();
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}
