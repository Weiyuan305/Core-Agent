import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations, canonicalPayloadHash, createRuntimeDatabase } from "../src/index.js";

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
  const finalize = module.finalizeEmailVerificationTransactionStart as (dependencies: unknown, input: unknown) => Promise<void>;
  const prepare = module.prepareEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<{ clientKind: string; deviceLabel?: string; flowKind: string; invitationId?: string; providerVerification: unknown }>;
  const admit = module.admitEmailVerificationProviderAttempt as (dependencies: unknown, input: unknown) => Promise<{ kind: string }>;
  const checkpoint = module.checkpointEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<void>;
  const consume = module.consumeEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<{ clientKind: string; deviceLabel?: string; verifiedSubject: unknown }>;
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
    payloadHash: canonicalPayloadHash({
      schema_version: 1, flow_kind: "b2c", idempotency_key: "signup_idem_01",
      normalized_email: "student@example.test", client_kind: "web", device_label: "Browser",
    }),
    normalizedEmail: "student@example.test",
    clientKind: "web",
    deviceLabel: "Browser",
    flow: { kind: "b2c" },
  };
  const first = await begin(dependencies, input);
  assert.deepEqual(first, {
    kind: "reserved",
    verificationId: first.verificationId,
    expiresAt: "2026-08-18T00:10:00.000Z",
  });
  const restartedDependencies = { ...dependencies, randomBytes: (length: number) => Buffer.alloc(length, 0x7e) };
  assert.deepEqual(await begin(restartedDependencies, input), { ...first, kind: "in_progress" });
  await assert.rejects(begin(restartedDependencies, {
    ...input,
    normalizedEmail: "changed@example.test",
  }), (error: unknown) => (error as { code?: unknown }).code === "INVALID_REQUEST");
  await finalize(dependencies, {
    verificationId: first.verificationId, outcome: "finalized", expectedProviderSubject: "provider_subject_01",
  });
  assert.deepEqual(await begin(restartedDependencies, input), { ...first, kind: "finalized_replay" });
  assert.deepEqual(await prepare(dependencies, { verificationId: first.verificationId }), {
    normalizedEmail: "student@example.test", clientKind: "web", deviceLabel: "Browser", flowKind: "b2c",
    providerVerification: { kind: "pending", expectedProviderSubject: "provider_subject_01" },
  });
  assert.equal(randomCalls, 1);
  await assert.rejects(
    begin(dependencies, {
      ...input,
      deviceLabel: "Changed Browser",
      payloadHash: canonicalPayloadHash({
        schema_version: 1, flow_kind: "b2c", idempotency_key: "signup_idem_01",
        normalized_email: "student@example.test", client_kind: "web", device_label: "Changed Browser",
      }),
    }),
    (error: unknown) => (error as { code?: unknown }).code === "IDEMPOTENCY_CONFLICT",
  );

  const failedInput = {
    ...input,
    idempotencyKey: "signup_failed_then_retry",
    payloadHash: canonicalPayloadHash({
      schema_version: 1, flow_kind: "b2c", idempotency_key: "signup_failed_then_retry",
      normalized_email: "student@example.test", client_kind: "web", device_label: "Browser",
    }),
  };
  const failedStart = await begin(dependencies, failedInput);
  await finalize(dependencies, { verificationId: failedStart.verificationId, outcome: "failed" });
  assert.deepEqual(await begin(dependencies, failedInput), {
    ...failedStart,
    kind: "reserved",
  });
  await finalize(dependencies, {
    verificationId: failedStart.verificationId, outcome: "finalized", expectedProviderSubject: "provider_subject_retry",
  });
  assert.equal((await pool.query(
    "select provider_start_status, provider_start_attempt from email_verification_transactions where email_verification_transaction_id = $1",
    [failedStart.verificationId],
  )).rows[0]?.provider_start_attempt, 2);

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
  assert.equal((await admit(dependencies, {
    verificationId: first.verificationId,
    verificationProofDigest: `sha256:${"9".repeat(64)}`,
  })).kind, "started");
  await checkpoint(dependencies, { verificationId: first.verificationId, verifiedSubject });
  assert.deepEqual(await prepare(restartedDependencies, { verificationId: first.verificationId }), {
    normalizedEmail: "student@example.test", clientKind: "web", deviceLabel: "Browser", flowKind: "b2c",
    providerVerification: { kind: "verified", subject: verifiedSubject },
  });
  const outcomes = await Promise.allSettled([
    consume(dependencies, { verificationId: first.verificationId }),
    consume(dependencies, { verificationId: first.verificationId }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  const accepted = outcomes.find((outcome): outcome is PromiseFulfilledResult<{ clientKind: string; deviceLabel?: string }> => outcome.status === "fulfilled")!;
  assert.deepEqual(accepted.value, {
    clientKind: "web", deviceLabel: "Browser", normalizedEmail: "student@example.test", flowKind: "b2c",
    verifiedSubject,
  });
  const consumed = (await pool.query<{ status: string; consumed_at: Date | null; provider_hmac_bytes: number }>(
    `select status, consumed_at, octet_length(verified_provider_subject_hmac)::int as provider_hmac_bytes
     from email_verification_transactions where email_verification_transaction_id = $1`,
    [first.verificationId],
  )).rows[0]!;
  assert.equal(consumed.status, "consumed");
  assert.equal(consumed.consumed_at?.toISOString(), now.toISOString());
  assert.equal(consumed.provider_hmac_bytes, 32);
});

test("invitation email verification encrypts exact invitation authority and durably commits expiry", async () => {
  const module = await import("../src/index.js") as Record<string, unknown>;
  const begin = module.beginEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<{ kind: string; verificationId: string }>;
  const finalize = module.finalizeEmailVerificationTransactionStart as (dependencies: unknown, input: unknown) => Promise<void>;
  const prepare = module.prepareEmailVerificationTransaction as (dependencies: unknown, input: unknown) => Promise<Record<string, unknown>>;
  let clock = new Date(now);
  const dependencies = {
    db, hmacKey, protector, ttlMs: 60_000,
    databaseNow: async () => new Date(clock),
    randomBytes: (length: number) => Buffer.alloc(length, 0x31),
  };
  const invitationDigest = createHash("sha256").update(Buffer.alloc(32, 0x29)).digest("base64url");
  const started = await begin(dependencies, {
    idempotencyKey: "invitation-start-01",
    payloadHash: canonicalPayloadHash({
      schema_version: 1, flow_kind: "invitation", idempotency_key: "invitation-start-01",
      normalized_email: "invitee@example.test", client_kind: "iphone", device_label: "Invite Phone",
      invitation_digest: invitationDigest,
    }),
    normalizedEmail: "invitee@example.test",
    clientKind: "iphone",
    deviceLabel: "Invite Phone",
    flow: {
      kind: "invitation",
      invitationId: "invitation_bound_01",
      tenantId: "tenant_bound_01",
      invitationSecretDigest: invitationDigest,
      expectedResourceVersion: 3,
      role: "consultant",
    },
  });
  assert.equal(started.kind, "reserved");
  await finalize(dependencies, {
    verificationId: started.verificationId, outcome: "finalized", expectedProviderSubject: "provider_invitee_01",
  });
  assert.deepEqual(await prepare(dependencies, { verificationId: started.verificationId }), {
    normalizedEmail: "invitee@example.test",
    clientKind: "iphone",
    deviceLabel: "Invite Phone",
    flowKind: "invitation",
    invitationId: "invitation_bound_01",
    tenantId: "tenant_bound_01",
    invitationSecretDigest: invitationDigest,
    expectedResourceVersion: 3,
    role: "consultant",
    providerVerification: { kind: "pending", expectedProviderSubject: "provider_invitee_01" },
  });
  const raw = await pool.query<{ binding: string; status: string; start_status: string }>(
    "select encode(binding_ciphertext, 'escape') as binding, status, provider_start_status as start_status from email_verification_transactions where email_verification_transaction_id = $1",
    [started.verificationId],
  );
  assert.equal(JSON.stringify(raw.rows[0]).includes("invitation_bound_01"), false);
  assert.equal(raw.rows[0]?.start_status, "finalized");
  const replayExpiryInput = {
    idempotencyKey: "invitation-start-expiry-replay",
    payloadHash: canonicalPayloadHash({
      schema_version: 1, flow_kind: "invitation", idempotency_key: "invitation-start-expiry-replay",
      normalized_email: "invitee@example.test", client_kind: "iphone", device_label: "Invite Phone",
      invitation_digest: invitationDigest,
    }),
    normalizedEmail: "invitee@example.test",
    clientKind: "iphone",
    deviceLabel: "Invite Phone",
    flow: {
      kind: "invitation", invitationId: "invitation_bound_expiry", tenantId: "tenant_bound_01",
      invitationSecretDigest: invitationDigest, expectedResourceVersion: 4, role: "consultant",
    },
  };
  const replayExpiryDependencies = {
    ...dependencies, randomBytes: (length: number) => Buffer.alloc(length, 0x32),
  };
  const replayExpiry = await begin(replayExpiryDependencies, replayExpiryInput);
  clock = new Date(now.getTime() + 60_001);
  assert.deepEqual(await db.transaction().execute((trx) => begin(
    { ...replayExpiryDependencies, transaction: trx }, replayExpiryInput,
  )), { kind: "expired" });
  assert.equal((await pool.query(
    "select status from email_verification_transactions where email_verification_transaction_id = $1",
    [replayExpiry.verificationId],
  )).rows[0]?.status, "expired");
  await assert.rejects(prepare(dependencies, { verificationId: started.verificationId }), /UNAUTHENTICATED/u);
  const expired = await pool.query<{ status: string }>(
    "select status from email_verification_transactions where email_verification_transaction_id = $1",
    [started.verificationId],
  );
  assert.equal(expired.rows[0]?.status, "expired");
});

test("concurrent first email starts admit one durable reservation without raw uniqueness failures", async () => {
  const module = await import("../src/index.js") as Record<string, unknown>;
  const begin = module.beginEmailVerificationTransaction as (
    dependencies: unknown,
    input: unknown,
  ) => Promise<{ kind: string; verificationId: string }>;
  let randomSeed = 0;
  let encryptionsWaiting = 0;
  let releaseEncryptions!: () => void;
  const allEncryptionsWaiting = new Promise<void>((resolve) => { releaseEncryptions = resolve; });
  const concurrentProtector = {
    async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
      encryptionsWaiting += 1;
      if (encryptionsWaiting === 8) releaseEncryptions();
      await allEncryptionsWaiting;
      return protector.encrypt(plaintext);
    },
    decrypt: protector.decrypt,
  };
  const dependencies = {
    db, hmacKey, protector: concurrentProtector, ttlMs: 60_000,
    databaseNow: async () => new Date(now),
    randomBytes: (length: number) => Buffer.alloc(length, ++randomSeed),
  };
  const input = {
    idempotencyKey: "concurrent-first-start",
    payloadHash: canonicalPayloadHash({
      schema_version: 1, flow_kind: "b2c", idempotency_key: "concurrent-first-start",
      normalized_email: "concurrent@example.test", client_kind: "web",
    }),
    normalizedEmail: "concurrent@example.test", clientKind: "web", flow: { kind: "b2c" },
  };
  const settled = await Promise.allSettled(Array.from({ length: 8 }, () => begin(dependencies, input)));
  assert.equal(settled.every(({ status }) => status === "fulfilled"), true, JSON.stringify(settled));
  const results = settled.map((result) => (result as PromiseFulfilledResult<{ kind: string; verificationId: string }>).value);
  assert.equal(results.filter(({ kind }) => kind === "reserved").length, 1);
  assert.equal(results.filter(({ kind }) => kind === "in_progress").length, 7);
  assert.equal(new Set(results.map(({ verificationId }) => verificationId)).size, 1);
  assert.equal((await pool.query(
    "select count(*)::int as count from email_verification_transactions where start_idempotency_key = $1",
    [input.idempotencyKey],
  )).rows[0]?.count, 1);
});

