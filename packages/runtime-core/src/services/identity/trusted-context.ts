import {
  createPrivateKey,
  sign as signPayload,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { TextDecoder } from "node:util";

import {
  SignedTrustedRequestContextSchema,
  TrustedRequestContextSchema,
  validateSignedContextEnvelope,
  type SignedTrustedRequestContext,
  type TrustedRequestContext,
} from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import Schema from "typebox/schema";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import { loadActorIdentityAuthority } from "../../repositories/identity/identity-authority.js";
import type { SecretReference, SecretStore } from "../../secrets/secret-store.js";
import { canonicalJson } from "./canonical-json.js";

const maximumPayloadBytes = 64 * 1024;
const maximumEnvelopeBytes = maximumPayloadBytes + 16 * 1024;
const maximumContextTtlMs = 300_000;
const maximumClockSkewMs = 60_000;
const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const envelopeValidator = Schema.Compile(SignedTrustedRequestContextSchema);
const payloadValidator = Schema.Compile(TrustedRequestContextSchema);

export interface TrustedContextPublicKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
  readonly status: "active" | "retired" | "disabled";
  readonly activatedAt: string;
  readonly retiredAt?: string;
}

export interface ResolveTrustedContextPublicKeyInput {
  readonly keyId: string;
  readonly keys: readonly TrustedContextPublicKey[];
  readonly issuedAt: Date;
  readonly now: Date;
  readonly clockSkewMs?: number;
}

export interface VerifyTrustedContextSignatureInput {
  readonly envelope: unknown;
  readonly keys: readonly TrustedContextPublicKey[];
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly now: Date;
  readonly clockSkewMs?: number;
}

export interface CurrentEntitlementSnapshotAuthority {
  readonly snapshotRef: {
    readonly snapshot_id: string;
    readonly version: number;
    readonly evaluated_at: string;
  };
  readonly capabilityIds: readonly string[];
  readonly current: boolean;
  readonly bootstrapOnly: boolean;
}

export interface EntitlementSnapshotAuthorityPort {
  loadCurrentSnapshot(input: {
    readonly trx: Transaction<RuntimeDatabase>;
    readonly tenantId: string;
    readonly profileId: string;
    readonly membershipId: string;
    readonly actorId: string;
    readonly now: Date;
  }): Promise<CurrentEntitlementSnapshotAuthority>;
}

export interface IssueTrustedContextDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly signingKey: { readonly keyId: string; readonly privateKey: KeyObject };
  readonly issuer: string;
  readonly audience: readonly string[];
  readonly entitlementSnapshotAuthority: EntitlementSnapshotAuthorityPort;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface IssueTrustedContextInput {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly effectiveRole: "admin" | "consultant" | "student";
  readonly profileId: string;
  readonly containerId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly clientRequestId: string;
  readonly contextId: string;
  readonly ttlSeconds: number;
}

export async function loadIdentitySigningPrivateKey(
  store: SecretStore,
  reference: SecretReference & { readonly purpose: "identity_signing" },
): Promise<KeyObject> {
  if (reference.purpose !== "identity_signing") invalidContext();
  const material = await store.get(reference);
  try {
    const key = material.withBytes((bytes) => {
      try {
        return createPrivateKey({ key: bytes, format: "pem", type: "pkcs8" });
      } catch {
        throw new DomainError("INTERNAL_ERROR", "Identity signing key is invalid");
      }
    });
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new DomainError("INTERNAL_ERROR", "Identity signing key is invalid");
    }
    return key;
  } finally {
    material.release();
  }
}

function invalidTransport(): never {
  throw new DomainError("INVALID_REQUEST", "Trusted context transport is invalid");
}

function invalidContext(): never {
  throw new DomainError("UNAUTHENTICATED", "Trusted context is invalid");
}

function validDate(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalidContext();
  return value.getTime();
}

function parseDate(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalidContext();
  return parsed;
}

function clockSkew(value: number | undefined): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximumClockSkewMs) invalidContext();
  return resolved;
}

function canonicalPayloadBytes(payload: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(payload), "utf8");
  if (bytes.byteLength > maximumPayloadBytes) invalidTransport();
  return bytes;
}

