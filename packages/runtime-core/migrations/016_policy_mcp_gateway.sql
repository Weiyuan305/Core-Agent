create table policy_versions (
  policy_version_id text primary key,
  policy_id text not null,
  version text not null check (core_agent_is_canonical_semver(version)),
  rule_hash text not null check (rule_hash ~ '^sha256:[a-f0-9]{64}$'),
  status text not null check (status in ('reviewed', 'blocked')),
  reviewed_by_actor_id text not null references actors(actor_id),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint policy_versions_identity_key unique (policy_id, version)
);

create table mcp_server_versions (
  mcp_server_version_id text primary key,
  mcp_server_id text not null,
  version text not null check (core_agent_is_canonical_semver(version)),
  adapter_kind text not null check (adapter_kind in ('synthetic', 'remote_https')),
  origin text,
  protocol_version text not null check (char_length(protocol_version) between 1 and 32),
  credential_reference_id text,
  connect_timeout_ms integer not null check (connect_timeout_ms between 100 and 30000),
  request_timeout_ms integer not null check (request_timeout_ms between 100 and 30000),
  maximum_response_bytes integer not null check (maximum_response_bytes between 1 and 262144),
  status text not null check (status in ('reviewed', 'retired', 'blocked')),
  reviewed_by_actor_id text not null references actors(actor_id),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint mcp_server_versions_identity_key unique (mcp_server_id, version),
  constraint mcp_server_versions_adapter_check check (
    (adapter_kind = 'synthetic' and origin is null and credential_reference_id is null)
    or (adapter_kind = 'remote_https' and origin ~ '^https://[a-z0-9][a-z0-9.-]{0,252}(:[1-9][0-9]{0,4})?$'
      and credential_reference_id is not null)
  )
);

create table mcp_tool_bindings (
  mcp_tool_binding_id text primary key,
  capability_version_id text not null,
  capability_id text not null,
  capability_version text not null,
  mcp_server_version_id text not null references mcp_server_versions(mcp_server_version_id),
  public_tool_name text not null check (public_tool_name ~ '^[a-z][a-z0-9_.-]{0,254}$'),
  downstream_tool_name text not null check (downstream_tool_name ~ '^[a-z][a-z0-9_.-]{0,254}$'),
  title text not null check (char_length(title) between 1 and 200),
  description text not null check (char_length(description) between 1 and 1000),
  input_schema_json jsonb not null,
  input_schema_hash text not null check (input_schema_hash ~ '^sha256:[a-f0-9]{64}$'),
  output_contract_ref text not null check (core_agent_is_exact_contract_ref(output_contract_ref)),
  status text not null check (status in ('reviewed', 'retired', 'blocked')),
  reviewed_by_actor_id text not null references actors(actor_id),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint mcp_tool_bindings_capability_version_fkey
    foreign key (capability_version_id, capability_id, capability_version)
    references capability_versions(capability_version_id, capability_id, version),
  constraint mcp_tool_bindings_capability_key unique (capability_version_id),
  constraint mcp_tool_bindings_public_name_key unique (public_tool_name)
);

create table policy_sessions (
  tenant_id text not null,
  policy_session_id text not null,
  actor_id text not null,
  membership_id text not null,
  profile_id text not null,
  session_id text not null,
  conversation_id text not null,
  run_id text not null,
  runtime_container_id text not null,
  runtime_generation integer not null check (runtime_generation > 0),
  hermes_session_ref text not null,
  snapshot_id text not null,
  snapshot_version bigint not null check (snapshot_version > 0),
  snapshot_evaluated_at timestamptz not null,
  policy_version_id text not null references policy_versions(policy_version_id),
  state text not null constraint policy_sessions_state_value_check
    check (state in ('active', 'closed', 'expired')),
  close_reason text check (close_reason is null or close_reason in (
    'run_succeeded', 'run_failed', 'run_cancelled', 'run_expired', 'authority_changed'
  )),
  idempotency_key text not null,
  payload_hash text not null check (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  request_id text not null,
  trace_id text not null,
  correlation_id text not null,
  expires_at timestamptz not null,
  closed_at timestamptz,
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, policy_session_id),
  constraint policy_sessions_membership_fkey
    foreign key (tenant_id, membership_id, actor_id)
    references memberships(tenant_id, membership_id, actor_id),
  constraint policy_sessions_profile_fkey
    foreign key (tenant_id, profile_id) references profiles(tenant_id, profile_id),
  constraint policy_sessions_session_fkey
    foreign key (tenant_id, session_id) references sessions(tenant_id, session_id),
  constraint policy_sessions_conversation_fkey
    foreign key (tenant_id, conversation_id) references conversations(tenant_id, conversation_id),
  constraint policy_sessions_run_fkey
    foreign key (tenant_id, run_id) references agent_runs(tenant_id, run_id),
  constraint policy_sessions_runtime_fkey
    foreign key (tenant_id, runtime_container_id) references runtime_containers(tenant_id, container_id),
  constraint policy_sessions_snapshot_fkey
    foreign key (tenant_id, profile_id, snapshot_id, snapshot_version, snapshot_evaluated_at)
    references entitlement_snapshots(tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at),
  constraint policy_sessions_idempotency_key unique (tenant_id, idempotency_key),
  constraint policy_sessions_run_key unique (tenant_id, run_id),
  constraint policy_sessions_state_check check (
    (state = 'active' and close_reason is null and closed_at is null)
    or (state in ('closed', 'expired') and close_reason is not null and closed_at is not null)
  )
);

create unique index policy_sessions_active_runtime_session_key
  on policy_sessions (tenant_id, runtime_container_id, hermes_session_ref)
  where state = 'active';
create index policy_sessions_expiry_idx
  on policy_sessions (expires_at, tenant_id, policy_session_id)
  where state = 'active';

