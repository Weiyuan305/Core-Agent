import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
const now = new Date("2026-08-14T06:00:00.000Z");
let identityDb: Kysely<RuntimeDatabase>;

type PlatformMembershipId = (actorId: string, tenantId: string) => string;
type PlatformRoleAssignmentId = (actorId: string) => string;
type ProjectPlatformMemberships = (
  db: Kysely<RuntimeDatabase>, assignmentId: string, cursor: string | null, limit: number,
) => Promise<{ processed: number; nextCursor: string | null; done: boolean }>;
type PlatformRoleWrite = (
  dependencies: Record<string, unknown>, context: Record<string, unknown>, input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

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

async function seedActor(actorId: string): Promise<void> {
  await identityDb.insertInto("actors").values({
    actor_id: actorId, schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: actorId, status: "active", created_at: now, updated_at: now,
  }).execute();
}

async function seedTenants(count: number): Promise<void> {
  await identityDb.insertInto("tenants").values(Array.from({ length: count }, (_, index) => ({
    tenant_id: `tenant_platform_${String(index).padStart(3, "0")}`,
    schema_version: 1, resource_version: 1, tenant_mode: "b2b", status: "active",
    display_name: `Platform Tenant ${index}`, created_at: now, updated_at: now,
  }))).execute();
}

async function seedAssignment(status: "active" | "revoked" = "active", resourceVersion = 1): Promise<void> {
  await identityDb.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: "platform_assignment_projection", actor_id: "actor_platform_projection",
    role: "platform_super_admin", status, resource_version: resourceVersion, created_at: now, updated_at: now,
  }).execute();
}

async function seedPlatformAuthority(actorId: string, assignmentId: string, tenantIds: readonly string[]): Promise<void> {
  await identityDb.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: assignmentId, actor_id: actorId, role: "platform_super_admin",
    status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  if (tenantIds.length > 0) {
    for (const tenantId of tenantIds) await seedPlatformMembership(actorId, tenantId);
  }
}

async function seedPlatformMembership(actorId: string, tenantId: string): Promise<void> {
  await identityDb.insertInto("memberships").values({
    tenant_id: tenantId, membership_id: requiredFunction<PlatformMembershipId>("platformMembershipId")(actorId, tenantId),
    actor_id: actorId, schema_version: 1, resource_version: 1, roles: ["admin"],
    membership_source: "platform", seat_ref: null, status: "active", created_at: now, updated_at: now,
  }).execute();
}

function roleCommand(payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}

const roleContext = Object.freeze({
  performingActorId: "actor_platform_performer", requestId: "request_platform_role", traceId: "trace_platform_role",
});

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityDb = createRuntimeDatabase(new Pool({ connectionString: target.toString(), max: 8 }));
});

test.beforeEach(resetDatabase);

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("platform Membership IDs are deterministic and actor plus Tenant scoped", () => {
  const platformMembershipId = requiredFunction<PlatformMembershipId>("platformMembershipId");
  const expected = `membership_platform_${createHash("sha256")
    .update("actor_platform_projection:tenant_platform_000", "utf8").digest("hex").slice(0, 32)}`;
  assert.equal(platformMembershipId("actor_platform_projection", "tenant_platform_000"), expected);
  assert.notEqual(
    platformMembershipId("actor_platform_projection", "tenant_platform_000"),
    platformMembershipId("actor_platform_projection", "tenant_platform_001"),
  );
});

