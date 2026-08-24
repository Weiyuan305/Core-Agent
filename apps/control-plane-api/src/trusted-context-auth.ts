import { createPublicKey } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  validateEntitlementAwareTrustedRequestContext,
  type EntitlementSnapshotRef,
  type EntitlementAwareTrustedContextAuthority,
  type TrustedRequestContext,
} from "@core-agent/contracts";
import {
  canonicalJson,
  decodeSignedTrustedContext,
  DomainError,
  loadCurrentSnapshotAuthority,
  loadActorIdentityAuthority,
  verifyTrustedContextSignature,
  type RuntimeDatabase,
  type TrustedContextPublicKey,
} from "@core-agent/runtime-core";
import { sql, type Kysely, type Transaction } from "kysely";

export interface TrustedContextApiRequestContext {
  readonly authenticationKind: "trusted_context";
  readonly requestId: string;
  readonly traceId: string;
  readonly clientRequestId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly effectiveRole: "admin" | "consultant" | "student";
  readonly profileId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly contextId: string;
  readonly remainingLifetimeMs: number;
  readonly capabilityIds: readonly string[];
  readonly entitlementSnapshotRef: EntitlementSnapshotRef;
}

export interface AuthenticateTrustedContextDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly keys: readonly TrustedContextPublicKey[];
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly clockSkewMs?: number;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
  readonly loadCurrentAuthority?: (
    trx: Transaction<RuntimeDatabase>,
    context: TrustedRequestContext,
    now: Date,
  ) => Promise<EntitlementAwareTrustedContextAuthority>;
}

export interface TrustedContextRequestHeaders {
  readonly headers: unknown;
  readonly rawHeaders: unknown;
}

const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

function invalidRequest(): never {
  throw new DomainError("INVALID_REQUEST", "Trusted context request is invalid");
}

function unauthenticated(): never {
  throw new DomainError("UNAUTHENTICATED", "Trusted context authentication failed");
}

function ownHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers) || utilTypes.isProxy(headers)) {
    invalidRequest();
  }
  const descriptor = Object.getOwnPropertyDescriptor(headers, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") invalidRequest();
  return descriptor.value;
}

function validateRawHeaders(rawHeaders: unknown): void {
  if (
    !Array.isArray(rawHeaders)
    || utilTypes.isProxy(rawHeaders)
    || Object.getPrototypeOf(rawHeaders) !== Array.prototype
    || rawHeaders.length % 2 !== 0
  ) invalidRequest();
  let contextCount = 0;
  let prohibitedCount = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = Object.getOwnPropertyDescriptor(rawHeaders, String(index));
    const value = Object.getOwnPropertyDescriptor(rawHeaders, String(index + 1));
    if (
      name === undefined || value === undefined
      || !("value" in name) || !("value" in value)
      || !name.enumerable || !value.enumerable
      || typeof name.value !== "string" || typeof value.value !== "string"
      || !headerNamePattern.test(name.value) || /[\u0000\r\n]/u.test(value.value)
    ) invalidRequest();
    const lower = name.value.toLowerCase();
    if (lower === "x-core-agent-context") contextCount += 1;
    if (lower === "authorization" || lower === "x-core-agent-tenant-id") prohibitedCount += 1;
  }
  if (contextCount !== 1) unauthenticated();
  if (prohibitedCount !== 0) invalidRequest();
}

function validDatabaseNow(value: Date | undefined): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Trusted context database clock is invalid");
  }
  return new Date(value);
}

async function readDatabaseNow(
  dependencies: AuthenticateTrustedContextDependencies,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const value = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  return validDatabaseNow(value);
}

