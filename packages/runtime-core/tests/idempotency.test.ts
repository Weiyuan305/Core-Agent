import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import {
  applyMigrations,
  beginIdempotentCommand,
  completeIdempotentCommand,
  createRuntimeDatabase,
  withTenantTransaction,
} from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));
const farFutureNow = new Date("2400-01-01T00:00:00.000Z");
const farFutureExpiry = new Date("2400-01-02T00:00:00.000Z");

async function reset(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
  await db.insertInto("tenants").values({
    tenant_id: "tenant_idempotency", schema_version: 1, resource_version: 1,
    tenant_mode: "b2b", status: "active", display_name: "Synthetic idempotency tenant",
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
}

async function createSyntheticCommand(key: string, payloadHash: string, operation = "create_agent_run") {
  return withTenantTransaction(db, "tenant_idempotency", async (context) => {
    const admission = await beginIdempotentCommand<{ run_id: string }>(context, {
      key,
      payloadHash,
      operation,
      now: farFutureNow,
      expiresAt: farFutureExpiry,
    });
    if (admission.kind === "acquired") {
      const response = { run_id: "run_1" };
      await context.trx.updateTable("idempotency_records").set({
        status: "completed", response_json: response, result_ref: response.run_id,
        updated_at: farFutureNow,
      }).where("tenant_id", "=", context.tenantId).where("idempotency_key", "=", key).execute();
      return { ...admission, response };
    }
    return admission;
  });
}

test.beforeEach(reset);
test.after(async () => { await db.destroy(); });

test("same key and hash replay one result while a different hash conflicts", async () => {
  const first = await createSyntheticCommand("idem_1", `sha256:${"a".repeat(64)}`);
  const replay = await createSyntheticCommand("idem_1", `sha256:${"a".repeat(64)}`);
  assert.equal(first.kind, "acquired");
  assert.deepEqual(replay, { kind: "replay", resultRef: "run_1", response: first.response });
  await assert.rejects(
    createSyntheticCommand("idem_1", `sha256:${"b".repeat(64)}`),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("idempotency validates input, compares operation, and fails closed on null replay", async () => {
  await assert.rejects(createSyntheticCommand("", `sha256:${"a".repeat(64)}`), /INVALID_REQUEST/);
  await assert.rejects(createSyntheticCommand("idem_invalid", "not-a-hash"), /INVALID_REQUEST/);

  await withTenantTransaction(db, "tenant_idempotency", async (context) => {
    await beginIdempotentCommand(context, {
      key: "idem_operation", payloadHash: `sha256:${"a".repeat(64)}`,
      operation: "first_operation", now: farFutureNow, expiresAt: farFutureExpiry,
    });
  });
  await assert.rejects(withTenantTransaction(db, "tenant_idempotency", async (context) => (
    beginIdempotentCommand(context, {
      key: "idem_operation", payloadHash: `sha256:${"a".repeat(64)}`,
      operation: "second_operation", now: farFutureNow, expiresAt: farFutureExpiry,
    })
  )), /IDEMPOTENCY_CONFLICT/);

  await db.updateTable("idempotency_records").set({ status: "completed", response_json: null })
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_operation").execute();
  await assert.rejects(withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_operation", payloadHash: `sha256:${"a".repeat(64)}`,
    operation: "first_operation", now: farFutureNow, expiresAt: farFutureExpiry,
  })), /INTERNAL_ERROR/);

  await db.updateTable("idempotency_records").set({ response_json: { run_id: "run_1" }, result_ref: null })
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_operation").execute();
  await assert.rejects(withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_operation", payloadHash: `sha256:${"a".repeat(64)}`,
    operation: "first_operation", now: farFutureNow, expiresAt: farFutureExpiry,
  })), /INTERNAL_ERROR/);
});

