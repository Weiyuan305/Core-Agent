import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeToolArguments } from "../src/policy/canonical-json.js";
import { evaluateReadMcp } from "../src/policy/evaluate-read-mcp.js";
import { deriveExecutionProof, executionProofDigest, proofDigestMatches } from "../src/services/policy/proof-crypto.js";

const schema = {
  type: "object", additionalProperties: false,
  properties: { profile_id: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["profile_id"],
} as const;

test("canonical arguments are order-independent and reject hostile JS values", () => {
  const left = canonicalizeToolArguments({ b: 2, a: "one" });
  const right = canonicalizeToolArguments({ a: "one", b: 2 });
  assert.equal(left.hash, right.hash);
  assert.equal(left.json, '{"a":"one","b":2}');
  assert.notEqual(left.hash, canonicalizeToolArguments({ a: "two", b: 2 }).hash);
  assert.throws(() => canonicalizeToolArguments({ value: Number.NaN }), /arguments are invalid/u);
  assert.throws(() => canonicalizeToolArguments({ __core_agent_policy: "forged" }), /arguments are invalid/u);
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "leak" });
  assert.throws(() => canonicalizeToolArguments(accessor), /arguments are invalid/u);
});

test("pure evaluator allows only exact current reviewed read MCP facts", () => {
  const base = {
    session: { active: true, snapshotMatches: true },
    authority: { current: true, capabilityVersionIds: ["cv-1"] },
    capability: { capabilityVersionId: "cv-1", kind: "mcp", riskClass: "read", approvalRequirement: "none", status: "reviewed" },
    binding: { present: true, capabilityVersionId: "cv-1", status: "reviewed", inputSchema: schema },
    arguments: { profile_id: "fixture" },
  } as const;
  assert.deepEqual(evaluateReadMcp(base), { decision: "allow", reason: "POLICY_ALLOWED" });
  assert.deepEqual(evaluateReadMcp({ ...base, authority: { ...base.authority, current: false } }), { decision: "deny", reason: "CURRENT_AUTHORITY_CHANGED" });
  assert.deepEqual(evaluateReadMcp({ ...base, capability: { ...base.capability, riskClass: "external_write" } }), { decision: "deny", reason: "POLICY_NOT_PERMITTED" });
  assert.deepEqual(evaluateReadMcp({ ...base, arguments: {} }), { decision: "deny", reason: "ARGUMENTS_INVALID" });
});

test("policy output never reflects arguments or catalog details", () => {
  const result = evaluateReadMcp({
    session: { active: false, snapshotMatches: false }, authority: { current: false, capabilityVersionIds: [] },
    capability: null, binding: null, arguments: { token: "must-not-leak" },
  });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.deepEqual(Object.keys(result).sort(), ["decision", "reason"]);
});

test("execution proof is deterministic from stored facts while only its digest is persisted", () => {
  const bytes = Buffer.alloc(32, 7);
  const key = { withBytes: <T>(use: (value: Uint8Array) => T) => use(bytes) };
  const facts = { tenantId: "tenant", policySessionId: "session", decisionId: "decision", proofId: "proof", argumentsHash: `sha256:${"a".repeat(64)}` };
  const proof = deriveExecutionProof(key, facts);
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(deriveExecutionProof(key, facts), proof);
  const digest = executionProofDigest(key, proof)!;
  assert.equal(proofDigestMatches(digest, executionProofDigest(key, proof)!), true);
  assert.equal(Buffer.from(digest).includes(Buffer.from(proof)), false);
  assert.equal(executionProofDigest(key, "malformed"), undefined);
});
