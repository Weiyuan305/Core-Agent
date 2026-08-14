import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely, Transaction } from "kysely";
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
const now = new Date("2026-08-14T04:00:00.000Z");
const emailHmacKey = Buffer.from("task4-email-hmac-key-material-v1", "utf8");
let identityDb: Kysely<RuntimeDatabase>;

type CreateCompany = (
  dependencies: Record<string, unknown>, context: Record<string, unknown>, command: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type RoleCommand = (
  dependencies: Record<string, unknown>, context: Record<string, unknown>, command: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type LoadAuthority = (
  trx: Transaction<RuntimeDatabase>, actorId: string,
) => Promise<{ readonly memberships: readonly { readonly membershipId: string }[] }>;

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
  await administratorPool.query("drop schema public cascade; create schema public;");
  await applyMigrations(administratorPool, migrationsDirectory);
}

async function seedActor(actorId: string, displayName = actorId): Promise<void> {
  await identityDb.insertInto("actors").values({
    actor_id: actorId, schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: displayName, status: "active", created_at: now, updated_at: now,
  }).execute();
}

async function seedTenant(tenantId: string): Promise<void> {
  await identityDb.insertInto("tenants").values({
    tenant_id: tenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: tenantId, created_at: now, updated_at: now,
  }).execute();
}

async function seedMembership(input: {
  tenantId: string; membershipId: string; actorId: string; roles: string[];
  source?: "company" | "platform"; status?: "active" | "suspended" | "revoked";
}): Promise<void> {
  await identityDb.insertInto("memberships").values({
    tenant_id: input.tenantId, membership_id: input.membershipId, actor_id: input.actorId,
    schema_version: 1, resource_version: 1, roles: input.roles,
    membership_source: input.source ?? "company", seat_ref: null,
    status: input.status ?? "active", created_at: now, updated_at: now,
  }).execute();
}

function createCompanyCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = {
    schema_version: 1,
    idempotency_key: "create-b2b-company-0001",
    tenant_id: "tenant_company_0001",
    display_name: "Task Four Company",
    invitation: {
      invitation_id: "invitation_company_admin_0001",
      membership_id: "membership_company_admin_0001",
      normalized_email: "admin@company.test",
    },
    ...overrides,
  };
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

const platformContext = Object.freeze({
  actorId: "actor_platform_owner", requestId: "request_company_0001", traceId: "trace_company_0001",
});
const dependencies = () => ({
  db: identityDb, emailHmacKey, now: () => new Date(now),
  randomBytes: (size: number) => Buffer.alloc(size, 0x42),
});

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityDb = createRuntimeDatabase(new Pool({ connectionString: target.toString(), max: 6 }));
});

