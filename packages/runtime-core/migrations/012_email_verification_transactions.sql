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
  expected_provider_subject_hmac bytea
    check (expected_provider_subject_hmac is null or octet_length(expected_provider_subject_hmac) = 32),
  expected_provider_subject_ciphertext bytea
    check (expected_provider_subject_ciphertext is null or octet_length(expected_provider_subject_ciphertext) between 33 and 65536),
  verified_provider_subject_hmac bytea
    check (verified_provider_subject_hmac is null or octet_length(verified_provider_subject_hmac) = 32),
  verified_subject_ciphertext bytea
    check (verified_subject_ciphertext is null or octet_length(verified_subject_ciphertext) between 33 and 65536),
  provider_verification_status text not null default 'pending'
    check (provider_verification_status in ('pending', 'verified')),
  provider_verification_started_at timestamptz,
  provider_verification_attempt_expires_at timestamptz,
  provider_verification_proof_hmac bytea
    check (provider_verification_proof_hmac is null or octet_length(provider_verification_proof_hmac) = 32),
  provider_verification_attempt_count integer not null default 0
    constraint email_verification_provider_verification_attempt_count_check
    check (provider_verification_attempt_count between 0 and 5),
  provider_verified_at timestamptz,
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
    (provider_start_status = 'reserved' and provider_start_finalized_at is null and provider_start_failed_at is null
      and expected_provider_subject_hmac is null and expected_provider_subject_ciphertext is null)
    or (provider_start_status = 'finalized' and provider_start_finalized_at is not null and provider_start_failed_at is null
      and expected_provider_subject_hmac is not null and expected_provider_subject_ciphertext is not null)
    or (provider_start_status = 'failed' and provider_start_finalized_at is null and provider_start_failed_at is not null
      and expected_provider_subject_hmac is null and expected_provider_subject_ciphertext is null)
  ),
  constraint email_verification_provider_verification_state_check check (
    (provider_verification_status = 'pending' and verified_provider_subject_hmac is null
      and verified_subject_ciphertext is null and provider_verified_at is null
      and (
        (provider_verification_started_at is null and provider_verification_attempt_expires_at is null
          and provider_verification_proof_hmac is null)
        or (provider_verification_started_at is not null and provider_verification_attempt_expires_at is not null
          and provider_verification_proof_hmac is not null
          and provider_verification_attempt_expires_at > provider_verification_started_at
          and provider_verification_attempt_expires_at <= expires_at)
      ))
    or (provider_verification_status = 'verified' and verified_provider_subject_hmac is not null
      and verified_subject_ciphertext is not null and provider_verified_at is not null
      and provider_verification_started_at is not null
      and provider_verification_attempt_expires_at is not null
      and provider_verification_proof_hmac is not null
      and provider_verification_attempt_expires_at > provider_verification_started_at
      and provider_verification_attempt_expires_at <= expires_at
      and provider_verified_at >= provider_verification_started_at)
  ),
  check (status <> 'consumed' or provider_verification_status = 'verified'),
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

alter table public_rate_limits
  drop constraint public_rate_limits_bucket_kind_check;

alter table public_rate_limits
  add constraint public_rate_limits_bucket_kind_check
  check (bucket_kind in (
    'signup', 'login', 'reset', 'email_verification', 'reset_complete', 'apple_start', 'apple_link',
    'apple_callback', 'invitation_accept', 'reauthenticate'
  ));

alter table auth_subjects
  drop constraint auth_subjects_provider_identity_kind_check;

alter table auth_subjects
  add constraint auth_subjects_provider_identity_kind_check
  check (provider_identity_kind in ('email_password', 'apple', 'email_password_apple'));

alter table oauth_transactions
  add column provider_completion_status text not null default 'pending',
  add column provider_completion_started_at timestamptz,
  add column expected_provider_subject_ciphertext bytea
    constraint oauth_transactions_expected_provider_subject_ciphertext_check
    check (expected_provider_subject_ciphertext is null or octet_length(expected_provider_subject_ciphertext) between 33 and 65536),
  add column provider_subject_ciphertext bytea
    constraint oauth_transactions_provider_subject_ciphertext_check
    check (provider_subject_ciphertext is null or octet_length(provider_subject_ciphertext) between 33 and 65536),
  add column provider_completion_payload_hash text
    constraint oauth_transactions_provider_completion_payload_hash_check
    check (provider_completion_payload_hash is null or provider_completion_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  add column provider_settlement_expires_at timestamptz,
  add column provider_completed_at timestamptz,
  add column provider_evidence_at timestamptz;

-- Version-11 password-reset rows cannot satisfy the version-12 exact-subject
-- binding. Preserve them as terminal history, but never let them resume.
update oauth_transactions
set status = 'expired', updated_at = clock_timestamp()
where flow_kind = 'password_reset' and status = 'pending';

alter table oauth_transactions
  add constraint oauth_transactions_provider_completion_status_check
  check (provider_completion_status in ('pending', 'provider_started', 'provider_completed')),
  add constraint oauth_transactions_provider_completion_state_check
  check (
    (flow_kind <> 'password_reset' and provider_completion_status = 'pending'
      and provider_completion_started_at is null and expected_provider_subject_ciphertext is null
      and provider_subject_ciphertext is null
      and provider_completion_payload_hash is null
      and provider_settlement_expires_at is null
      and provider_completed_at is null and provider_evidence_at is null)
    or (flow_kind = 'password_reset' and provider_completion_status = 'pending'
      and provider_completion_started_at is null and expected_provider_subject_ciphertext is not null
      and provider_subject_ciphertext is null
      and provider_completion_payload_hash is null
      and provider_settlement_expires_at is null
      and provider_completed_at is null and provider_evidence_at is null)
    or (flow_kind = 'password_reset' and status = 'expired' and provider_completion_status = 'pending'
      and provider_completion_started_at is null and expected_provider_subject_ciphertext is null
      and provider_subject_ciphertext is null
      and provider_completion_payload_hash is null
      and provider_settlement_expires_at is null
      and provider_completed_at is null and provider_evidence_at is null)
    or (flow_kind = 'password_reset' and provider_completion_status = 'provider_started'
      and provider_completion_started_at is not null and expected_provider_subject_ciphertext is not null
      and provider_subject_ciphertext is not null
      and provider_completion_payload_hash is not null
      and provider_settlement_expires_at = provider_completion_started_at + interval '30 minutes'
      and provider_completed_at is null and provider_evidence_at is null)
    or (flow_kind = 'password_reset' and provider_completion_status = 'provider_completed'
      and provider_completion_started_at is not null and expected_provider_subject_ciphertext is not null
      and provider_subject_ciphertext is not null
      and provider_completion_payload_hash is not null
      and provider_settlement_expires_at = provider_completion_started_at + interval '30 minutes'
      and provider_completed_at is not null and provider_evidence_at is not null
      and provider_evidence_at >= provider_completion_started_at
      and provider_evidence_at <= provider_completed_at
      and provider_completed_at <= provider_settlement_expires_at)
  );
