import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { DomainError } from "../src/domain/idempotency.js";

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
type ProjectPlatformMemberships = (
  db: Kysely<RuntimeDatabase>, assignmentId: string, cursor: string | null, limit: number,
) => Promise<{ processed: number; nextCursor: string | null; done: boolean }>;
type PlatformRoleWrite = (
  db: Kysely<RuntimeDatabase>, input: Record<string, unknown>,
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

test("platform role grant and revoke are optimistic and enqueue project_platform_memberships once per version", async () => {
  const grantPlatformRole = requiredFunction<PlatformRoleWrite>("grantPlatformRole");
  const revokePlatformRole = requiredFunction<PlatformRoleWrite>("revokePlatformRole");
  await seedActor("actor_platform_projection");
  await seedTenants(1);
  const grantInput = {
    assignmentId: "platform_assignment_projection", actorId: "actor_platform_projection", now,
  };
  const granted = await grantPlatformRole(identityDb, grantInput);
  const replay = await grantPlatformRole(identityDb, grantInput);
  assert.deepEqual(replay, granted);
  assert.equal(granted.resource_version, 1);
  assert.deepEqual((await administratorPool.query("select job_kind, payload_ref, status from worker_jobs")).rows, [{
    job_kind: "project_platform_memberships", payload_ref: "platform_assignment_projection", status: "queued",
  }]);
  const revoked = await revokePlatformRole(identityDb, {
    assignmentId: "platform_assignment_projection", actorId: "actor_platform_projection", expectedResourceVersion: 1,
    now: new Date(now.getTime() + 1000),
  });
  assert.equal(revoked.resource_version, 2);
  assert.equal((await administratorPool.query("select count(*)::int as count from worker_jobs")).rows[0]?.count, 2);
  await assert.rejects(
    revokePlatformRole(identityDb, {
      assignmentId: "platform_assignment_projection", actorId: "actor_platform_projection", expectedResourceVersion: 1,
      now: new Date(now.getTime() + 2000),
    }),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
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
