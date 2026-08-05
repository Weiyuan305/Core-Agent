# Runtime v1 production boundary

Runtime v1 targets one controlled Linux host. It is an internal platform slice,
not a public product surface. Real customer or student use is prohibited until
the separate Identity, Consent, Retention, and Data Governance phases are
accepted and implemented.

## Host and service boundary

- Run API, Worker, and Supervisor as separate unprivileged service identities.
  Supervisor alone receives Docker socket access; Docker authority is
  effectively root-equivalent and must never reach API, Worker, a Hermes
  runtime, or a general operator shell.
- Bind API only to a private interface behind the internal service boundary.
  Runtime v1 has no public gateway or human login. Restrict host firewall and
  service discovery to the intended internal caller.
- Place the Worker/Supervisor UDS in a dedicated `0700` parent. Give the socket
  an explicit owner/group and `0660` or stricter mode. Only Worker joins that
  group. Do not reuse the development shared UID arrangement in production.
- Keep Hermes containers on exactly the labeled internal backplane and the
  dedicated non-internal egress bridge, with no host port bindings. Worker
  reaches only the backplane address. Provision egress as the exact local
  `172.31.240.0/24` bridge with gateway `172.31.240.1`, default IPAM, IPv4
  masquerading enabled, and IPv6 and swarm ingress disabled; a collision or
  drift is a deployment failure. Treat egress as a trusted single-host boundary,
  restrict host forwarding/firewall policy, and attach no unrelated container.
  Supervisor adoption must validate the complete prior label set,
  request hash, tenant/runtime identity, generation, volume, network, and image
  digest before it acts.

## Worker lease ownership

Set `CONTROL_PLANE_WORKER_ID` to a stable, bounded deployment prefix using
letters, digits, `_`, or `-` (maximum 91 characters). At startup the Worker
adds a fresh UUID incarnation suffix and uses that derived value for PostgreSQL
leases. Do not configure the suffix yourself and do not rely on a previous
process retaining lease authority after replacement.

Worker lease writes are fenced by the claim's `attempt_count`. An operator may
replace a Worker process after a lease expiry; the prior process can no longer
heartbeat, retry, complete, fail, or apply a Runtime/Agent Run/Outbox terminal
update for the reclaimed attempt.

Reconcile retry/failure records with the fixed summary `Superseded by a newer
runtime command` are successful disposal of obsolete work, not current Runtime
failures. They must not be accompanied by a Runtime failure transition or
failure event/audit entry. Current-command failure alerts therefore require a
matching `target_command_version`; investigate any mismatch as a broken Worker
transaction boundary.

A provision terminalization presented with a non-provision job kind, or a
reconcile terminalization whose locked persisted target differs from the
Worker's claim, is reported as lease loss and must make no Runtime mutation.
Treat repeated occurrences as a Worker contract or data-integrity alert; do not
retry them through a generic Runtime failure path.

Successful Runtime terminalization must expose one of the persisted proof
classes. `inspect_proved` is a no-effect completion for start, stop, or delete
while the job remains `pre_effect`. `effect_dispatched` requires the job to be
`unsafe_to_replay`; every lifecycle/restart/reprovision call must persist that
phase first, and a failed phase mark must produce no external call. Wrong job
kind, payload/container identity, command, target, effect phase, attempt, owner,
status, or lease is a lease-loss disposition with zero terminal writes.
The success proof is runtime-validated as an exact accessor-free record;
unknown proof kinds, malformed observations, and `inspect_proved` restart are
also lease loss with zero writes. Superseded completion must carry and match
the claimed Runtime identity, command, target, and exact `pre_effect` or
`unsafe_to_replay` phase. The effect-phase mark both locks and repeats
`payload_ref = container_id = runtime_id` in its final update CAS; either
identity mismatch prevents the mark and therefore prevents the external
effect.

Investigate lock waits against the enforced row order. Provision success and
Conversation admission acquire Tenant, Profiles ordered by `profile_id`,
Runtime, then Worker job when present. Agent Run execution mutations acquire
Conversation, Agent Run, then Worker job; a Worker must revalidate the unlocked
Run-to-Conversation discovery after locking. PostgreSQL `40P01` and `40001`
receive at most three fresh database transactions. The retry closure must never
contain Supervisor, Docker, Hermes, SecretStore, or notification calls. If the
fixed retry budget is exhausted after an accepted external effect, the Worker
must emit no business failure or retry mutation: the running lease expires and
normal recovery inspects or terminalizes it under the persisted effect phase.

