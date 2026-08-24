import type { StopIdleRuntimeResult } from "@core-agent/runtime-core";

import type { HandlerResult } from "../dispatch-job.js";

interface StopIdleB2cRuntimeJob {
  readonly tenantId: string;
  readonly jobId: string;
  readonly attemptCount: number;
  readonly payloadRef: string;
}

export interface StopIdleB2cRuntimePort {
  stop(input: {
    tenantId: string;
    jobId: string;
    workerId: string;
    attemptCount: number;
    runtimeId: string;
  }): Promise<StopIdleRuntimeResult>;
}

export async function handleStopIdleB2cRuntime(
  port: StopIdleB2cRuntimePort,
  job: StopIdleB2cRuntimeJob,
  signal: AbortSignal,
  workerId = "control_plane_worker",
): Promise<HandlerResult> {
  if (signal.aborted) return { kind: "failed", summary: "Worker job lease lost" };
  const result = await port.stop({
    tenantId: job.tenantId,
    jobId: job.jobId,
    workerId,
    attemptCount: job.attemptCount,
    runtimeId: job.payloadRef,
  });
  return result.kind === "lease_lost"
    ? { kind: "failed", summary: "Worker job lease lost" }
    : { kind: "succeeded" };
}
