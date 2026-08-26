import Type, { type Static } from "typebox";

import { OpaqueIdSchema, SchemaVersionSchema, UtcTimestampSchema } from "../common/primitives.js";

export const PolicyDecisionReasonSchema = Type.Union([
  Type.Literal("POLICY_ALLOWED"),
  Type.Literal("SESSION_NOT_ACTIVE"),
  Type.Literal("CURRENT_AUTHORITY_CHANGED"),
  Type.Literal("CAPABILITY_NOT_EFFECTIVE"),
  Type.Literal("POLICY_NOT_PERMITTED"),
  Type.Literal("TOOL_NOT_BOUND"),
  Type.Literal("ARGUMENTS_INVALID"),
  Type.Literal("PROOF_INVALID"),
  Type.Literal("PROOF_EXPIRED"),
  Type.Literal("PROOF_REPLAYED"),
  Type.Literal("DOWNSTREAM_UNAVAILABLE"),
  Type.Literal("DOWNSTREAM_CONTRACT_INVALID"),
], { $id: "core-agent://v1/policy-decision-reason" });

export const ToolPolicyDecisionRequestSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    hermes_session_ref: OpaqueIdSchema,
    tool_call_id: OpaqueIdSchema,
    tool_name: OpaqueIdSchema,
    arguments: Type.Record(Type.String({ minLength: 1, maxLength: 255 }), Type.Unknown(), {
      maxProperties: 128,
    }),
  },
  { additionalProperties: false, $id: "core-agent://v1/tool-policy-decision-request" },
);

const DecisionBase = {
  schema_version: SchemaVersionSchema,
  decision_id: OpaqueIdSchema,
};

export const ToolPolicyDecisionResponseSchema = Type.Union(
  [
    Type.Object(
      {
        ...DecisionBase,
        decision: Type.Literal("allow"),
        reason: Type.Literal("POLICY_ALLOWED"),
        execution_proof: Type.String({ minLength: 24, maxLength: 512 }),
        expires_at: UtcTimestampSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        ...DecisionBase,
        decision: Type.Literal("deny"),
        reason: Type.Exclude(PolicyDecisionReasonSchema, [Type.Literal("POLICY_ALLOWED")]),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "core-agent://v1/tool-policy-decision-response" },
);

export type ToolPolicyDecisionRequest = Static<typeof ToolPolicyDecisionRequestSchema>;
export type ToolPolicyDecisionResponse = Static<typeof ToolPolicyDecisionResponseSchema>;
export type PolicyDecisionReason = Static<typeof PolicyDecisionReasonSchema>;
