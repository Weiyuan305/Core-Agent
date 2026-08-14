import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import type { TenantTransaction } from "../../db/transaction.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../../domain/idempotency.js";
import { validateProductEvent } from "../../domain/events.js";
import { loadActorIdentityAuthority } from "../../repositories/identity/identity-authority.js";
import {
  insertPrivateIdentityPii,
  type PrivateIdentityPiiProtection,
} from "../../repositories/identity/private-pii.js";
import { appendAuditEvent, enqueueOutbox } from "../../repositories/events.js";

export interface RegisterB2cCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly auth_subject: VerifiedAuthSubjectInput;
  readonly display_name: string;
}

export interface VerifiedAuthSubjectInput {
  readonly provider: "supabase";
  readonly providerSubject: string;
  readonly identityKind: "email_password" | "apple";
  readonly normalizedEmail: string;
  readonly verifiedAt: string;
}

export interface B2cRegistrationResult {
  readonly schema_version: 1;
  readonly actor_id: string;
  readonly tenant_id: string;
  readonly membership_id: string;
  readonly profile_id: string;
  readonly auth_subject_id: string;
}

export interface RegisterB2cContext {
  readonly requestId: string;
  readonly traceId: string;
}

export interface RegisterB2cDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly defaultProfile: {
    readonly providerConfigId: string;
    readonly modelId: string;
  };
  readonly privatePii: PrivateIdentityPiiProtection;
  readonly now?: () => Date;
}

interface DerivedRegistrationIds {
  readonly actorId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly profileId: string;
  readonly authSubjectId: string;
  readonly hermesProfileRef: string;
  readonly eventId: string;
  readonly auditEventId: string;
  readonly outboxId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

const operation = "identity.register-b2c";
const dayMs = 24 * 60 * 60 * 1_000;
const payloadHashPattern = /^sha256:[a-f0-9]{64}$/u;
const identityCollisionConstraints = new Set([
  "auth_subjects_provider_provider_subject_key",
  "private_identity_pii_normalized_email_hmac_key",
]);

function invalid(message: string): never {
  throw new DomainError("INVALID_REQUEST", message);
}

function ownStringData(value: unknown, key: string): string | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function rethrowRegistrationError(error: unknown): never {
  if (
    ownStringData(error, "code") === "23505"
    && identityCollisionConstraints.has(ownStringData(error, "constraint") ?? "")
  ) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "Identity registration conflicts with existing authority");
  }
  throw error;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function assertCommand(value: unknown): asserts value is RegisterB2cCommand {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    "schema_version", "idempotency_key", "payload_hash", "auth_subject", "display_name",
  ])) invalid("B2C registration command does not satisfy its contract");
  const subject = value.auth_subject;
  if (!isPlainObject(subject) || !hasExactKeys(subject, [
    "provider", "providerSubject", "identityKind", "normalizedEmail", "verifiedAt",
  ])) invalid("B2C registration command does not satisfy its contract");
  if (
    value.schema_version !== 1
    || typeof value.idempotency_key !== "string"
    || value.idempotency_key.length < 1
    || value.idempotency_key.length > 255
    || typeof value.payload_hash !== "string"
    || !payloadHashPattern.test(value.payload_hash)
    || typeof value.display_name !== "string"
    || value.display_name.length < 1
    || value.display_name.length > 200
    || subject.provider !== "supabase"
    || typeof subject.providerSubject !== "string"
    || subject.providerSubject.length < 1
    || subject.providerSubject.length > 255
    || (subject.identityKind !== "email_password" && subject.identityKind !== "apple")
    || typeof subject.normalizedEmail !== "string"
    || subject.normalizedEmail.length < 3
    || subject.normalizedEmail.length > 320
    || subject.normalizedEmail !== subject.normalizedEmail.trim().toLowerCase()
    || !subject.normalizedEmail.includes("@")
    || typeof subject.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(subject.verifiedAt))
  ) invalid("B2C registration command does not satisfy its contract");
}

function payloadWithoutHash(command: RegisterB2cCommand): Omit<RegisterB2cCommand, "payload_hash"> {
  const { payload_hash: _payloadHash, ...payload } = command;
  return payload;
}

