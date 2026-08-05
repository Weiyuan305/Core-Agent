import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { applyMigrations, claimOutboxWakeups, createRedactor, createRuntimeDatabase, failOutbox, markOutboxDelivered, OUTBOX_RECOVERY_BATCH_SIZE, readEventsAfter, rescheduleOutbox } from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));
const exhaustedSummary = "Outbox delivery attempt budget exhausted";

async function seedOutbox(tenantId: string): Promise<void> {
  await db.insertInto("tenants").values({ tenant_id: tenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2b", status: "active", display_name: `Outbox ${tenantId}`, created_at: new Date(0), updated_at: new Date(0) }).execute();
  await db.insertInto("product_events").values({ tenant_id: tenantId, event_id: "event_1", stream_id: "runtime_1", schema_version: 1, sequence: 1, event_type: "runtime.status_changed", occurred_at: new Date(0), request_id: "request_1", trace_id: "trace_1", correlation_id: "runtime_1", causation_id: "job_1", profile_id: null, conversation_id: null, run_id: null, task_id: null, approval_id: null, student_ref: null, case_ref: null, capability_id: null, payload: { container_id: "runtime_1", observed_state: "requested" } }).execute();
  await db.insertInto("stream_sequences").values({ tenant_id: tenantId, stream_id: "runtime_1", last_sequence: 1 }).execute();
  await db.insertInto("outbox").values({ tenant_id: tenantId, outbox_id: "outbox_1", event_id: "event_1", delivery_target: "internal_event_stream", status: "pending", attempt_count: 0, next_attempt_at: new Date(0), lease_owner: null, lease_expires_at: null, last_error_summary: null, delivered_at: null, created_at: new Date(0), updated_at: new Date(0) }).execute();
}

async function seedExhaustedOutboxBacklog(total: number): Promise<void> {
  assert.ok(total >= 1);
  await db.updateTable("stream_sequences").set({ last_sequence: total })
    .where("tenant_id", "=", "tenant_outbox").where("stream_id", "=", "runtime_1").execute();
  await db.updateTable("outbox").set({ attempt_count: 10, lease_owner: null, lease_expires_at: null, created_at: new Date(1) })
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").execute();
  if (total === 1) return;
  const indexes = Array.from({ length: total - 1 }, (_, offset) => offset + 2);
  await db.insertInto("product_events").values(indexes.map((index) => ({
    tenant_id: "tenant_outbox", event_id: `event_${String(index).padStart(4, "0")}`, stream_id: "runtime_1",
    schema_version: 1, sequence: index, event_type: "runtime.status_changed", occurred_at: new Date(index),
    request_id: `request_${index}`, trace_id: `trace_${index}`, correlation_id: "runtime_1", causation_id: `job_${index}`,
    profile_id: null, conversation_id: null, run_id: null, task_id: null, approval_id: null, student_ref: null,
    case_ref: null, capability_id: null, payload: { container_id: "runtime_1", observed_state: "requested" },
  }))).execute();
  await db.insertInto("outbox").values(indexes.map((index) => ({
    tenant_id: "tenant_outbox", outbox_id: `outbox_${String(index).padStart(4, "0")}`,
    event_id: `event_${String(index).padStart(4, "0")}`, delivery_target: "internal_event_stream", status: "pending",
    attempt_count: 10, next_attempt_at: new Date(0), lease_owner: null, lease_expires_at: null,
    last_error_summary: null, delivered_at: null, created_at: new Date(index), updated_at: new Date(0),
  }))).execute();
}

test.beforeEach(async () => {
  await pool.query("drop schema public cascade; create schema public;"); await applyMigrations(pool, migrationsDirectory);
  await seedOutbox("tenant_outbox");
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
  assert.deepEqual(await markOutboxDelivered(db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId: "wrong", attemptCount: row.attemptCount }), { kind: "lease_lost" });
  assert.deepEqual(await rescheduleOutbox(db, { tenantId: row.tenantId, outboxId: row.outboxId, workerId: "worker_a", attemptCount: row.attemptCount, nextAttemptAt: new Date(Date.now() + 1000), lastErrorSummary: "Bearer secret-value", redactor: createRedactor(["secret-value"]) }), { kind: "updated" });
  const stored = await db.selectFrom("outbox").select(["status", "last_error_summary", "lease_owner"]).where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow();
  assert.equal(stored.status, "pending"); assert.equal(stored.lease_owner, null); assert.doesNotMatch(stored.last_error_summary ?? "", /Bearer|secret-value/);
});

test("same-owner Outbox reclaim fences delivered retry and failure mutations", async () => {
  const mutations = [
    (row: { tenantId: string; outboxId: string; attemptCount: number }) => markOutboxDelivered(db, { ...row, workerId: "worker_same" }),
    (row: { tenantId: string; outboxId: string; attemptCount: number }) => rescheduleOutbox(db, { ...row, workerId: "worker_same", nextAttemptAt: new Date(1), lastErrorSummary: "synthetic", redactor: createRedactor([]) }),
    (row: { tenantId: string; outboxId: string; attemptCount: number }) => failOutbox(db, { ...row, workerId: "worker_same", lastErrorSummary: "synthetic", redactor: createRedactor([]) }),
  ];
  for (const mutate of mutations) {
    const [stale] = await claimOutboxWakeups(db, { workerId: "worker_same", limit: 1, leaseMs: 30_000 });
    await db.updateTable("outbox").set({ lease_expires_at: new Date(0) }).where("outbox_id", "=", stale!.outboxId).execute();
    const [current] = await claimOutboxWakeups(db, { workerId: "worker_same", limit: 1, leaseMs: 30_000 });
    assert.deepEqual(await mutate(stale!), { kind: "lease_lost" });
    assert.deepEqual(await mutate(current!), { kind: "updated" });
    await db.updateTable("outbox").set({ status: "pending", lease_owner: null, lease_expires_at: null, next_attempt_at: new Date(0) }).where("outbox_id", "=", current!.outboxId).execute();
  }
});

test("expired attempt ten is terminalized once without notification or cross-tenant mutation", async () => {
  await seedOutbox("tenant_outbox_other");
  await db.updateTable("outbox").set({ attempt_count: 10, lease_owner: "worker_crashed", lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").execute();
  const liveLease = new Date("2400-01-01T00:00:00.000Z");
  await db.updateTable("outbox").set({ attempt_count: 10, lease_owner: "worker_live", lease_expires_at: liveLease })
    .where("tenant_id", "=", "tenant_outbox_other").where("outbox_id", "=", "outbox_1").execute();
  const before = await pool.query<{ database_now: Date }>("select clock_timestamp() as database_now");

  const claims = await Promise.all([
    claimOutboxWakeups(db, { workerId: "worker_recovery_a", limit: 8, leaseMs: 30_000 }),
    claimOutboxWakeups(db, { workerId: "worker_recovery_b", limit: 8, leaseMs: 30_000 }),
  ]);
  assert.deepEqual(claims, [[], []]);
  const after = await pool.query<{ database_now: Date }>("select clock_timestamp() as database_now");
  const exhausted = await db.selectFrom("outbox").selectAll()
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow();
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.attempt_count, 10);
  assert.equal(exhausted.lease_owner, null);
  assert.equal(exhausted.lease_expires_at, null);
  assert.equal(exhausted.last_error_summary, exhaustedSummary);
  assert.equal(exhausted.delivered_at, null);
  assert.ok(exhausted.updated_at >= before.rows[0]!.database_now);
  assert.ok(exhausted.updated_at <= after.rows[0]!.database_now);
  assert.deepEqual(
    await db.selectFrom("outbox").select(["status", "attempt_count", "lease_owner", "lease_expires_at"])
      .where("tenant_id", "=", "tenant_outbox_other").where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow(),
    { status: "pending", attempt_count: 10, lease_owner: "worker_live", lease_expires_at: liveLease },
  );
  const primaryEvents = await readEventsAfter({ tenantId: "tenant_outbox", db }, "runtime_1", 0);
  const otherEvents = await readEventsAfter({ tenantId: "tenant_outbox_other", db }, "runtime_1", 0);
  assert.deepEqual(primaryEvents.map((event) => [event.tenant_id, event.event_id]), [["tenant_outbox", "event_1"]]);
  assert.deepEqual(otherEvents.map((event) => [event.tenant_id, event.event_id]), [["tenant_outbox_other", "event_1"]]);
});

test("notification success with a lost delivered acknowledgement later terminalizes attempt ten", async () => {
  await db.updateTable("outbox").set({ attempt_count: 9, lease_owner: null, lease_expires_at: null })
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").execute();
  const [claimed] = await claimOutboxWakeups(db, { workerId: "worker_notified", limit: 1, leaseMs: 30_000 });
  assert.equal(claimed?.attemptCount, 10);
  await db.updateTable("outbox").set({ lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").execute();
  assert.deepEqual(await markOutboxDelivered(db, { ...claimed!, workerId: "worker_notified" }), { kind: "lease_lost" });

  assert.deepEqual(await claimOutboxWakeups(db, { workerId: "worker_recovery", limit: 1, leaseMs: 30_000 }), []);
  assert.deepEqual(
    await db.selectFrom("outbox").select(["status", "attempt_count", "last_error_summary", "delivered_at"])
      .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow(),
    { status: "failed", attempt_count: 10, last_error_summary: exhaustedSummary, delivered_at: null },
  );
  assert.equal((await readEventsAfter({ tenantId: "tenant_outbox", db }, "runtime_1", 0)).length, 1);
});

test("a live tenth lease is untouched and an expired ninth lease receives exactly attempt ten", async () => {
  const liveLease = new Date("2400-01-01T00:00:00.000Z");
  await db.updateTable("outbox").set({ attempt_count: 10, lease_owner: "worker_live", lease_expires_at: liveLease })
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").execute();
  assert.deepEqual(await claimOutboxWakeups(db, { workerId: "worker_other", limit: 1, leaseMs: 30_000 }), []);
  assert.deepEqual(
    await db.selectFrom("outbox").select(["status", "attempt_count", "lease_owner", "lease_expires_at"])
      .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow(),
    { status: "pending", attempt_count: 10, lease_owner: "worker_live", lease_expires_at: liveLease },
  );

  await db.updateTable("outbox").set({ attempt_count: 9, lease_owner: "worker_stale", lease_expires_at: new Date(0) })
    .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").execute();
  const [attemptTen] = await claimOutboxWakeups(db, { workerId: "worker_ten", limit: 1, leaseMs: 30_000 });
  assert.equal(attemptTen?.attemptCount, 10);
  assert.deepEqual(await claimOutboxWakeups(db, { workerId: "worker_eleven", limit: 1, leaseMs: 30_000 }), []);
  assert.deepEqual(
    await db.selectFrom("outbox").select(["status", "attempt_count", "lease_owner"])
      .where("tenant_id", "=", "tenant_outbox").where("outbox_id", "=", "outbox_1").executeTakeFirstOrThrow(),
    { status: "pending", attempt_count: 10, lease_owner: "worker_ten" },
  );
});

test("exhausted recovery terminalizes one bounded batch and the next claim advances the backlog", async () => {
  await seedExhaustedOutboxBacklog(OUTBOX_RECOVERY_BATCH_SIZE + 5);

  assert.deepEqual(await claimOutboxWakeups(db, { workerId: "worker_batch_one", limit: 1, leaseMs: 30_000 }), []);
  assert.deepEqual(
    (await pool.query<{ status: string; count: string }>("select status, count(*)::text as count from outbox group by status order by status")).rows,
    [{ status: "failed", count: String(OUTBOX_RECOVERY_BATCH_SIZE) }, { status: "pending", count: "5" }],
  );

  assert.deepEqual(await claimOutboxWakeups(db, { workerId: "worker_batch_two", limit: 1, leaseMs: 30_000 }), []);
  assert.deepEqual(
    (await pool.query<{ status: string; count: string }>("select status, count(*)::text as count from outbox group by status order by status")).rows,
    [{ status: "failed", count: String(OUTBOX_RECOVERY_BATCH_SIZE + 5) }],
  );
});

test("concurrent exhausted recovery skips another worker's locked batch", { timeout: 5_000 }, async () => {
  await seedExhaustedOutboxBacklog(OUTBOX_RECOVERY_BATCH_SIZE + 50);
  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    const locked = await blocker.query(`
      select tenant_id, outbox_id from outbox
      where status = 'pending' and attempt_count >= 10
        and (lease_owner is null or lease_expires_at is null or lease_expires_at <= clock_timestamp())
      order by created_at, tenant_id, outbox_id
      limit ${OUTBOX_RECOVERY_BATCH_SIZE}
      for update
    `);
    assert.equal(locked.rowCount, OUTBOX_RECOVERY_BATCH_SIZE);
    const claim = claimOutboxWakeups(db, { workerId: "worker_skip_locked", limit: 1, leaseMs: 30_000 });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const lockWait = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("recovery waited on another worker's row locks")), 1_000);
    });
    const result = await Promise.race([claim, lockWait]).finally(() => clearTimeout(timeout));
    assert.deepEqual(result, []);
    assert.deepEqual(
      (await pool.query<{ status: string; count: string }>("select status, count(*)::text as count from outbox group by status order by status")).rows,
      [{ status: "failed", count: "50" }, { status: "pending", count: String(OUTBOX_RECOVERY_BATCH_SIZE) }],
    );
  } finally {
    await blocker.query("rollback");
    blocker.release();
  }

  assert.deepEqual(await claimOutboxWakeups(db, { workerId: "worker_after_unlock", limit: 1, leaseMs: 30_000 }), []);
  assert.equal((await pool.query<{ count: number }>("select count(*)::integer as count from outbox where status = 'failed'")).rows[0]?.count, OUTBOX_RECOVERY_BATCH_SIZE + 50);
});
