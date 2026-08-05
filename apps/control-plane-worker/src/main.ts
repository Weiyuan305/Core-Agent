import {
  claimOutboxWakeups, claimPlatformWorkerJobs, completeJob, createRedactor, failOutbox,
  heartbeatJob, markOutboxDelivered, rescheduleOutbox, retryDecision,
  withRuntimeAdvisoryLock, WorkerRuntimeRepository,
  type ClaimedJob, type ProviderCatalog, type Redactor, type RuntimeDatabase,
  type RuntimeSupervisorClient, type SecretStore,
} from "@core-agent/runtime-core";
import { sql, type Kysely } from "kysely";

import { dispatchJob, type DispatchPort, type HandlerResult } from "./dispatch-job.js";
import { dispatchOutbox } from "./handlers/dispatch-outbox.js";
import { buildProvisionRuntimeRequest, handleProvisionRuntime, validatePrivateHermesOrigin } from "./handlers/provision-runtime.js";
import { handleReconcileRuntime } from "./handlers/reconcile-runtime.js";
import { handleNonReconcileRecovery } from "./recovery-boundary.js";
import { runWorkerLoop } from "./worker-loop.js";

export const implementedWorkerJobKinds = ["provision_runtime", "reconcile_runtime", "dispatch_outbox"] as const;

export interface WorkerClock {
  now(): Date;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  scheduleEvery(callback: () => Promise<void>, milliseconds: number): () => void;
}
export interface WorkerLogger { info(fields: object, message: string): void; error(fields: object, message: string): void }
export interface HermesReadinessClient {
  probe(input: { origin: string; profileRef: string; sessionId: string; ingressKey: string; modelId: string }, signal: AbortSignal): Promise<void>;
}
export interface WorkerRepositories { readonly runtimes: WorkerRuntimeRepository; readonly redactor: Redactor }
export interface WorkerDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly workerId: string;
  readonly clock: WorkerClock;
  readonly logger: WorkerLogger;
  readonly repositories: WorkerRepositories;
  readonly providerCatalog: ProviderCatalog;
  readonly supervisorClient: Pick<RuntimeSupervisorClient, "execute">;
  readonly ingressSecretStore: SecretStore;
  readonly hermesClient: HermesReadinessClient;
}

function jobRef(dependencies: WorkerDependencies, job: ClaimedJob) {
  return { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId, runtimeId: job.payloadRef };
}
function nextAttempt(dependencies: WorkerDependencies, job: ClaimedJob, summary: string): { at: Date; summary: string } {
  const decision = retryDecision({ code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary }, job.attemptCount, job.maxAttempts, dependencies.clock.now(), () => 0, dependencies.repositories.redactor);
  return { at: decision.nextAttemptAt ?? dependencies.clock.now(), summary: decision.summary };
}