test("projector processes at most 100 Tenants and creates permanent no-seat platform admin Memberships with tenant audit/outbox", async () => {
  const projectPlatformMemberships = requiredFunction<ProjectPlatformMemberships>("projectPlatformMemberships");
  await seedActor("actor_platform_projection");
  await seedAssignment();
  await seedTenants(101);

  const first = await projectPlatformMemberships(identityDb, "platform_assignment_projection", null, 100);
  assert.deepEqual(first, { processed: 100, nextCursor: "tenant_platform_099", done: false });
  assert.equal((await administratorPool.query("select count(*)::int as count from memberships")).rows[0]?.count, 100);
  const invalid = await administratorPool.query(`select count(*)::int as count from memberships
    where roles <> array['admin']::text[] or membership_source <> 'platform' or seat_ref is not null or status <> 'active'`);
  assert.equal(invalid.rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from profiles")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 100);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 100);
  const audit = await administratorPool.query("select actor_id, membership_id, effective_role from audit_events order by tenant_id limit 1");
  assert.deepEqual(audit.rows, [{
    actor_id: "actor_platform_projection",
    membership_id: `membership_platform_${createHash("sha256").update("actor_platform_projection:tenant_platform_000").digest("hex").slice(0, 32)}`,
    effective_role: "admin",
  }]);

  const second = await projectPlatformMemberships(identityDb, "platform_assignment_projection", first.nextCursor, 100);
  assert.deepEqual(second, { processed: 1, nextCursor: null, done: true });
  const replay = await projectPlatformMemberships(identityDb, "platform_assignment_projection", null, 100);
  assert.deepEqual(replay, { processed: 100, nextCursor: "tenant_platform_099", done: false });
  assert.equal((await administratorPool.query("select count(*)::int as count from memberships")).rows[0]?.count, 101);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 101);
});

test("revoked platform authority projects revocation without deleting Membership or audit history", async () => {
  const projectPlatformMemberships = requiredFunction<ProjectPlatformMemberships>("projectPlatformMemberships");
  await seedActor("actor_platform_projection");
  await seedAssignment();
  await seedTenants(2);
  await projectPlatformMemberships(identityDb, "platform_assignment_projection", null, 100);
  await identityDb.updateTable("platform_role_assignments").set({
    status: "revoked", resource_version: 2, updated_at: new Date(now.getTime() + 1000),
  }).where("platform_role_assignment_id", "=", "platform_assignment_projection").execute();
  await projectPlatformMemberships(identityDb, "platform_assignment_projection", null, 100);
  const memberships = await administratorPool.query("select status, resource_version::int from memberships order by tenant_id");
  assert.deepEqual(memberships.rows, [
    { status: "revoked", resource_version: 2 }, { status: "revoked", resource_version: 2 },
  ]);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 4);
  await projectPlatformMemberships(identityDb, "platform_assignment_projection", null, 100);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 4);
});

test("platform role service requires PostgreSQL authority and commits idempotency, per-Tenant audit/event/outbox, and projection job atomically", async () => {
  const grantPlatformRole = requiredFunction<PlatformRoleWrite>("grantPlatformRole");
  const revokePlatformRole = requiredFunction<PlatformRoleWrite>("revokePlatformRole");
  await seedActor(roleContext.performingActorId);
  await seedActor("actor_platform_projection");
  await seedTenants(2);
  const targetAssignmentId = requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_platform_projection");
  const grantPayload = {
    schema_version: 1, idempotency_key: "platform-role-grant-0001",
    platform_role_assignment_id: targetAssignmentId, target_actor_id: "actor_platform_projection",
    expected_resource_version: null,
  };
  await assert.rejects(
    grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(grantPayload)),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );
  assert.equal((await administratorPool.query("select count(*)::int as count from platform_role_assignments")).rows[0]?.count, 0);

  await seedPlatformAuthority(roleContext.performingActorId, "platform_assignment_performer", ["tenant_platform_000", "tenant_platform_001"]);
  const granted = await grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(grantPayload));
  const replay = await grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(grantPayload));
  assert.deepEqual(replay, granted);
  assert.equal(granted.resource_version, 1);
  await assert.rejects(
    grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand({
      ...grantPayload, expected_resource_version: 1,
    })),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual((await administratorPool.query("select job_kind, payload_ref, status from worker_jobs")).rows, [{
    job_kind: "project_platform_memberships", payload_ref: targetAssignmentId, status: "queued",
  }]);
  assert.equal((await administratorPool.query("select count(*)::int as count from idempotency_records")).rows[0]?.count, 1);
  const events = await administratorPool.query("select tenant_id, event_type, payload from product_events order by tenant_id");
  assert.deepEqual(events.rows.map((row) => ({ ...row, payload: row.payload })), [
    { tenant_id: "tenant_platform_000", event_type: "platform_role.changed", payload: {
      platform_role_assignment_id: targetAssignmentId, actor_id: "actor_platform_projection", status: "active", resource_version: 1,
    } },
    { tenant_id: "tenant_platform_001", event_type: "platform_role.changed", payload: {
      platform_role_assignment_id: targetAssignmentId, actor_id: "actor_platform_projection", status: "active", resource_version: 1,
    } },
  ]);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events where actor_id = 'actor_platform_performer'")).rows[0]?.count, 2);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 2);

  const revokePayload = {
    schema_version: 1, idempotency_key: "platform-role-revoke-0001",
    platform_role_assignment_id: targetAssignmentId, target_actor_id: "actor_platform_projection",
    expected_resource_version: 1,
  };
  const revoked = await revokePlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 1000) }, roleContext, roleCommand(revokePayload));
  const revokeReplay = await revokePlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 2000) }, roleContext, roleCommand(revokePayload));
  assert.deepEqual(revokeReplay, revoked);
  assert.equal(revoked.resource_version, 2);
  assert.equal((await administratorPool.query("select count(*)::int as count from worker_jobs")).rows[0]?.count, 2);
  assert.equal((await administratorPool.query("select count(*)::int as count from product_events")).rows[0]?.count, 4);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 4);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 4);
  await assert.rejects(
    revokePlatformRole({ db: identityDb }, roleContext, roleCommand({ ...revokePayload, idempotency_key: "platform-role-revoke-stale" })),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
});

