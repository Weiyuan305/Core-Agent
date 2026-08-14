import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { Kysely, Transaction } from "kysely";
import { Pool } from "pg";

import { createRuntimeDatabase, type RuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { loadActorIdentityAuthority } from "../src/repositories/identity/identity-authority.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const administratorPool = new Pool({ connectionString: databaseUrl });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const timestamp = new Date("2026-08-14T02:00:00.000Z");
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
  const client = await administratorPool.connect();
  try {
    await client.query("begin");
    await client.query("set local password_encryption = 'scram-sha-256'");
    await client.query("select set_config('core_agent.test_identity_password', $1, true)", [password ?? ""]);
    await client.query(`do $password$
      begin
        if current_setting('core_agent.test_identity_password') = '' then
          alter role core_agent_identity password null;
        else
          execute format(
            'alter role core_agent_identity password %L',
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

async function seedActor(trx: Transaction<RuntimeDatabase>, actorId: string, status: "active" | "disabled" = "active") {
  await trx.insertInto("actors").values({
    actor_id: actorId,
    schema_version: 1,
    resource_version: 1,
    actor_kind: "human",
    display_name: "Authority Student",
    status,
    created_at: timestamp,
    updated_at: timestamp,
  }).execute();
}

async function seedTenant(trx: Transaction<RuntimeDatabase>, tenantId: string, mode: "b2b" | "b2c") {
  await trx.insertInto("tenants").values({
    tenant_id: tenantId,
    schema_version: 1,
    resource_version: 1,
    tenant_mode: mode,
    status: "active",
    display_name: `Authority ${tenantId}`,
    created_at: timestamp,
    updated_at: timestamp,
  }).execute();
}

async function seedMembership(
  trx: Transaction<RuntimeDatabase>,
  input: {
    tenantId: string;
    membershipId: string;
    actorId: string;
    roles: string[];
    source: "self" | "company" | "platform";
    status?: "invited" | "active" | "suspended" | "revoked";
  },
) {
  await trx.insertInto("memberships").values({
    tenant_id: input.tenantId,
    membership_id: input.membershipId,
    actor_id: input.actorId,
    schema_version: 1,
    resource_version: 1,
    roles: input.roles,
    membership_source: input.source,
    seat_ref: null,
    status: input.status ?? "active",
    created_at: timestamp,
    updated_at: timestamp,
  }).execute();
}

async function seedProfile(
  trx: Transaction<RuntimeDatabase>,
  input: { tenantId: string; profileId: string; actorId: string; kind: "default" | "consultant" },
) {
  await trx.insertInto("profiles").values({
    tenant_id: input.tenantId,
    profile_id: input.profileId,
    schema_version: 1,
    resource_version: 1,
    owner_actor_id: input.actorId,
    profile_kind: input.kind,
    hermes_profile_ref: `hermes_${input.profileId}`,
    description: "Authority invariant profile",
    status: "active",
    provider_config_id: "provider_authority",
    model_id: "model_authority",
    created_at: timestamp,
    updated_at: timestamp,
  }).execute();
}

test.before(async () => {
  await ensureIdentityRoles();
  const password = randomBytes(32).toString("base64url");
  await setIdentityPassword(password);
  const target = new URL(databaseUrl);
  target.username = "core_agent_identity";
  target.password = password;
  identityDb = createRuntimeDatabase(new Pool({ connectionString: target.toString(), max: 4 }));
});

test.beforeEach(resetDatabase);

test.after(async () => {
  await identityDb?.destroy().catch(() => undefined);
  await setIdentityPassword(null).catch(() => undefined);
  await administratorPool.end();
});

test("loadActorIdentityAuthority derives and recursively freezes current authority from PostgreSQL", async () => {
  const authority = await identityDb.transaction().execute(async (trx) => {
    await seedActor(trx, "actor_authority", "disabled");
    await seedTenant(trx, "tenant_authority", "b2c");
    await seedMembership(trx, {
      tenantId: "tenant_authority",
      membershipId: "membership_authority",
      actorId: "actor_authority",
      roles: ["student"],
      source: "self",
    });
    await seedProfile(trx, {
      tenantId: "tenant_authority",
      profileId: "profile_authority",
      actorId: "actor_authority",
      kind: "default",
    });
    await trx.insertInto("platform_role_assignments").values({
      platform_role_assignment_id: "platform_role_authority",
      actor_id: "actor_authority",
      role: "platform_super_admin",
      status: "active",
      resource_version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }).execute();
    return loadActorIdentityAuthority(trx, "actor_authority");
  });

  assert.deepEqual(authority, {
    actorId: "actor_authority",
    actorStatus: "disabled",
    platformRoles: ["platform_super_admin"],
    memberships: [{
      membershipId: "membership_authority",
      tenantId: "tenant_authority",
      tenantMode: "b2c",
      source: "self",
      roles: ["student"],
      status: "active",
    }],
  });
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(authority.platformRoles), true);
  assert.equal(Object.isFrozen(authority.memberships), true);
  assert.equal(Object.isFrozen(authority.memberships[0]), true);
  assert.equal(Object.isFrozen(authority.memberships[0]?.roles), true);
  assert.throws(() => (authority.memberships as unknown[]).push({}), TypeError);
});

test("loadActorIdentityAuthority rejects duplicate active ordinary authority before deferred constraints commit", async () => {
  await assert.rejects(identityDb.transaction().execute(async (trx) => {
    await seedActor(trx, "actor_duplicate");
    await seedTenant(trx, "tenant_duplicate_a", "b2b");
    await seedTenant(trx, "tenant_duplicate_b", "b2b");
    await seedMembership(trx, {
      tenantId: "tenant_duplicate_a", membershipId: "membership_duplicate_a",
      actorId: "actor_duplicate", roles: ["consultant"], source: "company",
    });
    await seedMembership(trx, {
      tenantId: "tenant_duplicate_b", membershipId: "membership_duplicate_b",
      actorId: "actor_duplicate", roles: ["consultant"], source: "company",
    });
    await loadActorIdentityAuthority(trx, "actor_duplicate");
  }), /duplicate ordinary authority/i);
});

test("loadActorIdentityAuthority rejects non-student B2C authority", async () => {
  await assert.rejects(identityDb.transaction().execute(async (trx) => {
    await seedActor(trx, "actor_b2c_admin");
    await seedTenant(trx, "tenant_b2c_admin", "b2c");
    await seedMembership(trx, {
      tenantId: "tenant_b2c_admin", membershipId: "membership_b2c_admin",
      actorId: "actor_b2c_admin", roles: ["admin"], source: "company",
    });
    await loadActorIdentityAuthority(trx, "actor_b2c_admin");
  }), /B2C.*student/i);
});

test("loadActorIdentityAuthority rejects a second B2C Profile", async () => {
  await assert.rejects(identityDb.transaction().execute(async (trx) => {
    await seedActor(trx, "actor_b2c_profiles");
    await seedTenant(trx, "tenant_b2c_profiles", "b2c");
    await seedMembership(trx, {
      tenantId: "tenant_b2c_profiles", membershipId: "membership_b2c_profiles",
      actorId: "actor_b2c_profiles", roles: ["student"], source: "self",
    });
    await seedProfile(trx, {
      tenantId: "tenant_b2c_profiles", profileId: "profile_b2c_a",
      actorId: "actor_b2c_profiles", kind: "default",
    });
    await seedProfile(trx, {
      tenantId: "tenant_b2c_profiles", profileId: "profile_b2c_b",
      actorId: "actor_b2c_profiles", kind: "default",
    });
    await loadActorIdentityAuthority(trx, "actor_b2c_profiles");
  }), /second B2C Profile/i);
});

test("loadActorIdentityAuthority rejects a Profile without an active matching role", async () => {
  await assert.rejects(identityDb.transaction().execute(async (trx) => {
    await seedActor(trx, "actor_profile_role");
    await seedTenant(trx, "tenant_profile_role", "b2b");
    await seedMembership(trx, {
      tenantId: "tenant_profile_role", membershipId: "membership_profile_role",
      actorId: "actor_profile_role", roles: ["admin"], source: "company",
    });
    await seedProfile(trx, {
      tenantId: "tenant_profile_role", profileId: "profile_requires_consultant",
      actorId: "actor_profile_role", kind: "consultant",
    });
    await loadActorIdentityAuthority(trx, "actor_profile_role");
  }), /Profile without an active matching role/i);
});

test("loadActorIdentityAuthority rejects cross-Tenant resource references", async () => {
  await assert.rejects(identityDb.transaction().execute(async (trx) => {
    await seedActor(trx, "actor_cross_tenant");
    await seedTenant(trx, "tenant_cross_authority", "b2b");
    await seedTenant(trx, "tenant_cross_resource", "b2b");
    await seedMembership(trx, {
      tenantId: "tenant_cross_authority", membershipId: "membership_cross_tenant",
      actorId: "actor_cross_tenant", roles: ["consultant"], source: "company",
    });
    await seedProfile(trx, {
      tenantId: "tenant_cross_resource", profileId: "profile_cross_tenant",
      actorId: "actor_cross_tenant", kind: "consultant",
    });
    await loadActorIdentityAuthority(trx, "actor_cross_tenant");
  }), /cross-Tenant resource reference/i);
});
