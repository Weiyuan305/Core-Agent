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

Schema version 6 adds the storage invariant `attempt_count <= max_attempts`.
Queued and retrying rows are claimable only below the maximum. An expired
running row at the maximum remains claimable for terminal recovery without
incrementing its attempt count; row locking admits only one recovery owner at
a time, and the typed claim is marked `recoveryOnly`. A genuine v5 database
containing a larger attempt count fails the migration closed instead of
clamping or rewriting historical work.

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

The initial `provision_runtime` job owns runtime initialization only while
`runtime_containers.command_version = 0`. Normal provisioning and final-attempt
provision recovery both hold that same runtime advisory lock before their
atomic repository admission. If a Runtime Command has advanced the version,
the old provision job is lease-fenced to `succeeded` with a bounded superseded
summary and performs no Supervisor, Hermes, or runtime-state write. Provision
begin, success, and failure transactions repeat the command-version defense so
a misplaced caller cannot overwrite newer reconcile truth.

Worker transactions that start or terminalize leased runtime work fence the
lease before and after any runtime-row wait. They first lock the owned
`worker_jobs` row, lock the runtime row, then re-check owner, running status,
and expiry against PostgreSQL `clock_timestamp()`. A failed fence aborts the
whole transaction, including runtime transitions, events, audit, and job
completion. Transaction-stable `now()` is deliberately not used for this
authorization decision because it can predate time spent waiting on a lock.

`worker_jobs.effect_state` is interpreted by job kind rather than as one
generic retry flag:

- for `reconcile_runtime`, `pre_effect` permits one Supervisor lifecycle effect
  or reprovision decision; `unsafe_to_replay` means an accepted effect has been
  dispatched but its healthy terminal observation is still pending, so every
  later claim is inspect-only;
- for `execute_agent_run`, `unsafe_to_replay` retains its separate meaning that
  the owned job was durably marked immediately before the outbound Hermes
  request could be dispatched, and automatic execution replay is prohibited;
- provisioning and Outbox jobs do not claim an unsafe phase in Runtime v1.

After an accepted reconcile effect returns a running but non-healthy
observation, the Worker marks `unsafe_to_replay` before rescheduling. That mark
locks the owned job and runtime rows and atomically fences tenant, job kind,
lease owner/expiry, persisted command, target command version, and current
runtime command version. If the Worker crashes after the mark but before retry,
the expired running job is reclaimable with its inspect-only phase intact. If
it loses the lease before the mark, it cannot write either the phase or retry
state; the Supervisor journal remains the idempotency authority for an
uncommitted replay attempt.

Final-attempt recovery never opens another external-effect boundary. Reconcile
recovery may only inspect: a healthy observation that proves the requested
state can complete, while non-healthy, contradictory, or unprovable state
fails terminally. In particular, `pre_effect` restart cannot be proven by a
running inspection. Provision recovery fails without calling Supervisor and
Outbox recovery completes without dispatching a notification. When provision
has already been superseded, recovery completes only the old job and preserves
the newer runtime observation. Every terminal write still uses the owned,
unexpired lease fence. The production Worker
allowlist excludes `execute_agent_run` until Task 14 supplies its atomic Run
and job terminalization contract.

Internal infrastructure jobs are distinct from the contract Task resource,
which belongs to an Agent Run.

Conversation admission creates one immutable active Conversation and one
active Session in the same serializable tenant transaction. Conversation,
Session, `conversation.created`, AuditEvent, Outbox, and completed idempotency
response therefore commit or roll back together. Conversation, Session, and
Hermes Session references are deterministic from tenant and idempotency
identity; the client cannot supply a Hermes Session reference. The Session is
owned by the trusted service Actor, expires after 30 days, and must retain the
Conversation's immutable Profile and creator binding.

