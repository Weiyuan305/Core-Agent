import { createHmac } from "node:crypto";

import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

export interface PrivateIdentityPiiProtection {
  readonly normalizedEmailHmacKey: Uint8Array;
  readonly encryptionKeyRef: string;
  readonly encryptNormalizedEmail: (normalizedEmail: string) => Promise<Uint8Array>;
}

interface PrivateIdentityPiiProjection {
  readonly normalizedEmailHmac: Uint8Array;
  readonly encryptedEmail: Uint8Array;
  readonly encryptionKeyRef: string;
}

function invalidPrivatePiiConfiguration(): never {
  throw new DomainError("INTERNAL_ERROR", "Private identity PII protection is invalid");
}

async function projectPrivateIdentityPii(
  protection: PrivateIdentityPiiProtection,
  normalizedEmail: string,
): Promise<PrivateIdentityPiiProjection> {
  if (protection.normalizedEmailHmacKey.byteLength < 32) invalidPrivatePiiConfiguration();
  if (protection.encryptionKeyRef.length < 1 || protection.encryptionKeyRef.length > 255) {
    invalidPrivatePiiConfiguration();
  }
  const encryptedEmail = new Uint8Array(await protection.encryptNormalizedEmail(normalizedEmail));
  if (
    encryptedEmail.byteLength < 1
    || Buffer.from(encryptedEmail).equals(Buffer.from(normalizedEmail, "utf8"))
  ) invalidPrivatePiiConfiguration();
  return {
    normalizedEmailHmac: createHmac("sha256", protection.normalizedEmailHmacKey)
      .update(normalizedEmail, "utf8")
      .digest(),
    encryptedEmail,
    encryptionKeyRef: protection.encryptionKeyRef,
  };
}

export async function insertPrivateIdentityPii(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly actorId: string;
    readonly normalizedEmail: string;
    readonly protection: PrivateIdentityPiiProtection;
    readonly now: Date;
  },
): Promise<void> {
  const projection = await projectPrivateIdentityPii(input.protection, input.normalizedEmail);
  await trx.insertInto("private_identity_pii").values({
    actor_id: input.actorId,
    normalized_email_hmac: projection.normalizedEmailHmac,
    encrypted_email: projection.encryptedEmail,
    encryption_key_ref: projection.encryptionKeyRef,
    created_at: input.now,
    updated_at: input.now,
  }).execute();
}
