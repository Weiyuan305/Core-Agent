# Runtime v1 Task 17 implementation report

## Status

DONE

- Base: `8d32d336ccba74769cc136af26405b49f801f154`
- Branch: `feat/runtime-v1`
- Commits:
  - `97cae3d` `test(runtime): define control plane topology gate`
  - implementation commit containing this report
- Scope: Task 17 only; no Task 18 implementation, push, merge, Compose startup, or external-network mutation.

## Independent review correction

An independent review rejected the first implementation with zero Critical and
four Important findings. Two additional RED commits preserve the evidence:

- `dfc83ec` `test(runtime): reproduce topology review gaps` — focused review
  suite failed 8/8 across volume ownership, bootstrap mode, scanner URL
  reconstruction, and PostgreSQL role separation.
- `c5ee214` `test(runtime): pin preflight defaults and CI access` — focused
  follow-up failed 2/2 because the pure default `12002` preflight policy and CI
  PostgreSQL host port were not yet represented.
- final review-correction implementation commit containing this updated report.

The corrected development topology replaces Supervisor socket/state named
volumes with caller-named bind roots. `npm run runtime:paths` creates only an
absent leaf and otherwise fails closed unless both roots are exact `0700`
directories owned by the resolved Supervisor UID/GID. Its pure policy resolves
no override to Supervisor `12002:12002` and API `12000:12000`; a host UID
override is reused by Compose and preflight, so the bind owner and effective
container UID cannot drift. Worker and Supervisor deliberately share the dev
effective UID, while the production Docker targets remain distinct
`12000`/`12001`/`12002`. Migration receives neither runtime root.

The same preflight rejects bootstrap symlinks, non-regular files, wrong owner,
and any mode other than `0600`, using metadata only. Compose's target mode is
also `0600`. The database scanner now rejects passwords, query, fragment, and
percent-encoded ambiguity, then constructs the `pg.Client` configuration only
from validated host, port, user, and database fields; it never forwards the
original connection string.

Development PostgreSQL now uses an official-image bootstrap identity only for
initialization, a `NOSUPERUSER NOCREATEDB NOCREATEROLE` migrator owner, and a
separate equally restricted application role for API/Worker. Default table and
sequence privileges are granted from migrator to application. CI uses the
official `postgres` identity only in an explicit bootstrap step, then creates
`core_agent_ci LOGIN NOSUPERUSER CREATEDB NOCREATEROLE` plus its owned control
database. This preserves Task 16 per-file CREATE/DROP without making the test
role a superuser. Local trust remains isolated-development convenience;
production requires TLS and managed credentials.

During the required full gate, the pre-existing cross-instance operation
journal test twice exposed one deterministic release/read race signature. A
waiting instance could open the reservation, the owner could durably publish
the completed record and unlink the reservation, and the waiter then treated
the missing reservation pathname as unsafe. The narrow correction does not
relax reservation validation: after that exact failure it replays only if the
same operation's completed record passes the existing owner, mode, inode,
bounded-read, canonical-JSON, operation-ID, and request-hash checks. Without a
valid completed record the original unsafe error is rethrown.

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
- `node --test tests/runtime/control-plane-compose.test.mjs`: 14/14 pass.
- Independent-review focused RED: expected 8/8 failures, then 8/8 pass.
- Default-policy/CI-access follow-up RED: expected 2/2 failures, then 2/2 pass.
- Operation-journal release/read race: same unsafe-record failure reproduced in
  two full-suite runs; after the narrow correction, focused parallel pressure
  passed 8/8 and the complete Supervisor suite passed 40/40 including unsafe
  record, symlink, permissive mode, ancestor, and stale-reservation coverage.
- Real arm64 lock references plus synthetic path/ID inputs:
  `docker compose -f infra/runtime/compose.dev.yaml config --quiet`: exit 0.
- `npm run check`: exit 0; contracts 143/143, runtime-core 51/51, API 13/13,
  Worker 60/60, Supervisor 40/40, and all builds/schema/fixture/compat gates pass.
- Fresh review-correction `npm run check`: exit 0; contracts 143/143,
  runtime-core 51/51, API 13/13, Worker 60/60, Supervisor 40/40, and all
  builds/schema/fixture/compat gates pass.
- Fresh review-correction `npm test`: exit 0; runtime 44/44, contracts 143/143,
  runtime-core 51/51 (238 tests total).
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

## Independent review Round 2 correction

Round 2 rejected the prior correction with one Critical and two Important
findings. The focused RED is committed as `0f9abe6`
`test(runtime): reproduce second topology review gaps`:

- path preflight failed 2/2 because provider/ingress were absent from policy,
  a symlink ancestor was accepted, and canonical cross-purpose containment was
  not rejected;
- scanner failed 1/1 because raw empty password, query, and fragment
  delimiters reached client construction;
