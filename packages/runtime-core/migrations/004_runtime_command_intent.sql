alter table worker_jobs
  add column runtime_command text;

alter table worker_jobs
  add constraint worker_jobs_runtime_command_intent_check
  check (
    runtime_command is null
    or (
      job_kind = 'reconcile_runtime'
      and runtime_command in ('start', 'stop', 'restart', 'delete')
    )
  );