function deriveIdentityId(prefix: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`identity.register-b2c:${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function deriveRegistrationIds(idempotencyKey: string): DerivedRegistrationIds {
  return {
    actorId: deriveIdentityId("actor", idempotencyKey),
    tenantId: deriveIdentityId("tenant", idempotencyKey),
    membershipId: deriveIdentityId("membership", idempotencyKey),
    profileId: deriveIdentityId("profile", idempotencyKey),
    authSubjectId: deriveIdentityId("auth_subject", idempotencyKey),
    hermesProfileRef: deriveIdentityId("hermes", idempotencyKey),
    eventId: deriveIdentityId("event_identity", idempotencyKey),
    auditEventId: deriveIdentityId("audit_identity", idempotencyKey),
    outboxId: deriveIdentityId("outbox_identity", idempotencyKey),
    correlationId: deriveIdentityId("correlation_identity", idempotencyKey),
    causationId: deriveIdentityId("causation_identity", idempotencyKey),
  };
}

function result(ids: DerivedRegistrationIds): B2cRegistrationResult {
  return Object.freeze({
    schema_version: 1,
    actor_id: ids.actorId,
    tenant_id: ids.tenantId,
    membership_id: ids.membershipId,
    profile_id: ids.profileId,
    auth_subject_id: ids.authSubjectId,
  });
}

function assertReplay(value: unknown, ids: DerivedRegistrationIds): void {
  const expected = result(ids);
  if (
    !isPlainObject(value)
    || !hasExactKeys(value, Object.keys(expected))
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)
  ) throw new DomainError("INTERNAL_ERROR", "Stored B2C registration response is invalid");
}

function assertServerConfiguration(dependencies: RegisterB2cDependencies, context: RegisterB2cContext): void {
  if (
    dependencies.defaultProfile.providerConfigId.length < 1
    || dependencies.defaultProfile.providerConfigId.length > 255
    || dependencies.defaultProfile.modelId.length < 1
    || dependencies.defaultProfile.modelId.length > 255
    || context.requestId.length < 1
    || context.requestId.length > 255
    || context.traceId.length < 1
    || context.traceId.length > 255
  ) throw new DomainError("INTERNAL_ERROR", "B2C registration server configuration is invalid");
}

async function serializable<T>(
  db: Kysely<RuntimeDatabase>,
  work: (trx: Transaction<RuntimeDatabase>) => Promise<T>,
): Promise<T> {
  return withDatabaseTransactionRetry(db, work, { isolationLevel: "serializable" });
}

export async function registerB2c(
  dependencies: RegisterB2cDependencies,
  context: RegisterB2cContext,
  input: RegisterB2cCommand,
): Promise<B2cRegistrationResult> {
  assertCommand(input);
  assertServerConfiguration(dependencies, context);
  if (input.payload_hash !== canonicalPayloadHash(payloadWithoutHash(input))) {
    invalid("Payload hash does not match the canonical B2C registration command");
  }
  const ids = deriveRegistrationIds(input.idempotency_key);

  return serializable(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Registration clock is invalid");
    const nowIso = now.toISOString();
    const actorInsert = await trx.insertInto("actors").values({
      actor_id: ids.actorId,
      schema_version: 1,
      resource_version: 1,
      actor_kind: "human",
      display_name: input.display_name,
      status: "active",
      created_at: now,
      updated_at: now,
    }).onConflict((conflict) => conflict.column("actor_id").doNothing())
      .returning("actor_id")
      .executeTakeFirst();
    const actor = await trx.selectFrom("actors")
      .select(["actor_kind", "display_name", "status"])
      .where("actor_id", "=", ids.actorId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();

    const tenantInsert = await trx.insertInto("tenants").values({
      tenant_id: ids.tenantId,
      schema_version: 1,
      resource_version: 1,
      tenant_mode: "b2c",
      status: "active",
      display_name: input.display_name,
      created_at: now,
      updated_at: now,
    }).onConflict((conflict) => conflict.column("tenant_id").doNothing())
      .returning("tenant_id")
      .executeTakeFirst();
    const tenantTransaction: TenantTransaction = { tenantId: ids.tenantId, trx };
    const admission = await beginIdempotentCommand<B2cRegistrationResult>(tenantTransaction, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") {
      if (admission.resultRef !== ids.actorId) {
        throw new DomainError("INTERNAL_ERROR", "B2C registration replay result reference is invalid");
      }
      assertReplay(admission.response, ids);
      return result(ids);
    }
    if (admission.kind === "in_progress") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "B2C registration command is already in progress");
    }
    if (
      actorInsert === undefined
      || tenantInsert === undefined
      || actor.actor_kind !== "human"
      || actor.display_name !== input.display_name
      || actor.status !== "active"
    ) throw new DomainError("IDEMPOTENCY_CONFLICT", "B2C registration identity graph already exists");

    await trx.insertInto("memberships").values({
      tenant_id: ids.tenantId,
      membership_id: ids.membershipId,
      actor_id: ids.actorId,
      schema_version: 1,
      resource_version: 1,
      roles: ["student"],
      membership_source: "self",
      seat_ref: null,
      status: "active",
      created_at: now,
      updated_at: now,
    }).execute();
    await trx.insertInto("profiles").values({
      tenant_id: ids.tenantId,
      profile_id: ids.profileId,
      schema_version: 1,
      resource_version: 1,
      owner_actor_id: ids.actorId,
      profile_kind: "default",
      hermes_profile_ref: ids.hermesProfileRef,
      description: "Personal student profile",
      status: "active",
      provider_config_id: dependencies.defaultProfile.providerConfigId,
      model_id: dependencies.defaultProfile.modelId,
      created_at: now,
      updated_at: now,
    }).execute();
    await loadActorIdentityAuthority(trx, ids.actorId);

    await trx.insertInto("auth_subjects").values({
      auth_subject_id: ids.authSubjectId,
      actor_id: ids.actorId,
      provider: input.auth_subject.provider,
      provider_subject: input.auth_subject.providerSubject,
      provider_identity_kind: input.auth_subject.identityKind,
      verified_at: new Date(input.auth_subject.verifiedAt),
      status: "active",
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    await insertPrivateIdentityPii(trx, {
      actorId: ids.actorId,
      normalizedEmail: input.auth_subject.normalizedEmail,
      protection: dependencies.privatePii,
      now,
    });

    await trx.insertInto("stream_sequences").values({
      tenant_id: ids.tenantId,
      stream_id: ids.actorId,
      last_sequence: 1,
    }).execute();
    const event = {
      schema_version: 1 as const,
      event_id: ids.eventId,
      occurred_at: nowIso,
      sequence: 1,
      tenant_id: ids.tenantId,
      request_id: context.requestId,
      trace_id: context.traceId,
      correlation_id: ids.correlationId,
      causation_id: ids.causationId,
      profile_id: ids.profileId,
      event_type: "identity.registered" as const,
      payload: {
        actor_id: ids.actorId,
        tenant_id: ids.tenantId,
        membership_id: ids.membershipId,
        profile_id: ids.profileId,
        resource_version: 1,
      },
    };
    validateProductEvent(event, ids.tenantId);
    await trx.insertInto("product_events").values({
      tenant_id: ids.tenantId,
      event_id: ids.eventId,
      stream_id: ids.actorId,
      schema_version: 1,
      sequence: 1,
      event_type: event.event_type,
      occurred_at: now,
      request_id: context.requestId,
      trace_id: context.traceId,
      correlation_id: ids.correlationId,
      causation_id: ids.causationId,
      profile_id: ids.profileId,
      conversation_id: null,
      run_id: null,
      task_id: null,
      approval_id: null,
      student_ref: null,
      case_ref: null,
      capability_id: null,
      payload: event.payload,
    }).execute();
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1,
      audit_event_id: ids.auditEventId,
      occurred_at: nowIso,
      tenant_id: ids.tenantId,
      actor_id: ids.actorId,
      membership_id: ids.membershipId,
      effective_role: "student",
      action: operation,
      resource_type: "actor",
      resource_id: ids.actorId,
      decision: "allowed",
      outcome: "succeeded",
      request_id: context.requestId,
      trace_id: context.traceId,
      reason_summary: "Registered personal B2C identity graph",
      resource_version: 1,
    });
    await enqueueOutbox(tenantTransaction, {
      outboxId: ids.outboxId,
      eventId: ids.eventId,
      deliveryTarget: "internal_event_stream",
      now,
    });

    const response = result(ids);
    await completeIdempotentCommand(tenantTransaction, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      resultRef: ids.actorId,
      response,
      updatedAt: now,
    });
    return response;
  }).catch(rethrowRegistrationError);
}
