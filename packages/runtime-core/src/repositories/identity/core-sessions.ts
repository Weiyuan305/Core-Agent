import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { CoreSession } from "@core-agent/contracts";
import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

export type CoreSessionRandomBytes = (size: number) => Buffer;
export type CoreSessionRevocationReason = NonNullable<CoreSession["revocation_reason_code"]>;

export interface IssuedOpaqueCredential {
  readonly secret: string;
  readonly digest: Buffer;
}

export interface StoredCoreSessionAuthority {
  readonly session: CoreSession;
  readonly secretDigest: Buffer;
  readonly csrfDigest: Buffer | null;
}

const opaqueSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

function invalidSession(): never {
  throw new DomainError("UNAUTHENTICATED", "Core Session is invalid");
}

function safeVersion(value: string): number {
  if (!/^\d+$/u.test(value)) throw new DomainError("INTERNAL_ERROR", "Stored Core Session version is invalid");
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored Core Session version is invalid");
  }
  return version;
}

export function issueOpaqueCoreSessionCredential(
  randomBytes: CoreSessionRandomBytes = nodeRandomBytes,
): IssuedOpaqueCredential {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
    throw new DomainError("INTERNAL_ERROR", "Core Session entropy failed");
  }
  try {
    return Object.freeze({
      secret: bytes.toString("base64url"),
      digest: createHash("sha256").update(bytes).digest(),
    });
  } finally {
    bytes.fill(0);
  }
}

interface CredentialCandidate {
  readonly digest: Buffer;
  readonly wellFormed: boolean;
  clear(): void;
}

function credentialCandidate(secret: unknown): CredentialCandidate {
  const wellFormed = typeof secret === "string" && opaqueSecretPattern.test(secret);
  const bytes = wellFormed ? Buffer.from(secret, "base64url") : Buffer.alloc(32);
  const validLength = bytes.length === 32;
  const fixedBytes = validLength ? bytes : Buffer.alloc(32);
  const digest = createHash("sha256").update(fixedBytes).digest();
  if (fixedBytes !== bytes) fixedBytes.fill(0);
  return {
    digest,
    wellFormed: wellFormed && validLength,
    clear() {
      bytes.fill(0);
      digest.fill(0);
    },
  };
}

function constantTimeDigestMatch(candidate: Buffer, stored: Uint8Array | null): boolean {
  const storedDigest = stored === null ? Buffer.alloc(32) : Buffer.from(stored);
  try {
    if (candidate.length !== 32 || storedDigest.length !== 32) {
      const safeCandidate = createHash("sha256").update(candidate).digest();
      const safeStored = createHash("sha256").update(storedDigest).digest();
      try {
        timingSafeEqual(safeCandidate, safeStored);
      } finally {
        safeCandidate.fill(0);
        safeStored.fill(0);
      }
      return false;
    }
    return timingSafeEqual(candidate, storedDigest);
  } finally {
    storedDigest.fill(0);
  }
}

function rowToStoredCoreSession(row: {
  session_id: string;
  secret_digest: Buffer;
  csrf_digest: Buffer | null;
  actor_id: string;
  auth_subject_id: string;
  client_kind: "web" | "iphone" | "macos";
  status: "active" | "revoked" | "expired";
  device_label: string | null;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  reauthenticated_at: Date | null;
  revocation_reason: string | null;
  resource_version: string;
  updated_at: Date;
}): StoredCoreSessionAuthority {
  const session: CoreSession = {
    schema_version: 1,
    resource_version: safeVersion(row.resource_version),
    session_id: row.session_id,
    actor_id: row.actor_id,
    auth_subject_id: row.auth_subject_id,
    client_kind: row.client_kind,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    idle_expires_at: row.idle_expires_at.toISOString(),
    absolute_expires_at: row.absolute_expires_at.toISOString(),
    status: row.status,
    ...(row.device_label === null ? {} : { device_label: row.device_label }),
    ...(row.reauthenticated_at === null ? {} : { reauthenticated_at: row.reauthenticated_at.toISOString() }),
    ...(row.revocation_reason === null ? {} : {
      revocation_reason_code: row.revocation_reason as CoreSessionRevocationReason,
    }),
  };
  return Object.freeze({
    session: Object.freeze(session),
    secretDigest: Buffer.from(row.secret_digest),
    csrfDigest: row.csrf_digest === null ? null : Buffer.from(row.csrf_digest),
  });
}

const sessionColumns = [
  "session_id", "secret_digest", "csrf_digest", "actor_id", "auth_subject_id", "client_kind",
  "status", "device_label", "created_at", "last_seen_at", "idle_expires_at", "absolute_expires_at",
  "reauthenticated_at", "revocation_reason", "resource_version", "updated_at",
] as const;

export async function insertCoreSession(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly sessionId: string;
    readonly secretDigest: Uint8Array;
    readonly csrfDigest: Uint8Array | null;
    readonly actorId: string;
    readonly authSubjectId: string;
    readonly clientKind: "web" | "iphone" | "macos";
    readonly deviceLabel: string | null;
    readonly now: Date;
    readonly idleExpiresAt: Date;
    readonly absoluteExpiresAt: Date;
  },
): Promise<StoredCoreSessionAuthority> {
  const row = await trx.insertInto("core_sessions").values({
    session_id: input.sessionId,
    secret_digest: input.secretDigest,
    csrf_digest: input.csrfDigest,
    actor_id: input.actorId,
    auth_subject_id: input.authSubjectId,
    client_kind: input.clientKind,
    status: "active",
    device_label: input.deviceLabel,
    created_at: input.now,
    last_seen_at: input.now,
    idle_expires_at: input.idleExpiresAt,
    absolute_expires_at: input.absoluteExpiresAt,
    reauthenticated_at: null,
    revocation_reason: null,
    resource_version: 1,
    updated_at: input.now,
  }).returning(sessionColumns).executeTakeFirstOrThrow();
  return rowToStoredCoreSession(row);
}

