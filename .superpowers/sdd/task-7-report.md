# Task 7 Report — Public Identity Gateway

## Status

- Status: DONE_WITH_CONCERNS
- Branch: `feat/identity-gateway-v1`
- Base: `e7624fe0425ff470b646f8322254d5e9e3857da8`
- Original implementation commit: `2240a1bb0645e50a22204783f7cac5362924d906`
- No merge or push was performed.

## Round 21 review fix (2026-08-19)

### Outcome and boundary

- Native Apple linking no longer applies a separate JavaScript UTF-16
  `state.length` check to the state returned by the installed Supabase identity
  authorization endpoint. It uses the same provider-neutral OAuth proof validator
  as Gateway callbacks and Round 20 provider inputs: exactly 8..4,096 Unicode code
  points and at most 16,384 UTF-8 bytes.
- This is link-specific: the state comes from the pinned Supabase
  `/auth/v1/user/identities/authorize` response, is hashed into the durable OAuth
  transaction, and must match the later native callback. The exact-single-state
  query requirement remains. S256 challenge generation/request placement and
  callback verifier comparison are unchanged.
- The installed Supabase 2.112.2 fake-fetch path now exercises provider states of
  7, 8, 4,096 emoji, and 4,097 emoji. The accepted paths use 44- and 128-character
  RFC 7636 verifiers and complete the link, while every provider authorization
  request still carries the exact derived challenge and `S256`, carries no caller
  state, and uses the operation-local password Session.
- The required official Supabase Auth/breaking-change changelog scan found no
  change relevant to this local response-parser boundary. No SDK API, public
  contract, migration, package, or provider-effect ordering changed.

### Strict RED then GREEN

- RED command:
  `node --import tsx --test --test-name-pattern='installed Supabase 2.112.2 native Apple link validates provider state' apps/identity-gateway/tests/supabase-auth-provider.test.ts`
  — exact result 1 total / 0 pass / 1 fail. The 7-code-point provider state was
  incorrectly accepted, producing `Missing expected rejection`.
- After replacing only the local length predicate with `isOAuthProofString`, the
  same command is GREEN 1/1. It rejects 7 and 4,097, accepts 8 and 4,096 emoji,
  completes both 44/128-verifier callbacks, and observes the exact S256 provider
  requests.

### Verification, scans, and self-review

- `npm run check -w @core-agent/identity-gateway` — PASS: build and 124/124.
- Protected `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180,
  Runtime Core 83/83, Gateway 124/124, and Web 129/129 across nine files.
- Official `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  154,339.200542 ms. Its protected manifest asserted Runtime Core PostgreSQL 344,
  Gateway PostgreSQL 2, API PostgreSQL 14, and integration 93; failure injection,
  output-leak rejection, and cleanup passed. Exact label scans found zero Docker
  containers, volumes, and networks afterward.
- Exact pins remain Fastify 5.11.2, Cookie 11.1.2, Supabase JS/Auth JS 2.112.2,
  and Contracts 0.6.0. `git diff --check`, sentinel scan, production log-call scan,
  and residual diffs for Contracts, migrations, packages, and lockfiles are empty.
- Self-review confirms the provider response is validated after the provider call
  but before durable start completion/response, rejected provider states map to
  the calm provider-unavailable boundary, and no state, credential, token, or
  provider body is logged. The known untouched Worker TS2345 concern remains.

### Files and commit

- Production: `apps/identity-gateway/src/providers/supabase-auth-provider.ts`.
- Test: `apps/identity-gateway/tests/supabase-auth-provider.test.ts` using the
  installed exact SDK and fake HTTP boundary.
- Round 21 implementation commit: `67dbda57c`
  (`fix(identity): validate native link provider state`). No merge or push occurred.

## Round 20 review fix (2026-08-19)

### Outcome and boundary

- Supabase and deterministic Fake Apple parsing now share one provider-neutral
  proof validator with the Gateway. OAuth authorization code, state, and native
  nonce accept exactly 8..4,096 Unicode code points, bounded to 16,384 UTF-8
  bytes; this no longer mistakes one emoji for two characters.
- Native `pkce_code_verifier` now implements the RFC 7636 unreserved alphabet
  `[A-Za-z0-9._~-]` at exactly 43..128 ASCII characters. The start-side S256
  `pkce_code_challenge` remains an exact 43-character base64url value. Tests derive
  the challenge from each verifier and prove the stored challenge comparison, so
  widening parser length cannot bypass PKCE binding.
- The same helper is used by the direct invitation canonical-payload preflight.
  Real Fastify injection covers native sign-in and link starts, sign-in and link
  callbacks, and native Apple invitation acceptance at the 4,096-code-point and
  44/128-verifier boundaries. The installed pinned Supabase 2.112.2 fake-fetch
  path completes a native link with a 44-character verifier and the same subject.
- Contracts 0.6.0 and all migrations are byte-untouched. The Supabase skill's
  required changelog URL check was attempted before implementation, but the Web
  tool rejected the direct markdown URL with a non-retryable safe-open internal
  error. This parser-only change uses no new or assumed Supabase API surface, and
  the locally installed exact 2.112.2 SDK path is exercised directly.

### Strict RED then GREEN

- RED command:
  `node --import tsx --test --test-name-pattern='native Apple proofs|installed Supabase 2.112.2 Apple link' apps/identity-gateway/tests/fake-auth-provider.test.ts apps/identity-gateway/tests/supabase-auth-provider.test.ts`
  — exact result 3 total / 0 pass / 3 fail. Fake rejected the first non-43
  verifier at callback; Supabase rejected the 4,096-emoji nonce using UTF-16
  length; and the installed SDK link rejected a 44-character callback verifier.
- After the minimal shared-validator implementation, the same adapter command is
  GREEN 3/3. The Fastify route focus
  `node --import tsx --test --test-name-pattern='native Apple route families|Apple invitation proof preflight' apps/identity-gateway/tests/routes.test.ts`
  is GREEN 2/2. Fake and Supabase matrices accept verifier lengths 43, 44, and
  128; reject 42, 129, and a non-unreserved `!`; accept 4,096 emoji nonce/state;
  reject 4,097; and preserve a correct S256 comparison.

### Full verification and self-review

- Final `npm run check -w @core-agent/identity-gateway` — PASS: build and 124/124.
- Protected `npm run check -w @core-agent/contracts` — PASS: 180/180, generated
  schema/compatibility checks, 86 valid and 11 invalid fixtures. The first
  sandboxed run reached 180/180 then hit test-only `tsx` IPC `EPERM`; the identical
  protected rerun completed every gate.
- Protected root `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180,
  Runtime Core 83/83, Identity Gateway 124/124, and Web 129/129 across nine files.
- Official `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  144,341.193291 ms. Its fresh protected manifest asserted Runtime Core PostgreSQL
  344, Identity Gateway PostgreSQL 2, Control Plane API PostgreSQL 14, and
  integration 93; failure injection, output-leak rejection, and cleanup passed.
  Exact post-run Docker label scans found zero containers, volumes, and networks.
- Root `npm run check` passes Contracts, Runtime Core 83/83, Gateway 124/124, and
  API 17/17, then stops only at the untouched Worker `src/main.ts:60,129` TS2345
  `project_platform_memberships` mismatch. This remains independent of Task 7.
- Compatibility history from Task 7 base passes. Exact pins remain Fastify
  5.11.2, Cookie 11.1.2, Supabase JS/Auth JS 2.112.2, and Contracts 0.6.0.
  Accepted Contracts 0.5.0 and migrations 010/011 have empty base diffs.
  Checksums remain 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`,
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`,
  and 012 `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
- `git diff --check`, unique-sentinel scan over every Round 20 file, production
  log-call scan, migration/accepted-release residual scan, and Docker residual
  scan are empty. Self-review found no relaxed ordinary-string bound, no change
  to provider effects or authority, no raw proof persistence/logging, and no
  detached PKCE challenge.

### Files and commit

- Production: `apps/identity-gateway/src/oauth-proof.ts`, `src/security.ts`,
  `src/providers/fake-auth-provider.ts`, and
  `src/providers/supabase-auth-provider.ts`.
- Tests: Gateway Fake provider, Supabase provider/installed SDK fake-fetch, and
  real Fastify route-family suites.
- Round 20 implementation commit: `aab077094`
  (`fix(identity): align native Apple proof parsing`). No merge or push occurred.

## Round 19 review fixes (2026-08-19)

### Outcome and security boundary

- Web Apple cookies no longer contain raw OAuth state. Sealing computes a fixed
  `hmac-sha256` digest with the managed 32-byte flow key and a closed
  `apple-flow:{sign_in|link}:state:v1` purpose. The authenticated encrypted payload
  contains only transaction id, fixed state digest, exact Web client kind, link
  Actor when applicable, authorization/settlement deadlines, and flow kind. Web
  callbacks recompute that digest over the released body state and compare it in
  constant time before provider work; only a matching body state is forwarded.
  Web has no nonce field, and native state/nonce remains cookie-free.
- The Apple encrypted-value parser is again closed at 1,536 base64url characters,
  and both Apple cookie issuers reject any complete `Set-Cookie` header at 2,048
  bytes or more. Real Fastify injection proves 4,096 ASCII and 4,096 emoji states
  produce equal fixed-size headers below 2,048 bytes, survive the actual
  `Set-Cookie` -> `Cookie` path, and reject a changed state before the provider.
- OAuth proof validation now counts Unicode code points with a bounded iterator,
  not UTF-16 code units. It accepts 8..4,096 code points and at most 16,384 UTF-8
  bytes. Contracts, Web/native invitation preflight, and the real Fastify boundary
  accept 4,096 emoji and reject 4,097 while the shared ordinary 2,048-character
  helper remains unchanged.
- Provider authorization URLs are checked with that same exact state validator
  immediately after every Apple start effect. State lengths 1 and 7 now return the
  stable calm `AUTH_PROVIDER_UNAVAILABLE` 503 before any Web cookie or native
  response. Apple link cookies additionally bind the server-authenticated Actor.
- No public schema, database schema, provider effect ordering, or response field
  changed. Supabase JS remains pinned at 2.112.2; the required official changelog
  markdown request returned no relevant breaking item for this local boundary fix.

### Strict RED then GREEN

- Contracts baseline
  `node --import tsx --test --test-name-pattern="Apple and invitation proofs" tests/public-auth.test.ts`
  was already GREEN 1/1: the approved JSON Schema correctly treats 4,096 emoji as
  4,096 code points and rejects 4,097.
- Gateway invitation preflight focus was RED 0/1. Its new 4,096-emoji native proof
  threw `INVALID_REQUEST` from `security.ts:416`, proving the UTF-16 length defect.
- The combined security focus was RED 0/3:
  `node --import tsx --test --test-name-pattern="fixed purpose digest|compact real Set-Cookie|rejects short provider state" tests/security.test.ts`.
  The decrypted cookie still returned raw state and exceeded the new bound; the
  real 4,096-ASCII start emitted a header above 2,048 bytes; and a one-code-point
  provider state returned the wrong 401 instead of the start-boundary 503.
- After the minimal production changes, the same invitation focus is GREEN 1/1,
  the same security focus is GREEN 3/3, and the Contracts focus remains GREEN 1/1.

### Full verification and self-review

- Final `npm run check -w @core-agent/identity-gateway` — PASS: build and 121/121.
- `npm run check -w @core-agent/contracts` — PASS: 180/180, 86 valid and 11 invalid
  fixtures, generated schema, and cumulative compatibility checks.
- Protected `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180,
  Runtime Core 83/83, Identity Gateway 121/121, and Web 129/129 across 9 files.
