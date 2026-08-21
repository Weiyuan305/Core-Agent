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
  assert.deepEqual((await pool.query("select (select count(*)::int from platform_authority_audit) as audits, (select count(*)::int from product_events) as events, (select count(*)::int from outbox) as outbox")).rows, [{ audits: 2, events: 2, outbox: 2 }]);
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

test("accepted catalog writes atomically append a safe lifecycle ProductEvent and Outbox entry without replay duplication", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const create = required("createCapabilityVersion");
  const created = await create(deps, context, command(capabilityPayload()));
  assert.deepEqual(await create(deps, context, command(capabilityPayload())), created);
  const counts = await pool.query(`select
    (select count(*)::int from capability_versions) as capabilities,
    (select count(*)::int from platform_authority_audit) as audits,
    (select count(*)::int from product_events) as events,
    (select count(*)::int from outbox) as outbox,
    (select count(*)::int from idempotency_records where status = 'completed') as idempotency`);
  assert.deepEqual(counts.rows, [{ capabilities: 1, audits: 1, events: 1, outbox: 1, idempotency: 1 }]);
  const event = await pool.query("select event_type, payload from product_events");
  assert.deepEqual(event.rows, [{ event_type: "catalog.capability.created", payload: { resource_id: "capability_version_catalog", resource_type: "capability_version", resource_version: 1, status: "draft" } }]);
});

test("wire-order customer modes hash before persistence normalization and duplicate catalog versions fail safely", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const createCapability = required("createCapabilityVersion");
  await createCapability(deps, context, command(capabilityPayload()));
  const duplicateCapability = command(capabilityPayload({ idempotency_key: "capability-duplicate-version", capability_version_id: "capability_version_catalog_other" }));
  await assert.rejects(() => createCapability(deps, context, duplicateCapability), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT" && !error.message.includes("capability_versions_capability_id_version_key"));
  const createPack = required("createPackVersion");
  const wireOrdered = packPayload({ idempotency_key: "pack-wire-order", tenant_modes: ["b2c", "b2b"] });
  await createPack(deps, context, command(wireOrdered));
  assert.deepEqual((await pool.query("select tenant_modes from pack_products where pack_product_id = 'pack_product_catalog'")).rows, [{ tenant_modes: ["b2b", "b2c"] }]);
  await assert.rejects(() => createPack(deps, context, command(packPayload({ idempotency_key: "pack-wire-order", tenant_modes: ["b2b", "b2c"] }))), { code: "IDEMPOTENCY_CONFLICT" });
  const duplicatePack = command(packPayload({ idempotency_key: "pack-duplicate-version", pack_version_id: "pack_version_catalog_other" }));
  await assert.rejects(() => createPack(deps, context, duplicatePack), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT" && !error.message.includes("pack_versions_product_version_key"));
});

test("catalog production commands reject unknown members, unknown contracts, incompatible metadata, and kind mismatch without provider disclosure", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const createCapability = required("createCapabilityVersion"); const createPack = required("createPackVersion");
  await assert.rejects(() => createPack(deps, context, command(packPayload({ members: [{ capability_id: "missing", capability_version_id: "missing_version", version: "1.0.0" }], idempotency_key: "unknown-member" }))), { code: "INVALID_STATE_TRANSITION" });
  await assert.rejects(() => createCapability(deps, context, command(capabilityPayload({ contract_ref: "synthetic/unknown@1.0.0", idempotency_key: "unknown-contract" }))), { code: "INVALID_STATE_TRANSITION" });
  await assert.rejects(() => createCapability(deps, context, command(capabilityPayload({ compatibility: { ...capabilityPayload().compatibility as object, runtime_protocol_version: "9.0.0" }, idempotency_key: "bad-protocol" }))), { code: "INVALID_STATE_TRANSITION" });
  await createCapability(deps, context, command(capabilityPayload()));
  const duplicateMember = packPayload({ idempotency_key: "duplicate-member", members: [packPayload().members[0], packPayload().members[0]] });
  await assert.rejects(() => createPack(deps, context, command(duplicateMember)), { code: "INVALID_REQUEST" });
  await assert.rejects(() => createCapability(deps, context, command(capabilityPayload({ capability_version_id: "capability_version_kind_mismatch", version: "2.0.0", kind: "skill", idempotency_key: "kind-mismatch" }))), { code: "INVALID_STATE_TRANSITION" });
});

