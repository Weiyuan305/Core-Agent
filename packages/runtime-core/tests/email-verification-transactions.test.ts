import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations, createRuntimeDatabase } from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("email verification PostgreSQL tests require a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const now = new Date("2026-08-18T00:00:00.000Z");
const hmacKey = Buffer.alloc(32, 0x41);

const protector = {
  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    return Uint8Array.from(Buffer.concat([
      createHash("sha256").update(plaintext).digest(),
      Uint8Array.from([...plaintext].reverse(), (byte) => byte ^ 0x5a),
    ]));
  },
  async decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    const plaintext = Uint8Array.from([...ciphertext.slice(32)].map((byte) => byte ^ 0x5a).reverse());
    assert.deepEqual(ciphertext.slice(0, 32), createHash("sha256").update(plaintext).digest());
    return plaintext;
  },
};

test.beforeEach(async () => {
  await pool.query("drop schema public cascade; create schema public");
  await applyMigrations(pool, migrations);
});

test.after(async () => {
  await db.destroy();
});

test("durable email verification converges starts across restart and consumes exactly once", async () => {
  const module = await import("../src/index.js") as Record<string, unknown>;
  assert.equal(typeof module.beginEmailVerificationTransaction, "function");
  assert.equal(typeof module.consumeEmailVerificationTransaction, "function");
  const begin = module.beginEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<{ kind: string; verificationId: string; expiresAt: string }>;
  const consume = module.consumeEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<{ clientKind: string; deviceLabel?: string }>;
  let randomCalls = 0;
  const dependencies = {
    db,
    hmacKey,
    protector,
    ttlMs: 10 * 60 * 1_000,
    databaseNow: async () => new Date(now),
    randomBytes: (length: number) => {
      randomCalls += 1;
      return Uint8Array.from({ length }, (_, index) => index + randomCalls);
    },
  };
  const input = {
    idempotencyKey: "signup_idem_01",
    payloadHash: `sha256:${"a".repeat(64)}`,
    normalizedEmail: "student@example.test",
    clientKind: "web",
    deviceLabel: "Browser",
  };
  const first = await begin(dependencies, input);
  assert.deepEqual(first, {
    kind: "created",
    verificationId: first.verificationId,
    expiresAt: "2026-08-18T00:10:00.000Z",
  });
  const restartedDependencies = { ...dependencies, randomBytes: () => { throw new Error("replay must not draw randomness"); } };
  assert.deepEqual(await begin(restartedDependencies, input), { ...first, kind: "replay" });
  assert.equal(randomCalls, 1);
  await assert.rejects(
    begin(dependencies, { ...input, payloadHash: `sha256:${"b".repeat(64)}` }),
    (error: unknown) => (error as { code?: unknown }).code === "IDEMPOTENCY_CONFLICT",
  );

  const stored = (await pool.query<{
    binding: string; email: string; status: string; provider: string | null;
  }>(`select encode(binding_ciphertext, 'hex') as binding,
             encode(normalized_email_hmac, 'hex') as email,
             status, encode(verified_provider_subject_hmac, 'hex') as provider
      from email_verification_transactions`)).rows[0]!;
  assert.equal(stored.status, "pending");
  assert.equal(stored.provider, null);
  assert.equal(JSON.stringify(stored).includes("student@example.test"), false);
  assert.equal(JSON.stringify(stored).includes("Browser"), false);

  const verifiedSubject = {
    provider: "supabase",
    providerSubject: "provider_subject_01",
    identityKind: "email_password",
    normalizedEmail: "student@example.test",
    verifiedAt: "2026-08-18T00:00:00.000Z",
  };
  const outcomes = await Promise.allSettled([
    consume(dependencies, { verificationId: first.verificationId, verifiedSubject }),
    consume(dependencies, { verificationId: first.verificationId, verifiedSubject }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  const accepted = outcomes.find((outcome): outcome is PromiseFulfilledResult<{ clientKind: string; deviceLabel?: string }> => outcome.status === "fulfilled")!;
  assert.deepEqual(accepted.value, { clientKind: "web", deviceLabel: "Browser", normalizedEmail: "student@example.test" });
  const consumed = (await pool.query<{ status: string; consumed_at: Date | null; provider_hmac_bytes: number }>(
    `select status, consumed_at, octet_length(verified_provider_subject_hmac)::int as provider_hmac_bytes
     from email_verification_transactions`,
  )).rows[0]!;
  assert.equal(consumed.status, "consumed");
  assert.equal(consumed.consumed_at?.toISOString(), now.toISOString());
  assert.equal(consumed.provider_hmac_bytes, 32);
});
