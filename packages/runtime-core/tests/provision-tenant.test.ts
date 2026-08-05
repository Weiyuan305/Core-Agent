import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { loadProviderCatalog } from "../src/config/provider-catalog.js";
import { deriveManagedRuntimeNames } from "../src/runtime/managed-names.js";
import { createRuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";
import { provisionTenant } from "../src/services/provision-tenant.js";
import { commandRuntime, getTenantRuntime } from "../src/services/command-runtime.js";
import { createRedactor } from "../src/domain/redaction.js";
import { WorkerRuntimeRepository } from "../src/repositories/worker-runtime.js";
import { acquireRuntimeTransactionAdvisoryLock, withRuntimeAdvisoryLock } from "../src/repositories/runtime-lock.js";
import { sql } from "kysely";
import { claimJobs } from "../src/repositories/jobs.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}

const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const imageLock = {
  schemaVersion: 1,
  repository: "managed/runtime",
  tag: "v1",
  platforms: {
    "linux/amd64": { reference: `managed/runtime:v1@sha256:${"a".repeat(64)}` },
    "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
  },
} as const;
const providerCatalog = loadProviderCatalog([{
  provider_config_id: "provider_a",
  base_url: "https://provider.example/v1",
  model_ids: ["model_a"],
  credential_secret_ref: "provider_secret_a",
  timeout_ms: 10_000,
  max_safe_retries: 1,
}]);
const farFutureNow = new Date("2400-02-01T00:00:00.000Z");
const expiredRetention = new Date("2000-01-01T00:00:00.000Z");

function withHash<T extends Record<string, unknown>>(request: T): T & { payload_hash: string } {
  return {
    ...request,
    payload_hash: canonicalPayloadHash(request),
  };
}

function rehash<T extends { payload_hash: string }>(request: T): Omit<T, "payload_hash"> & { payload_hash: string } {
  const { payload_hash: _payloadHash, ...payload } = request;
  return withHash(payload);
}

function b2bRequest(tenantId = "tenant_provision_a") {
  const timestamp = "2026-08-04T01:00:00.000Z";
  return withHash({
    schema_version: 1 as const,
    idempotency_key: `idem_${tenantId}`,
    client_request_id: `client_${tenantId}`,
    identity_graph: {
      schema_version: 1 as const,
      tenant: {
        schema_version: 1 as const, resource_version: 1, tenant_id: tenantId,
        tenant_mode: "b2b" as const, display_name: "Provisioned B2B", status: "provisioning" as const,
        created_at: timestamp, updated_at: timestamp,
      },
      actors: [{
        schema_version: 1 as const, resource_version: 1, actor_id: `actor_${tenantId}`,
        actor_kind: "human" as const, display_name: "Consultant", status: "active" as const,
        created_at: timestamp, updated_at: timestamp,
      }],
      memberships: [{
        schema_version: 1 as const, resource_version: 1, membership_id: `membership_${tenantId}`,
        tenant_id: tenantId, actor_id: `actor_${tenantId}`, roles: ["consultant" as const],
        status: "active" as const, created_at: timestamp, updated_at: timestamp,
      }],
      profiles: [{
        schema_version: 1 as const, resource_version: 1, profile_id: `profile_${tenantId}`,
        tenant_id: tenantId, owner_actor_id: `actor_${tenantId}`, profile_kind: "consultant" as const,
        status: "provisioning" as const, hermes_profile_ref: `hermes_${tenantId}`,
        created_at: timestamp, updated_at: timestamp,
      }],
    },
    provider_config_id: "provider_a",
    model_id: "model_a",
    runtime: {
      image_ref: imageLock.platforms["linux/amd64"].reference,
      platform: "linux/amd64" as const,
      ingress_secret_ref: `ingress_${tenantId}`,
    },
    profile_runtime_config: [{ profile_id: `profile_${tenantId}`, description: "Consultant runtime profile" }],
  });
}

async function resetDatabase(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
}

async function holdRuntimeRowUntilLeaseExpires(
  tenantId: string,
  runtimeId: string,
  jobId: string,
  locked: () => void,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom("runtime_containers").select("container_id")
      .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId)
      .forUpdate().executeTakeFirstOrThrow();
    locked();
    await sql`select pg_sleep(greatest(extract(epoch from (lease_expires_at - clock_timestamp())) + 0.05, 0)::double precision)
      from worker_jobs where tenant_id = ${tenantId} and job_id = ${jobId}`.execute(trx);
    const barrier = await trx.selectFrom("worker_jobs")
      .select(sql<boolean>`clock_timestamp() > lease_expires_at`.as("expired"))
      .where("tenant_id", "=", tenantId).where("job_id", "=", jobId).executeTakeFirstOrThrow();
    assert.equal(barrier.expired, true, "runtime row lock must be held until PostgreSQL observes lease expiry");
  });
}

test.beforeEach(resetDatabase);
test.after(async () => db.destroy());

