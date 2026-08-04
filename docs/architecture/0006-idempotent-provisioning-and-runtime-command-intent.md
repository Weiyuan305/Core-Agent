# ADR 0006: Idempotent Provisioning and Durable Runtime Command Intent

Status: Accepted

Date: 2026-08-04

Decision IDs: D15, D16, D17, D18

## Context

Runtime v1 needs to create a complete tenant runtime and accept start, stop,
restart, and delete commands before a public Identity gateway exists. A request
may be retried after a timeout or process restart, and the API must never leave
resources, jobs, audit facts, or events partially committed.

Two protocol details cannot be inferred safely:

- provisioning has no pre-existing tenant path from which to derive authority;
- both start and restart result in desired state `running`, but the Worker must
  still know whether a real restart was requested.

The existing `runtime.status_changed` event describes observed container state.
Using it for a desired-state command would publish a state transition that did
not occur.

## Decision

### Provisioning authority and transaction

`POST /internal/v1/tenant-provisioning` authenticates the platform bootstrap
service but does not accept `X-Core-Agent-Tenant-Id`. The tenant scope comes
from the closed, contract-valid IdentityGraph in the request. Tenant-scoped
runtime query and command routes require exact path/header tenant equality.

Provisioning runs in one serializable PostgreSQL transaction. It admits the
idempotency key, creates tenant identity/Profile/runtime facts, stores only
opaque secret metadata, queues provisioning, appends ProductEvent/AuditEvent
and Outbox facts, and completes the idempotency record. No SecretStore,
Supervisor, Docker, or Hermes call occurs inside that transaction.

The managed ProviderCatalog and the complete two-platform runtime image lock
are server authority. The request can select only an allowed provider, model,
platform, and exact pinned image reference.

### Idempotency and optimistic concurrency

The API recomputes the canonical payload hash after closed-schema validation.
A completed replay must match tenant, key, operation, payload hash, stored
`result_ref`, and the server-derived RuntimeContainer ID before its minimal
response is returned.

Runtime commands require a safely incrementable `expected_resource_version`.
The resource update, command intent, audit, event, Outbox, and completed replay
response commit atomically. A stale version rolls the transaction back without
leaving an idempotency row or job.

### Durable commands and truthful events

Schema version 4 adds `worker_jobs.runtime_command`. An active
`reconcile_runtime` job must contain exactly one of `start`, `stop`, `restart`,
or `delete`; other job kinds must not contain a runtime command. The payload
reference remains the RuntimeContainer ID.

Contracts 0.3.0 adds `runtime.command_accepted`, binding each command to its
desired state. `runtime.status_changed` is emitted only when observed state is
actually changed. This preserves the restart distinction and gives Outbox
consumers a truthful event.

Desired or observed `deleted` state is terminal. Volume destruction remains a
separate operator-only action; the delete command preserves the volume.

### Effect admission and observation acceptance

API command admission and the Worker's external-effect critical section share
the same tenant-and-runtime PostgreSQL advisory-lock key. The Worker rechecks
the persisted `command_version` while holding that lock and keeps it through
the Supervisor call. The API takes the transaction-scoped form of the same lock
before optimistic-version admission. A newer accepted command therefore either
precedes the Worker's final check or waits until the older effect has finished;
it cannot race into the interval between those two operations.

Supervisor absence has one shared protocol representation:
`REMOVED_RUNTIME_IMAGE_REF`, the immutable
`managed/removed@sha256:` reference with a 64-zero digest. An observation with
`exists=false` is compatible only when its lifecycle is `removed` and it uses
that sentinel; it must not repeat the previously stored runtime image digest.
An existing observation must continue to match the stored immutable image.

For start, restart, or reprovision, `lifecycle=running` alone is insufficient.
The Worker commits `ready` only from an identity-compatible observation whose
health is `healthy` and whose private Hermes origin passes policy validation.
`unknown`, `degraded`, and `unhealthy` running observations retry within the
bounded attempt budget and eventually fail; they never advance readiness.

