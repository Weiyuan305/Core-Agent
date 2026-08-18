import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { canonicalPayloadHash, DomainError } from "../../domain/idempotency.js";
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
  readonly flow:
    | { readonly kind: "b2c" }
    | {
      readonly kind: "invitation";
      readonly invitationId: string;
      readonly tenantId: string;
      readonly invitationSecretDigest: string;
      readonly expectedResourceVersion: number;
      readonly role: "admin" | "consultant";
    };
}

export interface EmailVerificationStartPayloadFacts {
  readonly idempotencyKey: string;
  readonly normalizedEmail: string;
  readonly clientKind: "web" | "iphone" | "macos";
  readonly deviceLabel?: string;
  readonly flowKind: "b2c" | "invitation";
  readonly invitationDigest?: string;
}

export interface BegunEmailVerificationTransaction {
  readonly kind: "reserved" | "in_progress" | "finalized_replay";
  readonly verificationId: string;
  readonly expiresAt: string;
}

export interface ConsumedEmailVerificationBinding {
  readonly normalizedEmail: string;
  readonly clientKind: "web" | "iphone" | "macos";
  readonly deviceLabel?: string;
  readonly flowKind: "b2c" | "invitation";
  readonly invitationId?: string;
  readonly tenantId?: string;
  readonly invitationSecretDigest?: string;
  readonly expectedResourceVersion?: number;
  readonly role?: "admin" | "consultant";
  readonly verifiedSubject: VerifiedAuthSubjectInput;
}

type StoredEmailVerificationBinding = Omit<ConsumedEmailVerificationBinding, "verifiedSubject">;

export type PreparedEmailVerificationBinding = Omit<ConsumedEmailVerificationBinding, "verifiedSubject"> & {
  readonly providerVerification:
    | { readonly kind: "pending"; readonly expectedProviderSubject: string }
    | { readonly kind: "verified"; readonly subject: VerifiedAuthSubjectInput };
};

export interface ExpiredEmailVerificationTransaction {
  readonly kind: "expired";
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

export function canonicalEmailVerificationStartPayloadHash(input: EmailVerificationStartPayloadFacts): string {
  return canonicalPayloadHash({
    schema_version: 1,
    flow_kind: input.flowKind,
    idempotency_key: input.idempotencyKey,
    normalized_email: input.normalizedEmail,
    client_kind: input.clientKind,
    ...(input.deviceLabel === undefined ? {} : { device_label: input.deviceLabel }),
    ...(input.flowKind === "invitation" ? { invitation_digest: input.invitationDigest } : {}),
  });
}

function assertPayloadHash(input: BeginEmailVerificationTransactionInput): void {
  const expected = canonicalEmailVerificationStartPayloadHash({
    idempotencyKey: input.idempotencyKey,
    normalizedEmail: input.normalizedEmail,
    clientKind: input.clientKind,
    ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
    flowKind: input.flow.kind,
    ...(input.flow.kind === "invitation" ? { invitationDigest: input.flow.invitationSecretDigest } : {}),
  });
  const suppliedBytes = Buffer.from(input.payloadHash, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  try {
    if (suppliedBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(suppliedBytes, expectedBytes)) invalidInput();
  } finally {
    suppliedBytes.fill(0);
    expectedBytes.fill(0);
  }
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
  if (input.flow?.kind !== "b2c" && (
    input.flow?.kind !== "invitation"
    || typeof input.flow.invitationId !== "string"
    || input.flow.invitationId.length < 1
    || input.flow.invitationId.length > 255
    || typeof input.flow.tenantId !== "string"
    || input.flow.tenantId.length < 1
    || input.flow.tenantId.length > 255
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.flow.invitationSecretDigest)
    || Buffer.from(input.flow.invitationSecretDigest, "base64url").byteLength !== 32
    || !Number.isSafeInteger(input.flow.expectedResourceVersion)
    || input.flow.expectedResourceVersion < 1
    || (input.flow.role !== "admin" && input.flow.role !== "consultant")
  )) invalidInput();
  assertPayloadHash(input);
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
    flow_kind: input.flow.kind,
    ...(input.flow.kind === "b2c" ? {} : {
      invitation_id: input.flow.invitationId,
      tenant_id: input.flow.tenantId,
      invitation_secret_digest: input.flow.invitationSecretDigest,
      expected_resource_version: input.flow.expectedResourceVersion,
      role: input.flow.role,
    }),
  }), "utf8");
}

