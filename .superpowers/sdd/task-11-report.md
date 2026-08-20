# Task 11 — Provider replacement and end-to-end public/private identity boundary

## Status

COMPLETE_WITH_ENVIRONMENT_LIMITATIONS

- Branch: `feat/identity-provider-replacement-v1`
- Base: `45a6e28456`
- Date: 2026-08-20
- Implementation commit: `a00704613a`
- Production migrations 010/011/012 and accepted Contracts 0.5/0.6 releases remain byte-unchanged.

## Implemented

- Added `replaceAuthProviderSubject` as one Actor-first serializable transaction.
  It admits one canonical idempotent command, creates the replacement subject on
  the same Actor, revokes the prior subject, revokes every non-revoked Core
  Session, appends one tenant-scoped `auth_subject.replaced` ProductEvent,
  AuditEvent and Outbox row for each current active Membership, and completes
  idempotency last.
- Replacement accepts the current database identity kinds
  `email_password`, `apple`, and `email_password_apple`; provider subject
  collisions and stale versions fail closed with bounded errors.
- Real PostgreSQL tests prove exact replay, changed-payload conflict, collision
  rollback, stale-version rejection, concurrent convergence, public evidence
  redaction, and preservation of Actor, Tenant, Membership, Profile,
  Conversation, Runtime, existing Audit ID, and Entitlement snapshot reference.
- Added a deterministic in-process fake provider and real Fastify/PostgreSQL
  integration slices for B2C registration, B2B invitation-only onboarding,
  platform access across two companies, Cookie/CSRF, reauthentication, provider
  outage/non-enumeration, Session revocation, deletion recovery, and safe errors.
- Added an Ed25519 Trusted Context integration test using current PostgreSQL
  Actor/Membership/Profile authority and the actual Control Plane verifier;
  re-signed browser-forged Actor/role payloads are rejected.
- Added root `test:identity`, globbed serial integration discovery, default-CI
  identity execution, exact suite/count manifests, and fail-closed CI output
  markers. No real Supabase credentials enter default CI.
- Fixed the existing consultant-role tuple schema so TypeBox keeps exact tuple
  order while Fastify's Draft-7 response serializer can serialize valid arrays.

## TDD evidence

- Initial provider replacement RED: five PostgreSQL cases failed because the
  production export did not exist.
- Initial fake-provider integration RED: new B2C, B2B, and Trusted Context
  suites failed before their fake/composition existed.
- Integration exposed a real Fastify serialization defect: valid consultant role
  arrays returned a response serialization failure. The schema change was made
  only after that RED and retained strict TypeBox tuple validation.

## Fresh verification

- `npm run test:unit`: PASS.
  Runtime 193/193; Contracts 182/182; Runtime Core 89/89; Gateway 129/129;
  Web 153/153.
- `npm run check -w @core-agent/contracts`: PASS.
  182/182, schema drift PASS, 87 valid/11 invalid fixtures, compatibility PASS.
- `npm run check -w @core-agent/runtime-core`: PASS, 89/89.
- `npm run test:identity`: PASS, Gateway 129/129.
- Real PostgreSQL 17 replacement focus: PASS, 5/5.
- Real PostgreSQL 17 Gateway composition: PASS, 2/2.
- Real PostgreSQL 17 Control Plane API: PASS, 15/15.
- Real PostgreSQL 17 full integration clean rerun: PASS, 96/96.
- Real PostgreSQL 17 formal Runtime Core: 359 total, 358 pass, one environment
  failure because the local trust-only instance intentionally has no official
  `CONTROL_PLANE_TEST_DATABASE_PASSWORD_FILE`; all five Task 11 cases passed.
- Browser Playwright: PASS, 40 passed/2 configured skips across desktop,
  compact, and iPhone projects.
- Explicit compatibility history against `45a6e28456`: PASS.
- `git diff --check`, synthetic sentinel scan, immutable release/migration scan:
  PASS.

## Environment limitations and unrelated baseline

- Colima was deliberately removed before this task, so the Docker-based official
  SCRAM `database-ci-equivalent` topology cannot run locally. The workflow and
  exact expected counts are wired for GitHub CI, which must provide the final
  protected-topology proof after push.
- Root `npm run check` reaches Runtime Supervisor after Contracts, Runtime Core,
  Gateway, API, and Worker pass, then can fail rotating millisecond-deadline
  tests. The exact failures reproduce on untouched main at `45a6e28456`, and
  Task 11 has zero Runtime Supervisor source/test diff. They are not classified
  as Task 11 regressions.
