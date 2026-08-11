# ADR 0002: Control Plane Runtime Topology

Status: Accepted

Date: 2026-08-03

Decision IDs: D01, D03, D05, D10, D11

## Context

Core-Agent must turn the existing Hermes distribution and Control Plane
Contracts into a running backend. The first deployable target is one Linux host
with one isolated Hermes container per company; Mac and Colima provide the
development equivalent.

Docker Engine access is root-equivalent. Combining public request handling,
long-running Agent work, and Docker authority in one process would make any API
or dependency compromise a host compromise and would couple request
availability to slow model/container operations.

## Decision

Use a single-node topology with three separate TypeScript processes:

1. **Control Plane API** — Fastify, internal HTTP, schema validation,
   idempotency, transactions, queries, and SSE;
2. **Control Plane Worker** — durable PostgreSQL jobs, runtime reconciliation,
   Hermes calls, and event production;
3. **Runtime Supervisor** — a narrow Unix Domain Socket service and the only
   process with Docker Socket access.

The API and Worker never receive Docker Socket access. The Supervisor accepts
only versioned, allowlisted lifecycle operations built from server-derived
RuntimeSpec values. Company Hermes containers have private networking, separate
persistent volumes, pinned image digests, and no public host ports.

Profile creation is performed before gateway startup by one fixed, pinned,
no-network initializer mode in the Core-Agent product image. This is an
allowlisted provisioning step, not arbitrary container `exec`. The gateway
entrypoint reads its ingress key from a mounted secret file so the value is not
stored in Docker configuration environment.

The initializer owns the Hermes compatibility adapter. For each Profile it
writes a private `.env` and a `config.yaml` selecting the named custom provider
`core-agent-managed`, `key_env`, `transport: chat_completions`, and the approved
model. Provider catalog endpoints ending in `/chat/completions` are normalized
to the OpenAI-compatible base URL at this boundary, and URLs with query strings
are rejected. Legacy `LLM_MODEL` and `OPENAI_BASE_URL` variables are not part of
the managed Runtime contract.

Mac + Colima development and Linux production use the same component and
network boundaries. The topology is intentionally single-node, but the
Supervisor protocol leaves a future path to a mutually authenticated remote
Runtime Agent.

Runtime v1 must finish a real vertical slice: provision a company and Profiles,
reach a healthy Hermes container, execute one Profile conversation, and expose
durable events. Container-only CRUD is insufficient evidence.

### Development network and bind ownership

The development Compose project treats `core-agent-backplane` and
`core-agent-egress` as external, pre-existing bridges. `npm run runtime:network`
creates both idempotently with the exact labels enforced by Runtime Supervisor,
or refuses a network whose driver, internal flag, attachability, name, or
labels drift. Backplane is internal; egress is deliberately non-internal so
Hermes can reach the selected HTTPS model provider. The egress bridge has the
closed single-host contract `172.31.240.0/24`, gateway `172.31.240.1`, local
scope, IPv6 and swarm ingress disabled, default IPAM, and IP masquerading
enabled. Preparation fails closed if that CIDR is unavailable or any of those
settings drift in Docker IPAM. This is not a portable host-route detector:
operators separately inspect host, VPN, and VM routes before deployment and
must reject any overlap. Neither network is attachable.
Compose teardown therefore cannot claim a network containing
Supervisor-managed Hermes containers.

The Worker joins the backplane so it can call the private Hermes gateway. The
Supervisor container itself uses `network_mode: none`: Docker socket authority,
not membership in an application network, lets it create each Hermes container
with `NetworkMode=core-agent-backplane`. Dynamically created Hermes containers
join exactly backplane plus the dedicated egress bridge and publish no host
port. Runtime observations select the backplane address, never the egress
address. Worker joins only the ingress side; API, PostgreSQL, and migration join
only the separate internal control network. Egress is a single-host v1 trust
boundary, not a tenant firewall: Docker authority and host networking remain
trusted. A later proxy can narrow provider destinations without changing the
Worker-to-Hermes protocol.

