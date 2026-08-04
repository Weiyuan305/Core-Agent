alter table worker_jobs
  add column runtime_command text;

update worker_jobs
set status = 'failed',
    lease_owner = null,
    lease_expires_at = null,
    runtime_command = null,
    last_error_summary = 'Legacy reconcile intent unavailable after schema upgrade',
    updated_at = now()
where job_kind = 'reconcile_runtime';

alter table worker_jobs
  add constraint worker_jobs_runtime_command_intent_check
  check (
    (
      job_kind = 'reconcile_runtime'
      and (
        (
          runtime_command is not null
          and runtime_command in ('start', 'stop', 'restart', 'delete')
        )
        or (
          runtime_command is null
          and status in ('failed', 'cancelled')
        )
      )
    )
    or (
      job_kind <> 'reconcile_runtime'
      and runtime_command is null
    )
  );
