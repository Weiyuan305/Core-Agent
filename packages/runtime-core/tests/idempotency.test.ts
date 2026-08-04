import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import {
  applyMigrations,
  beginIdempotentCommand,
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

async function reset(): Promise<void> {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
  await db.insertInto("tenants").values({
    tenant_id: "tenant_idempotency", schema_version: 1, resource_version: 1,
    tenant_mode: "b2b", status: "active", display_name: "Synthetic idempotency tenant",
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
}

async function createSyntheticCommand(key: string, payloadHash: string) {
  return withTenantTransaction(db, "tenant_idempotency", async (context) => {
    const admission = await beginIdempotentCommand<{ run_id: string }>(context, {
      key,
      payloadHash,
      operation: "create_agent_run",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    if (admission.kind === "acquired") {
      const response = { run_id: "run_1" };
      await context.trx.updateTable("idempotency_records").set({
        status: "completed", response_json: response, result_ref: response.run_id,
        updated_at: new Date("2026-08-03T00:00:01.000Z"),
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
  assert.deepEqual(replay, { kind: "replay", response: first.response });
  await assert.rejects(
    createSyntheticCommand("idem_1", `sha256:${"b".repeat(64)}`),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("idempotency validates input, compares operation, reclaims expiry, and fails closed on null replay", async () => {
  await assert.rejects(createSyntheticCommand("", `sha256:${"a".repeat(64)}`), /INVALID_REQUEST/);
  await assert.rejects(createSyntheticCommand("idem_invalid", "not-a-hash"), /INVALID_REQUEST/);

  await withTenantTransaction(db, "tenant_idempotency", async (context) => {
    await beginIdempotentCommand(context, {
      key: "idem_operation", payloadHash: `sha256:${"a".repeat(64)}`,
      operation: "first_operation", expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });
  await assert.rejects(withTenantTransaction(db, "tenant_idempotency", async (context) => (
    beginIdempotentCommand(context, {
      key: "idem_operation", payloadHash: `sha256:${"a".repeat(64)}`,
      operation: "second_operation", expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
  )), /IDEMPOTENCY_CONFLICT/);

  await db.updateTable("idempotency_records").set({ expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_operation").execute();
  const reclaimed = await withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_operation", payloadHash: `sha256:${"b".repeat(64)}`,
    operation: "second_operation", expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  }));
  assert.equal(reclaimed.kind, "acquired");

  await db.updateTable("idempotency_records").set({ status: "completed", response_json: null })
    .where("tenant_id", "=", "tenant_idempotency").where("idempotency_key", "=", "idem_operation").execute();
  await assert.rejects(withTenantTransaction(db, "tenant_idempotency", (context) => beginIdempotentCommand(context, {
    key: "idem_operation", payloadHash: `sha256:${"b".repeat(64)}`,
    operation: "second_operation", expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })), /INTERNAL_ERROR/);
});

test("concurrent idempotency admission acquires one record and leaves one caller in progress", async () => {
  const admissions = await Promise.all(["left", "right"].map(() => withTenantTransaction(
    db,
    "tenant_idempotency",
    (context) => beginIdempotentCommand(context, {
      key: "idem_concurrent", payloadHash: `sha256:${"c".repeat(64)}`,
      operation: "create_agent_run", expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  )));
  assert.deepEqual(admissions.map((admission) => admission.kind).sort(), ["acquired", "in_progress"]);
});
