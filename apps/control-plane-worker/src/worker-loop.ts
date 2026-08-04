export interface WorkerLoopJob { readonly jobId: string }

export interface WorkerLoopPort<Job extends WorkerLoopJob = WorkerLoopJob> {
  tick?(): Promise<void>;
  claim(limit: 8): Promise<readonly Job[]>;
  dispatch(job: Job, signal: AbortSignal): Promise<void>;
  wait(milliseconds: 250, signal: AbortSignal): Promise<void>;
}

export async function runWorkerLoop<Job extends WorkerLoopJob>(port: WorkerLoopPort<Job>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await port.tick?.();
    const jobs = await port.claim(8);
    if (jobs.length > 8) throw new Error("Platform Worker claim exceeded process concurrency");
    if (jobs.length === 0) {
      if (!signal.aborted) await port.wait(250, signal);
      continue;
    }
    await Promise.allSettled(jobs.map((job) => port.dispatch(job, signal)));
  }
}