test("platform role replay keeps its earliest-created Tenant scope after a lexically smaller Tenant is added", async () => {
  const grantPlatformRole = requiredFunction<PlatformRoleWrite>("grantPlatformRole");
  await seedActor(roleContext.performingActorId);
  await seedActor("actor_scope_target");
  await identityDb.insertInto("tenants").values({
    tenant_id: "tenant_scope_z", schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: "Scope Z", created_at: now, updated_at: now,
  }).execute();
  await seedPlatformAuthority(roleContext.performingActorId, "platform_assignment_performer", ["tenant_scope_z"]);
  const assignmentId = requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_scope_target");
  const payload = {
    schema_version: 1, idempotency_key: "platform-role-stable-scope",
    platform_role_assignment_id: assignmentId, target_actor_id: "actor_scope_target", expected_resource_version: null,
  };
  const granted = await grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(payload));
  await identityDb.insertInto("tenants").values({
    tenant_id: "tenant_scope_a", schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: "Scope A", created_at: new Date(now.getTime() + 1000),
    updated_at: new Date(now.getTime() + 1000),
  }).execute();
  await seedPlatformMembership(roleContext.performingActorId, "tenant_scope_a");
  const replay = await grantPlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 2000) }, roleContext, roleCommand(payload));
  assert.deepEqual(replay, granted);
  assert.deepEqual((await administratorPool.query("select tenant_id from idempotency_records")).rows, [{ tenant_id: "tenant_scope_z" }]);
  assert.equal((await administratorPool.query("select count(*)::int as count from product_events")).rows[0]?.count, 1);
  assert.equal((await administratorPool.query("select count(*)::int as count from worker_jobs")).rows[0]?.count, 1);
});

