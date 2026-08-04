import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { loadProviderCatalog } from "../src/config/provider-catalog.js";
import { createRuntimeDatabase } from "../src/db/database.js";
import { applyMigrations } from "../src/db/migrate.js";
import { canonicalPayloadHash, DomainError } from "../src/domain/idempotency.js";
import { provisionTenant } from "../src/services/provision-tenant.js";
import { commandRuntime, getTenantRuntime } from "../src/services/command-runtime.js";

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
});

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