create table policy_decisions (
  tenant_id text not null,
  decision_id text not null,
  policy_session_id text not null,
  tool_call_id text not null,
  public_tool_name text not null,
  capability_version_id text,
  mcp_tool_binding_id text,
  arguments_hash text not null check (arguments_hash ~ '^sha256:[a-f0-9]{64}$'),
  decision text not null check (decision in ('allow', 'deny')),
  reason_code text not null check (reason_code in (
    'POLICY_ALLOWED', 'SESSION_NOT_ACTIVE', 'CURRENT_AUTHORITY_CHANGED',
    'CAPABILITY_NOT_EFFECTIVE', 'POLICY_NOT_PERMITTED', 'TOOL_NOT_BOUND',
    'ARGUMENTS_INVALID', 'PROOF_INVALID', 'PROOF_EXPIRED', 'PROOF_REPLAYED',
    'DOWNSTREAM_UNAVAILABLE', 'DOWNSTREAM_CONTRACT_INVALID'
  )),
  policy_version_id text not null references policy_versions(policy_version_id),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, decision_id),
  constraint policy_decisions_session_fkey
    foreign key (tenant_id, policy_session_id)
    references policy_sessions(tenant_id, policy_session_id),
  constraint policy_decisions_capability_fkey
    foreign key (capability_version_id) references capability_versions(capability_version_id),
  constraint policy_decisions_binding_fkey
    foreign key (mcp_tool_binding_id) references mcp_tool_bindings(mcp_tool_binding_id),
  constraint policy_decisions_tool_call_key unique (tenant_id, policy_session_id, tool_call_id),
  constraint policy_decisions_truth_check check (
    (decision = 'allow' and reason_code = 'POLICY_ALLOWED'
      and capability_version_id is not null and mcp_tool_binding_id is not null)
    or (decision = 'deny' and reason_code <> 'POLICY_ALLOWED')
  )
);

create table policy_execution_proofs (
  tenant_id text not null,
  proof_id text not null,
  decision_id text not null,
  policy_session_id text not null,
  proof_digest bytea not null unique,
  arguments_hash text not null check (arguments_hash ~ '^sha256:[a-f0-9]{64}$'),
  state text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, proof_id),
  constraint policy_execution_proofs_decision_fkey
    foreign key (tenant_id, decision_id) references policy_decisions(tenant_id, decision_id),
  constraint policy_execution_proofs_session_fkey
    foreign key (tenant_id, policy_session_id)
    references policy_sessions(tenant_id, policy_session_id),
  constraint policy_execution_proofs_decision_key unique (tenant_id, decision_id),
  constraint policy_execution_proofs_state_check check (
    (state = 'issued' and consumed_at is null and invalidated_at is null)
    or (state = 'consumed' and consumed_at is not null and invalidated_at is null)
    or (state in ('invalidated', 'expired') and consumed_at is null and invalidated_at is not null)
  )
);

create index policy_execution_proofs_expiry_idx
  on policy_execution_proofs (expires_at, tenant_id, proof_id)
  where state = 'issued';

create table mcp_tool_calls (
  tenant_id text not null,
  mcp_tool_call_id text not null,
  policy_session_id text not null,
  decision_id text not null,
  proof_id text not null,
  mcp_tool_binding_id text not null references mcp_tool_bindings(mcp_tool_binding_id),
  tool_call_id text not null,
  public_tool_name text not null,
  arguments_hash text not null check (arguments_hash ~ '^sha256:[a-f0-9]{64}$'),
  status text not null check (status in ('requested', 'started', 'succeeded', 'failed')),
  reason_code text,
  safe_result_summary text check (safe_result_summary is null or char_length(safe_result_summary) <= 500),
  requested_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  resource_version bigint not null check (resource_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, mcp_tool_call_id),
  constraint mcp_tool_calls_session_fkey
    foreign key (tenant_id, policy_session_id)
    references policy_sessions(tenant_id, policy_session_id),
  constraint mcp_tool_calls_decision_fkey
    foreign key (tenant_id, decision_id) references policy_decisions(tenant_id, decision_id),
  constraint mcp_tool_calls_proof_fkey
    foreign key (tenant_id, proof_id) references policy_execution_proofs(tenant_id, proof_id),
  constraint mcp_tool_calls_tool_call_key unique (tenant_id, policy_session_id, tool_call_id)
);

create function core_agent_enforce_policy_catalog_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Reviewed Policy and MCP catalog rows are immutable'
    using errcode = '23514', constraint = tg_table_name || '_immutable';
end
$$;

create trigger policy_versions_immutable
before update or delete on policy_versions
for each row execute function core_agent_enforce_policy_catalog_immutable();
create trigger mcp_server_versions_immutable
before update or delete on mcp_server_versions
for each row execute function core_agent_enforce_policy_catalog_immutable();
create trigger mcp_tool_bindings_immutable
before update or delete on mcp_tool_bindings
for each row execute function core_agent_enforce_policy_catalog_immutable();

alter function core_agent_enforce_policy_catalog_immutable() set search_path = pg_catalog, public;
revoke all on function core_agent_enforce_policy_catalog_immutable()
  from public, core_agent_app, core_agent_identity;

revoke all on table
  policy_versions, mcp_server_versions, mcp_tool_bindings, policy_sessions,
  policy_decisions, policy_execution_proofs, mcp_tool_calls
from public, core_agent_app, core_agent_identity;

grant select on table
  policy_versions, mcp_server_versions, mcp_tool_bindings
to core_agent_app, core_agent_identity;
grant select, insert on table
  policy_sessions, policy_decisions, policy_execution_proofs, mcp_tool_calls
to core_agent_app;
grant update on table
  policy_sessions, policy_execution_proofs, mcp_tool_calls
to core_agent_app;
