import { createHash } from "node:crypto";

import type { RuntimeContainer } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { ProviderCatalog } from "../config/provider-catalog.js";
import type { RuntimeDatabase } from "../db/database.js";
import type { TenantTransaction } from "../db/transaction.js";
import { assertRuntimeObservedTransition } from "../domain/transitions.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";
import { validateSupervisorResponse, type RuntimeObservation } from "../supervisor/contracts.js";
import type { SecretReference } from "../secrets/secret-store.js";
import { appendAuditEvent, appendProductEvents } from "./events.js";
import { safeContractInteger } from "./resources.js";

const actorId = "core_agent_provisioner";
const membershipId = "core_agent_provisioner_admin";

export interface RuntimeWorkerJobRef {
  readonly tenantId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly attemptCount: number;
  readonly runtimeId: string;
}
export type ProvisionAdmissionResult = { readonly kind: "admitted" | "superseded" | "lease_lost" };
export type ProvisionCompletionResult = { readonly kind: "completed" | "superseded" | "lease_lost" };
export type ProvisionFailureResult = { readonly kind: "failed" | "superseded" | "lease_lost" };
export type ReconcileRetryResult = { readonly kind: "retried" | "superseded" | "lease_lost" };
export type ReconcileFailureResult = { readonly kind: "failed" | "superseded" | "lease_lost" };
export type ReconcileSuccessIntent =
  | { readonly kind: "inspect_proved"; readonly command: "start" | "stop" | "delete"; readonly targetCommandVersion: number; readonly observation: RuntimeObservation }
  | { readonly kind: "effect_dispatched"; readonly command: "start" | "stop" | "restart" | "delete"; readonly targetCommandVersion: number; readonly observation: RuntimeObservation };
export interface ReconcileClaimedIntent {
  readonly runtimeId: string;
  readonly targetCommandVersion: number;
  readonly command: "start" | "stop" | "restart" | "delete";
  readonly effectState: "pre_effect" | "unsafe_to_replay";
}
export interface StoredProvisionProfile {
  readonly profileId: string; readonly hermesProfileRef: string; readonly description: string;
  readonly providerConfigId: string; readonly providerBaseUrl: string; readonly modelId: string;
  readonly providerSecretRef: SecretReference;
}
export interface StoredProvisionFacts {
  readonly tenantId: string; readonly runtimeId: string; readonly generation: number;
  readonly imageRef: string; readonly platform: "linux/amd64" | "linux/arm64";
  readonly volumeRef: string; readonly ingressSecretRef: SecretReference;
  readonly profiles: readonly StoredProvisionProfile[];
}
export interface StoredReconcileFacts {
  readonly tenantId: string; readonly runtimeId: string; readonly generation: number;
  readonly imageRef: string; readonly commandVersion: number;
  readonly observedState: RuntimeContainer["observed_state"];
  readonly desiredState: RuntimeContainer["desired_state"];
}

