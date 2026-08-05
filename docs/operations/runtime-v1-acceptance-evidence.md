# Runtime v1 acceptance evidence

This release commit records deterministic evidence only. No real Hermes smoke
was run while producing this file: the current repository Hermes lock is the
official base-image build input, not a reviewed Core-Agent product-image lock,
and no target-platform product RepoDigest or real provider execution was
authorized. Consequently AC10 is explicitly pending. This file contains no
real resource ID, response, credential, customer name, or student data.

“Pass” below means the criterion has release-blocking automated evidence in the
repository. A manual column marked “Not run” is not a claim that an operator
performed the real smoke.

| Criterion | Automated evidence | Manual evidence | Result |
| --- | --- | --- | --- |
| AC1 migrations/readiness | `packages/runtime-core/tests/migrations.test.ts`; `apps/control-plane-api/tests/health.test.ts` | Not run; real-smoke readiness remains part of AC10 | Pass |
| AC2 idempotent provisioning | `tests/integration/provisioning.test.ts` duplicate request/resource assertions | Not run; no real Docker resource count recorded | Pass |
| AC3 isolated healthy runtime | Supervisor Docker adapter/policy tests and `tests/runtime/control-plane-compose.test.mjs` | Not run; no target managed-container inspection recorded | Pass |
| AC4 accepted Profile Run | API Conversation/Run admission tests and `tests/integration/agent-run.test.ts` | Not run; no real Run ID/status recorded | Pass |
| AC5 ordered durable SSE | API SSE tests and the ordered event assertion in `tests/integration/agent-run.test.ts` | Not run; no real event-type list recorded | Pass |
| AC6 restart recovery | `tests/integration/recovery.test.ts` API/Worker restart, lease reclaim, and cursor resume | Not run; no target restart note recorded | Pass |
| AC7 fail-closed boundaries | `tests/integration/security.test.ts`, Supervisor policy tests, auth tests, and Compose static security matrix | Not run; no manual rejected-command summary recorded | Pass |
| AC8 no secret leakage | synthetic sentinel assertions, `scripts/scan-runtime-database.mjs`, and smoke structure/sentinel tests | Not run; no target Docker/database dump scan recorded | Pass |
| AC9 CI quality gates | `.github/workflows/runtime-contract.yml` split contract/unit/PostgreSQL/integration/Compose jobs and static pin checks | Compose config is validated deterministically; no Compose service was started for this evidence | Pass |
| AC10 real Hermes response | `tests/runtime/runtime-contract.test.mjs` opt-in, output allowlist, secure file, product-lock, inspection, child-process, and cleanup structure tests | Not run; requires a reviewed product RepoDigest, target platform, and provider execution | **Pending real smoke** |

When AC10 is eventually executed, append a separate allowlisted record with
only platform, locked digests, timestamp, tenant/profile/runtime/conversation/
Run IDs, final runtime and Run states, event types, and assistant message count.
Do not add prompt/response content, keys, authorization, raw dependency output,
Docker JSON, database rows, or secret paths. Mark AC10 Pass only after that
record shows a non-empty assistant result and all cleanup assertions pass.
