import { createHash } from "node:crypto";

import type { AgentRun, Message } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { ProviderCatalog } from "../config/provider-catalog.js";
import type { RuntimeDatabase } from "../db/database.js";
import type { TenantTransaction } from "../db/transaction.js";
import { redactSummary, type Redactor } from "../domain/redaction.js";
import { assertAgentRunTransition } from "../domain/transitions.js";
import type { SecretReference } from "../secrets/secret-store.js";
import { deriveRuntimeContainerId } from "../services/provision-tenant.js";
import { appendAuditEvent, appendProductEvents } from "./events.js";
import type { JobLeaseResult } from "./jobs.js";
import { ResourceRepositories } from "./index.js";
import { safeContractInteger } from "./resources.js";

const workerActorId = "core_agent_provisioner";
const workerMembershipId = "core_agent_provisioner_admin";

export interface AgentRunWorkerJobRef {
  readonly tenantId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly runId: string;
}

export interface StoredAgentRunExecutionFacts {
  readonly tenantId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly profileRef: string;
  readonly sessionRef: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly content: string;
  readonly ingressSecretRef: SecretReference;
  readonly runtime: {
    readonly runtimeId: string;
    readonly generation: number;
    readonly imageRef: string;
  };
}

export type AgentRunBeginResult =
  | { readonly kind: "admitted"; readonly facts: StoredAgentRunExecutionFacts }
  | { readonly kind: "lease_lost" };

class AgentRunLeaseLost extends Error {}

function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 32);
}

function assistantMessageId(tenantId: string, runId: string): string {
  return `message_assistant_${digest(tenantId, runId, "assistant")}`;
}

function eventId(prefix: string, jobId: string, ordinal = "terminal"): string {
  return `${prefix}_${digest(jobId, prefix, ordinal)}`;
}

async function lockedOwnedJob(trx: Transaction<RuntimeDatabase>, job: AgentRunWorkerJobRef) {
  const row = await trx.selectFrom("worker_jobs")
    .select(["job_id", "job_kind", "status", "attempt_count", "max_attempts", "payload_ref", "run_id", "effect_state"])
    .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
    .where("lease_owner", "=", job.workerId).where("status", "=", "running")
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
    .forUpdate().executeTakeFirst();
  if (
    row === undefined || row.job_kind !== "execute_agent_run" || row.payload_ref !== job.runId
    || row.run_id !== job.runId || !["pre_effect", "unsafe_to_replay"].includes(row.effect_state)
  ) throw new AgentRunLeaseLost();
  return row;
}

async function requireStillOwned(trx: Transaction<RuntimeDatabase>, job: AgentRunWorkerJobRef): Promise<void> {
  const owned = await trx.selectFrom("worker_jobs").select("job_id")
    .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
    .where("lease_owner", "=", job.workerId).where("status", "=", "running")
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
  if (owned === undefined) throw new AgentRunLeaseLost();
}

async function updateOwnedJob(
  trx: Transaction<RuntimeDatabase>,
  job: AgentRunWorkerJobRef,
  update: Record<string, unknown>,
): Promise<void> {
  const result = await trx.updateTable("worker_jobs").set(update)
    .where("tenant_id", "=", job.tenantId).where("job_id", "=", job.jobId)
    .where("lease_owner", "=", job.workerId).where("status", "=", "running")
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
  if (Number(result.numUpdatedRows) !== 1) throw new AgentRunLeaseLost();
}

async function fenced<Result>(
  db: Kysely<RuntimeDatabase>,
  work: (trx: Transaction<RuntimeDatabase>) => Promise<Result>,
): Promise<Result | { readonly kind: "lease_lost" }> {
  try { return await db.transaction().execute(work); }
  catch (error) {
    if (error instanceof AgentRunLeaseLost) return { kind: "lease_lost" };
    throw error;
  }
}

function baseEvent(run: {
  tenant_id: string; run_id: string; conversation_id: string; request_id: string; trace_id: string;
}, profileId: string, jobId: string, now: Date) {
  return {
    schema_version: 1 as const,
    occurred_at: now.toISOString(),
    tenant_id: run.tenant_id,
    request_id: run.request_id,
    trace_id: run.trace_id,
    correlation_id: run.run_id,
    causation_id: jobId,
    profile_id: profileId,
    conversation_id: run.conversation_id,
    run_id: run.run_id,
  };
}

