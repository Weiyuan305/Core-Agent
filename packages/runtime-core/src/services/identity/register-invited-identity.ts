import { createHash } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { TenantTransaction } from "../../db/transaction.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../../domain/idempotency.js";
import {
  insertPrivateIdentityPii,
  type PrivateIdentityPiiProtection,
} from "../../repositories/identity/private-pii.js";
import type { RegisterB2cContext, VerifiedAuthSubjectInput } from "./register-b2c.js";
import { constantTimeDigestMatches, invitationEmailHmac } from "../../repositories/identity/invitations.js";

export interface RegisterInvitedIdentityCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly tenant_id: string;
  readonly auth_subject: VerifiedAuthSubjectInput;
  readonly display_name: string;
}

export interface RegisterInvitedIdentityDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly transaction: Transaction<RuntimeDatabase>;
  readonly privatePii: PrivateIdentityPiiProtection;
  readonly verifiedInvitationBinding: {
    readonly invitationId: string;
    readonly tenantId: string;
    readonly secretDigest: Uint8Array;
    readonly expectedResourceVersion: number;
    readonly role: "admin" | "consultant";
  };
  readonly now?: () => Date;
}

export interface InvitedIdentityRegistrationResult {
  readonly schema_version: 1;
  readonly actor_id: string;
  readonly auth_subject_id: string;
}

const operation = "identity.register-invited";
const dayMs = 24 * 60 * 60 * 1_000;
const identityCollisionConstraints = new Set([
  "auth_subjects_provider_provider_subject_key",
  "private_identity_pii_normalized_email_hmac_key",
]);

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
    throw new DomainError("IDEMPOTENCY_CONFLICT", "Invited identity conflicts with existing authority");
  }
  throw error;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function assertCommand(input: unknown): asserts input is RegisterInvitedIdentityCommand {
  if (!isPlainObject(input) || !exactKeys(input, [
    "schema_version", "idempotency_key", "payload_hash", "tenant_id", "auth_subject", "display_name",
  ])) throw new DomainError("INVALID_REQUEST", "Invited identity registration is invalid");
  const subject = input.auth_subject;
  if (!isPlainObject(subject) || !exactKeys(subject, [
    "provider", "providerSubject", "identityKind", "normalizedEmail", "verifiedAt",
  ]) || input.schema_version !== 1 || !validId(input.idempotency_key) || !validId(input.tenant_id)
    || typeof input.payload_hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.payload_hash)
    || typeof input.display_name !== "string" || input.display_name.length < 1 || input.display_name.length > 200
    || subject.provider !== "supabase"
    || (subject.identityKind !== "email_password" && subject.identityKind !== "apple")
    || !validId(subject.providerSubject)
    || typeof subject.normalizedEmail !== "string"
    || subject.normalizedEmail !== subject.normalizedEmail.trim().toLowerCase()
    || subject.normalizedEmail.length < 3 || subject.normalizedEmail.length > 320 || !subject.normalizedEmail.includes("@")
    || typeof subject.verifiedAt !== "string" || !Number.isFinite(Date.parse(subject.verifiedAt))) {
    throw new DomainError("INVALID_REQUEST", "Invited identity registration is invalid");
  }
  const { payload_hash: _payloadHash, ...payload } = input;
  if (input.payload_hash !== canonicalPayloadHash(payload)) {
    throw new DomainError("INVALID_REQUEST", "Invited identity registration payload hash is invalid");
  }
}

function derivedId(prefix: string, key: string): string {
  return `${prefix}_${createHash("sha256").update(`identity.register-invited:${key}`, "utf8").digest("hex").slice(0, 32)}`;
}

function registrationResult(key: string): InvitedIdentityRegistrationResult {
  return Object.freeze({
    schema_version: 1,
    actor_id: derivedId("actor", key),
    auth_subject_id: derivedId("auth_subject", key),
  });
}

function assertReplay(value: unknown, expected: InvitedIdentityRegistrationResult): void {
  if (!isPlainObject(value) || !exactKeys(value, Object.keys(expected))
    || Object.entries(expected).some(([key, item]) => value[key] !== item)) {
    throw new DomainError("INTERNAL_ERROR", "Stored invited identity response is invalid");
  }
}

