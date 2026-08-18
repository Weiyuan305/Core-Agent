# Identity Runtime V1 Progress

## Task 7 — Public Identity Gateway

- Status: DONE_WITH_CONCERNS
- Branch: `feat/identity-gateway-v1`
- Base: `e7624fe0425ff470b646f8322254d5e9e3857da8`
- Brief: `.superpowers/sdd/task-7-brief.md`
- Baseline: Contracts 179/179 with fixtures 84/11; Identity Gateway 28/28.
- Current phase: review fixes implemented and fully verified; ready for parent review.
- User-approved amendment: forward-only schema 12 adds durable encrypted
  email-verification/start-idempotency authority; Entitlement reservation moved to
  schema 13. Historical 010/011 and Contracts 0.5.0 are untouched.
- Constraints: exact Fastify/Cookie/Supabase pins; Web/native credential separation;
  server-derived authority; Task 6 same-transaction guard for protected mutation;
  provider effects outside automatically retried transactions; Task 9 deletion
  explicitly unavailable; no provider or internal-detail leakage.
- Result: Contracts 0.6.0 180/180 with fixtures 85/11; Runtime Core 81/81;
  Identity Gateway 69/69; root unit Runtime 192, Contracts 180, Runtime Core 81,
  Gateway 69, Web 129; real PostgreSQL composition 1/1; official disposable
  PostgreSQL CI-equivalent 3/3 with counts 328 + 1 + 14 + 93.
- Concern: untouched Control Plane Worker has two existing `project_platform_memberships`
  dispatcher TS2345 errors, so root check and database-auth-topology stop at that
  independent build. Task 7 gates and official fresh database CI pass.
- Original commit: `2240a1bb0645e50a22204783f7cac5362924d906`
- Review-fix implementation commit: `00937575b9e0caa310526567bccd4bd281173f65`