async function dispatchRuntimeJob(dependencies: WorkerDependencies, job: ClaimedJob, signal: AbortSignal): Promise<HandlerResult> {
  const ref = jobRef(dependencies, job);
  if (job.jobKind === "provision_runtime") return withRuntimeAdvisoryLock(dependencies.db, job.tenantId, job.payloadRef, async () => {
    const recovery = await handleNonReconcileRecovery({
      failRuntime: (_job, summary) => dependencies.repositories.runtimes.failProvisionJob(ref, summary),
      complete: async () => false,
    }, job);
    if (recovery !== undefined) return recovery;
    return handleProvisionRuntime({
      transitionToProvisioning: () => dependencies.repositories.runtimes.beginProvision(ref),
      loadFacts: () => dependencies.repositories.runtimes.loadProvisionFacts(job.tenantId, job.payloadRef, dependencies.providerCatalog),
      supervisor: (request, operationSignal) => dependencies.supervisorClient.execute(request, operationSignal),
      getIngressMaterial: (reference) => dependencies.ingressSecretStore.get(reference),
      probe: (input, operationSignal) => dependencies.hermesClient.probe(input, operationSignal),
      succeed: () => dependencies.repositories.runtimes.finishProvision(ref),
      retry: async (_job, summary) => { const retry = nextAttempt(dependencies, job, summary); return dependencies.repositories.runtimes.retryJob(ref, retry.summary, retry.at); },
      fail: (_job, summary) => dependencies.repositories.runtimes.failProvisionJob(ref, summary),
    }, job, signal);
  });
  if (job.jobKind === "reconcile_runtime") return withRuntimeAdvisoryLock(dependencies.db, job.tenantId, job.payloadRef, () => handleReconcileRuntime({
    loadFacts: () => dependencies.repositories.runtimes.loadReconcileFacts(job.tenantId, job.payloadRef),
    supervisor: (request, operationSignal) => dependencies.supervisorClient.execute(request, operationSignal),
    reprovision: async (_job, operationSignal) => {
      const facts = await dependencies.repositories.runtimes.loadProvisionFacts(job.tenantId, job.payloadRef, dependencies.providerCatalog);
      const response = await dependencies.supervisorClient.execute(buildProvisionRuntimeRequest(facts, `${job.jobId}:effect-reprovision`), operationSignal);
      if (response.outcome !== "accepted") return response;
      const observation = response.observation;
      if (observation.tenant_id !== facts.tenantId || observation.runtime_id !== facts.runtimeId || observation.generation !== facts.generation || observation.image_ref !== facts.imageRef || !observation.exists || observation.lifecycle !== "running") throw new Error("Supervisor reprovision observation does not match stored runtime identity");
      const origin = validatePrivateHermesOrigin(observation.private_origin);
      const material = await dependencies.ingressSecretStore.get(facts.ingressSecretRef);
      try {
        for (const profile of facts.profiles) await dependencies.hermesClient.probe({ origin, profileRef: profile.hermesProfileRef, sessionId: `readiness-${facts.runtimeId}-${facts.generation}`, ingressKey: material.text(), modelId: profile.modelId }, operationSignal);
      } finally { material.release(); }
      return response;
    },
    isCurrent: () => dependencies.repositories.runtimes.isCurrentCommand(ref, job.targetCommandVersion),
    markEffectDispatched: () => dependencies.repositories.runtimes.markReconcileEffectDispatched(ref, job.runtimeCommand, job.targetCommandVersion),
    succeed: async (_job, response) => response?.outcome === "accepted"
      ? dependencies.repositories.runtimes.finishReconcile(ref, job.runtimeCommand, job.targetCommandVersion, response.observation)
      : dependencies.repositories.runtimes.completeSuperseded(ref),
    retry: async (_job, summary) => { const retry = nextAttempt(dependencies, job, summary); return dependencies.repositories.runtimes.retryJob(ref, retry.summary, retry.at); },
    fail: (_job, summary) => dependencies.repositories.runtimes.failRuntimeJob(ref, summary),
  }, { tenantId: job.tenantId, jobId: job.jobId, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, targetCommandVersion: job.targetCommandVersion, command: job.runtimeCommand, effectState: job.effectState, recoveryOnly: job.recoveryOnly }, signal));
  if (job.jobKind === "dispatch_outbox") {
    const recovery = await handleNonReconcileRecovery({
      failRuntime: async () => ({ kind: "lease_lost" }),
      complete: async () => (await completeJob(dependencies.db, { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId })).kind === "updated",
    }, job);
    if (recovery !== undefined) return recovery;
    await pollOutbox(dependencies);
    await completeJob(dependencies.db, { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId });
    return { kind: "succeeded" };
  }
  throw new Error("execute_agent_run is not available before the Run execution milestone");
}

async function pollOutbox(dependencies: WorkerDependencies): Promise<void> {
  await dispatchOutbox({
    claim: (workerId, limit) => claimOutboxWakeups(dependencies.db, { workerId, limit, leaseMs: 30_000 }),
    notify: async (payload) => { await sql`select pg_notify('core_agent_events', ${payload})`.execute(dependencies.db); },
    delivered: async (row, workerId) => (await markOutboxDelivered(dependencies.db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId })).kind === "updated",
    retry: async (row, workerId, summary) => row.attemptCount !== undefined && row.attemptCount >= 10
      ? (await failOutbox(dependencies.db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId, lastErrorSummary: summary, redactor: dependencies.repositories.redactor })).kind === "updated"
      : (await rescheduleOutbox(dependencies.db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId, nextAttemptAt: new Date(dependencies.clock.now().getTime() + Math.min(60_000, 500 * 2 ** Math.max(0, (row.attemptCount ?? 1) - 1))), lastErrorSummary: summary, redactor: dependencies.repositories.redactor })).kind === "updated",
  }, dependencies.workerId);
}

export async function runControlPlaneWorker(dependencies: WorkerDependencies, signal: AbortSignal): Promise<void> {
  const dispatchPort: DispatchPort = {
    workerId: dependencies.workerId, heartbeatEveryMs: 10_000,
    scheduleHeartbeat: (callback, milliseconds) => dependencies.clock.scheduleEvery(callback, milliseconds),
    heartbeat: async (job) => (await heartbeatJob(dependencies.db, { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId, leaseMs: 30_000 })).kind,
    handle: (job, operationSignal) => dispatchRuntimeJob(dependencies, job, operationSignal),
  };
  await runWorkerLoop({
    tick: () => pollOutbox(dependencies),
    claim: (limit) => claimPlatformWorkerJobs(dependencies.db, { workerId: dependencies.workerId, limit, leaseMs: 30_000, jobKinds: implementedWorkerJobKinds }),
    dispatch: (job, operationSignal) => dispatchJob(dispatchPort, job, operationSignal),
    wait: (milliseconds, operationSignal) => dependencies.clock.wait(milliseconds, operationSignal),
  }, signal);
}

export function createWorkerRuntimeRepositories(db: Kysely<RuntimeDatabase>, redactor: Redactor = createRedactor([])): WorkerRepositories {
  return { runtimes: new WorkerRuntimeRepository(db, redactor), redactor };
}
