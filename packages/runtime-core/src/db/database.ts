import { Kysely, PostgresDialect, type ColumnType } from "kysely";
import type { Pool } from "pg";

type JsonValue = unknown;
type RuntimeBigIntInput = string | number | bigint;

/** PostgreSQL int8 values remain strings on reads so callers cannot lose precision. */
export type RuntimeBigInt = ColumnType<string, RuntimeBigIntInput, RuntimeBigIntInput>;
export type NullableRuntimeBigInt = ColumnType<
  string | null,
  RuntimeBigIntInput | null,
  RuntimeBigIntInput | null
>;

export interface RuntimeDatabase {
  core_agent_schema_migrations: { version: number; name: string; checksum: string; applied_at: Date };
  tenants: { tenant_id: string; schema_version: number; resource_version: RuntimeBigInt; tenant_mode: string; status: string; display_name: string; created_at: Date; updated_at: Date };
  actors: { tenant_id: string; actor_id: string; schema_version: number; resource_version: RuntimeBigInt; actor_kind: string; display_name: string | null; status: string; created_at: Date; updated_at: Date };
  memberships: { tenant_id: string; membership_id: string; actor_id: string; schema_version: number; resource_version: RuntimeBigInt; roles: string[]; seat_ref: string | null; status: string; created_at: Date; updated_at: Date };
  profiles: { tenant_id: string; profile_id: string; schema_version: number; resource_version: RuntimeBigInt; owner_actor_id: string; profile_kind: string; hermes_profile_ref: string; description: string; status: string; provider_config_id: string; model_id: string; created_at: Date; updated_at: Date };
  runtime_containers: { tenant_id: string; container_id: string; schema_version: number; resource_version: RuntimeBigInt; command_version: ColumnType<string, RuntimeBigIntInput | undefined, RuntimeBigIntInput>; runtime_kind: string; desired_state: string; observed_state: string; image_ref: string; runtime_platform: ColumnType<string | null, string | null | undefined, string | null>; generation: number; volume_ref: string; health_status: string; last_probed_at: Date | null; failure_summary: string | null; created_at: Date; updated_at: Date };
  conversations: { tenant_id: string; conversation_id: string; profile_id: string; created_by_actor_id: string; status: string; schema_version: number; resource_version: RuntimeBigInt; student_ref: JsonValue | null; case_ref: JsonValue | null; created_at: Date; updated_at: Date };
  sessions: { tenant_id: string; session_id: string; profile_id: string; actor_id: string; conversation_id: string; schema_version: number; resource_version: RuntimeBigInt; status: string; last_active_at: Date; expires_at: Date; hermes_session_ref: string | null; created_at: Date; updated_at: Date };
  agent_runs: { tenant_id: string; run_id: string; conversation_id: string; request_id: string; trace_id: string; client_request_id: string; idempotency_key: string; parent_run_id: string | null; schema_version: number; resource_version: RuntimeBigInt; status: string; started_at: Date | null; finished_at: Date | null; failure_summary: string | null; created_at: Date; updated_at: Date };
  messages: { tenant_id: string; message_id: string; conversation_id: string; run_id: string; schema_version: number; resource_version: RuntimeBigInt; role: string; status: string; content: string; created_at: Date; updated_at: Date };
  secret_references: { tenant_id: string; reference_id: string; purpose: string; version: RuntimeBigInt; status: string; created_at: Date; updated_at: Date };
  worker_jobs: { tenant_id: string; job_id: string; job_kind: string; status: string; attempt_count: number; max_attempts: number; lease_owner: string | null; lease_expires_at: Date | null; next_attempt_at: Date; payload_ref: string; runtime_command: string | null; target_command_version: ColumnType<string | null, RuntimeBigIntInput | null | undefined, RuntimeBigIntInput | null>; effect_state: string; last_error_summary: string | null; run_id: string | null; container_id: string | null; created_at: Date; updated_at: Date };
  idempotency_records: { tenant_id: string; idempotency_key: string; payload_hash: string; operation: string; status: string; result_ref: string | null; response_json: JsonValue | null; expires_at: Date; created_at: Date; updated_at: Date };
  outbox: { tenant_id: string; outbox_id: string; event_id: string; delivery_target: string; status: string; attempt_count: number; next_attempt_at: Date; lease_owner: ColumnType<string | null, string | null | undefined, string | null>; lease_expires_at: ColumnType<Date | null, Date | null | undefined, Date | null>; last_error_summary: ColumnType<string | null, string | null | undefined, string | null>; delivered_at: Date | null; created_at: Date; updated_at: Date };
  product_events: { tenant_id: string; event_id: string; stream_id: string; schema_version: number; sequence: RuntimeBigInt; event_type: string; occurred_at: Date; request_id: string; trace_id: string; correlation_id: string; causation_id: string; profile_id: string | null; conversation_id: string | null; run_id: string | null; task_id: string | null; approval_id: string | null; student_ref: JsonValue | null; case_ref: JsonValue | null; capability_id: string | null; payload: JsonValue };
  stream_sequences: { tenant_id: string; stream_id: string; last_sequence: RuntimeBigInt };
  audit_events: { tenant_id: string; audit_event_id: string; schema_version: number; occurred_at: Date; actor_id: string; membership_id: string; effective_role: string; action: string; resource_type: string; resource_id: string; decision: string; outcome: string; request_id: string; trace_id: string; reason_summary: string; delegation_id: string | null; delegation_reason: string | null; run_id: string | null; task_id: string | null; approval_id: string | null; policy_version: string | null; entitlement_snapshot_ref: JsonValue | null; consent_snapshot_ref: JsonValue | null; change_summary: string | null; resource_version: NullableRuntimeBigInt; event_json: JsonValue };
  stream_cursors: { tenant_id: string; consumer_id: string; stream_id: string; last_sequence: RuntimeBigInt; updated_at: Date };
}

export function createRuntimeDatabase(pool: Pool): Kysely<RuntimeDatabase> {
  return new Kysely<RuntimeDatabase>({ dialect: new PostgresDialect({ pool }) });
}
