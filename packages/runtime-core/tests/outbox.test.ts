import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { applyMigrations, claimOutboxWakeups, createRedactor, createRuntimeDatabase, markOutboxDelivered, rescheduleOutbox } from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));

test.beforeEach(async () => {
  await pool.query("drop schema public cascade; create schema public;"); await applyMigrations(pool, migrationsDirectory);
  await db.insertInto("tenants").values({ tenant_id: "tenant_outbox", schema_version: 1, resource_version: 1, tenant_mode: "b2b", status: "active", display_name: "Outbox", created_at: new Date(0), updated_at: new Date(0) }).execute();
  await db.insertInto("product_events").values({ tenant_id: "tenant_outbox", event_id: "event_1", stream_id: "runtime_1", schema_version: 1, sequence: 1, event_type: "runtime.status_changed", occurred_at: new Date(0), request_id: "request_1", trace_id: "trace_1", correlation_id: "runtime_1", causation_id: "job_1", profile_id: null, conversation_id: null, run_id: null, task_id: null, approval_id: null, student_ref: null, case_ref: null, capability_id: null, payload: { container_id: "runtime_1", observed_state: "requested" } }).execute();
  await db.insertInto("stream_sequences").values({ tenant_id: "tenant_outbox", stream_id: "runtime_1", last_sequence: 1 }).execute();
  await db.insertInto("outbox").values({ tenant_id: "tenant_outbox", outbox_id: "outbox_1", event_id: "event_1", delivery_target: "internal_event_stream", status: "pending", attempt_count: 0, next_attempt_at: new Date(0), lease_owner: null, lease_expires_at: null, last_error_summary: null, delivered_at: null, created_at: new Date(0), updated_at: new Date(0) }).execute();
});
test.after(async () => db.destroy());

test("Outbox concurrent claims are exclusive and an expired lease is recoverable", async () => {
  const [left, right] = await Promise.all([claimOutboxWakeups(db, { workerId: "worker_a", limit: 8, leaseMs: 30_000 }), claimOutboxWakeups(db, { workerId: "worker_b", limit: 8, leaseMs: 30_000 })]);
  assert.equal(left.length + right.length, 1);
  await db.updateTable("outbox").set({ lease_expires_at: new Date(0) }).where("outbox_id", "=", "outbox_1").execute();
  assert.equal((await claimOutboxWakeups(db, { workerId: "worker_c", limit: 8, leaseMs: 30_000 })).length, 1);
});

test("Outbox delivery and retry require current lease ownership", async () => {
  const [row] = await claimOutboxWakeups(db, { workerId: "worker_a", limit: 8, leaseMs: 30_000 });
  assert.ok(row);
  assert.deepEqual(await markOutboxDelivered(db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId: "wrong" }), { kind: "lease_lost" });
  assert.deepEqual(await rescheduleOutbox(db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId: "worker_a", nextAttemptAt: new Date(Date.now() + 1000), lastErrorSummary: "Bearer secret-value", redactor: createRedactor(["secret-value"]) }), { kind: "updated" });
  const stored = await db.selectFrom("outbox").select(["status", "last_error_summary", "lease_owner"]).where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow();
  assert.equal(stored.status, "pending"); assert.equal(stored.lease_owner, null); assert.doesNotMatch(stored.last_error_summary ?? "", /Bearer|secret-value/);
});
