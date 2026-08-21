import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash } from "../src/domain/idempotency.js";

const runtime = await import("../src/index.js") as Record<string, unknown>;
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const now = new Date("2026-08-21T00:00:00.000Z");

type CatalogWrite = (dependencies: Record<string, unknown>, context: Record<string, unknown>, input: unknown) => Promise<Record<string, unknown>>;
function required(name: string): CatalogWrite {
  const value = runtime[name];
  assert.equal(typeof value, "function", `${name} must be exported`);
  return value as CatalogWrite;
}
function command<T extends Record<string, unknown>>(payload: T): T & { payload_hash: string } {
  return { ...payload, payload_hash: canonicalPayloadHash(payload) };
}
const context = Object.freeze({ performingActorId: "actor_catalog_admin", requestId: "request_catalog", traceId: "trace_catalog" });
const dependencies = Object.freeze({
  db: undefined as unknown,
  now: () => new Date(now),
  knownContractRefs: ["synthetic/catalog@1.0.0"],
  platformCompatibility: { core_contract_version: "0.7.0", runtime_protocol_version: "1.0.0" },
});
function capabilityPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1, idempotency_key: "capability-create", capability_id: "capability_catalog",
    capability_version_id: "capability_version_catalog", display_name: "Catalog capability", owning_domain: "synthetic",
    kind: "mcp", version: "1.0.0", artifact_ref: `manifest:sha256:${"a".repeat(64)}`,
    contract_ref: "synthetic/catalog@1.0.0", risk_class: "read", approval_requirement: "none",
    compatibility: { core_contract_version: "0.7.0", domain_contract_version: "1.0.0", runtime_protocol_version: "1.0.0", tenant_modes: ["b2b", "b2c"] },
    expected_resource_version: null, ...overrides,
  };
}
function packPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1, idempotency_key: "pack-create", pack_product_id: "pack_product_catalog", pack_version_id: "pack_version_catalog",
    display_name: "Catalog pack", tenant_modes: ["b2b", "b2c"], version: "1.0.0", expected_resource_version: null,
    members: [{ capability_id: "capability_catalog", capability_version_id: "capability_version_catalog", version: "1.0.0" }], ...overrides,
  };
}
async function reset(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await pool.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'core_agent_app') then create role core_agent_app login nosuperuser nocreatedb nocreaterole noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'core_agent_identity') then create role core_agent_identity login nosuperuser nocreatedb nocreaterole noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'core_agent_migrator') then create role core_agent_migrator nologin nosuperuser nocreatedb nocreaterole noinherit; end if;
  end $$`);
  await applyMigrations(pool, migrationsDirectory);
  await pool.query(`insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
    values ('tenant_catalog', 1, 1, 'b2b', 'active', 'Catalog authority', $1, $1)`, [now]);
  await pool.query(`insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
    values ('actor_catalog_admin', 1, 1, 'human', 'Catalog admin', 'active', $1, $1)`, [now]);
  await pool.query(`insert into platform_role_assignments (platform_role_assignment_id, actor_id, role, status, resource_version, created_at, updated_at)
    values ('platform_assignment_catalog', 'actor_catalog_admin', 'platform_super_admin', 'active', 1, $1, $1)`, [now]);
  const membershipId = `membership_platform_${createHash("sha256").update("actor_catalog_admin:tenant_catalog", "utf8").digest("hex").slice(0, 32)}`;
  await pool.query(`insert into memberships (tenant_id, membership_id, actor_id, schema_version, resource_version, roles, membership_source, seat_ref, status, created_at, updated_at)
    values ('tenant_catalog', $1, 'actor_catalog_admin', 1, 1, array['admin'], 'platform', null, 'active', $2, $2)`, [membershipId, now]);
}
test.beforeEach(reset);
test.after(async () => { await pool.end(); });

test("Capability draft creation replays exactly, conflicts on changed payload, and review freezes its executable metadata", async () => {
  const create = required("createCapabilityVersion");
  const review = required("reviewCapabilityVersion");
  const deps = { ...dependencies, db: (await import("../src/db/database.js")).createRuntimeDatabase(pool) };
  const created = await create(deps, context, command(capabilityPayload()));
  assert.deepEqual(await create(deps, context, command(capabilityPayload())), created);
  await assert.rejects(() => create(deps, context, command(capabilityPayload({ display_name: "Changed" }))), { code: "IDEMPOTENCY_CONFLICT" });
  const reviewed = await review(deps, context, command({ schema_version: 1, idempotency_key: "capability-review", capability_version_id: "capability_version_catalog", expected_resource_version: 1 }));
  assert.equal(reviewed.status, "reviewed");
  assert.match(String(reviewed.compatibility_hash), /^sha256:[a-f0-9]{64}$/u);
  await assert.rejects(() => review(deps, context, command({ schema_version: 1, idempotency_key: "capability-review-again", capability_version_id: "capability_version_catalog", expected_resource_version: 2 })), { code: "INVALID_STATE_TRANSITION" });
  const row = await pool.query("select artifact_ref, status, resource_version::int from capability_versions where capability_version_id = 'capability_version_catalog'");
  assert.deepEqual(row.rows, [{ artifact_ref: `manifest:sha256:${"a".repeat(64)}`, status: "reviewed", resource_version: 2 }]);
});

test("Pack publication persists a sorted immutable reviewed-member catalog, and retirement/blocking have no reverse transition", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload()));
  await required("reviewCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "capability-review", capability_version_id: "capability_version_catalog", expected_resource_version: 1 }));
  const createPack = required("createPackVersion"); const reviewPack = required("reviewPackVersion"); const publish = required("publishPackVersion");
  await createPack(deps, context, command(packPayload()));
  await reviewPack(deps, context, command({ schema_version: 1, idempotency_key: "pack-review", pack_version_id: "pack_version_catalog", expected_resource_version: 1 }));
  const published = await publish(deps, context, command({ schema_version: 1, idempotency_key: "pack-publish", pack_version_id: "pack_version_catalog", expected_resource_version: 2 }));
  assert.equal(published.status, "published");
  await required("retirePackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-retire", pack_version_id: "pack_version_catalog", expected_resource_version: 3 }));
  await required("blockPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-block", pack_version_id: "pack_version_catalog", expected_resource_version: 4 }));
  await assert.rejects(() => publish(deps, context, command({ schema_version: 1, idempotency_key: "pack-republish", pack_version_id: "pack_version_catalog", expected_resource_version: 5 })), { code: "INVALID_STATE_TRANSITION" });
  const rows = await pool.query("select status, resource_version::int from pack_versions where pack_version_id = 'pack_version_catalog'");
  assert.deepEqual(rows.rows, [{ status: "blocked", resource_version: 5 }]);
});

test("publication fails closed for unavailable member authority and preserves the draft", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload()));
  await required("createPackVersion")(deps, context, command(packPayload()));
  await required("reviewPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-review", pack_version_id: "pack_version_catalog", expected_resource_version: 1 }));
  await assert.rejects(() => required("publishPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-publish", pack_version_id: "pack_version_catalog", expected_resource_version: 2 })), { code: "INVALID_STATE_TRANSITION" });
  assert.deepEqual((await pool.query("select status from pack_versions where pack_version_id = 'pack_version_catalog'")).rows, [{ status: "reviewed" }]);
});

test("real PostgreSQL locking admits only one concurrent Capability review at its expected version", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload()));
  const review = required("reviewCapabilityVersion");
  const attempts = await Promise.allSettled([
    review(deps, context, command({ schema_version: 1, idempotency_key: "capability-review-race-a", capability_version_id: "capability_version_catalog", expected_resource_version: 1 })),
    review(deps, context, command({ schema_version: 1, idempotency_key: "capability-review-race-b", capability_version_id: "capability_version_catalog", expected_resource_version: 1 })),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.deepEqual((await pool.query("select status, resource_version::int from capability_versions where capability_version_id = 'capability_version_catalog'")).rows, [{ status: "reviewed", resource_version: 2 }]);
});
