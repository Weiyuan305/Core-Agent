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
  clear(): void;
}

export interface StoredCoreSessionAuthority {
  readonly session: CoreSession;
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
  let temporaryDigest: Buffer | undefined;
  try {
    const secret = bytes.toString("base64url");
    temporaryDigest = createHash("sha256").update(bytes).digest();
    temporaryDigest.copy(bytes);
    return Object.freeze({
      secret,
      digest: bytes,
      clear() {
        bytes.fill(0);
      },
    });
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    temporaryDigest?.fill(0);
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
  const canonical = wellFormed && validLength && bytes.toString("base64url") === secret;
  const fixedBytes = validLength ? bytes : Buffer.alloc(32);
  let digest: Buffer | undefined;
  try {
    digest = createHash("sha256").update(fixedBytes).digest();
    const ownedDigest = digest;
    return {
      digest: ownedDigest,
      wellFormed: canonical,
      clear() {
        bytes.fill(0);
        ownedDigest.fill(0);
      },
    };
  } catch (error) {
    bytes.fill(0);
    digest?.fill(0);
    throw error;
  } finally {
    if (fixedBytes !== bytes) fixedBytes.fill(0);
  }
}

function constantTimeOwnedDigestMatch(candidate: Buffer, stored: Buffer): boolean {
  try {
    if (candidate.length !== 32 || stored.length !== 32) {
      let safeCandidate: Buffer | undefined;
      let safeStored: Buffer | undefined;
      try {
        safeCandidate = createHash("sha256").update(candidate).digest();
        safeStored = createHash("sha256").update(stored).digest();
        timingSafeEqual(safeCandidate, safeStored);
      } finally {
        safeCandidate?.fill(0);
        safeStored?.fill(0);
      }
      return false;
    }
    return timingSafeEqual(candidate, stored);
  } finally {
    candidate.fill(0);
    stored.fill(0);
  }
}

export const coreSessionSecretTestInternals = Object.freeze({
  constantTimeOwnedDigestMatch,
});

function queryResultDigest(digest: Uint8Array | null | undefined): Buffer {
  if (Buffer.isBuffer(digest)) return digest;
  return digest === null || digest === undefined ? Buffer.alloc(32) : Buffer.from(digest);
}

function rowToCoreSessionAuthority(row: {
  session_id: string;
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
  });
}

const sessionColumns = [
  "session_id", "actor_id", "auth_subject_id", "client_kind",
  "status", "device_label", "created_at", "last_seen_at", "idle_expires_at", "absolute_expires_at",
  "reauthenticated_at", "revocation_reason", "resource_version", "updated_at",
] as const;

const sessionCredentialColumns = [...sessionColumns, "secret_digest", "csrf_digest"] as const;
const sessionSecretColumns = [...sessionColumns, "secret_digest"] as const;

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
  return rowToCoreSessionAuthority(row);
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
    const matches = constantTimeOwnedDigestMatch(candidate.digest, queryResultDigest(row?.secret_digest));
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
  let csrfCandidate: CredentialCandidate | undefined;
  try {
    csrfCandidate = input.requireCsrf === true ? credentialCandidate(input.csrfSecret) : undefined;
    const columns = input.requireCsrf === true ? sessionCredentialColumns : sessionSecretColumns;
    const row = await trx.selectFrom("core_sessions").select(columns)
      .where("session_id", "=", input.sessionId)
      .where("actor_id", "=", input.actorId)
      .forUpdate()
      .executeTakeFirst();
    const sessionMatches = constantTimeOwnedDigestMatch(
      sessionCandidate.digest,
      queryResultDigest(row?.secret_digest),
    );
    const csrfMatches = input.requireCsrf !== true
      || constantTimeOwnedDigestMatch(
        csrfCandidate!.digest,
        queryResultDigest("csrf_digest" in (row ?? {}) ? row?.csrf_digest : undefined),
      );
    if (
      !sessionCandidate.wellFormed
      || !sessionMatches
      || (input.requireCsrf === true && (!csrfCandidate!.wellFormed || !csrfMatches))
      || row === undefined
    ) invalidSession();
    return rowToCoreSessionAuthority(row);
  } finally {
    sessionCandidate.clear();
    csrfCandidate?.clear();
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
  return rowToCoreSessionAuthority(row);
}

export async function updateCoreSessionReauthentication(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly sessionId: string;
    readonly now: Date;
    readonly expectedResourceVersion: number;
  },
): Promise<StoredCoreSessionAuthority> {
  const row = await trx.updateTable("core_sessions").set({
    reauthenticated_at: input.now,
    resource_version: input.expectedResourceVersion + 1,
    updated_at: input.now,
  }).where("session_id", "=", input.sessionId)
    .where("status", "=", "active")
    .where("resource_version", "=", input.expectedResourceVersion.toString())
    .returning(sessionColumns)
    .executeTakeFirst();
  if (row === undefined) invalidSession();
  return rowToCoreSessionAuthority(row);
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
  return row === undefined ? undefined : rowToCoreSessionAuthority(row);
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
  return rowToCoreSessionAuthority(row);
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