Supervisor file creation and Docker bind construction use paired roots. The
Supervisor writes through fixed local staging/ingress roots, then maps only a
validated relative descendant to a separately configured canonical Docker-host
root. Requests cannot supply either form. The staging view is a real bind mount,
not private tmpfs, because sibling containers are created by the host daemon.
On Linux the Docker-host value is the canonical host path. On macOS/Colima it
must be a canonical shared host path, normally below `/Users`; a path that
exists only inside Supervisor is invalid.

Docker access is accepted only through a documented local Unix context. Compose
parameterizes the daemon-side socket bind source and mounts it at the fixed
Supervisor path. A one-shot service built from the exact Supervisor image runs
with the final Supervisor uid/gid and socket supplementary group, the identical
read-only socket mount, `network_mode: none`, all capabilities dropped,
`no-new-privileges`, and no privileged mode. It validates exact socket metadata
and performs only a three-second `GET /_ping`; Supervisor depends on successful
completion. Linux uses its canonical Engine socket. Docker Desktop for macOS
uses the VM-side `/var/run/docker.sock.raw`. Colima uses socket path and group
metadata obtained inside the explicitly selected VM, never inferred from a
macOS compatibility symlink. A successful preflight proves access but does not
reduce Docker socket authority, which remains effectively root-equivalent.

The API normally accepts only a loopback listen address. Its container image
may bind `0.0.0.0` only when the deployment sets the exact
`CONTROL_PLANE_API_CONTAINER_BIND=1` opt-in. The API service itself has no host
port. A separate fixed, credential-free TCP `api-ingress` service joins the
internal control network and a dedicated host-ingress bridge, proxies only to
`api:8787`, and is the sole publisher of `127.0.0.1:8787`. This is container
wiring, not permission to expose the API on a public host interface.

Provider and Hermes-ingress bytes are separate read-only projections. The
Worker receives only the ingress projection. The Supervisor routes
`model_provider` references to the provider projection and `hermes_ingress`
references to the ingress projection, rejecting every other secret purpose;
it never receives the bootstrap key. The provider catalog and image lock are
non-secret managed configuration, not substitutes for either projection.

The API bootstrap key uses its own protected projection boundary. Host
preflight validates the API-UID-owned `0600`, single-link regular source without
reading it. A bounded root one-shot with `network_mode: none` validates the
explicit Docker mount-view owner/group, copies the material into an isolated
named volume, and assigns the configured non-root API UID/GID with exact mode
`0600`. Only API mounts that volume read-only; Worker, Supervisor, PostgreSQL,
migration, database-auth one-shots, and API ingress receive neither its source
nor projection. This avoids relying on Compose file-secret `uid`, `gid`, and
`mode` metadata that Docker Desktop or Colima may ignore.

The image targets retain non-root identities: API defaults to its independent
application UID `12000`, while Worker and Supervisor explicitly share runtime
UID `12002`. The shared identity is required because Worker reads the
Supervisor-owned `0700` Hermes ingress projection and `FileSecretStore` requires
the current UID to own that root and each `0600` leaf. Compose accepts no
independent Worker UID/GID input. API and runtime UIDs may not collide with
PostgreSQL `999`, role bootstrap `12003`, or migrator `12004`. Host projections
must be created for the configured API and shared runtime owners.

Every API, Worker, and Supervisor target UID, primary GID, shared socket GID,
and Supervisor Docker supplementary GID must be nonzero. Root-owned
Docker Desktop/Colima protected credential source mounts remain a separate, explicit
mount-view compatibility policy; root source metadata never authorizes a root
application target.

Database credentials are projected by one root, networkless one-shot into six
consumer-specific named volumes. PostgreSQL, role bootstrap, HBA convergence,
migrate, API, and Worker each mount only their approved volume read-only. API
and Worker therefore cannot enumerate another database credential even under a
container user override; file ownership is defense in depth, not the isolation
mechanism.

