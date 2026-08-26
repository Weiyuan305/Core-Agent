import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  PolicyDecisionReasonSchema,
  ToolPolicyDecisionRequestSchema,
  ToolPolicyDecisionResponseSchema,
} from "../src/index.js";

test("tool decision request accepts only hook facts and opaque arguments", () => {
  const request = {
    schema_version: 1,
    hermes_session_ref: "hermes_session_demo",
    tool_call_id: "tool_call_demo",
    tool_name: "core_agent.synthetic_profile",
    arguments: { subject: "platform" },
  };
  assert.equal(Schema.Check(ToolPolicyDecisionRequestSchema, request), true);
  assert.equal(Schema.Check(ToolPolicyDecisionRequestSchema, { ...request, tenant_id: "attacker" }), false);
  assert.equal(Schema.Check(ToolPolicyDecisionRequestSchema, { ...request, policy_version: "attacker" }), false);
});

test("decision response returns proof only on allow and never internal routing", () => {
  const allowed = {
    schema_version: 1,
    decision_id: "decision_demo",
    decision: "allow",
    reason: "POLICY_ALLOWED",
    execution_proof: "opaque-proof-value-with-sufficient-length",
    expires_at: "2026-08-25T01:00:30Z",
  };
  const denied = {
    schema_version: 1,
    decision_id: "decision_denied",
    decision: "deny",
    reason: "CURRENT_AUTHORITY_CHANGED",
  };
  assert.equal(Schema.Check(ToolPolicyDecisionResponseSchema, allowed), true);
  assert.equal(Schema.Check(ToolPolicyDecisionResponseSchema, denied), true);
  assert.equal(Schema.Check(ToolPolicyDecisionResponseSchema, { ...denied, execution_proof: "secret" }), false);
  assert.equal(Schema.Check(ToolPolicyDecisionResponseSchema, { ...allowed, endpoint: "https://private" }), false);
  assert.equal(Schema.Check(PolicyDecisionReasonSchema, "PROOF_REPLAYED"), true);
  assert.equal(Schema.Check(PolicyDecisionReasonSchema, "MAYBE"), false);
});