Outbox delivery has a hard limit of 10 notification attempts. Each polling
transaction first locks at most 100 exhausted pending rows in deterministic
creation-and-identity order with `FOR UPDATE SKIP LOCKED`. It rechecks each
composite identity and dead-lease predicate, marks it `failed`, clears its
lease, and records the fixed summary `Outbox delivery attempt budget
exhausted`; it does not send a recovery notification or admit attempt 11. A
live tenth-attempt lease is left untouched. Concurrent Workers recover disjoint
batches and subsequent polls drain larger backlogs. Alert on this fixed summary
and use ProductEvent database polling to recover consumers: a successful
notification whose delivered acknowledgement lost its lease may still be
terminalized as failed, but the durable ProductEvent remains available.

## PostgreSQL and release roles

Use Supabase PostgreSQL over TLS with certificate and hostname verification.
Create dedicated least-privilege credentials for migration and application
traffic; the application role is not a superuser and cannot create databases
or roles. Keep bootstrap/owner credentials out of long-lived API and Worker
configuration. Restrict Supabase network policy to the production host and
monitor failed authentication separately from application errors.

Run reviewed additive migrations as an explicit release step before starting
the new API/Worker revision. Readiness must verify the exact expected schema
version. Record migration checksum, deployed schema version, application
digest, and product-Hermes digest in release evidence.

## Secret projections

Project each purpose separately:

- API receives only the bootstrap-service file;
- Worker receives only the Hermes-ingress root;
- Supervisor receives distinct provider and ingress roots and never the
  bootstrap key;
- Hermes receives provider material only in its isolated tenant volume and an
  ingress file mount, never a secret value in Docker configuration environment.

Each root is canonical, owner-controlled, exact `0700`, protected through all
ancestors, and non-overlapping with every other purpose. Secret leaves are
current-owner regular, exact `0600`, single-link files. Use an ownership-aware
projection mechanism; do not assume Compose file-secret UID/GID semantics are
portable. Rotate by atomically replacing the approved projection. Never pass
secret bytes through process environment, command line, Docker labels, logs,
events, traces, errors, or PostgreSQL rows.

Supervisor receives paired local and Docker-host roots for staging and managed
ingress. On Linux they are namespace views of the same canonical host
directories. Never pass a container-private `/run/...` path to the host Docker
daemon. Pre-create state-root `staging` and `ingress` children as Supervisor's
uid/gid with `0700`. Initializer, verifier, and gateway use that same explicit
numeric identity; never compensate for mismatch by making provider or ingress
files group/world-readable.

## Supervisor deadline operations

Deploy Worker, Runtime Supervisor, and Runtime Core from one revision so all
three use the shared deadline budget: 25 seconds each for initializer and
verifier, five 10-second cleanup/absence-proof windows for two old helpers, two
new helpers, and a failed gateway, plus 10 seconds of other
effect overhead, a 120-second total effect, 1-second admission, 150-second
operation, 20-second cancellation settlement, and 180-second client wait. The
enforced production equations are `25 + 25 + 5*10 + 10 = 110 < 120 < 150`
and `1 + 150 + 20 = 171 < 180` seconds. Do not lower the Worker client wait
below the aggregate admission, operation, and settlement window. Supervisor or
adapter startup with an out-of-range or misordered limit must fail closed.

Journal deduplication precedes capacity admission. Identical retries attach to
the first dispatch and consume no additional execution slots. A distinct
operation that remains busy through the one-second admission window receives a
retryable non-durable unavailable response; the Supervisor releases that
operation's reservation and never starts its effect after the deadline. Retry
that operation later with the same ID and hash.

A timeout response before cancellation settlement is transient and is not
proof of a durable timeout journal entry. Retry only with the exact same stable
operation ID and request hash; the Supervisor will attach it to the existing
reservation. Do not generate a replacement operation ID, manually repeat a
Docker lifecycle action, remove a reservation file, or free a held execution
slot. If the effect remains unsettled, preserve the managed resources and
journal directory, collect only redacted service evidence, and restart the
Supervisor through the approved service procedure so stale-reservation
recovery and strict resource adoption can reconcile the derived names.
This includes a Dockerode mutation that rejects on local request abort and the
narrow response-less codes `ECONNRESET`, `EPIPE`, `ECONNABORTED`, and
`ERR_STREAM_PREMATURE_CLOSE` while its signal is still active: their daemon-side
outcome is unknown until strict inspection or restart/adoption reconciliation.
An HTTP/status-bearing error, accessor-backed or malformed error, policy or
validation failure, not-found response, or any other transport code is not in
this class and must follow its normal bounded terminal path.