The Supervisor state mount is a caller-named bind root. The UDS instead uses the
Compose-owned `supervisor-socket` named volume so Worker and Supervisor do not
depend on a host socket path. Before Compose, `npm run runtime:paths` validates
four caller-controlled host projections as separate purposes: bootstrap file,
provider root, ingress root, and state root. Every configured
existing path must already equal its canonical path. Every ancestor must be a
non-symlink directory owned by root or the preflight caller and prohibit group
and other writes, so an attacker cannot replace a validated leaf through a
writable parent. Provider and ingress must be existing exact `0700`
directories. State may be absent, but preflight creates it only below a
canonical protected parent and then repeats canonical, opened-handle,
named-inode, owner, group, type, and exact `0700` checks.

A one-shot `supervisor-socket-volume-init` service runs as root with no network,
a read-only root filesystem, all capabilities dropped except `CHOWN` and
`FOWNER`, and the exact named volume mounted at `/run/core-agent/supervisor`.
It assigns the configured runtime UID/socket GID and mode `0700`, then
revalidates the final metadata. Supervisor mounts the volume read/write; Worker
mounts the same volume read-only. Neither API nor migration receives it.

Preflight also creates and revalidates exact `0700` `staging` and `ingress`
children below the state root. Initializer, manifest verifier, and gateway run
with the same explicit numeric uid/gid as Supervisor. Those values are trusted
startup configuration, must equal Supervisor's effective identity, and are
never request fields. The product image seeds an empty root-owned sticky
`01777` volume root so Docker copy-up supports that arbitrary uid; initializer
then creates tenant metadata, Profile directories, and secret-bearing leaves
as the managed uid with `0700`/`0600`. The sticky root contains no secrets and
does not relax its private children.

The four canonical host paths are pairwise rejected if they are equal or if either
is an ancestor of the other. This prevents the Worker-visible ingress or
state mount from containing bootstrap or provider bytes. With no UID
override the runtime roots must be `12002:12002`; a caller who cannot create
that ownership must prepare it explicitly rather than receive a silent
chmod/chown. With a host override the same numeric value drives Worker,
Supervisor, the credential projector, and preflight policy. Worker mounts only
ingress and the socket
volume, with the socket mount read-only; migration receives no runtime root. The
bootstrap source is separately rejected unless it is a regular file owned by
the exact effective API UID/GID with mode `0600` and exactly one hard link.
Preflight verifies link-count stability across its named/opened/named snapshots,
opens metadata only, and never reads secret bytes. The API bootstrap loader and
the shared provider/ingress `FileSecretStore` repeat the single-link requirement
before and after bounded reads and during final pathname revalidation. Secret
content must be non-empty valid UTF-8 with no NUL, carriage return, or line feed.
This
closes hard-link aliases introduced before preflight or while secret material is
being loaded.

This UID convergence is strictly a local-development compatibility mechanism.
Production must keep API on a dedicated application identity and configure one
shared Worker/Supervisor runtime identity. It must use the real orchestrator's
ownership-aware secret, state, and UDS projections instead of silently
converging services onto an arbitrary host user.

### Supervisor deadline and journal ownership

The Supervisor journal requires Node.js 22.13.0 or newer. Each operation owns a
permanent digest-named, mode-`0600` SQLite guard file. `BEGIN IMMEDIATE` holds
that guard from journal read, through durable pending-stage transitions and the
Supervisor callback, to terminal record fsync. The guard is never renamed or
unlinked: process death releases SQLite's OS lock and a successor reads the
canonical pending record before recovery. A legacy `.lock` reservation is an
unsafe mixed-protocol artifact and fails closed. `node:sqlite` remains
experimental on the supported Node 22 line; the runtime deliberately does not
suppress that warning or any other process warning.

Runtime v1 has one exported production deadline budget. Initializer and
manifest-verifier execution receive 25 seconds each. Five independent
reconciliation windows of 10 seconds cover two prior helper residues, the new
initializer, the new verifier, and failed-gateway absence proof; 10 seconds
remains for the other bounded Docker calls. That 110-second worst-case
sequential composition is strictly below the 120-second
effect budget. A request may wait at most 1 second for admission after journal
deduplication, the Supervisor operation deadline is 150 seconds, cancellation
settlement is allowed 20 further seconds, and the Runtime Supervisor client
waits 180 seconds. Configuration must preserve both
`initializer + verifier + 5 * reconciliation + overhead < effect < operation`
and `admission + operation + settlement < client`. Test-only values may scale
the same ordering down, but production components import the shared budget
rather than restating numbers.