- Official `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  153,243.754209 ms. Its fresh protected run retained Runtime Core PostgreSQL 344,
  Identity Gateway PostgreSQL 2, Control Plane API PostgreSQL 14, and integration
  93, including the updated real Apple link cookie fixture; injected-failure
  cleanup and output-leak redaction passed. Exact label scans afterward found zero
  containers, volumes, or networks.
- Compatibility history from the Task 7 base passes. Exact pins remain Fastify
  5.11.2, `@fastify/cookie` 11.1.2, Supabase JS 2.112.2, and Contracts 0.6.0.
  `git diff --check`, unique-sentinel and production logging scans, accepted 0.5
  release diff, and historical migration diff are empty.
- Migration checksums remain: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  012 `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
- Self-review found no raw state/nonce in decrypted cookie data, no provider effect
  inside a retried transaction, no authority regression, and no public leakage.
  The known untouched Worker TS2345 concern remains independent.

### Files and commit

- Production: `apps/identity-gateway/src/security.ts` and `src/routes/apple.ts`.
- Tests: Gateway security/routes/real PostgreSQL production composition plus the
  Contracts public-auth boundary test.
- Round 19 implementation commit: `e24417eff`
  (`fix(identity): compact apple flow proof binding`). No merge or push occurred.

## Round 18 review fix (2026-08-19)

### Outcome and boundary

- Apple OAuth `authorization_code`, `state`, and native `nonce` now use one
  field-specific 8..4,096-character validator at the invitation canonical-proof
  preflight, exactly matching Contracts 0.6.0. The shared `boundedString` remains
  unchanged at 1..2,048 characters for transaction ids, timestamps, recovery
  fields, and other ordinary inputs.
- The Apple flow-cookie seal and read boundaries authenticate the full 4,096-
  character state. Only the Apple encrypted-envelope ceiling was raised, to the
  closed 12,288-base64url-character bound needed for the existing closed payload;
  the recovery-cookie envelope remains capped at 4,096. Sealing rejects a 4,097-
  character state, reading still rejects an ordinary 2,049-character transaction
  id, and no public schema or provider behavior changed.
- Contract and Gateway regressions cover Web and native invitation proofs at 2,049
  and exactly 4,096, reject 4,097 independently for authorization code, state, and
  nonce, preserve key-order-independent canonical hashing, and round-trip Apple
  cookies at both newly reachable sizes.

### Strict RED then GREEN

- Contract boundary baseline:
  `node --import tsx --test --test-name-pattern="Apple and invitation proofs" tests/public-auth.test.ts`
  in Contracts was already GREEN 1/1, proving the approved 0.6 schema accepts the
  requested lengths before any production edit.
- Cookie RED:
  `node --import tsx --test --test-name-pattern="Apple flow cookie round-trips" tests/security.test.ts`
  was 0/1. A 2,049-character contract-valid Apple state returned `AUTH_INVALID`
  from `readAppleFlowCookie` at `security.ts:254`.
- Invitation preflight RED:
  `node --import tsx --test --test-name-pattern="Apple invitation proof preflight matches" tests/routes.test.ts`
  was 0/1. The first 2,049-character Web proof threw `INVALID_REQUEST` from
  `assertInvitationAcceptancePayloadHash` at `security.ts:408`.
- After the minimal field-specific implementation, the same three commands were
  GREEN 1/1, 1/1, and 1/1. The final cookie focus, including the unchanged ordinary
  2,048 boundary assertion, is GREEN 1/1.

### Final verification and self-review

- Final `npm run check -w @core-agent/identity-gateway` — PASS: build and 119/119.
- `npm run check -w @core-agent/contracts` — PASS: 180/180, 86 valid and 11 invalid
  fixtures, generated-schema check, and cumulative compatibility.
- Protected `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180,
  Runtime Core 83/83, Identity Gateway 119/119, and Web 129/129 across 9 files.
  The initial managed-sandbox run stopped at Runtime 189/192 only because its
  test-only loopback TCP and Unix socket listeners received `EPERM`; the identical
  protected rerun is fully green.
- Official `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  128,938.539875 ms. The fresh protected gate retained the observed manifest
  summaries Runtime Core PostgreSQL 344, Identity Gateway PostgreSQL 2, Control
  Plane API PostgreSQL 14, and integration 93; injected-failure cleanup and output-
  leak redaction passed. Exact label scans afterward found zero containers,
  volumes, or networks.
- Compatibility history from base passes. Exact pins remain Fastify 5.11.2,
  `@fastify/cookie` 11.1.2, Supabase JS 2.112.2, and Contracts 0.6.0.
  `git diff --check`, the sentinel scanner, production logging scan, accepted 0.5
  release diff, and historical migration diff are empty.
- No migration changed. SHA-256 remains: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  012 `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
- Self-review found no provider call, persistence, authority, output/logging, or
  public-contract change. The known untouched Worker TS2345 concern documented in
  Round 17 remains independent and was not expanded into this bounded fix.

### Files and commit

- Production: `apps/identity-gateway/src/security.ts`.
- Tests: `apps/identity-gateway/tests/security.test.ts`, `routes.test.ts`, and
  `packages/contracts/tests/public-auth.test.ts`.
- Round 18 implementation commit: `dddf1d20c`
  (`fix(identity): align apple oauth proof bounds`). No merge or push was performed.

## Round 17 review fixes (2026-08-19)

### Outcome and design

- Anonymous `/auth/v1/apple/start` no longer derives an account-dimension rate
  key from caller-controlled idempotency, redirect, device, nonce, or PKCE facts.
  It consumes the existing independent per-client route row and one fixed
  `global-circuit-breaker:anonymous-apple-start` row under the explicitly named
  `anonymous_apple_start_global_circuit_breaker` policy. The production policy is
  separately bounded at 2,000 requests per 15 minutes; it is a high-threshold
  global safety circuit breaker, not user-account identity. Callback account rows
  remain keyed by the server-minted transaction.
- Invitation Apple proof binding now accepts only the exact Web or native closed
  field set. It hashes authorization code, state, nonce, and PKCE facts before
  placing their digests into canonical key-sorted JSON. Semantically equal object
  property orders bind identically; extra, missing, or cross-mode facts fail
  before provider or durable effects.
- Production secret loading is sequential and ownership-scoped. The filesystem
  read buffer is wiped on validation success or failure; the validated value is
  copied into a separately owned buffer; already fulfilled siblings are wiped on
  partial acquisition failure; and all owned inputs are wiped after successful or
  failed production composition. No raw secret value is logged or persisted.
- The current brief, plan, and design record these boundaries. No contract,
  migration, database authority, or public response shape changed in Round 17.
  Supabase remains exactly 2.112.2; the required official changelog scan found no
  relevant newer Auth/Apple behavior requiring a scope change.

### RED evidence

- Before production edits,
  `npm test -w @core-agent/identity-gateway -- --test-name-pattern='anonymous Apple starts|Apple sign-in start and callback|Apple sign-in start account|Apple invitation proof hashing|managed-secret'`
  was RED: 117 total, 109 passed, 8 failed. The genuine failures showed the four
  rotated Apple starts created four different caller-derived account keys, the
  expected fixed circuit breaker was not consumed/limited, and neither managed-
  secret wipe helper existed. Three proof cases initially stopped in a test helper
  because it incorrectly sent raw secret-shaped keys to the canonicalizer; the
  helper was corrected to secret digests before any production proof edit.
- The corrected proof regression was mutation-audited against the prior
  `JSON.stringify(proof)` behavior:
  `node --import tsx --test --test-name-pattern='Apple invitation proof hashing' apps/identity-gateway/tests/routes.test.ts`
  was RED 0/1 with `INVALID_REQUEST` for a semantically equal reordered proof.
  Restoring the closed canonical implementation made the exact command GREEN 1/1.

### GREEN and real-boundary evidence

- `npm run check -w @core-agent/identity-gateway` — PASS: build and 117/117.
  Route tests prove four rotated Web/native start payloads share one fixed global
  account key while four direct client addresses retain four independent client
  keys; limiting the global row returns calm 429 before provider start. They also
  prove reordered Apple invitation proof acceptance and extra/missing rejection
  before effects. Composition tests capture and verify zeroed buffers for valid,
  invalid, callback-failure, and partial-acquisition paths.
- Disposable real PostgreSQL production composition — final PASS 2/2 in
  5,642.6055 ms using a passwordless configured URL plus a process-scoped protected
  credential. It persists exactly one Apple global circuit-breaker row at count 21
  and proves the separate threshold remains unexhausted above the ordinary limit
  of 20, while the complete Fastify/Task3-6/Supabase-adapter flows remain green.
  The first sandboxed attempt was 0/2 solely because local TCP returned EPERM; an
  initial disposable setup also exposed missing prerequisite roles, and one
  password-bearing URL was correctly rejected by strict production config. The
  final protected form was green and its explicit disposable container was removed.
- `npm run check -w @core-agent/contracts` — PASS: 180/180; 86 valid and 11
  invalid fixtures, generated schemas, and cumulative 0.6 compatibility all pass.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
- Authorized `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180,
  Runtime Core 83/83, Identity Gateway 117/117, and Web 129/129 across 9 files.
  The sandboxed precursor was 189/192 only because TCP/Unix listen returned EPERM.