- the legitimate two-instance journal replay test passed, while the new FIFO
  reservation plus valid completion probe failed because unsafe metadata was
  masked by the broad catch.

Preflight now treats bootstrap, provider, ingress, socket, and state as five
pairwise-separated purposes. Existing paths must equal `realpath`; ancestors
must be root/caller-owned non-symlink directories without group/other write;
all existing projections are opened with `O_NOFOLLOW` and compared to their
named inode. Provider/ingress require exact final-UID-owned `0700` directories.
Absent socket/state leaves are created only beneath a canonical protected
parent, then every projection is canonicalized and identity-checked again.
Any canonical equality or ancestor/descendant overlap is rejected, including
provider under ingress and bootstrap/state under Worker-visible roots. Tests
canonicalize the macOS temporary root first rather than permitting configured
symlink ancestors such as `/var`.

The journal no longer catches reservation errors. `#readReservation` returns
one private release sentinel only after the opened reservation has passed
regular-file, owner, exact `0600`, bounded size, bounded content, strict JSON,
request-hash/token, and stable handle-snapshot validation, and only when the
final pathname `lstat` fails with exact `ENOENT`. Only that sentinel may load a
fully validated completed record. FIFO, mode, owner, size, JSON, inode, and any
other `lstat` failure preserve the original unsafe rejection.

The scanner now applies an anchored grammar to the raw input before URL
normalization. It accepts only `postgres`/`postgresql`, one `core_agent_*`
user/database, exact IPv4 or bracketed IPv6 loopback, and an optional bounded
numeric port. Password delimiters, query/fragment delimiters including empty
ones, percent encoding, extra paths, and every other raw form are rejected
before `pg.Client` construction.

### Round 2 verification

- Focused path-preflight regression: 2/2 pass.
- Focused raw-database-URL regression: 1/1 pass.
- Focused journal replay and unsafe-FIFO regression: 2/2 pass.
- `node --test tests/runtime/control-plane-compose.test.mjs`: 15/15 pass.
- Complete Supervisor suite: 41/41 pass.
- `npm run check`: exit 0; contracts 143/143, runtime-core 51/51, API 13/13,
  Worker 60/60, Supervisor 41/41, and all builds/schema/fixture/compat gates
  pass.
- `npm test`: exit 0; runtime 45/45, contracts 143/143, runtime-core 51/51
  (239 tests total).
- No Compose startup, Docker network creation, image pull/build, or external
  access was performed during the Round 2 correction.

No blocking Task 17 concern remains after the Round 2 correction.

## Independent review Round 3 correction

Round 3 of `.superpowers/sdd/task-17-review.md` confirmed the Round 2 path,
journal, and scanner findings closed, then rejected the correction for one
remaining Critical purpose-separation gap: canonical path checks cannot detect
hard links to the same secret inode. The focused RED is committed as
`833e3896be2eeb7d9d5725bc86c0b503f15cd88c`
`test(runtime): reproduce hardlink purpose bypass`:

- bootstrap preflight failed 1/1 because a `0600` bootstrap hard-linked into
  ingress was accepted;
- the API bootstrap loader failed 1/1 because the same hard-linked key was
  digested;
- `FileSecretStore` failed 2/2 because it accepted hard-linked aliases across
  provider/ingress roots and within one root.

Every regular secret-file boundary now requires an exact link count of one.
Preflight compares device, inode, and link count across the named-before,
opened-handle, and named-after metadata snapshots. The API bootstrap loader
validates `nlink === 1` before reading, validates both opened and named metadata
again after the bounded read, and includes link count in its complete file
snapshot comparison. `FileSecretStore` applies the same single-link contract to
the initial opened metadata, post-read handle metadata, and both pathname
stability checks; link count is also part of its size/time/inode snapshot. The
shared store protects both Supervisor provider/ingress reads and Worker ingress
reads, so no additional reader-specific implementation was added. All failures
remain fixed and do not reflect secret bytes.

### Round 3 verification

- Focused hard-link regressions: preflight 1/1, API 1/1, runtime-core 2/2 pass.
- `node --test tests/runtime/control-plane-compose.test.mjs`: 16/16 pass.
- Complete runtime-core suite: 53/53 pass.
- Complete API suite: 14/14 pass.
- Complete Supervisor suite: 41/41 pass.
- `npm run check`: exit 0; contracts 143/143, runtime-core 53/53, API 14/14,
  Worker 60/60, Supervisor 41/41, and all builds/schema/fixture/compat gates
  pass.
- `npm test`: exit 0; runtime 46/46, contracts 143/143, runtime-core 53/53
  (242 tests total).
- No Compose startup, Docker network creation, image pull/build, external
  access, push, or merge was performed during the Round 3 correction.

No blocking Task 17 concern remains after the Round 3 correction.
