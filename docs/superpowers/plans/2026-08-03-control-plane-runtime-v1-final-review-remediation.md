# Control Plane Runtime v1 Final Review Remediation Plan

> **Execution rule:** Use `superpowers:subagent-driven-development`. Every remediation task starts with a committed failing regression test, ends with a separate implementation commit, and receives an independent reviewer before the next task starts.

**Baseline:** `1dd7251db4faf1f42b8d8a7b5d29b4b552d9aca3` on `feat/runtime-v1`.

**Why this plan exists:** The complete Runtime v1 branch passed all deterministic package and workspace gates, but three independent whole-branch reviews rejected release readiness. This document records the findings, the chosen corrections, and the evidence required before merge. It supplements the original Runtime v1 plan; it does not silently rewrite completed task history.

## Final-review findings

| ID | Severity | Finding | Required invariant |
| --- | --- | --- | --- |
| FR-01 | Critical | Supervisor-local staging and ingress paths are sent to the host Docker daemon as bind sources, although the daemon cannot see the Supervisor container's private filesystem. | Every Docker bind source is derived from a separately configured, canonical, daemon-visible host root; the Supervisor uses a mounted local view of the same root. |
| FR-02 | Critical | Initializer and gateway inherit/use the product `hermes` user, but staged secret files are owned by the Supervisor runtime uid with private directory/file modes. | Initializer and gateway run as the same explicit numeric runtime uid/gid that owns the staged and initialized tenant files; secret files remain `0600` and directories remain private. |
| FR-03 | Critical | Hermes is attached only to an internal Docker network, so an HTTPS provider URL is unreachable. | Hermes has one private ingress network plus one dedicated, non-internal egress network; no host port is published and Worker reaches Hermes only through the private network. |
| FR-04 | Important | Client, server, and Docker effect deadlines disagree; the client can fail at 10 seconds while the Supervisor legitimately allows 120 seconds, and server timeout can be journaled while an uncancelled effect later completes. | One documented deadline budget orders inner effect < Supervisor operation < client wait. Docker calls observe cancellation, and a terminal journal timeout is written only after the effect has settled or its final state has been reconciled. |
| FR-05 | Important | Production idle waits retain abort listeners, and job ownership lacks a process-incarnation/attempt fence. | Idle waits always detach listeners. Every lease heartbeat and terminal write is fenced by the captured claim attempt, and process lease-owner identity is unique per Worker incarnation. |
| FR-06 | Important | Idempotency admission uses ambient wall time, and expired-key reuse collides with deterministic resource IDs. | Admission uses the caller's injected clock. A tenant/key is a permanent tombstone: same payload replays its result; a different payload always conflicts, regardless of retention timestamp. |
| FR-07 | Important | An Outbox row whose tenth claim loses its lease remains pending forever. | An exhausted row with no live lease reaches an explicit terminal failed state without an eleventh notification attempt. |
| FR-08 | Important | A superseded runtime command may fail the newer shared Runtime after its external call returns. | Both successful and failed reconciliation compare the job's target command version with the current Runtime command version; a superseded job completes as superseded without changing newer Runtime truth. |

## Chosen architecture corrections

### Docker-visible paths and runtime identity

The Supervisor receives two forms of each managed bind root:

- a **Supervisor-local root**, used for descriptor-relative file creation and validation;
- a **Docker-host root**, used only when constructing Docker bind-source strings.

Compose mounts `${CORE_AGENT_SUPERVISOR_STATE_ROOT}/staging` and `/ingress` into fixed Supervisor-local paths and passes the original canonical host paths separately. The adapter accepts no per-request paths and only maps validated relative children between these paired roots. Inspection validates the exact Docker-host source. The old private staging `tmpfs` is removed because its content is intentionally consumed by sibling containers created by the host daemon.

Initializer and gateway containers use an explicit numeric uid/gid supplied by trusted Supervisor startup configuration, never a request field. The product image must support that arbitrary managed uid without making secrets group/world-readable. Tenant directories stay private and provider/ingress files stay `0600`.

