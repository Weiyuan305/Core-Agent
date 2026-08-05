import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { Pool } from "pg";

import {
  buildHttpAdmissionApp,
  createRuntimeDatabase,
  resetHttpAdmissionDatabase,
  seedHttpReadyTenant,
} from "./admission-http-test-support.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);

test.after(async () => { await db.destroy(); });

test("SSE conversation events route is registered", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_red";
  const profileId = await seedHttpReadyTenant(db, tenantId);
  const now = new Date("2026-08-05T02:00:00.000Z");
  await db.insertInto("conversations").values({
    tenant_id: tenantId,
    conversation_id: "conversation_events_red",
    profile_id: profileId,
    created_by_actor_id: `owner_${tenantId}`,
    status: "active",
    schema_version: 1,
    resource_version: 1,
    student_ref: null,
    case_ref: null,
    created_at: now,
    updated_at: now,
  }).execute();
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db);
  try {
    assert.equal(app.hasRoute({
      method: "GET",
      url: "/internal/v1/conversations/:conversation_id/events",
    }), true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
