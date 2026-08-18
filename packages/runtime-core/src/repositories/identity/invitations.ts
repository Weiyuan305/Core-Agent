import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

export type InvitationRandomBytes = (size: number) => Buffer;

export interface StoredInvitationCredential {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly invitedByActorId: string;
  readonly role: "admin" | "consultant";
  readonly normalizedEmailHmac: Buffer;
  readonly status: "pending" | "accepted" | "revoked" | "expired" | "replaced";
  readonly expiresAt: Date;
  readonly acceptedActorId: string | null;
  readonly resourceVersion: number;
}

const invitationSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

export function issueInvitationSecret(randomBytes: InvitationRandomBytes = nodeRandomBytes): {
  readonly secret: string;
  readonly digest: Buffer;
} {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new DomainError("INTERNAL_ERROR", "Invitation entropy failed");
  }
  return Object.freeze({
    secret: bytes.toString("base64url"),
    digest: createHash("sha256").update(bytes).digest(),
  });
}

export function invitationEmailHmac(key: Uint8Array, normalizedEmail: string): Buffer {
  if (key.byteLength < 32) throw new DomainError("INTERNAL_ERROR", "Invitation email protection is invalid");
  if (
    normalizedEmail.length < 3
    || normalizedEmail.length > 320
    || normalizedEmail !== normalizedEmail.trim().toLowerCase()
    || !normalizedEmail.includes("@")
  ) throw new DomainError("INVALID_REQUEST", "Normalized invitation email is invalid");
  return createHmac("sha256", key).update(normalizedEmail, "utf8").digest();
}

function invitationNotFound(): never {
  throw new DomainError("RESOURCE_NOT_FOUND", "Invitation was not found");
}

function safeVersion(value: string): number {
  if (!/^\d+$/u.test(value)) throw new DomainError("INTERNAL_ERROR", "Stored invitation version is invalid");
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored invitation version is invalid");
  }
  return version;
}

function credentialDigest(secret: string): { digest: Buffer; wellFormed: boolean } {
  const wellFormed = secret.length <= 128 && invitationSecretPattern.test(secret);
  let bytes: Buffer;
  try {
    bytes = wellFormed ? Buffer.from(secret, "base64url") : Buffer.from(secret.slice(0, 128), "utf8");
  } catch {
    bytes = Buffer.alloc(0);
  }
  return {
    digest: createHash("sha256").update(bytes).digest(),
    wellFormed: wellFormed && bytes.length === 32,
  };
}

async function invitationBySecret(
  trx: Transaction<RuntimeDatabase>,
  secret: string,
  lock: boolean,
): Promise<StoredInvitationCredential> {
  if (typeof secret !== "string") invitationNotFound();
  const candidate = credentialDigest(secret);
  let query = trx.selectFrom("identity_invitations")
    .select([
      "invitation_id", "tenant_id", "membership_id", "invited_by_actor_id", "role",
      "secret_digest", "normalized_email_hmac", "status", "expires_at",
      "accepted_actor_id", "resource_version",
    ])
    .where("secret_digest", "=", candidate.digest);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  const comparedDigest = row === undefined ? Buffer.alloc(32) : Buffer.from(row.secret_digest);
  const matches = timingSafeEqual(candidate.digest, comparedDigest);
  if (!candidate.wellFormed || !matches || row === undefined) invitationNotFound();
  return {
    invitationId: row.invitation_id,
    tenantId: row.tenant_id,
    membershipId: row.membership_id,
    invitedByActorId: row.invited_by_actor_id,
    role: row.role,
    normalizedEmailHmac: Buffer.from(row.normalized_email_hmac),
    status: row.status,
    expiresAt: row.expires_at,
    acceptedActorId: row.accepted_actor_id,
    resourceVersion: safeVersion(row.resource_version),
  };
}

export async function lockInvitationByDigest(
  trx: Transaction<RuntimeDatabase>, digest: Uint8Array,
): Promise<StoredInvitationCredential> {
  const candidate = Buffer.from(digest);
  const wellFormed = candidate.byteLength === 32;
  const lookup = wellFormed ? candidate : createHash("sha256").update(candidate).digest();
  const row = await trx.selectFrom("identity_invitations")
    .select([
      "invitation_id", "tenant_id", "membership_id", "invited_by_actor_id", "role",
      "secret_digest", "normalized_email_hmac", "status", "expires_at",
      "accepted_actor_id", "resource_version",
    ])
    .where("secret_digest", "=", lookup)
    .forUpdate()
    .executeTakeFirst();
  const stored = row === undefined ? Buffer.alloc(32) : Buffer.from(row.secret_digest);
  const matches = timingSafeEqual(lookup, stored);
  if (!wellFormed || !matches || row === undefined) invitationNotFound();
  return {
    invitationId: row.invitation_id,
    tenantId: row.tenant_id,
    membershipId: row.membership_id,
    invitedByActorId: row.invited_by_actor_id,
    role: row.role,
    normalizedEmailHmac: Buffer.from(row.normalized_email_hmac),
    status: row.status,
    expiresAt: row.expires_at,
    acceptedActorId: row.accepted_actor_id,
    resourceVersion: safeVersion(row.resource_version),
  };
}

export async function lockInvitationBySecret(
  trx: Transaction<RuntimeDatabase>, secret: string,
): Promise<StoredInvitationCredential> {
  return invitationBySecret(trx, secret, true);
}

export async function readInvitationBySecret(
  trx: Transaction<RuntimeDatabase>, secret: string,
): Promise<StoredInvitationCredential> {
  return invitationBySecret(trx, secret, false);
}

export function constantTimeDigestMatches(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== 32 || rightBuffer.length !== 32) {
    timingSafeEqual(createHash("sha256").update(leftBuffer).digest(), createHash("sha256").update(rightBuffer).digest());
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function publicInvitationNotFound(): never {
  return invitationNotFound();
}

export function deriveIdentityCommandId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}
