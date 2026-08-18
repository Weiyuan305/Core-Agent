create table email_verification_transactions (
  email_verification_transaction_id text primary key
    check (char_length(email_verification_transaction_id) between 1 and 255),
  start_idempotency_key text not null unique
    check (char_length(start_idempotency_key) between 1 and 255),
  start_payload_hash text not null
    check (start_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  normalized_email_hmac bytea not null
    check (octet_length(normalized_email_hmac) = 32),
  binding_ciphertext bytea not null
    check (octet_length(binding_ciphertext) between 33 and 65536),
  verified_provider_subject_hmac bytea
    check (verified_provider_subject_hmac is null or octet_length(verified_provider_subject_hmac) = 32),
  provider_start_status text not null
    constraint email_verification_provider_start_status_check
    check (provider_start_status in ('reserved', 'finalized', 'failed')),
  provider_start_attempt integer not null default 1
    constraint email_verification_provider_start_attempt_check
    check (provider_start_attempt between 1 and 100),
  provider_start_finalized_at timestamptz,
  provider_start_failed_at timestamptz,
  status text not null check (status in ('pending', 'consumed', 'expired')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (expires_at > created_at),
  constraint email_verification_provider_start_state_check check (
    (provider_start_status = 'reserved' and provider_start_finalized_at is null and provider_start_failed_at is null)
    or (provider_start_status = 'finalized' and provider_start_finalized_at is not null and provider_start_failed_at is null)
    or (provider_start_status = 'failed' and provider_start_finalized_at is null and provider_start_failed_at is not null)
  ),
  check ((status = 'consumed') = (consumed_at is not null)),
  check (updated_at >= created_at)
);

create index email_verification_transactions_pending_expiry_idx
  on email_verification_transactions (expires_at, email_verification_transaction_id)
  where status = 'pending';

revoke all on table email_verification_transactions
  from public, core_agent_app, core_agent_identity;

grant select, insert, update on table email_verification_transactions
  to core_agent_identity;
