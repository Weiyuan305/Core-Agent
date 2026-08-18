# Task 7 Report — Public Identity Gateway

## Status

- Status: DONE
- Branch: `feat/identity-gateway-v1`
- Base: `e7624fe0425ff470b646f8322254d5e9e3857da8`
- Implementation commit: `2240a1bb0645e50a22204783f7cac5362924d906`
- No merge or push was performed.

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
