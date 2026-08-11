do $$
begin
  if exists (
    select 1
    from actors
    group by actor_id
    having count(distinct actor_kind) > 1
      or count(distinct status) > 1
      or not (
        bool_and(display_name is null)
        or (bool_and(display_name is not null) and min(display_name) = max(display_name))
      )
  ) then
    raise exception 'contradictory legacy Actor facts prevent global identity migration';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from memberships
    where status in ('active', 'invited')
    group by actor_id
    having count(distinct tenant_id) > 1
  ) then
    raise exception 'legacy ordinary Membership authority conflict prevents global identity migration';
  end if;
end
$$;

create table actors_v2 (
  actor_id text primary key,
  schema_version integer not null check (schema_version = 1),
  resource_version bigint not null check (resource_version > 0),
  actor_kind text not null check (actor_kind in ('human', 'service')),
  display_name text check (display_name is null or char_length(display_name) between 1 and 200),
  status text not null check (status in ('active', 'disabled', 'deletion_pending', 'deleted')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

insert into actors_v2 (
  actor_id, schema_version, resource_version, actor_kind, display_name, status,
  created_at, updated_at
)
select
  actor_id,
  max(schema_version),
  max(resource_version),
  min(actor_kind),
  min(display_name),
  min(status),
  min(created_at),
  max(updated_at)
from actors
group by actor_id;

alter table memberships drop constraint memberships_tenant_id_actor_id_fkey;
alter table profiles drop constraint profiles_tenant_id_owner_actor_id_fkey;
alter table conversations drop constraint conversations_tenant_id_created_by_actor_id_fkey;
alter table sessions drop constraint sessions_tenant_id_actor_id_fkey;
alter table audit_events drop constraint audit_events_tenant_id_actor_id_fkey;

drop table actors;
alter table actors_v2 rename to actors;

alter table memberships
  add constraint memberships_actor_id_fkey foreign key (actor_id) references actors (actor_id);
alter table memberships
  add constraint memberships_tenant_id_fkey foreign key (tenant_id) references tenants (tenant_id);
alter table profiles
  add constraint profiles_owner_actor_id_fkey foreign key (owner_actor_id) references actors (actor_id);
alter table profiles
  add constraint profiles_tenant_id_fkey foreign key (tenant_id) references tenants (tenant_id);
alter table conversations
  add constraint conversations_created_by_actor_id_fkey foreign key (created_by_actor_id) references actors (actor_id);
alter table sessions
  add constraint sessions_actor_id_fkey foreign key (actor_id) references actors (actor_id);
alter table audit_events
  add constraint audit_events_actor_id_fkey foreign key (actor_id) references actors (actor_id);

alter table memberships
  add column membership_source text not null default 'company';

update memberships as membership
set membership_source = 'self'
from tenants as tenant
where tenant.tenant_id = membership.tenant_id
  and tenant.tenant_mode = 'b2c'
  and membership.roles = array['student']::text[];

alter table memberships alter column membership_source drop default;
alter table memberships
  add constraint memberships_source_check
  check (membership_source in ('self', 'company', 'platform'));
alter table memberships
  add constraint memberships_source_roles_check
  check (
    (
      membership_source = 'platform'
      and roles = array['admin']::text[]
      and seat_ref is null
    )
    or (
      membership_source = 'self'
      and roles = array['student']::text[]
    )
    or (
      membership_source = 'company'
      and (
        roles = array['admin']::text[]
        or roles = array['consultant']::text[]
        or (status <> 'invited' and roles = array['admin', 'consultant']::text[])
      )
    )
  );

create index memberships_ordinary_actor_authority_idx
  on memberships (actor_id, tenant_id, membership_id)
  where membership_source <> 'platform'
    and status in ('active', 'invited');

create function enforce_ordinary_membership_actor_authority()
returns trigger
language plpgsql
as $$
begin
  perform 1
  from actors
  where actor_id = new.actor_id
  for no key update;

  if exists (
    select 1
    from memberships as conflicting
    where conflicting.actor_id = new.actor_id
      and conflicting.membership_source <> 'platform'
      and conflicting.status in ('active', 'invited')
      and (conflicting.tenant_id, conflicting.membership_id)
        <> (new.tenant_id, new.membership_id)
  ) then
    raise exception 'ordinary Membership authority conflict for Actor %', new.actor_id
      using errcode = '23514',
        constraint = 'memberships_ordinary_actor_authority_check';
  end if;

  return null;
end
$$;

create constraint trigger memberships_ordinary_actor_authority_check
after insert or update of actor_id, membership_source, status on memberships
deferrable initially deferred
for each row
when (
  new.membership_source <> 'platform'
  and new.status in ('active', 'invited')
)
execute function enforce_ordinary_membership_actor_authority();

create table auth_subjects (
  auth_subject_id text primary key,
  actor_id text not null references actors(actor_id),
  provider text not null check (provider in ('supabase')),
  provider_subject text not null,
  provider_identity_kind text not null check (provider_identity_kind in ('email_password', 'apple')),
  verified_at timestamptz not null,
  status text not null check (status in ('active', 'unlinked', 'revoked')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_subject)
);

create table private_identity_pii (
  actor_id text primary key references actors(actor_id),
  normalized_email_hmac bytea not null unique check (octet_length(normalized_email_hmac) = 32),
  encrypted_email bytea not null check (octet_length(encrypted_email) > 0),
  encryption_key_ref text not null check (char_length(encryption_key_ref) between 1 and 255),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table platform_role_assignments (
  platform_role_assignment_id text primary key,
  actor_id text not null references actors(actor_id),
  role text not null check (role in ('platform_super_admin')),
  status text not null check (status in ('active', 'revoked')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (actor_id, role)
);

create table identity_invitations (
  invitation_id text primary key,
  tenant_id text not null references tenants(tenant_id),
  membership_id text not null,
  invited_by_actor_id text not null references actors(actor_id),
  role text not null check (role in ('admin', 'consultant')),
  secret_digest bytea not null unique check (octet_length(secret_digest) = 32),
  normalized_email_hmac bytea not null check (octet_length(normalized_email_hmac) = 32),
  status text not null check (status in ('pending', 'accepted', 'revoked', 'expired', 'replaced')),
  expires_at timestamptz not null,
  accepted_actor_id text references actors(actor_id),
  accepted_at timestamptz,
  replaced_by_invitation_id text references identity_invitations(invitation_id),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (
    (status = 'accepted' and accepted_actor_id is not null and accepted_at is not null)
    or (status <> 'accepted' and accepted_actor_id is null and accepted_at is null)
  )
);

create unique index identity_invitations_pending_email_idx
  on identity_invitations (tenant_id, normalized_email_hmac)
  where status = 'pending';

create table oauth_transactions (
  oauth_transaction_id text primary key,
  provider text not null check (provider in ('supabase')),
  flow_kind text not null check (flow_kind in ('apple_sign_in', 'apple_link')),
  actor_id text references actors(actor_id),
  client_kind text not null check (client_kind in ('web', 'iphone', 'macos')),
  state_digest bytea not null unique check (octet_length(state_digest) = 32),
  nonce_digest bytea not null check (octet_length(nonce_digest) = 32),
  pkce_verifier_ciphertext bytea not null check (octet_length(pkce_verifier_ciphertext) > 0),
  redirect_uri text not null check (char_length(redirect_uri) between 1 and 2048),
  status text not null check (status in ('pending', 'consumed', 'expired')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check ((status = 'consumed') = (consumed_at is not null))
);

create table core_sessions (
  session_id text primary key,
  secret_digest bytea not null unique check (octet_length(secret_digest) = 32),
  csrf_digest bytea check (csrf_digest is null or octet_length(csrf_digest) = 32),
  actor_id text not null references actors(actor_id),
  auth_subject_id text not null references auth_subjects(auth_subject_id),
  client_kind text not null check (client_kind in ('web', 'iphone', 'macos')),
  status text not null check (status in ('active', 'revoked', 'expired')),
  device_label text check (device_label is null or char_length(device_label) between 1 and 80),
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  reauthenticated_at timestamptz,
  revocation_reason text,
  resource_version bigint not null check (resource_version > 0),
  updated_at timestamptz not null,
  check (idle_expires_at <= absolute_expires_at)
);

create table account_deletions (
  account_deletion_id text primary key,
  actor_id text not null references actors(actor_id),
  status text not null check (status in ('deletion_pending', 'cancelled', 'deleted')),
  requested_at timestamptz not null,
  scheduled_for timestamptz not null,
  cancelled_at timestamptz,
  deleted_at timestamptz,
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (
    (status = 'deletion_pending' and cancelled_at is null and deleted_at is null)
    or (status = 'cancelled' and cancelled_at is not null and deleted_at is null)
    or (status = 'deleted' and cancelled_at is null and deleted_at is not null)
  )
);

create unique index account_deletions_pending_actor_idx
  on account_deletions (actor_id)
  where status = 'deletion_pending';

create table public_rate_limits (
  bucket_kind text not null check (bucket_kind in ('signup', 'login', 'reset', 'apple_callback', 'invitation_accept', 'reauthenticate')),
  account_identifier_hmac bytea not null check (octet_length(account_identifier_hmac) = 32),
  client_identifier_hmac bytea not null check (octet_length(client_identifier_hmac) = 32),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (bucket_kind, account_identifier_hmac, client_identifier_hmac, window_started_at),
  check (window_started_at < expires_at)
);

create index auth_subjects_actor_id_idx on auth_subjects (actor_id);
create index core_sessions_actor_status_idx on core_sessions (actor_id, status);
create index identity_invitations_tenant_status_idx on identity_invitations (tenant_id, status, expires_at);
create index account_deletions_due_idx on account_deletions (status, scheduled_for);
create index public_rate_limits_expiry_idx on public_rate_limits (expires_at);

revoke all on table auth_subjects from public;
revoke all on table private_identity_pii from public;
revoke all on table platform_role_assignments from public;
revoke all on table identity_invitations from public;
revoke all on table oauth_transactions from public;
revoke all on table core_sessions from public;
revoke all on table account_deletions from public;
revoke all on table public_rate_limits from public;

alter table worker_jobs drop constraint worker_jobs_job_kind_check;
alter table worker_jobs
  add constraint worker_jobs_job_kind_check
  check (job_kind in (
    'provision_runtime',
    'reconcile_runtime',
    'execute_agent_run',
    'dispatch_outbox',
    'project_platform_memberships',
    'finalize_account_deletion'
  ));
