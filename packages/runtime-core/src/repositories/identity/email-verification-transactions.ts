import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import type { VerifiedAuthSubjectInput } from "../../services/identity/register-b2c.js";

export interface EmailVerificationProtector {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface EmailVerificationTransactionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  /** Caller-owned transaction composes one-time consumption with registration. */
  readonly transaction?: Transaction<RuntimeDatabase>;
  readonly hmacKey: Uint8Array;
  readonly protector: EmailVerificationProtector;
  readonly ttlMs?: number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface BeginEmailVerificationTransactionInput {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly normalizedEmail: string;
  readonly clientKind: "web" | "iphone" | "macos";
  readonly deviceLabel?: string;
}

export interface BegunEmailVerificationTransaction {
  readonly kind: "created" | "replay";
  readonly verificationId: string;
  readonly expiresAt: string;
}

export interface ConsumedEmailVerificationBinding {
  readonly normalizedEmail: string;
  readonly clientKind: "web" | "iphone" | "macos";
  readonly deviceLabel?: string;
}

const payloadHashPattern = /^sha256:[a-f0-9]{64}$/u;
const emailPattern = /^[^\s@]+@[^\s@]+$/u;
const defaultTtlMs = 10 * 60 * 1_000;

function invalidInput(): never {
  throw new DomainError("INVALID_REQUEST", "Email verification transaction input is invalid");
}

function invalidAuthority(): never {
  throw new DomainError("UNAUTHENTICATED", "Email verification authority is invalid");
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Email verification database clock is invalid");
  }
  return new Date(value);
}

async function databaseNow(
  dependencies: EmailVerificationTransactionDependencies,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  if (dependencies.databaseNow !== undefined) return validDate(await dependencies.databaseNow(trx));
  const row = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0];
  if (row === undefined) throw new DomainError("INTERNAL_ERROR", "Email verification database clock is unavailable");
  return validDate(row.now);
}

function assertDependencies(dependencies: EmailVerificationTransactionDependencies): number {
  const ttlMs = dependencies.ttlMs ?? defaultTtlMs;
  if (
    !(dependencies.hmacKey instanceof Uint8Array)
    || dependencies.hmacKey.byteLength < 32
    || typeof dependencies.protector?.encrypt !== "function"
    || typeof dependencies.protector?.decrypt !== "function"
    || !Number.isSafeInteger(ttlMs)
    || ttlMs < 60_000
    || ttlMs > 24 * 60 * 60 * 1_000
  ) throw new DomainError("INTERNAL_ERROR", "Email verification transaction configuration is invalid");
  return ttlMs;
}

function assertBeginInput(input: BeginEmailVerificationTransactionInput): void {
  if (
    typeof input.idempotencyKey !== "string"
    || input.idempotencyKey.length < 1
    || input.idempotencyKey.length > 255
    || !payloadHashPattern.test(input.payloadHash)
    || typeof input.normalizedEmail !== "string"
    || input.normalizedEmail.length < 3
    || input.normalizedEmail.length > 320
    || input.normalizedEmail !== input.normalizedEmail.toLowerCase()
    || input.normalizedEmail !== input.normalizedEmail.trim()
    || !emailPattern.test(input.normalizedEmail)
    || (input.clientKind !== "web" && input.clientKind !== "iphone" && input.clientKind !== "macos")
    || input.deviceLabel !== undefined && (
      typeof input.deviceLabel !== "string" || input.deviceLabel.length < 1 || input.deviceLabel.length > 80
    )
  ) invalidInput();
}

function hmac(key: Uint8Array, purpose: string, value: string): Buffer {
  return createHmac("sha256", key).update(`core-agent:${purpose}:v1\0`, "utf8").update(value, "utf8").digest();
}

function verificationId(random: ((length: number) => Uint8Array) | undefined): string {
  const bytes = random?.(24);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 24) {
    if (random !== undefined) throw new DomainError("INTERNAL_ERROR", "Email verification randomness is invalid");
    return `verification_${nodeRandomBytes(24).toString("base64url")}`;
  }
  return `verification_${Buffer.from(bytes).toString("base64url")}`;
}

function bindingPlaintext(input: BeginEmailVerificationTransactionInput): Buffer {
  return Buffer.from(JSON.stringify({
    normalized_email: input.normalizedEmail,
    client_kind: input.clientKind,
    ...(input.deviceLabel === undefined ? {} : { device_label: input.deviceLabel }),
  }), "utf8");
}

