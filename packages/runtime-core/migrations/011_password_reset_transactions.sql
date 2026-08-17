alter table oauth_transactions
  drop constraint oauth_transactions_flow_kind_check;

alter table oauth_transactions
  add constraint oauth_transactions_flow_kind_check
  check (flow_kind in ('apple_sign_in', 'apple_link', 'password_reset'));