function canonicalBase64UrlBytes(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !canonicalBase64UrlPattern.test(value)) invalidContext();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    bytes.fill(0);
    invalidContext();
  }
  return bytes;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
  }
  Object.freeze(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function invalidIssuance(): never {
  throw new DomainError("UNAUTHENTICATED", "Trusted context authority is invalid");
}

function sortedUniqueIds(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => !validOpaqueId(value))) invalidIssuance();
  return Object.freeze([...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

async function trustedContextDatabaseNow(
  dependencies: IssueTrustedContextDependencies,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const value = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Trusted context database clock is invalid");
  }
  return new Date(value);
}

function assertIssueInput(dependencies: IssueTrustedContextDependencies, input: IssueTrustedContextInput): void {
  if (
    !validOpaqueId(dependencies.signingKey.keyId)
    || dependencies.signingKey.privateKey.type !== "private"
    || dependencies.signingKey.privateKey.asymmetricKeyType !== "ed25519"
    || !validOpaqueId(dependencies.issuer)
    || dependencies.audience.length < 1
    || [
      input.sessionId, input.tenantId, input.membershipId, input.profileId, input.containerId,
      input.conversationId, input.runId, input.requestId, input.traceId, input.clientRequestId, input.contextId,
    ].some((value) => !validOpaqueId(value))
    || !["admin", "consultant", "student"].includes(input.effectiveRole)
    || !Number.isSafeInteger(input.ttlSeconds)
    || input.ttlSeconds < 1
    || input.ttlSeconds > 300
  ) invalidIssuance();
  sortedUniqueIds(dependencies.audience);
}

export function createIdentityBootstrapEntitlementSnapshotAuthorityPort(): EntitlementSnapshotAuthorityPort {
  const authority = Object.freeze({
    snapshotRef: Object.freeze({
      snapshot_id: "identity_bootstrap_empty",
      version: 1,
      evaluated_at: "1970-01-01T00:00:00.000Z",
    }),
    capabilityIds: Object.freeze([] as string[]),
    current: true,
    bootstrapOnly: true,
  });
  return Object.freeze({
    async loadCurrentSnapshot() { return authority; },
  });
}

export function assertTrustedContextAgentRunAdmission(envelope: SignedTrustedRequestContext): void {
  if (
    envelope.payload.entitlement_snapshot_ref.snapshot_id === "identity_bootstrap_empty"
    || envelope.payload.capability_ids.length === 0
  ) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Agent Run entitlement authority is not available");
  }
}

