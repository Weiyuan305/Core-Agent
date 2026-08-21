import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash } from "../src/domain/idempotency.js";
import { appendCatalogLifecycleEvent } from "../src/repositories/entitlements/catalog.js";

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
  catalogAuthorityTenantId: "tenant_catalog",
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
async function seedSecondPlatformActor(): Promise<typeof context> {
  await pool.query(`insert into actors (actor_id, schema_version, resource_version, actor_kind, display_name, status, created_at, updated_at)
    values ('actor_catalog_admin_two', 1, 1, 'human', 'Catalog admin two', 'active', $1, $1)`, [now]);
  await pool.query(`insert into platform_role_assignments (platform_role_assignment_id, actor_id, role, status, resource_version, created_at, updated_at)
    values ('platform_assignment_catalog_two', 'actor_catalog_admin_two', 'platform_super_admin', 'active', 1, $1, $1)`, [now]);
  await pool.query(`insert into memberships (tenant_id, membership_id, actor_id, schema_version, resource_version, roles, membership_source, seat_ref, status, created_at, updated_at)
    values ('tenant_catalog', 'membership_platform_catalog_two', 'actor_catalog_admin_two', 1, 1, array['admin'], 'platform', null, 'active', $1, $1)`, [now]);
  return Object.freeze({ performingActorId: "actor_catalog_admin_two", requestId: "request_catalog_two", traceId: "trace_catalog_two" });
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

test("catalog authority is the configured durable platform Tenant, never a sorted customer Membership", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  await pool.query(`insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
    values ('tenant_000_customer', 1, 1, 'b2b', 'active', 'Earlier customer', $1, $1)`, [now]);
  await pool.query(`insert into memberships (tenant_id, membership_id, actor_id, schema_version, resource_version, roles, membership_source, seat_ref, status, created_at, updated_at)
    values ('tenant_000_customer', 'membership_customer_platform', 'actor_catalog_admin', 1, 1, array['admin'], 'platform', null, 'active', $1, $1)`, [now]);
  const create = required("createCapabilityVersion");
  const created = await create(deps, context, command(capabilityPayload()));
  assert.deepEqual((await pool.query("select authority_tenant_id from platform_authority_audit")).rows, [{ authority_tenant_id: "tenant_catalog" }]);
  assert.deepEqual((await pool.query("select tenant_id from product_events")).rows, [{ tenant_id: "tenant_catalog" }]);
  await pool.query("update memberships set status = 'revoked' where tenant_id = 'tenant_000_customer'");
  assert.deepEqual(await create(deps, context, command(capabilityPayload())), created);
  assert.deepEqual((await pool.query("select tenant_id from idempotency_records")).rows, [{ tenant_id: "tenant_catalog" }]);
  await assert.rejects(() => create({ ...deps, catalogAuthorityTenantId: "tenant_missing" }, context, command(capabilityPayload({ idempotency_key: "missing-scope" }))), { code: "UNAUTHENTICATED" });
  await assert.rejects(() => create({ db: database, now: dependencies.now, knownContractRefs: dependencies.knownContractRefs, platformCompatibility: dependencies.platformCompatibility }, context, command(capabilityPayload({ idempotency_key: "unset-scope" }))), { code: "INVALID_REQUEST" });
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
  const contextTwo = await seedSecondPlatformActor();
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload()));
  const review = required("reviewCapabilityVersion");
  const attempts = await Promise.allSettled([
    review(deps, context, command({ schema_version: 1, idempotency_key: "capability-review-race-a", capability_version_id: "capability_version_catalog", expected_resource_version: 1 })),
    review(deps, contextTwo, command({ schema_version: 1, idempotency_key: "capability-review-race-b", capability_version_id: "capability_version_catalog", expected_resource_version: 1 })),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.deepEqual((await pool.query("select status, resource_version::int from capability_versions where capability_version_id = 'capability_version_catalog'")).rows, [{ status: "reviewed", resource_version: 2 }]);
});