### Network split

Runtime preparation owns two exact labeled networks:

- `core-agent-backplane`: `internal=true`, non-attachable, Worker plus Hermes private ingress;
- `core-agent-egress`: `internal=false`, non-attachable, Hermes only, no published ports.

The adapter validates exact membership and resolves `private_origin` from the backplane attachment specifically. The egress network is a single-host v1 boundary, not a tenant firewall: Docker authority and host networking remain trusted. A later proxy/NAT policy service may narrow destinations without changing the Worker-to-Hermes protocol.

### Deadline budget

There is one exported/documented production budget. The initializer/effect deadline is strictly below the Supervisor operation deadline, which is strictly below the Runtime Supervisor client deadline. A timeout aborts the underlying Docker request. The server must not record a terminal timeout while an ignored promise can still mutate Docker; cancellation settlement or inspect-based reconciliation is part of the adapter contract. Tests cover a valid operation lasting longer than the former 10-second ceiling and a cancellation case with no mutation after the terminal journal record.

### Durable ownership and recovery

`attempt_count` is the claim generation. Claimed-job references carry it through every heartbeat, retry, success, failure, and runtime-specific terminal update; SQL predicates include it. The configured Worker ID becomes a prefix for a per-process incarnation suffix, adding defense in depth against replacement processes.

Outbox attempt 10 remains the maximum notification attempt. If its lease expires before a durable delivered acknowledgement, recovery terminalizes the row as failed with a redacted fixed summary. ProductEvent polling remains authoritative, so a lost wakeup does not lose event truth.

### Idempotency and command supersession

`expires_at` is a retention/operational timestamp, not permission to reuse a logical key. Records remain authoritative tombstones while their deterministic resources exist. All admission comparisons and timestamps use the same injected `now` value supplied by the service.

Runtime reconcile failure follows the same command-version supersession rule as success: an older job cannot overwrite newer desired/observed state or emit a false current failure.

## Remediation tasks

### Task 19 — Make Hermes containers deployable without weakening isolation

- Add RED tests for daemon-visible bind mapping, rejection of mismatched roots, explicit numeric initializer/gateway user, exact two-network inspection, backplane-origin selection, and external-provider-capable topology.
- Implement paired local/host roots, Compose/preflight directory ownership, arbitrary managed uid/gid container configuration, and the two-network topology.
- Update operating and architecture documents with Linux and macOS/Colima path semantics and the single-host egress trust boundary.
- Required gates: Supervisor focused tests, runtime topology tests, Compose config with synthetic variables, secret scanner, package checks, root tests, and diff check. No Docker mutation or provider request without explicit opt-in.

### Task 20 — Make Supervisor deadlines coherent and effect-safe

- Add RED tests for the ordered deadline budget, an operation longer than 10 seconds but inside the valid budget, abort propagation, and absence of a post-journal late mutation.
- Implement shared constants/config validation, abort-aware Docker calls, and settlement/reconciliation before terminal timeout journaling.
- Required gates: Runtime Core Supervisor tests, Runtime Supervisor tests, package checks, root tests, scanner, and diff check.

### Task 21 — Fence every Worker lease by claim incarnation

- Add RED tests for listener cleanup, stale attempt rejection after same-owner reclaim, runtime-specific terminal writes, and distinct process incarnation IDs.
- Carry claim attempt through all ownership references and SQL predicates; detach abort listeners on every idle-wait completion; derive a bounded unique process owner from the configured prefix.
- Required gates: Worker tests, Runtime Core job/PostgreSQL tests when available, package checks, root tests, and diff check.

### Task 22 — Make idempotency clocks deterministic and keys non-reclaimable

- Add RED tests using a clock far beyond the old fixture date and for same/different payload behavior after `expires_at`.
- Remove ambient time reads from idempotency admission. Preserve completed replay and permanent conflict semantics after expiry; do not reset an existing key generation.
- Update the idempotency ADR and field documentation.
- Required gates: focused PostgreSQL idempotency and admission tests when available, Runtime Core/API tests, package checks, root tests, and diff check.

