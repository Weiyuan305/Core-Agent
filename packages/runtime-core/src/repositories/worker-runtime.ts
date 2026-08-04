import { createHash } from "node:crypto";

import type { RuntimeContainer } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { ProviderCatalog } from "../config/provider-catalog.js";
import type { RuntimeDatabase } from "../db/database.js";
import type { TenantTransaction } from "../db/transaction.js";
import { assertRuntimeObservedTransition } from "../domain/transitions.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";
import type { RuntimeObservation } from "../supervisor/contracts.js";
import type { SecretReference } from "../secrets/secret-store.js";
import { appendAuditEvent, appendProductEvents } from "./events.js";
import { safeContractInteger } from "./resources.js";

const actorId = "core_agent_provisioner";
const membershipId = "core_agent_provisioner_admin";

export interface RuntimeWorkerJobRef {
  readonly tenantId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly runtimeId: string;
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
async function ownsLease(trx: Transaction<RuntimeDatabase>, job: RuntimeWorkerJobRef): Promise<boolean> {
  return await trx.selectFrom("worker_jobs").select("job_id").where("tenant_id", "=", job.tenantId)
    .where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId)
    .where("status", "=", "running").where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst() !== undefined;
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

  public async beginProvision(job: RuntimeWorkerJobRef): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!await ownsLease(trx, job)) return false;
      const row = await trx.selectFrom("runtime_containers").select(["observed_state", "resource_version"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      if (row.observed_state === "provisioning") return true;
      if (row.observed_state !== "requested") throw new Error("Runtime is not provisionable");
      const context = { tenantId: job.tenantId, trx };
      const version = await transition(trx, context, job, "requested", "provisioning", "unknown", this.now());
      await appendWorkerAudit(context, job, "runtime.provision", "pending", "Runtime provisioning started", version, this.now());
      return true;
    });
  }

  public async finishProvision(job: RuntimeWorkerJobRef): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!await ownsLease(trx, job)) return false;
      const current = await trx.selectFrom("runtime_containers").select("observed_state").where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      if (current.observed_state !== "provisioning") throw new Error("Runtime provisioning state changed");
      const now = this.now(); const context = { tenantId: job.tenantId, trx };
      await transition(trx, context, job, "provisioning", "starting", "unknown", now);
      const version = await transition(trx, context, job, "starting", "ready", "healthy", now);
      await trx.updateTable("runtime_containers").set({ last_probed_at: now, failure_summary: null }).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).execute();
      await trx.updateTable("tenants").set({ status: "active", resource_version: sql`resource_version + 1`, updated_at: now }).where("tenant_id", "=", job.tenantId).where("status", "=", "provisioning").execute();
      await trx.updateTable("profiles").set({ status: "active", resource_version: sql`resource_version + 1`, updated_at: now }).where("tenant_id", "=", job.tenantId).where("status", "=", "provisioning").execute();
      await appendWorkerAudit(context, job, "runtime.provision", "succeeded", "Runtime provisioning completed after Profile readiness probes", version, now);
      const result = await trx.updateTable("worker_jobs").set({ status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: null, updated_at: now })
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId).where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  public async retryJob(job: RuntimeWorkerJobRef, summary: string, nextAttemptAt: Date): Promise<boolean> {
    const result = await this.db.updateTable("worker_jobs").set({ status: "retrying", lease_owner: null, lease_expires_at: null, next_attempt_at: nextAttemptAt,
      last_error_summary: redactSummary(summary, 1000, this.redactor), updated_at: this.now() }).where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
      .where("lease_owner", "=", job.workerId).where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  public async failRuntimeJob(job: RuntimeWorkerJobRef, summary: string): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!await ownsLease(trx, job)) return false;
      const row = await trx.selectFrom("runtime_containers").select(["observed_state", "resource_version"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      const now = this.now(); const context = { tenantId: job.tenantId, trx }; let version = safeContractInteger(row.resource_version);
      if (row.observed_state !== "failed" && row.observed_state !== "deleted") version = await transition(trx, context, job, row.observed_state as RuntimeContainer["observed_state"], "failed", "unhealthy", now);
      const redacted = redactSummary(summary, 1000, this.redactor);
      await trx.updateTable("runtime_containers").set({ failure_summary: redacted }).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).execute();
      await appendWorkerAudit(context, job, "runtime.reconcile", "failed", redacted, version, now);
      const result = await trx.updateTable("worker_jobs").set({ status: "failed", lease_owner: null, lease_expires_at: null, last_error_summary: redacted, updated_at: now })
        .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId).where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst();
      return Number(result.numUpdatedRows) === 1;
    });
  }

  public async loadReconcileFacts(tenantId: string, runtimeId: string): Promise<StoredReconcileFacts> {
    const row = await this.db.selectFrom("runtime_containers").select(["tenant_id", "container_id", "generation", "image_ref", "command_version", "observed_state", "desired_state"])
      .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId).executeTakeFirstOrThrow();
    return { tenantId, runtimeId, generation: row.generation, imageRef: row.image_ref, commandVersion: safeContractInteger(row.command_version), observedState: row.observed_state as RuntimeContainer["observed_state"], desiredState: row.desired_state as RuntimeContainer["desired_state"] };
  }

  public async completeSuperseded(job: RuntimeWorkerJobRef): Promise<boolean> {
    const result = await this.db.updateTable("worker_jobs").set({ status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() })
      .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId).where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  public async isCurrentCommand(job: RuntimeWorkerJobRef, targetCommandVersion: number): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!await ownsLease(trx, job)) return false;
      const row = await trx.selectFrom("runtime_containers").select("command_version").where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).executeTakeFirst();
      return row !== undefined && safeContractInteger(row.command_version) === targetCommandVersion;
    });
  }

  public async finishReconcile(job: RuntimeWorkerJobRef, command: "start" | "stop" | "restart" | "delete", targetCommandVersion: number, observation: RuntimeObservation): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!await ownsLease(trx, job)) return false;
      const row = await trx.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state"]).where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).forUpdate().executeTakeFirstOrThrow();
      if (safeContractInteger(row.command_version) !== targetCommandVersion) {
        const result = await trx.updateTable("worker_jobs").set({ status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command", updated_at: this.now() }).where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId).executeTakeFirst();
        return Number(result.numUpdatedRows) === 1;
      }
      const now = this.now(); const context = { tenantId: job.tenantId, trx }; let state = row.observed_state as RuntimeContainer["observed_state"];
      const alreadySatisfied = (command === "start" && state === "ready") || (command === "stop" && state === "stopped") || (command === "delete" && state === "deleted");
      const path: RuntimeContainer["observed_state"][] = command === "delete" ? ["deleting", "deleted"]
        : command === "stop" ? ["stopping", "stopped"]
          : state === "failed" || state === "ready" ? ["recovering", "starting", "ready"] : ["starting", "ready"];
      for (const next of alreadySatisfied ? [] : path) {
        if (state === next || (next === "starting" && state === "starting") || (next === "ready" && state === "ready")) continue;
        if (command === "start" && state === "ready") break;
        await transition(trx, context, job, state, next, next === "ready" ? "healthy" : next === "stopped" || next === "deleted" ? "unknown" : "unknown", now);
        state = next;
      }
      const final = await trx.selectFrom("runtime_containers").select("resource_version").where("tenant_id", "=", job.tenantId).where("container_id", "=", job.runtimeId).executeTakeFirstOrThrow();
      await appendWorkerAudit(context, job, `runtime.${command}`, "succeeded", "Runtime command reconciled with Supervisor observation", safeContractInteger(final.resource_version), now);
      const result = await trx.updateTable("worker_jobs").set({ status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: null, updated_at: now }).where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId).where("lease_owner", "=", job.workerId).where("lease_expires_at", ">", sql<Date>`now()`).executeTakeFirst();
      void observation;
      return Number(result.numUpdatedRows) === 1;
    });
  }
}