test("two platform Actors concurrently create first shared families/products and map submitted-ID races without provider errors", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const contextTwo = await seedSecondPlatformActor();
  const createCapability = required("createCapabilityVersion"); const createPack = required("createPackVersion");
  const capabilityAttempts = await Promise.allSettled([
    createCapability(deps, context, command(capabilityPayload({ idempotency_key: "family-one", capability_id: "capability_family_race", capability_version_id: "capability_version_family_one", version: "1.0.0" }))),
    createCapability(deps, contextTwo, command(capabilityPayload({ idempotency_key: "family-two", capability_id: "capability_family_race", capability_version_id: "capability_version_family_two", version: "1.0.1" }))),
  ]);
  assert.equal(capabilityAttempts.filter((attempt) => attempt.status === "fulfilled").length, 2);
  const packAttempts = await Promise.allSettled([
    createPack(deps, context, command(packPayload({ idempotency_key: "product-one", pack_product_id: "pack_product_race", pack_version_id: "pack_version_product_one", version: "1.0.0", members: [{ capability_id: "capability_family_race", capability_version_id: "capability_version_family_one", version: "1.0.0" }] }))),
    createPack(deps, contextTwo, command(packPayload({ idempotency_key: "product-two", pack_product_id: "pack_product_race", pack_version_id: "pack_version_product_two", version: "1.0.1", members: [{ capability_id: "capability_family_race", capability_version_id: "capability_version_family_two", version: "1.0.1" }] }))),
  ]);
  assert.equal(packAttempts.filter((attempt) => attempt.status === "fulfilled").length, 2);
  const submittedIdRace = await Promise.allSettled([
    createCapability(deps, context, command(capabilityPayload({ idempotency_key: "id-race-one", capability_id: "capability_id_race_one", capability_version_id: "capability_version_submitted_race", version: "2.0.0" }))),
    createCapability(deps, contextTwo, command(capabilityPayload({ idempotency_key: "id-race-two", capability_id: "capability_id_race_two", capability_version_id: "capability_version_submitted_race", version: "2.0.0" }))),
  ]);
  assert.equal(submittedIdRace.filter((attempt) => attempt.status === "fulfilled").length, 1);
  const rejected = submittedIdRace.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
  assert.equal((rejected.reason as { code?: string }).code, "IDEMPOTENCY_CONFLICT");
  assert(!String(rejected.reason).includes("23505"));
});

test("Runtime, Contracts, and schema-13 immutable-artifact admission agree at exact boundary cases", async () => {
  const validateImmutableArtifactRef = runtime.validateImmutableArtifactRef as (value: unknown) => string;
  const digest = Buffer.alloc(64, 0x61).toString("base64");
  const artifacts = [
    `npm:${"a".repeat(214)}@1.0.0#sha512-${digest}`,
    `oci:registry.example:5000/repository/path@sha256:${"a".repeat(64)}`,
    `oci:registry.example.invalid/repository@sha256:${"a".repeat(64)}`,
    `oci:registry.example/repository@sha256:${"A".repeat(64)}`,
  ];
  const Schema = (await import("typebox/schema")).default;
  const { ImmutableArtifactRefSchema } = await import("@core-agent/contracts");
  for (const artifact of artifacts) {
    const contracts = Schema.Check(ImmutableArtifactRefSchema, artifact);
    const runtimeAccepted = (() => { try { validateImmutableArtifactRef(artifact); return true; } catch { return false; } })();
    const databaseAccepted = (await pool.query("select core_agent_is_immutable_artifact_ref($1) as accepted", [artifact])).rows[0]?.accepted;
    assert.equal(runtimeAccepted, contracts, artifact); assert.equal(databaseAccepted, contracts, artifact);
  }
});

test("released Contracts artifact grammar is accepted by Runtime and PostgreSQL at the same long and dotted OCI boundaries", async () => {
  const validateImmutableArtifactRef = runtime.validateImmutableArtifactRef as (value: unknown) => string;
  const digest = "a".repeat(64);
  const longQualifiedRegistry = Array.from({ length: 17 }, () => "a".repeat(63)).join(".");
  const artifacts = [
    `oci:registry.example@sha256:${digest}`,
    `oci:${longQualifiedRegistry}/repository@sha256:${digest}`,
  ];
  const Schema = (await import("typebox/schema")).default;
  const { ImmutableArtifactRefSchema } = await import("@core-agent/contracts");
  const results = await Promise.all(artifacts.map(async (artifact) => ({
    contracts: Schema.Check(ImmutableArtifactRefSchema, artifact),
    runtime: (() => { try { validateImmutableArtifactRef(artifact); return true; } catch { return false; } })(),
    database: (await pool.query("select core_agent_is_immutable_artifact_ref($1) as accepted", [artifact])).rows[0]?.accepted,
  })));
  assert.deepEqual(results, [
    { contracts: true, runtime: true, database: true },
    { contracts: true, runtime: true, database: true },
  ]);
});

