# Task 7 Report — Public Identity Gateway

## Status

- Status: DONE_WITH_CONCERNS
- Branch: `feat/identity-gateway-v1`
- Base: `e7624fe0425ff470b646f8322254d5e9e3857da8`
- Original implementation commit: `2240a1bb0645e50a22204783f7cac5362924d906`
- No merge or push was performed.

## Round 6 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. All Round 6 gateway findings are implemented and
verified at the public Fastify, installed Supabase 2.112.2 adapter, and disposable
PostgreSQL boundaries. The remaining failures are unchanged Control Plane Worker
compile and integration teardown defects outside Task 7.

### Delivered Round 6 corrections

- Same-subject password plus Apple linking now CAS-updates the one active Core
  AuthSubject from internal `email_password` to `email_password_apple`. Replay is
  idempotent; a different Actor or provider subject fails before mutation. The
  combined kind remains private to Runtime Core because adding it to the released
  0.6 public union would violate the accepted 0.5 closed-union compatibility gate.
- First Apple authentication now atomically creates either a complete B2C graph or,
  for an exact valid invitation, a bare invited identity followed by the intended
  B2B Membership/Profile and Session. Existing subjects sign in normally. The
  post-provider domain phase is one caller-owned serializable retry; provider work
  is never inside the retry.
- Password-reset completion is a recoverable saga. Schema 12 records the encrypted
  exact provider subject, database-clock attempt start, server-validated completion
  payload hash, and causal provider evidence. Core Session revocation and OAuth
  consumption commit together. Retry after Core rollback retains the recovery
  Cookie, skips provider mutation, and completes the missing Core phase; changed
  completion facts conflict with the durable checkpoint.
- Production Session inspection enables Task 6 bounded activity advancement while
  preserving absolute expiry. Mutation authentication remains non-advancing so its
  released resource-version CAS semantics are unchanged.
- Email verification and reset completion use stable route/client pre-provider rate
  buckets; the email transaction has a durable five-attempt OTP bound. Contracts
  0.6 now publishes `PasswordResetCompletionRequestSchema` in source, registry,
  generated schema, current release, fixture, and compatibility coverage.

### Round 6 RED evidence

- Contracts focused/full was RED 180 total / 177 pass / 3 fail because reset
  completion was absent from source/registry/current schema. After adding the
  combined identity kind publicly, cumulative compatibility correctly stayed RED;
  the combined state was moved back behind the private Runtime boundary.
- Gateway completion focus was RED 0/2 because email verification had no dedicated
  completion bucket and reset used a route-local schema without recovery-cookie
  retry behavior. The schema-12 catalog focus was RED 0/1 for missing OAuth provider
  completion columns. Invited Apple Runtime PostgreSQL focus was RED 0/1 with
  `INVALID_REQUEST` because verified invited registration accepted password only.
- Final saga self-review added a genuine replay RED:
  `node --import tsx --test --test-name-pattern='Supabase password recovery uses' tests/supabase-auth-provider.test.ts`
  was 0/1 (`Missing expected rejection`) when changed reset facts could reuse a
  completed provider checkpoint. Schema 12 and the adapter now bind and compare the
  server-validated payload hash; the identical focused command is GREEN 1/1.

### Round 6 GREEN and integration evidence

- `npm run test:unit` — PASS after the final checkpoint binding: Runtime 192/192,
  Contracts 180/180, Runtime Core 83/83, Identity Gateway 90/90, and Web 129/129
  across 9 files.
- Contracts — PASS 180/180, generated schemas have no drift, cumulative compatibility
  passes, and fixtures are 86 valid / 11 invalid. Runtime Core package check is
  83/83; Identity Gateway package check is 90/90.
- Current schema-12 focused topology is GREEN 3/3: fresh database, schema-10 upgrade,
  and dirty recorded schema-11 reconvergence. Historical migration SHA-256 remains
  010 `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`
  and 011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended unmerged 012 is
  `9bd9e2521bac3c6e172ee170bc163d42fbecd69e7af352d9415c1e80040ef32c`.
- Production composition through real Fastify plus PostgreSQL is GREEN 1/1. It proves
  email verification to Task 3 registration and Task 6 Session, same-subject Apple
  combination with exactly one AuthSubject, new Apple B2C Web/native graphs, invited
  B2B admin/consultant graphs, invalid invitation rollback, forced SQLSTATE 40001
  retry with the provider called once, OTP attempt exhaustion, reset provider
  checkpoint plus forced Core rollback/retry/all-session revocation/transaction
  consumption, and bounded Session activity advancement.
- Installed Supabase 2.112.2 fake-fetch Apple-link callback is GREEN 1/1 with the
  password-authenticated and Apple-linked callbacks returning the same `user.id`.
  Supabase reset recovery is GREEN 4/4, including checkpoint failure/restart and
  mismatched, old, future, and malformed causal evidence rejection.