- Final official `npm run test:runtime:database-ci-equivalent` rerun — PASS 3/3
  in 153,366.095 ms. Its tracked count manifest and protected summaries assert
  Runtime Core PostgreSQL 344, Identity Gateway PostgreSQL 2, Control Plane API
  PostgreSQL 14, and integration 93 from a fresh database, plus injected-failure
  cleanup and output-leak redaction. The first official run was 2/3: all database
  commands completed, but integration reported 93 pass plus one file-level
  `agent-run` teardown failure at `database drop`. Both cleanup scenarios passed
  and an exact label audit was empty before the single clean rerun; this evidence
  is retained rather than hidden.
- Root `npm run check` again passes Contracts, Runtime Core, Gateway, and Control
  Plane API 17/17, then stops only at the untouched Worker `src/main.ts:60,129`
  TS2345 `project_platform_memberships` errors. The corresponding database-auth
  topology wrapper is 0/1 because its image build reaches the same Worker errors
  before any topology scenario; its exact randomized resources were absent after
  cleanup. The fully fresh official database CI-equivalent above is green.
- `npm run compat:history -w @core-agent/contracts -- --base e7624fe0425ff470b646f8322254d5e9e3857da8`
  — PASS. Exact pins are Fastify 5.11.2, Cookie 11.1.2, Supabase JS 2.112.2, and
  Contracts 0.6.0. Base diffs for migrations 010/011 and Contracts 0.5.0 are empty.
  SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`,
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`,
  and unmodified Round-17 012
  `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
- Final unique-sentinel scan across every Round 17 source, test, current design,
  brief, progress, and report artifact — PASS with empty output. `git diff --check`,
  production logging/provider-token residual search, official-CI label
  scan, and historical migration/Contracts residual scans are also empty.

### Files, self-review, and commit

- Production: `apps/identity-gateway/src/app.ts`, `routes/apple.ts`,
  `security.ts`, and `server.ts`.
- Tests: `apps/identity-gateway/tests/routes.test.ts`, `composition.test.ts`, and
  `tests/postgres/production-composition.test.ts`.
- Current documentation: Task 7 brief, approved plan, and approved design.
- Self-review found no provider effect moved into a retried database transaction,
  no new caller authority, no public token/PII exposure, and no migration or
  historical contract drift. Callback client+server-transaction rate dimensions
  and all prior Task3-6 composition behavior remain unchanged.
- Round 17 implementation commit: `2a9fb545b`
  (`fix(identity): close round 17 review findings`). No merge or push was performed.

## Round 16 review fixes (2026-08-19)

### Review resolution

- Re-read and followed receiving-code-review, test-driven-development,
  systematic-debugging, verification-before-completion, and the Supabase skill.
  No schema or contract change was needed: migration 012 remains at its Round 15
  checksum, 010/011 and Contracts 0.5 remain byte-identical, and Entitlement stays
  reserved for schema 13.
- `grantConsultantRole`, `removeConsultantRole`, and `suspendMembership` now use the
  caller-owned Kysely transaction for discovery as well as all locks, authority
  checks, idempotency, and mutation. The root database is used only to open the
  service-owned serializable transaction when no transaction is supplied. A real
  PostgreSQL max-three pool test starts three outer serializable transactions at
  one snapshot barrier and proves grant/remove/suspend need no fourth connection;
  serialization retries converge through fresh caller-owned transactions.
- Email sign-in and password reauthentication still validate the released public
  canonical hash before provider work. Before durable idempotency, production now
  derives a purpose-separated HMAC-SHA-256 from the managed private key, closed
  authority/request facts, and transient password bytes. The caller-owned bytes and
  owned copies are cleared. Real Fastify/PostgreSQL assertions prove the stored hash
  differs from both the public hash and plain SHA-256 password digest, while a
  changed password under the same key conflicts without another Session.
- OTP verification no longer has a cross-clock inspection recovery primitive in
  the adapter, fake, Gateway operation, runtime repository, or test fixture. Only
  an explicit successful `verifyOtp` result may checkpoint a verified subject. An
  unavailable/unknown result or a consumed proof whose checkpoint was lost commits
  `expired`, replaces encrypted/email bindings with non-secret sentinels, clears
  attempt/subject fields, and returns a stable terminal authentication error. It
  never registers an Actor or issues a Session; a new flow or ordinary sign-in is
  still available.
- Company create, member invite, consultant grant/remove, member suspend/revoke,
  and invitation revoke recompute the exact public canonical payload hash before
  Session authentication or any provider/database effect. Email facts are
  normalized exactly as the contract requires. Malformed and changed hashes return
  400 with an empty operation trace.

### Round 16 RED evidence

- Focused Gateway RED ran the new route/provider cases before production edits:
  113 total / 109 pass / 4 fail. The failures proved that checkpoint-loss and
  unknown OTP outcomes still recovered to 200, the Supabase inspection recovery
  surface still existed, and protected company/invitation hashes reached authority
  handling instead of returning pre-authentication 400.
- The real PostgreSQL caller-owned role focus was RED 0/1. With pool `max: 3`, the
  three outer transactions reached the snapshot barrier, then the first role
  discovery attempted a fourth root-database connection and timed out at
  `prepareRoleMutation`.
- The production-composition additions were written before the private durable-hash
  implementation and ambiguity terminalization. They initially observed the public
  recomputable hash at the idempotency boundary and retained a recoverable OTP
  attempt instead of a terminal scrub.
- The first final official CI-equivalent run was RED 2/3 after all behavior suites
  passed: the execution-proof manifest still expected the Round 15 Runtime Core
  PostgreSQL count 343. The formal run had just observed 344/344. The manifest was
  updated only to that observed count; its focused static gate is GREEN 38/38.

### Focused, package, and real-boundary GREEN evidence

- `npm run check -w @core-agent/identity-gateway` — PASS: build and 113/113.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
- `npm run check -w @core-agent/contracts` — PASS: 180/180, generated schemas,
  current/cumulative compatibility, 86 valid fixtures, and 11 invalid fixtures.
- `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180, Runtime Core
  83/83, Identity Gateway 113/113, and Control Plane Web 129/129 across 9 files.
- Focused real PostgreSQL role-mutation plus OTP ambiguity run — PASS 2/2. The role
  test exercises three simultaneous caller-owned transactions and the OTP test
  asserts durable terminal scrub rather than a fake adapter-only result.
- `npm run test:postgres` against the protected SCRAM disposable database — PASS:
  Runtime Core 344/344, Identity Gateway 2/2, and Control Plane API 14/14. The
  Gateway composition is real Fastify plus production operations, provider ports,
  and PostgreSQL; it proves private sign-in/reauth hashes, changed-secret conflict,
  unknown OTP ahead/behind/unrelated/response-loss matrices, zero graph/Session,
  and all seven protected-write pre-auth hash checks.
- During local diagnosis one non-fresh Gateway run observed 1/2 with a calm 500 in
  the OTP-attempt fixture after a previously interrupted two-hour test process. It
  was not reproducible after the exact stale test process was removed: five
  consecutive focused production runs, a complete Gateway 2/2, the root formal
  2/2, and the fresh official run all passed. No speculative production change was
  made for that isolated shared-environment observation.

### Official gates, integrity, and concern

- Final `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  147750.961583 ms. Its fresh protected run accepted the actual 344 + 2 + 14
  PostgreSQL summaries and integration 93; injected-failure cleanup and protected
  output-leak rejection passed. Exact labeled/prefixed container, volume, network,
  credential-file, and stale-process residual scans are empty.
- Root `npm run check` passes Contracts 180/180 and fixtures 86/11, Runtime Core
  83/83, Gateway 113/113, and Control Plane API 17/17, then stops only at the
  unchanged Worker `main.ts:60,129` TS2345 diagnostics for
  `project_platform_memberships`. `npm run test:runtime:database-auth-topology` is
  correspondingly 0/1 because its Worker image build stops before any topology
  scenario runs; cleanup completed and no Task 7 file touches the Worker.
- Exact pins remain Fastify 5.11.2, `@fastify/cookie` 11.1.2, Supabase JS 2.112.2,
  and Contracts 0.6.0. `node scripts/verify-no-secret.mjs
  identity-auth-private-sentinel`, `git diff --check`, production logging scan,
  accepted-history diff, and Docker/filesystem residual scans pass.
- SHA-256 remains: migration 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  012 `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
- Self-review confirmed that provider effects remain outside automatically retried
  transactions; public errors/logs contain none of the provider, proof, email,
  Cookie, Session-secret, key, or database facts prohibited by the brief.
- Round 16 implementation commit: `7af365f2b` (`fix(identity): close round 16
  gateway review`). Remaining concern is only the pre-existing Worker build blocker
  above. No merge or push was performed.

## Round 15 review fixes (2026-08-19)

### Review resolution

- Re-read and followed receiving-code-review, test-driven-development,
  verification-before-completion, and the Supabase skill before production
  changes. No new schema or authority decision was required; the still-unmerged
  migration 012 was amended, while 010/011 and Contracts 0.5 remain unchanged.
- Apple sign-in start now consumes the stable client route limit and an
  independent account limit derived server-side from the exact canonical start
  facts before `beginApple` or any durable/provider start effect. Apple
  invitation callback consumes `apple_callback` client plus exact durable
  transaction account admission before `completeApple`, then only the
  `invitation_accept` account admission after exact invitation lookup; it does
  not duplicate the client dimension.
- Ambiguous password-reset recovery independently decrypts the durable completed
  and expected provider-subject bindings. It resolves all distinct Actors and
  revokes their Sessions without requiring an active AuthSubject; a corrupt or
  absent binding does not prevent the other binding's revocation or the final
  durable scrub.
- The initial Web Apple-link Cookie now signs the exact five-minute authorization
  expiry and its exact plus-thirty-minute settlement deadline, with a 2,100-second
  `Max-Age`. Authorization expiry still prevents new provider acquisition. A
  durable `provider_started` callback returns a closed observation to the Core
  caller-owned transaction, whose PostgreSQL clock returns retryable 503 before
  the settlement boundary or commits `expired` plus checkpoint scrub at/after
  the boundary. The same initial Cookie resumes `provider_completed` settlement
  after an authorization-expiry response-loss crash.