test("two Actor create and publish wait on the same UTF-8-first Capability Version lock", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const contextTwo = await seedSecondPlatformActor();
  const createCapability = required("createCapabilityVersion");
  const reviewCapability = required("reviewCapabilityVersion");
  // Capability identity order is a,z while Version identity order is a,z in
  // the opposite pairing.  The old create path followed member order and
  // therefore waited on the z Version while publish waited on the a Version.
  const memberA = { capability_id: "capability_lock_a", capability_version_id: "capability_version_lock_z", version: "1.0.0" };
  const memberZ = { capability_id: "capability_lock_z", capability_version_id: "capability_version_lock_a", version: "1.0.0" };
  for (const [index, member] of [memberA, memberZ].entries()) {
    await createCapability(deps, context, command(capabilityPayload({ ...member, idempotency_key: `lock-capability-create-${index}` })));
    await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: `lock-capability-review-${index}`, capability_version_id: member.capability_version_id, expected_resource_version: 1 }));
  }
  const createPack = required("createPackVersion");
  const reviewPack = required("reviewPackVersion");
  const publishPack = required("publishPackVersion");
  await createPack(deps, context, command(packPayload({ idempotency_key: "lock-existing-create", pack_product_id: "pack_product_lock_existing", pack_version_id: "pack_version_lock_existing", members: [memberZ, memberA] })));
  await reviewPack(deps, context, command({ schema_version: 1, idempotency_key: "lock-existing-review", pack_version_id: "pack_version_lock_existing", expected_resource_version: 1 }));

  const firstBlocker = await pool.connect();
  const inverseBlocker = await pool.connect();
  let firstOpen = false;
  let inverseOpen = false;
  try {
    await firstBlocker.query("begin"); firstOpen = true;
    await inverseBlocker.query("begin"); inverseOpen = true;
    await firstBlocker.query("select capability_version_id from capability_versions where capability_version_id = $1 for update", [memberZ.capability_version_id]);
    await inverseBlocker.query("select capability_version_id from capability_versions where capability_version_id = $1 for update", [memberA.capability_version_id]);

    const publish = publishPack(deps, contextTwo, command({ schema_version: 1, idempotency_key: "lock-publish", pack_version_id: "pack_version_lock_existing", expected_resource_version: 2 }));
    const create = createPack(deps, context, command(packPayload({ idempotency_key: "lock-create", pack_product_id: "pack_product_lock_new", pack_version_id: "pack_version_lock_new", members: [memberA, memberZ] })));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const waiting = await pool.query(`select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%capability_versions%'`);
      if (waiting.rows[0]?.count === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const waiting = await pool.query(`select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query like '%capability_versions%'`);
    assert.equal(waiting.rows[0]?.count, 2, "both production transactions must wait at a Capability Version row");

    // Releasing the old create-path candidate must leave it lockable: both
    // production transactions are still waiting on memberZ's byte-first ID.
    await inverseBlocker.query("commit"); inverseOpen = false;
    const probe = await pool.connect();
    try {
      await probe.query("begin");
      await assert.doesNotReject(() => probe.query("select capability_version_id from capability_versions where capability_version_id = $1 for update nowait", [memberA.capability_version_id]));
      await probe.query("rollback");
    } finally { probe.release(); }

    await firstBlocker.query("commit"); firstOpen = false;
    const [published, created] = await Promise.all([publish, create]);
    assert.equal(published.status, "published");
    assert.equal(created.status, "draft");
    assert.deepEqual((await pool.query("select capability_version_id from pack_members where pack_version_id = 'pack_version_lock_new' order by member_order")).rows, [
      { capability_version_id: memberA.capability_version_id },
      { capability_version_id: memberZ.capability_version_id },
    ]);
  } finally {
    if (inverseOpen) await inverseBlocker.query("rollback").catch(() => undefined);
    if (firstOpen) await firstBlocker.query("rollback").catch(() => undefined);
    inverseBlocker.release(); firstBlocker.release();
  }
});

