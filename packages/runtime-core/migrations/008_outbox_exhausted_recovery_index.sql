create index outbox_exhausted_recovery_idx
  on outbox (created_at, tenant_id, outbox_id)
  include (lease_owner, lease_expires_at)
  where status = 'pending' and attempt_count >= 10;