- The formal direct Runtime PostgreSQL run observed 339 total / 338 pass / 1 fail;
  the sole failure was the environment not supplying
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE`. The official protected wrapper did
  supply it and passed the required 339 Runtime Core + 1 Gateway + 14 API summaries.
  Its aggregate remained 2/3 because all 93 integration behaviors passed but the
  unchanged `agent-run.test.ts` after-hook failed its database drop (94 total / 93
  pass / 1 teardown failure); both cleanup scenarios passed.
- Root `npm run check` passes Contracts, Runtime Core, Gateway, and API 17/17, then
  stops only on the unchanged Worker `project_platform_memberships` TS2345 errors at
  `apps/control-plane-worker/src/main.ts:60,129`. Database-auth topology stops at the
  same Worker image build error before topology execution.
- `git diff --check`, accepted 0.5/010/011 history diff, exact pin check, sentinel
  secret scan, public log/output scan, and final labeled container/volume/network
  residual scans pass. Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2, and
  Contracts 0.6.0 remain exact.
- Round 6 implementation commit:
  `1799d50a612f08da97031cefcc3d3212db6bd949`.
- No merge or push was performed.

## Round 5 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. The bounded callback-rate, reauthentication ordering,
Kysely type, and fake-provider parity findings are implemented and verified. No
migration SQL, public contract, Worker, or integration-harness file changed.

### Delivered Round 5 corrections

- Apple sign-in, Apple link, and invitation Apple callbacks now consume the
  `apple_callback` bucket with exact server-owned route identifiers. Transaction
  ids, state, authorization codes, and idempotency keys cannot partition the
  primary pre-auth bucket. The existing client/IP identifier remains the second
  bucket dimension, so a different client is independently admitted.
- Reauthentication now separates pure credential/transport validation from Task 6
  Session authentication. Exact Web Cookie/CSRF or native Bearer mode validation,
  including mixed-header and Origin rejection, completes before the pre-auth rate
  operation. Correctly shaped but invalid credentials still consume the stable
  route/client bucket before authentication and provider work.
- `PublicRateLimitTable.bucket_kind` now includes the already persisted schema-12
  `apple_start` and `apple_link` values, with a source-static regression test.
- `FakeAuthProvider` now assigns email `verifiedAt` from its injected clock at the
  successful one-time OTP consumption, not at signup. Advancing-clock parity proves
  the timestamp satisfies the durable attempt window and recovery check.

### Round 5 RED and focused GREEN evidence

- `node --import tsx --test --test-name-pattern='rotating Apple|native Apple sign-in and link callbacks|Apple invitation callback rotation|reauthentication rejects changed password' apps/identity-gateway/tests/routes.test.ts`
  was RED 4 tests / 0 pass / 4 fail: rotated Web/native/link/invitation
  transactions returned 401/200 instead of stable-bucket 429, and mixed native
  traffic recorded an unwanted limiter call. The same command is GREEN 4/4 after
  the fix; rotated identifiers share one account identifier, same-client second
  requests are limited before provider/Session effects, and a different remote
  client remains independent.
- `node --import tsx --test --test-name-pattern='timestamps email verification' apps/identity-gateway/tests/fake-auth-provider.test.ts`
  was RED 0/1 because `verifiedAt` remained
  `2026-08-17T01:02:03.000Z` from signup instead of OTP consumption at
  `2026-08-17T01:03:01.000Z`. It is GREEN 1/1 after the fix, including causal
  recovery through the existing exact attempt window.
- `node --import tsx --test --test-name-pattern='public rate-limit table type' packages/runtime-core/tests/repository-static-gate.test.ts`
  was RED 0/1 because `PublicRateLimitTable` omitted both
  schema-12 Apple-start buckets. It is GREEN 1/1 after the union correction.

### Round 5 verification

- `npm run check -w @core-agent/identity-gateway` — PASS: build and 87/87.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
- `npm run check -w @core-agent/contracts` — PASS: 180/180; 85 valid and 11
  invalid fixtures plus cumulative 0.6 compatibility.
- `npm run test:unit` — PASS outside the restricted command sandbox: Runtime 192,
  Contracts 180, Runtime Core 83, Gateway 87, and Web 129 across 9 files. The first
  sandboxed attempt had only three local TCP/Unix-socket `listen EPERM` failures;
  the required unsandboxed rerun was clean.
- `npm run test:runtime:database-ci-equivalent` completed the protected Runtime
  Core PostgreSQL 339, Gateway composition 1, and API 14 phases before integration.
  All 93 integration behaviors passed, but the aggregate again ended 2/3 in
  204249.570084 ms because the unchanged `agent-run.test.ts` after-hook failed its
  database drop (94 total / 93 pass / 1 teardown failure). Both exact cleanup
  scenarios passed and the final labeled container/volume/network scan is empty.
- Root `npm run check` passes Contracts, Runtime Core 83, Gateway 87, and API 17,
  then stops on the unchanged Worker `project_platform_memberships` TS2345 pair at
  `src/main.ts:60,129`. Neither independent baseline defect was modified.
- `git diff --check`, sentinel secret scan, pin check, accepted-history diff, and
  migration residual check pass. Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2,
  and Contracts 0.6.0 remain exact. Migration 012 is unchanged from Round 4, so no
  topology rerun was necessary; SHA-256 remains
  `7545113387693ca0a944dd09033df0941333bfbbc9e8f23d3d622b84a6155bf8`.
- Round 5 implementation commit:
  `a90623fde99da4ba7fa5306ed3e0a0861b9bd175`.
- No merge or push was performed.

## Round 4 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. All three Round 4 identity findings are implemented
and verified at the HTTP, pinned provider-adapter, and real PostgreSQL boundaries.
The only remaining failures are the independently reproduced unchanged integration
database-drop teardown and Control Plane Worker compile errors described below.

### Delivered Round 4 corrections

- Native reauthentication now requires an explicit released `client_kind` and,
  after Task 6 Session authentication, compares it exactly with the stored Session
  kind. A Web Session secret cannot be replayed as native, and iphone/macos cannot
  cross modes. The check precedes actor rate limiting, recent reauthentication,
  provider password verification, and durable mutation. Web Cookie/CSRF behavior
  remains compatible when `client_kind` is omitted or explicitly `web`.
- Schema 12 now records a database-clock `provider_verification_started_at`, a
  bounded attempt lease, and a 32-byte proof HMAC. OTP verification is admitted
  durably before the provider effect. Concurrent callers with the same proof see
  `in_progress`; a different proof is rejected; after the lease, the exact proof
  may recover from the original start timestamp without repeating an unconstrained
  attempt. No verification code, provider subject, email, or provider token is
  stored in plaintext.
- General pre-verification service-role recovery was removed. The gateway first
  calls the one-use provider OTP operation. Only after that call fails may it load
  the matching durable attempt and inspect the exact service-role subject. The
  pinned Supabase adapter accepts only own-data subject/email and a strict UTC
  `email_confirmed_at` within `[provider_verification_started_at, database_now]`.
  Pre-confirmed, mismatched, old, future, and malformed facts fail closed. A
  successful verification checkpoint also enforces the same causal window.
- Apple sign-in start, Apple link start, every Apple callback, invitation Apple
  callback, and reauthentication now consume a route/client pre-auth bucket before
  Session authentication or any provider effect. Link/reauth flows consume an
  additional actor bucket only after authentication. Invalid Session/provider
  attempts therefore count while account identifiers remain server-derived.
- The current Contracts 0.6 reauthentication request adds optional
  `client_kind`; the accepted 0.5 release remains untouched. Public rate-limit
  storage adds the independent `apple_start` and `apple_link` buckets through the
  still-unmerged migration 012 and exact schema-manifest amendment.

### Round 4 RED evidence

- `node --import tsx --test --test-name-pattern='native Session transport|pre-auth route rate|Apple sign-in start|email verification (verifies|recovers|skips)' apps/identity-gateway/tests/routes.test.ts`
  — RED: 6 tests / 0 pass / 6 fail. The failures proved missing stored-mode checks,
  pre-auth rate ordering, and causally gated OTP recovery.
- `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55443/core_agent_round4 node --import tsx --test --test-name-pattern='provider verification attempt' packages/runtime-core/tests/email-verification-transactions.test.ts`
  — RED: 1/1 failed because no durable attempt admission/release API existed.
- `node --import tsx --test --test-name-pattern='caused by the durable attempt' apps/identity-gateway/tests/supabase-auth-provider.test.ts`
  — RED: 1/1 failed with `Missing expected rejection`; the adapter accepted a
  pre-existing confirmation without causal timestamp bounds.

### Focused and package GREEN evidence

- The same focused HTTP command is GREEN 6/6. Full gateway route and security
  suites are respectively 26/26 and 19/19. Ordered traces prove pre-auth rate
  consumption precedes Session/provider calls, including repeated invalid calls.
- The real PostgreSQL email-verification repository suite is GREEN 4/4, covering
  durable started/recovery state, exact proof conflict, lease concurrency,
  checkpoint causality, release, restart, and old/future rejection. Focused fresh,
  schema-10, and dirty schema-11 topology cases are GREEN 3/3.
- Pinned Supabase causal recovery is GREEN 1/1 and deterministic fake parity is
  green. Tests use a one-use OTP: forced checkpoint failure followed by restart
  performs a second failing verify call and only then recovers the exact subject;
  pre-confirmed, wrong-email, old, future, and malformed timestamps reject.
- `npm run check -w @core-agent/identity-gateway` — PASS: build and 83/83.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 82/82 unit tests.
- `npm run check -w @core-agent/contracts` — PASS: 180/180, with 85 valid and 11
  invalid fixtures and cumulative 0.6 compatibility.
- `npm run test:unit` — PASS: Runtime 192, Contracts 180, Runtime Core 82,
  Identity Gateway 83, and Web 129 across 9 files.
- Real Fastify plus production composition is GREEN 1/1. It proves Web-secret as
  iphone rejection, iphone/macos mismatch rejection, correct native and Web modes,
  no downstream provider/durable effect on mismatch, and the causal one-use OTP
  checkpoint/restart/concurrency path against PostgreSQL.

### Formal database, topology, and audit evidence

- A clean protected PostgreSQL 17 SCRAM run observed Runtime Core PostgreSQL
  `339 tests / 339 pass / 0 fail` in 154482.247833 ms. The checked count manifest
  was updated from this observed summary only.
- `npm run test:runtime:database-ci-equivalent` reached and passed its protected
  Runtime Core 339, Identity Gateway 1, and Control Plane API 14 summaries. All 93
  integration behavior subtests passed, but the wrapper ended 2/3 because the
  unchanged `agent-run.test.ts` after-hook again failed to drop its database
  (94 total / 93 pass / 1 teardown failure). This is the same independently
  repeated teardown concern recorded in Round 3, so it was not blindly rerun.
- Root `npm run check` again passes Contracts, Runtime Core, Gateway 83, and
  Control Plane API 17, then stops only on unchanged
  `apps/control-plane-worker/src/main.ts:60,129` TS2345 diagnostics for
  `project_platform_memberships`. `npm run test:runtime:database-auth-topology`
  consequently reports 0/1 before topology execution at the same Worker Docker
  build; its exact resources were cleaned.
- `npm ls fastify @fastify/cookie @supabase/supabase-js @core-agent/contracts --depth=1`
  — PASS: Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2, Contracts 0.6.0.
- Sentinel and exact protected-credential `verify-no-secret` scans, gateway logging
  residual scan, and `git diff --check` pass. Base diffs for migrations 010/011 and Contracts
  0.5 are empty. SHA-256: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended 012 `7545113387693ca0a944dd09033df0941333bfbbc9e8f23d3d622b84a6155bf8`.
- Round 4 implementation commit:
  `7834f552c2b6dac9ed9a836f96c9bef97b00b457`.
- No merge or push was performed.

## Round 3 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. All Round 3 Identity Gateway findings are fixed
and the Task 7 package, real Fastify composition, schema-12, lock-order, and
protected PostgreSQL phases pass. Two repeated, independently existing
integration-harness teardown failures prevent the aggregate official wrapper
from ending green; the same wrapper proves the complete identity PostgreSQL
counts before reaching that later integration phase.

### Delivered Round 3 corrections

- `/auth/v1/reauthenticate` now accepts either exact Web cookie/CSRF transport or
  exact native bearer Core Session transport. Native rejects Origin/cookies and
  Web/native cross-mode sessions. Password verification remains provider-side;
  the durable reauthentication command keeps expected-version CAS, canonical
  payload binding, idempotency, database time, and Task 6 caller-owned locking.
  Real Fastify/PostgreSQL covers both iPhone and macOS reauthentication followed
  by native Apple-link start with no cookie output.
- Schema 12 now stores encrypted/HMAC-bound expected provider subject and a
  separate encrypted verified-subject checkpoint. Provider OTP verification is
  one-use. A retry after domain rollback reads the checkpoint without a second
  provider verification; a crash after provider verification but before the
  checkpoint recovers only the exact confirmed expected subject through the
  service-role inspection port, then checkpoints before domain composition.
- Email verification, invitation acceptance, and reauthentication validate a
  server-computed canonical hash over the released request facts before any
  provider or durable effect. Password/code/proof changes under an old caller
  hash fail closed. Sensitive values are represented only by the released hash
  or one-way digest in durable commands.
- Email first-start admission now uses `INSERT ... ON CONFLICT DO NOTHING` then
  locks and classifies the exact row. Deterministic real PostgreSQL concurrency
  proves one reservation, one provider call, one row, bounded in-progress/replay,
  and no exposed `23505`.
- The canonical invitation lock order is Actor -> Tenant -> Invitation for an
  existing Actor and Tenant -> Invitation -> verification for unauthenticated
  onboarding. Production acceptance no longer prelocks Invitation before Task 4.
  Real barriers cover start-vs-complete, Fastify accept-vs-revoke, and runtime
  accept-vs-revoke/replace without deadlock or partial graph. `replaceInvitation`
  now honors the caller-owned transaction and rolls back with its caller.
- The standalone unsafe invited-registration export is absent. The remaining
  named helper requires the exact runtime-verified invitation id, Tenant, digest,
  version, and role and rechecks active B2B authority before any identity write.
  Direct bypass rolls back in real PostgreSQL.
- Invitation registration preflights active B2B Tenant plus exact pending
  invitation/email authority before provider signup or schema-12 admission.
  Closed/B2C Tenant tests prove zero provider calls and zero transaction rows.
- Enumeration coverage now warms each route and uses distinct delayed account,
  invitation, and Tenant lookup failures rather than one immediate shared stub;
  all map to the same bounded public class.

### Round 3 RED evidence

- `node --import tsx --test --test-name-pattern='changed code|native bearer|changed password|changed proof facts' apps/identity-gateway/tests/routes.test.ts`
  — RED 0/4: changed email code, native reauthentication, changed password, and
  changed invitation proof were not all enforced before provider/authority work.
- Focused fake-provider email recovery was RED 0/1 because signup returned no
  expected provider subject. Focused Supabase recovery was RED 0/2 because the
  adapter had no exact service-role recovery path and accepted no expected-subject
  binding.
- `packages/runtime-core/tests/email-verification-transactions.test.ts` concurrent
  first-start focus was RED 0/1: one reservation plus seven raw PostgreSQL `23505`
  failures exposed the select-then-insert race.
- The invited-registration export/direct-bypass focus was RED before the unsafe
  root export was removed and exact verified-invitation dependency was required.
- Caller-owned replacement RED was 0/1: an outer rollback left the old invitation
  `replaced` and committed its replacement, proving `replaceInvitation` ignored
  the caller transaction.
- The final real Fastify/PostgreSQL existing-accept lock-order barrier was RED
  0/1: an admin revoke timed out while acceptance held Invitation and waited for
  the externally locked Actor. Removing the server prelock made the same barrier
  green while retaining the public one-time Session replay conflict.

### Round 3 focused and real-boundary GREEN evidence

- Route canonical/native focus: 4/4. Email verification focus: 5/5.
  Deterministic fake recovery: 1/1. Supabase exact-subject recovery: 2/2.
- `packages/runtime-core/tests/email-verification-transactions.test.ts` — 3/3
  against disposable PostgreSQL, including restart, expiry, verified checkpoint,
  exact one-time consumption, and concurrent first admission.
- Invited-registration export/bypass PostgreSQL focus — 1/1. Invitation
  caller-owned rollback and accept-vs-revoke/replace barriers — 2/2.
- `apps/identity-gateway/tests/postgres/production-composition.test.ts` — 1/1.
  The real Fastify + production composition covers native reauth/link, one-use OTP
  recovery and checkpoint retry, active-B2B preflight, concurrent first starts,
  B2B onboarding, invalid/replay matrices, start-vs-complete, existing
  accept-vs-revoke, protected Task 4 mutation, and one-time Session settlement.
- Trust-only full Runtime Core PostgreSQL observed 338 total / 337 pass / 1
  protected-role-bootstrap assertion because
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE` was intentionally absent. Both
  protected official runs passed Runtime Core PostgreSQL 338, Identity Gateway
  PostgreSQL 1, and Control Plane API PostgreSQL 14 before later integration
  teardown. This includes fresh -> 12, schema 10 -> 12, schema 11 -> 12,
  dirty-schema-11 reconvergence, exact ACL/catalog/rollback, restart, replay,
  expiry, and concurrency.