test("two platform Actors create reversed multi-member Packs without deadlock and persist UTF-8 canonical member order", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const createCapability = required("createCapabilityVersion");
  const contextTwo = await seedSecondPlatformActor();
  const first = { capability_id: "capability_sorted_\uE000", capability_version_id: "capability_version_sorted_\uE000", version: "1.0.0" };
  const second = { capability_id: "capability_sorted_\u{10000}", capability_version_id: "capability_version_sorted_\u{10000}", version: "1.0.0" };
  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "sorted-one", ...first })));
  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "sorted-two", ...second })));
  const createPack = required("createPackVersion");
  const attempts = await Promise.allSettled([
    createPack(deps, context, command(packPayload({ idempotency_key: "pack-sorted-one", pack_product_id: "pack_product_sorted_one", pack_version_id: "pack_version_sorted_one", members: [second, first] }))),
    createPack(deps, contextTwo, command(packPayload({ idempotency_key: "pack-sorted-two", pack_product_id: "pack_product_sorted_two", pack_version_id: "pack_version_sorted_two", members: [first, second] }))),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 2);
  assert.deepEqual((await pool.query("select capability_version_id, member_order from pack_members order by pack_version_id, member_order")).rows, [
    { capability_version_id: "capability_version_sorted_", member_order: 1 },
    { capability_version_id: "capability_version_sorted_𐀀", member_order: 2 },
    { capability_version_id: "capability_version_sorted_", member_order: 1 },
    { capability_version_id: "capability_version_sorted_𐀀", member_order: 2 },
  ]);
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
  assert.deepEqual(event.rows, [{ event_type: "capability_version.created", payload: { capability_version_id: "capability_version_catalog", capability_id: "capability_catalog", resource_version: 1, status: "draft" } }]);
  const readEventsAfter = runtime.readEventsAfter as (context: { db: unknown; tenantId: string }, streamId: string, after: number) => Promise<unknown>;
  await assert.doesNotReject(() => readEventsAfter({ db: database, tenantId: "tenant_catalog" }, "capability_version_catalog", 0));
});