function parseBinding(value: Uint8Array): ConsumedEmailVerificationBinding {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch {
    throw new DomainError("INTERNAL_ERROR", "Stored email verification binding is invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DomainError("INTERNAL_ERROR", "Stored email verification binding is invalid");
  }
  const binding = parsed as Record<string, unknown>;
  const expected = binding.device_label === undefined
    ? ["client_kind", "normalized_email"]
    : ["client_kind", "device_label", "normalized_email"];
  if (
    JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(expected)
    || typeof binding.normalized_email !== "string"
    || (binding.client_kind !== "web" && binding.client_kind !== "iphone" && binding.client_kind !== "macos")
    || binding.device_label !== undefined && typeof binding.device_label !== "string"
  ) throw new DomainError("INTERNAL_ERROR", "Stored email verification binding is invalid");
  return Object.freeze({
    normalizedEmail: binding.normalized_email,
    clientKind: binding.client_kind,
    ...(binding.device_label === undefined ? {} : { deviceLabel: binding.device_label }),
  });
}

export async function beginEmailVerificationTransaction(
  dependencies: EmailVerificationTransactionDependencies,
  input: BeginEmailVerificationTransactionInput,
): Promise<BegunEmailVerificationTransaction> {
  const ttlMs = assertDependencies(dependencies);
  assertBeginInput(input);
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<BegunEmailVerificationTransaction> => {
    const now = await databaseNow(dependencies, trx);
    const existing = await trx.selectFrom("email_verification_transactions")
      .select(["email_verification_transaction_id", "start_payload_hash", "status", "expires_at"])
      .where("start_idempotency_key", "=", input.idempotencyKey)
      .forUpdate()
      .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.start_payload_hash !== input.payloadHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification start payload conflicts");
      }
      if (existing.status !== "pending" || now.getTime() >= existing.expires_at.getTime()) invalidAuthority();
      return Object.freeze({
        kind: "replay" as const,
        verificationId: existing.email_verification_transaction_id,
        expiresAt: existing.expires_at.toISOString(),
      });
    }

    const plaintext = bindingPlaintext(input);
    const emailHmac = hmac(dependencies.hmacKey, "email-verification-email", input.normalizedEmail);
    try {
      const ciphertext = Uint8Array.from(await dependencies.protector.encrypt(plaintext));
      if (ciphertext.byteLength < 33 || ciphertext.byteLength > 65_536) {
        throw new DomainError("INTERNAL_ERROR", "Email verification binding protection is invalid");
      }
      const id = verificationId(dependencies.randomBytes);
      const expiresAt = new Date(now.getTime() + ttlMs);
      await trx.insertInto("email_verification_transactions").values({
        email_verification_transaction_id: id,
        start_idempotency_key: input.idempotencyKey,
        start_payload_hash: input.payloadHash,
        normalized_email_hmac: emailHmac,
        binding_ciphertext: ciphertext,
        verified_provider_subject_hmac: null,
        status: "pending",
        expires_at: expiresAt,
        consumed_at: null,
        created_at: now,
        updated_at: now,
      }).execute();
      return Object.freeze({ kind: "created" as const, verificationId: id, expiresAt: expiresAt.toISOString() });
    } finally {
      plaintext.fill(0);
      emailHmac.fill(0);
    }
  };
  return dependencies.transaction === undefined
    ? dependencies.db.transaction().execute(execute)
    : execute(dependencies.transaction);
}

export async function consumeEmailVerificationTransaction(
  dependencies: EmailVerificationTransactionDependencies,
  input: { readonly verificationId: string; readonly verifiedSubject: VerifiedAuthSubjectInput },
): Promise<ConsumedEmailVerificationBinding> {
  assertDependencies(dependencies);
  if (typeof input.verificationId !== "string" || input.verificationId.length < 1 || input.verificationId.length > 255) {
    invalidInput();
  }
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<ConsumedEmailVerificationBinding> => {
    const now = await databaseNow(dependencies, trx);
    const row = await trx.selectFrom("email_verification_transactions").selectAll()
      .where("email_verification_transaction_id", "=", input.verificationId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined || row.status !== "pending") invalidAuthority();
    if (now.getTime() >= row.expires_at.getTime()) {
      await trx.updateTable("email_verification_transactions")
        .set({ status: "expired", updated_at: now })
        .where("email_verification_transaction_id", "=", input.verificationId)
        .execute();
      invalidAuthority();
    }
    const subject = input.verifiedSubject;
    if (
      subject?.provider !== "supabase"
      || subject.identityKind !== "email_password"
      || typeof subject.providerSubject !== "string"
      || subject.providerSubject.length < 1
      || subject.providerSubject.length > 255
      || typeof subject.normalizedEmail !== "string"
      || subject.normalizedEmail !== subject.normalizedEmail.trim().toLowerCase()
      || !Number.isFinite(Date.parse(subject.verifiedAt))
    ) invalidAuthority();
    const emailHmac = hmac(dependencies.hmacKey, "email-verification-email", subject.normalizedEmail);
    const subjectHmac = hmac(dependencies.hmacKey, "email-verification-provider-subject", subject.providerSubject);
    let plaintext: Uint8Array | undefined;
    try {
      if (!timingSafeEqual(Buffer.from(row.normalized_email_hmac), emailHmac)) invalidAuthority();
      plaintext = Uint8Array.from(await dependencies.protector.decrypt(row.binding_ciphertext));
      const binding = parseBinding(plaintext);
      if (binding.normalizedEmail !== subject.normalizedEmail) invalidAuthority();
      await trx.updateTable("email_verification_transactions").set({
        verified_provider_subject_hmac: subjectHmac,
        status: "consumed",
        consumed_at: now,
        updated_at: now,
      }).where("email_verification_transaction_id", "=", input.verificationId).execute();
      return binding;
    } finally {
      emailHmac.fill(0);
      subjectHmac.fill(0);
      plaintext?.fill(0);
    }
  };
  return dependencies.transaction === undefined
    ? dependencies.db.transaction().execute(execute)
    : execute(dependencies.transaction);
}