### Final Round 3 verification

- `npm run check -w @core-agent/contracts` — PASS 180/180; 85 valid and 11
  invalid fixtures; Contracts 0.6.0 current release is compatible.
- `npm run check -w @core-agent/runtime-core` — PASS build and 82/82.
- `npm run check -w @core-agent/identity-gateway` — PASS build and 79/79.
- `npm run test:unit` with local socket permission — PASS: Runtime 192/192,
  Contracts 180/180, Runtime Core 82/82, Identity Gateway 79/79, Web 129/129 in
  9 files.
- `npm run compat:history -w @core-agent/contracts -- --base e7624fe0425ff470b646f8322254d5e9e3857da8`
  — PASS; accepted 0.5.0 is byte-untouched.
- Official `npm run test:runtime:database-ci-equivalent` was run twice from fresh
  disposable state. Run 1: 2/3 in 228012.898541 ms; all 93 integration behavior
  tests passed but unchanged `agent-run.test.ts` after-hook database drop failed.
  Run 2: 2/3 in 208763.848542 ms; the same drop failure repeated and unchanged
  `harness-cleanup.test.ts` force-termination cleanup also failed. On both runs,
  the complete protected identity PostgreSQL counts above passed and injected
  failure/output-leak cleanup scenarios passed. No third blind retry was made.