export async function discoverCoreSessionBySecret(
  trx: Transaction<RuntimeDatabase>,
  sessionSecret: unknown,
): Promise<{ readonly sessionId: string; readonly actorId: string }> {
  const candidate = credentialCandidate(sessionSecret);
  try {
    const row = await trx.selectFrom("core_sessions")
      .select(["session_id", "actor_id", "secret_digest"])
      .where("secret_digest", "=", candidate.digest)
      .executeTakeFirst();
    const matches = constantTimeDigestMatch(candidate.digest, row?.secret_digest ?? null);
    if (!candidate.wellFormed || !matches || row === undefined) invalidSession();
    return Object.freeze({ sessionId: row.session_id, actorId: row.actor_id });
  } finally {
    candidate.clear();
  }
}

export async function lockCoreSessionCredential(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly sessionId: string;
    readonly actorId: string;
    readonly sessionSecret: unknown;
    readonly csrfSecret?: unknown;
    readonly requireCsrf?: boolean;
  },
): Promise<StoredCoreSessionAuthority> {
  const sessionCandidate = credentialCandidate(input.sessionSecret);
  const csrfCandidate = credentialCandidate(input.csrfSecret);
  try {
    const row = await trx.selectFrom("core_sessions").select(sessionColumns)
      .where("session_id", "=", input.sessionId)
      .where("actor_id", "=", input.actorId)
      .forUpdate()
      .executeTakeFirst();
    const sessionMatches = constantTimeDigestMatch(sessionCandidate.digest, row?.secret_digest ?? null);
    const csrfMatches = input.requireCsrf !== true
      || constantTimeDigestMatch(csrfCandidate.digest, row?.csrf_digest ?? null);
    if (
      !sessionCandidate.wellFormed
      || !sessionMatches
      || (input.requireCsrf === true && (!csrfCandidate.wellFormed || !csrfMatches))
      || row === undefined
    ) invalidSession();
    return rowToStoredCoreSession(row);
  } finally {
    sessionCandidate.clear();
    csrfCandidate.clear();
  }
}

export async function updateCoreSessionActivity(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly sessionId: string;
    readonly now: Date;
    readonly idleExpiresAt: Date;
    readonly expectedResourceVersion: number;
  },
): Promise<StoredCoreSessionAuthority> {
  const row = await trx.updateTable("core_sessions").set({
    last_seen_at: input.now,
    idle_expires_at: input.idleExpiresAt,
    resource_version: input.expectedResourceVersion + 1,
    updated_at: input.now,
  }).where("session_id", "=", input.sessionId)
    .where("status", "=", "active")
    .where("resource_version", "=", input.expectedResourceVersion.toString())
    .returning(sessionColumns)
    .executeTakeFirst();
  if (row === undefined) invalidSession();
  return rowToStoredCoreSession(row);
}

export async function expireCoreSession(
  trx: Transaction<RuntimeDatabase>,
  sessionId: string,
  now: Date,
  expectedResourceVersion: number,
): Promise<void> {
  await trx.updateTable("core_sessions").set({
    status: "expired",
    resource_version: expectedResourceVersion + 1,
    updated_at: now,
  }).where("session_id", "=", sessionId)
    .where("status", "=", "active")
    .where("resource_version", "=", expectedResourceVersion.toString())
    .executeTakeFirst();
}

export async function lockCoreSessionById(
  trx: Transaction<RuntimeDatabase>,
  actorId: string,
  sessionId: string,
): Promise<StoredCoreSessionAuthority | undefined> {
  const row = await trx.selectFrom("core_sessions").select(sessionColumns)
    .where("actor_id", "=", actorId)
    .where("session_id", "=", sessionId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : rowToStoredCoreSession(row);
}

export async function revokeLockedCoreSession(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly sessionId: string;
    readonly reason: CoreSessionRevocationReason;
    readonly now: Date;
    readonly expectedResourceVersion: number;
  },
): Promise<StoredCoreSessionAuthority> {
  const row = await trx.updateTable("core_sessions").set({
    status: "revoked",
    revocation_reason: input.reason,
    resource_version: input.expectedResourceVersion + 1,
    updated_at: input.now,
  }).where("session_id", "=", input.sessionId)
    .where("status", "!=", "revoked")
    .where("resource_version", "=", input.expectedResourceVersion.toString())
    .returning(sessionColumns)
    .executeTakeFirst();
  if (row === undefined) invalidSession();
  return rowToStoredCoreSession(row);
}

export async function revokeCoreSessionsByScope(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly actorId: string;
    readonly authSubjectId?: string;
    readonly reason: CoreSessionRevocationReason;
    readonly now: Date;
  },
): Promise<number> {
  let query = trx.updateTable("core_sessions").set({
    status: "revoked",
    revocation_reason: input.reason,
    resource_version: sql<string>`resource_version + 1`,
    updated_at: input.now,
  }).where("actor_id", "=", input.actorId)
    .where("status", "!=", "revoked");
  if (input.authSubjectId !== undefined) {
    query = query.where("auth_subject_id", "=", input.authSubjectId);
  }
  const result = await query.executeTakeFirst();
  const count = Number(result.numUpdatedRows);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new DomainError("INTERNAL_ERROR", "Core Session revocation count is invalid");
  }
  return count;
}

export function publicCoreSessionInvalid(): never {
  return invalidSession();
}