Agent Run admission likewise commits a queued Run, completed user Message,
`execute_agent_run` job, ordered events, AuditEvent, Outbox, and idempotency
response atomically. PostgreSQL foreign-key order requires inserting the Run
before its Message even though logical event order remains exactly
`message.created` then `run.queued` on the Conversation stream. The job payload
references only the Run, keeps runtime command/version null and effect phase
`pre_effect`, and derives total attempts as the selected managed ProviderCatalog
entry's `max_safe_retries + 1`. It does not accept a client retry ceiling.

Admission does not take a tenant-wide exclusive row lock. Tenant, Profile,
service Actor, Membership, Session, parent Run, and Runtime authority/readiness
facts use PostgreSQL shared row locks: concurrent admissions may read them,
while a status or readiness update cannot invalidate a decision before commit.
Run admission takes an exclusive row lock only on its Conversation, preserving
one ordered stream and Session binding without serializing other Conversations
in the same B2B tenant. Tenant-global `client_request_id` and
Conversation-scoped derived Message identities converge at their database
unique constraints. Only PostgreSQL `23505` from
`agent_runs_tenant_id_client_request_id_key` or `messages_pkey` is translated
to bounded `IDEMPOTENCY_CONFLICT`; every other constraint failure remains an
internal error instead of being mislabeled.

Task 13 only admits durable `execute_agent_run` work. The production Worker
claim allowlist excluded that kind until Task 14 supplied the matching
lease-fenced Run, Message, event, and job transactions. Task 14 closes that
boundary as follows:

- begin, delta, completion, retry, and failure transactions lock the owned
  `execute_agent_run` job first and authorize its lease against PostgreSQL
  `clock_timestamp()` both before and after resource-row waits;
- begin revalidates the active Tenant, service Actor, admin Membership,
  immutable Conversation/Profile/Session/user Message, ready Runtime, managed
  ProviderCatalog entry, and active secret-reference metadata under shared or
  stronger row locks. The existing SecretReference mapping stores the ingress
  purpose as `integration` and returns the typed `hermes_ingress` reference;
- `queued -> running` appends one `run.started`; a reclaimed, below-ceiling
  `pre_effect` job may resume the already-running Run without duplicating it;
- after successful Supervisor inspection, a separate transaction locks the
  owned job and target Run, requires the Run to be `running`, repeats the
  database-clock lease fence, and changes `pre_effect -> unsafe_to_replay`.
  Only after that commit may the Worker resolve SecretMaterial or enter the
  Hermes streaming client. Every delta transaction requires the already-unsafe
  phase and appends `message.delta` before the streaming iterator may be pulled
  again. Delta accounting and completion evidence are filtered by both
  Conversation stream and Run ID, so sequential Runs cannot share output;
- durable deltas remain ProductEvents only. No partial assistant Message exists.
  Exact concatenated output creates one completed assistant Message only in the
  same transaction that appends `message.completed`, transitions the Run to
  succeeded, appends `run.completed`, advances Session activity, writes audit
  and Outbox rows, and completes the job;
- safe automatic retry is limited to retryable inspection/dependency failure
  before the dispatch mark. Any failure after the unsafe boundary terminalizes
  Run and job atomically. With no reliable Hermes idempotency key, connection
  refusal, timeout, malformed response, caller abort, or process crash after
  the mark cannot prove that Hermes did not accept work and therefore cannot be
  replayed automatically;
  Reclaimed unsafe work and both final-attempt recovery phases terminalize
  without Supervisor inspect, SecretStore access, or Hermes. Worker/process
  cancellation or lease loss makes no business cancellation or stale terminal
  claim;
- only after these normal, safe-retry, unsafe-recovery, and `recoveryOnly`
  paths were tested did the production Worker allowlist add
  `execute_agent_run`.

Every delta transaction performs one final database-clock lease check after
ProductEvent sequence allocation and Outbox insertion. This closes the row-wait
window: if the Conversation stream-sequence row was locked until the lease
expired, the final fence rolls back the delta, sequence allocation, and Outbox
together while the earlier committed dispatch mark correctly remains unsafe.