function parseBinding(value: Uint8Array): StoredEmailVerificationBinding {
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
  const base = binding.device_label === undefined
    ? ["client_kind", "flow_kind", "normalized_email"]
    : ["client_kind", "device_label", "flow_kind", "normalized_email"];
  const expected = binding.flow_kind === "invitation"
    ? [...base, "expected_resource_version", "invitation_id", "invitation_secret_digest", "role", "tenant_id"]
    : base;
  if (
    JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(expected.sort())
    || typeof binding.normalized_email !== "string"
    || (binding.client_kind !== "web" && binding.client_kind !== "iphone" && binding.client_kind !== "macos")
    || binding.device_label !== undefined && typeof binding.device_label !== "string"
    || (binding.flow_kind !== "b2c" && binding.flow_kind !== "invitation")
  ) throw new DomainError("INTERNAL_ERROR", "Stored email verification binding is invalid");
  if (binding.flow_kind === "invitation" && (
    typeof binding.invitation_id !== "string"
    || typeof binding.tenant_id !== "string"
    || typeof binding.invitation_secret_digest !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(binding.invitation_secret_digest)
    || !Number.isSafeInteger(binding.expected_resource_version)
    || (binding.role !== "admin" && binding.role !== "consultant")
  )) throw new DomainError("INTERNAL_ERROR", "Stored email verification invitation binding is invalid");
  return Object.freeze({
    normalizedEmail: binding.normalized_email,
    clientKind: binding.client_kind,
    ...(binding.device_label === undefined ? {} : { deviceLabel: binding.device_label }),
    flowKind: binding.flow_kind,
    ...(binding.flow_kind === "b2c" ? {} : {
      invitationId: binding.invitation_id as string,
      tenantId: binding.tenant_id as string,
      invitationSecretDigest: binding.invitation_secret_digest as string,
      expectedResourceVersion: binding.expected_resource_version as number,
      role: binding.role as "admin" | "consultant",
    }),
  });
}

function assertProviderSubject(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) invalidAuthority();
}

function assertVerifiedSubject(value: unknown): asserts value is VerifiedAuthSubjectInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidAuthority();
  const subject = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(subject).sort()) !== JSON.stringify([
    "identityKind", "normalizedEmail", "provider", "providerSubject", "verifiedAt",
  ].sort()) || subject.provider !== "supabase" || subject.identityKind !== "email_password"
    || typeof subject.providerSubject !== "string" || subject.providerSubject.length < 1
    || subject.providerSubject.length > 1_024 || typeof subject.normalizedEmail !== "string"
    || subject.normalizedEmail !== subject.normalizedEmail.trim().toLowerCase()
    || !emailPattern.test(subject.normalizedEmail) || typeof subject.verifiedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(subject.verifiedAt)
    || !Number.isFinite(Date.parse(subject.verifiedAt))) invalidAuthority();
}

function subjectPlaintext(subject: VerifiedAuthSubjectInput): Buffer {
  return Buffer.from(JSON.stringify({
    provider: subject.provider,
    providerSubject: subject.providerSubject,
    identityKind: subject.identityKind,
    normalizedEmail: subject.normalizedEmail,
    verifiedAt: new Date(subject.verifiedAt).toISOString(),
  }), "utf8");
}

function parseVerifiedSubject(value: Uint8Array): VerifiedAuthSubjectInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch {
    throw new DomainError("INTERNAL_ERROR", "Stored provider verification is invalid");
  }
  assertVerifiedSubject(parsed);
  return Object.freeze({ ...parsed });
}

