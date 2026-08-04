alter table worker_jobs
  add column runtime_command text;

update worker_jobs as jobs
set runtime_command = case runtimes.desired_state
  when 'running' then 'start'
  when 'stopped' then 'stop'
  when 'deleted' then 'delete'
end
from runtime_containers as runtimes
where jobs.job_kind = 'reconcile_runtime'
  and runtimes.tenant_id = jobs.tenant_id
  and runtimes.container_id = jobs.container_id;

update worker_jobs
set status = 'failed',
    lease_owner = null,
    lease_expires_at = null,
    runtime_command = 'stop',
    last_error_summary = 'Legacy reconcile intent unavailable after schema upgrade',
    updated_at = now()
where job_kind = 'reconcile_runtime'
  and runtime_command is null;

alter table worker_jobs
  add constraint worker_jobs_runtime_command_intent_check
  check (
    (
      job_kind = 'reconcile_runtime'
      and runtime_command is not null
      and runtime_command in ('start', 'stop', 'restart', 'delete')
    )
    or (
      job_kind <> 'reconcile_runtime'
      and runtime_command is null
    )
  );
