-- Runtime platform is internal Supervisor input. Existing rows stay null because
-- an image digest does not prove an OCI platform; Workers fail closed on null.
alter table runtime_containers
  add column runtime_platform text
  check (runtime_platform is null or runtime_platform in ('linux/amd64', 'linux/arm64'));

alter table runtime_containers add column command_version bigint not null default 0 check (command_version >= 0);

alter table worker_jobs add column target_command_version bigint;

-- Active v4 commands are not durably bound to an independent command version.
-- Executing them after a newer command could replay stale intent, so upgrade
-- fails them closed instead of guessing.
update worker_jobs
set status = 'failed', lease_owner = null, lease_expires_at = null,
    last_error_summary = 'Legacy reconcile command version unavailable after schema upgrade',
    updated_at = now()
where job_kind = 'reconcile_runtime' and status in ('queued', 'running', 'retrying');

alter table worker_jobs add constraint worker_jobs_target_command_version_check check (
  (job_kind = 'reconcile_runtime' and
    ((status in ('queued', 'running', 'retrying') and target_command_version is not null and target_command_version > 0)
      or status in ('succeeded', 'failed', 'cancelled')))
  or (job_kind <> 'reconcile_runtime' and target_command_version is null)
);

-- Outbox delivery uses its own short lease. Product events remain truth while
-- these rows are merely retryable PostgreSQL wakeups.
alter table outbox
  add column lease_owner text,
  add column lease_expires_at timestamptz,
  add column last_error_summary text
    check (last_error_summary is null or char_length(last_error_summary) between 1 and 1000);

create index outbox_eligible_idx on outbox (status, next_attempt_at, created_at);