async function decryptExpectedProviderSubject(
  dependencies: EmailVerificationTransactionDependencies,
  ciphertext: Uint8Array | null,
  expectedHmac: Uint8Array | null,
): Promise<string> {
  if (ciphertext === null || expectedHmac === null) {
    throw new DomainError("INTERNAL_ERROR", "Stored expected provider subject is unavailable");
  }
  let plaintext: Uint8Array | undefined;
  let observedHmac: Buffer | undefined;
  try {
    plaintext = Uint8Array.from(await dependencies.protector.decrypt(ciphertext));
    const subject = Buffer.from(plaintext).toString("utf8");
    assertProviderSubject(subject);
    observedHmac = hmac(dependencies.hmacKey, "email-verification-provider-subject", subject);
    if (!timingSafeEqual(Buffer.from(expectedHmac), observedHmac)) {
      throw new DomainError("INTERNAL_ERROR", "Stored expected provider subject is invalid");
    }
    return subject;
  } finally {
    plaintext?.fill(0);
    observedHmac?.fill(0);
  }
}

function expiredAfterCommit(): never {
  invalidAuthority();
}

export async function beginEmailVerificationTransaction(
  dependencies: EmailVerificationTransactionDependencies,
  input: BeginEmailVerificationTransactionInput,
): Promise<BegunEmailVerificationTransaction | ExpiredEmailVerificationTransaction> {
  const ttlMs = assertDependencies(dependencies);
  assertBeginInput(input);
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<BegunEmailVerificationTransaction | ExpiredEmailVerificationTransaction> => {
    const now = await databaseNow(dependencies, trx);
    const plaintext = bindingPlaintext(input);
    const emailHmac = hmac(dependencies.hmacKey, "email-verification-email", input.normalizedEmail);
    let ciphertext: Uint8Array | undefined;
    let inserted: { email_verification_transaction_id: string } | undefined;
    const candidateId = verificationId(dependencies.randomBytes);
    const candidateExpiresAt = new Date(now.getTime() + ttlMs);
    try {
      ciphertext = Uint8Array.from(await dependencies.protector.encrypt(plaintext));
      if (ciphertext.byteLength < 33 || ciphertext.byteLength > 65_536) {
        throw new DomainError("INTERNAL_ERROR", "Email verification binding protection is invalid");
      }
      inserted = await trx.insertInto("email_verification_transactions").values({
        email_verification_transaction_id: candidateId,
        start_idempotency_key: input.idempotencyKey,
        start_payload_hash: input.payloadHash,
        normalized_email_hmac: emailHmac,
        binding_ciphertext: ciphertext,
        expected_provider_subject_hmac: null,
        expected_provider_subject_ciphertext: null,
        verified_provider_subject_hmac: null,
        verified_subject_ciphertext: null,
        provider_verification_status: "pending",
        provider_verified_at: null,
        provider_start_status: "reserved",
        provider_start_attempt: 1,
        provider_start_finalized_at: null,
        provider_start_failed_at: null,
        status: "pending",
        expires_at: candidateExpiresAt,
        consumed_at: null,
        created_at: now,
        updated_at: now,
      }).onConflict((conflict) => conflict.column("start_idempotency_key").doNothing())
        .returning("email_verification_transaction_id").executeTakeFirst();
    } finally {
      plaintext.fill(0);
      emailHmac.fill(0);
      ciphertext?.fill(0);
    }
    if (inserted !== undefined) {
      return Object.freeze({
        kind: "reserved" as const,
        verificationId: inserted.email_verification_transaction_id,
        expiresAt: candidateExpiresAt.toISOString(),
      });
    }
    const existing = await trx.selectFrom("email_verification_transactions")
      .select(["email_verification_transaction_id", "start_payload_hash", "provider_start_status", "provider_start_attempt", "status", "expires_at"])
      .where("start_idempotency_key", "=", input.idempotencyKey)
      .forUpdate()
      .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.start_payload_hash !== input.payloadHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification start payload conflicts");
      }
      if (existing.status === "pending" && now.getTime() >= existing.expires_at.getTime()) {
        await trx.updateTable("email_verification_transactions")
          .set({ status: "expired", updated_at: now })
          .where("email_verification_transaction_id", "=", existing.email_verification_transaction_id)
          .where("status", "=", "pending")
          .execute();
        return { kind: "expired" };
      }
      if (existing.status !== "pending") invalidAuthority();
      if (existing.provider_start_status === "failed") {
        const expiresAt = new Date(now.getTime() + ttlMs);
        await trx.updateTable("email_verification_transactions").set({
          provider_start_status: "reserved",
          provider_start_attempt: existing.provider_start_attempt + 1,
          provider_start_finalized_at: null,
          provider_start_failed_at: null,
          expires_at: expiresAt,
          updated_at: now,
        }).where("email_verification_transaction_id", "=", existing.email_verification_transaction_id)
          .where("provider_start_status", "=", "failed")
          .execute();
        return Object.freeze({
          kind: "reserved" as const,
          verificationId: existing.email_verification_transaction_id,
          expiresAt: expiresAt.toISOString(),
        });
      }
      return Object.freeze({
        kind: existing.provider_start_status === "finalized" ? "finalized_replay" as const : "in_progress" as const,
        verificationId: existing.email_verification_transaction_id,
        expiresAt: existing.expires_at.toISOString(),
      });
    }
    throw new DomainError("INTERNAL_ERROR", "Email verification admission did not converge");
  };
  const result = dependencies.transaction === undefined
    ? dependencies.db.transaction().execute(execute)
    : execute(dependencies.transaction);
  const settled = await result;
  if (settled.kind === "expired" && dependencies.transaction === undefined) expiredAfterCommit();
  return settled;
}

