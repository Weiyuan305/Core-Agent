import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { SignedTrustedRequestContextSchema } from "../request-context/trusted-request-context.js";

export const POLICY_PROTOCOL_VERSION = 1 as const;
export const BUILTIN_READ_MCP_POLICY_VERSION = "core-agent-read-mcp-v1" as const;

export const PolicySessionStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("closed"),
  Type.Literal("expired"),
], { $id: "core-agent://v1/policy-session-state" });

export const PolicySessionCloseReasonSchema = Type.Union([
  Type.Literal("run_succeeded"),
  Type.Literal("run_failed"),
  Type.Literal("run_cancelled"),
  Type.Literal("run_expired"),
  Type.Literal("authority_changed"),
]);

export const OpenPolicySessionRequestSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    signed_context: SignedTrustedRequestContextSchema,
    runtime_container_id: OpaqueIdSchema,
    runtime_generation: Type.Integer({ minimum: 1 }),
    hermes_session_ref: OpaqueIdSchema,
    idempotency_key: OpaqueIdSchema,
    correlation_id: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/open-policy-session-request" },
);

export const OpenPolicySessionResponseSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    policy_session_id: OpaqueIdSchema,
    state: Type.Literal("active"),
    policy_version: Type.Literal(BUILTIN_READ_MCP_POLICY_VERSION),
    expires_at: UtcTimestampSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/open-policy-session-response" },
);

export const ClosePolicySessionRequestSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    policy_session_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    reason: PolicySessionCloseReasonSchema,
    idempotency_key: OpaqueIdSchema,
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
  },
  { additionalProperties: false, $id: "core-agent://v1/close-policy-session-request" },
);

export const ClosePolicySessionResponseSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    policy_session_id: OpaqueIdSchema,
    state: Type.Literal("closed"),
  },
  { additionalProperties: false, $id: "core-agent://v1/close-policy-session-response" },
);

export type OpenPolicySessionRequest = Static<typeof OpenPolicySessionRequestSchema>;
export type OpenPolicySessionResponse = Static<typeof OpenPolicySessionResponseSchema>;
export type ClosePolicySessionRequest = Static<typeof ClosePolicySessionRequestSchema>;
export type ClosePolicySessionResponse = Static<typeof ClosePolicySessionResponseSchema>;