export async function registerInvitedIdentityForVerifiedInvitation(
  dependencies: RegisterInvitedIdentityDependencies,
  context: RegisterB2cContext,
  input: unknown,
): Promise<InvitedIdentityRegistrationResult> {
  assertCommand(input);
  if (!validId(context.requestId) || !validId(context.traceId)) {
    throw new DomainError("INTERNAL_ERROR", "Invited identity registration context is invalid");
  }
  const now = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Invited identity registration clock is invalid");
  const tenant = await dependencies.transaction.selectFrom("tenants").select(["tenant_mode", "status"])
    .where("tenant_id", "=", input.tenant_id).forShare().executeTakeFirst();
  if (tenant?.tenant_mode !== "b2b" || tenant.status !== "active") {
    throw new DomainError("UNAUTHENTICATED", "Invited identity Tenant authority is unavailable");
  }
  const binding = dependencies.verifiedInvitationBinding;
  if (!validId(binding?.invitationId) || binding.tenantId !== input.tenant_id
    || !(binding.secretDigest instanceof Uint8Array) || binding.secretDigest.byteLength !== 32
    || !Number.isSafeInteger(binding.expectedResourceVersion) || binding.expectedResourceVersion < 1
    || (binding.role !== "admin" && binding.role !== "consultant")) {
    throw new DomainError("UNAUTHENTICATED", "Verified invitation binding is required");
  }
  const invitation = await dependencies.transaction.selectFrom("identity_invitations")
    .select(["tenant_id", "secret_digest", "normalized_email_hmac", "role", "status", "expires_at", "resource_version"])
    .where("invitation_id", "=", binding.invitationId).forUpdate().executeTakeFirst();
  const databaseTimestamp = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(dependencies.transaction)).rows[0]?.now;
  const observedEmailHmac = invitationEmailHmac(
    dependencies.privatePii.normalizedEmailHmacKey, input.auth_subject.normalizedEmail,
  );
  try {
    if (!(databaseTimestamp instanceof Date) || invitation === undefined
      || invitation.tenant_id !== binding.tenantId || invitation.role !== binding.role
      || invitation.status !== "pending" || invitation.expires_at.getTime() <= databaseTimestamp.getTime()
      || Number(invitation.resource_version) !== binding.expectedResourceVersion
      || !constantTimeDigestMatches(binding.secretDigest, invitation.secret_digest)
      || !constantTimeDigestMatches(observedEmailHmac, invitation.normalized_email_hmac)) {
      throw new DomainError("UNAUTHENTICATED", "Verified invitation authority is unavailable");
    }
  } finally {
    observedEmailHmac.fill(0);
  }
  const tenantTransaction: TenantTransaction = { tenantId: input.tenant_id, trx: dependencies.transaction };
  const expected = registrationResult(input.idempotency_key);
  const admission = await beginIdempotentCommand<InvitedIdentityRegistrationResult>(tenantTransaction, {
    key: input.idempotency_key,
    payloadHash: input.payload_hash,
    operation,
    now,
    expiresAt: new Date(now.getTime() + dayMs),
  });
  if (admission.kind === "replay") {
    if (admission.resultRef !== expected.actor_id) throw new DomainError("INTERNAL_ERROR", "Invited identity replay reference is invalid");
    assertReplay(admission.response, expected);
    return expected;
  }
  if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Invited identity registration is in progress");
  try {
    await dependencies.transaction.insertInto("actors").values({
      actor_id: expected.actor_id,
      schema_version: 1,
      resource_version: 1,
      actor_kind: "human",
      display_name: input.display_name,
      status: "active",
      created_at: now,
      updated_at: now,
    }).execute();
    await dependencies.transaction.insertInto("auth_subjects").values({
      auth_subject_id: expected.auth_subject_id,
      actor_id: expected.actor_id,
      provider: input.auth_subject.provider,
      provider_subject: input.auth_subject.providerSubject,
      provider_identity_kind: input.auth_subject.identityKind,
      verified_at: new Date(input.auth_subject.verifiedAt),
      status: "active",
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    await insertPrivateIdentityPii(dependencies.transaction, {
      actorId: expected.actor_id,
      normalizedEmail: input.auth_subject.normalizedEmail,
      protection: dependencies.privatePii,
      now,
    });
  } catch (error) {
    rethrowRegistrationError(error);
  }
  await completeIdempotentCommand(tenantTransaction, {
    key: input.idempotency_key,
    payloadHash: input.payload_hash,
    operation,
    resultRef: expected.actor_id,
    response: expected,
    updatedAt: now,
  });
  return expected;
}

export const registerInvitedIdentityTestInternals = Object.freeze({ rethrowRegistrationError });
