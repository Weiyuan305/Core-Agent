import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { ConversationSchema } from "@core-agent/contracts";
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
const validator = Schema.Compile(ConversationSchema);

test("POST /internal/v1/conversations uses tenant authority and returns a contract-valid Conversation", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_conversation";
  const profileId = await seedHttpReadyTenant(db, tenantId);
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db);
  try {
    const unhashed = { schema_version: 1, idempotency_key: "idem_http_conversation", tenant_id: tenantId, profile_id: profileId };
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(validator.Check(response.json()), true);
    const replay = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.deepEqual(replay.json(), response.json());
    const wrongTenant = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": "tenant_other" },
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.equal(wrongTenant.statusCode, 400);
    assert.equal((wrongTenant.json() as { code: string }).code, "INVALID_REQUEST");
    const clientAuthority = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: { authorization: `Bearer ${bootstrapKey}`, "x-core-agent-tenant-id": tenantId },
      payload: { ...unhashed, actor_id: "actor_client", payload_hash: canonicalPayloadHash({ ...unhashed, actor_id: "actor_client" }) },
    });
    assert.equal(clientAuthority.statusCode, 400);
    assert.equal((clientAuthority.json() as { code: string }).code, "INVALID_REQUEST");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await db.destroy();
  }
});