- Pinned Supabase 2.112.2 offers exact subject inspection but no causal receipt
  proving that one specific Apple-link attempt created a provider identity.
  Therefore the bounded ambiguous `provider_started` state fails safely at its
  settlement deadline rather than claiming link success from ambient account
  state.
- Existing-Session invitation acceptance now invokes Task 6
  `requireRecentReauthentication` and locks/revalidates the exact Core Session,
  Actor, and AuthSubject in the same serializable transaction as Task 4
  acceptance and replacement Session issuance. The ten-minute database-clock
  boundary is exclusive. Verified-provider onboarding has no old Session and
  intentionally skips this guard.

### Round 15 RED evidence

- Focused Fastify command:
  `npm test -w @core-agent/identity-gateway -- --test-name-pattern='Apple sign-in start and callback consume|Apple sign-in start account limiting|Apple invitation callback rotation|Apple link cookie authenticates|Apple link start derives'`
  was RED at 109 total / 104 pass / 5 fail. The exact failures were provider
  start before account admission, account exhaustion still reaching `beginApple`,
  duplicate invitation client admission with no callback account admission,
  Apple-link Cookie `Max-Age=300` instead of 2,100, and acceptance of a non-exact
  29:59 settlement binding.
- Adding the durable Supabase Apple-link observation focus made the suite 110 total
  / 104 pass / 6 fail: loaded `provider_started` returned
  `AUTH_PROVIDER_UNAVAILABLE` before the PostgreSQL clock could settle it.
- Real Fastify/production-composition/PostgreSQL was RED 0/2: the initial
  Apple-link Cookie still expired at five minutes, and the ambiguous-reset active
  Session reachable through the alternate durable subject remained active.
- The existing-invitation reauthentication matrix was written before its
  production edit and failed for missing Task 6 guard behavior; it covers revoked,
  idle-expired, and exact ten-minute reauthentication boundaries.

### Focused and package GREEN evidence

- The expanded focused Fastify/Supabase command is GREEN 110/110. Ordered traces
  prove both Apple-start limits precede provider work, account 429 performs zero
  provider work, and invitation Apple callback uses exactly three admissions:
  callback client, callback transaction account, invitation account.
- `npm run check -w @core-agent/identity-gateway` — PASS: build and 110/110.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
- `npm run check -w @core-agent/contracts` — PASS: 180/180, schema/current 0.6
  compatibility, 86 valid fixtures, and 11 invalid fixtures.
- `npm run test:unit` initially stopped at Runtime 189/192 only because the
  restricted sandbox denied three local TCP/Unix `listen` calls with `EPERM`.
  The same command outside that socket restriction is PASS: Runtime 192/192,
  Contracts 180/180, Runtime Core 83/83, Identity Gateway 110/110, and Control
  Plane Web 129/129 across 9 files.

### Real PostgreSQL and official evidence

- `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55451/core_agent_runtime npm run test:postgres -w @core-agent/identity-gateway`
  — PASS 2/2. Real Fastify plus production composition proves original-Cookie
  resume after authorization expiry, database-clock `provider_started`
  retry/terminal scrub boundaries, independent ambiguous-reset subject recovery,
  and existing invitation Session reauthentication/revoke/expiry barriers.
- Manual full Runtime Core PostgreSQL was 343 total / 342 pass / 1 environment
  failure: the disposable diagnostic container used
  `POSTGRES_HOST_AUTH_METHOD=trust`, so the test requiring rejection of a stale
  password could not reject it. All migration-012, restart, ACL, concurrency, and
  identity behavior passed in that run.
- `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  144423 ms. Its protected SCRAM run asserted Runtime Core PostgreSQL 343,
  Identity Gateway PostgreSQL 2, Control Plane API PostgreSQL 14, and integration
  93; injected-failure cleanup and output-leak rejection passed.
- `npm run test:runtime:database-auth-topology` is 0/1 because the unchanged
  Control Plane Worker Docker build stops first at its two existing TS2345
  `project_platform_memberships` dispatcher errors. No migration/topology
  assertion ran or failed. `npm run check` likewise passes Task 7 packages and
  Control Plane API 17/17 before stopping at those same Worker lines 60 and 129.

### Integrity, scans, and self-review

- Exact pins remain Fastify 5.11.2, `@fastify/cookie` 11.1.2,
  `@supabase/supabase-js` 2.112.2, and Contracts 0.6.0.
- Historical SHA-256 values remain: migration 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  migration 011
  `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`.
  Amended migration 012 and its manifest are
  `2e7a7d0b8f910ff5253ace5dff1f0cc242224ec432e75621f15f57d93d14af12`.
  Base diffs for 010/011 and Contracts 0.5 are empty.
- `node scripts/verify-no-secret.mjs identity-auth-private-sentinel`,
  `git diff --check`, dependency inspection, and the production logging/residual
  scans pass. No provider proof/token, raw Cookie, provider subject/email,
  Session secret, key identifier, database detail, or internal body was added to
  public output/logging.
- Self-review confirmed provider effects remain outside automatically retried
  database transactions; the post-provider observation and all protected Task 4
  mutations use caller-owned serializable transactions and database time.
- Round 15 implementation commit:
  `b346bf60a` (`fix(identity): close round 15 gateway review`).
- Remaining concern is limited to the pre-existing, out-of-scope Worker TS2345
  build failure described above. No merge or push was performed.

## Round 14 review fixes (2026-08-18)

### Review resolution

- Re-read the receiving-review, TDD, verification-before-completion, and
  Supabase skill instructions before changing production code. No new schema or
  authority decision was required; the approved, still-unmerged migration 012
  was sufficient.
- Every split public limiter call now declares its dimension. Stable route/client
  admission uses `dimensions: "client"`; the exact second admission uses
  `dimensions: "account"` with the server-issued transaction/invitation identity
  or authenticated Actor. Apple sign-in callback account admission is keyed by
  the durable transaction and occurs before its one-use provider exchange.
  Reauthentication and Apple link no longer consume a duplicated client
  dimension through a default `both` call.
- Email provider-start admission now returns a monotonically increasing
  `providerStartAttempt`. Finalize-success and finalize-failure lock the row and
  require the exact still-reserved generation, so an expired lease's stale
  provider result cannot overwrite a newer reservation.
- Existing invitation acceptance performs stable client admission, exact
  invitation lookup/account admission, and only then Core Session
  authentication. Its serializable final transaction locks and revalidates the
  exact Actor and Core Session, including Actor/subject/client kind, status,
  resource version, idle expiry, and absolute expiry before accepting the
  invitation or issuing a Session.
- Ambiguous password-reset recovery always commits `expired` and scrubs every
  checkpoint. If the protected subject resolves to an Actor, all Sessions are
  revoked even when its AuthSubject is inactive; corrupt ciphertext and missing
  subjects still scrub durably without claiming success.
- Email signup and invited signup durable start hashes now incorporate a
  purpose-separated password HMAC, and Apple-link start uses its own purpose
  HMAC. Only the overall canonical hash is persisted. Owned password byte copies
  are cleared. Exact Apple-link start replay still performs a fresh password
  authentication; a changed password conflicts before any new provider start.
- Apple-link provider acquisition creates a separate database-clock 30-minute
  settlement deadline. Initial callbacks remain constrained by the OAuth
  authorization expiry. A provider-completed Web callback receives a signed
  dual-deadline settlement cookie; after a Core rollback it can resume after the
  authorization expiry without repeating the provider effect. At the exact
  settlement boundary the serializable Core command commits `expired`, scrubs
  the provider checkpoint, and returns a terminal calm error.
- Removed the dormant unconditional test return. The obsolete generic
  `updated_at` recovery assertions were replaced by the released fail-closed
  behavior: concurrent corrupt checkpoints, missing subjects, and inactive
  subjects execute and assert durable scrub/revocation.

### Round 14 RED and focused GREEN evidence

- `node --import tsx --test --test-name-pattern='unknown provider-start outcome' packages/runtime-core/tests/email-verification-transactions.test.ts`
  was RED 0/1 because the admission returned no generation and stale
  finalization was accepted. The same real PostgreSQL focus is GREEN 1/1.
- The focused Fastify rate/order group was RED 0/4: Apple start lacked the exact
  account admission, invitation accept authenticated before exact invitation
  admission, Apple link calls omitted explicit dimensions, and callback account
  admission was missing. It is GREEN 4/4 after the route changes.
- `node --import tsx --test --test-name-pattern='Apple sign-in start and callback consume' apps/identity-gateway/tests/routes.test.ts`
  was RED 0/1 with the observed order `client rate -> completeApple -> account
  rate -> issueSession`; it is GREEN 1/1 with `client rate -> transaction account
  rate -> completeApple -> issueSession`.
- Real Fastify/PostgreSQL invitation Session revoke/idle-expiry barriers are
  GREEN 1/1 and prove zero Membership creation after authority changes between
  preliminary authentication and the final command.
- Real Fastify/Supabase-adapter/PostgreSQL reset ambiguity coverage is GREEN 1/1:
  concurrent corrupt ciphertext, missing subject, and inactive subject all
  terminate and scrub; the resolvable inactive Actor's Session is revoked.
- The real email start suite is GREEN 1/1 for changed-password conflict and stale
  attempt fencing. The Supabase Apple-link focus is GREEN and observes two real
  password authentications for initial start plus exact replay, while a changed
  password conflicts without another provider start.
- The Apple-link real production-composition focus is GREEN 1/1: forced Core
  rollback returns 500 with a settlement cookie, the original authorization
  cookie is rejected after authorization expiry, the settlement cookie resumes
  successfully without another provider link effect, and exact settlement
  expiry commits scrubbed `expired` state.
- `node --import tsx --test --test-name-pattern='explicit route-client' packages/runtime-core/tests/public-rate-limits.test.ts`
  — PASS 1/1 against PostgreSQL. Same-client/different account facts share the
  client bucket, same-account/different clients share the account bucket, and
  different server accounts remain independent rather than collapsing globally.

### Round 14 final verification

- `npm run check -w @core-agent/contracts` — PASS: build, 180/180, schemas,
  86 valid fixtures / 11 invalid fixtures, and current compatibility.
- `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
- `npm run check -w @core-agent/identity-gateway` — PASS: build and 108/108.
- `CONTROL_PLANE_TEST_DATABASE_URL=... npm run test:postgres -w @core-agent/identity-gateway`
  — PASS 2/2 in 5049.855042 ms with real Fastify, production composition,
  pinned Supabase adapter, and PostgreSQL.
