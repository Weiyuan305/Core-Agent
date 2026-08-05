export interface WorkerLoopJob { readonly jobId: string }

export interface WorkerLoopPort<Job extends WorkerLoopJob = WorkerLoopJob> {
  tick?(): Promise<void>;
  claim(limit: number): Promise<readonly Job[]>;
  dispatch(job: Job, signal: AbortSignal): Promise<void>;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export async function runWorkerLoop<Job extends WorkerLoopJob>(port: WorkerLoopPort<Job>, signal: AbortSignal): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const start = (job: Job): void => {
    let dispatched: Promise<void>;
    try { dispatched = port.dispatch(job, signal); }
    catch (error) { dispatched = Promise.reject(error); }
    let task: Promise<void>;
    task = dispatched
      .catch(() => undefined)
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
  };

  try {
    while (!signal.aborted) {
      await port.tick?.();
      if (signal.aborted) break;
      const freeSlots = 8 - inFlight.size;
      if (freeSlots > 0) {
        const jobs = await port.claim(freeSlots);
        if (signal.aborted) break;
        if (jobs.length > freeSlots) throw new Error("Platform Worker claim exceeded process concurrency");
        for (const job of jobs) {
          if (signal.aborted) break;
          start(job);
        }
        if (jobs.length > 0) continue;
      }
      if (signal.aborted) break;
      const timer = port.wait(250, signal);
      if (inFlight.size === 0) await timer;
      else await Promise.race([timer, ...inFlight]);
    }
  } finally {
    await Promise.allSettled(inFlight);
  }
}
