# Changelog

## 0.8.0 - 2026-08-21

- Add closed Capability-Version and Pack-Version catalog lifecycle ProductEvent
  branches for draft creation, review, publication, retirement, and blocking.
  Payloads carry only stable resource identifiers, closed status facts, and
  resource versions; executable metadata, customer/provider content, and secrets
  remain excluded.
- Append the immutable 0.8.0 schema release without changing 0.2.0–0.7.0.

## 0.7.0 - 2026-08-20

- Add closed Capability, immutable Capability Version, Pack Product, exact Pack
  Version/member, and Tenant Pack Release resources.
- Add platform-manual B2B seat and B2C automatic Entitlement authority,
  Assignment, immutable effective Snapshot, current pointer, and Runtime service
  projection contracts.
- Add calm company/student service summaries and versioned management commands
  without exposing Capability internals, commercial payloads, tool schemas, secrets,
  or Runtime details.
- Extend ProductEvent, Trusted Context validation, and stable errors for Entitlement,
  seat, effective-snapshot, and service preparation lifecycles.
- Append the immutable 0.7.0 schema release without modifying accepted 0.2.0
  through 0.6.0 snapshots.

## 0.6.0 - 2026-08-17

- Add the closed Apple identity link-start request with current password and the
  released Web/native Apple start fields. Email, provider tokens, provider proofs,
  and caller-supplied authority remain excluded.
- Publish distinct closed Apple sign-in and identity-link start response unions:
  Web exposes only the authorization URL, while native additionally receives the
  transaction identifier and exact expiry. Authorization URLs remain bounded to
  2,048 characters.
- Append the immutable 0.6.0 schema release without modifying older snapshots.

## 0.5.0 - 2026-08-10

- Add provider-neutral identity authority resources, bounded identity ProductEvent
  branches, and the complete closed `/auth/v1` contract inventory for verification,
  Apple authentication, invitations, company-member lifecycle, Sessions, and account
  deletion.
- Keep email sign-up verification-pending, model browser Sessions as Cookie-only,
  and permit one-time opaque Session-secret delivery only for native clients with
  nonce and PKCE proof.
- Add invitation-bound email registration and verified-email acceptance, expose the
  exact optimistic-concurrency versions required by follow-up mutations, and return
  newly issued invitation secrets exactly once from company/member creation.
- Enforce Tenant-mode Membership sources, duplicate ordinary-authority rejection,
  exact S256 challenge encoding, and semantic lifecycle validation for Invitations,
  Core Sessions, and Account Deletions.
- Make invitation-acceptance responses role-discriminated, add the safe paginated
  company-member view/list needed for current Membership versions, and scope every
  public mutation reason to the command the caller is authorized to request.
- Make company-member views source/status/roles-discriminated with canonical role
  ordering, and close membership-change event reasons to the planned lifecycle
  vocabulary.
- Correlate B2B Membership and consultant Profile lifecycles across public member
  views and graph validation, including inactive Profiles retained after consultant
  role removal.
- Require singular lifecycle-matched Profiles for consultant-bearing Memberships,
  and publish explicit versioned consultant-role grant/remove command contracts.
- Enforce exact canonical company Membership role arrays for each lifecycle state,
  and discriminate first-time consultant Profile creation from retained-Profile
  reactivation with both Membership and Profile optimistic-concurrency versions.
- Preserve the released Actor status vocabulary while defining identity-authority
  deletion lifecycle separately, and enforce B2B/B2C authority-mode boundaries.
- Add the immutable 0.5.0 schema release while keeping accepted historical release
  inventories unchanged. Provider tokens and authentication PII are explicitly
  excluded from public responses, events, and business identity resources.

## 0.4.0 - 2026-08-07

- Add the closed `AgentRunFailureCode` vocabulary and expose it on Agent Run
  resources. Structural compatibility remains additive; producer and persistence
  invariants require it exactly for failed Runs.
- Add the optional `run.failed.payload.failure_code` field so historical events remain
  readable while new producers can persist structured failure semantics.

## 0.3.0 - 2026-08-04

- Add the `runtime.command_accepted` ProductEvent branch with command-specific
  desired-state bindings.

## 0.2.0 - 2026-08-03

- Add bounded Message and CreateAgentRunRequest contracts plus the
  `message.created` ProductEvent family.
- Add the Runtime v1 stable error-code literals.

## 0.1.0 - 2026-08-03

- Establish wire schema version 1 for identity, runtime, trusted context,
  product events, audit events, errors, idempotency, and external references.
- Add generated JSON Schema, anonymous fixtures, and compatibility checks.