- The first local formal PostgreSQL run observed 342/343 Runtime Core tests pass;
  its sole failure was the auth-bootstrap test because the hand-created
  disposable container used host `trust` and therefore could not reject a wrong
  password. No product behavior failed. The authoritative protected SCRAM run
  below covered that test.
- `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  141825.677459 ms. The fresh protected run asserted Runtime Core PostgreSQL
  343/343, Identity Gateway PostgreSQL 2/2, Control Plane API PostgreSQL 14/14,
  and integration 93/93; injected-failure cleanup and output-leak redaction also
  passed. The expected-count manifest changed from 342 to the observed 343 only
  after the new rate-dimension PostgreSQL test ran.
- `npm run compat:history -w @core-agent/contracts -- --base e7624fe0425ff470b646f8322254d5e9e3857da8`,
  `node scripts/verify-no-secret.mjs identity-auth-private-sentinel`, gateway
  log-call scan, and `git diff --check` — PASS. Migrations 010/011 and Contracts
  0.5.0 have no base diff.
- Exact pins remain Fastify 5.11.2, `@fastify/cookie` 11.1.2, Supabase JS
  2.112.2, and Contracts 0.6.0. SHA-256: 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended 012
  `61e62a78b86769866a242e138f64db9ea8c560bbada0806acf2d1414fc895f4f`.
- Official CI-equivalent and topology residual scans found zero labeled
  containers, volumes, or networks.
- `npm run check` again passes Contracts, Runtime Core, Identity Gateway, and
  Control Plane API (17/17), then stops only at the untouched Worker's two known
  TS2345 `project_platform_memberships` dispatcher errors. The Worker base diff
  is empty. `npm run test:runtime:database-auth-topology` likewise stops 0/1 at
  that Worker image build before topology execution and cleans its resources.
- Round 14 implementation commit:
  `ce9269ce2` (`fix(identity): close round 14 gateway review`).

## Round 13 review fixes (2026-08-18)

### Feasibility and provider-boundary decision

- Re-read `superpowers:receiving-code-review`,
  `superpowers:test-driven-development`,
  `superpowers:verification-before-completion`, and `supabase:supabase` before
  changing production code.
- Inspected the installed, exactly pinned `@supabase/supabase-js` and
  `@supabase/auth-js` 2.112.2 source. The Admin user response exposes only the
  generic user `updated_at`; it has no operation-specific password-update
  receipt or password-change timestamp. Therefore a loaded
  `provider_started` reset cannot safely infer success from later admin
  inspection. The implementation is deliberately fail-closed: it decrypts the
  exact prebound subject inside a serializable caller-owned PostgreSQL
  transaction, revokes every Core Session for that exact active subject,
  durably terminalizes and scrubs the OAuth checkpoint, returns the stable
  recovery-required public failure, and permits a new reset. It never labels
  generic `updated_at` as causal success and never repeats an admin password
  update from an arbitrary code.
- The immutable Contracts 0.5 invitation provider-proof branch creates an
  additive-compatibility constraint. Contracts 0.6 keeps that legacy branch
  parseable but marks it as a wire-compatibility shape only; the Gateway rejects
  it before rate limiting, Session authentication, provider work, or database
  work. New email invitees use durable schema-12 onboarding, and existing
  invitees authenticate with an exact Core Session transport.

### Round 13 RED evidence

- Strict timestamp focus was RED 98/99 because the shared parser/export did not
  exist. It then proved zero fractional digits and 1..9 digits, while rejecting
  invalid calendar dates, offsets, excess precision, and trailing garbage for
  both `email_confirmed_at` and reset evidence.
- Supabase reset focus was RED 100/101 because a loaded `provider_started`
  checkpoint still attempted to recover through generic `updated_at` rather
  than returning an ambiguous fail-closed observation.
- Real PostgreSQL provider-start lease focus was RED 0/1: the same exact key
  remained permanently `in_progress`. Route focus was separately RED 0/1
  because the unknown outcome returned a terminal conflict instead of a
  retryable 503.
- Invitation contract focus was RED 3/5 before the Core Session branch and
  provider-proof rejection were represented. A later full compatibility gate
  was genuinely RED after all 180 contract tests and 86/11 fixtures passed:
  `initial v1` and release `0.5.0` both reported
  `union_narrowed at $.anyOf`. The final additive object evolution resolves this
  without changing 0.5.
- Independent-dimension rate-limit PostgreSQL focus was RED 0/1 because one
  combined row let either account or client rotation bypass the other. Trusted
  proxy route focus was RED 0/1 because the client identity did not yet use
  Fastify's `request.ip` trust boundary.
- Email sign-in and Apple callback canonical-binding focuses were each RED 0/1:
  a changed password/code/state fact under the caller's old hash reached the
  effect path.
- Supabase Apple-link focus was RED 0/1 because provider success had no durable
  `provider_completed` checkpoint. The real Fastify/PostgreSQL composition
  focus then proved the pre-fix Core rollback repeated the one-time provider
  exchange.
- The first official CI-equivalent Round 13 rerun was RED 2/3 only because the
  observed Runtime Core PostgreSQL count increased from 340 to 342. After
  updating that count from a protected 342/342 summary, the next run was RED
  2/3 only because its proof marker retained the old rate-limit test title.
  Both REDs were gate-wiring evidence, not guessed count changes.

### Round 13 implementation and real-boundary GREEN

- Added one shared closed UTC parser accepting only exact UTC `Z` RFC3339
  calendar timestamps with zero or 1..9 fractional digits, truncating the
  provider/PostgreSQL boundary to JavaScript milliseconds. All Supabase subject,
  confirmation, reset-evidence, fake-provider, and durable-flow timestamp reads
  use it.
- Schema 012 now records `provider_start_reserved_at`. Concurrent first starts
  still use `INSERT ... ON CONFLICT` admission; an exact same-key reservation is
  retryable only after a bounded database-clock lease, payload conflicts stay
  closed, finalized starts replay without provider work, and unknown outcomes
  are 503 rather than fake 202/409 success.
- Public invitation acceptance now uses an exact Web cookie+CSRF or native
  bearer Core Session for existing identities, verifies the stored Session
  client kind, and derives Actor/AuthSubject/email only in production
  composition. The immutable provider-proof branch is explicitly rejected with
  zero effect. New invitees retain the durable email/Apple onboarding paths.
- Rate limiting persists two independently contended HMAC rows in one atomic SQL
  statement: actual-account/constant-client and constant-account/actual-client.
  Stable route/client admission precedes verification/invitation lookup;
  transaction or invitation IDs are server-issued account dimensions. Fastify
  does not trust X-Forwarded-For by default and accepts only the bounded exact
  `IDENTITY_TRUSTED_PROXY_ADDRESSES` allowlist, using `request.ip`.
- Apple link completion reserves `provider_started`, checkpoints the encrypted
  exact Apple subject as `provider_completed` immediately after the one-time
  exchange, and performs the Core CAS, idempotency completion, and OAuth consume
  in one serializable post-provider transaction. A Core rollback returns 500
  while retaining the Web Apple cookie; exact replay skips the provider and
  consumes once after Core success.
- Email sign-in and Apple sign-in/link callback hashes are recomputed from closed
  normalized request facts, including secret digests and every mode-specific
  callback fact, before rate/provider/durable effects. Caller hashes cannot
  detach an idempotent identity from the actual proof.
- Real production-composition PostgreSQL remains 2/2. It proves the Apple-link
  checkpoint/Core-rollback/replay sequence with one provider exchange and the
  reset ambiguous checkpoint path with Core Session revocation, durable scrub,
  no admin inspection, stable public error, and a new reset start.

### Round 13 final verification

- `npm run check --workspace=@core-agent/contracts` — PASS: 180/180, generated
  schema drift clean, 86 valid/11 invalid fixtures, cumulative 0.6 compatibility.
- `npm run compat:history --workspace=@core-agent/contracts -- --base e7624fe0425ff470b646f8322254d5e9e3857da8`
  — PASS; Contracts 0.5 is unchanged.
- `npm run check --workspace=@core-agent/runtime-core` — PASS: build and 83/83.
- `npm run check --workspace=@core-agent/identity-gateway` — PASS: build and
  107/107.
- `npm run test:runtime` — PASS 192/192. `npm run test:unit` — PASS, including
  Runtime 192/192, Contracts 180/180, Runtime Core 83/83, Identity Gateway
  107/107, and Web 129/129 across 9 files.
- Protected formal `npm run test:postgres` — PASS: Runtime Core PostgreSQL
  342/342, Identity Gateway production composition 2/2, Control Plane API
  14/14. Protected migration-only rerun — PASS 128/128, including fresh,
  schema-10, schema-11 clean/dirty/consumed upgrades, ACL/catalog/rollback,
  restart, and schema-12 convergence.
- `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in
  141209.988042 ms. Its fresh protected scenario asserted PostgreSQL
  342+2+14 and integration 93, secret-output rejection, injected-failure
  cleanup, and exact Docker resource cleanup.
- `npm ls fastify @fastify/cookie @supabase/supabase-js @supabase/auth-js` —
  exact Fastify 5.11.2, Cookie 11.1.2, Supabase JS/Auth JS 2.112.2.