- Root `npm run check` passes Contracts, Runtime Core, Identity Gateway, and
  Control Plane API 17/17, then stops only at untouched Worker
  `src/main.ts:60,129` TS2345 `project_platform_memberships` dispatcher errors.
  `npm run test:runtime:database-auth-topology` is consequently 0/1 at that same
  Worker Docker build before topology execution. These files have no Task 7 diff.
- Exact pins: Fastify 5.11.2, `@fastify/cookie` 11.1.2, Supabase JS 2.112.2,
  Contracts 0.6.0. `verify-no-secret`, `git diff --check`, gateway log-call scan,
  protected historical-file diff, and Docker/filesystem residual scans pass.
  All official and local disposable containers, volumes, networks, and temporary
  credential directories are absent.
- SHA-256: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended 012 `734a609cd7fb0eee84727820fc562b791ea48bba2fcad0494396bd33f8aaeb45`.
- Round 3 implementation commit:
  `3a5631da34d28be247a69639c01255c04a03e54a`.
  No merge or push was performed.

## Delivered

- Added the Fastify 5.11.2 public Identity Gateway and all approved `/auth/v1`
  email, password-reset, Apple, Session, invitation, company/member, and account
  route families.
- Added strict configuration admission, loopback/container bind policy, exact
  Host/Origin/redirect validation, JSON-only 64 KiB mutations, duplicate sensitive
  header rejection, feature-flag admission, no-CORS defaults, and calm closed errors.
- Added host-only Core Session and CSRF Cookies, exact CSRF matching, separate
  purpose-bound AES-256-GCM recovery and Apple-flow Cookies, and Web/native
  credential and response separation.
- Added response-contract serialization and explicit Apple response allowlists so
  provider, Cookie, key, database, and arbitrary operation fields cannot cross the
  public boundary. Passwords and provider proofs are removed before durable commands.