test.beforeEach(resetDatabase);

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("only a real platform_super_admin creates a B2B Tenant, permanent projections, and first admin invitation atomically", async () => {
  const createB2bCompany = requiredFunction<CreateCompany>("createB2bCompany");
  await seedActor(platformContext.actorId);
  await seedActor("actor_other_platform_admin");
  await identityDb.insertInto("platform_role_assignments").values([{
    platform_role_assignment_id: "platform_role_owner", actor_id: platformContext.actorId,
    role: "platform_super_admin", status: "active", resource_version: 1, created_at: now, updated_at: now,
  }, {
    platform_role_assignment_id: "platform_role_other", actor_id: "actor_other_platform_admin",
    role: "platform_super_admin", status: "active", resource_version: 1, created_at: now, updated_at: now,
  }]).execute();

  const command = createCompanyCommand();
  const first = await createB2bCompany(dependencies(), platformContext, command);
  const replay = await createB2bCompany(dependencies(), platformContext, command);

  assert.equal(first.tenant_id, "tenant_company_0001");
  assert.equal(typeof first.invitation_secret, "string");
  assert.equal(Object.hasOwn(replay, "invitation_secret"), false, "secret is returned once only");
  const tenant = await administratorPool.query("select tenant_mode, status from tenants");
  assert.deepEqual(tenant.rows, [{ tenant_mode: "b2b", status: "active" }]);
  const projected = await administratorPool.query(
    "select actor_id, roles, membership_source, seat_ref, status from memberships order by actor_id",
  );
  assert.deepEqual(projected.rows, [{
    actor_id: "actor_other_platform_admin", roles: ["admin"], membership_source: "platform", seat_ref: null, status: "active",
  }, {
    actor_id: "actor_platform_owner", roles: ["admin"], membership_source: "platform", seat_ref: null, status: "active",
  }]);
  const invitation = await administratorPool.query<{
    secret_digest: Buffer; normalized_email_hmac: Buffer; expires_at: Date; role: string; status: string;
  }>("select secret_digest, normalized_email_hmac, expires_at, role, status from identity_invitations");
  assert.equal(invitation.rows[0]?.secret_digest.length, 32);
  assert.deepEqual(invitation.rows[0]?.secret_digest, createHash("sha256").update(Buffer.alloc(32, 0x42)).digest());
  assert.deepEqual(invitation.rows[0]?.normalized_email_hmac, createHmac("sha256", emailHmacKey).update("admin@company.test").digest());
  assert.equal(invitation.rows[0]?.expires_at.toISOString(), "2026-08-21T04:00:00.000Z");
  assert.equal(invitation.rows[0]?.role, "admin");
  assert.equal(invitation.rows[0]?.status, "pending");
  assert.equal((await administratorPool.query("select count(*)::int as count from profiles")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 3);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 3);
});

