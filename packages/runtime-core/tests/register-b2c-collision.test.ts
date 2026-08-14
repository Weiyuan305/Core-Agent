import assert from "node:assert/strict";
import test from "node:test";

import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../src/db/database.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";
import {
  registerB2c,
  type RegisterB2cCommand,
  type RegisterB2cDependencies,
} from "../src/services/identity/register-b2c.js";

function command(): RegisterB2cCommand {
  const withoutHash = {
    schema_version: 1 as const,
    idempotency_key: "collision-probe",
    auth_subject: {
      provider: "supabase" as const,
      providerSubject: "collision-probe-subject",
      identityKind: "email_password" as const,
      normalizedEmail: "collision-probe@example.test",
      verifiedAt: "2026-08-14T01:00:00.000Z",
    },
    display_name: "Collision Probe",
  };
  return { ...withoutHash, payload_hash: canonicalPayloadHash(withoutHash) };
}

function dependencies(transactionError: unknown): RegisterB2cDependencies {
  const transaction = {
    setIsolationLevel(value: string) {
      assert.equal(value, "serializable");
      return this;
    },
    async execute() {
      throw transactionError;
    },
  };
  const db = {
    transaction() {
      return transaction;
    },
  } as unknown as Kysely<RuntimeDatabase>;
  return {
    db,
    defaultProfile: { providerConfigId: "unused", modelId: "unused" },
    privatePii: {
      normalizedEmailHmacKey: Buffer.alloc(32),
      encryptionKeyRef: "unused",
      async encryptNormalizedEmail() {
        throw new Error("unused");
      },
    },
  };
}

const context = Object.freeze({ requestId: "collision-probe-request", traceId: "collision-probe-trace" });

test("registerB2c collision classification never invokes accessor-bearing error fields", async () => {
  let codeReads = 0;
  let constraintReads = 0;
  const original = new Error("opaque transaction failure");
  Object.defineProperties(original, {
    code: {
      configurable: true,
      get() {
        codeReads += 1;
        return "23505";
      },
    },
    constraint: {
      configurable: true,
      get() {
        constraintReads += 1;
        return "auth_subjects_provider_provider_subject_key";
      },
    },
  });

  await assert.rejects(
    registerB2c(dependencies(original), context, command()),
    (error: unknown) => error === original,
  );
  assert.equal(codeReads, 0);
  assert.equal(constraintReads, 0);
});

test("registerB2c maps only own-data exact identity collision constraints", async () => {
  for (const constraint of [
    "auth_subjects_provider_provider_subject_key",
    "private_identity_pii_normalized_email_hmac_key",
  ]) {
    const databaseError = Object.assign(new Error("opaque transaction failure"), {
      code: "23505",
      constraint,
    });

    await assert.rejects(
      registerB2c(dependencies(databaseError), context, command()),
      (error: unknown) => error instanceof DomainError
        && error.code === "IDEMPOTENCY_CONFLICT"
        && error.message === "IDEMPOTENCY_CONFLICT: Identity registration conflicts with existing authority"
        && !Object.prototype.hasOwnProperty.call(error, "cause"),
    );
  }
});