export async function issueTrustedContext(
  dependencies: IssueTrustedContextDependencies,
  input: IssueTrustedContextInput,
): Promise<SignedTrustedRequestContext> {
  assertIssueInput(dependencies, input);
  const audience = sortedUniqueIds(dependencies.audience);
  const payload = await withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const preliminarySession = await trx.selectFrom("core_sessions")
      .select(["actor_id", "auth_subject_id"])
      .where("session_id", "=", input.sessionId)
      .executeTakeFirst();
    if (preliminarySession === undefined) invalidIssuance();
    const actor = await trx.selectFrom("actors").select(["actor_id", "status"])
      .where("actor_id", "=", preliminarySession.actor_id).forShare().executeTakeFirst();
    if (actor?.status !== "active") invalidIssuance();
    const authSubject = await trx.selectFrom("auth_subjects").select(["actor_id", "status"])
      .where("auth_subject_id", "=", preliminarySession.auth_subject_id)
      .where("actor_id", "=", preliminarySession.actor_id).forShare().executeTakeFirst();
    if (authSubject?.status !== "active") invalidIssuance();
    const session = await trx.selectFrom("core_sessions").select([
      "actor_id", "auth_subject_id", "status", "idle_expires_at", "absolute_expires_at",
    ]).where("session_id", "=", input.sessionId).forShare().executeTakeFirst();
    const now = await trustedContextDatabaseNow(dependencies, trx);
    if (
      session?.actor_id !== preliminarySession.actor_id
      || session.auth_subject_id !== preliminarySession.auth_subject_id
      || session.status !== "active"
      || now.getTime() >= session.idle_expires_at.getTime()
      || now.getTime() >= session.absolute_expires_at.getTime()
    ) invalidIssuance();

    const identityAuthority = await loadActorIdentityAuthority(trx, actor.actor_id);
    if (identityAuthority.actorStatus !== "active") invalidIssuance();
    const membershipAuthority = identityAuthority.memberships.find((membership) => (
      membership.membershipId === input.membershipId && membership.tenantId === input.tenantId
    ));
    if (
      membershipAuthority?.status !== "active"
      || !membershipAuthority.roles.includes(input.effectiveRole)
    ) invalidIssuance();

    const tenant = await trx.selectFrom("tenants").select(["tenant_mode", "status"])
      .where("tenant_id", "=", input.tenantId).forShare().executeTakeFirst();
    if (tenant?.status !== "active" || (tenant.tenant_mode !== "b2b" && tenant.tenant_mode !== "b2c")) invalidIssuance();
    const profile = await trx.selectFrom("profiles").select(["owner_actor_id", "status"])
      .where("tenant_id", "=", input.tenantId).where("profile_id", "=", input.profileId)
      .forShare().executeTakeFirst();
    if (profile?.status !== "active" || profile.owner_actor_id !== actor.actor_id) invalidIssuance();
    const container = await trx.selectFrom("runtime_containers")
      .select(["desired_state", "observed_state", "health_status"])
      .where("tenant_id", "=", input.tenantId).where("container_id", "=", input.containerId)
      .forShare().executeTakeFirst();
    if (
      container?.desired_state !== "running"
      || container.observed_state !== "ready"
      || container.health_status !== "healthy"
    ) invalidIssuance();
    const conversation = await trx.selectFrom("conversations")
      .select(["profile_id", "created_by_actor_id", "status"])
      .where("tenant_id", "=", input.tenantId).where("conversation_id", "=", input.conversationId)
      .forShare().executeTakeFirst();
    if (
      conversation?.status !== "active"
      || conversation.profile_id !== input.profileId
      || conversation.created_by_actor_id !== actor.actor_id
    ) invalidIssuance();
    const run = await trx.selectFrom("agent_runs")
      .select(["conversation_id", "request_id", "trace_id", "client_request_id", "status"])
      .where("tenant_id", "=", input.tenantId).where("run_id", "=", input.runId)
      .forShare().executeTakeFirst();
    if (
      run === undefined
      || run.conversation_id !== input.conversationId
      || run.request_id !== input.requestId
      || run.trace_id !== input.traceId
      || run.client_request_id !== input.clientRequestId
      || (run.status !== "queued" && run.status !== "running")
    ) invalidIssuance();
    const snapshot = await dependencies.entitlementSnapshotAuthority.loadCurrentSnapshot({
      trx, tenantId: input.tenantId, profileId: input.profileId, membershipId: input.membershipId,
      actorId: actor.actor_id, now,
    });
    if (snapshot.current !== true) invalidIssuance();
    const capabilityIds = sortedUniqueIds(snapshot.capabilityIds);
    const trustedPayload: TrustedRequestContext = {
      schema_version: 1,
      tenant_mode: tenant.tenant_mode,
      tenant_id: input.tenantId,
      actor_id: actor.actor_id,
      original_actor_id: actor.actor_id,
      membership_id: input.membershipId,
      effective_role: input.effectiveRole,
      profile_id: input.profileId,
      entitlement_snapshot_ref: { ...snapshot.snapshotRef },
      capability_ids: [...capabilityIds],
      container_id: input.containerId,
      conversation_id: input.conversationId,
      run_id: input.runId,
      request_id: input.requestId,
      trace_id: input.traceId,
      client_request_id: input.clientRequestId,
      context_id: input.contextId,
      issuer: dependencies.issuer,
      audience: [...audience],
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
      key_id: dependencies.signingKey.keyId,
    };
    if (!payloadValidator.Check(trustedPayload)) invalidIssuance();
    return trustedPayload;
  }, { isolationLevel: "serializable" });

  const payloadBytes = canonicalPayloadBytes(payload);
  try {
    const envelope: SignedTrustedRequestContext = {
      schema_version: 1,
      algorithm: "EdDSA",
      key_id: dependencies.signingKey.keyId,
      payload,
      signature: signPayload(null, payloadBytes, dependencies.signingKey.privateKey).toString("base64url"),
    };
    deepFreeze(envelope);
    return envelope;
  } finally {
    payloadBytes.fill(0);
  }
}