An accepted running effect that is not yet healthy advances the durable
reconcile job from `pre_effect` to `unsafe_to_replay` before retry. This phase
does not mean the command is abandoned: it means the command's external effect
was dispatched and subsequent attempts must use attempt-specific `inspect`
operations only. A healthy running inspection completes start or restart;
continued non-healthy running observations consume the bounded retry budget;
removed or command-contradicting observations fail closed. Stop and delete use
the same observe-only rule after marking, although their accepted effect
normally already supplies a terminal observation.

The phase mark and retry update are intentionally separate recoverable writes.
A crash between them leaves an expired `running` job whose
`unsafe_to_replay` value survives reclaim, preventing a stable Supervisor
journal response from trapping restart in a replay loop. The identically named
phase on `execute_agent_run` has a different job-kind contract: it records that
the model execution boundary cannot be automatically replayed, not that a
runtime lifecycle effect should be polled.

### Schema-v3 upgrade

Schema v3 cannot distinguish a queued start from a queued restart because both
stored only desired `running`. Migration 004 does not invent an intent. It
fails active ambiguous legacy reconcile jobs closed, clears their leases, and
retains a bounded generic failure summary. Existing succeeded, failed, and
cancelled history is preserved unchanged. Null legacy intent is permitted only
for terminal reconcile rows that cannot be claimed.

Schema v5 adds a monotonic runtime `command_version` and records the accepted
version on each reconcile job. A genuine schema-v4 active reconcile row cannot
prove that binding and is likewise failed closed during upgrade; its persisted
command remains available for diagnosis, and terminal schema-v4 history is not
rewritten.

Schema v6 adds only the Worker attempt fence `attempt_count <= max_attempts`.
It does not repair invalid v5 history: migration fails closed when a row already
exceeds its maximum. Expired final-attempt running work is reclaimed without an
increment and carries `recoveryOnly`; it may inspect or terminalize under the
lease fence, but it may not replay a Supervisor effect. Production scheduling
continues to exclude `execute_agent_run` until Task 14 implements the matching
Run-state transaction.

## Alternatives considered

### Trust a provisioning tenant header

Rejected because there is no existing tenant authority to compare it with. It
would create two caller-controlled tenant fields. The validated IdentityGraph
is the single provisioning scope.

### Derive restart from desired state

Rejected because `running` represents both start and restart. A Worker cannot
recover the user's intent after a crash or queue delay.

### Encode restart in an opaque job ID or payload reference

Rejected because it turns identifiers into an undocumented protocol and stops
`payload_ref` from being a pure resource reference. A typed database column is
explicit and enforceable.

### Emit `runtime.status_changed` when accepting a command

Rejected because only desired state changed. Publishing the unchanged observed
state would create a false or duplicate lifecycle event.

### Infer legacy intent from desired state during migration

Rejected because it silently converts some restarts into starts. Ambiguous
active work fails closed; terminal history remains immutable.

### Put PostgreSQL integration tests in the ordinary API unit gate

Rejected because a default package check should build and run deterministic
tests without hidden environment requirements. Transaction tests remain an
explicit `test:postgres` gate.

## Consequences

- Runtime reconciliation can execute restart exactly and can suppress any job
  whose target command version is no longer current.
- Database schema authority advances through version 6; ambiguous active v3
  intent and unbound active v4 intent both fail closed during their upgrades.
- Contracts advance additively to 0.3.0 with a new immutable compatibility
  snapshot.
- Provisioning and command acceptance remain asynchronous `202` operations.
- Same-runtime command admission can wait for an in-flight Supervisor effect;
  this is intentional serialization, not API/Worker process coupling.
- Supervisor, Worker, and their tests import the removed-runtime sentinel from
  the shared runtime-core contract so the absence representation cannot drift.
- A running but non-healthy Hermes container is observable but is not ready.
- Delayed health after restart or reprovision causes inspect-only recovery, not
  a replay of the previously accepted lifecycle effect.
- An upgrade may terminalize ambiguous active schema-v3 reconcile work; it will
  not rewrite completed history or execute a guessed command.

## Supersession rule

Changing provisioning tenant authority, allowing runtime resurrection,
removing persisted command intent, or publishing desired-state acceptance as an
observed-state event requires a superseding ADR and a data/protocol migration.