test("zero-Tenant platform grant uses the approved bootstrap exception and later company creation projects it", async () => {
  const grantPlatformRole = requiredFunction<PlatformRoleWrite>("grantPlatformRole");
  const revokePlatformRole = requiredFunction<PlatformRoleWrite>("revokePlatformRole");
  const createB2bCompany = requiredFunction<PlatformRoleWrite>("createB2bCompany");
  await seedActor(roleContext.performingActorId);
  await seedActor("actor_first_target");
  await seedPlatformAuthority(roleContext.performingActorId, "platform_assignment_performer", []);
  const targetAssignmentId = requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_first_target");
  const payload = {
    schema_version: 1, idempotency_key: "platform-zero-tenant-grant",
    platform_role_assignment_id: targetAssignmentId, target_actor_id: "actor_first_target",
    expected_resource_version: null,
  };
  const first = await grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(payload));
  const replay = await grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(payload));
  assert.deepEqual(replay, first);
  const revokePayload = {
    ...payload, idempotency_key: "platform-zero-tenant-revoke", expected_resource_version: 1,
  };
  const revoked = await revokePlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 1000) }, roleContext, roleCommand(revokePayload));
  assert.deepEqual(revoked, {
    schema_version: 1, platform_role_assignment_id: targetAssignmentId,
    actor_id: "actor_first_target", status: "revoked", resource_version: 2,
  });
  assert.deepEqual(
    await revokePlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 2000) }, roleContext, roleCommand(revokePayload)),
    revoked,
  );
  const reactivatePayload = {
    ...payload, idempotency_key: "platform-zero-tenant-reactivate", expected_resource_version: 2,
  };
  const reactivated = await grantPlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 3000) }, roleContext, roleCommand(reactivatePayload));
  assert.deepEqual(reactivated, {
    schema_version: 1, platform_role_assignment_id: targetAssignmentId,
    actor_id: "actor_first_target", status: "active", resource_version: 3,
  });
  assert.deepEqual(
    await grantPlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 4000) }, roleContext, roleCommand(reactivatePayload)),
    reactivated,
  );
  await assert.rejects(
    grantPlatformRole({ db: identityDb }, roleContext, roleCommand({ ...reactivatePayload, expected_resource_version: 3 })),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  assert.equal((await administratorPool.query("select count(*)::int as count from worker_jobs")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from idempotency_records")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from product_events")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 0);

  const companyPayload = {
    schema_version: 1, idempotency_key: "platform-zero-company", tenant_id: "tenant_after_zero",
    display_name: "After Zero", invitation: {
      invitation_id: "invitation_after_zero", membership_id: "membership_after_zero",
      normalized_email: "admin@after-zero.test",
    },
  };
  await createB2bCompany({
    db: identityDb, emailHmacKey: Buffer.alloc(32, 0x45), now: () => new Date(now),
    randomBytes: (size: number) => Buffer.alloc(size, 0x46),
  }, { actorId: roleContext.performingActorId, requestId: "request_zero_company", traceId: "trace_zero_company" }, {
    ...companyPayload, payload_hash: canonicalPayloadHash(companyPayload),
  });
  assert.equal((await administratorPool.query("select count(*)::int as count from memberships where actor_id = 'actor_first_target' and membership_source = 'platform'")).rows[0]?.count, 1);
});