- Added the `executeProtectedAuthorityCommand` boundary. Management mutations use
  only server-derived Session authority and delegate recent-reauthentication recheck
  plus the final durable mutation to one caller-owned transaction. Apple/provider
  work completes outside that transaction; the link callback then rechecks authority
  through the protected command before its durable link mutation.
- Published additive Contracts 0.6.0 with the closed
  `AppleIdentityLinkStartRequest`, one new current schema, one valid fixture, and an
  immutable complete 85-schema 0.6.0 release. Historical 0.5.0 is unchanged.
- Kept `@supabase/supabase-js` exactly 2.112.2 and added exact Fastify 5.11.2 and
  `@fastify/cookie` 11.1.2 pins. All workspace Contracts consumers now pin 0.6.0.

## TDD evidence

Production implementation began only after genuine injected HTTP RED:

- `npm test -w @core-agent/identity-gateway -- --test-name-pattern='security|cookie|origin|csrf|enumeration'`
  — 43 tests, 29 passed, 14 failed. New real Fastify-inject cases observed 404/500
  instead of the required security outcomes.
- `node --import tsx --test --test-name-pattern='Apple link start contains' packages/contracts/tests/public-auth.test.ts`
  — 1 test, 0 passed, 1 failed because the contract was absent.
- Focused first GREEN after implementation — 43/43.

Additional red/green increments:

- Native Apple link start: 43 passed / 1 failed (400 instead of 200), then GREEN.
- Dynamic recovery redirect config: 44 passed / 1 failed, then GREEN.
- Callback validation Cookie clearing: 45 passed / 1 failed, then GREEN.
- Web Apple output shape and provider-origin authorization URL each failed before
  allowlisted response and origin enforcement, then GREEN.
- Protected management delegation: 48 tests, 47 passed / 1 failed because the route
  called a separate reauth guard plus ordinary command; it now calls exactly one
  protected transaction-scoped operation.
- HTTP enumeration boundary: 49 tests, 48 passed / 1 failed while an invalid test
  field produced 400; a contract-valid request proved account/invitation/Tenant
  unknowns share 401, one body shape, and one bounded timing class.
- Closed success serialization: 50 tests, 49 passed / 1 failed after injected
  `provider_token` and `database_detail` escaped; response schemas now strip both.
- Native adapter allowlist: 51 tests, 50 passed / 1 failed after injected provider
  data escaped; Apple start now copies only three approved fields.
- Durable command credential isolation: 52 tests, 51 passed / 1 failed because the
  password entered the reauthentication command; passwords and provider proofs are
  now removed before durable calls. Final GREEN is 52/52.

## Verification evidence

- `npm run check -w @core-agent/contracts` — PASS: 180/180 tests; 85 valid and 11
  invalid fixtures; generated-schema drift and cumulative compatibility checks pass.
- Pre-accept `npm run compat:check -w @core-agent/contracts` — PASS. Official accept
  tool reported `Accepted 85 v1 compatibility schemas for release 0.6.0`.
- `npm run check -w @core-agent/identity-gateway` — PASS: build plus 52/52 tests.
- `npm test -w @core-agent/identity-gateway -- --test-name-pattern='security|enumeration|cookie|origin|csrf'`
  — PASS: 52/52. The existing npm script places the pattern after the test glob, so
  Node executed the complete gateway suite; the count is the observed summary.
- `npm run test:unit` — first sandboxed run reached 189/192 runtime tests and failed
  only because local TCP/Unix socket listen returned EPERM. The authorized unchanged
  rerun passed: runtime 192/192, Contracts 180/180, Runtime Core 81/81, Identity
  Gateway 51/51 at that checkpoint, and Web 129/129.
- `npm run test:runtime:database-ci-equivalent` — PASS: 3/3 official disposable
  scenarios. Its fresh PostgreSQL execution asserted Runtime Core PostgreSQL 327,
  Control Plane API PostgreSQL 14, and integration 93, including the Task 6 external
  provider-outside-retry and transaction-scoped guard markers. Injected failure and
  output-leak cleanup scenarios also passed; exact Docker resources were removed.
- `npm ls fastify @fastify/cookie @supabase/supabase-js @core-agent/contracts --depth=1`
  — PASS: Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2, Contracts 0.6.0.
- `npm run compat:history -w @core-agent/contracts -- --base e7624fe0425ff470b646f8322254d5e9e3857da8`
  — PASS after commit: compatibility history check passed.
- `node scripts/verify-no-secret.mjs identity-auth-private-sentinel ...` — PASS.
- `git diff --check` — PASS.
- Historical release/migration residual scan — PASS: no changes under Contracts
  0.5.0 or migrations 010/011.

## Files

- Gateway production: `src/app.ts`, `config.ts`, `security.ts`, `errors.ts`,
  `server.ts`, six focused route modules, and the Node 26 `TransferListItem` type
  compatibility declaration.
- Gateway tests: `security.test.ts`, `routes.test.ts`, `errors.test.ts`.
- Contracts: public-auth source/registry/version metadata, generated current schema,
  valid fixture, schema inventory/count tests, changelog, compatibility declaration,
  and immutable 0.6.0 release.
- Dependency metadata: Identity Gateway and all workspace Contracts consumers plus
  `package-lock.json`.

## Self-review and constraints

- Production files remain focused; the largest production file is `security.ts` at
  217 lines. The larger 398-line security test is table-like boundary coverage.
- No Task 7 migration was added. No historical migration or accepted release was
  modified. No external provider effect occurs within the protected database port.
- Database behavior is intentionally not mocked in Task 7: the gateway is a pure HTTP
  orchestration boundary, while the official disposable PostgreSQL suite proves the
  Task 6 caller-owned transaction behavior consumed by its protected port.
- The provider/live Supabase acceptance remains Task 12 and was not attempted.
- `npm install --package-lock-only --ignore-scripts` reported one high advisory in the
  resolved tree. A follow-up read-only `npm audit --omit=dev` could not be completed:
  sandbox DNS failed and escalation was rejected because it would send the private
  workspace dependency inventory externally. No audit fix or pinned-version change
  was attempted.

## Review-fix feasibility checkpoint (2026-08-17)

Status: `NEEDS_CONTEXT`. No review-fix production or test file was changed, and no
review-fix commit was created.

The critical email-verification finding cannot be implemented with the approved
durability semantics while also honoring the explicit Task 7 prohibition on a new
migration:

- The public sign-up request carries `idempotency_key`, email, requested
  `client_kind`, and optional `device_label`; verification later carries only the
  opaque `verification_id`, `verification_code`, and a second idempotency identity.
  A durable binding is therefore required to recover and authenticate the requested
  delivery mode/device and to make repeated provider starts converge.
- `oauth_transactions` is the only existing pre-Actor transaction state, but
  migration 011 and the Kysely type close `flow_kind` to `apple_sign_in`,
  `apple_link`, and `password_reset`. Storing an email-verification flow there would
  fail the database constraint and expanding it requires migration 012.
- `idempotency_records` cannot safely stand in for that binding: every row requires
  a `tenant_id` foreign key to an existing Tenant. At sign-up start the B2C Actor and
  Tenant deliberately do not exist; Task 3 creates them atomically only after a
  verified provider subject.
- A process-memory map would lose verification and idempotency authority on restart.
  A self-sealed `verification_id` could be bounded but would not durably suppress a
  repeated sign-up provider/email effect and would silently weaken the approved
  replay semantics. Reusing another flow kind or pre-creating a Tenant would violate
  the closed schema/domain invariants.
- The pinned local Auth JS 2.112.2 surface does provide
  `verifyOtp({ token_hash, type: "email" })`, so provider verification itself is not
  the blocker. The missing piece is the durable pre-registration binding and global
  start-idempotency authority.

The needed architecture decision is one of:

1. authorize a new forward-only migration and planned runtime-core store for pending
   email-verification/idempotency bindings (preferred); or
2. explicitly approve bounded self-sealed verification bindings and the resulting
   non-durable sign-up-start idempotency/restart tradeoff, with an amended design.

Because the review instruction explicitly says to stop as `NEEDS_CONTEXT` when the
approved schema cannot persist this binding without a migration, no RED test was
added: doing so would leave an intentionally failing tracked suite while the required
data-model authority is unresolved. All prior Task 7 verification evidence above
remains the last executed test evidence.

## User-approved review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. The user approved option 1: forward-only schema 12
for durable pre-registration email-verification/start-idempotency authority. The
only concern is an independently reproducible pre-existing Control Plane Worker
compile failure described below; all Task 7 package, root unit, real PostgreSQL,
and official fresh CI-equivalent gates pass.

### Delivered review corrections

- Added `012_email_verification_transactions.sql` and the runtime repository. The
  dedicated table stores a unique start idempotency key, payload hash, normalized
  email HMAC, bounded encrypted email/client/device binding, optional verified
  provider-subject HMAC, pending/consumed/expired state, and database-clock
  timestamps. It stores no plaintext email/password/code, provider token, or
  Session secret. Identity application role ACL is limited to select/insert/update;
  public and application roles remain denied. Schema manifest/catalog/type coverage
  is exact. Migration 010/011 are byte-identical to the base.
- Added restart-safe replay/payload-conflict, expiry, one-time consumption, and
  concurrent-callback repository behavior. Email sign-up reserves 012 before the
  provider effect; verification calls pinned Supabase Auth JS
  `verifyOtp({ token_hash, type: "email" })`, then atomically consumes 012 and calls
  Task 3 `registerB2c` in one caller-owned transaction. Task 6 Session issuance
  follows only after commit and uses its own durable idempotency admission.
- Invitation email registration now uses the same durable email-start reservation,
  so replay does not send another provider verification effect. Account rate-limit
  identifiers and provider email inputs use the same normalized value.
- Added durable OAuth provider-start reservation/finalization using the existing
  `oauth_transactions` encrypted column and exact database store. Apple sign-in,
  Apple link, and password-reset starts reserve before their provider effect;
  sequential replay returns the same bounded start, changed payload conflicts, and
  a concurrent duplicate performs no second provider effect. An incomplete
  reservation fails closed rather than retrying an uncertain external effect.
- Added a usable zero-argument production composition and executable entrypoint.
  It loads owner-only managed secrets, verifies schema 12, creates PostgreSQL and
  pinned Supabase clients, owns lifecycle cleanup, and concretely wires rate limits,
  Task 3 registration, Task 4 company/invitation/member operations, Task 6 Session
  issue/authentication/revocation/reauthentication, private email loading, and Apple
  identity linking. Only Task 9 account deletion is explicitly unavailable.
- Protected durable operations re-run Task 6 recent-reauth authority and their final
  mutation in the same caller-owned transaction. Provider effects remain outside
  automatically retried database transactions. Production password-reset completion
  derives the Actor from the verified provider subject and revokes all Core Sessions.
- Session inspection now returns only the requested current authenticated Session;
  another Session id is a calm `RESOURCE_NOT_FOUND`. Session delivery requires the
  issued client kind to equal the validated request kind for email and invitation
  flows. Invitation device labels are preserved into Session issuance.
- Duplicate sensitive Cookie names are rejected before Fastify Cookie parsing.
  Native callback failures emit no Cookie. Web Apple invitation acceptance rebuilds
  all callback authority from the purpose-bound Apple-flow Cookie at Path
  `/auth/v1`, clears it on every terminal path, and never trusts body authority.
- Added missing `reauthenticate` and `apple_callback` rate buckets, strict UTC/finite
  flow expiry parsing, exact provider `/auth/v1/authorize` redirect validation, and
  exact native Apple `https://appleid.apple.com/auth/authorize` validation bound to
  the configured provider callback. Supabase Web/native authorization URLs now
  carry the exact callback state used by the durable transaction.
- Contracts remain additive compatible 0.6.0; accepted 0.5.0 is untouched. The
  Entitlement schema reservation and all plan references moved from 012 to 013.

### Review-fix TDD evidence

Production changes followed genuine focused REDs:

- Initial HTTP review RED: route/security focus had 18 pass / 12 fail, covering
  wrong-mode Session delivery, email verification, Apple Cookie authority/path,
  duplicate Cookies, rate buckets, native failure Cookies, strict expiry, exact
  authorization URL, and missing route behavior. Focused GREEN was complete before
  package verification.
- Initial provider RED: 0/2 new email-signup/verification adapter cases. GREEN proves
  exact configured verification redirect and token-hash-only verification.
- Initial schema/repository RED: real PostgreSQL email-verification suite 0/1 before
  migration/repository implementation. Focused migration+email GREEN: 126/126.
- Initial composition/service REDs: production composition 0/1 and transaction-aware
  runtime service 0/1. The final real PostgreSQL production composition is 1/1.