export function resolveTrustedContextPublicKey(input: ResolveTrustedContextPublicKeyInput): KeyObject {
  const now = validDate(input.now);
  const issuedAt = validDate(input.issuedAt);
  const skew = clockSkew(input.clockSkewMs);
  if (typeof input.keyId !== "string" || input.keyId.length < 1 || input.keyId.length > 255 || !Array.isArray(input.keys)) {
    invalidContext();
  }
  const matches = input.keys.filter((candidate) => candidate.keyId === input.keyId);
  if (matches.length !== 1) invalidContext();
  const key = matches[0]!;
  if (key.status === "disabled" || key.publicKey.type !== "public" || key.publicKey.asymmetricKeyType !== "ed25519") {
    invalidContext();
  }
  const activatedAt = parseDate(key.activatedAt);
  if (issuedAt < activatedAt) invalidContext();
  if (key.status === "retired") {
    if (key.retiredAt === undefined) invalidContext();
    const retiredAt = parseDate(key.retiredAt);
    if (issuedAt >= retiredAt || now >= retiredAt + maximumContextTtlMs + skew) invalidContext();
  } else if (key.retiredAt !== undefined) {
    invalidContext();
  }
  return key.publicKey;
}

export function verifyTrustedContextSignature(
  input: VerifyTrustedContextSignatureInput,
): SignedTrustedRequestContext {
  let canonicalEnvelope: string;
  try {
    canonicalEnvelope = canonicalJson(input.envelope);
  } catch {
    invalidContext();
  }
  if (Buffer.byteLength(canonicalEnvelope!, "utf8") > maximumEnvelopeBytes) invalidContext();
  if (!envelopeValidator.Check(input.envelope)) invalidContext();
  const envelope = input.envelope as SignedTrustedRequestContext;
  const payloadBytes = canonicalPayloadBytes(envelope.payload);
  let signature: Buffer | undefined;
  try {
    signature = canonicalBase64UrlBytes(envelope.signature, 64);
    const issuedAtForKey = new Date(typeof envelope.payload?.issued_at === "string" ? envelope.payload.issued_at : Number.NaN);
    const publicKey = resolveTrustedContextPublicKey({
      keyId: envelope.key_id,
      keys: input.keys,
      issuedAt: issuedAtForKey,
      now: input.now,
      ...(input.clockSkewMs === undefined ? {} : { clockSkewMs: input.clockSkewMs }),
    });
    if (!verifySignature(null, payloadBytes, publicKey, signature)) invalidContext();
  } finally {
    payloadBytes.fill(0);
    signature?.fill(0);
  }

  if (validateSignedContextEnvelope(envelope).length > 0) invalidContext();
  const now = validDate(input.now);
  const issuedAt = parseDate(envelope.payload.issued_at);
  const expiresAt = parseDate(envelope.payload.expires_at);
  if (
    envelope.payload.issuer !== input.expectedIssuer
    || !envelope.payload.audience.includes(input.expectedAudience)
    || now < issuedAt
    || now >= expiresAt
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > maximumContextTtlMs
  ) invalidContext();
  deepFreeze(envelope);
  return envelope;
}

export function encodeSignedTrustedContext(envelope: SignedTrustedRequestContext): string {
  canonicalPayloadBytes(envelope.payload).fill(0);
  const bytes = Buffer.from(canonicalJson(envelope), "utf8");
  try {
    if (bytes.byteLength > maximumEnvelopeBytes) invalidTransport();
    return bytes.toString("base64url");
  } finally {
    bytes.fill(0);
  }
}

export function decodeSignedTrustedContext(encoded: unknown): unknown {
  if (typeof encoded !== "string" || encoded.length < 1 || !canonicalBase64UrlPattern.test(encoded)) invalidTransport();
  const bytes = Buffer.from(encoded, "base64url");
  try {
    if (bytes.byteLength > maximumEnvelopeBytes || bytes.toString("base64url") !== encoded) invalidTransport();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      invalidTransport();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text!);
    } catch {
      invalidTransport();
    }
    if (canonicalJson(parsed) !== text) invalidTransport();
    const payload = typeof parsed === "object" && parsed !== null
      ? Object.getOwnPropertyDescriptor(parsed, "payload")
      : undefined;
    if (payload === undefined || !("value" in payload)) invalidTransport();
    canonicalPayloadBytes(payload.value).fill(0);
    return parsed;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    invalidTransport();
  } finally {
    bytes.fill(0);
  }
}