This boundary deliberately chooses at-most-once dispatch safety over automatic
availability. A post-mark failure can terminalize a Run even when the request
never reached Hermes. Recovery requires an explicit child Run rather than a
possibly duplicate hidden replay.

Production claim is Conversation-aware before work reaches the process. A
bounded grouped discovery query returns only the earliest eligible
`execute_agent_run` Conversation groups, ordered by their oldest job. A
MATERIALIZED CTE first computes the distinct tenant-and-Conversation keys that
own an unexpired running execute job; the outer eligible jobs-and-Runs query
then excludes those keys through a composite tenant-and-Conversation left
anti-join. This avoids materializing a queued-Runs-by-active-Runs product inside
one Conversation and is not truncated by the first eight rows of one
Conversation backlog. For each discovered
Conversation the scheduler takes a transaction advisory try-lock in the same
`agent-session:v1` tenant-and-Conversation namespace, determines the earliest
job ID, locks only that exact row with `FOR UPDATE SKIP LOCKED`, and rechecks
eligibility and active ownership before update. A single claim also deduplicates
Conversation keys. This serializes competing platform claimers without a new
schema invariant while preserving parallel claims for unrelated Conversations.

Schema version 8 retains the version-7 composite indexes on Agent Run
tenant/Conversation/Run identity, Worker job tenant/Run identity, eligible
queued/retrying claims, and expired-running recovery claims. It adds a partial
covering index for bounded exhausted Outbox recovery. Migration tests prove a
genuine v7-to-v8 upgrade, exact index existence, and index-backed plan support.
A 500-Run same-Conversation regression reduced focused discovery and
claim time from the reviewed 11.1 seconds to 274 milliseconds under cold
statistics. Its analyzed plan also asserts that the maximum per-node work,
calculated as actual rows multiplied by actual loops, stays below 5,000.

The Worker process maintains a rolling set of at most eight dispatches. It
claims only free slots rather than waiting for a batch barrier. While full, it
wakes on either dispatch completion or the 250-ms poll boundary, so Outbox
notification work continues during long model Runs. Shutdown starts no new
claim after abort and awaits every already-started dispatch to settle.

Only one Agent Run may use one Conversation's Hermes Session at a time. The
Worker resolves the immutable Run-to-Conversation binding inside the authority
tenant, then holds a PostgreSQL session advisory lock across the complete
`handleExecuteAgentRun` lifecycle: begin, Supervisor inspect, SecretMaterial,
Hermes stream, every durable delta, and terminal/retry transaction. The key
uses the separate `agent-session:v1` namespace rather than the Runtime
lifecycle-lock namespace. It includes tenant and Conversation, so different
Conversations and different tenants remain concurrent. Lock acquisition uses
bounded `pg_try_advisory_lock` polling so cancellation does not enter begin or
Hermes and waiting jobs do not pin every pool connection. After acquisition the
Worker resolves the tenant-scoped binding again; `begin` then revalidates the
current database-clock lease and all execution authority before external work.

Runtime inspection before Hermes is deliberately not protected by the runtime
advisory lock: a model stream may last 90 seconds and must not block a stop or
delete command. The Worker issues a deterministic Supervisor `inspect`
operation bound to `(job_id, attempt_count)`. Repeated work within one attempt
is idempotent, while a safe retry receives a new observation instead of a stale
Supervisor-journal entry. It requires exact tenant, runtime, generation, image,
existence, running lifecycle, healthy status, and validated private origin.
Later runtime drift converges through the pre-effect versus unsafe failure
policy rather than a conversation-long lifecycle lock.

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
- A reconciler never replays an accepted restart merely because readiness was
  delayed; it observes the dispatched effect until healthy or bounded failure.
- If a later workload justifies Redis or a broker, it must consume a committed
  Outbox and cannot become the resource authority.

## Supersession rule

Changing the database authority, queue authority, or migration source requires
a superseding ADR and an explicit data/event migration plan.