export async function finalizeEmailVerificationTransactionStart(
  dependencies: EmailVerificationTransactionDependencies,
  input:
    | { readonly verificationId: string; readonly outcome: "failed" }
    | { readonly verificationId: string; readonly outcome: "finalized"; readonly expectedProviderSubject: string },
): Promise<void> {
  assertDependencies(dependencies);
  if (typeof input.verificationId !== "string" || input.verificationId.length < 1 || input.verificationId.length > 255
    || (input.outcome !== "finalized" && input.outcome !== "failed")
    || input.outcome === "finalized" && (typeof input.expectedProviderSubject !== "string"
      || input.expectedProviderSubject.length < 1 || input.expectedProviderSubject.length > 1_024)) invalidInput();
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<"ok" | "expired"> => {
    const now = await databaseNow(dependencies, trx);
    const row = await trx.selectFrom("email_verification_transactions")
      .select(["provider_start_status", "status", "expires_at", "expected_provider_subject_hmac", "expected_provider_subject_ciphertext"])
      .where("email_verification_transaction_id", "=", input.verificationId)
      .forUpdate().executeTakeFirst();
    if (row === undefined || row.status !== "pending") invalidAuthority();
    if (now.getTime() >= row.expires_at.getTime()) {
      await trx.updateTable("email_verification_transactions").set({ status: "expired", updated_at: now })
        .where("email_verification_transaction_id", "=", input.verificationId).execute();
      return "expired";
    }
    if (row.provider_start_status === input.outcome) {
      if (input.outcome === "finalized") {
        const stored = await decryptExpectedProviderSubject(
          dependencies, row.expected_provider_subject_ciphertext, row.expected_provider_subject_hmac,
        );
        const storedBytes = Buffer.from(stored, "utf8");
        const suppliedBytes = Buffer.from(input.expectedProviderSubject, "utf8");
        const matches = storedBytes.byteLength === suppliedBytes.byteLength && timingSafeEqual(storedBytes, suppliedBytes);
        storedBytes.fill(0);
        suppliedBytes.fill(0);
        if (!matches) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification provider subject conflicts");
        }
      }
      return "ok";
    }
    if (row.provider_start_status !== "reserved") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification provider start is not reserved");
    }
    let subjectPlaintext: Buffer | undefined;
    let subjectCiphertext: Uint8Array | undefined;
    let subjectHmac: Buffer | undefined;
    try {
      if (input.outcome === "finalized") {
        subjectPlaintext = Buffer.from(input.expectedProviderSubject, "utf8");
        subjectCiphertext = Uint8Array.from(await dependencies.protector.encrypt(subjectPlaintext));
        if (subjectCiphertext.byteLength < 33 || subjectCiphertext.byteLength > 65_536) {
          throw new DomainError("INTERNAL_ERROR", "Expected provider subject protection is invalid");
        }
        subjectHmac = hmac(dependencies.hmacKey, "email-verification-provider-subject", input.expectedProviderSubject);
      }
      await trx.updateTable("email_verification_transactions").set({
        provider_start_status: input.outcome,
        provider_start_finalized_at: input.outcome === "finalized" ? now : null,
        provider_start_failed_at: input.outcome === "failed" ? now : null,
        expected_provider_subject_hmac: input.outcome === "finalized" ? subjectHmac! : null,
        expected_provider_subject_ciphertext: input.outcome === "finalized" ? subjectCiphertext! : null,
        updated_at: now,
      }).where("email_verification_transaction_id", "=", input.verificationId)
        .where("provider_start_status", "=", "reserved").execute();
    } finally {
      subjectPlaintext?.fill(0);
      subjectCiphertext?.fill(0);
      subjectHmac?.fill(0);
    }
    return "ok";
  };
  const outcome = dependencies.transaction === undefined
    ? await dependencies.db.transaction().execute(execute)
    : await execute(dependencies.transaction);
  if (outcome === "expired") expiredAfterCommit();
}

