import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { AgentRunSchema } from "@core-agent/contracts";
import { canonicalPayloadHash } from "@core-agent/runtime-core";
import { Pool } from "pg";
import Schema from "typebox/schema";

import {
  bootstrapKey,
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
const validator = Schema.Compile(AgentRunSchema);

test("POST conversation Run and tenant-scoped GET return only a contract-valid AgentRun", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_run";
  const profileId = await seedHttpReadyTenant(db, tenantId);
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db);
  try {
    const conversationPayload = { schema_version: 1, idempotency_key: "idem_http_run_conversation", tenant_id: tenantId, profile_id: profileId };
    const conversationResponse = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
      payload: { ...conversationPayload, payload_hash: canonicalPayloadHash(conversationPayload) },
    });
    assert.equal(conversationResponse.statusCode, 201);
    const conversationId = (conversationResponse.json() as { conversation_id: string }).conversation_id;
    const runPayload = { schema_version: 1, idempotency_key: "idem_http_run", client_request_id: "client_http_run", input_message: { client_message_id: "message_http_run", content: "Hello central agent" } };
    const created = await app.inject({
      method: "POST",
      url: `/internal/v1/conversations/${conversationId}/runs`,
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
      payload: { ...runPayload, payload_hash: canonicalPayloadHash(runPayload) },
    });
    assert.equal(created.statusCode, 202);
    assert.equal(validator.Check(created.json()), true);
    const replay = await app.inject({
      method: "POST",
      url: `/internal/v1/conversations/${conversationId}/runs`,
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
      payload: { ...runPayload, payload_hash: canonicalPayloadHash(runPayload) },
    });
    assert.deepEqual(replay.json(), created.json());
    const run = created.json() as { run_id: string };
    const queried = await app.inject({
      method: "GET",
      url: `/internal/v1/runs/${run.run_id}`,
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
    });
    assert.equal(queried.statusCode, 200);
    assert.deepEqual(queried.json(), created.json());
    assert.deepEqual(Object.keys(queried.json() as object).sort(), [
      "client_request_id", "conversation_id", "created_at", "idempotency_key", "request_id", "resource_version",
      "run_id", "schema_version", "status", "tenant_id", "trace_id", "updated_at",
    ]);
    const absent = await app.inject({
      method: "GET",
      url: "/internal/v1/runs/run_absent",
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
    });
    const crossTenant = await app.inject({
      method: "GET",
      url: `/internal/v1/runs/${run.run_id}`,
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": "tenant_other" },
    });
    assert.equal(absent.statusCode, 404);
    assert.equal(crossTenant.statusCode, 404);
    assert.equal((absent.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
    assert.equal((crossTenant.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
    assert.equal((absent.json() as { message: string }).message, (crossTenant.json() as { message: string }).message);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await db.destroy();
  }
});
