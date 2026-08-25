import Type, { type Static } from "typebox";

export const CORE_AGENT_POLICY_PROOF_FIELD = "__core_agent_policy" as const;

export const GatewayToolDescriptorSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 255, pattern: "^[a-z][a-z0-9_.-]*$" }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.String({ minLength: 1, maxLength: 1000 }),
    inputSchema: Type.Object({}, { additionalProperties: true, maxProperties: 32 }),
    annotations: Type.Object(
      {
        readOnlyHint: Type.Literal(true),
        destructiveHint: Type.Literal(false),
        idempotentHint: Type.Literal(true),
        openWorldHint: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "core-agent://v1/gateway-tool-descriptor" },
);

export const McpToolCallArgumentsSchema = Type.Object(
  {
    [CORE_AGENT_POLICY_PROOF_FIELD]: Type.String({ minLength: 24, maxLength: 512 }),
  },
  { additionalProperties: true, maxProperties: 129, $id: "core-agent://v1/mcp-tool-call-arguments" },
);

const GatewayTextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String({ maxLength: 64_000 }),
  },
  { additionalProperties: false },
);

export const GatewayToolResultSchema = Type.Object(
  {
    content: Type.Array(GatewayTextContentSchema, { minItems: 1, maxItems: 16 }),
    isError: Type.Boolean(),
  },
  { additionalProperties: false, $id: "core-agent://v1/gateway-tool-result" },
);

export type GatewayToolDescriptor = Static<typeof GatewayToolDescriptorSchema>;
export type McpToolCallArguments = Static<typeof McpToolCallArgumentsSchema>;
export type GatewayToolResult = Static<typeof GatewayToolResultSchema>;
