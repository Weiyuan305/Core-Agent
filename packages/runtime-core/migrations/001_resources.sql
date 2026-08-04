create table core_agent_schema_migrations (
  version integer primary key check (version > 0),
  name text not null unique check (char_length(name) between 1 and 200),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null
);

create table tenants (
  tenant_id text primary key,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  tenant_mode text not null check (tenant_mode in ('b2b', 'b2c')),
  status text not null check (status in ('provisioning', 'active', 'suspended', 'closing', 'closed')),
  display_name text not null check (char_length(display_name) between 1 and 200),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, resource_version)
);

create table actors (
  tenant_id text not null,
  actor_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  actor_kind text not null check (actor_kind in ('human', 'service')),
  display_name text check (display_name is null or char_length(display_name) between 1 and 200),
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, actor_id),
  foreign key (tenant_id) references tenants (tenant_id)
);

create table memberships (
  tenant_id text not null,
  membership_id text not null,
  actor_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  roles text[] not null check (cardinality(roles) between 1 and 3 and roles <@ array['admin', 'consultant', 'student']::text[]),
  seat_ref text,
  status text not null check (status in ('invited', 'active', 'suspended', 'revoked')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, membership_id),
  unique (tenant_id, actor_id),
  foreign key (tenant_id, actor_id) references actors (tenant_id, actor_id)
);

create table profiles (
  tenant_id text not null,
  profile_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  owner_actor_id text not null,
  profile_kind text not null check (profile_kind in ('default', 'consultant')),
  hermes_profile_ref text not null check (hermes_profile_ref ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  description text not null check (char_length(description) between 1 and 2000),
  status text not null check (status in ('provisioning', 'active', 'suspended', 'archived')),
  provider_config_id text not null,
  model_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, profile_id),
  unique (tenant_id, hermes_profile_ref),
  foreign key (tenant_id, owner_actor_id) references actors (tenant_id, actor_id)
);

create table runtime_containers (
  tenant_id text not null,
  container_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  runtime_kind text not null check (runtime_kind = 'hermes'),
  desired_state text not null check (desired_state in ('running', 'stopped', 'deleted')),
  observed_state text not null check (observed_state in ('requested', 'provisioning', 'starting', 'ready', 'draining', 'upgrading', 'recovering', 'stopping', 'stopped', 'failed', 'deleting', 'deleted')),
  image_ref text not null check (image_ref ~ '^.+@sha256:[a-f0-9]{64}$'),
  generation integer not null check (generation > 0),
  volume_ref text not null,
  health_status text not null check (health_status in ('unknown', 'healthy', 'degraded', 'unhealthy')),
  last_probed_at timestamptz,
  failure_summary text check (failure_summary is null or char_length(failure_summary) <= 1000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, container_id),
  foreign key (tenant_id) references tenants (tenant_id)
);

create table conversations (
  tenant_id text not null,
  conversation_id text not null,
  profile_id text not null,
  created_by_actor_id text not null,
  status text not null check (status in ('active', 'archived', 'closed')),
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  student_ref jsonb,
  case_ref jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, conversation_id),
  foreign key (tenant_id, profile_id) references profiles (tenant_id, profile_id),
  foreign key (tenant_id, created_by_actor_id) references actors (tenant_id, actor_id)
);

create table sessions (
  tenant_id text not null,
  session_id text not null,
  profile_id text not null,
  actor_id text not null,
  conversation_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  status text not null check (status in ('active', 'idle', 'expired', 'closed')),
  last_active_at timestamptz not null,
  expires_at timestamptz not null,
  hermes_session_ref text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, session_id),
  unique (tenant_id, hermes_session_ref),
  foreign key (tenant_id, profile_id) references profiles (tenant_id, profile_id),
  foreign key (tenant_id, actor_id) references actors (tenant_id, actor_id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, conversation_id)
);

create table agent_runs (
  tenant_id text not null,
  run_id text not null,
  conversation_id text not null,
  request_id text not null,
  trace_id text not null,
  client_request_id text not null,
  idempotency_key text not null,
  parent_run_id text,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  status text not null check (status in ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  failure_summary text check (failure_summary is null or char_length(failure_summary) <= 1000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, run_id),
  unique (tenant_id, client_request_id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, conversation_id),
  foreign key (tenant_id, parent_run_id) references agent_runs (tenant_id, run_id)
);

create table messages (
  tenant_id text not null,
  message_id text not null,
  conversation_id text not null,
  run_id text not null,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  role text not null check (role in ('user', 'assistant')),
  status text not null check (status in ('pending', 'streaming', 'completed', 'failed')),
  content text not null check (char_length(content) between 1 and 64000),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, message_id),
  foreign key (tenant_id, conversation_id) references conversations (tenant_id, conversation_id),
  foreign key (tenant_id, run_id) references agent_runs (tenant_id, run_id)
);

create table secret_references (
  tenant_id text not null,
  reference_id text not null,
  purpose text not null check (purpose in ('provider_credential', 'bootstrap', 'integration')),
  version bigint not null check (version > 0),
  status text not null check (status in ('active', 'rotated', 'revoked')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, reference_id),
  foreign key (tenant_id) references tenants (tenant_id)
);