test("Capability retirement and blocking are irreversible and blocking records the affected release as one bounded recomputation job", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload()));
  await required("reviewCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "review-for-block", capability_version_id: "capability_version_catalog", expected_resource_version: 1 }));
  await required("createPackVersion")(deps, context, command(packPayload()));
  await required("reviewPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "review-pack-for-block", pack_version_id: "pack_version_catalog", expected_resource_version: 1 }));
  await required("publishPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "publish-pack-for-block", pack_version_id: "pack_version_catalog", expected_resource_version: 2 }));
  await pool.query(`insert into tenant_pack_releases (tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version, generation, status, resource_version, created_at, updated_at)
    values ('release_catalog_block', 'tenant_catalog', 'pack_product_catalog', 'pack_version_catalog', '1.0.0', 1, 'preparing', 1, $1, $1)`, [now]);
  await pool.query("update tenant_pack_releases set status = 'current', resource_version = 2 where tenant_pack_release_id = 'release_catalog_block'");
  await required("blockCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "block-capability", capability_version_id: "capability_version_catalog", expected_resource_version: 2 }));
  assert.deepEqual((await pool.query("select tenant_id, payload_ref, job_kind, max_attempts from worker_jobs order by job_id")).rows, [{ tenant_id: "tenant_catalog", payload_ref: "release_catalog_block", job_kind: "reconcile_capability_projection", max_attempts: 5 }]);
  await assert.rejects(() => required("retireCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "retire-blocked", capability_version_id: "capability_version_catalog", expected_resource_version: 3 })), { code: "INVALID_STATE_TRANSITION" });
});

test("publication rejects blocked members, unsupported risks, and customer-mode mismatch", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const createCapability = required("createCapabilityVersion"); const reviewCapability = required("reviewCapabilityVersion"); const blockCapability = required("blockCapabilityVersion");
  const createPack = required("createPackVersion"); const reviewPack = required("reviewPackVersion"); const publish = required("publishPackVersion");
  const makePack = async (suffix: string, capabilityId: string, capabilityVersionId: string, modes: string[]) => {
    await createPack(deps, context, command(packPayload({ idempotency_key: `pack-${suffix}`, pack_product_id: `pack_product_${suffix}`, pack_version_id: `pack_version_${suffix}`, tenant_modes: modes, members: [{ capability_id: capabilityId, capability_version_id: capabilityVersionId, version: "1.0.0" }] })));
    await reviewPack(deps, context, command({ schema_version: 1, idempotency_key: `review-pack-${suffix}`, pack_version_id: `pack_version_${suffix}`, expected_resource_version: 1 }));
    await assert.rejects(() => publish(deps, context, command({ schema_version: 1, idempotency_key: `publish-pack-${suffix}`, pack_version_id: `pack_version_${suffix}`, expected_resource_version: 2 })), { code: "INVALID_STATE_TRANSITION" });
  };
  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "risk-create", capability_id: "capability_risk", capability_version_id: "capability_version_risk", risk_class: "external_write" })));
  await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: "risk-review", capability_version_id: "capability_version_risk", expected_resource_version: 1 }));
  await makePack("risk", "capability_risk", "capability_version_risk", ["b2b"]);
  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "mode-create", capability_id: "capability_mode", capability_version_id: "capability_version_mode", compatibility: { core_contract_version: "0.7.0", domain_contract_version: "1.0.0", runtime_protocol_version: "1.0.0", tenant_modes: ["b2b"] } })));
  await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: "mode-review", capability_version_id: "capability_version_mode", expected_resource_version: 1 }));
  await makePack("mode", "capability_mode", "capability_version_mode", ["b2c"]);
  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "blocked-create", capability_id: "capability_blocked", capability_version_id: "capability_version_blocked" })));
  await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: "blocked-review", capability_version_id: "capability_version_blocked", expected_resource_version: 1 }));
  await blockCapability(deps, context, command({ schema_version: 1, idempotency_key: "blocked-block", capability_version_id: "capability_version_blocked", expected_resource_version: 2 }));
  await makePack("blocked", "capability_blocked", "capability_version_blocked", ["b2b"]);
});
