create function core_agent_is_canonical_semver(candidate text)
returns boolean
language sql
immutable
strict
as $$
  select char_length(candidate) between 5 and 128
    and candidate ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$'
$$;

create function core_agent_is_exact_contract_ref(candidate text)
returns boolean
language sql
immutable
strict
as $$
  select char_length(candidate) between 7 and 256
    and candidate ~ '^[a-z0-9][a-z0-9._/-]{0,127}@'
    and char_length(candidate) - char_length(replace(candidate, '@', '')) = 1
    and core_agent_is_canonical_semver(substring(candidate from '@([^@]+)$'))
$$;

create function core_agent_is_immutable_artifact_ref(candidate text)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  artifact_body text;
  package_name text;
  package_version text;
  repository_ref text;
  repository_path text;
  registry_name text;
begin
  if candidate ~ '^manifest:sha256:[a-f0-9]{64}$' then
    return true;
  end if;

  if candidate like 'npm:%' then
    artifact_body := substring(candidate from 5);
    if artifact_body !~ '#sha512-[A-Za-z0-9+/]{85}[AQgw]==$' then return false; end if;
    artifact_body := regexp_replace(artifact_body, '#sha512-[A-Za-z0-9+/]{85}[AQgw]==$', '');
    package_version := substring(artifact_body from '@([^@]+)$');
    if package_version is null then return false; end if;
    package_name := left(artifact_body, char_length(artifact_body) - char_length(package_version) - 1);
    return char_length(package_name) between 1 and 214
      and core_agent_is_canonical_semver(package_version)
      and (
        package_name ~ '^[a-z0-9][a-z0-9._~-]*$'
        or package_name ~ '^@[a-z0-9][a-z0-9._~-]*/[a-z0-9][a-z0-9._~-]*$'
      );
  end if;

  if candidate not like 'oci:%@sha256:%'
    or candidate !~ '^oci:.*@sha256:[a-f0-9]{64}$' then
    return false;
  end if;
  repository_ref := regexp_replace(substring(candidate from 5), '@sha256:[a-f0-9]{64}$', '');
  if repository_ref is null or repository_ref = '' then return false; end if;
  registry_name := split_part(repository_ref, '/', 1);
  if repository_ref like '%/%'
    and (registry_name = 'localhost' or registry_name like '%.%' or registry_name like '%:%') then
    repository_path := substring(repository_ref from char_length(registry_name) + 2);
    if registry_name !~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.([a-z0-9]([a-z0-9-]*[a-z0-9])?))*(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$'
      and registry_name !~ '^localhost(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?$' then
      return false;
    end if;
  else
    repository_path := repository_ref;
    if registry_name = 'localhost' or registry_name like '%.%' or registry_name like '%:%' then return false; end if;
  end if;
  return char_length(repository_path) between 1 and 255
    and repository_path ~ '^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*$';
end
$$;

create function core_agent_is_valid_capability_compatibility(candidate jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
  key_count integer;
begin
  if jsonb_typeof(candidate) <> 'object' then return false; end if;
  select count(*)::integer into key_count from jsonb_object_keys(candidate);
  return key_count = 4
    and candidate ?& array[
      'core_contract_version', 'domain_contract_version', 'runtime_protocol_version', 'tenant_modes'
    ]
    and core_agent_is_canonical_semver(candidate ->> 'core_contract_version')
    and core_agent_is_canonical_semver(candidate ->> 'domain_contract_version')
    and core_agent_is_canonical_semver(candidate ->> 'runtime_protocol_version')
    and candidate -> 'tenant_modes' in (
      '["b2b"]'::jsonb, '["b2c"]'::jsonb, '["b2b","b2c"]'::jsonb, '["b2c","b2b"]'::jsonb
    );
end
$$;

create table capabilities (
  capability_id text primary key,
  display_name text not null check (char_length(display_name) between 1 and 200),
  owning_domain text not null,
  kind text not null check (kind in ('mcp', 'skill', 'policy')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint capabilities_kind_ref_key unique (capability_id, kind)
);

create table capability_versions (
  capability_version_id text primary key,
  capability_id text not null references capabilities(capability_id),
  version text not null,
  kind text not null check (kind in ('mcp', 'skill', 'policy')),
  artifact_ref text not null,
  contract_ref text not null,
  risk_class text not null check (risk_class in ('read', 'draft_write', 'external_write', 'privileged')),
  approval_requirement text not null check (approval_requirement in ('none', 'user_confirmation', 'human_approval')),
  compatibility_json jsonb not null,
  status text not null check (status in ('draft', 'reviewed', 'retired', 'blocked')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (capability_id, version),
  constraint capability_versions_exact_ref_key
    unique (capability_version_id, capability_id, version),
  constraint capability_versions_kind_matches_capability_check
    foreign key (capability_id, kind) references capabilities(capability_id, kind),
  constraint capability_versions_version_length_check
    check (char_length(version) between 5 and 128),
  constraint capability_versions_canonical_version_check
    check (core_agent_is_canonical_semver(version)),
  constraint capability_versions_immutable_artifact_ref_check
    check (core_agent_is_immutable_artifact_ref(artifact_ref)),
  constraint capability_versions_exact_contract_ref_check
    check (core_agent_is_exact_contract_ref(contract_ref)),
  constraint capability_versions_compatibility_object_check
    check (core_agent_is_valid_capability_compatibility(compatibility_json))
);

create table pack_products (
  pack_product_id text primary key,
  display_name text not null check (char_length(display_name) between 1 and 200),
  tenant_modes text[] not null,
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pack_products_tenant_modes_check check (
    tenant_modes in (
      array['b2b']::text[], array['b2c']::text[], array['b2b', 'b2c']::text[]
    )
  )
);

create table pack_versions (
  pack_version_id text primary key,
  pack_product_id text not null references pack_products(pack_product_id),
  version text not null check (char_length(version) between 5 and 128),
  status text not null check (status in ('draft', 'reviewed', 'published', 'retired', 'blocked')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pack_versions_canonical_version_check check (core_agent_is_canonical_semver(version)),
  constraint pack_versions_product_version_key unique (pack_product_id, version),
  constraint pack_versions_exact_ref_key unique (pack_version_id, pack_product_id, version)
);

create table pack_members (
  pack_member_id text primary key,
  pack_version_id text not null references pack_versions(pack_version_id),
  member_order integer not null check (member_order > 0),
  capability_id text not null,
  capability_version_id text not null,
  version text not null,
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint pack_members_capability_version_fkey
    foreign key (capability_version_id, capability_id, version)
    references capability_versions(capability_version_id, capability_id, version),
  constraint pack_members_order_key unique (pack_version_id, member_order),
  constraint pack_members_capability_key unique (pack_version_id, capability_id)
);

alter table memberships
  add constraint memberships_tenant_membership_actor_key
  unique (tenant_id, membership_id, actor_id);

create table platform_authority_audit (
  platform_authority_audit_id text primary key,
  authority_tenant_id text not null,
  actor_id text not null references actors(actor_id),
  membership_id text not null,
  action text not null check (char_length(action) between 1 and 200),
  decision text not null check (decision in ('allowed', 'denied', 'not_applicable')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'cancelled', 'pending')),
  resource_type text not null check (char_length(resource_type) between 1 and 100),
  resource_id text not null,
  resource_version bigint check (resource_version is null or resource_version > 0),
  request_id text not null,
  trace_id text not null,
  reason_summary text not null check (char_length(reason_summary) <= 2000),
  change_summary text check (change_summary is null or char_length(change_summary) <= 2000),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint platform_authority_audit_membership_actor_fkey
    foreign key (authority_tenant_id, membership_id, actor_id)
    references memberships(tenant_id, membership_id, actor_id)
);

create table tenant_pack_releases (
  tenant_pack_release_id text primary key,
  tenant_id text not null references tenants(tenant_id),
  pack_product_id text not null,
  pack_version_id text not null,
  pack_version text not null,
  generation bigint not null check (generation > 0),
  status text not null check (status in ('preparing', 'current', 'failed', 'superseded')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint tenant_pack_releases_pack_version_fkey
    foreign key (pack_version_id, pack_product_id, pack_version)
    references pack_versions(pack_version_id, pack_product_id, version),
  constraint tenant_pack_releases_generation_key
    unique (tenant_id, pack_product_id, generation),
  constraint tenant_pack_releases_tenant_ref_key
    unique (tenant_id, tenant_pack_release_id),
  constraint tenant_pack_releases_exact_ref_key
    unique (tenant_id, tenant_pack_release_id, pack_product_id, pack_version_id, pack_version)
);

create unique index tenant_pack_releases_current_key
  on tenant_pack_releases (tenant_id, pack_product_id)
  where status = 'current';
create index tenant_pack_releases_affected_idx
  on tenant_pack_releases (pack_version_id, status, tenant_id, pack_product_id);

create table entitlements (
  entitlement_id text primary key,
  tenant_id text not null references tenants(tenant_id),
  pack_product_id text not null,
  tenant_pack_release_id text not null,
  pack_version_id text not null,
  pack_version text not null,
  source text not null check (source = 'platform_manual'),
  external_order_ref text not null,
  tenant_mode text not null check (tenant_mode in ('b2b', 'b2c')),
  assignment_mode text not null constraint entitlements_assignment_mode_value_check
    check (assignment_mode in ('seat', 'automatic')),
  seat_quantity integer,
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  status text not null check (status in ('active', 'suspended', 'expired', 'revoked')),
  reason_code text not null check (reason_code in (
    'platform_grant', 'administrator_suspended', 'administrator_reactivated',
    'platform_revoked', 'validity_expired'
  )),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint entitlements_release_fkey
    foreign key (tenant_id, tenant_pack_release_id, pack_product_id, pack_version_id, pack_version)
    references tenant_pack_releases(tenant_id, tenant_pack_release_id, pack_product_id, pack_version_id, pack_version),
  constraint entitlements_tenant_ref_key unique (tenant_id, entitlement_id),
  constraint entitlements_order_key unique (tenant_id, source, external_order_ref),
  constraint entitlements_validity_check check (expires_at is null or expires_at > valid_from),
  constraint entitlements_assignment_mode_check check (
    (tenant_mode = 'b2b' and assignment_mode = 'seat' and seat_quantity > 0)
    or (tenant_mode = 'b2c' and assignment_mode = 'automatic' and seat_quantity is null)
  ),
  constraint entitlements_status_reason_check check (
    (status = 'active' and reason_code in ('platform_grant', 'administrator_reactivated'))
    or (status = 'suspended' and reason_code = 'administrator_suspended')
    or (status = 'expired' and reason_code = 'validity_expired' and expires_at is not null)
    or (status = 'revoked' and reason_code = 'platform_revoked')
  )
);

create index entitlements_active_authority_idx
  on entitlements (tenant_id, status, valid_from, expires_at, pack_product_id, entitlement_id)
  where status = 'active';
create index entitlements_due_expiry_idx
  on entitlements (status, expires_at, tenant_id, entitlement_id)
  where status = 'active' and expires_at is not null;

create table entitlement_assignments (
  assignment_id text primary key,
  tenant_id text not null,
  entitlement_id text not null,
  profile_id text not null,
  status text not null check (status in ('preparing', 'available', 'suspended', 'expired', 'failed', 'revoked')),
  reason_code text not null check (reason_code in (
    'seat_assigned', 'administrator_suspended', 'authority_suspended', 'validity_expired',
    'runtime_preparation_failed', 'administrator_revoked'
  )),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint entitlement_assignments_entitlement_fkey
    foreign key (tenant_id, entitlement_id)
    references entitlements(tenant_id, entitlement_id),
  constraint entitlement_assignments_profile_fkey
    foreign key (tenant_id, profile_id)
    references profiles(tenant_id, profile_id),
  constraint entitlement_assignments_history_key
    unique (tenant_id, entitlement_id, profile_id),
  constraint entitlement_assignments_status_reason_check check (
    (status in ('preparing', 'available') and reason_code = 'seat_assigned')
    or (status = 'suspended' and reason_code in ('administrator_suspended', 'authority_suspended'))
    or (status = 'expired' and reason_code = 'validity_expired')
    or (status = 'failed' and reason_code = 'runtime_preparation_failed')
    or (status = 'revoked' and reason_code = 'administrator_revoked')
  )
);

create index entitlement_assignments_active_entitlement_idx
  on entitlement_assignments (tenant_id, entitlement_id, status, profile_id)
  where status in ('preparing', 'available');
create index entitlement_assignments_active_profile_idx
  on entitlement_assignments (tenant_id, profile_id, status, entitlement_id)
  where status in ('preparing', 'available');

create function enforce_entitlement_assignment_seat_capacity()
returns trigger
language plpgsql
as $$
declare
  entitlement_seats integer;
  entitlement_assignment_mode text;
  entitlement_status text;
  entitlement_valid_from timestamptz;
  entitlement_expires_at timestamptz;
  consumed_seats integer;
begin
  if new.status not in ('preparing', 'available') then
    return new;
  end if;

  select seat_quantity, assignment_mode, status, valid_from, expires_at
  into entitlement_seats, entitlement_assignment_mode, entitlement_status,
       entitlement_valid_from, entitlement_expires_at
  from entitlements
  where tenant_id = new.tenant_id and entitlement_id = new.entitlement_id
  for no key update;

  if not found
    or entitlement_assignment_mode <> 'seat'
    or entitlement_status <> 'active'
    or entitlement_valid_from > clock_timestamp()
    or (entitlement_expires_at is not null and entitlement_expires_at <= clock_timestamp()) then
    raise exception 'Assignment requires active in-window seat authority'
      using errcode = '23514',
        constraint = 'entitlement_assignments_active_authority_check';
  end if;

  select count(*)::integer into consumed_seats
  from entitlement_assignments
  where tenant_id = new.tenant_id
    and entitlement_id = new.entitlement_id
    and status in ('preparing', 'available')
    and assignment_id <> new.assignment_id;

  if consumed_seats >= entitlement_seats then
    raise exception 'Entitlement seat capacity exhausted'
      using errcode = '23514',
        constraint = 'entitlement_assignments_seat_capacity_check';
  end if;
  return new;
end
$$;

create trigger entitlement_assignments_seat_capacity_check
before insert or update of tenant_id, entitlement_id, profile_id, status on entitlement_assignments
for each row
execute function enforce_entitlement_assignment_seat_capacity();

create function enforce_entitlement_consumed_seat_capacity()
returns trigger
language plpgsql
as $$
declare
  consumed_seats integer;
begin
  select count(*)::integer into consumed_seats
  from entitlement_assignments
  where tenant_id = old.tenant_id
    and entitlement_id = old.entitlement_id
    and status in ('preparing', 'available');

  if consumed_seats > 0 and (
    new.assignment_mode <> 'seat'
    or new.seat_quantity is null
    or new.seat_quantity < consumed_seats
  ) then
    raise exception 'Entitlement cannot be reduced below committed seat consumption'
      using errcode = '23514',
        constraint = 'entitlements_consumed_seat_capacity_check';
  end if;
  return new;
end
$$;

create trigger entitlements_consumed_seat_capacity_check
before update of assignment_mode, seat_quantity on entitlements
for each row
execute function enforce_entitlement_consumed_seat_capacity();

create table entitlement_snapshots (
  snapshot_id text primary key,
  tenant_id text not null,
  profile_id text not null,
  snapshot_version bigint not null check (snapshot_version > 0),
  evaluated_at timestamptz not null default clock_timestamp(),
  canonical_input_hash text not null check (canonical_input_hash ~ '^sha256:[a-f0-9]{64}$'),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  constraint entitlement_snapshots_profile_fkey
    foreign key (tenant_id, profile_id) references profiles(tenant_id, profile_id),
  constraint entitlement_snapshots_input_key
    unique (tenant_id, profile_id, canonical_input_hash),
  constraint entitlement_snapshots_version_key
    unique (tenant_id, profile_id, snapshot_version),
  constraint entitlement_snapshots_exact_ref_key
    unique (tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at),
  constraint entitlement_snapshots_tenant_ref_key
    unique (tenant_id, profile_id, snapshot_id)
);

create table entitlement_snapshot_sources (
  tenant_id text not null,
  profile_id text not null,
  snapshot_id text not null,
  source_kind text not null check (source_kind in ('entitlement', 'assignment', 'release')),
  source_id text not null,
  source_order integer not null check (source_order > 0),
  created_at timestamptz not null default clock_timestamp(),
  constraint entitlement_snapshot_sources_snapshot_fkey
    foreign key (tenant_id, profile_id, snapshot_id)
    references entitlement_snapshots(tenant_id, profile_id, snapshot_id),
  constraint entitlement_snapshot_sources_identity_key
    unique (tenant_id, profile_id, snapshot_id, source_kind, source_id),
  constraint entitlement_snapshot_sources_order_key
    unique (tenant_id, profile_id, snapshot_id, source_kind, source_order)
);

create table entitlement_snapshot_capabilities (
  tenant_id text not null,
  profile_id text not null,
  snapshot_id text not null,
  capability_id text not null,
  capability_version_id text not null,
  version text not null,
  capability_order integer not null check (capability_order > 0),
  created_at timestamptz not null default clock_timestamp(),
  constraint entitlement_snapshot_capabilities_snapshot_fkey
    foreign key (tenant_id, profile_id, snapshot_id)
    references entitlement_snapshots(tenant_id, profile_id, snapshot_id),
  constraint entitlement_snapshot_capabilities_version_fkey
    foreign key (capability_version_id, capability_id, version)
    references capability_versions(capability_version_id, capability_id, version),
  constraint entitlement_snapshot_capabilities_identity_key
    unique (tenant_id, profile_id, snapshot_id, capability_id),
  constraint entitlement_snapshot_capabilities_order_key
    unique (tenant_id, profile_id, snapshot_id, capability_order)
);

create function enforce_entitlement_snapshot_child_creation_transaction()
returns trigger
language plpgsql
as $$
declare
  snapshot_xid bigint;
begin
  select snapshot.xmin::text::bigint into snapshot_xid
  from entitlement_snapshots as snapshot
  where snapshot.tenant_id = new.tenant_id
    and snapshot.profile_id = new.profile_id
    and snapshot.snapshot_id = new.snapshot_id;

  if not found or snapshot_xid <> pg_current_xact_id()::text::bigint then
    raise exception 'Snapshot children must be created with their immutable parent'
      using errcode = '23514',
        constraint = 'entitlement_snapshot_children_creation_transaction_check';
  end if;
  return new;
end
$$;

create trigger entitlement_snapshot_sources_creation_transaction_check
before insert on entitlement_snapshot_sources
for each row execute function enforce_entitlement_snapshot_child_creation_transaction();
create trigger entitlement_snapshot_capabilities_creation_transaction_check
before insert on entitlement_snapshot_capabilities
for each row execute function enforce_entitlement_snapshot_child_creation_transaction();

create function validate_entitlement_snapshot_aggregate()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from entitlement_snapshot_sources as source
    where source.tenant_id = new.tenant_id
      and source.profile_id = new.profile_id
      and source.snapshot_id = new.snapshot_id
      and (
        (source.source_kind = 'entitlement' and not exists (
          select 1 from entitlements as entitlement
          where entitlement.tenant_id = new.tenant_id
            and entitlement.entitlement_id = source.source_id
        ))
        or (source.source_kind = 'assignment' and not exists (
          select 1 from entitlement_assignments as assignment
          where assignment.tenant_id = new.tenant_id
            and assignment.profile_id = new.profile_id
            and assignment.assignment_id = source.source_id
        ))
        or (source.source_kind = 'release' and not exists (
          select 1 from tenant_pack_releases as release
          where release.tenant_id = new.tenant_id
            and release.tenant_pack_release_id = source.source_id
        ))
      )
  ) then
    raise exception 'Snapshot source does not identify same-Tenant typed authority'
      using errcode = '23503',
        constraint = 'entitlement_snapshots_source_authority_check';
  end if;

  if exists (
    select 1
    from (
      select source.source_order,
        row_number() over (
          partition by source.source_kind order by source.source_id
        ) as canonical_order
      from entitlement_snapshot_sources as source
      where source.tenant_id = new.tenant_id
        and source.profile_id = new.profile_id
        and source.snapshot_id = new.snapshot_id
    ) as ordered_source
    where ordered_source.source_order <> ordered_source.canonical_order
  ) then
    raise exception 'Snapshot sources must use canonical per-kind order'
      using errcode = '23514',
        constraint = 'entitlement_snapshots_source_order_check';
  end if;

  if exists (
    select 1
    from entitlement_snapshot_capabilities as snapshot_capability
    where snapshot_capability.tenant_id = new.tenant_id
      and snapshot_capability.profile_id = new.profile_id
      and snapshot_capability.snapshot_id = new.snapshot_id
      and not exists (
        with source_releases as (
          select release.tenant_pack_release_id
          from entitlement_snapshot_sources as source
          join tenant_pack_releases as release
            on release.tenant_id = source.tenant_id
           and release.tenant_pack_release_id = source.source_id
          where source.tenant_id = new.tenant_id
            and source.profile_id = new.profile_id
            and source.snapshot_id = new.snapshot_id
            and source.source_kind = 'release'
          union
          select release.tenant_pack_release_id
          from entitlement_snapshot_sources as source
          join entitlements as entitlement
            on entitlement.tenant_id = source.tenant_id
           and entitlement.entitlement_id = source.source_id
          join tenant_pack_releases as release
            on release.tenant_id = entitlement.tenant_id
           and release.tenant_pack_release_id = entitlement.tenant_pack_release_id
           and release.status = 'current'
          where source.tenant_id = new.tenant_id
            and source.profile_id = new.profile_id
            and source.snapshot_id = new.snapshot_id
            and source.source_kind = 'entitlement'
          union
          select release.tenant_pack_release_id
          from entitlement_snapshot_sources as source
          join entitlement_assignments as assignment
            on assignment.tenant_id = source.tenant_id
           and assignment.profile_id = source.profile_id
           and assignment.assignment_id = source.source_id
          join entitlements as entitlement
            on entitlement.tenant_id = assignment.tenant_id
           and entitlement.entitlement_id = assignment.entitlement_id
          join tenant_pack_releases as release
            on release.tenant_id = entitlement.tenant_id
           and release.tenant_pack_release_id = entitlement.tenant_pack_release_id
           and release.status = 'current'
          where source.tenant_id = new.tenant_id
            and source.profile_id = new.profile_id
            and source.snapshot_id = new.snapshot_id
            and source.source_kind = 'assignment'
        )
        select 1
        from capability_versions as capability_version
        join pack_members as member
          on member.capability_id = capability_version.capability_id
         and member.capability_version_id = capability_version.capability_version_id
         and member.version = capability_version.version
        join pack_versions as pack
          on pack.pack_version_id = member.pack_version_id
         and pack.status = 'published'
        join tenant_pack_releases as release
          on release.tenant_id = new.tenant_id
         and release.pack_version_id = pack.pack_version_id
        join source_releases
          on source_releases.tenant_pack_release_id = release.tenant_pack_release_id
        where capability_version.capability_id = snapshot_capability.capability_id
          and capability_version.capability_version_id = snapshot_capability.capability_version_id
          and capability_version.version = snapshot_capability.version
          and capability_version.status = 'reviewed'
          and (
            capability_version.risk_class = 'read'
            or (
              capability_version.risk_class = 'draft_write'
              and capability_version.artifact_ref like 'manifest:sha256:%'
            )
          )
      )
  ) then
    raise exception 'Snapshot Capability is not effective reviewed Pack authority'
      using errcode = '23514',
        constraint = 'entitlement_snapshots_capability_authority_check';
  end if;

  if exists (
    select 1
    from (
      select capability.capability_order,
        row_number() over (
          order by capability.capability_id, capability.capability_version_id, capability.version
        ) as canonical_order
      from entitlement_snapshot_capabilities as capability
      where capability.tenant_id = new.tenant_id
        and capability.profile_id = new.profile_id
        and capability.snapshot_id = new.snapshot_id
    ) as ordered_capability
    where ordered_capability.capability_order <> ordered_capability.canonical_order
  ) then
    raise exception 'Snapshot Capabilities must use canonical order'
      using errcode = '23514',
        constraint = 'entitlement_snapshots_capability_order_check';
  end if;
  return new;
end
$$;

create constraint trigger entitlement_snapshots_aggregate_authority_check
after insert on entitlement_snapshots
deferrable initially deferred
for each row execute function validate_entitlement_snapshot_aggregate();
create constraint trigger entitlement_snapshot_sources_aggregate_authority_check
after insert on entitlement_snapshot_sources
deferrable initially deferred
for each row execute function validate_entitlement_snapshot_aggregate();
create constraint trigger entitlement_snapshot_capabilities_aggregate_authority_check
after insert on entitlement_snapshot_capabilities
deferrable initially deferred
for each row execute function validate_entitlement_snapshot_aggregate();

create table profile_snapshot_pointers (
  tenant_id text not null,
  profile_id text not null,
  snapshot_id text not null,
  snapshot_version bigint not null check (snapshot_version > 0),
  evaluated_at timestamptz not null,
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, profile_id),
  constraint profile_snapshot_pointers_snapshot_fkey
    foreign key (tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at)
    references entitlement_snapshots(tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at)
);

create index profile_snapshot_pointers_snapshot_idx
  on profile_snapshot_pointers (tenant_id, snapshot_id, profile_id);

create function enforce_profile_snapshot_pointer_cas()
returns trigger
language plpgsql
as $$
begin
  if current_setting('core_agent.profile_snapshot_pointer_cas', true) is distinct from 'authorized' then
    raise exception 'Profile Snapshot pointers require expected-version CAS'
      using errcode = '23514',
        constraint = 'profile_snapshot_pointers_cas_check';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger profile_snapshot_pointers_cas_check
before insert or update or delete on profile_snapshot_pointers
for each row
execute function enforce_profile_snapshot_pointer_cas();

create function advance_profile_snapshot_pointer(
  p_tenant_id text,
  p_profile_id text,
  p_expected_resource_version bigint,
  p_snapshot_id text
)
returns table (resource_version bigint)
language plpgsql
security definer
as $$
declare
  next_snapshot_version bigint;
  next_evaluated_at timestamptz;
  current_resource_version bigint;
  current_snapshot_version bigint;
  changed_version bigint;
begin
  perform 1
  from profiles as profile
  where profile.tenant_id = p_tenant_id
    and profile.profile_id = p_profile_id
  for update;
  if not found then
    raise exception 'Profile does not belong to the requested Tenant'
      using errcode = '23503',
        constraint = 'profile_snapshot_pointers_profile_authority_check';
  end if;

  select snapshot.snapshot_version, snapshot.evaluated_at
  into next_snapshot_version, next_evaluated_at
  from entitlement_snapshots as snapshot
  where snapshot.tenant_id = p_tenant_id
    and snapshot.profile_id = p_profile_id
    and snapshot.snapshot_id = p_snapshot_id
  for share;

  if not found then
    raise exception 'Snapshot does not belong to the requested Tenant and Profile'
      using errcode = '23503',
        constraint = 'profile_snapshot_pointers_snapshot_authority_check';
  end if;

  if p_expected_resource_version is null or p_expected_resource_version < 0 then
    raise exception 'Profile Snapshot pointer expected version is stale'
      using errcode = '40001',
        constraint = 'profile_snapshot_pointers_expected_version_check';
  end if;

  select pointer.resource_version, pointer.snapshot_version
  into current_resource_version, current_snapshot_version
  from profile_snapshot_pointers as pointer
  where pointer.tenant_id = p_tenant_id
    and pointer.profile_id = p_profile_id
  for update;

  if (p_expected_resource_version = 0 and found)
    or (p_expected_resource_version > 0 and (
      not found or current_resource_version <> p_expected_resource_version
    )) then
    raise exception 'Profile Snapshot pointer expected version is stale'
      using errcode = '40001',
        constraint = 'profile_snapshot_pointers_expected_version_check';
  end if;

  if p_expected_resource_version > 0 and next_snapshot_version <= current_snapshot_version then
    raise exception 'Profile Snapshot pointer must advance monotonically'
      using errcode = '23514',
        constraint = 'profile_snapshot_pointers_monotonic_snapshot_check';
  end if;

  perform set_config('core_agent.profile_snapshot_pointer_cas', 'authorized', true);
  if p_expected_resource_version = 0 then
    insert into profile_snapshot_pointers (
      tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at,
      resource_version, created_at, updated_at
    ) values (
      p_tenant_id, p_profile_id, p_snapshot_id, next_snapshot_version, next_evaluated_at,
      1, clock_timestamp(), clock_timestamp()
    ) returning profile_snapshot_pointers.resource_version into changed_version;
  else
    update profile_snapshot_pointers
    set snapshot_id = p_snapshot_id,
        snapshot_version = next_snapshot_version,
        evaluated_at = next_evaluated_at,
        resource_version = profile_snapshot_pointers.resource_version + 1,
        updated_at = clock_timestamp()
    where tenant_id = p_tenant_id
      and profile_id = p_profile_id
    returning profile_snapshot_pointers.resource_version into changed_version;
  end if;
  return query select changed_version;
end
$$;

create table capability_runtime_projections (
  projection_id text primary key,
  tenant_id text not null,
  profile_id text not null,
  snapshot_id text not null,
  snapshot_version bigint not null,
  evaluated_at timestamptz not null,
  tenant_pack_release_id text,
  runtime_generation bigint not null check (runtime_generation > 0),
  capability_manifest_digest text not null check (capability_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  status text not null check (status in ('preparing', 'available', 'failed')),
  reason_code text check (reason_code is null or reason_code in (
    'runtime_preparation_failed', 'runtime_health_check_failed', 'capability_manifest_mismatch'
  )),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint capability_runtime_projections_snapshot_fkey
    foreign key (tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at)
    references entitlement_snapshots(tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at),
  constraint capability_runtime_projections_release_fkey
    foreign key (tenant_id, tenant_pack_release_id)
    references tenant_pack_releases(tenant_id, tenant_pack_release_id),
  constraint capability_runtime_projections_generation_key unique (tenant_id, runtime_generation),
  constraint capability_runtime_projections_status_reason_check check (
    (status in ('preparing', 'available') and reason_code is null)
    or (status = 'failed' and reason_code is not null)
  )
);

create index capability_runtime_projections_claim_idx
  on capability_runtime_projections (status, updated_at, tenant_id, runtime_generation)
  where status in ('preparing', 'failed');

create table runtime_activity (
  tenant_id text not null references tenants(tenant_id),
  runtime_generation bigint not null check (runtime_generation > 0),
  last_work_at timestamptz not null default clock_timestamp(),
  active_conversation_count integer not null default 0 check (active_conversation_count >= 0),
  active_run_count integer not null default 0 check (active_run_count >= 0),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, runtime_generation)
);

create index runtime_activity_due_idle_stop_idx
  on runtime_activity (active_conversation_count, active_run_count, last_work_at, tenant_id, runtime_generation)
  where active_conversation_count = 0 and active_run_count = 0;

create index capability_runtime_projections_release_fk_idx
  on capability_runtime_projections (tenant_id, tenant_pack_release_id);
create index capability_runtime_projections_snapshot_fk_idx
  on capability_runtime_projections (tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at);
create index capability_versions_kind_fk_idx
  on capability_versions (capability_id, kind);
create index entitlement_snapshot_capabilities_version_fk_idx
  on entitlement_snapshot_capabilities (capability_version_id, capability_id, version);
create index entitlements_release_fk_idx
  on entitlements (tenant_id, tenant_pack_release_id, pack_product_id, pack_version_id, pack_version);
create index pack_members_capability_version_fk_idx
  on pack_members (capability_version_id, capability_id, version);
create index platform_authority_audit_actor_fk_idx
  on platform_authority_audit (actor_id);
create index platform_authority_audit_membership_fk_idx
  on platform_authority_audit (authority_tenant_id, membership_id, actor_id);
create index profile_snapshot_pointers_snapshot_fk_idx
  on profile_snapshot_pointers (tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at);
create index tenant_pack_releases_pack_version_fk_idx
  on tenant_pack_releases (pack_version_id, pack_product_id, pack_version);

alter table runtime_containers
  add column capability_manifest_digest text,
  add constraint runtime_containers_capability_manifest_digest_check
  check (capability_manifest_digest is null or capability_manifest_digest ~ '^sha256:[a-f0-9]{64}$');

alter table worker_jobs drop constraint worker_jobs_job_kind_check;
alter table worker_jobs
  add constraint worker_jobs_job_kind_check
  check (job_kind in (
    'provision_runtime',
    'reconcile_runtime',
    'execute_agent_run',
    'dispatch_outbox',
    'project_platform_memberships',
    'finalize_account_deletion',
    'reconcile_capability_projection',
    'stop_idle_b2c_runtime'
  ));

create index worker_jobs_capability_projection_claim_idx
  on worker_jobs (job_kind, status, next_attempt_at, created_at, tenant_id, job_id)
  where job_kind in ('reconcile_capability_projection', 'stop_idle_b2c_runtime')
    and status in ('queued', 'retrying');

create function enforce_capability_version_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and not (
    (old.status = 'draft' and new.status in ('draft', 'reviewed', 'blocked'))
    or (old.status = 'reviewed' and new.status in ('reviewed', 'retired', 'blocked'))
    or (old.status = 'retired' and new.status in ('retired', 'blocked'))
    or (old.status = 'blocked' and new.status = 'blocked')
  ) then
    raise exception 'Capability Version status transition is irreversible'
      using errcode = '23514', constraint = 'capability_versions_status_transition_check';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Reviewed Capability Versions are immutable'
        using errcode = '23514', constraint = 'capability_versions_reviewed_immutable_check';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and (
    new.capability_version_id, new.capability_id, new.version, new.kind, new.artifact_ref,
    new.contract_ref, new.risk_class, new.approval_requirement, new.compatibility_json, new.created_at
  ) is distinct from (
    old.capability_version_id, old.capability_id, old.version, old.kind, old.artifact_ref,
    old.contract_ref, old.risk_class, old.approval_requirement, old.compatibility_json, old.created_at
  ) then
    raise exception 'Reviewed Capability Version executable metadata is immutable'
      using errcode = '23514', constraint = 'capability_versions_reviewed_immutable_check';
  end if;
  return new;
end
$$;

create trigger capability_versions_reviewed_immutable_check
before update or delete on capability_versions
for each row
execute function enforce_capability_version_immutability();

create function enforce_pack_version_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and not (
    (old.status = 'draft' and new.status in ('draft', 'reviewed', 'blocked'))
    or (old.status = 'reviewed' and new.status in ('reviewed', 'published', 'blocked'))
    or (old.status = 'published' and new.status in ('published', 'retired', 'blocked'))
    or (old.status = 'retired' and new.status in ('retired', 'blocked'))
    or (old.status = 'blocked' and new.status = 'blocked')
  ) then
    raise exception 'Pack Version status transition is irreversible'
      using errcode = '23514', constraint = 'pack_versions_status_transition_check';
  end if;
  if tg_op = 'UPDATE' and new.status = 'published' and old.status <> 'published' and (
    not exists (
      select 1 from pack_members as member
      where member.pack_version_id = old.pack_version_id
    )
    or exists (
      select 1
      from (
        select member.member_order,
          row_number() over (
            order by member.capability_id, member.capability_version_id, member.version
          ) as canonical_order
        from pack_members as member
        where member.pack_version_id = old.pack_version_id
      ) as ordered_member
      where ordered_member.member_order <> ordered_member.canonical_order
    )
    or exists (
      select 1
      from pack_members as member
      join capability_versions as capability_version
        on capability_version.capability_version_id = member.capability_version_id
       and capability_version.capability_id = member.capability_id
       and capability_version.version = member.version
      join pack_products as product
        on product.pack_product_id = old.pack_product_id
      where member.pack_version_id = old.pack_version_id
        and (
          capability_version.status <> 'reviewed'
          or capability_version.risk_class in ('external_write', 'privileged')
          or (
            capability_version.risk_class = 'draft_write'
            and capability_version.artifact_ref not like 'manifest:sha256:%'
          )
          or not (
            capability_version.compatibility_json -> 'tenant_modes'
            @> to_jsonb(product.tenant_modes)
          )
        )
    )
  ) then
    raise exception 'Pack Version members are not canonical publishable authority'
      using errcode = '23514', constraint = 'pack_versions_publishable_members_check';
  end if;
  if tg_op = 'DELETE' then
    if old.status in ('published', 'retired', 'blocked') then
      raise exception 'Published Pack Versions are immutable'
        using errcode = '23514', constraint = 'pack_versions_published_immutable_check';
    end if;
    return old;
  end if;
  if old.status in ('published', 'retired', 'blocked') and (
    new.pack_version_id, new.pack_product_id, new.version, new.created_at
  ) is distinct from (
    old.pack_version_id, old.pack_product_id, old.version, old.created_at
  ) then
    raise exception 'Published Pack Version content identity is immutable'
      using errcode = '23514', constraint = 'pack_versions_published_immutable_check';
  end if;
  return new;
end
$$;

create trigger pack_versions_published_immutable_check
before update or delete on pack_versions
for each row
execute function enforce_pack_version_immutability();

create function enforce_pack_member_immutability()
returns trigger
language plpgsql
as $$
declare
  parent_status text;
begin
  select status into parent_status from pack_versions
  where pack_version_id = case when tg_op = 'DELETE' then old.pack_version_id else new.pack_version_id end
  for share;
  if parent_status in ('published', 'retired', 'blocked') then
    raise exception 'Published Pack members are immutable'
      using errcode = '23514', constraint = 'pack_members_published_immutable_check';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger pack_members_published_immutable_check
before insert or update or delete on pack_members
for each row
execute function enforce_pack_member_immutability();

create function enforce_tenant_pack_release_history_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from pack_versions as pack
      where pack.pack_version_id = new.pack_version_id
        and pack.pack_product_id = new.pack_product_id
        and pack.version = new.pack_version
        and pack.status = 'published'
    ) then
      raise exception 'Tenant Pack Releases require a published Pack Version'
        using errcode = '23514', constraint = 'tenant_pack_releases_published_pack_check';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Tenant Pack Release history is immutable'
      using errcode = '23514', constraint = 'tenant_pack_releases_history_immutable_check';
  end if;
  if not (
    (old.status = 'preparing' and new.status in ('preparing', 'current', 'failed'))
    or (old.status = 'current' and new.status in ('current', 'superseded'))
    or (old.status = 'failed' and new.status = 'failed')
    or (old.status = 'superseded' and new.status = 'superseded')
  ) then
    raise exception 'Tenant Pack Release status transition is irreversible'
      using errcode = '23514', constraint = 'tenant_pack_releases_status_transition_check';
  end if;
  if (
    new.tenant_pack_release_id, new.tenant_id, new.pack_product_id, new.pack_version_id,
    new.pack_version, new.generation, new.created_at
  ) is distinct from (
    old.tenant_pack_release_id, old.tenant_id, old.pack_product_id, old.pack_version_id,
    old.pack_version, old.generation, old.created_at
  ) then
    raise exception 'Tenant Pack Release history identity is immutable'
      using errcode = '23514', constraint = 'tenant_pack_releases_history_immutable_check';
  end if;
  return new;
end
$$;

create trigger tenant_pack_releases_history_immutable_check
before insert or update or delete on tenant_pack_releases
for each row
execute function enforce_tenant_pack_release_history_immutability();

create function enforce_entitlement_snapshot_immutability()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Entitlement Snapshots are immutable'
    using errcode = '23514', constraint = tg_table_name || '_immutable_check';
end
$$;

create trigger entitlement_snapshots_immutable_check
before update or delete on entitlement_snapshots
for each row execute function enforce_entitlement_snapshot_immutability();
create trigger entitlement_snapshot_sources_immutable_check
before update or delete on entitlement_snapshot_sources
for each row execute function enforce_entitlement_snapshot_immutability();
create trigger entitlement_snapshot_capabilities_immutable_check
before update or delete on entitlement_snapshot_capabilities
for each row execute function enforce_entitlement_snapshot_immutability();

alter function enforce_entitlement_assignment_seat_capacity() set search_path = pg_catalog, public;
alter function enforce_entitlement_consumed_seat_capacity() set search_path = pg_catalog, public;
alter function enforce_profile_snapshot_pointer_cas() set search_path = pg_catalog, public;
alter function advance_profile_snapshot_pointer(text, text, bigint, text) set search_path = pg_catalog, public;
alter function core_agent_is_canonical_semver(text) set search_path = pg_catalog, public;
alter function core_agent_is_exact_contract_ref(text) set search_path = pg_catalog, public;
alter function core_agent_is_immutable_artifact_ref(text) set search_path = pg_catalog, public;
alter function core_agent_is_valid_capability_compatibility(jsonb) set search_path = pg_catalog, public;
alter function enforce_capability_version_immutability() set search_path = pg_catalog, public;
alter function enforce_pack_version_immutability() set search_path = pg_catalog, public;
alter function enforce_pack_member_immutability() set search_path = pg_catalog, public;
alter function enforce_tenant_pack_release_history_immutability() set search_path = pg_catalog, public;
alter function enforce_entitlement_snapshot_immutability() set search_path = pg_catalog, public;
alter function enforce_entitlement_snapshot_child_creation_transaction() set search_path = pg_catalog, public;
alter function validate_entitlement_snapshot_aggregate() set search_path = pg_catalog, public;

revoke all on table
  capabilities, capability_versions, pack_products, pack_versions, pack_members,
  platform_authority_audit, tenant_pack_releases, entitlements, entitlement_assignments,
  entitlement_snapshots, entitlement_snapshot_sources, entitlement_snapshot_capabilities,
  profile_snapshot_pointers, capability_runtime_projections, runtime_activity
from public, core_agent_app, core_agent_identity;

grant usage on schema public to core_agent_app;

grant select on table
  capabilities, capability_versions, pack_products, pack_versions, pack_members,
  tenant_pack_releases, entitlements, entitlement_assignments, entitlement_snapshots,
  entitlement_snapshot_sources, entitlement_snapshot_capabilities, profile_snapshot_pointers,
  capability_runtime_projections, runtime_activity
to core_agent_app;
grant insert, update on table capability_runtime_projections, runtime_activity to core_agent_app;
grant update on table tenant_pack_releases to core_agent_app;

grant select, insert, update on table
  capabilities, capability_versions, pack_products, pack_versions, pack_members,
  tenant_pack_releases, entitlements, entitlement_assignments,
  capability_runtime_projections, runtime_activity
to core_agent_identity;
grant select, insert on table
  platform_authority_audit, entitlement_snapshots, entitlement_snapshot_sources,
  entitlement_snapshot_capabilities
to core_agent_identity;
grant select on table profile_snapshot_pointers to core_agent_identity;

revoke all on function enforce_entitlement_assignment_seat_capacity() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_entitlement_consumed_seat_capacity() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_profile_snapshot_pointer_cas() from public, core_agent_app, core_agent_identity;
revoke all on function advance_profile_snapshot_pointer(text, text, bigint, text) from public, core_agent_app, core_agent_identity;
revoke all on function core_agent_is_canonical_semver(text) from public, core_agent_app, core_agent_identity;
revoke all on function core_agent_is_exact_contract_ref(text) from public, core_agent_app, core_agent_identity;
revoke all on function core_agent_is_immutable_artifact_ref(text) from public, core_agent_app, core_agent_identity;
revoke all on function core_agent_is_valid_capability_compatibility(jsonb) from public, core_agent_app, core_agent_identity;
revoke all on function enforce_capability_version_immutability() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_pack_version_immutability() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_pack_member_immutability() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_tenant_pack_release_history_immutability() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_entitlement_snapshot_immutability() from public, core_agent_app, core_agent_identity;
revoke all on function enforce_entitlement_snapshot_child_creation_transaction() from public, core_agent_app, core_agent_identity;
revoke all on function validate_entitlement_snapshot_aggregate() from public, core_agent_app, core_agent_identity;
grant execute on function core_agent_is_canonical_semver(text), core_agent_is_exact_contract_ref(text), core_agent_is_immutable_artifact_ref(text), core_agent_is_valid_capability_compatibility(jsonb) to core_agent_identity;
grant execute on function advance_profile_snapshot_pointer(text, text, bigint, text) to core_agent_app, core_agent_identity;
