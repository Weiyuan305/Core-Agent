alter table worker_jobs
  add constraint worker_jobs_attempt_count_max_check
  check (attempt_count <= max_attempts);