- Historical migration diffs for 010/011 are empty. SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`,
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended 012 is
  `6107af0bdc7574884326132cdaade446419cf77e207f45507abebac27471f93b`.
- `git diff --check`, protected sentinel scan over every changed Task 7 file,
  provider-token/public-auth residual scan, stale Entitlement-012 scan, and
  stale causal-`updated_at` claim scan all pass. Public-auth contract tests retain
  their provider/PII/credential forbidden-name gate.

### Independent concern

- Root `npm run check` passes Task 7 packages and Control Plane API 17/17, then
  fails only in untouched `apps/control-plane-worker/src/main.ts:60,129` with
  the pre-existing TS2345 `project_platform_memberships` union mismatch.
  `npm run test:runtime:database-auth-topology` likewise stops 0/1 while building
  that unchanged Worker, before any topology scenario executes. Task 7 has no
  Worker/harness diff, prior review instructions explicitly excluded them, and
  the topology harness cleaned its exact disposable resources. The fully fresh
  official database CI-equivalent above is green.
- Round 13 implementation commit:
  `0d0b692e0` (`fix(identity): close final gateway review findings`). No merge or
  push was performed.

## Round 12 review fix (2026-08-18)

Status: `DONE_WITH_CONCERNS`. The final concurrent exact-observation loser now
resumes a durable Provider-completed password-reset settlement. All Task 7 gates,
including the official protected database CI-equivalent, pass. The only concern
remains the unchanged Control Plane Worker compile defect that prevents the
separate auth-topology image from reaching its scenario.

### Delivered Round 12 correction

- Two requests may both load the same `provider_started` row and independently
  obtain exact service-role evidence before either reaches Core. If the winner
  commits `provider_completed` and then rolls back its Session-revocation phase,
  the loser now resumes only when the locked row is the same pending password-reset
  transaction, its canonical completion payload hash matches, the observation is
  exact and causal under the same PostgreSQL clock, and its evidence timestamp is
  the already persisted completion evidence.
- Core decrypts the durable encrypted Provider subject inside that caller-owned
  serializable observation transaction and checks every closed subject field
  against the adapter observation. It returns the durable subject, not the caller
  value, to the existing Session-revoke/consume phase. The production builder now
  shares the same purpose-derived OAuth envelope protector between the pinned
  adapter and Core composition; secret source buffers retain their existing
  zeroization.
- Invalid typed observations remain terminal, old evidence remains retryable, and
  future or malformed evidence remains terminal before the already-completed
  branch can run. An exact observation with a different durable subject or
  evidence also fails closed. No Provider effect moved inside a database retry.
- The real deterministic barrier performs one Provider exchange/password update,
  forces the first durable Provider checkpoint attempt to fail, then admits two
  exact retries before releasing either Core observation. The winner commits the
  observation and is forced to 500 in phase two with its Cookie retained; the
  loser sees `provider_completed`, revokes all Core Sessions, consumes the
  transaction, returns 200, and clears the Cookie without repeating Provider work.
  A second barrier gives the concurrent loser a closed subject-mismatch observation;
  it remains 401, clears its Cookie, leaves the Session active, and cannot consume
  the winner's completed checkpoint.

### Round 12 RED/GREEN evidence

- Focused RED against disposable PostgreSQL 17 on localhost:
  `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55448/core_agent_runtime node --import tsx --test --test-concurrency=1 --test-name-pattern='defer provider-started reset settlement' tests/postgres/production-composition.test.ts`
  — 1 total / 0 pass / 1 fail. The exact race returned statuses `[401, 500]`
  instead of `[200, 500]`, proving the loser was rejected solely because the
  winner had already changed the row to `provider_completed`.
- The same focused command is GREEN 1/1 in 1576.613375 ms. The complete Gateway
  check is build plus 98/98. The direct formal Gateway PostgreSQL package is GREEN
  2/2 in 3667.627125 ms; its formal count is unchanged because both new barrier
  matrices extend the existing production reset test.

### Round 12 final verification

- Contracts pass 180/180 plus 86 valid and 11 invalid fixtures; Runtime Core
  passes build and 83/83. Root `test:unit` passes Runtime 192/192, Contracts
  180/180, Runtime Core 83/83, Gateway 98/98, and Web 129/129 across nine files.
- `npm run test:runtime:database-ci-equivalent` is GREEN 3/3 in
  145457.801333 ms. Its fresh protected stage accepted Runtime Core PostgreSQL
  340, Gateway PostgreSQL 2, API PostgreSQL 14, and integration 93; injected-failure
  cleanup and output-leak redaction also passed. Exact labeled resources and the
  owned Round 12 database were absent afterward.
- Contracts history compatibility, exact pins, sentinel secret scan, forbidden
  log/legacy-checkpoint scan, `git diff --check`, and base immutability for
  Contracts 0.5, migrations 010/011, and the Worker source pass. Fastify remains
  5.11.2, Cookie 11.1.2, Supabase JS 2.112.2, and Contracts 0.6.0.
- Migration 012 is unchanged. SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  012 `42a2120802daa43b19f842e638e310c4285d927bc292186d996ff61af3d83767`.
- Root `npm run check` again reaches and passes Contracts, Core, Gateway, and API,
  then stops only at unchanged Worker TS2345 diagnostics at `src/main.ts:60` and
  `src/main.ts:129`. `database-auth-topology` is 0/1 because its image build
  reaches the same Worker diagnostics; all exact cleanup resources are absent.
- Round 12 implementation commit:
  `6660f03bd` (`fix(identity): resume concurrent reset settlement`).
- No merge or push was performed.

## Round 11 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. The final Provider-started observation finding is
fixed through the real pinned Supabase adapter and production Fastify/PostgreSQL
composition. All Task 7 behavior gates, including the official protected database
CI-equivalent, pass. The only concern remains the unchanged Control Plane Worker
compile defect that also stops the separate auth-topology image build.

### Delivered Round 11 correction

- A loaded `provider_started` reset no longer lets the Supabase adapter classify
  expiry, future evidence, or causality with its Node process clock. The adapter
  validates the durable binding, performs the exact service-role inspection, and
  returns one closed internal observation: exact evidence with only the expected
  bound subject, or a non-sensitive typed subject/email/malformed reason. It does
  not expose the observed mismatched Provider facts and does not checkpoint Core.
- Every exact, old, future, malformed, subject-mismatch, and email-mismatch
  observation reaches the production caller-owned serializable transaction. It
  locks the exact OAuth row, reads PostgreSQL `clock_timestamp()` once, and checks
  settlement expiry first. An expired row commits `expired` and scrubs PKCE,
  expected/completed subject ciphertext, canonical hash, start/completion/evidence
  timestamps, and settlement deadline before the terminal public 401.
- Before expiry, exact causal evidence durably advances to `provider_completed`;
  old evidence returns stable retryable 503 with the recovery Cookie retained;
  future/malformed/subject/email mismatch remains terminal 401 with Cookie clear.
  The later Core Session revocation/consume phase remains a separate serializable
  transaction, so no Provider effect is placed inside an automatic DB retry.
- The production matrix deliberately places the Gateway clock one hour behind the
  database. It proves valid evidence still completes, and that all six expired
  observations scrub durably even when the application clock would consider the
  settlement live. No migration, public Contract, or formal PostgreSQL count
  changed in this round.

### Round 11 RED evidence

- From `apps/identity-gateway`,
  `node --import tsx --test --test-name-pattern='checkpoint failure restarts|bounded post-provider deadline|arbitrary adapter delay|crash before admin update|closed identity mismatch observations' tests/supabase-auth-provider.test.ts`
  — RED 5 total / 0 pass / 5 fail. Loaded old/deadline observations still returned
  the former checkpoint shape, while subject/email mismatch terminated inside the
  adapter rather than entering the database-clock classification.
- With disposable PostgreSQL on localhost, the focused production command
  `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55447/core_agent_runtime node --import tsx --test --test-concurrency=1 --test-name-pattern='defer provider-started reset settlement' tests/postgres/production-composition.test.ts`
  — behavioral RED 1 total / 0 pass / 1 fail: the first DB-ahead/Gateway-behind
  valid-evidence case expected 200 but received 401 before Core. The initial
  sandbox-only localhost `EPERM` run is not counted as behavioral evidence.

### Round 11 GREEN and final verification

- The exact adapter focus is GREEN 5/5; the complete Gateway check is build plus
  98/98. Contracts are 180/180 with 86 valid and 11 invalid fixtures; Runtime Core
  is build plus 83/83. Root `test:unit` passes Runtime 192/192, Contracts 180/180,
  Runtime Core 83/83, Gateway 98/98, and Web 129/129 across nine files.
- The focused real Supabase/Fastify/PostgreSQL matrix is GREEN 1/1 across its 12
  observation branches. The full formal Gateway PostgreSQL package is GREEN 2/2
  in 3730.291791 ms, including the existing complete Tasks 3–6 production flow.
- `npm run test:runtime:database-ci-equivalent` is GREEN 3/3 in
  153833.880291 ms. Its fresh protected stage accepted the manifest's Runtime Core
  PostgreSQL 340, Gateway PostgreSQL 2, API PostgreSQL 14, and integration 93;
  injected-failure cleanup and output-leak redaction also passed. All labeled
  containers, volumes, and networks and the owned Round 11 database were absent
  after cleanup.
- Contracts history compatibility against the Task 7 base, exact package pins,
  sentinel secret scan, forbidden Gateway log/residual scan, `git diff --check`,
  and base diffs for Contracts 0.5 plus migrations 010/011 pass. Exact pins remain
  Fastify 5.11.2, Cookie 11.1.2, Supabase JS 2.112.2, and Contracts 0.6.0.
- SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  unmerged 012
  `42a2120802daa43b19f842e638e310c4285d927bc292186d996ff61af3d83767`.
- Root `npm run check` again passes Contracts, Core, Gateway, and API, then stops
  only at the unchanged Worker `project_platform_memberships` TS2345 diagnostics
  at `src/main.ts:60` and `src/main.ts:129`. The Worker source has no diff from the
  Task 7 base. `database-auth-topology` is 0/1 because its image build reaches the
  same diagnostics before topology execution; exact resource cleanup is empty.
- Round 11 implementation commit:
  `5984028b3` (`fix(identity): classify reset evidence with database clock`).
- No merge or push was performed.

## Round 10 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. Both remaining Provider-started settlement findings
are fixed through the pinned Supabase adapter and production Fastify/PostgreSQL
composition. The only failed formal gates are the unchanged Worker compile defect
and the already documented integration teardown-only database-drop failure.

### Delivered Round 10 corrections

- A `provider_started` password reset with the exact encrypted subject and exact
  normalized email, but Provider evidence predating the durable attempt, now
  returns the closed internal settlement checkpoint. It does not become a public
  success and does not mark the Provider operation completed.
- The adapter's former 30-second process-clock lease is removed. A concurrent loser
  cannot turn an arbitrarily long in-flight Provider update into a terminal 401 or
  clear the recovery Cookie merely because a Gateway clock advanced. Malformed or
  future evidence and subject/email mismatch remain immediate terminal failures.
- The internal checkpoint always reaches the existing production caller-owned
  serializable transaction. PostgreSQL `clock_timestamp()` alone decides whether
  settlement is still in progress (stable 503 with Cookie retained) or expired
  (commit `expired`, scrub every encrypted/checkpoint field, then terminal 401 and
  Cookie clear). No Provider effect occurs inside the retrying database phase.
- The real barrier test advances the Gateway clock beyond the removed lease while
  the winner remains inside the actual Supabase adapter exchange. The loser stays
  retryable; after the winner's forced Core rollback, the loser resumes the durable
  Provider checkpoint, revokes Sessions, and consumes the OAuth transaction without
  repeating exchange or password update. A separate clock-skew phase proves a DB
  clock one hour ahead of the Gateway still commits expiration and full scrub.
- No migration, public Contract, or formal test-count manifest changed in Round 10.

### Round 10 RED evidence

- From `apps/identity-gateway`,
  `node --import tsx --test --test-name-pattern='arbitrary adapter delay'
  tests/supabase-auth-provider.test.ts` — RED 1 total / 0 pass / 1 fail. The
  adapter returned `AUTH_CALLBACK_INVALID` instead of the internal settlement
  checkpoint after 30.001 seconds.
- The first disposable PostgreSQL package run reported 2 total / 0 pass / 2 fail.
  The scoped production test returned 401 rather than the required 503 for the
  long-running winner's loser. The other top-level failure was only strict config
  rejecting a password-bearing test URL and is not counted as behavior evidence;
  the database was recreated with host-trust and the exact no-password localhost
  URL used by repository gates.
- With the already captured loser assertion diagnostically admitted so execution
  could reach the second phase, the focused real Fastify/Supabase/PostgreSQL test
  was RED 1 total / 0 pass / 1 fail: the public response was terminal, but the DB
  row remained `pending/provider_started` with both encrypted subjects, payload
  hash, start time, and settlement deadline instead of committing expired/scrub.

### Round 10 GREEN and final verification

- Adapter focus — PASS 2/2 for causal checkpoint recovery and arbitrary adapter
  delay. `npm run check -w @core-agent/identity-gateway` — PASS build and 97/97.
  `npm run check -w @core-agent/runtime-core` — PASS build and 83/83.
  `npm run check -w @core-agent/contracts` — PASS 180/180, schema/compatibility
  checks, 86 valid fixtures and 11 invalid fixtures.
- Final disposable production run:
  `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55446/core_agent_runtime
  npm run test:postgres -w @core-agent/identity-gateway` — PASS 2/2 in
  4381.785 ms. It uses real `SupabaseAuthProvider`, the production OAuth store,
  envelope protector, operations, Fastify injection, and PostgreSQL.
- Root `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180, Runtime
  Core 83/83, Gateway 97/97, Web 129/129 across nine files. Contracts explicit
  history compatibility against the Task 7 base passed.
