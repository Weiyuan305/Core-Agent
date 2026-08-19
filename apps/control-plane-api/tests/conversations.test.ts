import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { ConversationSchema } from "@core-agent/contracts";
import { canonicalPayloadHash, deriveConversationId } from "@core-agent/runtime-core";
import { Pool } from "pg";
import Schema from "typebox/schema";

import {
  buildHttpAdmissionApp,
  createRuntimeDatabase,
  resetHttpAdmissionDatabase,
  seedHttpReadyTenant,
  trustedContextHeaders,
} from "./admission-http-test-support.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const validator = Schema.Compile(ConversationSchema);

test("trusted context admits a Conversation and rejects bootstrap authority", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_conversation";
  const profileId = await seedHttpReadyTenant(db, tenantId);
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db);
  try {
    const unhashed = { schema_version: 1, idempotency_key: "idem_http_conversation", tenant_id: tenantId, profile_id: profileId };
    const headers = trustedContextHeaders({
      tenantId,
      profileId,
      conversationId: deriveConversationId(tenantId, unhashed.idempotency_key),
      runId: "run_http_conversation_context",
    });
    const response = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers,
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(validator.Check(response.json()), true);
    const replay = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers,
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.deepEqual(replay.json(), response.json());
    const wrongTenant = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: trustedContextHeaders({
        tenantId: "tenant_other",
        profileId: "profile_tenant_other",
        conversationId: deriveConversationId("tenant_other", unhashed.idempotency_key),
        runId: "run_http_conversation_context",
      }),
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.equal(wrongTenant.statusCode, 404);
    assert.equal((wrongTenant.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
    const clientAuthority = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers,
      payload: { ...unhashed, actor_id: "actor_client", payload_hash: canonicalPayloadHash({ ...unhashed, actor_id: "actor_client" }) },
    });
    assert.equal(clientAuthority.statusCode, 400);
    assert.equal((clientAuthority.json() as { code: string }).code, "INVALID_REQUEST");
    const bootstrapAttempt = await app.inject({
      method: "POST",
      url: "/internal/v1/conversations",
      headers: { authorization: "Bearer synthetic-bootstrap-key-00000001", "x-core-agent-tenant-id": tenantId },
      payload: { ...unhashed, payload_hash: canonicalPayloadHash(unhashed) },
    });
    assert.equal(bootstrapAttempt.statusCode, 401);
    assert.equal((bootstrapAttempt.json() as { code: string }).code, "UNAUTHENTICATED");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await db.destroy();
  }
});
