import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { createRuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";

export const entitlementTestNow = new Date("2026-08-24T00:00:00.000Z");

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

export const entitlementTestPool = new Pool({ connectionString: databaseUrl, max: 32 });
export const entitlementTestDatabase = createRuntimeDatabase(entitlementTestPool);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export interface TestAuthority {
  readonly performingActorId: string;
  readonly performingAuthSubjectId: string;
  readonly performingSessionId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export function digestHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function resetEntitlementTestDatabase(): Promise<void> {
  await entitlementTestPool.query("drop schema public cascade; create schema public;");
  await entitlementTestPool.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'core_agent_migrator') then create role core_agent_migrator nologin nosuperuser nocreatedb nocreaterole noinherit; end if;
  end $$`);
  await applyMigrations(entitlementTestPool, migrationsDirectory);
}

export async function seedPlatformAuthority(suffix = "primary"): Promise<TestAuthority> {
  const actorId = `actor_platform_${suffix}`;
  const authSubjectId = `subject_platform_${suffix}`;
  const sessionId = `session_platform_${suffix}`;
  const membershipId = `membership_platform_${suffix}`;
  await entitlementTestPool.query(
    `insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
     values ($1, 1, 1, 'human', 'Platform authority', 'active', $2, $2)`,
    [actorId, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into platform_role_assignments (platform_role_assignment_id, actor_id, role, status, resource_version, created_at, updated_at)
     values ($1, $2, 'platform_super_admin', 'active', 1, $3, $3)`,
    [`platform_role_${suffix}`, actorId, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into memberships (tenant_id, membership_id, actor_id, schema_version, resource_version, roles, membership_source, seat_ref, status, created_at, updated_at)
     values ('tenant_platform_authority', $1, $2, 1, 1, array['admin'], 'platform', null, 'active', $3, $3)`,
    [membershipId, actorId, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into auth_subjects (auth_subject_id, actor_id, provider, provider_subject, provider_identity_kind, verified_at, status, resource_version, created_at, updated_at)
     values ($1, $2, 'supabase', $3, 'email_password', $4, 'active', 1, $4, $4)`,
    [authSubjectId, actorId, `provider_${suffix}`, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into core_sessions (
       session_id, secret_digest, csrf_digest, actor_id, auth_subject_id, client_kind, status,
       device_label, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
       reauthenticated_at, revocation_reason, resource_version, updated_at
     ) values (
       $1, decode($2, 'hex'), null, $3, $4, 'web', 'active', 'Entitlement test',
       $5, $5, $6, $7, $5, null, 1, $5
     )`,
    [
      sessionId,
      digestHex(sessionId),
      actorId,
      authSubjectId,
      entitlementTestNow,
      new Date(entitlementTestNow.getTime() + 30 * 60_000),
      new Date(entitlementTestNow.getTime() + 24 * 60 * 60_000),
    ],
  );
  return Object.freeze({
    performingActorId: actorId,
    performingAuthSubjectId: authSubjectId,
    performingSessionId: sessionId,
    requestId: `request_${suffix}`,
    traceId: `trace_${suffix}`,
  });
}

export async function seedTenant(
  tenantId: string,
  tenantMode: "b2b" | "b2c",
  profileCount = 1,
): Promise<readonly string[]> {
  await entitlementTestPool.query(
    `insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
     values ($1, 1, 1, $2, 'active', $3, $4, $4)`,
    [tenantId, tenantMode, `Tenant ${tenantId}`, entitlementTestNow],
  );
  const profileIds: string[] = [];
  for (let index = 1; index <= profileCount; index += 1) {
    const actorId = `actor_${tenantId}_${index}`;
    const membershipId = `membership_${tenantId}_${index}`;
    const profileId = `profile_${tenantId}_${index}`;
    profileIds.push(profileId);
    await entitlementTestPool.query(
      `insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
       values ($1, 1, 1, 'human', $2, 'active', $3, $3)`,
      [actorId, `Actor ${index}`, entitlementTestNow],
    );
    await entitlementTestPool.query(
      `insert into memberships (tenant_id, membership_id, actor_id, schema_version, resource_version, roles, membership_source, seat_ref, status, created_at, updated_at)
       values ($1, $2, $3, 1, 1, $4, $5, null, 'active', $6, $6)`,
      [
        tenantId,
        membershipId,
        actorId,
        tenantMode === "b2b" ? ["admin", "consultant"] : ["student"],
        tenantMode === "b2b" ? "company" : "self",
        entitlementTestNow,
      ],
    );
    await entitlementTestPool.query(
      `insert into profiles (
         tenant_id, profile_id, schema_version, resource_version, owner_actor_id, profile_kind,
         hermes_profile_ref, description, status, provider_config_id, model_id, created_at, updated_at
       ) values ($1, $2, 1, 1, $3, $4, $2, 'Entitlement test profile', 'active', 'provider', 'model', $5, $5)`,
      [tenantId, profileId, actorId, tenantMode === "b2b" ? "consultant" : "default", entitlementTestNow],
    );
  }
  return Object.freeze(profileIds);
}

export async function seedPublishedPack(
  suffix: string,
  tenantModes: readonly ("b2b" | "b2c")[] = ["b2b", "b2c"],
  version = "1.0.0",
  productId = `pack_product_${suffix}`,
): Promise<{ readonly packProductId: string; readonly packVersionId: string; readonly capabilityId: string; readonly capabilityVersionId: string }> {
  const capabilityId = `capability_${suffix}`;
  const capabilityVersionId = `capability_version_${suffix}`;
  const packVersionId = `pack_version_${suffix}`;
  await entitlementTestPool.query(
    `insert into capabilities (capability_id, display_name, owning_domain, kind, resource_version, created_at, updated_at)
     values ($1, 'Entitlement test capability', 'synthetic', 'mcp', 1, $2, $2)`,
    [capabilityId, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into capability_versions (
       capability_version_id, capability_id, version, kind, artifact_ref, contract_ref,
       risk_class, approval_requirement, compatibility_json, status, resource_version, created_at, updated_at
     ) values ($1, $2, $3, 'mcp', $4, 'synthetic/entitlement@1.0.0', 'read', 'none', $5::jsonb, 'reviewed', 1, $6, $6)`,
    [
      capabilityVersionId,
      capabilityId,
      version,
      `manifest:sha256:${digestHex(capabilityVersionId)}`,
      JSON.stringify({ core_contract_version: "0.8.0", domain_contract_version: "1.0.0", runtime_protocol_version: "1.0.0", tenant_modes: tenantModes }),
      entitlementTestNow,
    ],
  );
  await entitlementTestPool.query(
    `insert into pack_products (pack_product_id, display_name, tenant_modes, resource_version, created_at, updated_at)
     values ($1, 'Entitlement test Pack', $2, 1, $3, $3)
     on conflict (pack_product_id) do nothing`,
    [productId, tenantModes, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into pack_versions (pack_version_id, pack_product_id, version, status, resource_version, created_at, updated_at)
     values ($1, $2, $3, 'draft', 1, $4, $4)`,
    [packVersionId, productId, version, entitlementTestNow],
  );
  await entitlementTestPool.query(
    `insert into pack_members (
       pack_member_id, pack_version_id, member_order, capability_id, capability_version_id,
       version, resource_version, created_at, updated_at
     ) values ($1, $2, 1, $3, $4, $5, 1, $6, $6)`,
    [`pack_member_${suffix}`, packVersionId, capabilityId, capabilityVersionId, version, entitlementTestNow],
  );
  await entitlementTestPool.query(
    "update pack_versions set status = 'reviewed', resource_version = 2, updated_at = $2 where pack_version_id = $1",
    [packVersionId, entitlementTestNow],
  );
  await entitlementTestPool.query(
    "update pack_versions set status = 'published', resource_version = 3, updated_at = $2 where pack_version_id = $1",
    [packVersionId, entitlementTestNow],
  );
  return Object.freeze({ packProductId: productId, packVersionId, capabilityId, capabilityVersionId });
}