test("provider verification attempt is durably timed, HMAC-bound, leased once, and recoverable after restart", async () => {
  const module = await import("../src/index.js") as Record<string, unknown>;
  const begin = module.beginEmailVerificationTransaction as (
    dependencies: unknown, input: unknown,
  ) => Promise<{ verificationId: string }>;
  const finalize = module.finalizeEmailVerificationTransactionStart as (
    dependencies: unknown, input: unknown,
  ) => Promise<void>;
  const admit = module.admitEmailVerificationProviderAttempt as (
    dependencies: unknown, input: unknown,
  ) => Promise<Record<string, unknown>>;
  const release = module.releaseEmailVerificationProviderAttempt as (
    dependencies: unknown, input: unknown,
  ) => Promise<void>;
  assert.equal(typeof admit, "function");
  assert.equal(typeof release, "function");

  let clock = new Date(now);
  const dependencies = {
    db, hmacKey, protector, ttlMs: 10 * 60_000, verificationAttemptLeaseMs: 30_000,
    databaseNow: async () => new Date(clock),
    randomBytes: (length: number) => Buffer.alloc(length, 0x61),
  };
  const input = {
    idempotencyKey: "provider-attempt-start",
    payloadHash: canonicalPayloadHash({
      schema_version: 1, flow_kind: "b2c", idempotency_key: "provider-attempt-start",
      normalized_email: "attempt@example.test", client_kind: "web",
    }),
    normalizedEmail: "attempt@example.test", clientKind: "web", flow: { kind: "b2c" },
  };
  const started = await begin(dependencies, input);
  await finalize(dependencies, {
    verificationId: started.verificationId,
    outcome: "finalized",
    expectedProviderSubject: "provider_attempt_subject",
  });
  const attemptInput = {
    verificationId: started.verificationId,
    verificationProofDigest: `sha256:${"4".repeat(64)}`,
  };
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => admit(dependencies, attemptInput)));
  assert.equal(concurrent.filter(({ kind }) => kind === "started").length, 1);
  assert.equal(concurrent.filter(({ kind }) => kind === "in_progress").length, 7);
  const first = concurrent.find(({ kind }) => kind === "started")!;
  assert.deepEqual(first, {
    kind: "started",
    expectedProviderSubject: "provider_attempt_subject",
    expectedNormalizedEmail: "attempt@example.test",
    verificationStartedAt: "2026-08-18T00:00:00.000Z",
    recoveryNotAfter: "2026-08-18T00:00:00.000Z",
  });
  const stored = (await pool.query<{
    provider_verification_started_at: Date | null;
    provider_verification_attempt_expires_at: Date | null;
    proof_hmac: string | null;
    leaked: string;
  }>(`select provider_verification_started_at, provider_verification_attempt_expires_at,
      encode(provider_verification_proof_hmac, 'hex') as proof_hmac,
      encode(provider_verification_proof_hmac, 'escape') as leaked
    from email_verification_transactions where email_verification_transaction_id = $1`,
  [started.verificationId])).rows[0]!;
  assert.equal(stored.provider_verification_started_at?.toISOString(), now.toISOString());
  assert.equal(stored.provider_verification_attempt_expires_at?.toISOString(), "2026-08-18T00:00:30.000Z");
  assert.equal(stored.proof_hmac?.length, 64);
  assert.equal(stored.leaked.includes(attemptInput.verificationProofDigest), false);

  clock = new Date("2026-08-18T00:00:30.001Z");
  assert.deepEqual(await admit({ ...dependencies }, attemptInput), {
    kind: "recovery",
    expectedProviderSubject: "provider_attempt_subject",
    expectedNormalizedEmail: "attempt@example.test",
    verificationStartedAt: "2026-08-18T00:00:00.000Z",
    recoveryNotAfter: "2026-08-18T00:00:30.001Z",
  });
  await release(dependencies, attemptInput);
  const released = (await pool.query<{
    provider_verification_started_at: Date | null;
    provider_verification_attempt_expires_at: Date | null;
    provider_verification_proof_hmac: Buffer | null;
  }>(`select provider_verification_started_at, provider_verification_attempt_expires_at,
      provider_verification_proof_hmac from email_verification_transactions
      where email_verification_transaction_id = $1`, [started.verificationId])).rows[0]!;
  assert.deepEqual(released, {
    provider_verification_started_at: null,
    provider_verification_attempt_expires_at: null,
    provider_verification_proof_hmac: null,
  });
});
