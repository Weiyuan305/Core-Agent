import { createHash } from "node:crypto";

import {
  AgentRunSchema,
  CaseRefSchema,
  CreateAgentRunRequestSchema,
  StudentRefSchema,
  validateRetryRun,
  type AgentRun,
  type CaseRef,
  type CreateAgentRunRequest,
  type StudentRef,
} from "@core-agent/contracts";
import { type Kysely, type Transaction } from "kysely";
import Schema from "typebox/schema";

import type { ProviderCatalog } from "../config/provider-catalog.js";
import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId, type TenantTransaction } from "../db/transaction.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../domain/idempotency.js";
import { appendAuditEvent, appendProductEvents } from "../repositories/events.js";
import { ResourceRepositories } from "../repositories/index.js";
import { deriveRuntimeContainerId, type ProvisioningContext } from "./provision-tenant.js";

export interface CreateAgentRunDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly providerCatalog: ProviderCatalog;
  readonly now?: () => Date;
}

export type CreateAgentRunContext = ProvisioningContext;

const requestValidator = Schema.Compile(CreateAgentRunRequestSchema);
const responseValidator = Schema.Compile(AgentRunSchema);
const operation = "agent_run.create";
const dayMs = 24 * 60 * 60 * 1_000;

function invalid(message: string): never {
  throw new DomainError("INVALID_REQUEST", message);
}

function notFound(): never {
  throw new DomainError("RESOURCE_NOT_FOUND", "Admission resource was not found");
}

function runtimeNotReady(): never {
  throw new DomainError("RUNTIME_NOT_READY", "Managed runtime is not ready");
}

function identityConflict(): never {
  throw new DomainError("IDEMPOTENCY_CONFLICT", "Client request identity conflicts with an earlier Run");
}

const clientIdentityConstraints = new Set([
  "agent_runs_tenant_id_client_request_id_key",
  "messages_pkey",
]);

function ownStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function isClientIdentityUniqueConflict(error: unknown): boolean {
  return ownStringField(error, "code") === "23505"
    && clientIdentityConstraints.has(ownStringField(error, "constraint") ?? "");
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 32);
}

function deriveRunId(tenantId: string, conversationId: string, request: CreateAgentRunRequest): string {
  return `run_${digest([
    tenantId,
    conversationId,
    operation,
    request.idempotency_key,
    request.client_request_id,
    request.input_message.client_message_id,
  ])}`;
}

function deriveMessageId(tenantId: string, conversationId: string, clientMessageId: string): string {
  return `message_${digest([tenantId, conversationId, "client_message", clientMessageId])}`;
}

function deriveRunScopedId(prefix: string, tenantId: string, runId: string): string {
  return `${prefix}_${digest([tenantId, runId, prefix])}`;
}

function payloadWithoutHash(request: CreateAgentRunRequest): Omit<CreateAgentRunRequest, "payload_hash"> {
  const { payload_hash: _payloadHash, ...payload } = request;
  return payload;
}

function retryableSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && ["40001", "40P01"].includes(String((error as { code?: unknown }).code));
}

async function serializable<T>(
  db: Kysely<RuntimeDatabase>,
  work: (trx: Transaction<RuntimeDatabase>) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.transaction().setIsolationLevel("serializable").execute(work);
    } catch (error) {
      if (!retryableSerializationFailure(error) || attempt === 2) throw error;
    }
  }
  throw new DomainError("INTERNAL_ERROR", "Serializable transaction retry exhausted");
}

function assertReplay(
  value: unknown,
  expected: {
    tenantId: string;
    conversationId: string;
    runId: string;
    clientRequestId: string;
    idempotencyKey: string;
    parentRunId?: string;
  },
): asserts value is AgentRun {
  if (!responseValidator.Check(value)) {
    throw new DomainError("INTERNAL_ERROR", "Stored AgentRun response is invalid");
  }
  const response = value as AgentRun;
  if (
    response.tenant_id !== expected.tenantId
    || response.conversation_id !== expected.conversationId
    || response.run_id !== expected.runId
    || response.client_request_id !== expected.clientRequestId
    || response.idempotency_key !== expected.idempotencyKey
    || response.parent_run_id !== expected.parentRunId
  ) throw new DomainError("INTERNAL_ERROR", "Stored AgentRun response identity is invalid");
}

