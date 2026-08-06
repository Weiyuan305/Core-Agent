# Runtime v1 acceptance evidence

This release commit records deterministic specification evidence only. No local
PostgreSQL suite, Docker/Colima topology, Linux startup, or real Hermes/provider
smoke was run while producing this file. The current repository Hermes lock is
the official base-image build input, not a reviewed Core-Agent product-image
lock, and no target-platform product RepoDigest or provider execution was
authorized. Runtime-dependent criteria remain Pending until their required
systems actually run. This file contains no real resource ID, response,
credential, customer name, or student data.

Committed automated tests are specifications, not proof that an unrun dependency
worked. “Pass” below is reserved for a criterion whose required gate actually
ran for this evidence revision. A manual column marked “Not run” is not a claim
that an operator performed the real smoke.

| Criterion | Automated evidence | Manual evidence | Result |
| --- | --- | --- | --- |
| AC1 migrations/readiness | `packages/runtime-core/tests/migrations.test.ts`; `apps/control-plane-api/tests/health.test.ts` | Not run; PostgreSQL/readiness evidence absent | **Pending runtime evidence** |
| AC2 idempotent provisioning | `tests/integration/provisioning.test.ts` duplicate request/resource assertions | Not run; PostgreSQL and real Docker resource evidence absent | **Pending runtime evidence** |
| AC3 isolated healthy runtime | Supervisor Docker adapter/policy tests and `tests/runtime/control-plane-compose.test.mjs` | Not run; no Linux/Colima preflight or managed-container inspection | **Pending runtime evidence** |
| AC4 accepted Profile Run | API Conversation/Run admission tests and `tests/integration/agent-run.test.ts` | Not run; no real Hermes/provider Run | **Pending runtime evidence** |
| AC5 ordered durable SSE | API SSE tests and the ordered event assertion in `tests/integration/agent-run.test.ts` | Not run; no PostgreSQL-backed real event stream | **Pending runtime evidence** |
| AC6 restart recovery | `tests/integration/recovery.test.ts` API/Worker restart, lease reclaim, and cursor resume | Not run; no PostgreSQL/Docker restart exercise | **Pending runtime evidence** |
| AC7 fail-closed boundaries | `tests/integration/security.test.ts`, Supervisor policy tests, auth tests, and Compose static security matrix | Not run; no target rejected-command exercise | **Pending runtime evidence** |
| AC8 no secret leakage | synthetic sentinel assertions, `scripts/scan-runtime-database.mjs`, and smoke structure/sentinel tests | Not run; no target Docker/database dump scan | **Pending runtime evidence** |
| AC9 CI quality gates | `.github/workflows/runtime-contract.yml` split contract/unit/PostgreSQL/integration/Compose jobs and static pin checks | Compose config is validated deterministically; no Compose service was started for this evidence | Pass |
| AC10 real Hermes response | `tests/runtime/runtime-contract.test.mjs` opt-in, output allowlist, secure file, product-lock, inspection, child-process, and cleanup structure tests | Not run; requires a reviewed product RepoDigest, target platform, and provider execution | **Pending real smoke** |

When AC10 is eventually executed, append a separate allowlisted record with
only platform, locked digests, timestamp, tenant/profile/runtime/conversation/
Run IDs, final runtime and Run states, event types, and assistant message count.
Do not add prompt/response content, keys, authorization, raw dependency output,
Docker JSON, database rows, or secret paths. Mark AC10 Pass only after that
record shows a non-empty assistant result and all cleanup assertions pass.
