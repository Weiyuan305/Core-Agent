-- Contracts 0.8.0 permits a dotted repository component when no registry slash
-- is present (for example, oci:registry.example@sha256:...).  Schema 013
-- treated that valid unqualified repository as a malformed registry.  Keep the
-- existing named CHECK constraint and advance only its immutable predicate.
create or replace function core_agent_is_immutable_artifact_ref(candidate text)
returns boolean
language plpgsql
immutable
as $$
declare
  artifact_body text;
  package_name text;
  package_version text;
  repository_ref text;
  repository_path text;
  registry_name text;
begin
  if candidate is null then return false; end if;
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
    -- This is the Contracts unqualified-repository branch.  Its component
    -- grammar permits dots; registry-looking prefixes are rejected only when
    -- followed by a slash, so a dotted no-slash identity remains a repository.
    repository_path := repository_ref;
  end if;
  return char_length(repository_path) between 1 and 255
    and repository_path ~ '^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*(/[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*)*$';
end
$$;

alter function core_agent_is_immutable_artifact_ref(text) set search_path = pg_catalog, public;
revoke all on function core_agent_is_immutable_artifact_ref(text) from public, core_agent_app, core_agent_identity;
grant execute on function core_agent_is_immutable_artifact_ref(text) to core_agent_identity;
