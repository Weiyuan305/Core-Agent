import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BUILTIN_READ_POLICY,
  BUILTIN_READ_POLICY_HASH,
  canonicalPolicyHash,
} from "../src/policy/builtin-read-policy.js";
import {
  validateReviewedMcpBinding,
  validateReviewedServerVersion,
} from "../src/services/policy/catalog-validation.js";

const closedSchema = {
  type: "object",
  additionalProperties: false,
  properties: { profile_id: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["profile_id"],
} as const;

test("built-in read policy has one deterministic immutable hash", () => {
  assert.equal(BUILTIN_READ_POLICY.version, "core-agent-read-mcp-v1");
  assert.equal(canonicalPolicyHash(BUILTIN_READ_POLICY), BUILTIN_READ_POLICY_HASH);
  assert.match(BUILTIN_READ_POLICY_HASH, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(BUILTIN_READ_POLICY), true);
});

test("catalog admits only reviewed synthetic read MCP none bindings", () => {
  const server = validateReviewedServerVersion({
    mcp_server_version_id: "server-version-1",
    mcp_server_id: "synthetic-server",
    version: "1.0.0",
    adapter_kind: "synthetic",
    origin: null,
    protocol_version: "2025-03-26",
    credential_reference_id: null,
    connect_timeout_ms: 500,
    request_timeout_ms: 1000,
    maximum_response_bytes: 8192,
    status: "reviewed",
  });
  const binding = validateReviewedMcpBinding({
    mcp_tool_binding_id: "binding-1",
    capability_version_id: "capability-version-1",
    capability_id: "core_agent.synthetic_profile",
    capability_version: "1.0.0",
    public_tool_name: "core_agent.synthetic_profile",
    downstream_tool_name: "synthetic_profile",
    title: "Synthetic profile",
    description: "Returns deterministic non-customer fixture data.",
    input_schema_json: closedSchema,
    output_contract_ref: "gateway-tool-result@0.9.0",
    status: "reviewed",
  }, {
    capability_version_id: "capability-version-1",
    capability_id: "core_agent.synthetic_profile",
    version: "1.0.0",
    kind: "mcp",
    risk_class: "read",
    approval_requirement: "none",
    status: "reviewed",
  }, server);
  assert.equal(binding.inputSchemaHash.startsWith("sha256:"), true);
  assert.equal(Object.isFrozen(binding.inputSchema), true);
});

test("catalog rejects remote and executable or open schema surfaces", () => {
  assert.throws(() => validateReviewedServerVersion({
    mcp_server_version_id: "server-version-1", mcp_server_id: "remote", version: "1.0.0",
    adapter_kind: "remote_https", origin: "https://example.com", protocol_version: "2025-03-26",
    credential_reference_id: "secret-ref", connect_timeout_ms: 500, request_timeout_ms: 1000,
    maximum_response_bytes: 8192, status: "reviewed",
  }), /catalog is not permitted/u);
  const server = validateReviewedServerVersion({
    mcp_server_version_id: "server-version-1", mcp_server_id: "synthetic", version: "1.0.0",
    adapter_kind: "synthetic", origin: null, protocol_version: "2025-03-26",
    credential_reference_id: null, connect_timeout_ms: 500, request_timeout_ms: 1000,
    maximum_response_bytes: 8192, status: "reviewed",
  });
  for (const schema of [
    { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: { x: { $ref: "https://example.com/schema" } }, additionalProperties: false },
  ]) {
    assert.throws(() => validateReviewedMcpBinding({
      mcp_tool_binding_id: "binding-1", capability_version_id: "cv", capability_id: "cap",
      capability_version: "1.0.0", public_tool_name: "tool.name", downstream_tool_name: "tool_name",
      title: "Tool", description: "Description", input_schema_json: schema,
      output_contract_ref: "gateway-tool-result@0.9.0", status: "reviewed",
    }, {
      capability_version_id: "cv", capability_id: "cap", version: "1.0.0", kind: "mcp",
      risk_class: "read", approval_requirement: "none", status: "reviewed",
    }, server), /catalog is not permitted/u);
  }
});

test("reviewed synthetic bootstrap fixture stays valid and disabled from customer data", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../infra/policy-mcp/synthetic-bindings.json", import.meta.url), "utf8"));
  const server = validateReviewedServerVersion(fixture.server);
  const binding = validateReviewedMcpBinding(fixture.binding, fixture.capability, server);
  assert.equal(binding.publicToolName, "core_agent.synthetic_profile");
  assert.equal(binding.server.adapterKind, "synthetic");
  assert.equal(fixture.server.origin, null);
  assert.equal(fixture.server.credential_reference_id, null);
});
