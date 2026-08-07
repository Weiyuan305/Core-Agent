alter table agent_runs add column failure_code text;

update agent_runs
set failure_code = 'RUN_FAILURE_UNKNOWN'
where status = 'failed' and failure_code is null;

alter table agent_runs
  add constraint agent_runs_failure_code_allowlist_check
  check (
    failure_code is null or failure_code in (
      'MODEL_BUSY',
      'MODEL_SERVICE_UNAVAILABLE',
      'MODEL_RESPONSE_TIMEOUT',
      'MODEL_ACCESS_DENIED',
      'MODEL_NOT_AVAILABLE',
      'MODEL_RESPONSE_INVALID',
      'MODEL_STREAM_INTERRUPTED',
      'MODEL_EMPTY_RESPONSE',
      'AGENT_RUNTIME_NOT_READY',
      'RUN_INTERNAL_ERROR',
      'RUN_FAILURE_UNKNOWN'
    )
  ),
  add constraint agent_runs_failure_code_state_check
  check (
    (status = 'failed' and failure_code is not null)
    or (status <> 'failed' and failure_code is null)
  );
