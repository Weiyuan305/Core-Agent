import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  ClosePolicySessionRequestSchema,
  OpenPolicySessionRequestSchema,
  OpenPolicySessionResponseSchema,
  PolicySessionStateSchema,
} from "../src/index.js";

const context = {
  schema_version: 1,
  tenant_mode: "b2b",
  tenant_id: "tenant_demo",
  actor_id: "actor_demo",
  original_actor_id: "actor_demo",
  membership_id: "membership_demo",
  effective_role: "consultant",
  profile_id: "profile_demo",
  conversation_id: "conversation_demo",
  run_id: "run_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  client_request_id: "client_request_demo",
  entitlement_snapshot_ref: {
    snapshot_id: "snapshot_demo",
    version: 1,
    evaluated_at: "2026-08-25T01:00:00Z",
  },
  capability_ids: ["capability.synthetic.read"],
  container_id: "runtime_demo",
  context_id: "context_demo",
  issuer: "core-agent-control-plane",
  audience: ["core-agent-policy-mcp-gateway"],
  issued_at: "2026-08-25T01:00:00Z",
  expires_at: "2026-08-25T01:05:00Z",
  key_id: "key_demo",
};

const signedContext = {
  schema_version: 1,
  algorithm: "EdDSA",
  key_id: "key_demo",
  payload: context,
  signature: "A".repeat(86),
};

test("policy session contracts are closed and bind an exact run", () => {
  const request = {
    schema_version: 1,
    signed_context: signedContext,
    runtime_container_id: "runtime_demo",
    runtime_generation: 3,
    hermes_session_ref: "hermes_session_demo",
    idempotency_key: "policy_session.run_demo",
    correlation_id: "correlation_demo",
  };
  assert.equal(Schema.Check(OpenPolicySessionRequestSchema, request), true);
  assert.equal(Schema.Check(OpenPolicySessionRequestSchema, { ...request, tenant_id: "attacker" }), false);
  assert.equal(Schema.Check(OpenPolicySessionRequestSchema, { ...request, runtime_generation: 0 }), false);

  const response = {
    schema_version: 1,
    policy_session_id: "policy_session_demo",
    state: "active",
    policy_version: "core-agent-read-mcp-v1",
    expires_at: "2026-08-25T01:05:00Z",
  };
  assert.equal(Schema.Check(OpenPolicySessionResponseSchema, response), true);
  assert.equal(Schema.Check(OpenPolicySessionResponseSchema, { ...response, proof: "secret" }), false);
  assert.equal(Schema.Check(PolicySessionStateSchema, "expired"), true);
  assert.equal(Schema.Check(PolicySessionStateSchema, "ready"), false);
});

test("close request carries no caller-selected authority", () => {
  const request = {
    schema_version: 1,
    policy_session_id: "policy_session_demo",
    run_id: "run_demo",
    reason: "run_succeeded",
    idempotency_key: "close.run_demo",
    request_id: "request_demo",
    trace_id: "trace_demo",
  };
  assert.equal(Schema.Check(ClosePolicySessionRequestSchema, request), true);
  assert.equal(Schema.Check(ClosePolicySessionRequestSchema, { ...request, policy_version: "attacker" }), false);
});