test("native PostgreSQL reader reconstructs every closed catalog lifecycle branch and exact replays do not append twice", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const readEventsAfter = runtime.readEventsAfter as (context: { db: unknown; tenantId: string }, streamId: string, after: number) => Promise<readonly { event_type: string; payload: Record<string, unknown> }[]>;
  const eventTypes = async (streamId: string) => (await readEventsAfter({ db: database, tenantId: "tenant_catalog" }, streamId, 0)).map((event) => event.event_type);

  const createCapability = required("createCapabilityVersion");
  const reviewCapability = required("reviewCapabilityVersion");
  const retireCapability = required("retireCapabilityVersion");
  const blockCapability = required("blockCapabilityVersion");
  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "reader-capability-retire-create", capability_id: "capability_reader_retire", capability_version_id: "capability_version_reader_retire" })));
  await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: "reader-capability-retire-review", capability_version_id: "capability_version_reader_retire", expected_resource_version: 1 }));
  await retireCapability(deps, context, command({ schema_version: 1, idempotency_key: "reader-capability-retire", capability_version_id: "capability_version_reader_retire", expected_resource_version: 2 }));
  assert.deepEqual(await eventTypes("capability_version_reader_retire"), ["capability_version.created", "capability_version.reviewed", "capability_version.retired"]);

  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "reader-capability-block-create", capability_id: "capability_reader_block", capability_version_id: "capability_version_reader_block" })));
  await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: "reader-capability-block-review", capability_version_id: "capability_version_reader_block", expected_resource_version: 1 }));
  await blockCapability(deps, context, command({ schema_version: 1, idempotency_key: "reader-capability-block", capability_version_id: "capability_version_reader_block", expected_resource_version: 2 }));
  assert.deepEqual(await eventTypes("capability_version_reader_block"), ["capability_version.created", "capability_version.reviewed", "capability_version.blocked"]);

  await createCapability(deps, context, command(capabilityPayload({ idempotency_key: "reader-capability-pack-create", capability_id: "capability_reader_pack", capability_version_id: "capability_version_reader_pack" })));
  await reviewCapability(deps, context, command({ schema_version: 1, idempotency_key: "reader-capability-pack-review", capability_version_id: "capability_version_reader_pack", expected_resource_version: 1 }));

  const createPack = required("createPackVersion");
  const reviewPack = required("reviewPackVersion");
  const publishPack = required("publishPackVersion");
  const retirePack = required("retirePackVersion");
  const blockPack = required("blockPackVersion");
  const packCreate = command(packPayload({ idempotency_key: "reader-pack-create", pack_product_id: "pack_product_reader", pack_version_id: "pack_version_reader", members: [{ capability_id: "capability_reader_pack", capability_version_id: "capability_version_reader_pack", version: "1.0.0" }] }));
  await createPack(deps, context, packCreate);
  await assert.doesNotReject(() => createPack(deps, context, packCreate));
  await reviewPack(deps, context, command({ schema_version: 1, idempotency_key: "reader-pack-review", pack_version_id: "pack_version_reader", expected_resource_version: 1 }));
  await publishPack(deps, context, command({ schema_version: 1, idempotency_key: "reader-pack-publish", pack_version_id: "pack_version_reader", expected_resource_version: 2 }));
  await retirePack(deps, context, command({ schema_version: 1, idempotency_key: "reader-pack-retire", pack_version_id: "pack_version_reader", expected_resource_version: 3 }));
  await blockPack(deps, context, command({ schema_version: 1, idempotency_key: "reader-pack-block", pack_version_id: "pack_version_reader", expected_resource_version: 4 }));
  assert.deepEqual(await eventTypes("pack_version_reader"), ["pack_version.created", "pack_version.reviewed", "pack_version.published", "pack_version.retired", "pack_version.blocked"]);
});

test("catalog lifecycle audit, ProductEvent, Outbox, and public failures do not disclose a command canary", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  const canary = "catalog-canary-never-persisted-in-event";
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload({ display_name: canary })));
  const visible = await pool.query(`select
    (select count(*)::int from platform_authority_audit where concat_ws(' ', action, reason_summary, change_summary, request_id, trace_id) like $1) as audit_count,
    (select count(*)::int from audit_events where event_json::text like $1) as audit_event_count,
    (select count(*)::int from product_events where payload::text like $1) as event_count,
    (select count(*)::int from outbox where concat_ws(' ', outbox_id, event_id, delivery_target, status, last_error_summary) like $1) as outbox_count`, [`%${canary}%`]);
  assert.deepEqual(visible.rows, [{ audit_count: 0, audit_event_count: 0, event_count: 0, outbox_count: 0 }]);
  await assert.rejects(
    () => required("createCapabilityVersion")(deps, context, command(capabilityPayload({ idempotency_key: "canary-error", contract_ref: `synthetic/${canary}@1.0.0` }))),
    (error: unknown) => error instanceof Error && !error.message.includes(canary) && !JSON.stringify(error).includes(canary),
  );
});

