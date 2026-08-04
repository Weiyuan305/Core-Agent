create table worker_jobs (
  tenant_id text not null,
  job_id text not null,
  job_kind text not null check (job_kind in ('provision_runtime', 'reconcile_runtime', 'execute_agent_run', 'dispatch_outbox')),
  status text not null check (status in ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer not null check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts between 1 and 20),
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null,
  payload_ref text not null check (char_length(payload_ref) between 1 and 500),
  effect_state text not null check (effect_state in ('pre_effect', 'unsafe_to_replay')),
  last_error_summary text check (last_error_summary is null or char_length(last_error_summary) between 1 and 1000),
  run_id text,
  container_id text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, job_id),
  foreign key (tenant_id) references tenants (tenant_id),
  foreign key (tenant_id, run_id) references agent_runs (tenant_id, run_id),
  foreign key (tenant_id, container_id) references runtime_containers (tenant_id, container_id)
);

create index worker_jobs_eligible_idx on worker_jobs (status, next_attempt_at, created_at);

create table idempotency_records (
  tenant_id text not null,
  idempotency_key text not null,
  payload_hash text not null check (payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  operation text not null check (char_length(operation) between 1 and 200),
  status text not null check (status in ('in_progress', 'completed')),
  result_ref text,
  response_json jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, idempotency_key),
  foreign key (tenant_id) references tenants (tenant_id)
);

create table outbox (
  tenant_id text not null,
  outbox_id text not null,
  event_id text not null,
  delivery_target text not null check (delivery_target in ('internal_event_stream', 'webhook')),
  status text not null check (status in ('pending', 'delivered', 'failed')),
  attempt_count integer not null check (attempt_count >= 0),
  next_attempt_at timestamptz not null,
  delivered_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, outbox_id),
  unique (tenant_id, event_id, delivery_target),
  foreign key (tenant_id) references tenants (tenant_id)
);