async function appendRunAudit(
  context: TenantTransaction,
  job: AgentRunWorkerJobRef,
  run: { request_id: string; trace_id: string; resource_version: string },
  outcome: "succeeded" | "failed",
  summary: string,
  now: Date,
): Promise<void> {
  await appendAuditEvent(context, {
    schema_version: 1,
    audit_event_id: eventId(`audit_run_${outcome}`, job.jobId),
    occurred_at: now.toISOString(),
    tenant_id: job.tenantId,
    actor_id: workerActorId,
    membership_id: workerMembershipId,
    effective_role: "admin",
    action: "agent_run.execute",
    resource_type: "agent_run",
    resource_id: job.runId,
    decision: "allowed",
    outcome,
    request_id: run.request_id,
    trace_id: run.trace_id,
    reason_summary: summary,
    run_id: job.runId,
    resource_version: safeContractInteger(run.resource_version),
  });
}

export class WorkerAgentRunRepository {
  public constructor(
    private readonly db: Kysely<RuntimeDatabase>,
    private readonly providerCatalog: ProviderCatalog,
    private readonly redactor: Redactor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async begin(job: AgentRunWorkerJobRef): Promise<AgentRunBeginResult> {
    return fenced(this.db, async (trx) => {
      const claimed = await lockedOwnedJob(trx, job);
      if (claimed.effect_state !== "pre_effect") throw new Error("Unsafe Agent execution cannot begin");
      const run = await trx.selectFrom("agent_runs").selectAll()
        .where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).forUpdate().executeTakeFirst();
      if (run === undefined) throw new Error("Stored Agent Run execution identity is unavailable");
      const conversation = await trx.selectFrom("conversations").selectAll()
        .where("tenant_id", "=", job.tenantId).where("conversation_id", "=", run.conversation_id).forUpdate().executeTakeFirst();
      if (conversation === undefined || conversation.status !== "active") throw new Error("Stored Agent Run Conversation is unavailable");
      const tenant = await trx.selectFrom("tenants").select("status").where("tenant_id", "=", job.tenantId).forShare().executeTakeFirst();
      const actor = await trx.selectFrom("actors").select(["actor_kind", "status"]).where("tenant_id", "=", job.tenantId)
        .where("actor_id", "=", conversation.created_by_actor_id).forShare().executeTakeFirst();
      const membership = await trx.selectFrom("memberships").select(["actor_id", "roles", "status"]).where("tenant_id", "=", job.tenantId)
        .where("membership_id", "=", workerMembershipId).forShare().executeTakeFirst();
      if (
        tenant?.status !== "active" || conversation.created_by_actor_id !== workerActorId
        || actor?.actor_kind !== "service" || actor.status !== "active"
        || membership?.actor_id !== workerActorId || membership.status !== "active" || !membership.roles.includes("admin")
      ) throw new Error("Stored Agent Run execution authority is inconsistent");
      await requireStillOwned(trx, job);
      const now = this.now();
      if (run.status === "queued") {
        assertAgentRunTransition("queued", "running");
        await trx.updateTable("agent_runs").set({
          status: "running", started_at: now, resource_version: sql`resource_version + 1`, updated_at: now,
        }).where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).where("status", "=", "queued").executeTakeFirstOrThrow();
        const context = { tenantId: job.tenantId, trx };
        await appendProductEvents(context, {
          streamId: `conversation_${run.conversation_id}`,
          deliveryTarget: "internal_event_stream",
          events: [{
            ...baseEvent(run, conversation.profile_id, job.jobId, now),
            event_id: eventId("event_run_started", job.jobId),
            event_type: "run.started",
            payload: { run_id: job.runId, status: "running" },
          }],
        });
        run.status = "running";
        run.started_at = now;
        run.resource_version = String(safeContractInteger(run.resource_version) + 1);
      } else if (run.status !== "running" || run.started_at === null) {
        throw new Error("Stored Agent Run is not executable");
      }

      const profile = await trx.selectFrom("profiles").select(["profile_id", "hermes_profile_ref", "provider_config_id", "model_id", "status"])
        .where("tenant_id", "=", job.tenantId).where("profile_id", "=", conversation.profile_id).forShare().executeTakeFirst();
      const sessions = await trx.selectFrom("sessions").selectAll()
        .where("tenant_id", "=", job.tenantId).where("conversation_id", "=", run.conversation_id).where("status", "=", "active")
        .where("expires_at", ">", sql<Date>`clock_timestamp()`).forShare().execute();
      const messages = await trx.selectFrom("messages").selectAll()
        .where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).where("role", "=", "user").where("status", "=", "completed")
        .forShare().execute();
      const runtimeId = deriveRuntimeContainerId(job.tenantId);
      const runtime = await trx.selectFrom("runtime_containers").select(["container_id", "generation", "image_ref", "desired_state", "observed_state", "health_status"])
        .where("tenant_id", "=", job.tenantId).where("container_id", "=", runtimeId).forShare().executeTakeFirst();
      const ingress = await trx.selectFrom("secret_references").select(["reference_id", "version"])
        .where("tenant_id", "=", job.tenantId).where("purpose", "=", "integration").where("status", "=", "active").forShare().execute();
      if (
        profile?.status !== "active" || profile.profile_id !== conversation.profile_id || sessions.length !== 1
        || sessions[0]!.profile_id !== profile.profile_id || sessions[0]!.actor_id !== conversation.created_by_actor_id
        || sessions[0]!.hermes_session_ref === null || messages.length !== 1 || runtime === undefined
        || runtime.desired_state !== "running" || runtime.observed_state !== "ready" || runtime.health_status !== "healthy"
        || ingress.length !== 1
      ) throw new Error("Stored Agent Run execution facts are inconsistent");
      let provider;
      try { provider = this.providerCatalog.require(profile.provider_config_id, profile.model_id); }
      catch { throw new Error("Stored Agent Run provider configuration is inconsistent"); }
      const credential = await trx.selectFrom("secret_references").select("reference_id")
        .where("tenant_id", "=", job.tenantId).where("reference_id", "=", provider.credential_secret_ref)
        .where("purpose", "=", "provider_credential").where("status", "=", "active").forShare().executeTakeFirst();
      if (credential === undefined) throw new Error("Stored Agent Run provider credential metadata is inconsistent");
      await requireStillOwned(trx, job);
      return {
        kind: "admitted" as const,
        facts: {
          tenantId: job.tenantId,
          jobId: job.jobId,
          runId: job.runId,
          conversationId: run.conversation_id,
          assistantMessageId: assistantMessageId(job.tenantId, job.runId),
          profileRef: profile.hermes_profile_ref,
          sessionRef: sessions[0]!.hermes_session_ref,
          modelId: profile.model_id,
          timeoutMs: provider.timeout_ms,
          content: messages[0]!.content,
          ingressSecretRef: { reference_id: ingress[0]!.reference_id, version: safeContractInteger(ingress[0]!.version), purpose: "hermes_ingress" as const },
          runtime: { runtimeId, generation: runtime.generation, imageRef: runtime.image_ref },
        },
      };
    }) as Promise<AgentRunBeginResult>;
  }

  public async persistDelta(job: AgentRunWorkerJobRef, messageId: string, delta: string): Promise<JobLeaseResult> {
    if (delta.length < 1 || delta.length > 4_000) throw new Error("Agent Run delta is invalid");
    return fenced(this.db, async (trx) => {
      const claimed = await lockedOwnedJob(trx, job);
      const run = await trx.selectFrom("agent_runs").select(["tenant_id", "run_id", "conversation_id", "request_id", "trace_id", "status"])
        .where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).forUpdate().executeTakeFirst();
      if (run === undefined || run.status !== "running" || messageId !== assistantMessageId(job.tenantId, job.runId)) throw new Error("Stored Agent Run delta identity is inconsistent");
      const conversation = await trx.selectFrom("conversations").select(["profile_id"]).where("tenant_id", "=", job.tenantId)
        .where("conversation_id", "=", run.conversation_id).forUpdate().executeTakeFirst();
      if (conversation === undefined) throw new Error("Stored Agent Run Conversation is unavailable");
      await requireStillOwned(trx, job);
      const prior = await trx.selectFrom("product_events").select("payload").where("tenant_id", "=", job.tenantId)
        .where("stream_id", "=", `conversation_${run.conversation_id}`).where("run_id", "=", job.runId)
        .where("event_type", "=", "message.delta").orderBy("sequence").execute();
      let total = delta.length;
      for (const row of prior) {
        const value = typeof row.payload === "object" && row.payload !== null ? (row.payload as { delta?: unknown }).delta : undefined;
        if (typeof value !== "string") throw new Error("Stored Agent Run delta is invalid");
        total += value.length;
      }
      if (total > 4_000) throw new Error("Agent Run assistant content exceeds its bound");
      if (claimed.effect_state === "pre_effect") {
        await updateOwnedJob(trx, job, { effect_state: "unsafe_to_replay", updated_at: this.now() });
      }
      const now = this.now();
      await appendProductEvents({ tenantId: job.tenantId, trx }, {
        streamId: `conversation_${run.conversation_id}`,
        deliveryTarget: "internal_event_stream",
        events: [{
          ...baseEvent(run, conversation.profile_id, job.jobId, now),
          event_id: eventId("event_message_delta", job.jobId, String(prior.length + 1)),
          event_type: "message.delta",
          payload: { message_id: messageId, delta },
        }],
      });
      await requireStillOwned(trx, job);
      return { kind: "updated" as const };
    }) as Promise<JobLeaseResult>;
  }

  public async complete(job: AgentRunWorkerJobRef, facts: StoredAgentRunExecutionFacts, content: string): Promise<JobLeaseResult> {
    if (
      content.length < 1 || content.length > 4_000 || facts.tenantId !== job.tenantId || facts.runId !== job.runId
      || facts.jobId !== job.jobId || facts.assistantMessageId !== assistantMessageId(job.tenantId, job.runId)
    ) {
      throw new Error("Agent Run completion is invalid");
    }
    return fenced(this.db, async (trx) => {
      const claimed = await lockedOwnedJob(trx, job);
      if (claimed.effect_state !== "unsafe_to_replay") throw new Error("Agent Run completion lacks durable output");
      const run = await trx.selectFrom("agent_runs").selectAll().where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).forUpdate().executeTakeFirst();
      if (run === undefined || run.status !== "running" || run.conversation_id !== facts.conversationId) throw new Error("Stored Agent Run completion identity is inconsistent");
      const conversation = await trx.selectFrom("conversations").select("profile_id").where("tenant_id", "=", job.tenantId).where("conversation_id", "=", run.conversation_id).forUpdate().executeTakeFirst();
      const sessions = await trx.selectFrom("sessions").selectAll().where("tenant_id", "=", job.tenantId).where("conversation_id", "=", run.conversation_id).where("status", "=", "active").forUpdate().execute();
      if (conversation === undefined || sessions.length !== 1 || sessions[0]!.hermes_session_ref !== facts.sessionRef) throw new Error("Stored Agent Run completion Session is inconsistent");
      await requireStillOwned(trx, job);
      const deltas = await trx.selectFrom("product_events").select("payload").where("tenant_id", "=", job.tenantId)
        .where("stream_id", "=", `conversation_${run.conversation_id}`).where("run_id", "=", job.runId)
        .where("event_type", "=", "message.delta").orderBy("sequence").execute();
      const durableContent = deltas.map((row) => typeof row.payload === "object" && row.payload !== null ? (row.payload as { delta?: unknown }).delta : undefined);
      if (!durableContent.every((value): value is string => typeof value === "string") || durableContent.join("") !== content) throw new Error("Agent Run completion does not match durable deltas");
      const now = this.now();
      const message: Message = {
        schema_version: 1, resource_version: 1, message_id: facts.assistantMessageId, tenant_id: job.tenantId,
        conversation_id: run.conversation_id, run_id: job.runId, role: "assistant", status: "completed", content,
        created_at: now.toISOString(), updated_at: now.toISOString(),
      };
      await new ResourceRepositories(this.db).forTransaction({ tenantId: job.tenantId, trx }).messages.insert(message);
      const context = { tenantId: job.tenantId, trx };
      await appendProductEvents(context, { streamId: `conversation_${run.conversation_id}`, deliveryTarget: "internal_event_stream", events: [{
        ...baseEvent(run, conversation.profile_id, job.jobId, now), event_id: eventId("event_message_completed", job.jobId),
        event_type: "message.completed", payload: { message_id: facts.assistantMessageId, content },
      }] });
      assertAgentRunTransition("running", "succeeded");
      const updated = await trx.updateTable("agent_runs").set({ status: "succeeded", finished_at: now, failure_summary: null, resource_version: sql`resource_version + 1`, updated_at: now })
        .where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).where("status", "=", "running").returning(["request_id", "trace_id", "resource_version"]).executeTakeFirstOrThrow();
      await appendProductEvents(context, { streamId: `conversation_${run.conversation_id}`, deliveryTarget: "internal_event_stream", events: [{
        ...baseEvent(run, conversation.profile_id, job.jobId, now), event_id: eventId("event_run_completed", job.jobId),
        event_type: "run.completed", payload: { run_id: job.runId, status: "succeeded" },
      }] });
      await trx.updateTable("sessions").set({ last_active_at: now, resource_version: sql`resource_version + 1`, updated_at: now })
        .where("tenant_id", "=", job.tenantId).where("session_id", "=", sessions[0]!.session_id).executeTakeFirstOrThrow();
      await appendRunAudit(context, job, updated, "succeeded", "Managed Agent Run completed", now);
      await updateOwnedJob(trx, job, { status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: null, updated_at: now });
      return { kind: "updated" as const };
    }) as Promise<JobLeaseResult>;
  }

  public async retry(job: AgentRunWorkerJobRef, summary: string, nextAttemptAt: Date): Promise<JobLeaseResult> {
    const redacted = redactSummary(summary, 1_000, this.redactor) || "Agent execution dependency unavailable";
    return fenced(this.db, async (trx) => {
      const claimed = await lockedOwnedJob(trx, job);
      if (claimed.effect_state !== "pre_effect" || claimed.attempt_count >= claimed.max_attempts) throw new Error("Agent Run is not safely retryable");
      await updateOwnedJob(trx, job, { status: "retrying", lease_owner: null, lease_expires_at: null, next_attempt_at: nextAttemptAt, last_error_summary: redacted, updated_at: this.now() });
      return { kind: "updated" as const };
    }) as Promise<JobLeaseResult>;
  }

  public async fail(job: AgentRunWorkerJobRef, summary: string): Promise<JobLeaseResult> {
    const redacted = redactSummary(summary, 1_000, this.redactor) || "Agent execution failed";
    return fenced(this.db, async (trx) => {
      await lockedOwnedJob(trx, job);
      const run = await trx.selectFrom("agent_runs").selectAll().where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).forUpdate().executeTakeFirst();
      if (run === undefined || !["queued", "running"].includes(run.status)) throw new Error("Stored Agent Run failure identity is inconsistent");
      const conversation = await trx.selectFrom("conversations").select("profile_id").where("tenant_id", "=", job.tenantId).where("conversation_id", "=", run.conversation_id).forUpdate().executeTakeFirst();
      if (conversation === undefined) throw new Error("Stored Agent Run Conversation is unavailable");
      await requireStillOwned(trx, job);
      assertAgentRunTransition(run.status as AgentRun["status"], "failed");
      const now = this.now();
      const updated = await trx.updateTable("agent_runs").set({ status: "failed", finished_at: now, failure_summary: redacted, resource_version: sql`resource_version + 1`, updated_at: now })
        .where("tenant_id", "=", job.tenantId).where("run_id", "=", job.runId).where("status", "=", run.status).returning(["request_id", "trace_id", "resource_version"]).executeTakeFirstOrThrow();
      const context = { tenantId: job.tenantId, trx };
      await appendProductEvents(context, { streamId: `conversation_${run.conversation_id}`, deliveryTarget: "internal_event_stream", events: [{
        ...baseEvent(run, conversation.profile_id, job.jobId, now), event_id: eventId("event_run_failed", job.jobId),
        event_type: "run.failed", payload: { run_id: job.runId, status: "failed", summary: redacted },
      }] });
      await appendRunAudit(context, job, updated, "failed", redacted, now);
      await updateOwnedJob(trx, job, { status: "failed", lease_owner: null, lease_expires_at: null, last_error_summary: redacted, updated_at: now });
      return { kind: "updated" as const };
    }) as Promise<JobLeaseResult>;
  }
}
