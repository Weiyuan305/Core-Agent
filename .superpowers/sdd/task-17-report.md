# Runtime v1 Task 17 implementation report

## Status

DONE

- Base: `8d32d336ccba74769cc136af26405b49f801f154`
- Branch: `feat/runtime-v1`
- Commits:
  - `97cae3d` `test(runtime): define control plane topology gate`
  - implementation commit containing this report
- Scope: Task 17 only; no Task 18 implementation, push, merge, Compose startup, or external-network mutation.

## RED evidence

The topology contract was committed before implementation. The first focused
run of `node --test tests/runtime/control-plane-compose.test.mjs` produced 11
expected failures because the Runtime Dockerfile, Compose project, registry
lock/resolver, PostgreSQL initialization, CI split, environment template, and
support scripts did not yet exist or satisfy the new boundary.

The final development identity correction used a second focused RED cycle.
The mount, least-privilege, and environment-template tests failed 3/3 while
Compose still used fixed IDs and the example did not document numeric host
overrides. They passed only after Compose gained the explicit development UID,
API GID, and common Supervisor-socket GID variables. Dockerfile target users
remain the distinct fixed production defaults.

## Runtime topology

- Compose defines exactly PostgreSQL, one-shot migration, API, Worker, and
  Supervisor services. PostgreSQL and migration have no published ports; API
  is the only publisher and binds host loopback at `127.0.0.1:8787`.
- API and PostgreSQL use only the internal control bridge. Worker additionally
  joins the external `core-agent-backplane`. Supervisor uses
  `network_mode: none`; Docker socket authority is isolated to that service.
- `npm run runtime:network` owns a separate idempotent prerequisite which
  creates or strictly validates the labeled, internal backplane. It is not run
  by Compose and was tested only through an injected Docker seam in this task.
- API receives only the bootstrap file projection and non-secret provider
  catalog. Worker receives only the Hermes-ingress projection. Supervisor
  receives separate provider and ingress projections, routes them by strict
  secret purpose, and never receives the bootstrap key.
- Application filesystems are read-only with bounded tmpfs, memory, CPU, PID,
  stop-grace, dropped capabilities, and no-new-privileges controls. Supervisor
  alone mounts the Docker socket and has no host PID, IPC, cgroup, or privileged
  mode.
- Dockerfile targets keep API `12000:12000`, Worker `12001:12002`, and
  Supervisor `12002:12002`. Development Compose supports a caller-supplied
  numeric host UID/GID for macOS/Colima file projections and an explicit common
  UDS GID. The ADR records that production must retain dedicated identities and
  use ownership-aware orchestrator secret projections.

## Image and database gates

The registry resolver accepts only `node:22-bookworm-slim` and
`postgres:17-bookworm`, invokes `docker buildx imagetools inspect --raw` with a
30-second timeout and bounded output, validates the OCI/Docker index and target
platform descriptors, and atomically replaces the lock. The committed registry
results are:

- Node linux/amd64: `node:22-bookworm-slim@sha256:a17d50af28002a160548bd4225b3cfcb12c5efcb171f79e68758f2885fb1b066`
- Node linux/arm64: `node:22-bookworm-slim@sha256:253da19867dd03e2f817f433d7782adefd2a2bac8729fcd4ebc6770665167a24`
- PostgreSQL linux/amd64: `postgres:17-bookworm@sha256:6e5a6518f9d2ff9e9f4cba2a5a87d8f41b0f067f6f92ac847c344351a6c8d923`
- PostgreSQL linux/arm64: `postgres:17-bookworm@sha256:3aac91d19d5b7aff4c650dddfacc1a26c436459aafd4eb51ab0bf1748e990dbb`

The PostgreSQL service uses trust authentication only on the private internal
development/CI network and initializes the disposable `core_agent_control`
test database. The database sentinel scanner accepts only strict loopback test
URLs, enumerates every public text/varchar/JSON surface, uses parameterized
existence queries with five-second bounds, and emits no stored values.

CI is split into contract, unit, PostgreSQL, integration, and Compose jobs.
Actions and PostgreSQL are digest/SHA pinned; no repository credential, real
Hermes call, Compose startup, or Docker socket application access is used. The
Compose job re-resolves approved tags, rejects lock drift, exports the locked
runner-platform references, validates rendered Compose, and runs static runtime
assertions.

## Verification

- Genuine topology RED: 11 expected failures before implementation.
- Development UID/GID RED: 3 expected failures before the compatibility wiring.
- `node --test tests/runtime/control-plane-compose.test.mjs`: 13/13 pass.
- Real arm64 lock references plus synthetic path/ID inputs:
  `docker compose -f infra/runtime/compose.dev.yaml config --quiet`: exit 0.
- `npm run check`: exit 0; contracts 143/143, runtime-core 51/51, API 13/13,
  Worker 60/60, Supervisor 40/40, and all builds/schema/fixture/compat gates pass.
- Fresh `npm test`: exit 0; runtime 43/43, contracts 143/143, runtime-core 51/51
  (237 tests total).
- `node scripts/verify-no-secret.mjs synthetic-leak-sentinel-4d83f17f` after
  staging every Task 17 artifact: exit 0 with no output.
- `git diff --cached --check`: exit 0.
- Workflow PostgreSQL references were programmatically compared with the
  committed lock and match exactly. Self-review found no privileged/host
  namespace setting, unpinned action, or Docker socket mount outside Supervisor.

A valid locked-reference Docker target build was not completed and is not a
Task 17 final gate. A preliminary API smoke command contained a manually
transcribed, malformed digest and Docker rejected it before build execution;
the corrective external registry check was then interrupted at the external
boundary. Per task coordination, no further Docker build or external command
was attempted. This does not claim image-build evidence.

## Self-review and concerns

- Rechecked every process, mount, port, network, identity, resource, image, CI,
  and secret-projection boundary against the Task 17 static gate and ADR.
- Verified the committed lock is registry-derived and CI's two PostgreSQL
  service references equal its amd64 entry exactly.
- Verified the environment example contains only image references, paths, and
  numeric identity placeholders; it contains no key bytes.
- Verified no runtime containers, Compose project, PostgreSQL volume, or
  `core-agent-backplane` network were created or modified by this task.
- The only missing optional evidence is a successful Docker target smoke build,
  accurately bounded above. Deterministic Task 17 gates are green.

No blocking Task 17 concern remains.
