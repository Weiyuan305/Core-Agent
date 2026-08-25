import type { ColumnType } from "kysely";

type BigIntInput = string | number | bigint;
type PolicyBigInt = ColumnType<string, BigIntInput, BigIntInput>;
type DefaultTimestamp = ColumnType<Date, Date | undefined, Date>;

export interface PolicyVersionTable {
  policy_version_id: string;
  policy_id: string;
  version: string;
  rule_hash: string;
  status: "reviewed" | "blocked";
  reviewed_by_actor_id: string;
  resource_version: PolicyBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface McpServerVersionTable {
  mcp_server_version_id: string;
  mcp_server_id: string;
  version: string;
  adapter_kind: "synthetic" | "remote_https";
  origin: string | null;
  protocol_version: string;
  credential_reference_id: string | null;
  connect_timeout_ms: number;
  request_timeout_ms: number;
  maximum_response_bytes: number;
  status: "reviewed" | "retired" | "blocked";
  reviewed_by_actor_id: string;
  resource_version: PolicyBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface McpToolBindingTable {
  mcp_tool_binding_id: string;
  capability_version_id: string;
  capability_id: string;
  capability_version: string;
  mcp_server_version_id: string;
  public_tool_name: string;
  downstream_tool_name: string;
  title: string;
  description: string;
  input_schema_json: unknown;
  input_schema_hash: string;
  output_contract_ref: string;
  status: "reviewed" | "retired" | "blocked";
  reviewed_by_actor_id: string;
  resource_version: PolicyBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PolicySessionTable {
  tenant_id: string;
  policy_session_id: string;
  actor_id: string;
  membership_id: string;
  effective_role: "admin" | "consultant" | "student";
  profile_id: string;
  session_id: string;
  core_session_id: string;
  conversation_id: string;
  run_id: string;
  runtime_container_id: string;
  runtime_generation: number;
  hermes_session_ref: string;
  snapshot_id: string;
  snapshot_version: PolicyBigInt;
  snapshot_evaluated_at: Date;
  policy_version_id: string;
  state: "active" | "closed" | "expired";
  close_reason: "run_succeeded" | "run_failed" | "run_cancelled" | "run_expired" | "authority_changed" | null;
  idempotency_key: string;
  payload_hash: string;
  request_id: string;
  trace_id: string;
  correlation_id: string;
  expires_at: Date;
  closed_at: Date | null;
  resource_version: PolicyBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface PolicyDecisionTable {
  tenant_id: string;
  decision_id: string;
  policy_session_id: string;
  tool_call_id: string;
  public_tool_name: string;
  capability_version_id: string | null;
  mcp_tool_binding_id: string | null;
  arguments_hash: string;
  decision: "allow" | "deny";
  reason_code: string;
  policy_version_id: string;
  resource_version: PolicyBigInt;
  created_at: DefaultTimestamp;
}

export interface PolicyExecutionProofTable {
  tenant_id: string;
  proof_id: string;
  decision_id: string;
  policy_session_id: string;
  proof_digest: Uint8Array;
  arguments_hash: string;
  state: "issued" | "consumed" | "invalidated" | "expired";
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  resource_version: PolicyBigInt;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface McpToolCallTable {
  tenant_id: string;
  mcp_tool_call_id: string;
  policy_session_id: string;
  decision_id: string;
  proof_id: string;
  mcp_tool_binding_id: string;
  tool_call_id: string;
  public_tool_name: string;
  arguments_hash: string;
  status: "requested" | "started" | "succeeded" | "failed";
  reason_code: string | null;
  safe_result_summary: string | null;
  requested_at: DefaultTimestamp;
  started_at: Date | null;
  finished_at: Date | null;
  resource_version: PolicyBigInt;
  updated_at: DefaultTimestamp;
}

export interface PolicyMcpAuthorityTables {
  policy_versions: PolicyVersionTable;
  mcp_server_versions: McpServerVersionTable;
  mcp_tool_bindings: McpToolBindingTable;
  policy_sessions: PolicySessionTable;
  policy_decisions: PolicyDecisionTable;
  policy_execution_proofs: PolicyExecutionProofTable;
  mcp_tool_calls: McpToolCallTable;
}