- Session inspect real PostgreSQL RED: 0/1, `Missing expected rejection`; GREEN 1/1
  after exact current-Session matching.
- Password-reset revocation real PostgreSQL RED: 0/1, stored Session remained
  `active` instead of `revoked`; GREEN 1/1 after Task 6 revocation wiring.
- Invitation-registration provider-start RED: focused route 0/1; actual calls were
  provider+no-op twice instead of reserve/provider once. GREEN 1/1 after 012 start
  reservation and removal of the no-op command.
- Account normalization RED: focused route 0/2 because uppercase provider email
  differed from the normalized rate identifier. GREEN 2/2.
- Provider-start idempotency RED: build failed at the two new structured reset-start
  calls because the adapter accepted only a raw email. GREEN 1/1 proves Apple
  sign-in/link and reset sequential replay, payload conflict, and concurrent one
  effect behavior.
- Native Apple exact-endpoint HTTP RED: 0/1 with 503 for the valid direct Apple link
  endpoint; GREEN 1/1 plus unsafe path, callback, and `next` variants rejected.
- Additional focused RED/GREEN increments covered executable entrypoint, explicit
  Task 9 marker, exact email redirect origin, four idempotency propagation cases,
  duplicate Session prevention, Apple-link changed-subject conflict, platform
  projection rejection for company member listing, migration dirty-state cleanup,
  and formal root PostgreSQL count wiring.

### Final verification

- `npm run check -w @core-agent/contracts` — PASS: 180/180; 85 valid and 11
  invalid fixtures; schemas and cumulative 0.6.0 compatibility pass.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 81/81 unit tests.
- `npm run check -w @core-agent/identity-gateway` — PASS: build and 69/69 tests.
- `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55432/core_agent_runtime npm run test:postgres -w @core-agent/identity-gateway`
  — PASS: 1/1 real PostgreSQL production composition. It proves 012 consume plus
  Task 3 registration, Task 6 issuance/authentication/idempotency/revocation,
  production OAuth start reservation, server-derived Task 4 company creation,
  invitation creation/acceptance, company-only list authority, and member revoke.
- Focused real PostgreSQL migration/email run — PASS: 126/126, including empty to
  12, schema 10 to 12, schema 11 to 12, dirty rollback/retry, schema catalog/ACL,
  restart, expiry, replay/conflict, and concurrency.
- Full trust-only Runtime Core PostgreSQL run observed 328 total / 327 pass; its
  sole failure was the deliberately protected database-role bootstrap case because
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE` was absent. The official protected
  run below passed all 328.
- `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180, Runtime Core
  81/81, Identity Gateway 69/69, Control Plane Web 129/129 across 9 files.
- Final `npm run test:runtime:database-ci-equivalent` — PASS: 3/3 in
  125176.372167 ms. Its fresh official PostgreSQL run asserted Runtime Core 328,
  Identity Gateway 1, Control Plane API 14, and integration 93; injected-failure
  cleanup and output-leak redaction also passed with exact Docker cleanup.
- `npm ls fastify @fastify/cookie @supabase/supabase-js @core-agent/contracts --depth=1`
  — PASS: Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2, Contracts 0.6.0.
- `node scripts/verify-no-secret.mjs identity-auth-private-sentinel` — PASS.
- `git diff --check` — PASS. Public output/log residual scan found no provider,
  Cookie, key, database, raw proof, or internal-body leakage.
- Migration SHA-256: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  new 012 `23489ce458dba6209e8047c16060e032db9bb5cf090a2b2a05a03a165538dfb2`.
  Base diff for 010/011 and accepted Contracts 0.5.0 is empty; Entitlement stale-012
  reservation scan is empty.

### Independent baseline concern

- Root `npm run check` reaches and passes Contracts 180/180 plus fixtures 85/11,
  Runtime Core 81/81, Identity Gateway 69/69, and Control Plane API 17/17, then
  fails in untouched `apps/control-plane-worker/src/main.ts:60,129`. Its dispatcher
  accepts only `dispatch_outbox | provision_runtime`, while the shared `ClaimedJob`
  type also contains `project_platform_memberships` (two TS2345 diagnostics).
- `npm run test:runtime:database-auth-topology` consequently reports 0/1 before
  topology execution because the same untouched Worker Docker build fails. The
  final failed run left zero labeled containers, volumes, or networks. This exact
  failure reproduces with the standalone Worker build and no Task 7 diff touches
  the Worker. It was not expanded into this identity task.
- Live provider credentials remain Task 12 and were not used. All provider behavior
  here is the pinned offline SDK boundary plus deterministic adapter parity.

- Review-fix implementation commit: `00937575b9e0caa310526567bccd4bd281173f65`
- No merge or push was performed.

## Round 2 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. Every Round 2 identity finding is implemented and
verified. The remaining concern is still the untouched Control Plane Worker
dispatcher compile error; it prevents the repository-wide `check` tail and the
auth-topology wrapper from starting, but does not affect the passing official
database CI-equivalent gate.

### Delivered Round 2 corrections

- Invitation registration now resolves the exact pending invitation before any
  provider call and durably seals its id, Tenant, role, resource version, and
  SHA-256 secret digest into the schema-12 binding. The row contains no plaintext
  invitation secret or email. A verified invitee is created by the new
  caller-owned `registerInvitedIdentity` service as Actor + AuthSubject + private
  PII only; it creates no self Tenant, Membership, or Profile. `acceptInvitation`
  then creates only the invitation-authorized B2B Membership/Profile in the same
  transaction as schema-12 consumption, invited registration, and Session issue.
- Email verification start now has explicit `reserved`, `finalized`, and `failed`
  provider-start states plus bounded attempts. Reservation commits before the
  provider effect. A definite provider rejection marks the row failed and permits
  one controlled retry; unavailable/unknown finalization remains reserved and
  fails closed so the provider effect is not repeated. Expired start replays and
  consumes commit `expired` before returning a stable public failure.
- The gateway and repository compute canonical start hashes from normalized
  email, request client kind, device label, flow kind, and invitation digest.
  Caller hashes are compared to the server result using constant-time byte
  comparison and temporary buffers are cleared. The Apple/password-reset provider
  starts likewise compute their canonical hashes from the actual flow facts.
- Email verification loads the durable client kind and exact binding before
  calling `verifyOtp`. A wrong Web/native transport performs zero provider effect,
  does not consume schema 12, and remains retryable with the correct transport.