test("platform claims without active Core PostgreSQL authority cannot create a company", async () => {
  const createB2bCompany = requiredFunction<CreateCompany>("createB2bCompany");
  await seedActor(platformContext.actorId);

  await assert.rejects(
    createB2bCompany(dependencies(), platformContext, createCompanyCommand()),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );
  assert.equal((await administratorPool.query("select count(*)::int as count from tenants")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from identity_invitations")).rows[0]?.count, 0);
});

test("consultant grant/remove contracts version Membership and Profile across create, suspend, and reactivate", async () => {
  const grantConsultantRole = requiredFunction<RoleCommand>("grantConsultantRole");
  const removeConsultantRole = requiredFunction<RoleCommand>("removeConsultantRole");
  await seedActor("actor_company_admin");
  await seedActor("actor_target_admin");
  await seedTenant("tenant_roles");
  await seedMembership({ tenantId: "tenant_roles", membershipId: "membership_admin", actorId: "actor_company_admin", roles: ["admin"] });
  await seedMembership({ tenantId: "tenant_roles", membershipId: "membership_target", actorId: "actor_target_admin", roles: ["admin"] });
  const context = { tenantId: "tenant_roles", actorId: "actor_company_admin", requestId: "request_roles", traceId: "trace_roles" };
  const roleDependencies = {
    db: identityDb, now: () => new Date(now),
    consultantProfile: { providerConfigId: "provider_consultant", modelId: "model_consultant" },
  };
  const addPayload = {
    schema_version: 1, idempotency_key: "roles-add-consultant", membership_id: "membership_target",
    expected_membership_resource_version: 1, grant_mode: "create_profile",
  };
  const add = { ...addPayload, payload_hash: canonicalPayloadHash(addPayload) };
  const added = await grantConsultantRole(roleDependencies, context, add);
  const replay = await grantConsultantRole(roleDependencies, context, add);
  assert.deepEqual(replay, added);
  const expectedProfileId = `profile_consultant_${createHash("sha256").update("actor_target_admin:tenant_roles").digest("hex").slice(0, 32)}`;
  assert.deepEqual(added, {
    schema_version: 1, membership_id: "membership_target", roles: ["admin", "consultant"],
    membership_resource_version: 2, profile_id: expectedProfileId,
    profile_resource_version: 1, profile_status: "active",
  });
  let profiles = await administratorPool.query("select profile_id, profile_kind, status, resource_version::int from profiles");
  assert.deepEqual(profiles.rows, [{
    profile_id: expectedProfileId,
    profile_kind: "consultant", status: "active", resource_version: 1,
  }]);

  const removePayload = {
    schema_version: 1, idempotency_key: "roles-remove-consultant", membership_id: "membership_target",
    expected_membership_resource_version: 2, profile_id: expectedProfileId,
    expected_profile_resource_version: 1,
  };
  const remove = {
    ...removePayload, payload_hash: canonicalPayloadHash(removePayload),
  };
  const removed = await removeConsultantRole(roleDependencies, context, remove);
  assert.deepEqual(await removeConsultantRole(roleDependencies, context, remove), removed);
  assert.deepEqual(removed, {
    schema_version: 1, membership_id: "membership_target", roles: ["admin"],
    membership_resource_version: 3, profile_id: expectedProfileId,
    profile_resource_version: 2, profile_status: "suspended",
  });
  profiles = await administratorPool.query("select profile_kind, status, resource_version::int from profiles");
  assert.deepEqual(profiles.rows, [{ profile_kind: "consultant", status: "suspended", resource_version: 2 }]);

  const staleProfile = {
    schema_version: 1, idempotency_key: "roles-reactivate-stale", membership_id: "membership_target",
    expected_membership_resource_version: 3, grant_mode: "reactivate_profile",
    profile_id: expectedProfileId, expected_profile_resource_version: 1,
  };
  await assert.rejects(
    grantConsultantRole(roleDependencies, context, { ...staleProfile, payload_hash: canonicalPayloadHash(staleProfile) }),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  const reactivate = { ...staleProfile, idempotency_key: "roles-reactivate", expected_profile_resource_version: 2 };
  const reactivated = await grantConsultantRole(roleDependencies, context, {
    ...reactivate, payload_hash: canonicalPayloadHash(reactivate),
  });
  assert.deepEqual(reactivated, {
    schema_version: 1, membership_id: "membership_target", roles: ["admin", "consultant"],
    membership_resource_version: 4, profile_id: expectedProfileId,
    profile_resource_version: 3, profile_status: "active",
  });
  assert.deepEqual(await grantConsultantRole(roleDependencies, context, {
    ...reactivate, payload_hash: canonicalPayloadHash(reactivate),
  }), reactivated);
  const staleMember = { ...removePayload, idempotency_key: "roles-remove-stale-member" };
  await assert.rejects(
    removeConsultantRole(roleDependencies, context, {
      ...staleMember, payload_hash: canonicalPayloadHash(staleMember),
    }),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  const loadActorIdentityAuthority = requiredFunction<LoadAuthority>("loadActorIdentityAuthority");
  const authority = await identityDb.transaction().execute((trx) => loadActorIdentityAuthority(trx, "actor_target_admin"));
  assert.deepEqual(authority.memberships.map((membership) => membership.membershipId), ["membership_target"]);
});

test("customer administrators cannot mutate source platform Memberships", async () => {
  const grantConsultantRole = requiredFunction<RoleCommand>("grantConsultantRole");
  await seedActor("actor_company_admin");
  await seedActor("actor_platform_target");
  await seedTenant("tenant_platform_immutable");
  await seedMembership({ tenantId: "tenant_platform_immutable", membershipId: "membership_admin", actorId: "actor_company_admin", roles: ["admin"] });
  await seedMembership({
    tenantId: "tenant_platform_immutable", membershipId: "membership_platform_target",
    actorId: "actor_platform_target", roles: ["admin"], source: "platform",
  });
  await identityDb.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: "platform_role_target", actor_id: "actor_platform_target",
    role: "platform_super_admin", status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  const payload = {
    schema_version: 1, idempotency_key: "platform-edit-forbidden", membership_id: "membership_platform_target",
    expected_membership_resource_version: 1, grant_mode: "create_profile",
  };
  await assert.rejects(
    grantConsultantRole(
      { db: identityDb, now: () => new Date(now), consultantProfile: { providerConfigId: "provider", modelId: "model" } },
      { tenantId: "tenant_platform_immutable", actorId: "actor_company_admin", requestId: "request", traceId: "trace" },
      { ...payload, payload_hash: canonicalPayloadHash(payload) },
    ),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATE_TRANSITION",
  );
});