test("expired completed keys remain permanent tombstones for replay operation and payload", async () => {
  const payloadHash = `sha256:${"f".repeat(64)}`;
  const first = await createSyntheticCommand("idem_expired_completed", payloadHash);
  await db.updateTable("idempotency_records").set({ expires_at: new Date("2000-01-01T00:00:00.000Z") })
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_expired_completed").execute();

  const replay = await createSyntheticCommand("idem_expired_completed", payloadHash);
  assert.deepEqual(replay, { kind: "replay", resultRef: "run_1", response: first.response });
  await assert.rejects(
    createSyntheticCommand("idem_expired_completed", `sha256:${"0".repeat(64)}`),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    createSyntheticCommand("idem_expired_completed", payloadHash, "different_operation"),
    /IDEMPOTENCY_CONFLICT/,
  );

  const unchanged = await db.selectFrom("idempotency_records")
    .select(["payload_hash", "operation", "status", "result_ref", "expires_at", "created_at", "updated_at"])
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_expired_completed")
    .executeTakeFirstOrThrow();
  assert.deepEqual(unchanged, {
    payload_hash: payloadHash,
    operation: "create_agent_run",
    status: "completed",
    result_ref: "run_1",
    expires_at: new Date("2000-01-01T00:00:00.000Z"),
    created_at: farFutureNow,
    updated_at: farFutureNow,
  });
});

test("expired in-progress keys remain in progress and cannot change generation", async () => {
  const payloadHash = `sha256:${"1".repeat(64)}`;
  await withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_expired_in_progress", payloadHash, operation: "create_agent_run",
    now: farFutureNow, expiresAt: farFutureExpiry,
  }));
  await db.updateTable("idempotency_records").set({ expires_at: new Date("2000-01-01T00:00:00.000Z") })
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_expired_in_progress").execute();

  const existing = await withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_expired_in_progress", payloadHash, operation: "create_agent_run",
    now: farFutureNow, expiresAt: farFutureExpiry,
  }));
  assert.deepEqual(existing, { kind: "in_progress" });
  await assert.rejects(withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_expired_in_progress", payloadHash: `sha256:${"2".repeat(64)}`, operation: "create_agent_run",
    now: farFutureNow, expiresAt: farFutureExpiry,
  })), /IDEMPOTENCY_CONFLICT/);
});

test("concurrent idempotency admission acquires one record and leaves one caller in progress", async () => {
  const admissions = await Promise.all(["left", "right"].map(() => withTenantTransaction(
    db,
    "tenant_idempotency",
    (context) => beginIdempotentCommand(context, {
      key: "idem_concurrent", payloadHash: `sha256:${"c".repeat(64)}`,
      operation: "create_agent_run", now: farFutureNow, expiresAt: farFutureExpiry,
    }),
  )));
  assert.deepEqual(admissions.map((admission) => admission.kind).sort(), ["acquired", "in_progress"]);
});

test("idempotency completion matches the admitted hash and operation", async () => {
  const payloadHash = `sha256:${"d".repeat(64)}`;
  await db.insertInto("idempotency_records").values({
    tenant_id: "tenant_idempotency", idempotency_key: "idem_complete", payload_hash: payloadHash,
    operation: "runtime.command", status: "in_progress", result_ref: null, response_json: null,
    expires_at: farFutureExpiry, created_at: farFutureNow, updated_at: farFutureNow,
  }).execute();
  for (const mismatch of [
    { payloadHash: `sha256:${"e".repeat(64)}`, operation: "runtime.command" },
    { payloadHash, operation: "tenant.provision" },
  ]) {
    await assert.rejects(withTenantTransaction(db, "tenant_idempotency", (context) => (
      completeIdempotentCommand(context, {
        key: "idem_complete", ...mismatch, resultRef: "runtime_a", response: { accepted: true }, updatedAt: farFutureNow,
      })
    )), /INTERNAL_ERROR/);
  }
  const unchanged = await db.selectFrom("idempotency_records").select(["status", "response_json"])
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_complete")
    .executeTakeFirstOrThrow();
  assert.deepEqual(unchanged, { status: "in_progress", response_json: null });
});