Journal lookup and in-flight attachment happen before execution-capacity
acquisition. Only the first dispatch for an operation can own one of the four
execution slots; any number of identical in-process retries attach without
consuming more capacity. If a new operation cannot acquire a slot before its
receipt-relative admission deadline, it receives a retryable, non-durable busy
response. A still-`reserved` journal reservation is released, no effect may
start after that deadline, and a later retry may reserve and dispatch normally.
If a non-`reserved` lifecycle stage reaches an admission or closing transient,
the journal commits and retains its canonical mode-`0600` pending JSON record,
then releases its SQLite transaction. The permanent guard remains in place but
is not a claim; a successor acquires the OS-released per-operation transaction
and recovers that exact stage without a stale interval. A `reserved` transient
removes only its pending JSON record, never the guard.

A settled, retryable Provision dependency failure is also transient only while
its journal stage remains `reserved`. The stable Provision operation ID may
then dispatch again and strictly adopt the same derived resources. Accepted or
non-retryable responses remain terminal. Lifecycle retryable failures are not
generalized into this rule: once their stage is non-`reserved`, the pending
record remains recoverable and the Worker stays observe-only. A caller timeout
or daemon-uncertain mutation remains unsettled and retains its reservation.

The separate 120-second effect deadline aborts every supported Dockerode
inspect, create, wait, log, start, stop, restart, and remove request. Reaching
that deadline does not
itself complete the operation journal. The journal callback waits for the
adapter to settle and records an accepted late result when the effect completed
despite cancellation, or records a terminal timeout only after the adapter has
settled without an accepted result. The 150-second outer operation boundary and
20-second settlement window bound only the caller response; they never delay
effect cancellation to 150 seconds. This prevents a timeout record from racing
an in-process effect that can still mutate Docker.

If an implementation violates the cancellation contract and remains unsettled
through the 20-second settlement window, the UDS caller receives a bounded,
retryable timeout but that response is deliberately not a durable journal
record. The same operation ID remains reserved, its execution slot remains
owned, and retries attach to the single in-flight promise. A later settled
result becomes the only durable record. Process shutdown remains bounded; after
a crash, SQLite guard recovery and strict Docker adoption inspect
the stable derived resource names before any new effect. The Supervisor never
starts a second in-process effect merely because the transport wait expired.
In particular, a mutating Dockerode request that rejects locally after abort is
still remote-uncertain: the adapter keeps it unsettled because local HTTP
rejection does not prove that Docker daemon work was cancelled. The same rule
applies while the signal remains active when a real `Error` carries one of the
narrow response-less transport codes `ECONNRESET`, `EPIPE`, `ECONNABORTED`, or
`ERR_STREAM_PREMATURE_CLOSE`. The classifier reads only own data descriptors
and rejects HTTP/status-bearing errors, accessors, malformed values, policy or
validation errors, not-found responses, and every unlisted code. Strict
inspection may settle a provable final state; otherwise the stable reservation
remains unresolved for restart and exact-name adoption.

