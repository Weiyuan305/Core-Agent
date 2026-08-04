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
      expiresAt: new Date("2026-08-04T00:00:00.000Z"),
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