### Task 23 — Terminalize exhausted Outbox wakeups

- Add RED tests for attempt-10 lease loss before and after notification, no attempt 11, explicit terminal status, and continued ProductEvent discoverability.
- Add transactional expired-lease recovery before normal claims. Treat a lost delivered acknowledgement as non-authoritative; recovery owns terminalization.
- Required gates: Outbox/PostgreSQL tests when available, Worker tests, package checks, root tests, and diff check.

### Task 24 — Isolate superseded reconcile failures

- Add RED race tests where a newer command is accepted before an older rejected/thrown Supervisor effect returns.
- Fence failure finalization by `target_command_version`. Terminalize the older job as superseded without changing Runtime state or emitting current-command failure history.
- Required gates: reconcile Worker tests, Runtime Core PostgreSQL tests when available, package checks, root tests, and diff check.

## Release gate after Task 24

Run all deterministic checks from a clean worktree, then perform a new three-angle independent review:

1. architecture and trust-boundary review;
2. PostgreSQL concurrency/idempotency/recovery review;
3. release-operability review from clean-host assumptions.

Runtime v1 may merge to `main` only if all three approve with no Critical or Important findings. The real Hermes/provider smoke remains an explicit operator opt-in and must be reported honestly if it was not run.

## Second whole-branch review remediation

The first remediation wave closed FR-01 through FR-08, but the next complete-branch review at `bb3b064` found cross-module invariants that task-local reviews did not expose. These findings are release-blocking and extend this plan.

### Task 25 — Bind every successful Runtime terminalization to persisted job intent

- Add RED repository tests for wrong kind, payload/runtime, command, target version, effect state, and attempt across provision success, reconcile success, and superseded completion.
- Lock and validate the complete persisted job intent before any Runtime, Tenant, Profile, ProductEvent, AuditEvent, Outbox, or job terminal mutation.
- `finishReconcile` must require the persisted durable dispatch fence where the command path requires an external effect; inspect-proved pre-effect completion must use a separately explicit disposition rather than bypassing intent validation.
- Required gates: Runtime Core/Worker tests and builds, full deterministic gates, scanner, and diff check. PostgreSQL specifications are committed even when the local URL is unavailable.

### Task 26 — Remove database lock inversions and retry only safe commit work

- Establish and document one lock order for Tenant/Profile/Runtime and one for Conversation/Run.
- Change Provision success to follow the same Tenant/Profile/Runtime order as Conversation admission.
- Change Agent Run terminalization to lock Conversation before Run, using a tenant-scoped unlocked lookup followed by locked revalidation when needed.
- Add a bounded retry helper for PostgreSQL `40P01` and `40001` around database-only transactions. Never replay Docker, Hermes, or another external effect.
- After an external effect, exhausted database-concurrency retries leave the job for durable reclaim/recovery; they must not convert an accepted Docker/Hermes result into a business failure.
- Add real-PostgreSQL concurrent regressions for Provision completion versus Conversation admission and Agent Run completion versus retry admission.

### Task 27 — Preserve non-abort Docker transport uncertainty

- Add RED tests where a mutating fake daemon applies the change and then rejects with a response-less transport error while the operation signal remains active.
- Classify only accessor-safe, response-less transport codes as daemon-uncertain after mutation dispatch. Do not turn Docker policy, HTTP status, validation, or ordinary rejected responses into indefinite reservations.
- Reconcile provable final state through strict inspection; otherwise retain the stable operation reservation for process restart/adoption without a durable failure journal.
- Required gates: Supervisor focused/full tests, Runtime Core client tests, full deterministic gates, scanner, and diff check.

### Task 28 — Make clean-host Docker access and acceptance evidence truthful

