import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  GatewayToolDescriptorSchema,
  GatewayToolResultSchema,
  McpToolCallArgumentsSchema,
} from "../src/index.js";

test("gateway tool descriptors expose a closed reviewed schema without routing data", () => {
  const descriptor = {
    name: "core_agent.synthetic_profile",
    title: "Synthetic profile",
    description: "Returns deterministic synthetic platform information.",
    inputSchema: {
      type: "object",
      properties: { subject: { type: "string", minLength: 1, maxLength: 32 } },
      required: ["subject"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  assert.equal(Schema.Check(GatewayToolDescriptorSchema, descriptor), true);
  assert.equal(Schema.Check(GatewayToolDescriptorSchema, { ...descriptor, endpoint: "https://private" }), false);
  assert.equal(Schema.Check(GatewayToolDescriptorSchema, { ...descriptor, annotations: { ...descriptor.annotations, destructiveHint: true } }), false);
});

test("tool call arguments reserve the gateway proof and results remain bounded", () => {
  assert.equal(Schema.Check(McpToolCallArgumentsSchema, {
    subject: "platform",
    __core_agent_policy: "opaque-proof-value-with-sufficient-length",
  }), true);
  assert.equal(Schema.Check(McpToolCallArgumentsSchema, { subject: "platform" }), false);
  assert.equal(Schema.Check(GatewayToolResultSchema, {
    content: [{ type: "text", text: "Synthetic result" }],
    isError: false,
  }), true);
  assert.equal(Schema.Check(GatewayToolResultSchema, {
    content: [{ type: "image", data: "secret" }],
    isError: false,
  }), false);
});