- `npm run test:runtime:database-ci-equivalent` reported 3 total / 2 pass / 1 fail
  in 164813.307333 ms. The protected PostgreSQL phase passed and advanced into the
  integration command; integration reported 94 total / 93 pass / 1 teardown-only
  failure in `agent-run.test.ts` after-hook database drop. Injected-failure cleanup
  and output-leak redaction passed. No identity behavior failed.
- Root `npm run check` again reaches Contracts, Core, Gateway, and API, then stops
  only at the unchanged Worker `project_platform_memberships` TS2345 errors at
  `main.ts:60` and `main.ts:129`. Database-auth topology is 0/1 because its image
  build stops at the same Worker errors before topology execution.
- `git diff --check`, sentinel secret scan, forbidden Gateway log scan, exact pin
  check, historical Contracts 0.5 and migration 010/011 base diffs, checksum scan,
  and final Docker labeled-resource/residual scans pass. Fastify 5.11.2, Cookie
  11.1.2, Supabase JS 2.112.2, and Contracts 0.6.0 remain exact.
- SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  unmerged 012
  `42a2120802daa43b19f842e638e310c4285d927bc292186d996ff61af3d83767`.
- Round 10 implementation commit:
  `49b34e6758f5232e6cb361c11c01e2bfbc59c49e`.
- No merge or push was performed.

## Round 9 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. Both remaining reset-settlement findings are fixed
through the pinned Supabase adapter and real Fastify/PostgreSQL production
composition. The unchanged Worker compile defect and two already reproduced
integration teardown-only failures remain outside Task 7 behavior.

### Delivered Round 9 corrections

- A loaded `provider_started` reset whose signed settlement binding has reached
  its deadline no longer fails inside the provider adapter. The adapter returns a
  closed internal settlement checkpoint without inspecting Provider evidence or
  repeating the Provider effect. Production composition locks the exact OAuth row
  in a caller-owned serializable transaction, uses `clock_timestamp()`, commits
  `expired`, replaces PKCE ciphertext with the non-secret sentinel, and clears
  expected/completed subject ciphertext, canonical payload hash, completion
  timestamps, evidence, and settlement deadline before the terminal public 401.
- A concurrent loser that initially loads a fresh `provider_started` row and sees
  the pre-effect Provider timestamp receives the retryable provider-unavailable
  result. The public route returns 503 and preserves the recovery Cookie. The
  fresh-attempt lease is bounded to 30 seconds from the durable database start;
  only old evidence inside that interval is retryable. Mismatched subject/email,
  malformed or future evidence, and evidence older than a non-fresh attempt remain
  terminal callback-invalid failures and clear the Cookie.
- The winning request still performs the Provider code exchange/password update
  exactly once and outside database retry. If its subsequent Core revocation rolls
  back, the loser retry loads the durable Provider checkpoint, skips Provider work,
  revokes every Core Session, consumes the transaction, and clears the Cookie.
- The formal Identity Gateway PostgreSQL manifest changed from 1 to 2 only after
  the complete disposable suite reported the observed 2/2 total.

### Round 9 RED evidence

- From `apps/identity-gateway`, `npm test --
  --test-name-pattern='Supabase password recovery settlement|freshly loaded
  provider-started'` ran the package's complete file set and was RED 97 total / 95
  pass / 2 fail. Expired `provider_started` returned `AUTH_CALLBACK_INVALID`
  instead of the settlement checkpoint; freshly loaded state with old evidence
  returned `AUTH_CALLBACK_INVALID` instead of retryable
  `AUTH_PROVIDER_UNAVAILABLE`.
- The first meaningful disposable PostgreSQL run was RED 2 total / 1 pass / 1
  fail: the expired public route returned 401 but left the row pending with its
  encrypted subject, hash, and timestamps. After ordering the barrier scenario
  before expiry, it was independently RED 2 total / 1 pass / 1 fail because the
  concurrent loser returned 401 instead of the required 503. An earlier attempt
  stopped only because the isolated database lacked prerequisite roles and is not
  counted as behavioral RED.

### Round 9 GREEN and final verification

- `npm run check -w @core-agent/identity-gateway` — PASS: build and 97/97.
  `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
  `npm run check -w @core-agent/contracts` — PASS: 180/180, generated schema and
  cumulative compatibility clean, 86 valid fixtures and 11 invalid fixtures.
- `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55445/core_agent_task7_r9
  npm run test:postgres -w @core-agent/identity-gateway` — PASS 2/2 in
  4747.6485 ms. The new test uses the real `SupabaseAuthProvider`, production
  OAuth store/envelope/composition, Fastify injection, and disposable PostgreSQL.
  It proves the expired durable scrub and the controlled winner/loser sequence,
  forced winner Core rollback, retained Cookie, loser recovery, Session revocation,
  transaction consumption, and exactly one Provider exchange/update.
- Root `npm run test:unit` — PASS: Runtime 192/192, Contracts 180/180, Runtime
  Core 83/83, Identity Gateway 97/97, Web 129/129 across nine files. The first
  sandbox attempt had only three `listen EPERM` environment failures; the required
  permitted rerun is the reported result.
- Direct root PostgreSQL reached Runtime Core 340 total / 339 pass / 1 expected
  protected-bootstrap failure because the disposable host-trust database has no
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE`; the separate Gateway suite passed
  2/2. `npm run test:runtime:database-ci-equivalent` reported 3 total / 2 pass / 1
  fail in 241898.956583 ms. Its protected stage accepted the exact Runtime Core
  340 + Gateway 2 + API 14 counts, then integration reported 94 total / 92 pass /
  2 teardown-only failures: the unchanged agent-run database-drop after-hook and
  unchanged harness-cleanup startup-delay classification. All identity behavior,
  injected cleanup, and output-leak scenarios passed; this repeatedly reproduced
  independent teardown condition was not blindly rerun.
- Root `npm run check` reaches the Gateway and API successfully, then stops at the
  unchanged Worker `project_platform_memberships` TS2345 errors at `main.ts:60`
  and `main.ts:129`. `npm run test:runtime:database-auth-topology` likewise stops
  during the Worker image build before topology execution. These files were not
  touched by Task 7.
- Contracts history compatibility, exact dependency pins, `git diff --check`,
  sentinel secret scan, forbidden Gateway log scan, historical Contracts 0.5 and
  migration 010/011 diffs, checksum scan, and final Docker residual scan pass.
  Fastify 5.11.2, Cookie 11.1.2, Supabase JS 2.112.2, and Contracts 0.6.0 remain
  exact. Migration 012 was unchanged in Round 9.
- SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  unmerged 012
  `42a2120802daa43b19f842e638e310c4285d927bc292186d996ff61af3d83767`.
- Round 9 implementation commit:
  `27162e2d8ead727ca3bcc4956b02c369809212e8`.
- No merge or push was performed.

## Round 8 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. All three Round 8 reset-state findings are fixed and
verified through schema-11 upgrade, pinned Supabase adapter, public Fastify, and
disposable PostgreSQL boundaries. The only concern remains the unchanged Worker
compile defect already documented in prior rounds; every Round 8 scoped gate passes.

### Delivered Round 8 corrections

- Migration 012 now admits a schema-11 `consumed` password-reset row only as an
  exact terminal legacy state: `provider_completion_status = pending` and every
  newly introduced subject/checkpoint/deadline field is null. It preserves status,
  `consumed_at`, and history. The constraint also explicitly binds new pending,
  provider-started, provider-completed, consumed, and expired combinations so a
  terminal legacy row cannot reacquire an expected-subject checkpoint.
- Recovery Cookie parsing authenticates the exact signed authorization and
  settlement deadlines without rejecting solely on wall time. The database clock
  remains the settlement authority. A durable provider-completed subject can pass
  the adapter at or after the settlement boundary only to reach Core settlement;
  no provider code exchange or password update is repeated.
- The Core expired branch now commits `status = expired`, replaces the encrypted
  PKCE material with a non-secret sentinel, and clears both subject ciphertexts,
  payload hash, completion timestamps, evidence, and settlement deadline before
  returning the stable terminal authentication error. The recovery Cookie is then
  cleared by the existing terminal-error policy.