test("disabled platform target can be revoked and remains revoked after Actor reactivation", async () => {
  const grantPlatformRole = requiredFunction<PlatformRoleWrite>("grantPlatformRole");
  const revokePlatformRole = requiredFunction<PlatformRoleWrite>("revokePlatformRole");
  const projectPlatformMemberships = requiredFunction<ProjectPlatformMemberships>("projectPlatformMemberships");
  await seedActor(roleContext.performingActorId);
  await seedActor("actor_disabled_target");
  await seedTenants(1);
  await seedPlatformAuthority(roleContext.performingActorId, "platform_assignment_performer", ["tenant_platform_000"]);
  const assignmentId = requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_disabled_target");
  const grantPayload = {
    schema_version: 1, idempotency_key: "platform-disabled-target-grant",
    platform_role_assignment_id: assignmentId, target_actor_id: "actor_disabled_target", expected_resource_version: null,
  };
  await grantPlatformRole({ db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(grantPayload));
  await projectPlatformMemberships(identityDb, assignmentId, null, 100);
  await identityDb.updateTable("actors").set({ status: "disabled", resource_version: 2, updated_at: now })
    .where("actor_id", "=", "actor_disabled_target").execute();
  const revokePayload = {
    ...grantPayload, idempotency_key: "platform-disabled-target-revoke", expected_resource_version: 1,
  };
  const revoked = await revokePlatformRole({ db: identityDb, now: () => new Date(now.getTime() + 1000) }, roleContext, roleCommand(revokePayload));
  assert.equal(revoked.status, "revoked");
  await projectPlatformMemberships(identityDb, assignmentId, null, 100);
  assert.deepEqual((await administratorPool.query(
    "select status, resource_version::int from memberships where actor_id = 'actor_disabled_target'",
  )).rows, [{ status: "revoked", resource_version: 2 }]);
  await identityDb.updateTable("actors").set({ status: "active", resource_version: 3, updated_at: now })
    .where("actor_id", "=", "actor_disabled_target").execute();
  await projectPlatformMemberships(identityDb, assignmentId, null, 100);
  assert.deepEqual((await administratorPool.query(
    "select status, resource_version::int from memberships where actor_id = 'actor_disabled_target'",
  )).rows, [{ status: "revoked", resource_version: 2 }]);
});

test("platform role service hides a missing target and rejects a disabled performer", async () => {
  const revokePlatformRole = requiredFunction<PlatformRoleWrite>("revokePlatformRole");
  await seedActor(roleContext.performingActorId);
  await seedActor("actor_authority_target");
  await seedTenants(1);
  await seedPlatformAuthority(roleContext.performingActorId, "platform_assignment_performer", ["tenant_platform_000"]);
  const missingPayload = {
    schema_version: 1, idempotency_key: "platform-missing-target-revoke",
    platform_role_assignment_id: requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_missing_target"),
    target_actor_id: "actor_missing_target", expected_resource_version: 1,
  };
  await assert.rejects(
    revokePlatformRole({ db: identityDb }, roleContext, roleCommand(missingPayload)),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
  const targetAssignmentId = requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_authority_target");
  await identityDb.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: targetAssignmentId, actor_id: "actor_authority_target",
    role: "platform_super_admin", status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await identityDb.updateTable("actors").set({ status: "disabled", resource_version: 2, updated_at: now })
    .where("actor_id", "=", roleContext.performingActorId).execute();
  const revokePayload = {
    schema_version: 1, idempotency_key: "platform-disabled-performer-revoke",
    platform_role_assignment_id: targetAssignmentId, target_actor_id: "actor_authority_target", expected_resource_version: 1,
  };
  await assert.rejects(
    revokePlatformRole({ db: identityDb }, roleContext, roleCommand(revokePayload)),
    (error: unknown) => error instanceof DomainError && error.code === "UNAUTHENTICATED",
  );
});

test("platform role artifacts roll back with the assignment when projection enqueue fails", async () => {
  const grantPlatformRole = requiredFunction<PlatformRoleWrite>("grantPlatformRole");
  await seedActor(roleContext.performingActorId);
  await seedActor("actor_atomic_target");
  await seedTenants(1);
  await seedPlatformAuthority(roleContext.performingActorId, "platform_assignment_performer", ["tenant_platform_000"]);
  const assignmentId = requiredFunction<PlatformRoleAssignmentId>("platformRoleAssignmentId")("actor_atomic_target");
  const collisionJobId = `job_platform_${createHash("sha256").update(`${assignmentId}:1`).digest("hex").slice(0, 32)}`;
  await identityDb.insertInto("worker_jobs").values({
    tenant_id: "tenant_platform_000", job_id: collisionJobId, job_kind: "project_platform_memberships",
    status: "queued", attempt_count: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null,
    next_attempt_at: now, payload_ref: "different_assignment", runtime_command: null,
    target_command_version: null, effect_state: "pre_effect", last_error_summary: null,
    run_id: null, container_id: null, created_at: now, updated_at: now,
  }).execute();
  const payload = {
    schema_version: 1, idempotency_key: "platform-role-atomic",
    platform_role_assignment_id: assignmentId, target_actor_id: "actor_atomic_target", expected_resource_version: null,
  };
  await assert.rejects(grantPlatformRole(
    { db: identityDb, now: () => new Date(now) }, roleContext, roleCommand(payload),
  ));
  assert.equal((await administratorPool.query("select count(*)::int as count from platform_role_assignments where platform_role_assignment_id = $1", [assignmentId])).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from idempotency_records")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from audit_events")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from product_events")).rows[0]?.count, 0);
  assert.equal((await administratorPool.query("select count(*)::int as count from outbox")).rows[0]?.count, 0);
});

test("projector rejects unsafe cursors and limits before reading cross-Tenant state", async () => {
  const projectPlatformMemberships = requiredFunction<ProjectPlatformMemberships>("projectPlatformMemberships");
  for (const [cursor, limit] of [[null, 0], [null, 101], ["", 10], ["x".repeat(256), 10]] as const) {
    await assert.rejects(
      projectPlatformMemberships(identityDb, "platform_assignment_projection", cursor, limit),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
});
