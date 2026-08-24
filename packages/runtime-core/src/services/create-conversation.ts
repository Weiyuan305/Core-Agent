import { createHash } from "node:crypto";

import {
  CaseRefSchema,
  ConversationSchema,
  OpaqueIdSchema,
  PayloadHashSchema,
  StudentRefSchema,
  validateCaseScope,
  type CaseRef,
  type Conversation,
  type StudentRef,
} from "@core-agent/contracts";
import { type Kysely, type Transaction } from "kysely";
import Type from "typebox";
import Schema from "typebox/schema";

import type { RuntimeDatabase } from "../db/database.js";
import { withDatabaseTransactionRetry } from "../db/transaction-retry.js";
import { assertTenantId, type TenantTransaction } from "../db/transaction.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../domain/idempotency.js";
import { appendAuditEvent, appendProductEvents } from "../repositories/events.js";
import { ResourceRepositories } from "../repositories/index.js";
import { deriveRuntimeContainerId } from "./provision-tenant.js";
import { loadCurrentSnapshotAuthority } from "./entitlements/current-authority.js";

const CreateConversationServiceRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  idempotency_key: OpaqueIdSchema,
  payload_hash: PayloadHashSchema,
  tenant_id: OpaqueIdSchema,
  profile_id: OpaqueIdSchema,
  student_ref: Type.Optional(StudentRefSchema),
  case_ref: Type.Optional(CaseRefSchema),
}, { additionalProperties: false });

export interface CreateConversationRequest {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly profile_id: string;
  readonly student_ref?: StudentRef;
  readonly case_ref?: CaseRef;
}

export interface CreateConversationDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly now?: () => Date;
}

export interface CreateConversationContext {
  readonly tenantId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly effectiveRole: "admin" | "consultant" | "student";
}

const requestValidator = Schema.Compile(CreateConversationServiceRequestSchema);
const responseValidator = Schema.Compile(ConversationSchema);
const operation = "conversation.create";
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