export async function prepareEmailVerificationTransaction(
  dependencies: EmailVerificationTransactionDependencies,
  input: { readonly verificationId: string },
): Promise<PreparedEmailVerificationBinding> {
  assertDependencies(dependencies);
  if (typeof input.verificationId !== "string" || input.verificationId.length < 1 || input.verificationId.length > 255) invalidInput();
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<PreparedEmailVerificationBinding | ExpiredEmailVerificationTransaction> => {
    const now = await databaseNow(dependencies, trx);
    const row = await trx.selectFrom("email_verification_transactions").selectAll()
      .where("email_verification_transaction_id", "=", input.verificationId)
      .forUpdate().executeTakeFirst();
    if (row?.status === "consumed") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification was already consumed");
    }
    if (row === undefined || row.status !== "pending" || row.provider_start_status !== "finalized") invalidAuthority();
    if (now.getTime() >= row.expires_at.getTime()) {
      await trx.updateTable("email_verification_transactions").set({ status: "expired", updated_at: now })
        .where("email_verification_transaction_id", "=", input.verificationId).execute();
      return { kind: "expired" };
    }
    let plaintext: Uint8Array | undefined;
    let verifiedPlaintext: Uint8Array | undefined;
    try {
      plaintext = Uint8Array.from(await dependencies.protector.decrypt(row.binding_ciphertext));
      const binding = parseBinding(plaintext);
      if (row.provider_verification_status === "pending") {
        return {
          ...binding,
          providerVerification: {
            kind: "pending" as const,
            expectedProviderSubject: await decryptExpectedProviderSubject(
              dependencies, row.expected_provider_subject_ciphertext, row.expected_provider_subject_hmac,
            ),
          },
        };
      }
      if (row.verified_subject_ciphertext === null || row.verified_provider_subject_hmac === null) {
        throw new DomainError("INTERNAL_ERROR", "Stored provider verification checkpoint is unavailable");
      }
      verifiedPlaintext = Uint8Array.from(await dependencies.protector.decrypt(row.verified_subject_ciphertext));
      const subject = parseVerifiedSubject(verifiedPlaintext);
      const subjectHmac = hmac(dependencies.hmacKey, "email-verification-provider-subject", subject.providerSubject);
      try {
        if (!timingSafeEqual(Buffer.from(row.verified_provider_subject_hmac), subjectHmac)) {
          throw new DomainError("INTERNAL_ERROR", "Stored provider verification checkpoint is invalid");
        }
      } finally {
        subjectHmac.fill(0);
      }
      return { ...binding, providerVerification: { kind: "verified" as const, subject } };
    } finally {
      plaintext?.fill(0);
      verifiedPlaintext?.fill(0);
    }
  };
  const result = dependencies.transaction === undefined
    ? await dependencies.db.transaction().execute(execute)
    : await execute(dependencies.transaction);
  if ("kind" in result) expiredAfterCommit();
  return result;
}

