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

## Task 12 — Provider acceptance and release evidence

- Status: COMPLETE_WITH_PROVIDER_ACCEPTANCE_PENDING
- Branch: `feat/identity-provider-acceptance-v1`
- Base: `4d5c0335d1b21b66f1a3983fae7cecfb6216fac9`
- Result: opt-in closed-report Supabase/Apple acceptance driver, report scanner,
  deployment/rollback/rotation operations guide, threat-model/testing evidence,
  and deterministic final release gates are implemented.
- Verification: root check PASS; root unit Runtime200/Contracts182/Core90/Gateway129/Web153;
  browser40 with2 configured skips; acceptance7; cleanup48; official protected
  database CI3/3 with Runtime Core359/Gateway2/API15/integration98.
- Provider status: live Supabase/Apple acceptance NOT_RUN; public deployment remains
  NO-GO until an approved disposable run produces a scanner-approved passed report
  and exact provider cleanup proof.
- Report: `.superpowers/sdd/task-12-report.md`.
- Implementation commit: `b1454ea63a55adc83b330eb50fc012b16b129a75`.

## Entitlement and Capability Registry v1 — Task 1 Contracts

- Status: COMPLETE
- Branch: `feat/entitlement-capability-contracts-v1`
- Base: `9f7c5c0516bea648770a4e73be28c736acf4a0bb`
- Plan-version amendment: `6288395858` (`@core-agent/contracts` 0.7.0; 0.6.0 is already released).
- Implementation head: `fd2ffe8f3e24d05a41cc39b1e0b197f1a44c838a`.
- Result: Capability, Pack, Entitlement, Assignment, Snapshot, public summary,
  event/error, and tenant/profile-bound entitlement-aware Trusted Context
  contracts are published as the exact 0.7.0 release.
- Verification: Contracts 232/232; fixtures 106 valid/11 invalid; schema,
  compatibility, compatibility-history, historical 0.2-0.6 immutability,
  106-schema release exactness, secret, and diff gates pass.
- Reviews: Task review and cumulative whole-branch review approved with zero
  Critical, Important, or Minor findings; final assessment is Ready to merge.

## Entitlement and Capability Registry v1 — Task 2 Schema 13 Storage

- Status: COMPLETE
- Branch: `feat/entitlement-capability-schema-v1`
- Base: `1f18ded803f84b34b7226900bf1e99b526f9062d`
- Implementation head: `766de759fad2ad2683df7bb30bb959f2e9d89105`.
- Result: schema 13 now owns the reviewed Capability/Pack catalog, Tenant releases,
  Entitlements, B2B seats and Assignments, deterministic immutable effective
  Snapshots, current Profile pointers, Runtime projections/activity, and the two
  new Worker job kinds. Direct SQL is constrained by exact catalog admission,
  tenant-safe authority, database-clock currentness, complete Snapshot union/hash
  validation, monotonic pointer CAS, forward-only release state, least privilege,
  and one Entitlement-to-Profile lock order.
- Verification: root `check` PASS; root unit Runtime 200/200, Contracts 233/233,
  Runtime Core 90/90, Gateway 129/129, Web 153/153; fresh native PostgreSQL 17
  runtime 402/402, Gateway 2/2, API 15/15; integration 98/98. Contracts schema,
  fixtures, compatibility, and history gates pass. Migration 013 SHA-256 and
  manifest are `b2bf71c90115f32ee7c2f8ac270fcc598b6cdae9a27168c64beaa3f681ba181d`;
  migrations 010-012 and accepted Contracts 0.7 artifacts are unchanged.
- Reviews: six evidence-driven review/fix rounds closed Snapshot authority,
  catalog, seat, currentness, ACL, state-machine, cross-language canonicalization,
  and concurrency gaps. Final review found zero Critical, Important, or Minor
  findings and assessed the branch Ready.
- Constraint: the Docker/Colima-only wrapper was not run; its native PostgreSQL,
  integration, count, marker, secret, and cleanup-equivalent gates were run
  directly without Docker.
- Report: `.superpowers/sdd/task-2-report.md`.

## Entitlement and Capability Registry v1 — Task 3 Catalog Review/Publication

- Status: COMPLETE.
- Branch: `feat/entitlement-capability-catalog-v1`.
- Base: `ce3f002706d0d34f7039fea47ad70d9b3219848b`.
- Implementation head before this progress record: `10055156373f`.
- Result: immutable Capability/Pack draft, review, publish, retire, and block
  services; stable idempotency/error mapping; platform audit; validated
  ProductEvent/Transactional Outbox; affected-release recomputation; hostile
  input budgets; and deterministic multi-Actor catalog lock ordering.
- Approved amendments: immutable Contracts 0.8.0 adds nine closed catalog
  lifecycle events; forward migration 014 aligns PostgreSQL immutable-artifact
  admission with the released Contracts grammar. Historical Contracts 0.2.0–0.7.0
  releases and migrations 001–013 remain unchanged.
- Verification: Contracts 234/234 with 107 valid/11 invalid fixtures; Runtime Core
  90/90; root unit 806/806; fresh native PostgreSQL 17 catalog/security 24/24;
  protected SCRAM migration and entitlement schema 169/169; compatibility history,
  historical immutability, secret, and diff checks PASS.
- Reviews: task review and cumulative whole-branch review approved with zero
  Critical, Important, or Minor findings; final assessment is Ready to merge.
- Report: `.superpowers/sdd/task-3-report.md`.
