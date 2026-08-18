import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const administratorPool = new Pool({ connectionString: databaseUrl });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const now = new Date("2026-08-14T05:00:00.000Z");
const emailHmacKey = createHash("sha256").update("task4-invitation-email-hmac-key", "utf8").digest();
let identityDb: Kysely<RuntimeDatabase>;
let entropyByte = 0x20;

type CommandFunction = (
  dependencies: Record<string, unknown>, context: Record<string, unknown>, command: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type InspectFunction = (dependencies: Record<string, unknown>, invitationSecret: string) => Promise<Record<string, unknown>>;

function requiredFunction<T>(name: string): T {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as T;
}

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
  const client = await administratorPool.connect();
  try {
    await client.query("begin");
    await client.query("set local password_encryption = 'scram-sha-256'");
    await client.query("select set_config('core_agent.task4_identity_password', $1, true)", [password ?? ""]);
    await client.query(`do $password$
      begin
        if current_setting('core_agent.task4_identity_password') = '' then
          alter role core_agent_identity password null;
        else
          execute format('alter role core_agent_identity login password %L', current_setting('core_agent.task4_identity_password'));
        end if;
        perform set_config('core_agent.task4_identity_password', '', true);
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
  entropyByte = 0x20;
  await administratorPool.query("drop schema public cascade; create schema public;");
  await applyMigrations(administratorPool, migrationsDirectory);
}

async function seedActor(actorId: string, normalizedEmail?: string): Promise<void> {
  await identityDb.insertInto("actors").values({
    actor_id: actorId, schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: actorId, status: "active", created_at: now, updated_at: now,
  }).execute();
  if (normalizedEmail !== undefined) {
    await identityDb.insertInto("private_identity_pii").values({
      actor_id: actorId,
      normalized_email_hmac: createHmac("sha256", emailHmacKey).update(normalizedEmail).digest(),
      encrypted_email: Buffer.from(`encrypted:${normalizedEmail}`), encryption_key_ref: "test-key",
      created_at: now, updated_at: now,
    }).execute();
  }
}

async function seedTenant(tenantId: string): Promise<void> {
  await identityDb.insertInto("tenants").values({
    tenant_id: tenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: tenantId, created_at: now, updated_at: now,
  }).execute();
}

async function seedMembership(input: {
  tenantId: string; membershipId: string; actorId: string; roles: string[]; status?: string;
}): Promise<void> {
  await identityDb.insertInto("memberships").values({
    tenant_id: input.tenantId, membership_id: input.membershipId, actor_id: input.actorId,
    schema_version: 1, resource_version: 1, roles: input.roles, membership_source: "company",
    seat_ref: null, status: input.status ?? "active", created_at: now, updated_at: now,
  }).execute();
}

async function seedCompany(tenantId = "tenant_invitation"): Promise<void> {
  await seedActor("actor_company_admin", "company-admin@example.test");
  await seedTenant(tenantId);
  await seedMembership({ tenantId, membershipId: `membership_admin_${tenantId}`, actorId: "actor_company_admin", roles: ["admin"] });
}

function dependencies(clock = now): Record<string, unknown> {
  return {
    db: identityDb, emailHmacKey, now: () => new Date(clock),
    randomBytes(size: number) {
      const bytes = Buffer.alloc(size, entropyByte);
      entropyByte += 1;
      return bytes;
    },
    consultantProfile: { providerConfigId: "provider_consultant", modelId: "model_consultant" },
  };
}

function adminContext(tenantId = "tenant_invitation"): Record<string, unknown> {
  return { tenantId, actorId: "actor_company_admin", requestId: `request_${tenantId}`, traceId: `trace_${tenantId}` };
}

function command(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1, idempotency_key: "invite-consultant-0001", tenant_id: "tenant_invitation",
    invitation_id: "invitation_consultant_0001", membership_id: "membership_consultant_0001",
    normalized_email: "consultant@example.test", role: "consultant", ...overrides,
  };
}

function acceptPayload(secret: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1, idempotency_key: "accept-consultant-0001", tenant_id: "tenant_invitation",
    invitation_code: secret, expected_resource_version: 1, ...overrides,
  };
}

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityDb = createRuntimeDatabase(new Pool({ connectionString: target.toString(), max: 12 }));
});

test.beforeEach(resetDatabase);

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("active company admins invite only within their Tenant and persist digest plus normalized-email HMAC", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  await seedCompany();
  await seedTenant("tenant_other");
  const payload = createPayload();
  const created = await createInvitation(dependencies(), adminContext(), command(payload));
  assert.equal(typeof created.invitation_secret, "string");
  const row = await administratorPool.query<{
    secret_digest: Buffer; normalized_email_hmac: Buffer; expires_at: Date; status: string;
  }>("select secret_digest, normalized_email_hmac, expires_at, status from identity_invitations");
  assert.equal(row.rows[0]?.secret_digest.length, 32);
  assert.deepEqual(row.rows[0]?.secret_digest, createHash("sha256").update(Buffer.alloc(32, 0x20)).digest());
  assert.deepEqual(row.rows[0]?.normalized_email_hmac, createHmac("sha256", emailHmacKey).update("consultant@example.test").digest());
  assert.equal(row.rows[0]?.expires_at.toISOString(), "2026-08-21T05:00:00.000Z");
  assert.equal(JSON.stringify(row.rows).includes("consultant@example.test"), false);

  const crossTenant = createPayload({
    idempotency_key: "invite-cross-tenant", tenant_id: "tenant_other",
    invitation_id: "invitation_cross", membership_id: "membership_cross",
  });
  await assert.rejects(
    createInvitation(dependencies(), adminContext(), command(crossTenant)),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );
});

test("inspection gives one RESOURCE_NOT_FOUND envelope for malformed unknown expired revoked and accepted secrets", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const inspectInvitation = requiredFunction<InspectFunction>("inspectInvitation");
  const revokeInvitation = requiredFunction<CommandFunction>("revokeInvitation");
  await seedCompany();
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const secret = created.invitation_secret as string;
  const inspected = await inspectInvitation(dependencies(), secret);
  assert.equal(inspected.invitation_id, "invitation_consultant_0001");
  const expectedMessage = "RESOURCE_NOT_FOUND: Invitation was not found";
  for (const invalid of ["not-base64url!", Buffer.alloc(32, 0x7f).toString("base64url")]) {
    await assert.rejects(inspectInvitation(dependencies(), invalid), (error: unknown) => (
      error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND" && error.message === expectedMessage
    ));
  }
  const revoke = {
    schema_version: 1, idempotency_key: "revoke-inspection", tenant_id: "tenant_invitation",
    invitation_id: "invitation_consultant_0001", expected_resource_version: 1,
  };
  await revokeInvitation(dependencies(), adminContext(), command(revoke));
  await assert.rejects(inspectInvitation(dependencies(), secret), (error: unknown) => (
    error instanceof DomainError && error.message === expectedMessage
  ));

  const expiredPayload = createPayload({
    idempotency_key: "invite-expired", invitation_id: "invitation_expired", membership_id: "membership_expired",
    normalized_email: "expired@example.test",
  });
  const expired = await createInvitation(dependencies(new Date("2026-08-01T00:00:00.000Z")), adminContext(), command(expiredPayload));
  await assert.rejects(inspectInvitation(dependencies(), expired.invitation_secret as string), (error: unknown) => (
    error instanceof DomainError && error.message === expectedMessage
  ));
});

test("inspection and acceptance hide invitations belonging to a closed Tenant", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const inspectInvitation = requiredFunction<InspectFunction>("inspectInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  await identityDb.updateTable("tenants").set({ status: "closed", resource_version: 2, updated_at: now })
    .where("tenant_id", "=", "tenant_invitation").execute();
  const expected = (error: unknown) => error instanceof DomainError
    && error.code === "RESOURCE_NOT_FOUND" && error.message === "RESOURCE_NOT_FOUND: Invitation was not found";
  await assert.rejects(inspectInvitation(dependencies(), created.invitation_secret as string), expected);
  await assert.rejects(acceptInvitation(dependencies(), {
    actorId: "actor_consultant", normalizedEmail: "consultant@example.test",
    requestId: "request_closed", traceId: "trace_closed",
  }, command(acceptPayload(created.invitation_secret as string))), expected);
});

test("replace and revoke require exact optimistic versions and remain single-use", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const replaceInvitation = requiredFunction<CommandFunction>("replaceInvitation");
  const revokeInvitation = requiredFunction<CommandFunction>("revokeInvitation");
  await seedCompany();
  await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const replace = {
    schema_version: 1, idempotency_key: "replace-invitation", tenant_id: "tenant_invitation",
    invitation_id: "invitation_consultant_0001", replacement_invitation_id: "invitation_consultant_0002",
    expected_resource_version: 1,
  };
  const replacement = await replaceInvitation(dependencies(), adminContext(), command(replace));
  assert.equal(typeof replacement.invitation_secret, "string");
  const replacementReplay = await replaceInvitation(dependencies(), adminContext(), command(replace));
  assert.equal(Object.hasOwn(replacementReplay, "invitation_secret"), false);
  assert.equal(replacementReplay.invitation_id, replacement.invitation_id);
  const old = await administratorPool.query("select status, replaced_by_invitation_id, resource_version::int from identity_invitations where invitation_id = 'invitation_consultant_0001'");
  assert.deepEqual(old.rows, [{ status: "replaced", replaced_by_invitation_id: "invitation_consultant_0002", resource_version: 2 }]);
  await assert.rejects(
    replaceInvitation(dependencies(), adminContext(), command({ ...replace, idempotency_key: "replace-stale" })),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  const revoke = {
    schema_version: 1, idempotency_key: "revoke-replacement", tenant_id: "tenant_invitation",
    invitation_id: "invitation_consultant_0002", expected_resource_version: 1,
  };
  const revoked = await revokeInvitation(dependencies(), adminContext(), command(revoke));
  const revokeReplay = await revokeInvitation(dependencies(), adminContext(), command(revoke));
  assert.deepEqual(revokeReplay, revoked);
  await assert.rejects(
    revokeInvitation(dependencies(), adminContext(), command({ ...revoke, idempotency_key: "revoke-stale" })),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  const lifecycle = await administratorPool.query("select event_type, payload from product_events order by payload->>'invitation_id', event_type desc");
  assert.deepEqual(lifecycle.rows, [{
    event_type: "invitation.created", payload: {
      invitation_id: "invitation_consultant_0001", membership_id: "membership_consultant_0001", status: "pending", resource_version: 1,
    },
  }, {
    event_type: "invitation.changed", payload: {
      invitation_id: "invitation_consultant_0001", membership_id: "membership_consultant_0001", status: "replaced",
      replacement_invitation_id: "invitation_consultant_0002", resource_version: 2,
    },
  }, {
    event_type: "invitation.created", payload: {
      invitation_id: "invitation_consultant_0002", membership_id: "membership_consultant_0001", status: "pending", resource_version: 1,
    },
  }, {
    event_type: "invitation.changed", payload: {
      invitation_id: "invitation_consultant_0002", membership_id: "membership_consultant_0001", status: "revoked", resource_version: 2,
    },
  }]);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events where actor_id = 'actor_company_admin'")).rows[0]?.count, 3);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 4);
});

test("reinviting expires a pending row with database time and concurrent attempts leave one new pending invitation", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  await seedCompany();
  const oldPayload = createPayload({ idempotency_key: "invite-expiry-old" });
  await createInvitation(dependencies(new Date("2026-08-01T00:00:00.000Z")), adminContext(), command(oldPayload));
  const nextA = createPayload({
    idempotency_key: "invite-expiry-next-a", invitation_id: "invitation_expiry_next_a",
    membership_id: "membership_expiry_next_a",
  });
  const nextB = createPayload({
    idempotency_key: "invite-expiry-next-b", invitation_id: "invitation_expiry_next_b",
    membership_id: "membership_expiry_next_b",
  });
  const outcomes = await Promise.allSettled([
    createInvitation(dependencies(), adminContext(), command(nextA)),
    createInvitation(dependencies(), adminContext(), command(nextB)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const rows = await administratorPool.query("select status, resource_version::int from identity_invitations order by created_at, invitation_id");
  assert.deepEqual(rows.rows.map((row) => row.status), ["expired", "pending"]);
  assert.equal(rows.rows[0]?.resource_version, 2);
  assert.equal((await administratorPool.query("select count(*)::int as count from identity_invitations where status = 'pending'")).rows[0]?.count, 1);
  const lifecycle = await administratorPool.query("select event_type, payload->>'status' as status from product_events order by occurred_at, event_type");
  assert.equal(lifecycle.rows.filter((row) => row.event_type === "invitation.changed" && row.status === "expired").length, 1);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 3);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 3);
});

test("consultant acceptance creates one Profile, admin acceptance creates none, and identical replay converges", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  const inspectInvitation = requiredFunction<InspectFunction>("inspectInvitation");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const acceptance = command(acceptPayload(created.invitation_secret as string));
  const accepted = await acceptInvitation(
    dependencies(),
    { actorId: "actor_consultant", normalizedEmail: "consultant@example.test", requestId: "request_accept", traceId: "trace_accept" },
    acceptance,
  );
  const replay = await acceptInvitation(
    dependencies(),
    { actorId: "actor_consultant", normalizedEmail: "consultant@example.test", requestId: "request_accept", traceId: "trace_accept" },
    acceptance,
  );
  assert.deepEqual(replay, accepted);
  await assert.rejects(
    inspectInvitation(dependencies(), created.invitation_secret as string),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND"
      && error.message === "RESOURCE_NOT_FOUND: Invitation was not found",
  );
  assert.equal((await administratorPool.query("select count(*)::int as count from profiles where profile_kind = 'consultant' and status = 'active'")).rows[0]?.count, 1);
  assert.deepEqual((await administratorPool.query("select roles, status, resource_version::int from memberships where membership_id = 'membership_consultant_0001'")).rows, [{
    roles: ["consultant"], status: "active", resource_version: 1,
  }]);

  await seedActor("actor_admin_target", "new-admin@example.test");
  const adminPayload = createPayload({
    idempotency_key: "invite-admin", invitation_id: "invitation_admin", membership_id: "membership_new_admin",
    normalized_email: "new-admin@example.test", role: "admin",
  });
  const adminInvite = await createInvitation(dependencies(), adminContext(), command(adminPayload));
  const adminAccept = acceptPayload(adminInvite.invitation_secret as string, {
    idempotency_key: "accept-admin", invitation_code: adminInvite.invitation_secret,
  });
  await acceptInvitation(
    dependencies(),
    { actorId: "actor_admin_target", normalizedEmail: "new-admin@example.test", requestId: "request_accept_admin", traceId: "trace_accept_admin" },
    command(adminAccept),
  );
  assert.equal((await administratorPool.query("select count(*)::int as count from profiles where owner_actor_id = 'actor_admin_target'")).rows[0]?.count, 0);
});

test("invitation acceptance participates in a caller-owned transaction", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));

  await assert.rejects(identityDb.transaction().execute(async (trx) => {
    await acceptInvitation({ ...dependencies(), transaction: trx }, {
      actorId: "actor_consultant", normalizedEmail: "consultant@example.test",
      requestId: "request_rollback", traceId: "trace_rollback",
    }, command(acceptPayload(created.invitation_secret as string)));
    throw new Error("deliberate caller rollback");
  }), /deliberate caller rollback/u);

  assert.deepEqual((await administratorPool.query(
    "select status, accepted_actor_id from identity_invitations where invitation_id = 'invitation_consultant_0001'",
  )).rows, [{ status: "pending", accepted_actor_id: null }]);
  assert.equal((await administratorPool.query(
    "select count(*)::int as count from memberships where membership_id = 'membership_consultant_0001'",
  )).rows[0]?.count, 0);
  assert.equal((await administratorPool.query(
    "select count(*)::int as count from profiles where owner_actor_id = 'actor_consultant'",
  )).rows[0]?.count, 0);
});

test("verified invitation acceptance enforces the exact bound invitation digest", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const secret = created.invitation_secret as string;
  const secretDigest = createHash("sha256").update(Buffer.from(secret, "base64url")).digest();

  await assert.rejects(acceptInvitation({
    ...dependencies(),
    verifiedInvitationBinding: {
      invitationId: "invitation_wrong", secretDigest, tenantId: "tenant_invitation",
      expectedResourceVersion: 1, role: "consultant",
    },
  }, {
    actorId: "actor_consultant", normalizedEmail: "consultant@example.test",
    requestId: "request_bound", traceId: "trace_bound",
  }, command(acceptPayload(secret))), (error: unknown) => (
    error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND"
  ));

  assert.equal((await administratorPool.query(
    "select count(*)::int as count from memberships where membership_id = 'membership_consultant_0001'",
  )).rows[0]?.count, 0);
});

test("accepted invitation replay by another Actor or provider-observed email conflicts", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  await seedActor("actor_other", "other@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const first = command(acceptPayload(created.invitation_secret as string));
  await acceptInvitation(dependencies(), {
    actorId: "actor_consultant", normalizedEmail: "consultant@example.test", requestId: "request_accept", traceId: "trace_accept",
  }, first);
  const nonIdenticalReplay = command(acceptPayload(created.invitation_secret as string, {
    idempotency_key: "accept-same-actor-new-command",
  }));
  await assert.rejects(
    acceptInvitation(dependencies(), {
      actorId: "actor_consultant", normalizedEmail: "consultant@example.test",
      requestId: "request_same_actor", traceId: "trace_same_actor",
    }, nonIdenticalReplay),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATE_TRANSITION",
  );
  const conflicting = command(acceptPayload(created.invitation_secret as string, { idempotency_key: "accept-other-actor" }));
  await assert.rejects(
    acceptInvitation(dependencies(), {
      actorId: "actor_other", normalizedEmail: "other@example.test", requestId: "request_other", traceId: "trace_other",
    }, conflicting),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATE_TRANSITION",
  );
  assert.equal((await administratorPool.query("select count(*)::int as count from memberships where membership_id = 'membership_consultant_0001'")).rows[0]?.count, 1);
});

test("concurrent accept and revoke reach one terminal invitation outcome without a partial Profile", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  const revokeInvitation = requiredFunction<CommandFunction>("revokeInvitation");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const accept = acceptInvitation(dependencies(), {
    actorId: "actor_consultant", normalizedEmail: "consultant@example.test", requestId: "request_race_accept", traceId: "trace_race_accept",
  }, command(acceptPayload(created.invitation_secret as string, { idempotency_key: "race-accept" })));
  const revokePayload = {
    schema_version: 1, idempotency_key: "race-revoke", tenant_id: "tenant_invitation",
    invitation_id: "invitation_consultant_0001", expected_resource_version: 1,
  };
  const outcomes = await Promise.allSettled([
    accept,
    revokeInvitation(dependencies(), adminContext(), command(revokePayload)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const invitation = await administratorPool.query("select status from identity_invitations");
  assert.match(invitation.rows[0]?.status, /^(accepted|revoked)$/u);
  const membershipCount = (await administratorPool.query("select count(*)::int as count from memberships where membership_id = 'membership_consultant_0001'")).rows[0]?.count;
  const profileCount = (await administratorPool.query("select count(*)::int as count from profiles where owner_actor_id = 'actor_consultant'")).rows[0]?.count;
  assert.equal(membershipCount, invitation.rows[0]?.status === "accepted" ? 1 : 0);
  assert.equal(profileCount, invitation.rows[0]?.status === "accepted" ? 1 : 0);
});

test("controlled concurrent accepted replay and suspension report both outcomes and one versioned terminal graph", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  const suspendMembership = requiredFunction<CommandFunction>("suspendMembership");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  const acceptance = command(acceptPayload(created.invitation_secret as string));
  const acceptContext = {
    actorId: "actor_consultant", normalizedEmail: "consultant@example.test", requestId: "request_accept", traceId: "trace_accept",
  };
  await acceptInvitation(dependencies(), acceptContext, acceptance);
  const suspendPayload = {
    schema_version: 1, idempotency_key: "suspend-accepted", tenant_id: "tenant_invitation",
    membership_id: "membership_consultant_0001", expected_resource_version: 1,
  };
  const blocker = await administratorPool.connect();
  await blocker.query("begin");
  await blocker.query("select actor_id from actors where actor_id = 'actor_consultant' for update");
  const pending = [
    acceptInvitation(dependencies(), acceptContext, acceptance),
    suspendMembership(dependencies(), adminContext(), command(suspendPayload)),
  ];
  await new Promise((resolve) => setTimeout(resolve, 50));
  await blocker.query("commit");
  blocker.release();
  const outcomes = await Promise.allSettled(pending);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 0);
  assert.deepEqual((await administratorPool.query(
    "select status, resource_version::int from memberships where membership_id = 'membership_consultant_0001'",
  )).rows, [{ status: "suspended", resource_version: 2 }]);
  assert.deepEqual((await administratorPool.query(
    "select status, resource_version::int from profiles where owner_actor_id = 'actor_consultant'",
  )).rows, [{ status: "suspended", resource_version: 2 }]);
  assert.deepEqual((await administratorPool.query(
    "select status, resource_version::int from identity_invitations where invitation_id = 'invitation_consultant_0001'",
  )).rows, [{ status: "accepted", resource_version: 2 }]);
  assert.equal((await administratorPool.query("select count(*)::int as count from memberships where membership_id = 'membership_consultant_0001'")).rows[0]?.count, 1);
  assert.equal((await administratorPool.query("select count(*)::int as count from profiles where owner_actor_id = 'actor_consultant'")).rows[0]?.count, 1);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 3);
  assert.equal((await administratorPool.query("select count(*)::int as count from product_events")).rows[0]?.count, 3);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 3);
});

test("identical Membership suspension replay converges without a second Profile transition", async () => {
  const createInvitation = requiredFunction<CommandFunction>("createInvitation");
  const acceptInvitation = requiredFunction<CommandFunction>("acceptInvitation");
  const suspendMembership = requiredFunction<CommandFunction>("suspendMembership");
  await seedCompany();
  await seedActor("actor_consultant", "consultant@example.test");
  const created = await createInvitation(dependencies(), adminContext(), command(createPayload()));
  await acceptInvitation(dependencies(), {
    actorId: "actor_consultant", normalizedEmail: "consultant@example.test", requestId: "request_accept", traceId: "trace_accept",
  }, command(acceptPayload(created.invitation_secret as string)));
  const suspendPayload = {
    schema_version: 1, idempotency_key: "suspend-replay", tenant_id: "tenant_invitation",
    membership_id: "membership_consultant_0001", expected_resource_version: 1,
  };
  const suspension = command(suspendPayload);
  const first = await suspendMembership(dependencies(), adminContext(), suspension);
  const replay = await suspendMembership(dependencies(), adminContext(), suspension);
  assert.deepEqual(replay, first);
  assert.deepEqual((await administratorPool.query("select status, resource_version::int from profiles where owner_actor_id = 'actor_consultant'")).rows, [{
    status: "suspended", resource_version: 2,
  }]);
});
