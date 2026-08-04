create table product_events (
  tenant_id text not null,
  event_id text not null,
  stream_id text not null,
  schema_version integer not null check (schema_version = 1),
  sequence bigint not null check (sequence > 0),
  event_type text not null,
  occurred_at timestamptz not null,
  request_id text not null,
  trace_id text not null,
  correlation_id text not null,
  causation_id text not null,
  profile_id text,
  conversation_id text,
  run_id text,
  task_id text,
  approval_id text,
  student_ref jsonb,
  case_ref jsonb,
  capability_id text,
  payload jsonb not null,
  primary key (tenant_id, event_id),
  unique (tenant_id, stream_id, sequence),
  foreign key (tenant_id) references tenants (tenant_id),
  foreign key (tenant_id, profile_id) references profiles (tenant_id, profile_id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, conversation_id),
  foreign key (tenant_id, run_id) references agent_runs (tenant_id, run_id)
);

create table stream_sequences (
  tenant_id text not null,
  stream_id text not null,
  last_sequence bigint not null check (last_sequence >= 0),
  primary key (tenant_id, stream_id),
  foreign key (tenant_id) references tenants (tenant_id)
);

create table audit_events (
  tenant_id text not null,
  audit_event_id text not null,
  schema_version integer not null check (schema_version = 1),
  occurred_at timestamptz not null,
  actor_id text not null,
  membership_id text not null,
  effective_role text not null check (effective_role in ('admin', 'consultant', 'student')),
  action text not null,
  resource_type text not null,
  resource_id text not null,
  decision text not null check (decision in ('allowed', 'denied', 'not_applicable')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'cancelled', 'pending')),
  request_id text not null,
  trace_id text not null,
  reason_summary text not null check (char_length(reason_summary) <= 2000),
  delegation_id text,
  delegation_reason text check (delegation_reason is null or char_length(delegation_reason) <= 2000),
  run_id text,
  task_id text,
  approval_id text,
  policy_version text,
  entitlement_snapshot_ref jsonb,
  consent_snapshot_ref jsonb,
  change_summary text check (change_summary is null or char_length(change_summary) <= 2000),
  resource_version bigint check (resource_version is null or resource_version > 0),
  event_json jsonb not null,
  primary key (tenant_id, audit_event_id),
  foreign key (tenant_id) references tenants (tenant_id),
  foreign key (tenant_id, actor_id) references actors (tenant_id, actor_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, membership_id),
  foreign key (tenant_id, run_id) references agent_runs (tenant_id, run_id)
);

create table stream_cursors (
  tenant_id text not null,
  consumer_id text not null,
  stream_id text not null,
  last_sequence bigint not null check (last_sequence >= 0),
  updated_at timestamptz not null,
  primary key (tenant_id, consumer_id, stream_id),
  foreign key (tenant_id, stream_id) references stream_sequences (tenant_id, stream_id)
);

alter table outbox
  add foreign key (tenant_id, event_id) references product_events (tenant_id, event_id);