For a stale lifecycle reservation, the replacement Supervisor must recover its
durable stage rather than replay the Docker call blindly. The only permitted
stages are `reserved`, `start_pending`, `stop_pending`, and `delete_pending`.
Start, stop, and delete write their matching pending stage before mutation;
restart writes `stop_pending`, proves the exact gateway stopped, advances to
`start_pending`, and then starts it. Generic Docker restart is forbidden.
Strict inspection turns an already-running start, already-stopped stop,
already-running restart start-half, or already-absent delete into the accepted
terminal observation without a duplicate mutation. Any incompatible or
out-of-order stage fails closed. Never edit a stage or lock by hand: journal
updates are canonical, atomic, directory-synced `0600` records containing only
protocol version, request hash, random ownership token, and the closed stage.

Provision reservations remain `reserved` by design. Recovery relies on stable
derived names and strict validation/adoption of each volume, network, helper,
and gateway boundary. Do not infer completion from a lifecycle stage or relax
adoption checks. A future provision progress machine requires its own reviewed
closed schema and migration procedure.

Helper and failed-gateway cleanup uses an independent bounded signal even when
the parent operation is already aborted. Treat a terminal helper failure as
safe only when a follow-up inspect proved the exact derived name absent. If
force-remove or absence inspection is uncertain, the response remains
non-durable and the helper may still be running. Do not manually delete its
journal reservation or start a replacement helper. Perform an approved
Supervisor restart: exact initializer/verifier residue is strict-validated,
force-removed, absence-proven, and then provisioning resumes. Drifted residue
is never auto-removed; quarantine it, preserve redacted inspect evidence, and
require explicit operator investigation rather than broad Docker cleanup.
Before starting a replacement Supervisor, the service manager must confirm the
old PID has terminated and its singleton ownership is gone. If graceful close
does not exit within the configured shutdown window, stop the rollout and
escalate through the approved operator procedure; never launch a competing
replacement, remove the singleton record, or delete a live journal lock by
hand. After confirmed termination, the replacement may perform stale-
reservation recovery, exact helper adoption, absence proof, and exact old-stage
cleanup. Preserve any sibling `operation-*` stage and escalate drift rather
than applying a directory-wide cleanup.

## Product-image rollout

The official Hermes base lock is only a build input. Publish the Core-Agent
product image for each supported platform, capture registry RepoDigests, review
them, and publish one immutable product-image lock. Mount that same lock
read-only into API and Supervisor; do not use a local tag or let the two
processes load different files.

Before rollout, verify the product digest contains the fixed initializer and
gateway entrypoints, run migrations, validate service configuration, and run
deterministic gates. Select the accepted platform digest and increment Runtime
generation for an image change. Canary with synthetic data before any
authorized tenant rollout.

## Backup, restore, and evidence

Back up PostgreSQL authority and tenant Docker volumes on independent schedules
with encryption and access audit. A release is not recoverable merely because
a backup command succeeded: restore PostgreSQL and a representative synthetic
tenant volume on an isolated host, verify schema version, labels, manifest
hash, Profile presence, and a synthetic read path, then record timestamp,
backup identifiers, checksums, duration, and allowlisted final states. Never
put restored content or credentials in the evidence record.

Preserve PostgreSQL truth and tenant volumes when a rollout fails. Quarantine
unmatched Docker resources for investigation; do not relabel, adopt, or delete
them with broad filters.

## Logging and redaction

Use structured allowlisted fields. Error and dependency bodies are reduced to
fixed bounded summaries before persistence. Never log request/response content,
authorization headers, provider errors, Docker raw JSON, SQL row values,
secret paths that reveal tenant identity, or environment values. Apply the
sentinel scanner to application tables and inspect Docker configuration during
every release exercise. Restrict log access and retention even after redaction.

## Rollback

- Roll back application code only when that revision's expected schema version
  exactly equals the deployed schema version.
- Treat additive SQL migrations as roll-forward. Do not automatically
  down-migrate production data.
- Roll back a runtime image by selecting a previously accepted product digest
  and incrementing Runtime generation; never retag a mutable name in place.
- A failed rollout preserves PostgreSQL truth and tenant volumes.
- Supervisor adoption validates prior labels and canonical request hash before
  starting, stopping, replacing, or deleting any resource.

These rules do not implement image draining, secret rotation orchestration, or
multi-node scheduling. Those remain later Runtime phases and cannot be inferred
from a successful Runtime v1 smoke.