- Parameterize and validate the daemon-side Docker socket bind source. Support only documented local Unix Docker contexts in v1.
- Add a fixed Supervisor-image socket preflight that runs with the exact final uid/gid, exact mounted socket, `network_mode: none`, no capabilities/privilege, and performs only a bounded Docker `_ping`. Runtime Supervisor startup depends on its successful completion.
- Document separate Linux, Docker Desktop, and Colima procedures. For Colima, derive daemon-side socket metadata inside the selected VM rather than from a macOS `/var/run/docker.sock` symlink; the runtime preflight remains the authority.
- Narrow CIDR wording to Docker-IPAM collision detection plus an explicit operator host/VPN/VM route check unless a portable route check is implemented.
- Mark runtime-dependent acceptance rows Pending until PostgreSQL, Docker, and real Hermes/provider evidence actually exists.
- Either configure role-authenticated development PostgreSQL or state explicitly that Compose `trust` is a development convenience and not a role-isolation security boundary.
- Required gates: runtime topology tests, read-only Compose config, socket-preflight unit tests, docs/static gates, scanner, and full deterministic checks. Actual Linux/Colima startup remains an explicit release gate.

After Task 28, repeat all three complete-branch reviews. Runtime v1 remains unmergeable until they approve with no Critical or Important findings.

## Execution and review trace

This section is the tracked audit trail for the decisions made while executing
Tasks 25-28. The local subagent ledger contains the longer per-round reports.

- **Task 25 — complete at `bc2d65f`.** RED coverage was added in
  `187b397..0573da6`, the first implementation landed in `31f8d49`, and review
  gaps were closed by `37bee56..bc2d65f`. Successful terminalization now binds
  persisted job kind, attempt, command version, target, and observed container
  identity before shared-state or history mutation.
- **Task 26 — complete at `546cf5c`.** `3c17768` defined the global transaction
  lock-order regressions and `546cf5c` enforced them. PostgreSQL `40P01` and
  `40001` retry only database commit work and never replay Docker, Hermes, or
  another external effect.
- **Task 27 — independently approved at `3ffdbd3`.** The initial transport and
  lifecycle work spanned `fc9df32..1ba253e`. Review then found a pathname
  `lstat`/`unlink` TOCTOU capable of dispatching two callbacks. RED commit
  `3fc3fd8` and GREEN commit `812afca` replaced stale pathname reservations
  with a permanent per-operation mode-`0600` SQLite guard plus canonical
  pending JSON. `9a66a89` and `3ffdbd3` migrated all uncertainty, recovery, and
  busy-admission evidence to pending-versus-terminal semantics. Cross-process
  contention, SIGKILL recovery, unsafe FIFO/symlink/permission handling,
  unrelated-operation concurrency, and the complete Supervisor suite passed;
  the final Supervisor count was 83/83.
- **Task 28 — independently approved at `8a70e6e`.** Socket preflight and
  clean-host documentation landed in `6768fdf..aae284c`. Review found an
  ambient `DOCKER_HOST` bypass; `6b8e0d7..8a70e6e` now rejects every present
  value before dependency creation or Docker invocation and never propagates
  or echoes it. The remediation tests passed 2/2 and Compose/static tests
  passed 19/19. No Docker daemon or real Hermes/provider smoke was started.

The architecture decision produced during Task 27 requires Node.js 22.13.0 or
newer because the Supervisor uses `node:sqlite`. The module remains
experimental on the supported Node 22 line; warnings stay visible. The
per-operation guard is permanent, while pending and terminal JSON records carry
the recoverable protocol state. Legacy digest `.lock` files fail closed.

The repeated release review then found two evidence-only drifts: the runtime
contract test still expected the former generic Node 22 CI selector, and the
production boundary still described the removed stale-token `.lock` protocol.
The gate now requires exact `node-version: 22.13.0`; the runbook describes the
permanent SQLite guard and the exact operation-bound pending JSON fields.

At `3ffdbd3`, Tasks 25-28 were ready for the required repeated whole-branch
architecture, PostgreSQL concurrency/recovery, and release-operability reviews.
