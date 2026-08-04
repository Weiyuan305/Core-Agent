import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Pool } from "pg";

import { appendProductEvents, applyMigrations, createRuntimeDatabase, withTenantTransaction } from "../src/index.js";

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
