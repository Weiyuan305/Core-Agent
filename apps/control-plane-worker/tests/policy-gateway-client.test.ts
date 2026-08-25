import assert from "node:assert/strict";
import test from "node:test";

import type { OpenPolicySessionRequest } from "@core-agent/contracts";

import { PolicyGatewayClient, PolicyGatewayClientError } from "../src/policy-gateway-client.js";

const signedContext = {
  schema_version: 1 as const, algorithm: "EdDSA" as const, key_id: "key-a", signature: "signature-a",
  payload: {
    schema_version: 1 as const, tenant_mode: "b2b" as const, tenant_id: "tenant-a", actor_id: "actor-a",
    original_actor_id: "actor-a", membership_id: "membership-a", effective_role: "consultant" as const,
    profile_id: "profile-a", entitlement_snapshot_ref: { snapshot_id: "snapshot-a", version: 1, evaluated_at: "2026-08-25T10:00:00.000Z" },
    capability_ids: ["core_agent.synthetic_profile"], container_id: "runtime-a", conversation_id: "conversation-a",
    run_id: "run-a", request_id: "request-a", trace_id: "trace-a", client_request_id: "client-a",
    context_id: "context-a", issuer: "identity-gateway", audience: ["policy-gateway"],
    issued_at: "2026-08-25T10:00:00.000Z", expires_at: "2026-08-25T10:05:00.000Z", key_id: "key-a",
  },
};
const openRequest: OpenPolicySessionRequest = {
  schema_version: 1, signed_context: signedContext, runtime_container_id: "runtime-a", runtime_generation: 1,
  hermes_session_ref: "hermes-session-a", idempotency_key: "policy-open-run-a", correlation_id: "run-a",
};

test("Policy Gateway Worker client uses exact private auth and closed open/close responses", async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new PolicyGatewayClient("http://policy-mcp-gateway:8787", "w".repeat(32), async (input, init) => {
    seen.push({ url: String(input), init });
    if (String(input).endsWith("/open")) return Response.json({
      schema_version: 1, policy_session_id: "policy-session-a", state: "active",
      policy_version: "core-agent-read-mcp-v1", expires_at: "2026-08-25T10:05:00.000Z",
    });
    return Response.json({ schema_version: 1, policy_session_id: "policy-session-a", state: "closed" });
  });
  const opened = await client.open(openRequest);
  await client.close("tenant-a", {
    schema_version: 1, policy_session_id: opened.policy_session_id, run_id: "run-a", reason: "run_succeeded",
    idempotency_key: "policy-close-run-a", request_id: "request-a", trace_id: "trace-a",
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.url, "http://policy-mcp-gateway:8787/v1/policy-sessions/open");
  assert.equal(seen[1]!.url, "http://policy-mcp-gateway:8787/v1/policy-sessions/policy-session-a/close");
  assert.equal(new Headers(seen[0]!.init?.headers).get("authorization"), `Bearer ${"w".repeat(32)}`);
  assert.equal(new Headers(seen[0]!.init?.headers).get("x-core-agent-tenant-id"), null);
  assert.equal(new Headers(seen[1]!.init?.headers).get("x-core-agent-tenant-id"), "tenant-a");
  assert.equal(seen[0]!.init?.redirect, "error");
});

test("Policy Gateway Worker client rejects malformed and oversized responses without reflecting bodies", async () => {
  for (const response of [
    Response.json({ schema_version: 1, policy_session_id: "x", state: "active", extra: true }),
    new Response("x".repeat(16 * 1024 + 1), { headers: { "content-type": "application/json" } }),
    new Response("private", { status: 503, headers: { "content-type": "text/plain" } }),
  ]) {
    const client = new PolicyGatewayClient("http://127.0.0.1:8787", "w".repeat(32), async () => response);
    await assert.rejects(client.open(openRequest), (failure: unknown) => (
      failure instanceof PolicyGatewayClientError && !failure.message.includes("private")
    ));
  }
});
