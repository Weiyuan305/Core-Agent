# ADR 0003: Durable Execution and PostgreSQL Authority

Status: Accepted

Date: 2026-08-03

Decision IDs: D02, D07, D09, D12

## Context

Runtime provisioning and Agent Runs outlive one HTTP request. They must survive
API and Worker restart, enforce tenant isolation and optimistic concurrency,
and publish ordered events without reporting an external side effect that was
never recorded.

The repository also requires durable business truth to live in Supabase in
production. Development must remain reproducible without depending on a remote
managed service.

## Decision

Use PostgreSQL as the only authority for Control Plane resources, desired and
observed runtime state, internal jobs, idempotency, ProductEvents, AuditEvents,
and Transactional Outbox rows.

- Development uses Docker PostgreSQL.
- Production targets Supabase PostgreSQL through a standard TLS PostgreSQL
  connection and a least-privilege role.
- Kysely and `pg` provide typed queries.
- Reviewed, versioned SQL files are the database schema and migration authority.
- Application startup checks migration version and refuses readiness on drift.
- Workers claim jobs with leased rows and `FOR UPDATE SKIP LOCKED`.
- Resource transitions, events, audit, jobs, and outbox rows are committed in
  explicit transactions.
- PostgreSQL `LISTEN/NOTIFY` may wake consumers but is never durable truth.
- Runtime reconciliation compares database desired state with Supervisor
  observed state.

Runtime v1 schema version 5 records three Worker-only durability facts:

- `runtime_platform` reconstructs a complete Supervisor provision request. It
  remains nullable only for legacy rows because an image digest does not prove
  an OCI platform; the Worker fails those rows closed rather than guessing.
- `command_version` and the reconcile job's `target_command_version` bind a
  lifecycle effect to the latest accepted command independently of ordinary
  resource-version increments caused by observed-state transitions. A
  superseded job completes without issuing its stale external effect.
- Outbox lease owner, expiry, and redacted error summary support bounded,
  restart-safe PostgreSQL wakeup delivery. The platform Worker owns an explicit
  cross-tenant scheduler claim for jobs and Outbox rows; every subsequent
  resource operation restores the returned tenant scope.

Schema-v4 active reconcile jobs lack a command-version binding and are failed
closed during upgrade. Existing runtime platforms stay unknown for the same
reason: neither command intent ordering nor CPU architecture is fabricated.

Runtime lifecycle serialization uses one tenant-and-runtime-scoped PostgreSQL
advisory-lock key across both processes. The Worker holds the session lock from
the final current-command check through the Supervisor effect. API command
admission takes the transaction form of the same lock before reading the
expected resource version and committing a newer intent. Therefore a command
cannot be admitted in the gap between the Worker's check and external effect;
different runtimes retain independent lock keys.

Worker transactions that start or terminalize leased runtime work fence the
lease before and after any runtime-row wait. They first lock the owned
`worker_jobs` row, lock the runtime row, then re-check owner, running status,
and expiry against PostgreSQL `clock_timestamp()`. A failed fence aborts the
whole transaction, including runtime transitions, events, audit, and job
completion. Transaction-stable `now()` is deliberately not used for this
authorization decision because it can predate time spent waiting on a lock.

Internal infrastructure jobs are distinct from the contract Task resource,
which belongs to an Agent Run.

## Alternatives considered

### SQLite

SQLite simplifies a local demo but creates an early migration for concurrent
workers, PostgreSQL constraints, Supabase deployment, row leasing, and audit
queries. It is not the Runtime authority.

### JSON files or in-memory state

Rejected because they do not provide safe concurrent writes, referential tenant
constraints, durable jobs, or atomic resource/event state.

### Redis and BullMQ

This is a capable queue, but it introduces a second persistence system and a
database/queue consistency problem before the first single-node slice needs it.
PostgreSQL jobs and Outbox are sufficient for Runtime v1.

### In-process background promises

Rejected because a process restart loses work and cannot safely distinguish
never-started work from partially completed side effects.

### Drizzle

Drizzle provides a useful TypeScript schema and migration toolchain, but this
design prefers explicit SQL migrations and direct control of PostgreSQL locking
and CTE behavior without another schema-generation authority.

### Prisma

Prisma is productive for ordinary CRUD but Runtime v1 depends on PostgreSQL-
specific leases, locks, sequences, and transactional event patterns that would
repeatedly require lower-level SQL escape hatches.

## Consequences

- CI needs a real PostgreSQL service for persistence tests.
- Schema changes require an explicit migration and rollback/forward strategy.
- Supabase is the production durable store without becoming a proprietary API
  dependency in the domain layer.
- A missed notification cannot lose an event because consumers query durable
  rows.
- Worker crashes require lease expiry and idempotent external operations.
- Runtime command admission may wait for an in-flight effect on the same
  runtime, while commands for other runtimes remain independent.
- A stale Worker cannot publish a terminal transition after losing its lease,
  even when the loss happens while it waits for another row lock.
- If a later workload justifies Redis or a broker, it must consume a committed
  Outbox and cannot become the resource authority.

## Supersession rule

Changing the database authority, queue authority, or migration source requires
a superseding ADR and an explicit data/event migration plan.
