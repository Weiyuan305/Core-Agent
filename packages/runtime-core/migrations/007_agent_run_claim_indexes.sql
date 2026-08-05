create index agent_runs_tenant_conversation_run_idx
  on agent_runs (tenant_id, conversation_id, run_id);

create index worker_jobs_tenant_run_idx
  on worker_jobs (tenant_id, run_id)
  where run_id is not null;

create index worker_jobs_platform_eligible_idx
  on worker_jobs (job_kind, status, created_at, next_attempt_at, tenant_id, job_id)
  where status in ('queued', 'retrying');

create index worker_jobs_platform_recovery_idx
  on worker_jobs (job_kind, lease_expires_at, created_at, tenant_id, job_id)
  where status = 'running';