- A completion caller that loaded pending state but loses the atomic provider-start
  admission now returns the existing retryable provider-unavailable result without
  inspecting premature evidence. It performs zero provider effect and preserves the
  Cookie. After the winner checkpoints provider completion—even when its Core phase
  rolls back—the loser retry loads the completed checkpoint, skips Provider work,
  revokes Sessions, and consumes the transaction.
- The formal Runtime Core PostgreSQL count manifest changed from 339 to 340 only
  after the complete direct suite reported the new observed total.

### Round 8 RED evidence

- Real schema-11 upgrade focus was RED 0/1: adding the schema-12 provider state
  constraint failed with PostgreSQL 23514 for a preserved consumed reset row.
- The recovery-Cookie deadline focus was RED 0/1 with `AUTH_INVALID` at the exact
  settlement boundary. The completed-checkpoint adapter focus was independently
  RED 0/1 with `AUTH_CALLBACK_INVALID`, proving the adapter also blocked Core.
- The concurrent-admission adapter focus was RED 0/1: actual
  `AUTH_CALLBACK_INVALID` versus the required retryable
  `AUTH_PROVIDER_UNAVAILABLE`; exchange and admin password-update counts remained
  zero.
- Real Fastify plus PostgreSQL was RED 0/1: an expired signed completion returned
  before the provider/Core boundary (`providerCalls = 0`) and left the OAuth row
  pending instead of durably terminalizing it.
- Schema self-review added a second genuine PostgreSQL RED 0/1 (`Missing expected
  rejection`): a legacy consumed row could reacquire expected-subject ciphertext
  through the overly broad pending branch. Explicit status combinations close it.

### Round 8 GREEN and final verification

- Focused GREEN: schema-11 consumed upgrade/terminal constraint 1/1; recovery
  Cookie 1/1; adapter expired-checkpoint plus concurrent-loser 2/2.
- `npm run check -w @core-agent/identity-gateway` — PASS: build and 96/96.
  `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
  `npm run check -w @core-agent/contracts` — PASS: 180/180, generated schemas and
  cumulative compatibility clean, 86 valid fixtures and 11 invalid fixtures.
- `CONTROL_PLANE_TEST_DATABASE_URL=postgresql://core_agent_ci@127.0.0.1:55441/core_agent_task7_r8
  npm run test:postgres -w @core-agent/identity-gateway` — PASS 1/1. The real
  Fastify/PostgreSQL test proves expired durable scrub plus 401/Cookie clear and a
  barrier-controlled sequence: loser 503/Cookie retained, one winner Provider
  update, forced winner Core rollback, loser retry, all Sessions revoked, OAuth
  transaction consumed, and no repeated Provider effect.
- Direct Runtime Core PostgreSQL reported 340 total / 339 pass / 1 fail. The sole
  failure is expected in this host-trust disposable database because
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE` is absent; all 340 behaviors,
  including the new schema-11 consumed upgrade, ran.
- `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in 151229.157 ms. The
  protected run asserted Runtime Core PostgreSQL 340, Identity Gateway PostgreSQL
  1, Control Plane API PostgreSQL 14, integration 93, injected-failure cleanup,
  and output-leak redaction.
- `npm run compat:history -w @core-agent/contracts -- --base
  e7624fe0425ff470b646f8322254d5e9e3857da8` — PASS. `git diff --check`, sentinel
  secret scan, forbidden Gateway log scan, exact pin check, Contracts 0.5 and
  migrations 010/011 base diffs, and final Docker residual scans pass. Fastify
  5.11.2, Cookie 11.1.2, and Supabase JS 2.112.2 remain exact.
- SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended unmerged 012 is
  `42a2120802daa43b19f842e638e310c4285d927bc292186d996ff61af3d83767`.
- Round 8 implementation commit:
  `4d180ce11ddeed5e937d88c280f9e8fff4e2f7e2`.
- No merge or push was performed.

## Round 7 review fixes (2026-08-18)

Status: `DONE_WITH_CONCERNS`. All Round 7 findings are implemented and verified
through the public Fastify boundary, installed Supabase 2.112.2 adapter boundary,
and disposable PostgreSQL composition. The only remaining repository gates are
still stopped by the unchanged Control Plane Worker compile defect described below.

### Delivered Round 7 corrections

- Session issuance now checks the verified authentication method against the
  active stored Core identity before idempotency admission or Session mutation.
  Password verification accepts only `email_password` or
  `email_password_apple`; Apple verification accepts only `apple` or the combined
  kind. Exact provider, subject, Actor, and active-state checks remain mandatory.
- Password reset has separate database-clock authorization and settlement
  deadlines. Provider exchange remains forbidden after the original authorization
  expiry, while an already durable `provider_completed` checkpoint may replay only
  Core Session revocation plus transaction consumption until the exact 30-minute
  settlement boundary. The signed recovery Cookie authenticates both deadlines.
- Reset start prebinds the exact expected Core provider subject without changing
  public enumeration behavior. Completion persists `provider_started`, canonical
  proof hash, attempt time, and settlement deadline before code exchange. Only the
  caller that atomically acquires that admission may exchange/update; a concurrent
  loser performs inspection-only recovery and never repeats the provider effect.
- Recovery accepts provider administration evidence only for the exact prebound
  subject and only when the password-update timestamp is at or after the durable
  attempt start, no later than database now, and within settlement. A crash before
  password update cannot claim revocation and permits a new reset; a crash after
  update but before checkpoint recovers, revokes every Core Session, and consumes
  the transaction on retry/restart.
- Every retryable public reset failure, including `AUTH_RATE_LIMITED` 429, retains
  the exact recovery Cookie. Success and terminal 400/401 failures clear it.
- The unmerged schema-12 OAuth state now stores the encrypted expected subject and
  bounded settlement deadline and expires legacy schema-11 pending reset rows that
  cannot satisfy the new binding. No password, code, raw subject, token, or Session
  secret is persisted. Migrations 010/011 and Contracts 0.5 remain unchanged.
- Self-review restored the accepted root compatibility snapshot for
  `reauthentication-request`; native `client_kind` remains present only in the
  additive current 0.6 release artifact, so compatibility history is append-only.

### Round 7 RED evidence

- Real Fastify/PostgreSQL method-compatibility assertions were RED because an
  Apple callback could issue a Session against an email-password-only AuthSubject,
  and a password subject could issue against an Apple-only row. The same suite also
  proved the combined-kind and B2B control cases after the fix.
- Reset PostgreSQL replay was RED with 401 after original authorization expiry even
  though provider completion had committed. Exact settlement-boundary and restart
  assertions also failed before schema 12 carried a separate deadline.
- Route focus for retryable recovery was RED 0/1 because 429 cleared the Cookie.
  Recovery-cookie security focus was RED 0/2 before both authenticated deadlines
  were signed and parsed.
- Supabase reset admission/prebinding focus was RED 0/2 before the exact expected
  subject and `provider_started` ordering existed. Crash-before-update could not
  safely distinguish an unused code, while crash-after-update had no causal
  checkpoint recovery path.
- Final concurrency self-review was genuine RED 0/1 (`Missing expected rejection`):
  a caller that lost provider-start admission could still invoke the provider.
  The store now returns explicit `acquired | existing`; only `acquired` performs
  exchange/update, and the identical focus is GREEN 1/1.

### Round 7 GREEN and final verification

- `npm run check -w @core-agent/identity-gateway` — PASS: build and 95/95. This
  includes the complete Supabase reset saga, one-use concurrent admission,
  retryable 429 Cookie behavior, method compatibility, and real-boundary route
  ordering tests.
- `npm run check -w @core-agent/contracts` — PASS: 180/180, generated schemas and
  cumulative compatibility clean, 86 valid fixtures and 11 invalid fixtures.
  `npm run check -w @core-agent/runtime-core` — PASS: build and 83/83.
- Real Fastify plus production composition on disposable PostgreSQL is PASS 1/1.
  It proves email-only rejects Apple until protected same-subject CAS combines the
  method, combined accepts Apple and password, Apple-only rejects password, and
  invited B2B onboarding remains unchanged. It also proves provider-completed reset
  settlement after authorization expiry, exact deadline failure, rollback/restart,
  all-Session revocation, and transaction consumption.
- Adapter tests prove crash before update leaves password and Core Sessions
  unchanged and permits a new reset; crash after update/checkpoint failure recovers
  from exact causal evidence; mismatched, old, future, and malformed evidence fail
  closed. Concurrent first completion invokes the provider exactly once.
- `npm run test:runtime:database-ci-equivalent` — PASS 3/3 in 142672 ms. Its
  protected summaries assert Runtime Core PostgreSQL 339, Identity Gateway
  PostgreSQL 1, Control Plane API PostgreSQL 14, integration 93, injected-failure
  cleanup, and output-leak redaction. A direct trust-only run observed 338/339; its
  sole failure was the intentionally unavailable password-authentication rejection
  in a host-trust database. The official protected run covers that case.
- `npm run compat:history -w @core-agent/contracts -- --base
  e7624fe0425ff470b646f8322254d5e9e3857da8` — PASS after the accepted snapshot
  restoration was committed. `git diff --check`, sentinel secret scan, forbidden
  gateway log scan, Contracts 0.5/010/011 base diffs, and exact pin checks pass.
  Fastify 5.11.2, Cookie 11.1.2, Supabase 2.112.2, and Contracts 0.6.0 are exact.
  Final exact label scans found zero database-CI containers, volumes, or networks;
  the disposable Round 7 PostgreSQL container and protected temporary password
  file were removed.
- SHA-256 remains 010
  `eb0b2e42ffacef5b16bee6aa1930824ee39317adf01f2f627ccf9c7ce589d381`;
  011 `fc9b7b131ba5c5faf8a4e04867776fa069b0db7d3cfb3049d8df1078a4433393`;
  amended unmerged 012 is
  `663e23fedca217cce340316229c50dd6b507caf5104815946f090c2e281f3980`.

### Remaining independent concern and commit

- Root `npm run check` reaches the Task 7 packages and API, then fails only at the
  untouched `apps/control-plane-worker/src/main.ts:60,129` with two TS2345 errors
  for the unhandled `project_platform_memberships` claimed-job variant.
  `npm run test:runtime:database-auth-topology` stops before topology execution at
  the same Worker image build. No Task 7 diff touches Worker or the harness.
- Round 7 implementation commit:
  `97078db1df594a573259f51bea2ca50c01467378`.
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
