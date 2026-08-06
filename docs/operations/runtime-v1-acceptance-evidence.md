# Runtime v1 acceptance evidence

Evidence date: 2026-08-06

This record contains only synthetic identifiers, immutable image identities,
final states, event types/counts, and behavioral assertions. It contains no
prompt or assistant text, credential, authorization value, secret path,
customer name, student data, raw Docker inspection, or database row.

## Reviewed Hermes product release

- Source commit: `16de0df8bd8024958b1e12d2c802f21e1c5512d7`
- Release: private GHCR `v0.1.3`
- Publish workflow: [GitHub Actions run 31089294718](https://github.com/Weiyuan305/Core-Agent/actions/runs/31089294718)
- Multi-platform index: `sha256:3f20fc2a6500f529a912d991134e3a55e9878678d833f25ccb008549c67f89bf`
- `linux/amd64`: `sha256:421f09a140d5b048586749d9f9753f3a2d3fa8571cebac462ae503c646ccb93e`
- `linux/arm64`: `sha256:518bc0734d94c44760a62368a2dbb633ebce511a73534ab987aa621862d2a7be`
- The release workflow's lock artifact was copied unchanged to
  `infra/hermes/product-images.lock.json`; a byte comparison passed, package
  visibility was confirmed `private`, and the locked arm64 digest pulled into
  the selected daemon.

## Target-platform strict smoke

- Host/runtime: macOS, Colima, `linux/arm64`
- Provider transport: managed custom provider using `chat_completions`
- Tenant: `synthetic-runtime-v1-f893baa74c06db30`
- Profile: `synthetic-runtime-v1-profile-f893baa74c06db30`
- Runtime: `runtime_b258256e2f2eeb26ba2997ba25b7c7c3`
- Conversation: `conversation_bbad3e918b294c23dd5871c427029a83`
- Run: `run_8ccdd7c55c15f89354e20ce65e6d0bf3`
- Final Runtime state: `ready`
- Final Run status: `succeeded`
- Assistant message count: `1`
- Terminal event ordering: `message.completed`, then `run.completed`
- Ordered stages completed: `PREFLIGHT`, `TOPOLOGY`, `PROVISION`, `RUN`,
  `CLEANUP`

The strict smoke exercised real PostgreSQL migration/readiness, API, Worker,
Supervisor, private Hermes Runtime provisioning, the selected HTTPS provider,
durable SSE, exact managed-container inspection, database/container no-secret
scans, and ordered default cleanup.

## Clean-checkout quality gates

- Verified commit: `6c093b4a1091153d5fc8ce2a103ff0c266e5efea`
- Runtime Contract: [GitHub Actions run 31091492854](https://github.com/Weiyuan305/Core-Agent/actions/runs/31091492854)
- Passing jobs: `contract`, `unit`, `postgres`, `integration`, `compose`
- The PostgreSQL job completed the real migration/repository suites and database
  sentinel scan. The Integration job completed duplicate provisioning, fake
  Supervisor/Hermes vertical-slice, recovery, security, and evidence scans from
  a fresh checkout.

## Interactive lifecycle acceptance

The anonymous synthetic interactive client completed all of these assertions
without persisting a transcript:

- a first prompt produced a successful assistant result;
- a follow-up in the same Conversation recalled the synthetic context;
- `/new` created a distinct Conversation that did not inherit that context;
- `/restart` recreated API and Worker, reached readiness, and a subsequent Run
  succeeded while PostgreSQL, Supervisor, Hermes Runtime, and Conversation were
  preserved;
- `/exit` entered the normal bounded cleanup path and the client exited with
  status `0`.

After cleanup, the exact Compose project had no running services and no managed
Runtime container remained. Tenant data volumes, the PostgreSQL volume, the
Supervisor socket volume, and permanent journal guards were retained by their
documented durability contracts; no broad or recursive deletion was used.

## Acceptance matrix

“Pass” means the required automated or target-platform gate actually ran for
this evidence revision. A pending result is not inferred from specification
tests alone.

| Criterion | Automated evidence | Target-platform evidence | Result |
| --- | --- | --- | --- |
| AC1 migrations/readiness | PostgreSQL migration and API health suites | Real migration completed; API, Worker, and dependencies reached readiness | **Pass** |
| AC2 idempotent provisioning | Clean CI ran `tests/integration/provisioning.test.ts` duplicate request/resource assertions | One real deterministic provisioning completed; fresh-checkout duplicate replay also passed | **Pass** |
| AC3 isolated healthy runtime | Supervisor adapter/policy and Compose topology suites | Managed arm64 container passed exact labels, digest, private-network, command, and readiness inspection | **Pass** |
| AC4 accepted Profile Run | Conversation/Run admission and full-slice suites | Real Profile Run reached `succeeded` with one assistant message | **Pass** |
| AC5 ordered durable SSE | API SSE and ProductEvent scope/bounds suites | PostgreSQL-backed event stream ended with `message.completed`, `run.completed` | **Pass** |
| AC6 restart recovery | Recovery, lease, cursor, and restart unit/integration coverage | `/restart` preserved state and the next real Run succeeded | **Pass** |
| AC7 fail-closed boundaries | Supervisor unsafe-operation matrix, auth tests, static security topology, and bounded-error tests ran locally | Exact image, container, context, socket, path, secret, and network inspections passed before mutation | **Pass** |
| AC8 no secret leakage | Synthetic sentinel, tracked-evidence, database-surface, and output-allowlist scanners | Real smoke scanned database and container surfaces and emitted only allowlisted metadata | **Pass** |
| AC9 CI quality gates | Split contract/unit/PostgreSQL/integration/Compose workflow passed with pinned actions and images | Run 31091492854 passed all five jobs from a fresh checkout | **Pass** |
| AC10 real Hermes response | Opt-in smoke structure, product-lock, inspection, SSE, child-process, and cleanup suites | Reviewed arm64 product digest returned a non-empty assistant result and cleanup completed | **Pass** |

Future evidence updates must not add logs, prompts, responses, keys, raw
dependency output, Docker JSON, database rows, or secret paths.
