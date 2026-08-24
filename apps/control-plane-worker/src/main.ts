import {
  claimOutboxWakeups, claimPlatformWorkerJobs, completeJob, createRedactor, failJob, failOutbox,
  deriveRuntimeContainerId,
  finalizeAccountDeletion, heartbeatJob, loadAccountDeletionFinalization, markJobEffectDispatched,
  markOutboxDelivered, projectPlatformMemberships, rescheduleJob, rescheduleOutbox, retryDecision,
  OUTBOX_MAX_ATTEMPTS,
  withAgentRunConversationLock, withRuntimeAdvisoryLock, WorkerAgentRunRepository, WorkerRuntimeRepository,
  CapabilityProjectionRepository,
  type ClaimedJob, type HermesChatInput, type ProviderCatalog, type Redactor, type RuntimeDatabase,
  type SecretStore, type SupervisorRequest, type SupervisorResponse,
} from "@core-agent/runtime-core";
import { sql, type Kysely } from "kysely";

import { dispatchJob, type DispatchPort, type HandlerResult } from "./dispatch-job.js";
import { dispatchOutbox } from "./handlers/dispatch-outbox.js";
import { handleExecuteAgentRun } from "./handlers/execute-agent-run.js";
import { handleFinalizeAccountDeletion } from "./handlers/finalize-account-deletion.js";
import { handleProjectPlatformMemberships } from "./handlers/project-platform-memberships.js";
import { buildProvisionRuntimeRequest, handleProvisionRuntime, validatePrivateHermesOrigin } from "./handlers/provision-runtime.js";
import { handleReconcileCapabilityProjection } from "./handlers/reconcile-capability-projection.js";
import { handleReconcileRuntime } from "./handlers/reconcile-runtime.js";
import { inspectAgentRunRuntime } from "./inspect-agent-runtime.js";
import { handleNonReconcileRecovery } from "./recovery-boundary.js";
import { runWorkerLoop } from "./worker-loop.js";

export const implementedWorkerJobKinds = [
  "provision_runtime", "reconcile_runtime", "execute_agent_run", "dispatch_outbox",
  "project_platform_memberships", "finalize_account_deletion", "reconcile_capability_projection",
] as const;

export function workerClaimJobKinds(
  dependencies: Pick<WorkerDependencies, "identityDb" | "identityProviderDeletion">,
): readonly ClaimedJob["jobKind"][] {
  const hasIdentityDatabase = dependencies.identityDb !== undefined;
  const hasProviderDeletion = dependencies.identityProviderDeletion !== undefined;
  if (hasIdentityDatabase !== hasProviderDeletion) {
    throw new Error("Identity account-deletion finalizer configuration is incomplete");
  }
  return hasIdentityDatabase
    ? implementedWorkerJobKinds
    : implementedWorkerJobKinds.filter((kind) => kind !== "finalize_account_deletion");
}

export interface WorkerClock {
  now(): Date;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  scheduleEvery(callback: () => Promise<void>, milliseconds: number): () => void;
}
export interface WorkerLogger { info(fields: object, message: string): void; error(fields: object, message: string): void }
export interface HermesReadinessClient {
  probe(input: { origin: string; profileRef: string; sessionId: string; ingressKey: string; modelId: string }, signal: AbortSignal): Promise<void>;
}
export interface HermesExecutionClient { streamChat(input: HermesChatInput): AsyncIterable<string> }
export interface WorkerIdentityProviderDeletionClient {
  inspectProviderSubject(providerSubject: string): Promise<"present" | "absent">;
  deleteProviderSubject(providerSubject: string): Promise<void>;
}
export interface WorkerSupervisorClient {
  execute(request: SupervisorRequest, signal?: AbortSignal): Promise<SupervisorResponse>;
}
export interface WorkerRepositories {
  readonly runtimes: WorkerRuntimeRepository;
  readonly capabilityProjections: CapabilityProjectionRepository;
  readonly agentRuns: WorkerAgentRunRepository;
  readonly redactor: Redactor;
}
export interface WorkerDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly identityDb?: Kysely<RuntimeDatabase>;
  readonly workerId: string;
  readonly clock: WorkerClock;
  readonly logger: WorkerLogger;
  readonly repositories: WorkerRepositories;
  readonly providerCatalog: ProviderCatalog;
  readonly supervisorClient: WorkerSupervisorClient;
  readonly ingressSecretStore: SecretStore;
  readonly hermesClient: HermesReadinessClient;
  readonly executionHermesClient: HermesExecutionClient;
  readonly identityProviderDeletion?: WorkerIdentityProviderDeletionClient;
}

