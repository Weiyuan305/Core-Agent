# Identity Runtime V1 Progress

## Task 7 — Public Identity Gateway

- Status: DONE_WITH_CONCERNS
- Branch: `feat/identity-gateway-v1`
- Base: `e7624fe0425ff470b646f8322254d5e9e3857da8`
- Brief: `.superpowers/sdd/task-7-brief.md`
- Baseline: Contracts 179/179 with fixtures 84/11; Identity Gateway 28/28.
- Current phase: Round 3 review fixes implemented and verified; ready for parent review.
- User-approved amendment: forward-only schema 12 adds durable encrypted
  email-verification/start-idempotency authority; Entitlement reservation moved to
  schema 13. Historical 010/011 and Contracts 0.5.0 are untouched.
- Constraints: exact Fastify/Cookie/Supabase pins; Web/native credential separation;
  server-derived authority; Task 6 same-transaction guard for protected mutation;
  provider effects outside automatically retried transactions; Task 9 deletion
  explicitly unavailable; no provider or internal-detail leakage.
- Result: Contracts 0.6.0 180/180 with fixtures 85/11; Runtime Core 82/82;
  Identity Gateway 79/79; root unit Runtime 192, Contracts 180, Runtime Core 82,
  Gateway 79, Web 129; real PostgreSQL composition 1/1; protected official
  PostgreSQL phases pass counts 338 + 1 + 14 before integration teardown.
- Concern: two fresh official CI-equivalent runs repeated an untouched
  `agent-run.test.ts` database-drop teardown failure (the second also hit the
  untouched harness force-termination cleanup test). Untouched Control Plane
  Worker still has the two existing `project_platform_memberships` TS2345 errors,
  so root check and database-auth-topology stop at that independent build.
- Original commit: `2240a1bb0645e50a22204783f7cac5362924d906`
- Review-fix implementation commit: `00937575b9e0caa310526567bccd4bd281173f65`
- Round 2 implementation commit: `d92335a9f`
- Round 3 implementation commit: `3a5631da34d28be247a69639c01255c04a03e54a`
