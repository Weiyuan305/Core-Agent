import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import {
  appendAuditEvent,
  appendProductEvents,
  applyMigrations,
  createRuntimeDatabase,
  readEventsAfter,
  withTenantTransaction,
} from "../src/index.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const migrationsDirectory = join(fileURLToPath(new URL("../migrations/", import.meta.url)));

test.beforeEach(async () => {
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
  await db.insertInto("tenants").values({
    tenant_id: "tenant_events", schema_version: 1, resource_version: 1,
    tenant_mode: "b2b", status: "active", display_name: "Synthetic events tenant",
    created_at: new Date("2026-08-03T00:00:00.000Z"), updated_at: new Date("2026-08-03T00:00:00.000Z"),
  }).execute();
});
test.after(async () => { await db.destroy(); });

test("event append allocates sequences and outbox rows atomically", async () => {
  const result = await withTenantTransaction(db, "tenant_events", (context) => appendProductEvents(context, {
    streamId: "conversation_1",
    deliveryTarget: "internal_event_stream",
    events: [{
      schema_version: 1, event_id: "event_1", occurred_at: "2026-08-03T12:00:00.000Z",
      tenant_id: "tenant_events", request_id: "request_1", trace_id: "trace_1",
      correlation_id: "conversation_1", causation_id: "request_1", event_type: "error.reported",
      payload: { error_id: "error_1", code: "INTERNAL_ERROR", category: "internal" },
    }],
  }));
  assert.deepEqual(result.map((event) => event.sequence), [1]);
  const outbox = await db.selectFrom("outbox").selectAll().where("tenant_id", "=", "tenant_events").execute();
  assert.equal(outbox.length, 1);
});

test("readEventsAfter returns complete validated ProductEvents strictly after the cursor", async () => {
  await withTenantTransaction(db, "tenant_events", (context) => appendProductEvents(context, {
    streamId: "conversation_conversation_1",
    deliveryTarget: "internal_event_stream",
    events: [1, 2, 3, 4].map((index) => ({
      schema_version: 1 as const,
      event_id: `event_read_${index}`,
      occurred_at: `2026-08-03T12:00:0${index}.000Z`,
      tenant_id: "tenant_events",
      request_id: "request_1",
      trace_id: "trace_1",
      correlation_id: "conversation_1",
      causation_id: "run_1",
      event_type: "message.delta" as const,
      payload: { message_id: "message_1", delta: `Synthetic ${index}` },
    })),
  }));

  const events = await readEventsAfter(
    { tenantId: "tenant_events", db },
    "conversation_conversation_1",
    2,
  );

  assert.deepEqual(events.map(({ stream_id, sequence, event_id }) => ({ stream_id, sequence, event_id })), [
    { stream_id: "conversation_conversation_1", sequence: 3, event_id: "event_read_3" },
    { stream_id: "conversation_conversation_1", sequence: 4, event_id: "event_read_4" },
  ]);
  assert.deepEqual(events[0], {
    stream_id: "conversation_conversation_1",
    schema_version: 1,
    event_id: "event_read_3",
    occurred_at: "2026-08-03T12:00:03.000Z",
    sequence: 3,
    tenant_id: "tenant_events",
    request_id: "request_1",
    trace_id: "trace_1",
    correlation_id: "conversation_1",
    causation_id: "run_1",
    event_type: "message.delta",
    payload: { message_id: "message_1", delta: "Synthetic 3" },
  });
});

test("readEventsAfter rejects unsafe cursors and limits at the repository boundary", async () => {
  const context = { tenantId: "tenant_events", db };
  for (const afterSequence of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      readEventsAfter(context, "conversation_conversation_1", afterSequence),
      /INVALID_REQUEST/,
    );
  }
  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
    await assert.rejects(
      readEventsAfter(context, "conversation_conversation_1", 0, limit),
      /INVALID_REQUEST/,
    );
  }
});

test("readEventsAfter accepts an AbortSignal for cancellable PostgreSQL reads", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readEventsAfter(
      { tenantId: "tenant_events", db },
      "conversation_conversation_1",
      0,
      100,
      controller.signal,
    ),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("readEventsAfter fails closed on unsafe or contract-invalid persisted ProductEvents", async () => {
  const appendOne = async (eventId: string): Promise<void> => withTenantTransaction(
    db,
    "tenant_events",
    (context) => appendProductEvents(context, {
      streamId: "conversation_tampered",
      deliveryTarget: "internal_event_stream",
      events: [{
        schema_version: 1,
        event_id: eventId,
        occurred_at: "2026-08-03T12:00:00.000Z",
        tenant_id: "tenant_events",
        request_id: "request_1",
        trace_id: "trace_1",
        correlation_id: "conversation_tampered",
        causation_id: "run_1",
        event_type: "message.delta",
        payload: { message_id: "message_1", delta: "Synthetic" },
      }],
    }),
  ).then(() => undefined);

  await appendOne("event_unsafe_sequence");
  await db.updateTable("product_events").set({ sequence: String(Number.MAX_SAFE_INTEGER + 1) })
    .where("tenant_id", "=", "tenant_events").where("event_id", "=", "event_unsafe_sequence").execute();
  await assert.rejects(
    readEventsAfter({ tenantId: "tenant_events", db }, "conversation_tampered", 0),
    /safe integer/,
  );

  await db.deleteFrom("outbox").where("tenant_id", "=", "tenant_events").execute();
  await db.deleteFrom("product_events").where("tenant_id", "=", "tenant_events").execute();
  await db.deleteFrom("stream_sequences").where("tenant_id", "=", "tenant_events").execute();
  await appendOne("event_invalid_contract");
  await db.updateTable("product_events").set({ event_type: "unsupported.event" })
    .where("tenant_id", "=", "tenant_events").where("event_id", "=", "event_invalid_contract").execute();
  await assert.rejects(
    readEventsAfter({ tenantId: "tenant_events", db }, "conversation_tampered", 0),
    /INVALID_REQUEST/,
  );
});

test("audit append rejects unsafe optional resource versions before persistence", async () => {
  await assert.rejects(withTenantTransaction(db, "tenant_events", (context) => appendAuditEvent(context, {
    schema_version: 1, audit_event_id: "audit_unsafe", occurred_at: "2026-08-03T12:00:00.000Z",
    tenant_id: "tenant_events", actor_id: "actor_1", membership_id: "membership_1",
    effective_role: "admin", action: "synthetic", resource_type: "synthetic", resource_id: "resource_1",
    decision: "allowed", outcome: "succeeded", request_id: "request_1", trace_id: "trace_1",
    reason_summary: "Synthetic", resource_version: Number.MAX_SAFE_INTEGER + 1,
  })), /INVALID_REQUEST/);
});