async function loadDatabaseAuthority(
  trx: Transaction<RuntimeDatabase>,
  context: TrustedRequestContext,
  now: Date,
): Promise<EntitlementAwareTrustedContextAuthority> {
  const actor = await loadActorIdentityAuthority(trx, context.actor_id);
  if (actor.actorStatus !== "active") unauthenticated();
  const membership = actor.memberships.find((candidate) => (
    candidate.membershipId === context.membership_id && candidate.tenantId === context.tenant_id
  ));
  if (membership === undefined || membership.tenantMode !== context.tenant_mode) unauthenticated();
  const tenant = await trx.selectFrom("tenants").select("status")
    .where("tenant_id", "=", context.tenant_id).executeTakeFirst();
  const profile = await trx.selectFrom("profiles").select(["tenant_id", "owner_actor_id", "status"])
    .where("tenant_id", "=", context.tenant_id).where("profile_id", "=", context.profile_id)
    .executeTakeFirst();
  const container = await trx.selectFrom("runtime_containers")
    .select(["desired_state", "observed_state", "health_status"])
    .where("tenant_id", "=", context.tenant_id).where("container_id", "=", context.container_id)
    .executeTakeFirst();
  if (
    tenant?.status !== "active"
    || profile === undefined
    || container?.desired_state !== "running"
    || container.observed_state !== "ready"
    || container.health_status !== "healthy"
  ) unauthenticated();
  const snapshot = await loadCurrentSnapshotAuthority({
    trx,
    tenantId: context.tenant_id,
    profileId: context.profile_id,
    now,
  });
  if (!snapshot.current) unauthenticated();
  return {
    expected_issuer: context.issuer,
    expected_audience: "control-plane-api",
    now: now.toISOString(),
    membership: {
      membership_id: membership.membershipId,
      tenant_id: membership.tenantId,
      actor_id: actor.actorId,
      roles: membership.roles,
      status: membership.status,
    },
    profile: {
      profile_id: context.profile_id,
      tenant_id: profile.tenant_id,
      owner_actor_id: profile.owner_actor_id,
      status: profile.status === "active" ? "active" : "suspended",
    },
    entitlement_snapshot: {
      tenant_id: context.tenant_id,
      profile_id: context.profile_id,
      snapshot_ref: snapshot.snapshotRef,
      capability_ids: snapshot.capabilityIds,
    },
  };
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export async function authenticateTrustedContextRequest(
  dependencies: AuthenticateTrustedContextDependencies,
  request: TrustedContextRequestHeaders,
): Promise<TrustedContextApiRequestContext> {
  validateRawHeaders(request.rawHeaders);
  const encoded = ownHeader(request.headers, "x-core-agent-context");
  if (encoded === undefined) unauthenticated();
  try {
    return await dependencies.db.transaction().execute(async (trx) => {
    const now = await readDatabaseNow(dependencies, trx);
    const envelope = verifyTrustedContextSignature({
      envelope: decodeSignedTrustedContext(encoded),
      keys: dependencies.keys,
      expectedIssuer: dependencies.expectedIssuer,
      expectedAudience: dependencies.expectedAudience,
      now,
      ...(dependencies.clockSkewMs === undefined ? {} : { clockSkewMs: dependencies.clockSkewMs }),
    });
    if (!sortedUnique(envelope.payload.capability_ids)) unauthenticated();
    const authority = dependencies.loadCurrentAuthority === undefined
      ? await loadDatabaseAuthority(trx, envelope.payload, now)
      : await dependencies.loadCurrentAuthority(trx, envelope.payload, now);
    if (
      authority.expected_issuer !== dependencies.expectedIssuer
      || authority.expected_audience !== dependencies.expectedAudience
      || validateEntitlementAwareTrustedRequestContext(envelope.payload, authority).length > 0
    ) unauthenticated();
    const result: TrustedContextApiRequestContext = {
      authenticationKind: "trusted_context",
      requestId: envelope.payload.request_id,
      traceId: envelope.payload.trace_id,
      clientRequestId: envelope.payload.client_request_id,
      tenantId: envelope.payload.tenant_id,
      actorId: envelope.payload.actor_id,
      membershipId: envelope.payload.membership_id,
      effectiveRole: envelope.payload.effective_role,
      profileId: envelope.payload.profile_id,
      conversationId: envelope.payload.conversation_id,
      runId: envelope.payload.run_id,
      contextId: envelope.payload.context_id,
      remainingLifetimeMs: Date.parse(envelope.payload.expires_at) - now.getTime(),
      capabilityIds: Object.freeze([...envelope.payload.capability_ids]),
      entitlementSnapshotRef: Object.freeze({ ...envelope.payload.entitlement_snapshot_ref }),
    };
      return Object.freeze(result);
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Trusted context authority is unavailable", true);
  }
}

function configurationError(): Error {
  return new Error("Trusted context public-key configuration is invalid");
}

function exactIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function loadTrustedContextPublicKeys(value: unknown): readonly TrustedContextPublicKey[] {
  try {
    canonicalJson(value);
  } catch {
    throw configurationError();
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw configurationError();
  const ids = new Set<string>();
  const keys = value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw configurationError();
    const record = entry as Record<string, unknown>;
    const expectedKeys = record.status === "retired" || record.retired_at !== undefined
      ? ["activated_at", "key_id", "public_key_spki_pem", "retired_at", "status"]
      : ["activated_at", "key_id", "public_key_spki_pem", "status"];
    if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) throw configurationError();
    if (
      typeof record.key_id !== "string" || record.key_id.length < 1 || record.key_id.length > 255
      || ids.has(record.key_id)
      || (record.status !== "active" && record.status !== "retired" && record.status !== "disabled")
      || !exactIsoTimestamp(record.activated_at)
      || typeof record.public_key_spki_pem !== "string"
      || record.public_key_spki_pem.length < 1 || record.public_key_spki_pem.length > 8_192
      || !record.public_key_spki_pem.startsWith("-----BEGIN PUBLIC KEY-----\n")
      || !record.public_key_spki_pem.endsWith("-----END PUBLIC KEY-----\n")
      || record.public_key_spki_pem.includes("PRIVATE KEY")
      || (record.retired_at !== undefined && !exactIsoTimestamp(record.retired_at))
      || (record.status === "retired" && !exactIsoTimestamp(record.retired_at))
      || (record.status === "active" && record.retired_at !== undefined)
    ) throw configurationError();
    ids.add(record.key_id);
    let publicKey;
    try {
      publicKey = createPublicKey({ key: record.public_key_spki_pem, format: "pem", type: "spki" });
    } catch {
      throw configurationError();
    }
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") throw configurationError();
    const key: TrustedContextPublicKey = {
      keyId: record.key_id,
      publicKey,
      status: record.status,
      activatedAt: record.activated_at,
      ...(record.retired_at === undefined ? {} : { retiredAt: record.retired_at as string }),
    };
    return Object.freeze(key);
  });
  return Object.freeze(keys);
}