- Public invitation acceptance uses deterministic server-derived subkeys for the
  acceptance and Session stages. Both stages are in one transaction: the first
  request returns the one-time Session secret; replay returns calm
  `IDEMPOTENCY_CONFLICT`, persists no raw secret, and creates no additional Session.
  The Session subkey payload includes the bound client kind and device label.
- Reauthentication and protected Session revocation now validate the released
  canonical payload hash, expected resource version, and durable idempotency
  record. Each uses database clock and row locks inside one caller-owned
  transaction; the Task 6 recent-reauth guard and final revocation remain in that
  same transaction. Replay returns the stored safe view, changed payload and stale
  versions conflict, and concurrent requests settle once.
- Company creation and company invitation creation now turn replay of a
  previously delivered one-time secret into a calm conflict rather than
  serializing `undefined` into a 500 response. No invitation or Session secret is
  persisted for replay.
- Invited registration maps only the two exact identity unique constraints to a
  public conflict. Error classification reads own data descriptors only, never
  invokes accessors/prototype traps, and rethrows unrelated database errors.
- Contracts 0.6.0 add `verification_id` to the current invitation registration
  response and its current 0.6 release artifact. Contracts 0.5.0 and migrations
  010/011 remain byte-identical.

### Round 2 RED evidence

The production edits followed focused failing tests:

- `npm run test -w @core-agent/contracts` — RED: 179/180, because invitation
  registration did not publish the durable `verification_id`.
- `node --import tsx --test apps/identity-gateway/tests/*.test.ts` — initial Round
  2 RED: 66/70. The four failures proved missing reservation/finalization,
  invitation binding, pre-provider cross-mode validation, and unsafe one-time
  replay behavior.
- `node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/email-verification-transactions.test.ts`
  — schema-12 state-machine RED: 0/2 for the old start semantics; later caller-owned
  expiry RED was 1/2 because throwing inside the outer transaction rolled the
  `expired` transition back.
- The new invited-identity registration focus was RED 0/1 before the service
  existed. Caller-owned invitation acceptance initially rolled back the composed
  graph, and exact bound-digest mismatch was not rejected.
- Route-focused one-time replay RED had two failures: company/invitation creation
  replays reached 500 through missing required secrets. Invitation acceptance
  initially reused the public key for both operations and could not complete the
  first accept + Session transaction.
- Reauthentication/Session-revoke focuses were RED for missing caller-owned
  reauthentication export, stale-version acceptance, replay version drift, and a
  Session authentication version of 2 where the released expected version was 1.
- Provider-start forged-payload RED showed that the same supplied hash with changed
  normalized input was accepted; the unknown-finalization focus was 0/1 because a
  retry repeated the provider effect instead of returning a bounded conflict.
- `node --import tsx --test --test-name-pattern='invited registration applies' packages/runtime-core/tests/register-b2c-collision.test.ts`
  — final self-review RED: 0/1 at module load because the invited service did not
  expose or implement bounded accessor-safe collision classification. The same
  exact command is GREEN 1/1 after the fix.

### Round 2 real-boundary evidence

- `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55439/core_agent_runtime npm run test:postgres -w @core-agent/identity-gateway`
  — PASS 1/1. Real Fastify plus production composition proves B2B invited admin
  and consultant onboarding, exact Membership/Profile/session results, no self
  graph, company/invitation one-time-secret replay, Task 6 protected mutation,
  expired schema-12 convergence, replay, and concurrent single settlement.
- The same production-composition suite proves the invalid matrix: wrong or
  replaced secret, revoked/expired invitation, email mismatch, changed payload,
  late binding drift after a valid start, replay, and concurrent verification all
  leave zero partial identity graph and at most one Session/provider settlement.
- Full trust-only Runtime Core PostgreSQL was observed at 336 total / 335 pass / 1
  expected protected-role-bootstrap failure because
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE` was intentionally absent. The
  official protected run below asserts all 336, including empty -> 12, schema 10
  -> 12, schema 11 -> 12, dirty schema-11 reconvergence, ACL/catalog/rollback,
  restart, expiry, replay/conflict, and concurrency.

### Final Round 2 verification

- `npm run check -w @core-agent/contracts` — PASS: 180/180; schemas, cumulative
  0.6 compatibility, 85 valid fixtures, and 11 invalid fixtures.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 82/82.
- `npm run check -w @core-agent/identity-gateway` — PASS: build and 72/72.
- `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180, Runtime Core
  82/82, Identity Gateway 72/72, and Web 129/129 across 9 files.
- `npm run test:runtime:database-ci-equivalent` — PASS: 3/3 in
  125249.099542 ms. The fresh protected run asserted Runtime Core PostgreSQL 336,
  Identity Gateway PostgreSQL 1, Control Plane API PostgreSQL 14, and integration
  93; injected-failure cleanup and output-leak redaction also passed.
- `npm run compat:history -w @core-agent/contracts -- --base e7624fe0425ff470b646f8322254d5e9e3857da8`
  — PASS. Accepted 0.5.0 was not modified.
- `npm ls fastify @fastify/cookie @supabase/supabase-js @core-agent/contracts --depth=1`
  — PASS: Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2, Contracts 0.6.0.
- `node scripts/verify-no-secret.mjs identity-auth-private-sentinel` and
  `git diff --check` — PASS. Gateway production source has no console/request/reply
  logging calls; public contracts retain their credential/PII forbidden-name gate.
- Official-CI residual checks found zero labeled containers, volumes, or networks.
  Base diffs for migrations 010/011 and Contracts 0.5.0 are empty.
- SHA-256: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended 012 `ebb81c2f6de869228e6b6e16bc92f055412d28441217b8eb51266c46c496d6b2`.

### Remaining independent concern and commit

- Root `npm run check` again passes Task 7 packages and Control Plane API 17/17,
  then fails only at untouched `apps/control-plane-worker/src/main.ts:60,129`
  with the same two TS2345 `project_platform_memberships` dispatcher diagnostics.
  Standalone Worker build exits 1 with the same output, and its diff from the Task
  7 base is empty.
- `npm run test:runtime:database-auth-topology` remains 0/1 because that same
  Worker Docker build fails before topology execution; its failed run cleaned all
  exact resources. The passing official database CI-equivalent is the formal Task
  7 database gate.
- Round 2 implementation commit:
  `d92335a9f` (`fix(identity): close gateway review findings`).
- No merge or push was performed.