function jobRef(dependencies: WorkerDependencies, job: ClaimedJob) {
  return { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId, attemptCount: job.attemptCount, runtimeId: job.payloadRef };
}
function nextAttempt(dependencies: WorkerDependencies, job: ClaimedJob, summary: string): { at: Date; summary: string } {
  const decision = retryDecision({ code: "DEPENDENCY_UNAVAILABLE", retryable: true, summary }, job.attemptCount, job.maxAttempts, dependencies.clock.now(), () => 0, dependencies.repositories.redactor);
  return { at: decision.nextAttemptAt ?? dependencies.clock.now(), summary: decision.summary };
}

async function dispatchRuntimeJob(dependencies: WorkerDependencies, job: ClaimedJob, signal: AbortSignal): Promise<HandlerResult> {
  if (job.jobKind === "project_platform_memberships") return handleProjectPlatformMemberships({
    project: (assignmentId, cursor, limit) => projectPlatformMemberships(dependencies.db, assignmentId, cursor, limit),
    succeed: async (projectionJob) => (await completeJob(dependencies.db, {
      tenantId: projectionJob.tenantId, jobId: projectionJob.jobId,
      workerId: dependencies.workerId, attemptCount: projectionJob.attemptCount,
    })).kind === "updated",
    retry: async (projectionJob, summary) => {
      const retry = nextAttempt(dependencies, job, summary);
      return (await rescheduleJob(dependencies.db, {
        tenantId: projectionJob.tenantId, jobId: projectionJob.jobId,
        workerId: dependencies.workerId, attemptCount: projectionJob.attemptCount,
        nextAttemptAt: retry.at, lastErrorSummary: retry.summary,
        redactor: dependencies.repositories.redactor,
      })).kind === "updated";
    },
    fail: async (projectionJob, summary) => (await failJob(dependencies.db, {
      tenantId: projectionJob.tenantId, jobId: projectionJob.jobId,
      workerId: dependencies.workerId, attemptCount: projectionJob.attemptCount,
      lastErrorSummary: summary, redactor: dependencies.repositories.redactor,
    })).kind === "updated",
  }, job, signal);
  if (job.jobKind === "finalize_account_deletion") {
    const identityDb = dependencies.identityDb ?? dependencies.db;
    const provider = dependencies.identityProviderDeletion;
    const ownedJob = {
      tenantId: job.tenantId, jobId: job.jobId,
      workerId: dependencies.workerId, attemptCount: job.attemptCount,
    };
    return handleFinalizeAccountDeletion({
      load: (_deletionJob, cursor, limit) => loadAccountDeletionFinalization(identityDb, job.payloadRef, cursor, limit),
      markEffectDispatched: async () => (await markJobEffectDispatched(dependencies.db, ownedJob)).kind === "updated",
      inspectProviderSubject: async (providerSubject) => {
        if (provider === undefined) throw new Error("Identity provider deletion is not configured");
        return provider.inspectProviderSubject(providerSubject);
      },
      deleteProviderSubject: async (providerSubject) => {
        if (provider === undefined) throw new Error("Identity provider deletion is not configured");
        await provider.deleteProviderSubject(providerSubject);
      },
      finalize: async () => (await finalizeAccountDeletion({ db: identityDb }, {
        accountDeletionId: job.payloadRef,
      })).kind,
      succeed: async () => (await completeJob(dependencies.db, ownedJob)).kind === "updated",
      retry: async (_deletionJob, summary) => {
        const retry = nextAttempt(dependencies, job, summary);
        return (await rescheduleJob(dependencies.db, {
          ...ownedJob, nextAttemptAt: retry.at, lastErrorSummary: retry.summary,
          redactor: dependencies.repositories.redactor,
        })).kind === "updated";
      },
      fail: async (_deletionJob, summary) => (await failJob(dependencies.db, {
        ...ownedJob, lastErrorSummary: summary, redactor: dependencies.repositories.redactor,
      })).kind === "updated",
    }, job, signal);
  }
  if (job.jobKind === "reconcile_capability_projection") {
    const owned = {
      tenantId: job.tenantId,
      jobId: job.jobId,
      workerId: dependencies.workerId,
      attemptCount: job.attemptCount,
      projectionId: job.payloadRef,
    };
    return withRuntimeAdvisoryLock(dependencies.db, job.tenantId, deriveRuntimeContainerId(job.tenantId), () => (
      handleReconcileCapabilityProjection({
        prepare: async () => {
          const prepared = await dependencies.repositories.capabilityProjections.prepare(owned);
          if (prepared.kind !== "ready") return prepared;
          const runtime = await dependencies.repositories.runtimes.loadProvisionFacts(
            job.tenantId,
            prepared.facts.runtimeId,
            dependencies.providerCatalog,
          );
          if (runtime.imageRef !== prepared.facts.imageRef) throw new Error("Capability projection Runtime image changed");
          return {
            kind: "ready" as const,
            facts: Object.freeze({
              ...prepared.facts,
              platform: runtime.platform,
              volumeRef: runtime.volumeRef,
              ingressSecretRef: runtime.ingressSecretRef,
              profiles: runtime.profiles,
            }),
          };
        },
        markEffectDispatched: async () => (
          await markJobEffectDispatched(dependencies.db, {
            tenantId: job.tenantId,
            jobId: job.jobId,
            workerId: dependencies.workerId,
            attemptCount: job.attemptCount,
          })
        ).kind === "updated",
        supervisor: async (request, operationSignal) => {
          const response = await dependencies.supervisorClient.execute(request, operationSignal);
          if (response.protocol_version !== 2) throw new Error("Capability projection Supervisor protocol mismatch");
          return response;
        },
        complete: (_projectionJob, facts, observation) => dependencies.repositories.capabilityProjections.complete(owned, facts, observation),
        retry: async (_projectionJob, failure) => {
          const retry = nextAttempt(dependencies, job, failure.summary);
          return dependencies.repositories.capabilityProjections.retry(owned, retry.summary, retry.at);
        },
        fail: (_projectionJob, failure) => dependencies.repositories.capabilityProjections.fail(
          owned,
          failure.reasonCode,
          failure.summary,
        ),
      }, {
        tenantId: job.tenantId,
        jobId: job.jobId,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        effectState: job.effectState,
      }, signal)
    ));
  }
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
      supervisor: async (request, operationSignal) => {
        const response = await dependencies.supervisorClient.execute(request, operationSignal);
        if (response.protocol_version !== 1) throw new Error("Runtime provisioning Supervisor protocol mismatch");
        return response;
      },
      getIngressMaterial: (reference) => dependencies.ingressSecretStore.get(reference),
      probe: (input, operationSignal) => dependencies.hermesClient.probe(input, operationSignal),
      succeed: () => dependencies.repositories.runtimes.finishProvision(ref),
      retry: async (_job, summary) => { const retry = nextAttempt(dependencies, job, summary); return dependencies.repositories.runtimes.retryProvisionJob(ref, retry.summary, retry.at); },
      fail: (_job, summary) => dependencies.repositories.runtimes.failProvisionJob(ref, summary),
    }, job, signal);
  });
  if (job.jobKind === "reconcile_runtime") return withRuntimeAdvisoryLock(dependencies.db, job.tenantId, job.payloadRef, () => handleReconcileRuntime({
    loadFacts: () => dependencies.repositories.runtimes.loadReconcileFacts(job.tenantId, job.payloadRef),
    supervisor: async (request, operationSignal) => {
      const response = await dependencies.supervisorClient.execute(request, operationSignal);
      if (response.protocol_version !== 1) throw new Error("Runtime reconcile Supervisor protocol mismatch");
      return response;
    },
    reprovision: async (_job, operationSignal) => {
      const facts = await dependencies.repositories.runtimes.loadProvisionFacts(job.tenantId, job.payloadRef, dependencies.providerCatalog);
      const response = await dependencies.supervisorClient.execute(buildProvisionRuntimeRequest(facts, `${job.jobId}:effect-reprovision`), operationSignal);
      if (response.protocol_version !== 1) throw new Error("Runtime reprovision Supervisor protocol mismatch");
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
    succeed: async (_job, success) => success.kind === "superseded"
      ? dependencies.repositories.runtimes.completeSuperseded(ref, {
        runtimeId: job.payloadRef,
        targetCommandVersion: job.targetCommandVersion,
        command: job.runtimeCommand,
        effectState: job.effectState,
      })
      : dependencies.repositories.runtimes.finishReconcile(ref, { ...success, targetCommandVersion: job.targetCommandVersion }),
    retry: async (_job, summary) => { const retry = nextAttempt(dependencies, job, summary); return dependencies.repositories.runtimes.retryReconcile(ref, job.targetCommandVersion, retry.summary, retry.at); },
    fail: (_job, summary) => dependencies.repositories.runtimes.failReconcile(ref, job.targetCommandVersion, summary),
  }, { tenantId: job.tenantId, jobId: job.jobId, attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, targetCommandVersion: job.targetCommandVersion, command: job.runtimeCommand, effectState: job.effectState, recoveryOnly: job.recoveryOnly }, signal));
  if (job.jobKind === "execute_agent_run") return withAgentRunConversationLock(
    dependencies.db,
    { tenantId: job.tenantId, runId: job.payloadRef, signal },
    () => handleExecuteAgentRun({
    begin: (runJob) => dependencies.repositories.agentRuns.begin(runJob),
    inspectRuntime: (facts, operationSignal) => inspectAgentRunRuntime({
      execute: async (request, inspectSignal) => {
        const response = await dependencies.supervisorClient.execute(request, inspectSignal);
        if (response.protocol_version !== 1) throw new Error("Agent Runtime inspect Supervisor protocol mismatch");
        return response;
      },
    }, facts, job.attemptCount, operationSignal),
    markDispatched: (runJob) => dependencies.repositories.agentRuns.markDispatched(runJob),
    stream: (facts, origin, operationSignal) => ({ async *[Symbol.asyncIterator]() {
      const material = await dependencies.ingressSecretStore.get(facts.ingressSecretRef);
      yield* dependencies.executionHermesClient.streamChat({
        origin, profileRef: facts.profileRef, sessionRef: facts.sessionRef, ingressMaterial: material,
        modelId: facts.modelId, timeoutMs: facts.timeoutMs, content: facts.content, signal: operationSignal,
      });
    } }),
    persistDelta: (runJob, messageId, delta) => dependencies.repositories.agentRuns.persistDelta(runJob, messageId, delta),
    complete: (runJob, facts, content) => dependencies.repositories.agentRuns.complete(runJob, facts, content),
    retry: (runJob, summary) => {
      const retry = nextAttempt(dependencies, job, summary);
      return dependencies.repositories.agentRuns.retry(runJob, retry.summary, retry.at);
    },
    fail: (runJob, summary) => dependencies.repositories.agentRuns.fail(runJob, summary),
    }, job, signal, dependencies.workerId),
  );
  if (job.jobKind === "dispatch_outbox") {
    const recovery = await handleNonReconcileRecovery({
      failRuntime: async () => ({ kind: "lease_lost" }),
      complete: async () => (await completeJob(dependencies.db, { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId, attemptCount: job.attemptCount })).kind === "updated",
    }, job);
    if (recovery !== undefined) return recovery;
    await pollOutbox(dependencies);
    await completeJob(dependencies.db, { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId, attemptCount: job.attemptCount });
    return { kind: "succeeded" };
  }
  throw new Error("Stored Worker job kind is not implemented");
}

