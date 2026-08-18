import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations } from "../src/db/migrate.js";
import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";
import {
  registerB2c,
  type RegisterB2cCommand,
  type RegisterB2cDependencies,
} from "../src/services/identity/register-b2c.js";
import type { Kysely, Transaction } from "kysely";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const administratorPool = new Pool({ connectionString: databaseUrl });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const now = new Date("2026-08-14T01:02:03.000Z");
const normalizedEmailHmacKey = Buffer.from("registration-email-hmac-key-v1!!", "utf8");
const fakePiiEncryptionKey = createHash("sha256").update("task-3-test-only-aead-key", "utf8").digest();
const fakePiiNonce = Buffer.from("000102030405060708090a0b", "hex");
const fakePiiMagic = Buffer.from("PII1", "ascii");
const fakePiiAad = Buffer.from("private_identity_pii:v1", "utf8");
const defaultProfile = Object.freeze({
  providerConfigId: "provider_personal_default",
  modelId: "model_personal_default",
});

let identityPool: Pool;
let identityDb: Kysely<RuntimeDatabase>;

async function ensureIdentityRoles(): Promise<void> {
  await administratorPool.query(`do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then
        create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then
        create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
      end if;
    end
  $$`);
}

async function setIdentityPassword(password: string | null): Promise<void> {
  const setting = password === null ? "" : password;
  const client = await administratorPool.connect();
  try {
    await client.query("begin");
    await client.query("set local password_encryption = 'scram-sha-256'");
    await client.query("select set_config('core_agent.test_identity_password', $1, true)", [setting]);
    await client.query(`do $password$
      begin
        if current_setting('core_agent.test_identity_password') = '' then
          alter role core_agent_identity password null;
        else
          execute format(
            'alter role core_agent_identity login password %L',
            current_setting('core_agent.test_identity_password')
          );
        end if;
        perform set_config('core_agent.test_identity_password', '', true);
      end
    $password$`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resetDatabase(): Promise<void> {
  await administratorPool.query("drop schema public cascade; create schema public;");
  await applyMigrations(administratorPool, migrationsDirectory);
}

function command(overrides: Partial<RegisterB2cCommand> = {}): RegisterB2cCommand {
  const base = {
    schema_version: 1 as const,
    idempotency_key: "register-personal-account-0001",
    auth_subject: {
      provider: "supabase" as const,
      providerSubject: "supabase-user-0001",
      identityKind: "email_password" as const,
      normalizedEmail: "student@example.test",
      verifiedAt: "2026-08-14T01:00:00.000Z",
    },
    display_name: "Personal Student",
    ...overrides,
  };
  const withoutHash = {
    schema_version: base.schema_version,
    idempotency_key: base.idempotency_key,
    auth_subject: base.auth_subject,
    display_name: base.display_name,
  };
  return { ...base, payload_hash: canonicalPayloadHash(withoutHash) };
}

function fakeEncryptNormalizedEmail(value: string): Buffer {
  const cipher = createCipheriv("aes-256-gcm", fakePiiEncryptionKey, fakePiiNonce);
  cipher.setAAD(fakePiiAad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([fakePiiMagic, fakePiiNonce, cipher.getAuthTag(), ciphertext]);
}

function fakeDecryptNormalizedEmail(envelope: Uint8Array): string {
  const bytes = Buffer.from(envelope);
  assert(bytes.length > fakePiiMagic.length + fakePiiNonce.length + 16);
  assert.deepEqual(bytes.subarray(0, fakePiiMagic.length), fakePiiMagic);
  const nonceStart = fakePiiMagic.length;
  const tagStart = nonceStart + fakePiiNonce.length;
  const ciphertextStart = tagStart + 16;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    fakePiiEncryptionKey,
    bytes.subarray(nonceStart, tagStart),
  );
  decipher.setAAD(fakePiiAad);
  decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
  return Buffer.concat([
    decipher.update(bytes.subarray(ciphertextStart)),
    decipher.final(),
  ]).toString("utf8");
}

function dependencies(): RegisterB2cDependencies {
  return {
    db: identityDb,
    now: () => new Date(now),
    defaultProfile,
    privatePii: {
      normalizedEmailHmacKey,
      encryptionKeyRef: "identity-email-key-v1",
      async encryptNormalizedEmail(value) {
        return fakeEncryptNormalizedEmail(value);
      },
    },
  };
}

const context = Object.freeze({
  requestId: "request-registration-0001",
  traceId: "trace-registration-0001",
});

async function tableCount(table: string): Promise<number> {
  const result = await administratorPool.query<{ count: number }>(
    `select count(*)::int as count from ${table}`,
  );
  return result.rows[0]?.count ?? -1;
}

async function assertRegistrationTablesEmpty(): Promise<void> {
  for (const table of [
    "actors",
    "tenants",
    "memberships",
    "profiles",
    "auth_subjects",
    "private_identity_pii",
    "idempotency_records",
    "stream_sequences",
    "product_events",
    "audit_events",
    "outbox",
  ]) {
    assert.equal(await tableCount(table), 0, `${table} must roll back`);
  }
}

const insertFailureTables = new Set([
  "actors",
  "tenants",
  "idempotency_records",
  "memberships",
  "profiles",
  "auth_subjects",
  "private_identity_pii",
  "stream_sequences",
  "product_events",
  "audit_events",
  "outbox",
]);

async function withDatabaseInsertFailure<T>(table: string, work: () => Promise<T>): Promise<T> {
  assert(insertFailureTables.has(table));
  await administratorPool.query(`create function task3_test_fail_after_insert()
    returns trigger language plpgsql
    set search_path = pg_catalog, public
    as $failure$
      begin
        raise exception 'injected failure after %', tg_table_name;
      end
    $failure$`);
  await administratorPool.query(`create trigger task3_test_fail_after_insert
    after insert on ${table}
    for each row execute function task3_test_fail_after_insert()`);
  try {
    return await work();
  } finally {
    await administratorPool.query(`drop trigger if exists task3_test_fail_after_insert on ${table}`);
    await administratorPool.query("drop function if exists task3_test_fail_after_insert()");
  }
}

async function captureError(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    assert(error instanceof Error);
    return error;
  }
  throw new assert.AssertionError({ message: "Expected operation to reject" });
}

function assertOpaqueIdentityCollision(error: Error, sentinels: readonly string[]): void {
  assert(error instanceof DomainError);
  assert.equal(error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(error.message, "IDEMPOTENCY_CONFLICT: Identity registration conflicts with existing authority");
  assert.equal(Object.prototype.hasOwnProperty.call(error, "cause"), false);
  const descriptorValues = Object.values(Object.getOwnPropertyDescriptors(error))
    .flatMap((descriptor) => "value" in descriptor && typeof descriptor.value === "string" ? [descriptor.value] : []);
  const surfaces = [error.message, error.stack ?? "", JSON.stringify(error), ...descriptorValues];
  for (const sentinel of sentinels) {
    assert.equal(surfaces.some((surface) => surface.includes(sentinel)), false, `collision leaked ${sentinel}`);
  }
}

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityPool = new Pool({ connectionString: target.toString(), max: 4 });
  identityDb = createRuntimeDatabase(identityPool);
});

test.beforeEach(resetDatabase);

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("registerB2c creates only the personal identity graph and replays byte-equivalent public IDs", async () => {
  assert.equal(
    (await identityPool.query<{ current_user: string }>("select current_user")).rows[0]?.current_user,
    "core_agent_identity",
  );
  const registration = command();
  const first = await registerB2c(dependencies(), context, registration);
  const replay = await registerB2c(dependencies(), context, registration);

  assert.deepEqual(replay, first);
  assert.equal(JSON.stringify(replay), JSON.stringify(first));
  assert.deepEqual(Object.keys(first).sort(), [
    "actor_id",
    "auth_subject_id",
    "membership_id",
    "profile_id",
    "schema_version",
    "tenant_id",
  ]);
  assert.equal(JSON.stringify(first).includes(registration.auth_subject.normalizedEmail), false);
  assert.equal(JSON.stringify(first).includes(registration.auth_subject.providerSubject), false);

  const actor = await administratorPool.query(
    "select actor_id, actor_kind, display_name, status from actors where actor_id = $1",
    [first.actor_id],
  );
  assert.deepEqual(actor.rows, [{
    actor_id: first.actor_id,
    actor_kind: "human",
    display_name: registration.display_name,
    status: "active",
  }]);
  const tenant = await administratorPool.query(
    "select tenant_id, tenant_mode, display_name, status from tenants where tenant_id = $1",
    [first.tenant_id],
  );
  assert.deepEqual(tenant.rows, [{
    tenant_id: first.tenant_id,
    tenant_mode: "b2c",
    display_name: registration.display_name,
    status: "active",
  }]);
  const membership = await administratorPool.query(
    "select membership_id, actor_id, roles, membership_source, status from memberships where tenant_id = $1",
    [first.tenant_id],
  );
  assert.deepEqual(membership.rows, [{
    membership_id: first.membership_id,
    actor_id: first.actor_id,
    roles: ["student"],
    membership_source: "self",
    status: "active",
  }]);
  const profile = await administratorPool.query(
    "select profile_id, owner_actor_id, profile_kind, status, provider_config_id, model_id from profiles where tenant_id = $1",
    [first.tenant_id],
  );
  assert.deepEqual(profile.rows, [{
    profile_id: first.profile_id,
    owner_actor_id: first.actor_id,
    profile_kind: "default",
    status: "active",
    provider_config_id: defaultProfile.providerConfigId,
    model_id: defaultProfile.modelId,
  }]);
  const subject = await administratorPool.query(
    "select auth_subject_id, actor_id, provider, provider_subject, provider_identity_kind, status from auth_subjects where auth_subject_id = $1",
    [first.auth_subject_id],
  );
  assert.deepEqual(subject.rows, [{
    auth_subject_id: first.auth_subject_id,
    actor_id: first.actor_id,
    provider: "supabase",
    provider_subject: registration.auth_subject.providerSubject,
    provider_identity_kind: registration.auth_subject.identityKind,
    status: "active",
  }]);
  const pii = await administratorPool.query<{
    actor_id: string;
    normalized_email_hmac: Buffer;
    encrypted_email: Buffer;
    encryption_key_ref: string;
  }>(
    "select actor_id, normalized_email_hmac, encrypted_email, encryption_key_ref from private_identity_pii where actor_id = $1",
    [first.actor_id],
  );
  assert.equal(pii.rows.length, 1);
  assert.equal(pii.rows[0]?.actor_id, first.actor_id);
  assert.deepEqual(
    pii.rows[0]?.normalized_email_hmac,
    createHmac("sha256", normalizedEmailHmacKey).update(registration.auth_subject.normalizedEmail, "utf8").digest(),
  );
  assert.equal(fakeDecryptNormalizedEmail(pii.rows[0]!.encrypted_email), registration.auth_subject.normalizedEmail);
  const tamperedEnvelope = Buffer.from(pii.rows[0]!.encrypted_email);
  tamperedEnvelope[tamperedEnvelope.length - 1] ^= 1;
  assert.throws(() => fakeDecryptNormalizedEmail(tamperedEnvelope));
  assert.equal(pii.rows[0]?.encryption_key_ref, "identity-email-key-v1");

  for (const table of [
    "actors",
    "tenants",
    "memberships",
    "profiles",
    "auth_subjects",
    "private_identity_pii",
    "stream_sequences",
    "product_events",
    "audit_events",
    "outbox",
    "idempotency_records",
  ]) assert.equal(await tableCount(table), 1, `${table} must contain exactly the registration row`);
  assert.equal(await tableCount("runtime_containers"), 0);
  assert.equal(await tableCount("worker_jobs"), 0);
  assert.equal(await tableCount("core_sessions"), 0);
  assert.equal(await tableCount("platform_role_assignments"), 0);
  assert.equal((await administratorPool.query<{ relation: string | null }>(
    "select to_regclass('public.entitlements')::text as relation",
  )).rows[0]?.relation, null);
  assert.equal(await tableCount("product_events"), 1);
  assert.equal(await tableCount("audit_events"), 1);
  assert.equal(await tableCount("outbox"), 1);
  assert.equal(await tableCount("idempotency_records"), 1);

  const streamSequence = await administratorPool.query<{
    tenant_id: string;
    stream_id: string;
    last_sequence: string;
  }>("select tenant_id, stream_id, last_sequence::text from stream_sequences");
  assert.deepEqual(streamSequence.rows, [{
    tenant_id: first.tenant_id,
    stream_id: first.actor_id,
    last_sequence: "1",
  }]);

  const idempotency = await administratorPool.query<{
    status: string;
    result_ref: string | null;
    response_json: unknown;
    payload_hash: string;
    operation: string;
  }>(`select status, result_ref, response_json, payload_hash, operation
      from idempotency_records where tenant_id = $1 and idempotency_key = $2`, [
    first.tenant_id,
    registration.idempotency_key,
  ]);
  assert.deepEqual(idempotency.rows, [{
    status: "completed",
    result_ref: first.actor_id,
    response_json: first,
    payload_hash: registration.payload_hash,
    operation: "identity.register-b2c",
  }]);
  const linkage = await administratorPool.query<{
    tenant_id: string;
    outbox_event_id: string;
    product_event_id: string;
    delivery_target: string;
    status: string;
  }>(`select outbox.tenant_id, outbox.event_id as outbox_event_id,
        product.event_id as product_event_id, outbox.delivery_target, outbox.status
      from outbox
      join product_events product
        on product.tenant_id = outbox.tenant_id and product.event_id = outbox.event_id`);
  assert.deepEqual(linkage.rows, [{
    tenant_id: first.tenant_id,
    outbox_event_id: linkage.rows[0]?.product_event_id,
    product_event_id: linkage.rows[0]?.product_event_id,
    delivery_target: "internal_event_stream",
    status: "pending",
  }]);

  const persistedPublicRecords = await administratorPool.query<{
    payload: unknown;
    event_json: unknown;
  }>(`select product.payload, audit.event_json
      from product_events product
      join audit_events audit on audit.tenant_id = product.tenant_id
      where product.tenant_id = $1`, [first.tenant_id]);
  const publicSerialization = JSON.stringify(persistedPublicRecords.rows);
  assert.equal(publicSerialization.includes(registration.auth_subject.normalizedEmail), false);
  assert.equal(publicSerialization.includes(registration.auth_subject.providerSubject), false);
  assert.deepEqual(persistedPublicRecords.rows[0]?.payload, {
    actor_id: first.actor_id,
    tenant_id: first.tenant_id,
    membership_id: first.membership_id,
    profile_id: first.profile_id,
    resource_version: 1,
  });
});

test("registerInvitedIdentity composes in a caller-owned transaction without self authority", async () => {
  const module = await import("../src/index.js") as Record<string, unknown>;
  assert.equal("registerInvitedIdentity" in module, false, "invited registration must not be a root public bypass");
  const { registerInvitedIdentityForVerifiedInvitation } = await import("../src/services/identity/register-invited-identity.js");
  await identityDb.insertInto("tenants").values({
    tenant_id: "tenant_invited_registration",
    schema_version: 1,
    resource_version: 1,
    tenant_mode: "b2b",
    display_name: "Invited Company",
    status: "active",
    created_at: now,
    updated_at: now,
  }).execute();
  await identityDb.insertInto("actors").values({
    actor_id: "actor_invited_registration_admin", schema_version: 1, resource_version: 1,
    actor_kind: "human", display_name: "Inviting admin", status: "active",
    created_at: now, updated_at: now,
  }).execute();
  const withoutHash = {
    schema_version: 1 as const,
    idempotency_key: "register-invited-identity-0001",
    tenant_id: "tenant_invited_registration",
    auth_subject: {
      provider: "supabase" as const,
      providerSubject: "supabase-invited-0001",
      identityKind: "email_password" as const,
      normalizedEmail: "invited@example.test",
      verifiedAt: "2026-08-14T01:00:00.000Z",
    },
    display_name: "Invited User",
  };
  const invitedCommand = { ...withoutHash, payload_hash: canonicalPayloadHash(withoutHash) };
  await assert.rejects(identityDb.transaction().execute((trx) => registerInvitedIdentityForVerifiedInvitation({
    db: identityDb,
    transaction: trx,
    now: () => new Date(now),
    privatePii: dependencies().privatePii,
  } as never, context, invitedCommand)), (error: unknown) => (
    error instanceof DomainError && error.code === "UNAUTHENTICATED"
  ));
  assert.equal(await tableCount("actors"), 1, "missing verified binding must roll back the partial identity graph");
  const invitationSecretDigest = Buffer.alloc(32, 0x4a);
  await identityDb.insertInto("identity_invitations").values({
    invitation_id: "invitation_invited_registration",
    tenant_id: "tenant_invited_registration",
    membership_id: "membership_invited_registration",
    invited_by_actor_id: "actor_invited_registration_admin",
    role: "consultant",
    secret_digest: invitationSecretDigest,
    normalized_email_hmac: createHmac("sha256", normalizedEmailHmacKey).update("invited@example.test").digest(),
    status: "pending",
    expires_at: new Date("2099-01-01T00:00:00.000Z"),
    accepted_actor_id: null,
    accepted_at: null,
    replaced_by_invitation_id: null,
    resource_version: 1,
    created_at: now,
    updated_at: now,
  }).execute();
  const invitedDependencies = (trx: Transaction<RuntimeDatabase>) => ({
    db: identityDb,
    transaction: trx,
    now: () => new Date(now),
    privatePii: dependencies().privatePii,
    verifiedInvitationBinding: {
      invitationId: "invitation_invited_registration", tenantId: "tenant_invited_registration",
      secretDigest: invitationSecretDigest, expectedResourceVersion: 1, role: "consultant" as const,
    },
  });
  const first = await identityDb.transaction().execute((trx) => registerInvitedIdentityForVerifiedInvitation(
    invitedDependencies(trx), context, invitedCommand,
  ));
  const replay = await identityDb.transaction().execute((trx) => registerInvitedIdentityForVerifiedInvitation(
    invitedDependencies(trx), context, invitedCommand,
  ));
  assert.deepEqual(replay, first);
  assert.equal(await tableCount("actors"), 2);
  assert.equal(await tableCount("auth_subjects"), 1);
  assert.equal(await tableCount("private_identity_pii"), 1);
  assert.equal(await tableCount("memberships"), 0);
  assert.equal(await tableCount("profiles"), 0);
  assert.equal(await tableCount("tenants"), 1, "the service must not create a personal Tenant");
  await assert.rejects(identityDb.transaction().execute((trx) => registerInvitedIdentityForVerifiedInvitation(invitedDependencies(trx), context, {
    ...invitedCommand,
    auth_subject: { ...invitedCommand.auth_subject, providerSubject: "supabase-invited-conflict" },
  })), (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST");
});

test("registerB2c maps provider-subject uniqueness to one opaque fixed DomainError", async () => {
  const providerSubject = "provider-subject-collision-sentinel";
  const first = command({
    idempotency_key: "provider-collision-first",
    auth_subject: {
      provider: "supabase",
      providerSubject,
      identityKind: "email_password",
      normalizedEmail: "provider-first@example.test",
      verifiedAt: "2026-08-14T01:00:00.000Z",
    },
  });
  const second = command({
    idempotency_key: "provider-collision-second",
    auth_subject: {
      ...first.auth_subject,
      normalizedEmail: "provider-second@example.test",
    },
  });
  await registerB2c(dependencies(), context, first);

  const error = await captureError(() => registerB2c(dependencies(), context, second));

  assertOpaqueIdentityCollision(error, [providerSubject]);
  assert.equal(await tableCount("actors"), 1);
  assert.equal(await tableCount("auth_subjects"), 1);
  assert.equal(await tableCount("idempotency_records"), 1);
});

test("registerB2c maps normalized-email uniqueness without leaking email or HMAC", async () => {
  const normalizedEmail = "email-collision-sentinel@example.test";
  const normalizedEmailHmac = createHmac("sha256", normalizedEmailHmacKey)
    .update(normalizedEmail, "utf8")
    .digest("hex");
  const first = command({
    idempotency_key: "email-collision-first",
    auth_subject: {
      provider: "supabase",
      providerSubject: "email-collision-provider-first",
      identityKind: "email_password",
      normalizedEmail,
      verifiedAt: "2026-08-14T01:00:00.000Z",
    },
  });
  const second = command({
    idempotency_key: "email-collision-second",
    auth_subject: {
      ...first.auth_subject,
      providerSubject: "email-collision-provider-second",
    },
  });
  await registerB2c(dependencies(), context, first);

  const error = await captureError(() => registerB2c(dependencies(), context, second));

  assertOpaqueIdentityCollision(error, [normalizedEmail, normalizedEmailHmac, `\\x${normalizedEmailHmac}`]);
  assert.equal(await tableCount("actors"), 1);
  assert.equal(await tableCount("auth_subjects"), 1);
  assert.equal(await tableCount("private_identity_pii"), 1);
  assert.equal(await tableCount("idempotency_records"), 1);
});

test("registerB2c never copies an adversarial idempotency identity into ProductEvent correlation", async () => {
  const sentinel = "correlation-sentinel@example.test";
  const registration = command({
    idempotency_key: sentinel,
    auth_subject: {
      provider: "supabase",
      providerSubject: sentinel,
      identityKind: "email_password",
      normalizedEmail: sentinel,
      verifiedAt: "2026-08-14T01:00:00.000Z",
    },
  });
  await registerB2c(dependencies(), context, registration);

  const event = await administratorPool.query<{
    correlation_id: string;
    causation_id: string;
    payload: unknown;
  }>("select correlation_id, causation_id, payload from product_events");

  assert.equal(event.rows.length, 1);
  assert.match(event.rows[0]!.correlation_id, /^correlation_identity_[a-f0-9]{32}$/u);
  assert.match(event.rows[0]!.causation_id, /^causation_identity_[a-f0-9]{32}$/u);
  assert.equal(JSON.stringify(event.rows).includes(sentinel), false);
});

test("registerB2c rejects idempotency reuse when any identity-bearing payload changes", async () => {
  const original = command();
  await registerB2c(dependencies(), context, original);
  const variants = [
    command({
      auth_subject: { ...original.auth_subject, providerSubject: "different-supabase-user" },
    }),
    command({
      auth_subject: { ...original.auth_subject, normalizedEmail: "different@example.test" },
    }),
    command({ display_name: "Different Student" }),
  ];

  for (const variant of variants) {
    await assert.rejects(
      registerB2c(dependencies(), context, variant),
      (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
    );
  }
  assert.equal(await tableCount("actors"), 1);
  assert.equal(await tableCount("tenants"), 1);
  assert.equal(await tableCount("idempotency_records"), 1);
});

test("registerB2c rolls the whole identity graph back after every insert boundary", async () => {
  const insertions = [
    ["actor", "actors"],
    ["tenant", "tenants"],
    ["idempotency", "idempotency_records"],
    ["membership", "memberships"],
    ["profile", "profiles"],
    ["auth_subject", "auth_subjects"],
    ["private_pii", "private_identity_pii"],
    ["stream_sequence", "stream_sequences"],
    ["product_event", "product_events"],
    ["audit_event", "audit_events"],
    ["outbox", "outbox"],
  ] as const;

  for (const [index, [targetStage, table]] of insertions.entries()) {
    const registration = command({
      idempotency_key: `register-rollback-${index}`,
      auth_subject: {
        provider: "supabase",
        providerSubject: `supabase-rollback-${index}`,
        identityKind: "email_password",
        normalizedEmail: `rollback-${index}@example.test`,
        verifiedAt: "2026-08-14T01:00:00.000Z",
      },
      display_name: `Rollback ${index}`,
    });
    await assert.rejects(
      withDatabaseInsertFailure(table, () => registerB2c(dependencies(), context, registration)),
      new RegExp(`injected failure after ${table}`),
    );
    await assertRegistrationTablesEmpty();
  }
});

test("registration fault injection remains database-only and absent from the public production API", async () => {
  const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const [serviceSource, publicIndexSource] = await Promise.all([
    readFile(join(sourceRoot, "services", "identity", "register-b2c.ts"), "utf8"),
    readFile(join(sourceRoot, "index.ts"), "utf8"),
  ]);
  assert.doesNotMatch(serviceSource, /afterInsert|RegisterB2cInsertStage/u);
  assert.doesNotMatch(publicIndexSource, /RegisterB2cInsertStage/u);
});