export async function checkpointEmailVerificationTransaction(
  dependencies: EmailVerificationTransactionDependencies,
  input: { readonly verificationId: string; readonly verifiedSubject: VerifiedAuthSubjectInput },
): Promise<void> {
  assertDependencies(dependencies);
  if (typeof input.verificationId !== "string" || input.verificationId.length < 1
    || input.verificationId.length > 255) invalidInput();
  assertVerifiedSubject(input.verifiedSubject);
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<"ok" | "expired"> => {
    const now = await databaseNow(dependencies, trx);
    const row = await trx.selectFrom("email_verification_transactions").selectAll()
      .where("email_verification_transaction_id", "=", input.verificationId)
      .forUpdate().executeTakeFirst();
    if (row?.status === "consumed") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification was already consumed");
    }
    if (row === undefined || row.status !== "pending" || row.provider_start_status !== "finalized") invalidAuthority();
    if (now.getTime() >= row.expires_at.getTime()) {
      await trx.updateTable("email_verification_transactions").set({ status: "expired", updated_at: now })
        .where("email_verification_transaction_id", "=", input.verificationId).execute();
      return "expired";
    }
    const expectedProviderSubject = await decryptExpectedProviderSubject(
      dependencies, row.expected_provider_subject_ciphertext, row.expected_provider_subject_hmac,
    );
    const subject = input.verifiedSubject;
    const expectedBytes = Buffer.from(expectedProviderSubject, "utf8");
    const observedBytes = Buffer.from(subject.providerSubject, "utf8");
    const emailHmac = hmac(dependencies.hmacKey, "email-verification-email", subject.normalizedEmail);
    const subjectHmac = hmac(dependencies.hmacKey, "email-verification-provider-subject", subject.providerSubject);
    let bindingPlaintext: Uint8Array | undefined;
    let verifiedPlaintext: Buffer | undefined;
    let verifiedCiphertext: Uint8Array | undefined;
    try {
      if (expectedBytes.byteLength !== observedBytes.byteLength || !timingSafeEqual(expectedBytes, observedBytes)
        || !timingSafeEqual(Buffer.from(row.normalized_email_hmac), emailHmac)) invalidAuthority();
      bindingPlaintext = Uint8Array.from(await dependencies.protector.decrypt(row.binding_ciphertext));
      const binding = parseBinding(bindingPlaintext);
      if (binding.normalizedEmail !== subject.normalizedEmail) invalidAuthority();
      if (row.provider_verification_status === "verified") {
        if (row.verified_provider_subject_hmac === null
          || !timingSafeEqual(Buffer.from(row.verified_provider_subject_hmac), subjectHmac)) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Provider verification checkpoint conflicts");
        }
        return "ok";
      }
      verifiedPlaintext = subjectPlaintext(subject);
      verifiedCiphertext = Uint8Array.from(await dependencies.protector.encrypt(verifiedPlaintext));
      if (verifiedCiphertext.byteLength < 33 || verifiedCiphertext.byteLength > 65_536) {
        throw new DomainError("INTERNAL_ERROR", "Provider verification checkpoint protection is invalid");
      }
      await trx.updateTable("email_verification_transactions").set({
        verified_provider_subject_hmac: subjectHmac,
        verified_subject_ciphertext: verifiedCiphertext,
        provider_verification_status: "verified",
        provider_verified_at: now,
        updated_at: now,
      }).where("email_verification_transaction_id", "=", input.verificationId)
        .where("provider_verification_status", "=", "pending").execute();
      return "ok";
    } finally {
      expectedBytes.fill(0);
      observedBytes.fill(0);
      emailHmac.fill(0);
      subjectHmac.fill(0);
      bindingPlaintext?.fill(0);
      verifiedPlaintext?.fill(0);
      verifiedCiphertext?.fill(0);
    }
  };
  const outcome = dependencies.transaction === undefined
    ? await dependencies.db.transaction().execute(execute)
    : await execute(dependencies.transaction);
  if (outcome === "expired") expiredAfterCommit();
}