async function pollOutbox(dependencies: WorkerDependencies): Promise<void> {
  await dispatchOutbox({
    claim: (workerId, limit) => claimOutboxWakeups(dependencies.db, { workerId, limit, leaseMs: 30_000 }),
    notify: async (payload) => { await sql`select pg_notify('core_agent_events', ${payload})`.execute(dependencies.db); },
    delivered: async (row, workerId) => (await markOutboxDelivered(dependencies.db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId, attemptCount: row.attemptCount })).kind === "updated",
    retry: async (row, workerId, summary) => row.attemptCount >= OUTBOX_MAX_ATTEMPTS
      ? (await failOutbox(dependencies.db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId, attemptCount: row.attemptCount, lastErrorSummary: summary, redactor: dependencies.repositories.redactor })).kind === "updated"
      : (await rescheduleOutbox(dependencies.db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId, attemptCount: row.attemptCount, nextAttemptAt: new Date(dependencies.clock.now().getTime() + Math.min(60_000, 500 * 2 ** Math.max(0, row.attemptCount - 1))), lastErrorSummary: summary, redactor: dependencies.repositories.redactor })).kind === "updated",
  }, dependencies.workerId);
}

export async function runControlPlaneWorker(dependencies: WorkerDependencies, signal: AbortSignal): Promise<void> {
  const claimJobKinds = workerClaimJobKinds(dependencies);
  const dispatchPort: DispatchPort = {
    workerId: dependencies.workerId, heartbeatEveryMs: 10_000,
    scheduleHeartbeat: (callback, milliseconds) => dependencies.clock.scheduleEvery(callback, milliseconds),
    heartbeat: async (job) => (await heartbeatJob(dependencies.db, { tenantId: job.tenantId, jobId: job.jobId, workerId: dependencies.workerId, attemptCount: job.attemptCount, leaseMs: 30_000 })).kind,
    handle: (job, operationSignal) => dispatchRuntimeJob(dependencies, job, operationSignal),
  };
  await runWorkerLoop({
    tick: () => pollOutbox(dependencies),
    claim: (limit) => claimPlatformWorkerJobs(dependencies.db, {
      workerId: dependencies.workerId, limit, leaseMs: 30_000, jobKinds: claimJobKinds,
    }),
    dispatch: (job, operationSignal) => dispatchJob(dispatchPort, job, operationSignal),
    wait: (milliseconds, operationSignal) => dependencies.clock.wait(milliseconds, operationSignal),
  }, signal);
}

export function createWorkerRuntimeRepositories(
  db: Kysely<RuntimeDatabase>,
  providerCatalog: ProviderCatalog,
  redactor: Redactor = createRedactor([]),
): WorkerRepositories {
  return {
    runtimes: new WorkerRuntimeRepository(db, redactor),
    capabilityProjections: new CapabilityProjectionRepository(db),
    agentRuns: new WorkerAgentRunRepository(db, providerCatalog, redactor),
    redactor,
  };
}
