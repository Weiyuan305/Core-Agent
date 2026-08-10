# Runtime v1 acceptance evidence

Evidence date: 2026-08-06

This record contains only synthetic identifiers, immutable image identities,
final states, event types/counts, and behavioral assertions. It contains no
prompt or assistant text, credential, authorization value, secret path,
customer name, student data, raw Docker inspection, or database row.

## Reviewed Hermes product release

- Source commit: `efbe21450b3dd4947eb2653797886a3939857663`
- Upstream Hermes commit: `cc4cab2f592e60a197e796506de9168f74baf3ea`
- Release: private GHCR `v0.1.4`; companion tag `sha-efbe21450b3d`
- Publish workflow: [GitHub Actions run 31362734548](https://github.com/Weiyuan305/Core-Agent/actions/runs/31362734548)
- Multi-platform index: `sha256:dd8f3e83cdc22778c023dfea3cb7d216b7d7eed9ece46d671561060a7b61a0c8`
- `linux/amd64`: `sha256:5197bf0afa7e9b5e95dd46d186f2ac4d657e23eac16e31f3bba89cda64d2aa6a`
- `linux/arm64`: `sha256:4fe870e2fb174726cb43994433b5b9b171d2ffd4cb05121c9a00e7b4b133e646`
- The release workflow's lock artifact was copied unchanged to
  `infra/hermes/product-images.lock.json`; a byte comparison passed, package
  visibility was confirmed `private`, and the locked arm64 digest pulled into
  the selected daemon.
- Independent registry review confirmed both immutable tags resolve to the same
  index, both platform descriptors match the artifact, and both images carry
  the exact Core-Agent, upstream Hermes, and release labels.

### Rollback point

- Previous release: private GHCR `v0.1.3`
- Previous `linux/amd64`:
  `sha256:421f09a140d5b048586749d9f9753f3a2d3fa8571cebac462ae503c646ccb93e`
- Previous `linux/arm64`:
  `sha256:518bc0734d94c44760a62368a2dbb633ebce511a73534ab987aa621862d2a7be`
- Rollback selects the previous reviewed platform reference through the normal
  Runtime lifecycle and increments Runtime generation. It does not retag,
  rebuild, or roll the schema-aware Control Plane backward.

## Target-platform strict smoke

- Host/runtime: macOS, Colima, `linux/arm64`
- Provider transport: managed custom provider using `chat_completions`
- Tenant: `synthetic-runtime-v1-74303bd1ca7058b8`
- Profile: `synthetic-runtime-v1-profile-74303bd1ca7058b8`
- Runtime: `runtime_6f876eb4d652707431c7942faf464f3f`
- Conversation: `conversation_f7d863153ecabb7293e568286e758919`
- Run: `run_912ab791f130b96a69a521f041cf2704`
- Final Runtime state: `ready`
- Final Run status: `succeeded`
- Assistant message count: `1`
- Terminal event ordering: `message.completed`, then `run.completed`
- Ordered successful stages: `PREFLIGHT`, `TOPOLOGY`, `PROVISION`, `RUN`
- Exact-target cleanup state: `completed`

The strict smoke exercised real PostgreSQL migration/readiness, API, Worker,
Supervisor, private source-built Hermes Runtime provisioning, the selected
HTTPS provider, durable SSE, exact managed-container inspection,
database/container no-secret scans, and ordered cleanup. A retained diagnostic
run was released through the exact-target receipt path; the final state had no
smoke Compose container or managed runtime-v1 container.

## Clean-checkout quality gates

- Verified commit: `efbe21450b3dd4947eb2653797886a3939857663`
- Runtime Contract: [GitHub Actions run 31361949133](https://github.com/Weiyuan305/Core-Agent/actions/runs/31361949133)
- Passing jobs: `contract`, `unit`, `postgres`, `integration`, `compose`,
  `web-browser`
- The PostgreSQL job completed the real migration/repository suites and database
  sentinel scan. The Integration job completed duplicate provisioning, fake
  Supervisor/Hermes vertical-slice, recovery, security, and evidence scans from
  a fresh checkout.

## Local Web lifecycle acceptance

The loopback-only consultant Web canary completed these assertions without
persisting a transcript:

- two Runs in the same Conversation each produced a non-empty completed output;
- the second Run exposed a streaming state and non-empty partial delivery before
  completion;
- New Conversation selected one distinct Conversation while the earlier two
  browser-memory turns remained available;
- API/Worker restart completed with no user-facing error and a Run in the
  selected Conversation succeeded afterward;
- the `390x844` viewport kept navigation, transcript, textarea, and send action
  inside the viewport with no horizontal overflow;
- browser console warning/error count was `0`.

Source-built Hermes cold start is covered by a bounded readiness transport
window: one probe retries at `250ms` intervals within its existing `10s`
deadline, while HTTP rejection, caller cancellation, and terminal timeout stay
fail-closed. The Worker build and all `84` Worker tests passed before the final
cold Web start reached `WEB_READY`.

After normal Web shutdown, the exact Compose project had no container and no
managed Runtime container remained. Tenant data volumes, the PostgreSQL volume,
the Supervisor socket volume, and permanent journal guards were retained by
their documented durability contracts; no broad or recursive deletion was
used.

## Acceptance matrix

“Pass” means the required automated or target-platform gate actually ran for
this evidence revision. A pending result is not inferred from specification
tests alone.

| Criterion | Automated evidence | Target-platform evidence | Result |
| --- | --- | --- | --- |
| AC1 migrations/readiness | PostgreSQL migration and API health suites | Real migration completed; API, Worker, and dependencies reached readiness | **Pass** |
| AC2 idempotent provisioning | Clean CI ran `tests/integration/provisioning.test.ts` duplicate request/resource assertions | One real deterministic provisioning completed; fresh-checkout duplicate replay also passed | **Pass** |
| AC3 isolated healthy runtime | Supervisor adapter/policy and Compose topology suites | Managed source-built arm64 container passed exact labels, digest, private-network, command, and readiness inspection | **Pass** |
| AC4 accepted Profile Run | Conversation/Run admission and full-slice suites | Real Profile Run reached `succeeded` with one assistant message | **Pass** |
| AC5 ordered durable SSE | API SSE and ProductEvent scope/bounds suites | PostgreSQL-backed event stream ended with `message.completed`, `run.completed` | **Pass** |
| AC6 restart recovery | Recovery, lease, cursor, and restart unit/integration coverage | Web API/Worker restart preserved the selected Conversation and the next real Run succeeded | **Pass** |
| AC7 fail-closed boundaries | Supervisor unsafe-operation matrix, auth tests, static security topology, and bounded-error tests ran locally | Exact image, container, context, socket, path, secret, and network inspections passed before mutation | **Pass** |
| AC8 no secret leakage | Synthetic sentinel, tracked-evidence, database-surface, and output-allowlist scanners | Real smoke scanned database and container surfaces and emitted only allowlisted metadata | **Pass** |
| AC9 CI quality gates | Split contract/unit/PostgreSQL/integration/Compose/Web workflow passed with pinned actions and images | Run 31361949133 passed all six jobs from a fresh checkout | **Pass** |
| AC10 real Hermes response | Opt-in smoke structure, product-lock, inspection, SSE, child-process, and cleanup suites | Reviewed source-built `v0.1.4` arm64 digest completed strict and Web Runs, then cleanup completed | **Pass** |

Future evidence updates must not add logs, prompts, responses, keys, raw
dependency output, Docker JSON, database rows, or secret paths.