export async function createAgentRun(
  dependencies: CreateAgentRunDependencies,
  context: CreateAgentRunContext,
  conversationId: string,
  input: unknown,
): Promise<AgentRun> {
  if (!requestValidator.Check(input)) invalid("AgentRun request does not satisfy its contract");
  const request = input as CreateAgentRunRequest;
  try {
    assertTenantId(context.tenantId);
  } catch {
    notFound();
  }
  if (typeof conversationId !== "string" || conversationId.length < 1 || conversationId.length > 255) notFound();
  if (request.payload_hash !== canonicalPayloadHash(payloadWithoutHash(request))) invalid("Payload hash does not match the canonical request");
  const tenantId = context.tenantId;
  const runId = deriveRunId(tenantId, conversationId, request);
  const messageId = deriveMessageId(tenantId, conversationId, request.input_message.client_message_id);

  try {
    return await serializable(dependencies.db, async (trx) => {
      const now = dependencies.now?.() ?? new Date();
      const nowIso = now.toISOString();
      const tenant = await trx.selectFrom("tenants").select("status")
        .where("tenant_id", "=", tenantId).forShare().executeTakeFirst();
      const conversation = await trx.selectFrom("conversations")
        .select(["conversation_id", "profile_id", "created_by_actor_id", "status", "student_ref", "case_ref"])
        .where("tenant_id", "=", tenantId).where("conversation_id", "=", conversationId)
        .forUpdate().executeTakeFirst();
      const actor = await trx.selectFrom("actors").select(["actor_kind", "status"])
        .where("tenant_id", "=", tenantId).where("actor_id", "=", context.actorId).forShare().executeTakeFirst();
      const membership = await trx.selectFrom("memberships").select(["actor_id", "roles", "status"])
        .where("tenant_id", "=", tenantId).where("membership_id", "=", context.membershipId).forShare().executeTakeFirst();
      if (
        tenant?.status !== "active"
        || conversation === undefined
        || actor?.actor_kind !== "service"
        || actor.status !== "active"
        || conversation.created_by_actor_id !== context.actorId
        || membership?.actor_id !== context.actorId
        || membership.status !== "active"
        || !membership.roles.includes(context.effectiveRole)
      ) notFound();
      const tenantTransaction: TenantTransaction = { tenantId, trx };
      const admission = await beginIdempotentCommand<AgentRun>(tenantTransaction, {
        key: request.idempotency_key,
        payloadHash: request.payload_hash,
        operation,
        now,
        expiresAt: new Date(now.getTime() + dayMs),
      });
      if (admission.kind === "replay") {
        if (admission.resultRef !== runId) {
          throw new DomainError("INTERNAL_ERROR", "AgentRun replay result reference is invalid");
        }
        assertReplay(admission.response, {
          tenantId,
          conversationId,
          runId,
          clientRequestId: request.client_request_id,
          idempotencyKey: request.idempotency_key,
          ...(request.parent_run_id === undefined ? {} : { parentRunId: request.parent_run_id }),
        });
        return admission.response;
      }
      if (admission.kind === "in_progress") {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "AgentRun command is already in progress");
      }
      if (conversation.status !== "active") notFound();
      const profile = await trx.selectFrom("profiles")
        .select(["status", "provider_config_id", "model_id"])
        .where("tenant_id", "=", tenantId).where("profile_id", "=", conversation.profile_id)
        .forShare().executeTakeFirst();
      if (profile?.status !== "active") notFound();
      const activeSessions = await trx.selectFrom("sessions")
        .select(["profile_id", "actor_id", "expires_at", "hermes_session_ref"])
        .where("tenant_id", "=", tenantId)
        .where("conversation_id", "=", conversationId)
        .where("status", "=", "active")
        .forShare().execute();
      if (
        activeSessions.length !== 1
        || activeSessions[0]!.profile_id !== conversation.profile_id
        || activeSessions[0]!.actor_id !== conversation.created_by_actor_id
        || activeSessions[0]!.actor_id !== context.actorId
        || activeSessions[0]!.expires_at.getTime() <= now.getTime()
        || activeSessions[0]!.hermes_session_ref === null
      ) notFound();
      const runtime = await trx.selectFrom("runtime_containers")
        .select(["desired_state", "observed_state", "health_status"])
        .where("tenant_id", "=", tenantId)
        .where("container_id", "=", deriveRuntimeContainerId(tenantId))
        .forShare().executeTakeFirst();
      if (runtime === undefined) notFound();
      if (runtime.desired_state !== "running" || runtime.observed_state !== "ready" || runtime.health_status !== "healthy") {
        runtimeNotReady();
      }
      if (request.parent_run_id !== undefined) {
        const parent = await trx.selectFrom("agent_runs").select(["run_id", "conversation_id", "status"])
          .where("tenant_id", "=", tenantId).where("run_id", "=", request.parent_run_id)
          .forShare().executeTakeFirst();
        if (
          parent === undefined
          || parent.conversation_id !== conversationId
          || validateRetryRun(parent, { run_id: runId, parent_run_id: request.parent_run_id, status: "queued" }).length > 0
        ) notFound();
      }

      let provider;
      try {
        provider = dependencies.providerCatalog.require(profile.provider_config_id, profile.model_id);
      } catch {
        throw new DomainError("INTERNAL_ERROR", "Managed Profile provider configuration is invalid");
      }

      const priorClientRequest = await trx.selectFrom("agent_runs").select("run_id")
        .where("tenant_id", "=", tenantId).where("client_request_id", "=", request.client_request_id)
        .executeTakeFirst();
      const priorClientMessage = await trx.selectFrom("messages").select("message_id")
        .where("tenant_id", "=", tenantId).where("message_id", "=", messageId)
        .executeTakeFirst();
      if (priorClientRequest !== undefined || priorClientMessage !== undefined) identityConflict();

      const run: AgentRun = {
        schema_version: 1,
        resource_version: 1,
        run_id: runId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        request_id: context.requestId,
        trace_id: context.traceId,
        client_request_id: request.client_request_id,
        idempotency_key: request.idempotency_key,
        ...(request.parent_run_id === undefined ? {} : { parent_run_id: request.parent_run_id }),
        status: "queued",
        created_at: nowIso,
        updated_at: nowIso,
      };
      const repositories = new ResourceRepositories(dependencies.db).forTransaction(tenantTransaction);
      // PostgreSQL foreign keys require the Run before its user Message. Event order below remains logical.
      await repositories.runs.insert(run);
      await repositories.messages.insert({
        schema_version: 1,
        resource_version: 1,
        message_id: messageId,
        tenant_id: tenantId,
        conversation_id: conversationId,
        run_id: runId,
        role: "user",
        status: "completed",
        content: request.input_message.content,
        created_at: nowIso,
        updated_at: nowIso,
      });
      const jobId = deriveRunScopedId("job_execute_agent_run", tenantId, runId);
      await trx.insertInto("worker_jobs").values({
        tenant_id: tenantId,
        job_id: jobId,
        job_kind: "execute_agent_run",
        status: "queued",
        attempt_count: 0,
        max_attempts: provider.max_safe_retries + 1,
        lease_owner: null,
        lease_expires_at: null,
        next_attempt_at: now,
        payload_ref: runId,
        effect_state: "pre_effect",
        runtime_command: null,
        target_command_version: null,
        last_error_summary: null,
        run_id: runId,
        container_id: null,
        created_at: now,
        updated_at: now,
      }).execute();
      let studentRef: StudentRef | undefined;
      let caseRef: CaseRef | undefined;
      if (conversation.student_ref !== null) {
        if (!Schema.Check(StudentRefSchema, conversation.student_ref)) {
          throw new DomainError("INTERNAL_ERROR", "Stored Conversation student scope is invalid");
        }
        studentRef = conversation.student_ref as StudentRef;
      }
      if (conversation.case_ref !== null) {
        if (!Schema.Check(CaseRefSchema, conversation.case_ref)) {
          throw new DomainError("INTERNAL_ERROR", "Stored Conversation case scope is invalid");
        }
        caseRef = conversation.case_ref as CaseRef;
      }
      const eventBase = {
        schema_version: 1 as const,
        occurred_at: nowIso,
        tenant_id: tenantId,
        request_id: context.requestId,
        trace_id: context.traceId,
        correlation_id: request.idempotency_key,
        causation_id: jobId,
        profile_id: conversation.profile_id,
        conversation_id: conversationId,
        run_id: runId,
        ...(studentRef === undefined ? {} : { student_ref: studentRef }),
        ...(caseRef === undefined ? {} : { case_ref: caseRef }),
      };
      await appendProductEvents(tenantTransaction, {
        streamId: `conversation_${conversationId}`,
        deliveryTarget: "internal_event_stream",
        events: [{
          ...eventBase,
          event_id: deriveRunScopedId("event_message_created", tenantId, runId),
          event_type: "message.created",
          payload: { message_id: messageId, role: "user", status: "completed" },
        }, {
          ...eventBase,
          event_id: deriveRunScopedId("event_run_queued", tenantId, runId),
          event_type: "run.queued",
          payload: { run_id: runId, status: "queued" },
        }],
      });
      await appendAuditEvent(tenantTransaction, {
        schema_version: 1,
        audit_event_id: deriveRunScopedId("audit_run_queued", tenantId, runId),
        occurred_at: nowIso,
        tenant_id: tenantId,
        actor_id: context.actorId,
        membership_id: context.membershipId,
        effective_role: context.effectiveRole,
        action: "agent_run.create",
        resource_type: "agent_run",
        resource_id: runId,
        decision: "allowed",
        outcome: "pending",
        request_id: context.requestId,
        trace_id: context.traceId,
        reason_summary: "Queued a managed Agent Run",
        run_id: runId,
        resource_version: 1,
      });
      await completeIdempotentCommand(tenantTransaction, {
        key: request.idempotency_key,
        payloadHash: request.payload_hash,
        operation,
        resultRef: runId,
        response: run,
        updatedAt: now,
      });
      return run;
    });
  } catch (error) {
    if (isClientIdentityUniqueConflict(error)) identityConflict();
    throw error;
  }
}

export async function getAgentRun(
  db: Kysely<RuntimeDatabase>,
  authorityTenantId: string,
  runId: string,
): Promise<AgentRun> {
  try {
    assertTenantId(authorityTenantId);
  } catch {
    notFound();
  }
  const run = await new ResourceRepositories(db).forTenant(authorityTenantId).runs.find(runId);
  if (run === undefined) notFound();
  return run;
}
