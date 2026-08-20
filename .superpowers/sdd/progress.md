# Identity Runtime V1 Progress

## Task 7 — Public Identity Gateway

- Status: DONE_WITH_CONCERNS
- Branch: `feat/identity-gateway-v1`
- Base: `e7624fe0425ff470b646f8322254d5e9e3857da8`
- Brief: `.superpowers/sdd/task-7-brief.md`
- Baseline: Contracts 179/179 with fixtures 84/11; Identity Gateway 28/28.
- Current phase: Round 22 closed Apple start responses and final authorization-URL bounds implemented and verified;
  ready for cumulative parent review.
- User-approved amendment: forward-only schema 12 adds durable encrypted
  email-verification/start-idempotency authority; Entitlement reservation moved to
  schema 13. Historical 010/011 and Contracts 0.5.0 are untouched.
- Constraints: exact Fastify/Cookie/Supabase pins; Web/native credential separation;
  server-derived authority; Task 6 same-transaction guard for protected mutation;
  provider effects outside automatically retried transactions; Task 9 deletion
  explicitly unavailable; no provider or internal-detail leakage.
- Result: Contracts 0.6.0 182/182 with fixtures 87/11; Runtime Core 83/83;
  Identity Gateway 127/127; real Fastify plus pinned Supabase adapter and PostgreSQL
  production composition 2/2. The Round 22 official CI-equivalent is fully green
  3/3 and accepted Runtime Core 344 + Gateway 2 + API 14 + integration 93.
- Concern: the untouched Control Plane Worker still has the two existing
  `project_platform_memberships` TS2345 errors, so root check and
  database-auth-topology stop at that independent build before topology execution.
- Original commit: `2240a1bb0645e50a22204783f7cac5362924d906`
- Review-fix implementation commit: `00937575b9e0caa310526567bccd4bd281173f65`
- Round 2 implementation commit: `d92335a9f`
- Round 3 implementation commit: `3a5631da34d28be247a69639c01255c04a03e54a`
- Round 4 implementation commit: `7834f552c2b6dac9ed9a836f96c9bef97b00b457`
- Round 5 implementation commit: `a90623fde99da4ba7fa5306ed3e0a0861b9bd175`
- Round 6 implementation commit: `1799d50a612f08da97031cefcc3d3212db6bd949`
- Round 7 implementation commit: `97078db1df594a573259f51bea2ca50c01467378`
- Round 8 implementation commit: `4d180ce11ddeed5e937d88c280f9e8fff4e2f7e2`
- Round 9 implementation commit: `27162e2d8ead727ca3bcc4956b02c369809212e8`
- Round 10 implementation commit: `49b34e6758f5232e6cb361c11c01e2bfbc59c49e`
- Round 11 implementation commit: `5984028b3`
- Round 12 implementation commit: `6660f03bd`
- Round 13 implementation commit: `0d0b692e0`.
- Round 14 implementation commit: `ce9269ce2`.
- Round 15 implementation commit: `b346bf60a`.
- Round 16 implementation commit: `7af365f2b`.
- Round 17 implementation commit: `2a9fb545b`.
- Round 18 implementation commit: `dddf1d20c`.
- Round 19 implementation commit: `e24417eff`.
- Round 20 implementation commit: `aab077094`.
- Round 21 implementation commit: `67dbda57c`.
- Round 22 implementation commit: `b2dde3d27`.

## Task 8 — Cryptographically real Trusted Context

- Status: COMPLETE
- Branch: `feat/identity-trusted-context-v1`
- Base: `3dbdd33b28`
- Result: Ed25519 canonical signing/verification, protected signing-key loading,
  current database authority issuance, key rotation, alternate Control Plane auth,
  bootstrap-only operations, signed Conversation/Run/SSE admission, and expiry-bound
  SSE streams are implemented.
- Verification: root check PASS; root unit PASS; Runtime Core protected PostgreSQL
  347/347; Control Plane API PostgreSQL 15/15; integration clean rerun 93/93.
- Environment: native disposable PostgreSQL 17 with SCRAM; no Colima/Docker.
- Report: `.superpowers/sdd/task-8-report.md`.
- Implementation commit: `3597901191`.

## Task 11 — Provider replacement and full identity boundary

- Status: COMPLETE_WITH_ENVIRONMENT_LIMITATIONS
- Branch: `feat/identity-provider-replacement-v1`
- Base: `45a6e28456`
- Result: deterministic fake-provider B2C/B2B slices, real PostgreSQL provider
  replacement without business-ID rewrites, current-authority Ed25519 Control
  Plane verification, and default-CI identity wiring are implemented.
- Verification: unit Runtime193/Contracts182/Core89/Gateway129/Web153; Contracts
  full check; replacement PG5; Gateway PG2; API PG15; integration96; browser40
  with 2 configured skips; compatibility/history/scans pass.
- Environment: local PostgreSQL 17 is real but trust-only; Colima/Docker is absent,
  so GitHub CI remains the final protected SCRAM topology proof.
- Report: `.superpowers/sdd/task-11-report.md`.
- Implementation commit: `a00704613a`.