test("validated catalog append rejects an unknown canary before allocating a reader cursor or Outbox wakeup", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const canary = "catalog-canary-unrecognized-event";
  await database.transaction().execute(async (trx) => {
    await assert.rejects(
      () => appendCatalogLifecycleEvent(trx, {
        tenantId: "tenant_catalog", eventId: "event_catalog_canary", streamId: "stream_catalog_canary",
        eventType: canary, resourceType: "capability_version", resourceId: "capability_version_canary",
        resourceVersion: 1, requestId: "request_catalog", traceId: "trace_catalog", occurredAt: now,
      }),
      (error: unknown) => error instanceof Error && !error.message.includes(canary),
    );
  });
  const writes = await pool.query(`select
    (select count(*)::int from stream_sequences where stream_id = 'stream_catalog_canary') as sequences,
    (select count(*)::int from product_events where stream_id = 'stream_catalog_canary') as events,
    (select count(*)::int from outbox where event_id = 'event_catalog_canary') as outbox`);
  assert.deepEqual(writes.rows, [{ sequences: 0, events: 0, outbox: 0 }]);
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
  await pool.query(`insert into tenant_pack_releases (tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version, generation, status, resource_version, created_at, updated_at)
    values ('release_catalog_failed', 'tenant_catalog', 'pack_product_catalog', 'pack_version_catalog', '1.0.0', 2, 'preparing', 1, $1, $1)`, [now]);
  await pool.query("update tenant_pack_releases set status = 'failed', resource_version = 2 where tenant_pack_release_id = 'release_catalog_failed'");
  await pool.query(`insert into tenants (tenant_id, schema_version, resource_version, tenant_mode, status, display_name, created_at, updated_at)
    values ('tenant_catalog_history', 1, 1, 'b2b', 'active', 'Catalog history', $1, $1)`, [now]);
  await pool.query(`insert into tenant_pack_releases (tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version, generation, status, resource_version, created_at, updated_at)
    values ('release_catalog_superseded', 'tenant_catalog_history', 'pack_product_catalog', 'pack_version_catalog', '1.0.0', 1, 'preparing', 1, $1, $1)`, [now]);
  await pool.query("update tenant_pack_releases set status = 'current', resource_version = 2 where tenant_pack_release_id = 'release_catalog_superseded'");
  await pool.query("update tenant_pack_releases set status = 'superseded', resource_version = 3 where tenant_pack_release_id = 'release_catalog_superseded'");
  await required("blockCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "block-capability", capability_version_id: "capability_version_catalog", expected_resource_version: 2 }));
  assert.deepEqual((await pool.query("select tenant_id, payload_ref, job_kind, max_attempts from worker_jobs order by job_id")).rows, [{ tenant_id: "tenant_catalog", payload_ref: "release_catalog_block", job_kind: "reconcile_capability_projection", max_attempts: 5 }]);
  await assert.rejects(() => required("retireCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "retire-blocked", capability_version_id: "capability_version_catalog", expected_resource_version: 3 })), { code: "INVALID_STATE_TRANSITION" });
});

test("Pack blocking queues only effective or preparing releases of its exact immutable version", async () => {
  const database = (await import("../src/db/database.js")).createRuntimeDatabase(pool);
  const deps = { ...dependencies, db: database };
  await required("createCapabilityVersion")(deps, context, command(capabilityPayload()));
  await required("reviewCapabilityVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-block-cap-review", capability_version_id: "capability_version_catalog", expected_resource_version: 1 }));
  await required("createPackVersion")(deps, context, command(packPayload()));
  await required("reviewPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-block-review", pack_version_id: "pack_version_catalog", expected_resource_version: 1 }));
  await required("publishPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-block-publish", pack_version_id: "pack_version_catalog", expected_resource_version: 2 }));
  await pool.query(`insert into tenant_pack_releases (tenant_pack_release_id, tenant_id, pack_product_id, pack_version_id, pack_version, generation, status, resource_version, created_at, updated_at)
    values ('release_pack_preparing', 'tenant_catalog', 'pack_product_catalog', 'pack_version_catalog', '1.0.0', 1, 'preparing', 1, $1, $1),
      ('release_pack_current', 'tenant_catalog', 'pack_product_catalog', 'pack_version_catalog', '1.0.0', 2, 'preparing', 1, $1, $1),
      ('release_pack_failed', 'tenant_catalog', 'pack_product_catalog', 'pack_version_catalog', '1.0.0', 3, 'preparing', 1, $1, $1)`, [now]);
  await pool.query("update tenant_pack_releases set status = 'current', resource_version = 2 where tenant_pack_release_id = 'release_pack_current'");
  await pool.query("update tenant_pack_releases set status = 'failed', resource_version = 2 where tenant_pack_release_id = 'release_pack_failed'");
  await required("blockPackVersion")(deps, context, command({ schema_version: 1, idempotency_key: "pack-block", pack_version_id: "pack_version_catalog", expected_resource_version: 3 }));
  assert.deepEqual((await pool.query("select payload_ref from worker_jobs order by payload_ref")).rows, [{ payload_ref: "release_pack_current" }, { payload_ref: "release_pack_preparing" }]);
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