function id(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 32)}`;
}
class LeaseFenceLost extends Error {}

function exactOwnDataValues(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function parseReconcileSuccessIntent(value: unknown): ReconcileSuccessIntent | undefined {
  try {
    const intent = exactOwnDataValues(value, ["kind", "command", "targetCommandVersion", "observation"]);
    if (intent === undefined) return undefined;
    const { kind, command, targetCommandVersion, observation } = intent;
    if (kind !== "inspect_proved" && kind !== "effect_dispatched") return undefined;
    if (command !== "start" && command !== "stop" && command !== "restart" && command !== "delete") return undefined;
    if (typeof targetCommandVersion !== "number" || !Number.isSafeInteger(targetCommandVersion) || targetCommandVersion < 1) return undefined;
    const response = validateSupervisorResponse({ protocol_version: 1, operation_id: "intent_validation", outcome: "accepted", observation });
    if (response.outcome !== "accepted") return undefined;
    if (kind === "inspect_proved") {
      if (command === "restart") return undefined;
      return { kind, command, targetCommandVersion, observation: response.observation };
    }
    return { kind, command, targetCommandVersion, observation: response.observation };
  } catch {
    return undefined;
  }
}

function parseReconcileClaimedIntent(value: unknown): ReconcileClaimedIntent | undefined {
  try {
    const intent = exactOwnDataValues(value, ["runtimeId", "targetCommandVersion", "command", "effectState"]);
    if (intent === undefined) return undefined;
    const { runtimeId, targetCommandVersion, command, effectState } = intent;
    if (typeof runtimeId !== "string" || runtimeId.length < 1) return undefined;
    if (typeof targetCommandVersion !== "number" || !Number.isSafeInteger(targetCommandVersion) || targetCommandVersion < 1) return undefined;
    if (command !== "start" && command !== "stop" && command !== "restart" && command !== "delete") return undefined;
    if (effectState !== "pre_effect" && effectState !== "unsafe_to_replay") return undefined;
    return { runtimeId, targetCommandVersion, command, effectState };
  } catch {
    return undefined;
  }
}

async function ownsLease(trx: Transaction<RuntimeDatabase>, job: RuntimeWorkerJobRef, lock = false): Promise<boolean> {
  if (lock) {
    return await trx.selectFrom("worker_jobs").select("job_id").where("tenant_id", "=", job.tenantId)
      .where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId)
      .where("attempt_count", "=", job.attemptCount)
      .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .forUpdate().executeTakeFirst() !== undefined;
  }
  return await trx.selectFrom("worker_jobs").select("job_id").where("tenant_id", "=", job.tenantId)
    .where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId)
    .where("attempt_count", "=", job.attemptCount)
    .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
    .executeTakeFirst() !== undefined;
}
async function requireLease(trx: Transaction<RuntimeDatabase>, job: RuntimeWorkerJobRef, lock = false): Promise<void> {
  if (!await ownsLease(trx, job, lock)) throw new LeaseFenceLost();
}
async function fencedTransaction(db: Kysely<RuntimeDatabase>, work: (trx: Transaction<RuntimeDatabase>) => Promise<void>): Promise<boolean> {
  try {
    await db.transaction().execute(work);
    return true;
  } catch (error) {
    if (error instanceof LeaseFenceLost) return false;
    throw error;
  }
}
async function provisionTransaction<Result extends { readonly kind: string }>(
  db: Kysely<RuntimeDatabase>, work: (trx: Transaction<RuntimeDatabase>) => Promise<Result>,
): Promise<Result | { readonly kind: "lease_lost" }> {
  try { return await db.transaction().execute(work); }
  catch (error) {
    if (error instanceof LeaseFenceLost) return { kind: "lease_lost" };
    throw error;
  }
}
async function finishOwnedJob(trx: Transaction<RuntimeDatabase>, job: RuntimeWorkerJobRef, update: Record<string, unknown>): Promise<void> {
  const result = await trx.updateTable("worker_jobs").set(update).where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
    .where("lease_owner", "=", job.workerId).where("status", "=", "running")
    .where("attempt_count", "=", job.attemptCount)
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) throw new LeaseFenceLost();
}
function eventBase(job: RuntimeWorkerJobRef, eventId: string, now: Date) {
  return { schema_version: 1 as const, event_id: eventId, occurred_at: now.toISOString(), tenant_id: job.tenantId,
    request_id: id("request_worker", job.jobId), trace_id: id("trace_worker", job.jobId),
    correlation_id: job.runtimeId, causation_id: job.jobId };
}
async function appendStatus(context: TenantTransaction, job: RuntimeWorkerJobRef, state: RuntimeContainer["observed_state"], now: Date): Promise<void> {
  await appendProductEvents(context, { streamId: `runtime_${job.runtimeId}`, deliveryTarget: "internal_event_stream", events: [{
    ...eventBase(job, id("event_runtime_status", job.jobId, state), now), event_type: "runtime.status_changed", payload: { container_id: job.runtimeId, observed_state: state },
  }] });
}
async function appendWorkerAudit(context: TenantTransaction, job: RuntimeWorkerJobRef, action: string, outcome: "pending" | "succeeded" | "failed", summary: string, version: number, now: Date): Promise<void> {
  await appendAuditEvent(context, { schema_version: 1, audit_event_id: id("audit_worker", job.jobId, action, outcome), occurred_at: now.toISOString(), tenant_id: job.tenantId,
    actor_id: actorId, membership_id: membershipId, effective_role: "admin", action, resource_type: "runtime_container", resource_id: job.runtimeId,
    decision: "allowed", outcome, request_id: id("request_worker", job.jobId), trace_id: id("trace_worker", job.jobId), reason_summary: summary, resource_version: version });
}
async function transition(trx: Transaction<RuntimeDatabase>, context: TenantTransaction, job: RuntimeWorkerJobRef, from: RuntimeContainer["observed_state"], to: RuntimeContainer["observed_state"], health: RuntimeContainer["health_status"], now: Date): Promise<number> {
  assertRuntimeObservedTransition(from, to);
  const updated = await trx.updateTable("runtime_containers").set({ observed_state: to, health_status: health, resource_version: sql`resource_version + 1`, updated_at: now })
    .where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).where("observed_state", "=", from)
    .returning("resource_version").executeTakeFirstOrThrow();
  await appendStatus(context, job, to, now);
  return safeContractInteger(updated.resource_version);
}

export class WorkerRuntimeRepository {
  public constructor(private readonly db: Kysely<RuntimeDatabase>, private readonly redactor: Redactor, private readonly now: () => Date = () => new Date()) {}

  public async loadProvisionFacts(tenantId: string, runtimeId: string, providerCatalog: ProviderCatalog): Promise<StoredProvisionFacts> {
    const runtime = await this.db.selectFrom("runtime_containers").select(["tenant_id", "container_id", "generation", "image_ref", "runtime_platform", "volume_ref"])
      .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId).executeTakeFirstOrThrow();
    if (runtime.runtime_platform !== "linux/amd64" && runtime.runtime_platform !== "linux/arm64") throw new Error("Runtime platform is unavailable; legacy runtime fails closed");
    const ingressRows = await this.db.selectFrom("secret_references").select(["reference_id", "version", "status"])
      .where("tenant_id", "=", tenantId).where("purpose", "=", "integration").where("status", "=", "active").execute();
    if (ingressRows.length !== 1) throw new Error("Runtime ingress secret metadata is unavailable");
    const profiles = await this.db.selectFrom("profiles").select(["profile_id", "hermes_profile_ref", "description", "provider_config_id", "model_id"])
      .where("tenant_id", "=", tenantId).where("status", "in", ["provisioning", "active"]).orderBy("hermes_profile_ref").execute();
    if (profiles.length === 0) throw new Error("Runtime profiles are unavailable");
    const mapped: StoredProvisionProfile[] = [];
    for (const profile of profiles) {
      const provider = providerCatalog.require(profile.provider_config_id, profile.model_id);
      const secret = await this.db.selectFrom("secret_references").select(["reference_id", "version", "status"])
        .where("tenant_id", "=", tenantId).where("reference_id", "=", provider.credential_secret_ref)
        .where("purpose", "=", "provider_credential").where("status", "=", "active").executeTakeFirstOrThrow();
      mapped.push({ profileId: profile.profile_id, hermesProfileRef: profile.hermes_profile_ref, description: profile.description,
        providerConfigId: profile.provider_config_id, providerBaseUrl: provider.base_url, modelId: profile.model_id,
        providerSecretRef: { reference_id: secret.reference_id, version: safeContractInteger(secret.version), purpose: "model_provider" } });
    }
    const ingress = ingressRows[0]!;
    return { tenantId, runtimeId, generation: runtime.generation, imageRef: runtime.image_ref, platform: runtime.runtime_platform,
      volumeRef: runtime.volume_ref, ingressSecretRef: { reference_id: ingress.reference_id, version: safeContractInteger(ingress.version), purpose: "hermes_ingress" }, profiles: mapped };
  }

  public async beginProvision(job: RuntimeWorkerJobRef): Promise<ProvisionAdmissionResult> {
    return provisionTransaction(this.db, async (trx) => {
      await requireLease(trx, job, true);
      const row = await trx.selectFrom("runtime_containers").select(["observed_state", "resource_version", "command_version"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      await requireLease(trx, job);
      if (safeContractInteger(row.command_version) > 0) {
        await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() });
        return { kind: "superseded" } as const;
      }
      if (row.observed_state === "provisioning") return { kind: "admitted" } as const;
      if (row.observed_state !== "requested") throw new Error("Runtime is not provisionable");
      const context = { tenantId: job.tenantId, trx };
      const version = await transition(trx, context, job, "requested", "provisioning", "unknown", this.now());
      await appendWorkerAudit(context, job, "runtime.provision", "pending", "Runtime provisioning started", version, this.now());
      return { kind: "admitted" } as const;
    });
  }

  public async finishProvision(job: RuntimeWorkerJobRef): Promise<ProvisionCompletionResult> {
    return provisionTransaction(this.db, async (trx) => {
      const claimed = await trx.selectFrom("worker_jobs").select(["job_kind", "payload_ref", "container_id", "effect_state"])
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId)
        .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate().executeTakeFirst();
      if (claimed === undefined || claimed.job_kind !== "provision_runtime" || claimed.payload_ref !== job.runtimeId
        || claimed.container_id !== job.runtimeId || claimed.effect_state !== "pre_effect") throw new LeaseFenceLost();
      const current = await trx.selectFrom("runtime_containers").select(["observed_state", "command_version"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      await requireLease(trx, job);
      if (safeContractInteger(current.command_version) > 0) {
        await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() });
        return { kind: "superseded" } as const;
      }
      if (current.observed_state !== "provisioning") throw new Error("Runtime provisioning state changed");
      const now = this.now(); const context = { tenantId: job.tenantId, trx };
      await transition(trx, context, job, "provisioning", "starting", "unknown", now);
      const version = await transition(trx, context, job, "starting", "ready", "healthy", now);
      await trx.updateTable("runtime_containers").set({ last_probed_at: now, failure_summary: null }).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).execute();
      await trx.updateTable("tenants").set({ status: "active", resource_version: sql`resource_version + 1`, updated_at: now }).where("tenant_id", "=", job.tenantId).where("status", "=", "provisioning").execute();
      await trx.updateTable("profiles").set({ status: "active", resource_version: sql`resource_version + 1`, updated_at: now }).where("tenant_id", "=", job.tenantId).where("status", "=", "provisioning").execute();
      await appendWorkerAudit(context, job, "runtime.provision", "succeeded", "Runtime provisioning completed after Profile readiness probes", version, now);
      await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: null, updated_at: now });
      return { kind: "completed" } as const;
    });
  }

  public async failProvisionJob(job: RuntimeWorkerJobRef, summary: string): Promise<ProvisionFailureResult> {
    return provisionTransaction(this.db, async (trx) => {
      const claimed = await trx.selectFrom("worker_jobs").select("job_kind")
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("job_kind", "=", "provision_runtime")
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId)
        .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate().executeTakeFirst();
      if (claimed?.job_kind !== "provision_runtime") throw new LeaseFenceLost();
      const row = await trx.selectFrom("runtime_containers").select(["observed_state", "resource_version", "command_version"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      await requireLease(trx, job);
      if (safeContractInteger(row.command_version) > 0) {
        await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() });
        return { kind: "superseded" } as const;
      }
      const now = this.now(); const context = { tenantId: job.tenantId, trx }; let version = safeContractInteger(row.resource_version);
      if (row.observed_state !== "failed" && row.observed_state !== "deleted") version = await transition(trx, context, job, row.observed_state as RuntimeContainer["observed_state"], "failed", "unhealthy", now);
      const redacted = redactSummary(summary, 1000, this.redactor);
      await trx.updateTable("runtime_containers").set({ failure_summary: redacted }).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).execute();
      await appendWorkerAudit(context, job, "runtime.provision", "failed", redacted, version, now);
      await finishOwnedJob(trx, job, { status: "failed", lease_owner: null, lease_expires_at: null, last_error_summary: redacted, updated_at: now });
      return { kind: "failed" } as const;
    });
  }

  public async retryProvisionJob(job: RuntimeWorkerJobRef, summary: string, nextAttemptAt: Date): Promise<boolean> {
    const result = await this.db.updateTable("worker_jobs").set({ status: "retrying", lease_owner: null, lease_expires_at: null, next_attempt_at: nextAttemptAt,
      last_error_summary: redactSummary(summary, 1000, this.redactor), updated_at: this.now() }).where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
      .where("job_kind", "=", "provision_runtime").where("attempt_count", "=", job.attemptCount)
      .where("lease_owner", "=", job.workerId).where("status", "=", "running")
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  private async finalizeReconcileFailure(job: RuntimeWorkerJobRef, targetCommandVersion: number, summary: string, nextAttemptAt?: Date): Promise<ReconcileRetryResult | ReconcileFailureResult> {
    return provisionTransaction(this.db, async (trx) => {
      const claimed = await trx.selectFrom("worker_jobs").select(["job_kind", "target_command_version"])
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId)
        .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate().executeTakeFirst();
      if (claimed === undefined || claimed.job_kind !== "reconcile_runtime" || claimed.target_command_version === null
        || safeContractInteger(claimed.target_command_version) !== targetCommandVersion) throw new LeaseFenceLost();
      const row = await trx.selectFrom("runtime_containers").select(["observed_state", "resource_version", "command_version"])
        .where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      await requireLease(trx, job);
      if (safeContractInteger(row.command_version) !== targetCommandVersion) {
        await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() });
        return { kind: "superseded" } as const;
      }
      const redacted = redactSummary(summary, 1000, this.redactor); const now = this.now();
      if (nextAttemptAt !== undefined) {
        await finishOwnedJob(trx, job, { status: "retrying", lease_owner: null, lease_expires_at: null, next_attempt_at: nextAttemptAt, last_error_summary: redacted, updated_at: now });
        return { kind: "retried" } as const;
      }
      const context = { tenantId: job.tenantId, trx }; let version = safeContractInteger(row.resource_version);
      if (row.observed_state !== "failed" && row.observed_state !== "deleted") version = await transition(trx, context, job, row.observed_state as RuntimeContainer["observed_state"], "failed", "unhealthy", now);
      await trx.updateTable("runtime_containers").set({ failure_summary: redacted }).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).execute();
      await appendWorkerAudit(context, job, "runtime.reconcile", "failed", redacted, version, now);
      await finishOwnedJob(trx, job, { status: "failed", lease_owner: null, lease_expires_at: null, last_error_summary: redacted, updated_at: now });
      return { kind: "failed" } as const;
    });
  }

  public async retryReconcile(job: RuntimeWorkerJobRef, targetCommandVersion: number, summary: string, nextAttemptAt: Date): Promise<ReconcileRetryResult> {
    return this.finalizeReconcileFailure(job, targetCommandVersion, summary, nextAttemptAt) as Promise<ReconcileRetryResult>;
  }

  public async failReconcile(job: RuntimeWorkerJobRef, targetCommandVersion: number, summary: string): Promise<ReconcileFailureResult> {
    return this.finalizeReconcileFailure(job, targetCommandVersion, summary) as Promise<ReconcileFailureResult>;
  }

  public async loadReconcileFacts(tenantId: string, runtimeId: string): Promise<StoredReconcileFacts> {
    const row = await this.db.selectFrom("runtime_containers").select(["tenant_id", "container_id", "generation", "image_ref", "command_version", "observed_state", "desired_state"])
      .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId).executeTakeFirstOrThrow();
    return { tenantId, runtimeId, generation: row.generation, imageRef: row.image_ref, commandVersion: safeContractInteger(row.command_version), observedState: row.observed_state as RuntimeContainer["observed_state"], desiredState: row.desired_state as RuntimeContainer["desired_state"] };
  }

  public async completeSuperseded(job: RuntimeWorkerJobRef, value: ReconcileClaimedIntent): Promise<boolean> {
    const intent = parseReconcileClaimedIntent(value);
    if (intent === undefined || intent.runtimeId !== job.runtimeId) return false;
    return fencedTransaction(this.db, async (trx) => {
      const claimed = await trx.selectFrom("worker_jobs").select(["job_kind", "payload_ref", "container_id", "runtime_command", "target_command_version", "effect_state"])
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId)
        .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate().executeTakeFirst();
      if (claimed === undefined || claimed.job_kind !== "reconcile_runtime" || claimed.payload_ref !== intent.runtimeId
        || claimed.container_id !== intent.runtimeId || claimed.runtime_command !== intent.command
        || claimed.target_command_version === null || safeContractInteger(claimed.target_command_version) !== intent.targetCommandVersion
        || claimed.effect_state !== intent.effectState) throw new LeaseFenceLost();
      await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() });
    });
  }

  public async isCurrentCommand(job: RuntimeWorkerJobRef, targetCommandVersion: number): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!await ownsLease(trx, job, true)) return false;
      const row = await trx.selectFrom("runtime_containers").select("command_version").where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).executeTakeFirst();
      return row !== undefined && safeContractInteger(row.command_version) === targetCommandVersion;
    });
  }

  public async markReconcileEffectDispatched(
    job: RuntimeWorkerJobRef,
    command: "start" | "stop" | "restart" | "delete",
    targetCommandVersion: number,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const claimed = await trx.selectFrom("worker_jobs").select(["job_kind", "payload_ref", "container_id", "runtime_command", "target_command_version", "effect_state"])
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId).where("status", "=", "running")
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).forUpdate().executeTakeFirst();
      if (claimed === undefined || claimed.job_kind !== "reconcile_runtime" || claimed.payload_ref !== job.runtimeId
        || claimed.container_id !== job.runtimeId || claimed.runtime_command !== command
        || claimed.target_command_version === null || safeContractInteger(claimed.target_command_version) !== targetCommandVersion
        || claimed.effect_state !== "pre_effect") return false;
      const runtime = await trx.selectFrom("runtime_containers").select("command_version")
        .where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirst();
      if (runtime === undefined || !await ownsLease(trx, job) || safeContractInteger(runtime.command_version) !== targetCommandVersion) return false;
      const result = await trx.updateTable("worker_jobs").set({ effect_state: "unsafe_to_replay", updated_at: this.now() })
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("payload_ref", "=", job.runtimeId).where("container_id", "=", job.runtimeId)
        .where("job_kind", "=", "reconcile_runtime").where("runtime_command", "=", command)
        .where("target_command_version", "=", String(targetCommandVersion)).where("effect_state", "=", "pre_effect")
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId).where("status", "=", "running")
        .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  public async finishReconcile(job: RuntimeWorkerJobRef, value: ReconcileSuccessIntent): Promise<boolean> {
    const intent = parseReconcileSuccessIntent(value);
    if (intent === undefined) return false;
    return fencedTransaction(this.db, async (trx) => {
      const claimed = await trx.selectFrom("worker_jobs").select(["job_kind", "payload_ref", "container_id", "runtime_command", "target_command_version", "effect_state"])
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
        .where("attempt_count", "=", job.attemptCount).where("lease_owner", "=", job.workerId)
        .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate().executeTakeFirst();
      if (claimed === undefined) throw new LeaseFenceLost();
      const wrongEffectState = intent.kind === "inspect_proved"
        ? claimed.effect_state !== "pre_effect"
        : claimed.effect_state !== "unsafe_to_replay";
      if (claimed.job_kind !== "reconcile_runtime" || claimed.payload_ref !== job.runtimeId
        || claimed.container_id !== job.runtimeId || claimed.runtime_command !== intent.command || claimed.target_command_version === null
        || safeContractInteger(claimed.target_command_version) !== intent.targetCommandVersion || wrongEffectState) throw new LeaseFenceLost();
      const row = await trx.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state", "health_status"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      await requireLease(trx, job);
      if (safeContractInteger(row.command_version) !== intent.targetCommandVersion) {
        await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() });
        return;
      }
      const { command, observation } = intent;
      const validObservation = command === "delete"
        ? !observation.exists && observation.lifecycle === "removed"
        : command === "stop"
          ? observation.exists && observation.lifecycle === "stopped"
          : observation.exists && observation.lifecycle === "running" && observation.health === "healthy";
      if (!validObservation) throw new Error("Supervisor observation is not a healthy result for the runtime command");
      const now = this.now(); const context = { tenantId: job.tenantId, trx }; let state = row.observed_state as RuntimeContainer["observed_state"];
      const alreadySatisfied = (command === "start" && state === "ready") || (command === "stop" && state === "stopped") || (command === "delete" && state === "deleted");
      if (alreadySatisfied && command === "start" && row.health_status !== "healthy") {
        await trx.updateTable("runtime_containers").set({ health_status: "healthy", last_probed_at: now, resource_version: sql`resource_version + 1`, updated_at: now })
          .where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).execute();
      }
      const path: RuntimeContainer["observed_state"][] = command === "delete" ? ["deleting", "deleted"]
        : command === "stop" ? ["stopping", "stopped"]
          : state === "failed" || state === "ready" ? ["recovering", "starting", "ready"] : ["starting", "ready"];
      for (const next of alreadySatisfied ? [] : path) {
        if (state === next || (next === "starting" && state === "starting") || (next === "ready" && state === "ready")) continue;
        if (command === "start" && state === "ready") break;
        await transition(trx, context, job, state, next, next === "ready" ? observation.health : "unknown", now);
        state = next;
      }
      const final = await trx.selectFrom("runtime_containers").select("resource_version").where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).executeTakeFirstOrThrow();
      await appendWorkerAudit(context, job, `runtime.${command}`, "succeeded", "Runtime command reconciled with Supervisor observation", safeContractInteger(final.resource_version), now);
      await finishOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: null, updated_at: now });
    });
  }
}