export async function consumeEmailVerificationTransaction(
  dependencies: EmailVerificationTransactionDependencies,
  input: { readonly verificationId: string },
): Promise<ConsumedEmailVerificationBinding | ExpiredEmailVerificationTransaction> {
  assertDependencies(dependencies);
  if (typeof input.verificationId !== "string" || input.verificationId.length < 1 || input.verificationId.length > 255) {
    invalidInput();
  }
  const execute = async (trx: Transaction<RuntimeDatabase>): Promise<ConsumedEmailVerificationBinding | ExpiredEmailVerificationTransaction> => {
    const now = await databaseNow(dependencies, trx);
    const row = await trx.selectFrom("email_verification_transactions").selectAll()
      .where("email_verification_transaction_id", "=", input.verificationId)
      .forUpdate()
      .executeTakeFirst();
    if (row?.status === "consumed") {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Email verification was already consumed");
    }
    if (row === undefined || row.status !== "pending" || row.provider_start_status !== "finalized"
      || row.provider_verification_status !== "verified" || row.verified_subject_ciphertext === null
      || row.verified_provider_subject_hmac === null) invalidAuthority();
    if (now.getTime() >= row.expires_at.getTime()) {
      await trx.updateTable("email_verification_transactions")
        .set({ status: "expired", updated_at: now })
        .where("email_verification_transaction_id", "=", input.verificationId)
        .execute();
      return { kind: "expired" };
    }
    let verifiedPlaintext: Uint8Array | undefined;
    let plaintext: Uint8Array | undefined;
    try {
      verifiedPlaintext = Uint8Array.from(await dependencies.protector.decrypt(row.verified_subject_ciphertext));
      const subject = parseVerifiedSubject(verifiedPlaintext);
      const emailHmac = hmac(dependencies.hmacKey, "email-verification-email", subject.normalizedEmail);
      const subjectHmac = hmac(dependencies.hmacKey, "email-verification-provider-subject", subject.providerSubject);
      try {
        if (!timingSafeEqual(Buffer.from(row.normalized_email_hmac), emailHmac)
          || !timingSafeEqual(Buffer.from(row.verified_provider_subject_hmac), subjectHmac)) invalidAuthority();
      } finally {
        emailHmac.fill(0);
        subjectHmac.fill(0);
      }
      plaintext = Uint8Array.from(await dependencies.protector.decrypt(row.binding_ciphertext));
      const binding = parseBinding(plaintext);
      if (binding.normalizedEmail !== subject.normalizedEmail) invalidAuthority();
      await trx.updateTable("email_verification_transactions").set({
        status: "consumed",
        consumed_at: now,
        updated_at: now,
      }).where("email_verification_transaction_id", "=", input.verificationId).execute();
      return { ...binding, verifiedSubject: subject };
    } finally {
      plaintext?.fill(0);
      verifiedPlaintext?.fill(0);
    }
  };
  return dependencies.transaction === undefined
    ? dependencies.db.transaction().execute(execute)
    : execute(dependencies.transaction);
}
