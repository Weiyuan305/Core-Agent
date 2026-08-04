import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { applyMigrations, claimJobs, createRuntimeDatabase } from "../src/index.js";

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
    tenant_id: "tenant_jobs", schema_version: 1, resource_version: 1,
    tenant_mode: "b2b", status: "active", display_name: "Synthetic jobs tenant",
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
}

async function insertJob(): Promise<void> {
  await db.insertInto("worker_jobs").values({
    tenant_id: "tenant_jobs", job_id: "job_1", job_kind: "dispatch_outbox", status: "queued",
    attempt_count: 0, max_attempts: 3, lease_owner: null, lease_expires_at: null,
    next_attempt_at: new Date(0), payload_ref: "payload_1", effect_state: "pre_effect",
    last_error_summary: null, run_id: null, container_id: null,
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
}

test.beforeEach(reset);
test.after(async () => { await db.destroy(); });

test("concurrent workers claim a job once and reclaim only after lease expiry", async () => {
  await insertJob();
  const [left, right] = await Promise.all([
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_a", limit: 1, leaseMs: 30_000 }),
    claimJobs(db, { tenantId: "tenant_jobs", workerId: "worker_b", limit: 1, leaseMs: 30_000 }),
  ]);
  assert.equal(left.length + right.length, 1);
  await db.updateTable("worker_jobs").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_jobs").where("job_id", "=", "job_1").execute();
  assert.equal((await claimJobs(db, {
    tenantId: "tenant_jobs", workerId: "worker_c", limit: 1, leaseMs: 30_000,
  })).length, 1);
});