function deriveId(prefix: string, tenantId: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${tenantId}:${operation}:${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

export function deriveConversationId(tenantId: string, idempotencyKey: string): string {
  return deriveId("conversation", tenantId, idempotencyKey);
}

function payloadWithoutHash(request: CreateConversationRequest): Omit<CreateConversationRequest, "payload_hash"> {
  const { payload_hash: _payloadHash, ...payload } = request;
  return payload;
}

async function serializable<T>(
  db: Kysely<RuntimeDatabase>,
  work: (trx: Transaction<RuntimeDatabase>) => Promise<T>,
): Promise<T> {
  return withDatabaseTransactionRetry(db, work, { isolationLevel: "serializable" });
}

function assertReplay(
  value: unknown,
  expected: { tenantId: string; conversationId: string; profileId: string; actorId: string },
): asserts value is Conversation {
  if (!responseValidator.Check(value)) {
    throw new DomainError("INTERNAL_ERROR", "Stored Conversation response is invalid");
  }
  const response = value as Conversation;
  if (
    response.tenant_id !== expected.tenantId
    || response.conversation_id !== expected.conversationId
    || response.profile_id !== expected.profileId
    || response.created_by_actor_id !== expected.actorId
  ) throw new DomainError("INTERNAL_ERROR", "Stored Conversation response identity is invalid");
}

export async function createConversation(
  dependencies: CreateConversationDependencies,
  context: CreateConversationContext,
  input: unknown,
): Promise<Conversation> {
  if (!requestValidator.Check(input)) invalid("Conversation request does not satisfy its contract");
  const request = input as CreateConversationRequest;
  try {
    assertTenantId(context.tenantId);
  } catch {
    invalid("Conversation tenant authority is invalid");
  }
  if (request.tenant_id !== context.tenantId) invalid("Conversation tenant scope does not match authority");
  if (validateCaseScope(request.student_ref, request.case_ref).length > 0) invalid("Conversation case scope is invalid");
  if (request.payload_hash !== canonicalPayloadHash(payloadWithoutHash(request))) invalid("Payload hash does not match the canonical request");

  const tenantId = context.tenantId;
  const conversationId = deriveConversationId(tenantId, request.idempotency_key);
  const sessionId = deriveId("session", tenantId, request.idempotency_key);
  const hermesSessionRef = deriveId("hermes_session", tenantId, request.idempotency_key);

  return serializable(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const tenant = await trx.selectFrom("tenants").select(["status"])
      .where("tenant_id", "=", tenantId).forShare().executeTakeFirst();
    const profile = await trx.selectFrom("profiles").select(["status"])
      .where("tenant_id", "=", tenantId).where("profile_id", "=", request.profile_id).forShare().executeTakeFirst();
    const runtime = await trx.selectFrom("runtime_containers")
      .select(["desired_state", "observed_state", "health_status"])
      .where("tenant_id", "=", tenantId)
      .where("container_id", "=", deriveRuntimeContainerId(tenantId))
      .forShare().executeTakeFirst();
    const actor = await trx.selectFrom("actors").select(["actor_kind", "status"])
      .where("actor_id", "=", context.actorId).forShare().executeTakeFirst();
    const membership = await trx.selectFrom("memberships").select(["actor_id", "roles", "status"])
      .where("tenant_id", "=", tenantId).where("membership_id", "=", context.membershipId).forShare().executeTakeFirst();
    const tenantTransaction: TenantTransaction = { tenantId, trx };
    if (
      tenant?.status !== "active"
      || profile === undefined
      || runtime === undefined
      || (actor?.actor_kind !== "service" && actor?.actor_kind !== "human")
      || actor.status !== "active"
      || membership?.actor_id !== context.actorId
      || membership.status !== "active"
      || !membership.roles.includes(context.effectiveRole)
    ) notFound();
    const admission = await beginIdempotentCommand<Conversation>(tenantTransaction, {
      key: request.idempotency_key,
      payloadHash: request.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      if (admission.resultRef !== conversationId) {
        throw new DomainError("INTERNAL_ERROR", "Conversation replay result reference is invalid");
      }
      assertReplay(admission.response, { tenantId, conversationId, profileId: request.profile_id, actorId: context.actorId });
      return admission.response;
    }
    if (admission.kind === "in_progress") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Conversation command is already in progress");
    }
    if (profile.status !== "active") notFound();
    if (runtime.desired_state !== "running" || runtime.observed_state !== "ready" || runtime.health_status !== "healthy") {
      runtimeNotReady();
    }
    const entitlementAuthority = await loadCurrentSnapshotAuthority({
      trx,
      tenantId,
      profileId: request.profile_id,
      now,
    });
    if (!entitlementAuthority.current) {
      if (entitlementAuthority.state === "preparing") {
        throw new DomainError("SERVICE_PREPARING", "Capability service is preparing", true);
      }
      throw new DomainError("ENTITLEMENT_DENIED", "Current entitlement authority is unavailable");
    }

    const conversation: Conversation = {
      schema_version: 1,
      resource_version: 1,
      conversation_id: conversationId,
      tenant_id: tenantId,
      profile_id: request.profile_id,
      created_by_actor_id: context.actorId,
      status: "active",
      ...(request.student_ref === undefined ? {} : { student_ref: request.student_ref }),
      ...(request.case_ref === undefined ? {} : { case_ref: request.case_ref }),
      created_at: nowIso,
      updated_at: nowIso,
    };
    const repositories = new ResourceRepositories(dependencies.db).forTransaction(tenantTransaction);
    await repositories.conversations.insert(conversation);
    await repositories.sessions.insert({
      schema_version: 1,
      resource_version: 1,
      session_id: sessionId,
      tenant_id: tenantId,
      profile_id: request.profile_id,
      actor_id: context.actorId,
      conversation_id: conversationId,
      status: "active",
      last_active_at: nowIso,
      expires_at: new Date(now.getTime() + 30 * dayMs).toISOString(),
      hermes_session_ref: hermesSessionRef,
      created_at: nowIso,
      updated_at: nowIso,
    });
    const eventId = deriveId("event_conversation_created", tenantId, request.idempotency_key);
    await appendProductEvents(tenantTransaction, {
      streamId: `conversation_${conversationId}`,
      deliveryTarget: "internal_event_stream",
      events: [{
        schema_version: 1,
        event_id: eventId,
        occurred_at: nowIso,
        tenant_id: tenantId,
        request_id: context.requestId,
        trace_id: context.traceId,
        correlation_id: request.idempotency_key,
        causation_id: sessionId,
        profile_id: request.profile_id,
        conversation_id: conversationId,
        ...(request.student_ref === undefined ? {} : { student_ref: request.student_ref }),
        ...(request.case_ref === undefined ? {} : { case_ref: request.case_ref }),
        event_type: "conversation.created",
        payload: { conversation_id: conversationId, status: "active" },
      }],
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1,
      audit_event_id: deriveId("audit_conversation_created", tenantId, request.idempotency_key),
      occurred_at: nowIso,
      tenant_id: tenantId,
      actor_id: context.actorId,
      membership_id: context.membershipId,
      effective_role: context.effectiveRole,
      action: "conversation.create",
      resource_type: "conversation",
      resource_id: conversationId,
      decision: "allowed",
      outcome: "succeeded",
      request_id: context.requestId,
      trace_id: context.traceId,
      reason_summary: "Created a managed Conversation and Hermes Session",
      resource_version: 1,
      entitlement_snapshot_ref: entitlementAuthority.snapshotRef,
    });
    await completeIdempotentCommand(tenantTransaction, {
      key: request.idempotency_key,
      payloadHash: request.payload_hash,
      operation,
      resultRef: conversationId,
      response: conversation,
      updatedAt: now,
    });
    return conversation;
  });
}