Lifecycle recovery also persists a closed, request-specific stage inside the
reservation before issuing the corresponding mutation. `start` may advance
only from `reserved` to `start_pending`, `stop` only to `stop_pending`, and
`delete` only to `delete_pending`. `restart` is deliberately two-stage:
`reserved -> stop_pending -> start_pending`; it never delegates to Docker's
combined restart operation. A replacement Supervisor that owns an aged
reservation receives both the recovered flag and the last durable stage. It
strict-inspects the exact derived gateway, short-circuits a start already
running or a stop already stopped, and treats an already-absent delete as
accepted. Restart resumes the pending half: it proves stopped before advancing
to `start_pending`, then starts only when strict inspection is not already
running. The allowlist and transition graph are enforced by both the journal
and adapter, and every stage replacement is canonical JSON, atomically renamed,
directory-synced, and mode `0600`. The reservation contains only protocol
version, request hash, random owner token, and stage; operation IDs, tenant or
runtime identifiers, provider data, and secrets are excluded. Reservation
input is accepted only when its bytes exactly match that canonical encoding;
reordered keys, additional whitespace, duplicate keys, alternate numeric
spellings, and every other noncanonical representation fail closed before
dispatch. After every awaited stage advance and immediately before every
lifecycle mutation, including both restart halves, the adapter rechecks the
operation abort signal. Cancellation while a stage write is blocked can leave
the durable stage recoverable but cannot dispatch the subsequent Docker
mutation.

Provision intentionally remains at `reserved`. Provisioning is a multi-resource
reconciliation rather than one reversible lifecycle mutation: deterministic
names plus strict immutable validation/adoption independently reconcile the
volume, network, helpers, and gateway after a crash. Reusing a single lifecycle
stage for those create/start boundaries would falsely imply which resource was
completed. If provision recovery later needs finer progress, it must introduce
a separately reviewed closed state machine for each reconciliation boundary.

Initializer, manifest-verifier, and failed gateway cleanup do not reuse an
already-aborted operation signal. Each force-remove and follow-up inspection
uses an independent bounded reconciliation signal. A terminal response is
possible only after inspection proves the exact derived container name absent.
A present object, timed-out inspection, or unclassified Docker failure leaves
the operation unsettled and therefore non-durable. On restart, an exact helper
residue is validated against its immutable image, identity, labels, command,
security controls, volume, and protected staging binds before it is removed and
absence-proven. The validated old Docker-host `operation-*` staging root is
mapped to its paired Supervisor-local root and that exact protected tree is
deleted only after every matching helper is absent; sibling stages are never
touched. Any drift is rejected without mutation and must be quarantined
for operator investigation.

PostgreSQL startup converges both fresh volumes and the narrowly accepted legacy
official-image `trust` shape to `scram-sha-256` host authentication before
migration. The bootstrap superuser is confined to bootstrap/convergence
one-shots: a non-superuser migrator owns the database/schema and a distinct
non-superuser application role is used by API and Worker. Public exposure
remains forbidden; production additionally requires transport protection while
retaining these least-privilege role and credential-volume boundaries.

## Alternatives considered

### Remote Docker host from v1

This improves physical separation but immediately requires remote-agent
identity, TLS/SSH lifecycle, network partitions, remote secret delivery, and
distributed reconciliation. Those are not necessary to validate the first
backend slice.

### Kubernetes or multi-node scheduling from v1

This would introduce a scheduler, cluster identity, persistent-volume classes,
pod security, service discovery, and rollout control before the product has one
working company conversation. It is deferred.

### API and Worker combined

This reduces one process but couples HTTP/SSE availability to model streams,
leases, probes, and backoff. Separate processes share code without sharing
failure or capacity boundaries.

### API or Worker mounts Docker Socket

Rejected because Docker access can grant root-level host authority. Internal
network placement and a service key reduce exposure but do not remove the need
for least privilege.

### Docker CLI subprocesses

Rejected because they retain the same authority while adding command argument,
process timeout, output parsing, and error-redaction hazards.

## Consequences

- The repository owns a versioned Supervisor protocol in addition to HTTP.
- Deployment has three application processes instead of one.
- API and Worker can restart and scale independently on the same node.
- The small privileged code surface can be audited and tested with a strict
  unsafe-operation matrix.
- Provisioning no longer depends on `docker compose exec` or a separately
  exposed Hermes management server.
- A later remote Runtime Agent can preserve the Control Plane interface while
  replacing the local Unix transport.
- Multi-node scheduling and high availability remain explicitly out of scope.

## Supersession rule

A future remote-agent or Kubernetes design must add a superseding ADR. It may
not silently give Docker authority to the API or Worker.