test("provisionTenant atomically creates one runtime and replays the completed response", async () => {
  const request = b2bRequest();
  let externalCalls = 0;
  const dependencies = {
    db, providerCatalog, imageLock,
    secretStore: { async get() { externalCalls += 1; } },
    supervisor: { async command() { externalCalls += 1; } },
  };
  const context = {
    tenantId: request.identity_graph.tenant.tenant_id,
    requestId: "request_provision_a",
    traceId: "trace_provision_a",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };

  const first = await provisionTenant(dependencies, context, request);
  const replay = await provisionTenant(dependencies, context, request);

  assert.deepEqual(replay, first);
  assert.equal(first.status, "accepted");
  assert.equal(first.tenant.tenant_id, context.tenantId);
  assert.equal(first.tenant.resource_version, 1);
  assert.equal(first.runtime.resource_version, 1);
  for (const table of ["tenants", "runtime_containers", "worker_jobs", "product_events", "audit_events", "outbox"] as const) {
    const count = await db.selectFrom(table).select(({ fn }) => fn.countAll<string>().as("count")).executeTakeFirstOrThrow();
    assert.equal(count.count, "1", table);
  }
  assert.equal(await db.selectFrom("actors").selectAll().execute().then((rows) => rows.length), 2);
  assert.equal(await db.selectFrom("memberships").selectAll().execute().then((rows) => rows.length), 2);
  assert.equal(await db.selectFrom("profiles").selectAll().execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("secret_references").selectAll().execute().then((rows) => rows.length), 2);
  const idempotency = await db.selectFrom("idempotency_records").selectAll().executeTakeFirstOrThrow();
  assert.equal(idempotency.status, "completed");
  assert.deepEqual(idempotency.response_json, first);
  assert.equal(externalCalls, 0);
  const internalRuntime = await db.selectFrom("runtime_containers").select(["runtime_platform", "command_version", "volume_ref"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  assert.deepEqual(internalRuntime, {
    runtime_platform: "linux/amd64",
    command_version: "0",
    volume_ref: deriveManagedRuntimeNames({
      tenant_id: context.tenantId,
      runtime_id: first.runtime.container_id,
      generation: 1,
    }).volume,
  });
});

test("provisioning replays an expired tombstone and permanently rejects a changed payload", async () => {
  const request = b2bRequest("tenant_provision_expired_tombstone");
  const context = {
    tenantId: request.identity_graph.tenant.tenant_id,
    requestId: "request_provision_expired_tombstone", traceId: "trace_provision_expired_tombstone",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  const dependencies = { db, providerCatalog, imageLock, now: () => farFutureNow };
  const first = await provisionTenant(dependencies, context, request);
  const admitted = await db.selectFrom("idempotency_records")
    .select(["created_at", "updated_at", "expires_at", "payload_hash", "operation"])
    .where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", request.idempotency_key)
    .executeTakeFirstOrThrow();
  assert.deepEqual(admitted, {
    created_at: farFutureNow,
    updated_at: farFutureNow,
    expires_at: new Date("2400-02-02T00:00:00.000Z"),
    payload_hash: request.payload_hash,
    operation: "tenant.provision",
  });
  await db.updateTable("idempotency_records").set({ expires_at: expiredRetention })
    .where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", request.idempotency_key).execute();

  assert.deepEqual(await provisionTenant(dependencies, context, request), first);
  const changed = rehash({ ...request, client_request_id: "client_changed_after_expiry" });
  await assert.rejects(
    provisionTenant(dependencies, context, changed),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(
    await db.selectFrom("idempotency_records").select(["payload_hash", "operation", "expires_at"])
      .where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", request.idempotency_key)
      .executeTakeFirstOrThrow(),
    { payload_hash: request.payload_hash, operation: "tenant.provision", expires_at: expiredRetention },
  );
  assert.equal(await db.selectFrom("runtime_containers").selectAll().where("tenant_id", "=", context.tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("worker_jobs").selectAll().where("tenant_id", "=", context.tenantId).execute().then((rows) => rows.length), 1);
});

test("provision replay rejects a result reference that does not match the derived runtime", async () => {
  const request = b2bRequest("tenant_tampered_provision_ref");
  const context = {
    tenantId: request.identity_graph.tenant.tenant_id,
    requestId: "request_tampered_provision_ref", traceId: "trace_tampered_provision_ref",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  await provisionTenant({ db, providerCatalog, imageLock }, context, request);
  await db.updateTable("idempotency_records").set({ result_ref: "runtime_attacker" })
    .where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", request.idempotency_key).execute();
  await assert.rejects(
    provisionTenant({ db, providerCatalog, imageLock }, context, request),
    (error: unknown) => error instanceof DomainError && error.code === "INTERNAL_ERROR",
  );
});

test("provisionTenant rejects invalid hashes and conflicts on a reused key with a different canonical payload", async () => {
  const original = b2bRequest("tenant_hash_a");
  const dependencies = { db, providerCatalog, imageLock };
  const context = {
    tenantId: original.identity_graph.tenant.tenant_id,
    requestId: "request_hash_a", traceId: "trace_hash_a",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };

  await assert.rejects(
    provisionTenant(dependencies, context, { ...original, payload_hash: `sha256:${"0".repeat(64)}` }),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
  );
  assert.equal(await db.selectFrom("tenants").selectAll().execute().then((rows) => rows.length), 0);

  await provisionTenant(dependencies, context, original);
  const { payload_hash: _payloadHash, ...originalWithoutHash } = original;
  const validChanged = withHash({ ...originalWithoutHash, client_request_id: "client_changed" });
  await assert.rejects(
    provisionTenant(dependencies, context, validChanged),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.equal(await db.selectFrom("runtime_containers").selectAll().execute().then((rows) => rows.length), 1);
});

test("provisionTenant rejects profile gaps, invalid identity authority, reserved IDs, and unmanaged models before writing", async () => {
  const base = b2bRequest("tenant_invalid_a");
  const invalidRequests = [
    rehash({ ...base, profile_runtime_config: [] }),
    rehash({ ...base, identity_graph: {
      ...base.identity_graph,
      actors: [{ ...base.identity_graph.actors[0]!, actor_id: "core_agent_forged" }],
      memberships: [{ ...base.identity_graph.memberships[0]!, actor_id: "core_agent_forged" }],
      profiles: [{ ...base.identity_graph.profiles[0]!, owner_actor_id: "core_agent_forged" }],
    } }),
    rehash({ ...base, identity_graph: {
      ...base.identity_graph,
      memberships: [{ ...base.identity_graph.memberships[0]!, membership_id: "core_agent_forged_membership" }],
    } }),
    rehash({ ...base, model_id: "model_unmanaged" }),
    rehash({ ...base, identity_graph: {
      ...base.identity_graph,
      memberships: [{ ...base.identity_graph.memberships[0]!, roles: ["student" as const] }],
    } }),
    rehash({ ...base, identity_graph: {
      ...base.identity_graph,
      tenant: { ...base.identity_graph.tenant, status: "active" as const },
    } }),
  ];
  for (const request of invalidRequests) {
    await assert.rejects(
      provisionTenant({ db, providerCatalog, imageLock }, {
        tenantId: request.identity_graph.tenant.tenant_id,
        requestId: "request_invalid", traceId: "trace_invalid",
        actorId: "core_agent_provisioner", membershipId: "core_agent_provisioner_admin", effectiveRole: "admin",
      }, request),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
  assert.equal(await db.selectFrom("tenants").selectAll().execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("idempotency_records").selectAll().execute().then((rows) => rows.length), 0);
});

test("B2B provisioning requires at least one consultant profile", async () => {
  const base = b2bRequest("tenant_empty_b2b");
  const request = rehash({
    ...base,
    identity_graph: { ...base.identity_graph, profiles: [] },
    profile_runtime_config: [],
  });
  await assert.rejects(
    provisionTenant({ db, providerCatalog, imageLock }, {
      tenantId: request.identity_graph.tenant.tenant_id,
      requestId: "request_empty_b2b", traceId: "trace_empty_b2b",
      actorId: "core_agent_provisioner", membershipId: "core_agent_provisioner_admin", effectiveRole: "admin",
    }, request),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
  );
  assert.equal(await db.selectFrom("tenants").selectAll().execute().then((rows) => rows.length), 0);
});

test("provisioning validates the complete managed image lock before writing", async () => {
  const request = b2bRequest("tenant_partial_image_lock");
  const partialImageLock = {
    ...imageLock,
    platforms: { "linux/amd64": imageLock.platforms["linux/amd64"] },
  };
  await assert.rejects(
    provisionTenant({ db, providerCatalog, imageLock: partialImageLock }, {
      tenantId: request.identity_graph.tenant.tenant_id,
      requestId: "request_partial_lock", traceId: "trace_partial_lock",
      actorId: "core_agent_provisioner", membershipId: "core_agent_provisioner_admin", effectiveRole: "admin",
    }, request),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
  );
  assert.equal(await db.selectFrom("tenants").selectAll().execute().then((rows) => rows.length), 0);
});

test("concurrent identical provisioning commands converge on one completed result", async () => {
  const request = b2bRequest("tenant_concurrent_a");
  const context = {
    tenantId: request.identity_graph.tenant.tenant_id,
    requestId: "request_concurrent", traceId: "trace_concurrent",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  const results = await Promise.all([
    provisionTenant({ db, providerCatalog, imageLock }, context, request),
    provisionTenant({ db, providerCatalog, imageLock }, context, request),
  ]);
  assert.deepEqual(results[1], results[0]);
  assert.equal(await db.selectFrom("tenants").selectAll().execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("worker_jobs").selectAll().execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("idempotency_records").selectAll().execute().then((rows) => rows.length), 1);
});

test("runtime commands use expected versions atomically, preserve volume, and replay", async () => {
  const provisioning = b2bRequest("tenant_command_a");
  const dependencies = { db, providerCatalog, imageLock };
  const context = {
    tenantId: provisioning.identity_graph.tenant.tenant_id,
    requestId: "request_command_a", traceId: "trace_command_a",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  await provisionTenant(dependencies, context, provisioning);
  const before = await getTenantRuntime(db, context.tenantId, context.tenantId);
  const command = withHash({
    schema_version: 1 as const,
    idempotency_key: "idem_command_stop",
    expected_resource_version: 1,
    command: "stop" as const,
  });

  const first = await commandRuntime({ db }, context, command);
  const replay = await commandRuntime({ db }, context, command);
  const after = await getTenantRuntime(db, context.tenantId, context.tenantId);
  assert.deepEqual(replay, first);
  assert.equal(first.runtime.desired_state, "stopped");
  assert.equal(first.runtime.resource_version, 2);
  assert.equal(after.volume_ref, before.volume_ref);
  assert.equal(after.desired_state, "stopped");
  assert.equal(await db.selectFrom("worker_jobs").selectAll().execute().then((rows) => rows.length), 2);
  const commandEvent = await db.selectFrom("product_events").select(["event_type", "payload"])
    .where("tenant_id", "=", context.tenantId).where("event_id", "like", "event_runtime_command_%")
    .executeTakeFirstOrThrow();
  assert.deepEqual(commandEvent, {
    event_type: "runtime.command_accepted",
    payload: { container_id: first.runtime.container_id, command: "stop", desired_state: "stopped" },
  });
  assert.equal(await db.selectFrom("product_events").selectAll().execute().then((rows) => rows.length), 2);
  assert.equal(await db.selectFrom("audit_events").selectAll().execute().then((rows) => rows.length), 2);
  assert.equal(await db.selectFrom("outbox").selectAll().execute().then((rows) => rows.length), 2);

  const stale = withHash({
    schema_version: 1 as const,
    idempotency_key: "idem_command_stale",
    expected_resource_version: 1,
    command: "delete" as const,
  });
  await assert.rejects(
    commandRuntime({ db }, context, stale),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_VERSION_CONFLICT",
  );
  const unchanged = await getTenantRuntime(db, context.tenantId, context.tenantId);
  assert.equal(unchanged.resource_version, 2);
  assert.equal(unchanged.desired_state, "stopped");
  assert.equal(unchanged.volume_ref, before.volume_ref);
  assert.equal(await db.selectFrom("worker_jobs").selectAll().execute().then((rows) => rows.length), 2);
});

test("runtime command idempotency uses the same far-future service clock as its resources", async () => {
  const provisioning = b2bRequest("tenant_command_clock");
  const context = {
    tenantId: provisioning.identity_graph.tenant.tenant_id,
    requestId: "request_command_clock", traceId: "trace_command_clock",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  await provisionTenant({ db, providerCatalog, imageLock, now: () => farFutureNow }, context, provisioning);
  const command = withHash({
    schema_version: 1 as const,
    idempotency_key: "idem_command_clock",
    expected_resource_version: 1,
    command: "stop" as const,
  });
  await commandRuntime({ db, now: () => farFutureNow }, context, command);

  const record = await db.selectFrom("idempotency_records")
    .select(["created_at", "updated_at", "expires_at"])
    .where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", command.idempotency_key)
    .executeTakeFirstOrThrow();
  assert.deepEqual(record, {
    created_at: farFutureNow,
    updated_at: farFutureNow,
    expires_at: new Date("2400-02-02T00:00:00.000Z"),
  });
  assert.deepEqual(
    await db.selectFrom("worker_jobs").select(["created_at", "updated_at", "next_attempt_at"])
      .where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").executeTakeFirstOrThrow(),
    { created_at: farFutureNow, updated_at: farFutureNow, next_attempt_at: farFutureNow },
  );
  assert.deepEqual(
    await db.selectFrom("runtime_containers").select(["desired_state", "updated_at"])
      .where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(),
    { desired_state: "stopped", updated_at: farFutureNow },
  );
});

test("runtime command replay rejects a result reference that does not match the derived runtime", async () => {
  const provisioning = b2bRequest("tenant_tampered_command_ref");
  const context = {
    tenantId: provisioning.identity_graph.tenant.tenant_id,
    requestId: "request_tampered_command_ref", traceId: "trace_tampered_command_ref",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  const request = withHash({
    schema_version: 1 as const, idempotency_key: "idem_tampered_command_ref",
    expected_resource_version: 1, command: "stop" as const,
  });
  await commandRuntime({ db }, context, request);
  await db.updateTable("idempotency_records").set({ result_ref: "runtime_attacker" })
    .where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", request.idempotency_key).execute();
  await assert.rejects(
    commandRuntime({ db }, context, request),
    (error: unknown) => error instanceof DomainError && error.code === "INTERNAL_ERROR",
  );
});

test("restart persists explicit durable reconcile intent while payload_ref remains the runtime", async () => {
  const provisioning = b2bRequest("tenant_restart_intent");
  const context = {
    tenantId: provisioning.identity_graph.tenant.tenant_id,
    requestId: "request_restart", traceId: "trace_restart",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  const restart = withHash({
    schema_version: 1 as const, idempotency_key: "idem_restart",
    expected_resource_version: 1, command: "restart" as const,
  });
  await commandRuntime({ db }, context, restart);
  const job = await db.selectFrom("worker_jobs").selectAll()
    .where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime")
    .executeTakeFirstOrThrow();
  assert.equal((job as typeof job & { runtime_command?: string }).runtime_command, "restart");
  assert.equal(job.payload_ref, accepted.runtime.container_id);
  assert.equal(job.target_command_version, "1");
});

test("Worker command supersession uses command_version independently from observed resource updates", async () => {
  const provisioning = b2bRequest("tenant_worker_supersession");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_worker_supersession", traceId: "trace_worker_supersession", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_stop_v1", expected_resource_version: 1, command: "stop" as const }));
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_start_v2", expected_resource_version: 2, command: "start" as const }));
  const jobs = await db.selectFrom("worker_jobs").select(["job_id", "runtime_command", "target_command_version", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").orderBy("created_at").execute();
  assert.deepEqual(jobs.map((job) => [job.runtime_command, job.target_command_version]), [["stop", "1"], ["start", "2"]]);
  const repository = new WorkerRuntimeRepository(db, createRedactor([]), () => new Date("2026-08-04T06:00:00.000Z"));
  const old = jobs[0]!;
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_a", lease_expires_at: new Date("2100-01-01T00:00:00.000Z") }).where("tenant_id", "=", context.tenantId).where("job_id", "=", old.job_id).execute();
  const before = await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  assert.equal(await repository.finishReconcile({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: old.job_id, workerId: "worker_a", attemptCount: old.attempt_count }, "stop", 1, { tenant_id: context.tenantId, runtime_id: accepted.runtime.container_id, generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageLock.platforms["linux/amd64"].reference }), true);
  const afterOld = await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  assert.deepEqual(afterOld, before, "superseded job must not mutate runtime truth");

  const current = jobs[1]!;
  await db.updateTable("runtime_containers").set({ observed_state: "stopped", resource_version: 4 }).where("tenant_id", "=", context.tenantId).execute();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_a", lease_expires_at: new Date("2100-01-01T00:00:00.000Z") }).where("tenant_id", "=", context.tenantId).where("job_id", "=", current.job_id).execute();
  assert.equal(await repository.finishReconcile({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: current.job_id, workerId: "worker_a", attemptCount: current.attempt_count }, "start", 2, { tenant_id: context.tenantId, runtime_id: accepted.runtime.container_id, generation: 1, exists: true, lifecycle: "running", health: "healthy", image_ref: imageLock.platforms["linux/amd64"].reference, private_origin: "http://172.30.0.4:8642" }), true);
  const completed = await db.selectFrom("runtime_containers").select(["command_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  assert.deepEqual(completed, { command_version: "2", observed_state: "ready" });
});

test("Worker terminal transaction makes no transition after lease loss", async () => {
  const provisioning = b2bRequest("tenant_worker_lease_loss");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_worker_lease_loss", traceId: "trace_worker_lease_loss", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_lease_stop", expected_resource_version: 1, command: "stop" as const }));
  const job = await db.selectFrom("worker_jobs").select(["job_id", "target_command_version", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: new Date(0) }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
  const before = await db.selectFrom("runtime_containers").select(["resource_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  assert.equal(await repository.finishReconcile({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count }, "stop", Number(job.target_command_version), { tenant_id: context.tenantId, runtime_id: accepted.runtime.container_id, generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageLock.platforms["linux/amd64"].reference }), false);
  assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), before);
});

test("runtime command admission waits for the Worker runtime lock without blocking another runtime", async () => {
  const provisioning = b2bRequest("tenant_command_lock");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_command_lock", traceId: "trace_command_lock", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  let entered!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const worker = withRuntimeAdvisoryLock(db, context.tenantId, accepted.runtime.container_id, async () => {
    entered(); await releasePromise;
    await db.updateTable("runtime_containers").set({ resource_version: sql`resource_version + 1` }).where("tenant_id", "=", context.tenantId).where("container_id", "=", accepted.runtime.container_id).execute();
  });
  await enteredPromise;

  let commandSettled = false;
  const command = commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_locked_stop_stale", expected_resource_version: 1, command: "stop" as const })).then(
    (value) => { commandSettled = true; return value; },
    (error: unknown) => { commandSettled = true; return error; },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(commandSettled, false, "command must wait until the Worker external-effect critical section ends");

  await assert.doesNotReject(db.transaction().execute(async (trx) => {
    await acquireRuntimeTransactionAdvisoryLock(trx, context.tenantId, "runtime_other");
  }), "a different runtime lock key must remain independent");

  release(); await worker; const staleResult = await command;
  assert.equal(staleResult instanceof DomainError && staleResult.code === "RESOURCE_VERSION_CONFLICT", true);
  const latest = await getTenantRuntime(db, context.tenantId, context.tenantId);
  const result = await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_locked_stop_latest", expected_resource_version: latest.resource_version, command: "stop" as const }));
  assert.equal(result.runtime.desired_state, "stopped");
  const stored = await db.selectFrom("worker_jobs").select(["runtime_command", "target_command_version"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").executeTakeFirstOrThrow();
  assert.deepEqual(stored, { runtime_command: "stop", target_command_version: "1" });
});

test("markReconcileEffectDispatched fences tenant lease command and current command version", async () => {
  const provisioning = b2bRequest("tenant_effect_phase");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_effect_phase", traceId: "trace_effect_phase", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_effect_restart", expected_resource_version: 1, command: "restart" as const }));
  const row = await db.selectFrom("worker_jobs").select(["job_id", "target_command_version", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").executeTakeFirstOrThrow();
  const provisionJob = await db.selectFrom("worker_jobs").select("job_id").where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_effect", lease_expires_at: sql<Date>`clock_timestamp() + interval '30 seconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).execute();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_effect", lease_expires_at: sql<Date>`clock_timestamp() + interval '30 seconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", provisionJob.job_id).execute();
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  const ref = { tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: row.job_id, workerId: "worker_effect", attemptCount: row.attempt_count };
  const targetVersion = Number(row.target_command_version);

  assert.equal(await repository.markReconcileEffectDispatched({ ...ref, tenantId: "tenant_other" }, "restart", targetVersion), false);
  assert.equal(await repository.markReconcileEffectDispatched({ ...ref, workerId: "worker_other" }, "restart", targetVersion), false);
  assert.equal(await repository.markReconcileEffectDispatched({ ...ref, jobId: provisionJob.job_id }, "restart", targetVersion), false);
  assert.equal(await repository.markReconcileEffectDispatched(ref, "start", targetVersion), false);
  assert.equal(await repository.markReconcileEffectDispatched(ref, "restart", targetVersion + 1), false);
  assert.equal((await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).executeTakeFirstOrThrow()).effect_state, "pre_effect");

  assert.equal(await repository.markReconcileEffectDispatched(ref, "restart", targetVersion), true);
  assert.equal((await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).executeTakeFirstOrThrow()).effect_state, "unsafe_to_replay");
  assert.equal(await repository.markReconcileEffectDispatched(ref, "restart", targetVersion), false);
  assert.equal((await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).executeTakeFirstOrThrow()).effect_state, "unsafe_to_replay");

  await db.updateTable("worker_jobs").set({ effect_state: "pre_effect", lease_expires_at: sql<Date>`clock_timestamp() - interval '1 second'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).execute();
  assert.equal(await repository.markReconcileEffectDispatched(ref, "restart", targetVersion), false);
  await db.updateTable("worker_jobs").set({ lease_expires_at: sql<Date>`clock_timestamp() + interval '30 seconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).execute();
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_effect_new_start", expected_resource_version: 2, command: "start" as const }));
  assert.equal(await repository.markReconcileEffectDispatched(ref, "restart", targetVersion), false);
  assert.equal((await db.selectFrom("worker_jobs").select("effect_state").where("tenant_id", "=", context.tenantId).where("job_id", "=", row.job_id).executeTakeFirstOrThrow()).effect_state, "pre_effect");
});

test("finishReconcile cannot complete as an old owner after its lease expires while waiting for a row lock", async () => {
  const provisioning = b2bRequest("tenant_finish_lock_expiry");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_finish_lock_expiry", traceId: "trace_finish_lock_expiry", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_old_stop", expected_resource_version: 1, command: "stop" as const }));
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_new_start", expected_resource_version: 2, command: "start" as const }));
  const old = await db.selectFrom("worker_jobs").select(["job_id", "target_command_version", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").where("runtime_command", "=", "stop").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: sql<Date>`now() + interval '100 milliseconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", old.job_id).execute();

  let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
  const rowLocker = holdRuntimeRowUntilLeaseExpires(context.tenantId, accepted.runtime.container_id, old.job_id, locked);
  await lockedPromise;
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  const finishing = repository.finishReconcile({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: old.job_id, workerId: "worker_old", attemptCount: old.attempt_count }, "stop", Number(old.target_command_version), { tenant_id: context.tenantId, runtime_id: accepted.runtime.container_id, generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageLock.platforms["linux/amd64"].reference });
  await rowLocker;
  assert.equal(await finishing, false);
  const job = await db.selectFrom("worker_jobs").select(["status", "lease_owner"]).where("tenant_id", "=", context.tenantId).where("job_id", "=", old.job_id).executeTakeFirstOrThrow();
  assert.deepEqual(job, { status: "running", lease_owner: "worker_old" });
});

test("finishReconcile rolls back current-command transitions when lease expires during row-lock wait", async () => {
  const provisioning = b2bRequest("tenant_finish_current_expiry");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_finish_current_expiry", traceId: "trace_finish_current_expiry", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await db.updateTable("runtime_containers").set({ observed_state: "ready" }).where("tenant_id", "=", context.tenantId).execute();
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_current_stop", expected_resource_version: 1, command: "stop" as const }));
  const job = await db.selectFrom("worker_jobs").select(["job_id", "target_command_version", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "reconcile_runtime").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: sql<Date>`now() + interval '100 milliseconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
  let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
  const rowLocker = holdRuntimeRowUntilLeaseExpires(context.tenantId, accepted.runtime.container_id, job.job_id, locked);
  await lockedPromise;
  const before = await db.selectFrom("runtime_containers").select(["resource_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const beforeEvents = await db.selectFrom("product_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  const finishing = repository.finishReconcile({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count }, "stop", Number(job.target_command_version), { tenant_id: context.tenantId, runtime_id: accepted.runtime.container_id, generation: 1, exists: true, lifecycle: "stopped", health: "unknown", image_ref: imageLock.platforms["linux/amd64"].reference });
  await rowLocker;
  assert.equal(await finishing, false);
  assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "observed_state"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), before);
  assert.deepEqual(await db.selectFrom("product_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeEvents);
});

test("beginProvision rolls back its transition and audit after lease expiry during row-lock wait", async () => {
  const provisioning = b2bRequest("tenant_begin_expiry");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_begin_expiry", traceId: "trace_begin_expiry", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  const job = await db.selectFrom("worker_jobs").select(["job_id", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: sql<Date>`now() + interval '100 milliseconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
  let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
  const rowLocker = holdRuntimeRowUntilLeaseExpires(context.tenantId, accepted.runtime.container_id, job.job_id, locked);
  await lockedPromise;
  const beforeRuntime = await db.selectFrom("runtime_containers").select(["resource_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const beforeEvents = await db.selectFrom("product_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const beforeAudit = await db.selectFrom("audit_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  const beginning = repository.beginProvision({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count });
  await rowLocker;
  assert.deepEqual(await beginning, { kind: "lease_lost" });
  assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeRuntime);
  assert.deepEqual(await db.selectFrom("product_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeEvents);
  assert.deepEqual(await db.selectFrom("audit_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeAudit);
});

test("initial provision admission atomically supersedes command-versioned work without changing runtime truth", async () => {
  const provisioning = b2bRequest("tenant_provision_admission_superseded");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_provision_admission_superseded", traceId: "trace_provision_admission_superseded", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_provision_admission_restart", expected_resource_version: 1, command: "restart" as const }));
  const job = await db.selectFrom("worker_jobs").select(["job_id", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: new Date("2100-01-01T00:00:00.000Z") }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
  const before = await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "desired_state", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));

  assert.deepEqual(await repository.beginProvision({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count }), { kind: "superseded" });
  assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "desired_state", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), before);
  assert.deepEqual(await db.selectFrom("worker_jobs").select(["status", "lease_owner", "lease_expires_at", "last_error_summary"]).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).executeTakeFirstOrThrow(), {
    status: "succeeded", lease_owner: null, lease_expires_at: null, last_error_summary: "Superseded by a newer runtime command",
  });
});

test("final provision recovery waits for newer reconcile truth and only supersedes its owned job", async () => {
  const provisioning = b2bRequest("tenant_provision_recovery_lock");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_provision_recovery_lock", traceId: "trace_provision_recovery_lock", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_provision_recovery_restart", expected_resource_version: 1, command: "restart" as const }));
  const job = await db.selectFrom("worker_jobs").select(["job_id", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
  const recoveryAttemptCount = 5;
  await db.updateTable("worker_jobs").set({ status: "running", attempt_count: recoveryAttemptCount, max_attempts: recoveryAttemptCount, lease_owner: "worker_recovery", lease_expires_at: new Date("2100-01-01T00:00:00.000Z") }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();

  let truthReady!: () => void; const truthReadyPromise = new Promise<void>((resolve) => { truthReady = resolve; });
  let releaseTruth!: () => void; const releaseTruthPromise = new Promise<void>((resolve) => { releaseTruth = resolve; });
  const newerReconcile = withRuntimeAdvisoryLock(db, context.tenantId, accepted.runtime.container_id, async () => {
    await db.updateTable("runtime_containers").set({ observed_state: "ready", health_status: "healthy", failure_summary: null, resource_version: 3 }).where("tenant_id", "=", context.tenantId).where("container_id", "=", accepted.runtime.container_id).execute();
    truthReady();
    await releaseTruthPromise;
  });
  await truthReadyPromise;

  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  let recoveryEntered = false;
  const recovering = withRuntimeAdvisoryLock(db, context.tenantId, accepted.runtime.container_id, async () => {
    recoveryEntered = true;
    return repository.failProvisionJob({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_recovery", attemptCount: recoveryAttemptCount }, "Final-attempt recovery cannot safely replay runtime provisioning");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recoveryEntered, false, "old provision recovery must wait for the same-runtime lock");
  assert.equal(await withRuntimeAdvisoryLock(db, context.tenantId, "runtime_other", async () => true), true, "another runtime must remain independent");

  releaseTruth();
  await newerReconcile;
  assert.deepEqual(await recovering, { kind: "superseded" });
  assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "desired_state", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), {
    resource_version: "3", command_version: "1", desired_state: "running", observed_state: "ready", health_status: "healthy", failure_summary: null,
  });
  assert.deepEqual(await db.selectFrom("worker_jobs").select(["status", "lease_owner", "last_error_summary"]).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).executeTakeFirstOrThrow(), {
    status: "succeeded", lease_owner: null, last_error_summary: "Superseded by a newer runtime command",
  });
});

test("superseded provision terminal defenses preserve newer runtime truth", async () => {
  for (const operation of ["finish", "fail"] as const) {
    const provisioning = b2bRequest(`tenant_provision_terminal_${operation}`);
    const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: `request_provision_terminal_${operation}`, traceId: `trace_provision_terminal_${operation}`, actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
    const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
    await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: `idem_provision_terminal_${operation}`, expected_resource_version: 1, command: "restart" as const }));
    const job = await db.selectFrom("worker_jobs").select(["job_id", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
    await db.updateTable("runtime_containers").set({ observed_state: "ready", health_status: "healthy", failure_summary: null, resource_version: 3 }).where("tenant_id", "=", context.tenantId).execute();
    await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: new Date("2100-01-01T00:00:00.000Z") }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
    const before = await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
    const repository = new WorkerRuntimeRepository(db, createRedactor([]));
    const ref = { tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count };
    const result = operation === "finish" ? await repository.finishProvision(ref) : await repository.failProvisionJob(ref, "synthetic failure");
    assert.deepEqual(result, { kind: "superseded" }, operation);
    assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), before, operation);
  }
});

test("superseded provision cannot terminalize after lease loss", async () => {
  const provisioning = b2bRequest("tenant_provision_superseded_lease_loss");
  const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: "request_provision_superseded_lease_loss", traceId: "trace_provision_superseded_lease_loss", actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
  const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: "idem_provision_lease_loss_restart", expected_resource_version: 1, command: "restart" as const }));
  const job = await db.selectFrom("worker_jobs").select(["job_id", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
  await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_expired", lease_expires_at: new Date(0) }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
  const beforeRuntime = await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
  const beforeJob = await db.selectFrom("worker_jobs").select(["status", "lease_owner", "last_error_summary"]).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).executeTakeFirstOrThrow();
  const repository = new WorkerRuntimeRepository(db, createRedactor([]));
  assert.deepEqual(await repository.beginProvision({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_expired", attemptCount: job.attempt_count }), { kind: "lease_lost" });
  assert.deepEqual(await repository.failProvisionJob({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_expired", attemptCount: job.attempt_count }, "synthetic failure"), { kind: "lease_lost" });
  assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "command_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeRuntime);
  assert.deepEqual(await db.selectFrom("worker_jobs").select(["status", "lease_owner", "last_error_summary"]).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).executeTakeFirstOrThrow(), beforeJob);
});

for (const terminalOperation of ["finishProvision", "failProvisionJob"] as const) {
  test(`${terminalOperation} rolls back runtime events and audit after lease expiry during row-lock wait`, async () => {
    const fixtureId = terminalOperation === "finishProvision" ? "finish_prov_expiry" : "fail_job_expiry";
    const provisioning = b2bRequest(`tenant_${fixtureId}`);
    const context = { tenantId: provisioning.identity_graph.tenant.tenant_id, requestId: `request_${fixtureId}`, traceId: `trace_${fixtureId}`, actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
    const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
    const job = await db.selectFrom("worker_jobs").select(["job_id", "attempt_count"]).where("tenant_id", "=", context.tenantId).where("job_kind", "=", "provision_runtime").executeTakeFirstOrThrow();
    await db.updateTable("runtime_containers").set({ observed_state: "provisioning", resource_version: 2 }).where("tenant_id", "=", context.tenantId).execute();
    await db.updateTable("worker_jobs").set({ status: "running", lease_owner: "worker_old", lease_expires_at: sql<Date>`now() + interval '100 milliseconds'` }).where("tenant_id", "=", context.tenantId).where("job_id", "=", job.job_id).execute();
    let locked!: () => void; const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const rowLocker = holdRuntimeRowUntilLeaseExpires(context.tenantId, accepted.runtime.container_id, job.job_id, locked);
    await lockedPromise;
    const beforeRuntime = await db.selectFrom("runtime_containers").select(["resource_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
    const beforeEvents = await db.selectFrom("product_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
    const beforeAudit = await db.selectFrom("audit_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow();
    const repository = new WorkerRuntimeRepository(db, createRedactor([]));
    const terminal = terminalOperation === "finishProvision"
      ? repository.finishProvision({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count })
      : repository.failProvisionJob({ tenantId: context.tenantId, runtimeId: accepted.runtime.container_id, jobId: job.job_id, workerId: "worker_old", attemptCount: job.attempt_count }, "synthetic permanent failure");
    await rowLocker;
    assert.deepEqual(await terminal, { kind: "lease_lost" });
    assert.deepEqual(await db.selectFrom("runtime_containers").select(["resource_version", "observed_state", "health_status", "failure_summary"]).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeRuntime);
    assert.deepEqual(await db.selectFrom("product_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeEvents);
    assert.deepEqual(await db.selectFrom("audit_events").select(({ fn }) => fn.countAll<string>().as("count")).where("tenant_id", "=", context.tenantId).executeTakeFirstOrThrow(), beforeAudit);
  });
}

for (const terminalField of ["desired_state", "observed_state"] as const) {
  test(`runtime command rejects terminal ${terminalField} before every write`, async () => {
    const provisioning = b2bRequest(`tenant_terminal_${terminalField}`);
    const context = {
      tenantId: provisioning.identity_graph.tenant.tenant_id,
      requestId: `request_terminal_${terminalField}`, traceId: `trace_terminal_${terminalField}`,
      actorId: "core_agent_provisioner" as const,
      membershipId: "core_agent_provisioner_admin" as const,
      effectiveRole: "admin" as const,
    };
    const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
    await db.updateTable("runtime_containers").set({ [terminalField]: "deleted", resource_version: 2 })
      .where("tenant_id", "=", context.tenantId).where("container_id", "=", accepted.runtime.container_id).execute();
    const command = withHash({
      schema_version: 1 as const, idempotency_key: `idem_terminal_${terminalField}`,
      expected_resource_version: 2, command: "start" as const,
    });
    await assert.rejects(
      commandRuntime({ db }, context, command),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_STATE_TRANSITION",
    );
    const runtime = await getTenantRuntime(db, context.tenantId, context.tenantId);
    assert.equal(runtime.resource_version, 2);
    assert.equal(runtime[terminalField], "deleted");
    assert.equal(await db.selectFrom("worker_jobs").selectAll().execute().then((rows) => rows.length), 1);
    assert.equal(await db.selectFrom("idempotency_records").selectAll().execute().then((rows) => rows.length), 1);
  });
}

test("runtime command rejects unsafe expected resource versions before repository work", async () => {
  const provisioning = b2bRequest("tenant_unsafe_version");
  const context = {
    tenantId: provisioning.identity_graph.tenant.tenant_id,
    requestId: "request_unsafe_version", traceId: "trace_unsafe_version",
    actorId: "core_agent_provisioner" as const,
    membershipId: "core_agent_provisioner_admin" as const,
    effectiveRole: "admin" as const,
  };
  await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
  for (const expected_resource_version of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const command = withHash({
      schema_version: 1 as const, idempotency_key: `idem_unsafe_${expected_resource_version}`,
      expected_resource_version, command: "stop" as const,
    });
    await assert.rejects(
      commandRuntime({ db }, context, command),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
  const runtime = await getTenantRuntime(db, context.tenantId, context.tenantId);
  assert.equal(runtime.resource_version, 1);
  assert.equal(await db.selectFrom("worker_jobs").selectAll().execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("idempotency_records").selectAll().execute().then((rows) => rows.length), 1);
});

test("runtime query returns the same generic not-found error for absent and cross-tenant paths", async () => {
  await assert.rejects(
    getTenantRuntime(db, "tenant_authority", "tenant_other"),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
  await assert.rejects(
    getTenantRuntime(db, "tenant_authority", "tenant_authority"),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
  const absentCommand = withHash({
    schema_version: 1 as const, idempotency_key: "idem_absent_runtime",
    expected_resource_version: 1, command: "start" as const,
  });
  await assert.rejects(
    commandRuntime({ db }, {
      tenantId: "tenant_authority", requestId: "request_absent", traceId: "trace_absent",
      actorId: "core_agent_provisioner", membershipId: "core_agent_provisioner_admin", effectiveRole: "admin",
    }, absentCommand),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
  assert.equal(await db.selectFrom("idempotency_records").selectAll().execute().then((rows) => rows.length), 0);
});

test("same-owner runtime reclaim fences effect and every terminal ownership mutation", async () => {
  const operations = ["effect", "retry", "supersede", "failure", "success"] as const;
  for (const operation of operations) {
    const tenantId = `tenant_runtime_reclaim_${operation}`;
    const provisioning = b2bRequest(tenantId);
    const context = { tenantId, requestId: `request_${operation}`, traceId: `trace_${operation}`, actorId: "core_agent_provisioner" as const, membershipId: "core_agent_provisioner_admin" as const, effectiveRole: "admin" as const };
    const accepted = await provisionTenant({ db, providerCatalog, imageLock }, context, provisioning);
    await db.updateTable("worker_jobs").set({ status: "succeeded" }).where("tenant_id", "=", tenantId).where("job_kind", "=", "provision_runtime").execute();
    await commandRuntime({ db }, context, withHash({ schema_version: 1 as const, idempotency_key: `idem_${operation}`, expected_resource_version: 1, command: "start" as const }));
    const [staleJob] = await claimJobs(db, { tenantId, workerId: "worker_same", limit: 1, leaseMs: 30_000 });
    assert.equal(staleJob?.jobKind, "reconcile_runtime");
    await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) }).where("tenant_id", "=", tenantId).where("job_id", "=", staleJob!.jobId).execute();
    const [currentJob] = await claimJobs(db, { tenantId, workerId: "worker_same", limit: 1, leaseMs: 30_000 });
    assert.equal(currentJob?.jobKind, "reconcile_runtime");
    const stale = { tenantId, runtimeId: accepted.runtime.container_id, jobId: staleJob!.jobId, workerId: "worker_same", attemptCount: staleJob!.attemptCount };
    const current = { ...stale, attemptCount: currentJob!.attemptCount };
    const repository = new WorkerRuntimeRepository(db, createRedactor([]));
    const targetCommandVersion = 1;
    const observation = { tenant_id: tenantId, runtime_id: accepted.runtime.container_id, generation: 1, exists: true, lifecycle: "running" as const, health: "healthy" as const, image_ref: imageLock.platforms["linux/amd64"].reference, private_origin: "http://172.30.0.4:8642" };
    if (operation === "effect") {
      assert.equal(await repository.markReconcileEffectDispatched(stale, "start", targetCommandVersion), false);
      assert.equal(await repository.markReconcileEffectDispatched(current, "start", targetCommandVersion), true);
    } else if (operation === "retry") {
      assert.equal(await repository.retryJob(stale, "stale", new Date(1)), false);
      assert.equal(await repository.retryJob(current, "current", new Date(1)), true);
    } else if (operation === "supersede") {
      assert.equal(await repository.completeSuperseded(stale), false);
      assert.equal(await repository.completeSuperseded(current), true);
    } else if (operation === "failure") {
      assert.equal(await repository.failRuntimeJob(stale, "stale"), false);
      assert.equal(await repository.failRuntimeJob(current, "current"), true);
    } else {
      assert.equal(await repository.finishReconcile(stale, "start", targetCommandVersion, observation), false);
      assert.equal(await repository.finishReconcile(current, "start", targetCommandVersion, observation), true);
    }
  }
});
