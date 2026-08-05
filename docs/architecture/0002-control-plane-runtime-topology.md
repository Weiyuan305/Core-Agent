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

Mac + Colima development and Linux production use the same component and
network boundaries. The topology is intentionally single-node, but the
Supervisor protocol leaves a future path to a mutually authenticated remote
Runtime Agent.

Runtime v1 must finish a real vertical slice: provision a company and Profiles,
reach a healthy Hermes container, execute one Profile conversation, and expose
durable events. Container-only CRUD is insufficient evidence.

### Development network ownership

The development Compose project treats `core-agent-backplane` as an external,
pre-existing internal bridge. `npm run runtime:network` creates it idempotently
with the exact labels enforced by the Runtime Supervisor, or refuses an
existing network whose driver, internal flag, attachability, name, or labels
drift from that contract. This prerequisite prevents Compose teardown from
claiming a network that contains Supervisor-managed Hermes containers.

The Worker joins the backplane so it can call the private Hermes gateway. The
Supervisor container itself uses `network_mode: none`: Docker socket authority,
not membership in an application network, lets it create each Hermes container
with `NetworkMode=core-agent-backplane`. Dynamically created Hermes containers
join only that backplane and publish no host port. The API, PostgreSQL, and the
one-shot migration process join only the separate internal control network.

The API normally accepts only a loopback listen address. Its container image
may bind `0.0.0.0` only when the deployment sets the exact
`CONTROL_PLANE_API_CONTAINER_BIND=1` opt-in; the development Compose boundary
then publishes that container port only as `127.0.0.1:8787`. This is container
wiring, not permission to expose the API on a public host interface.

Provider and Hermes-ingress bytes are separate read-only projections. The
Worker receives only the ingress projection. The Supervisor routes
`model_provider` references to the provider projection and `hermes_ingress`
references to the ingress projection, rejecting every other secret purpose;
it never receives the bootstrap key. The provider catalog and image lock are
non-secret managed configuration, not substitutes for either projection.

The image targets retain dedicated non-root identities: API `12000`, Worker
`12001`, and Supervisor `12002`. Development Compose deliberately runs Worker
and Supervisor with the same `${CORE_AGENT_RUNTIME_UID:-12002}` effective UID
so both can traverse one owner-only UDS root; API remains `12000` by default.
An explicit numeric host UID override makes all three development processes
compatible with macOS/Colima file projection, while `CORE_AGENT_RUNTIME_GID`
controls the bootstrap projection and `CORE_AGENT_SUPERVISOR_SOCKET_GID`
controls the private runtime roots.

The socket and Supervisor-state mounts are caller-named bind roots, never
Docker named volumes. Before Compose, `npm run runtime:paths` validates all
five caller-controlled projections as separate purposes: bootstrap file,
provider root, ingress root, socket root, and state root. Every configured
existing path must already equal its canonical path. Every ancestor must be a
non-symlink directory owned by root or the preflight caller and prohibit group
and other writes, so an attacker cannot replace a validated leaf through a
writable parent. Provider and ingress must be existing exact `0700`
directories. Socket and state may be absent, but preflight creates them only
below a canonical protected parent and then repeats canonical, opened-handle,
named-inode, owner, group, type, and exact `0700` checks.

The five canonical paths are pairwise rejected if they are equal or if either
is an ancestor of the other. This prevents the Worker-visible ingress or
socket mount from containing bootstrap, provider, or state bytes. With no UID
override the runtime roots must be `12002:12002`; a caller who cannot create
that ownership must prepare it explicitly rather than receive a silent
chmod/chown. With a host override the same numeric value drives both the
container user and preflight policy. Worker mounts only ingress and the socket
root, with the socket mount read-only; migration receives no runtime root. The
bootstrap source is separately rejected unless it is a regular file owned by
the exact effective API UID/GID with mode `0600` and exactly one hard link.
Preflight verifies link-count stability across its named/opened/named snapshots,
opens metadata only, and never reads secret bytes. The API bootstrap loader and
the shared provider/ingress `FileSecretStore` repeat the single-link requirement
before and after bounded reads and during final pathname revalidation. This
closes hard-link aliases introduced before preflight or while secret material is
being loaded.

This UID convergence is strictly a local-development compatibility mechanism.
Production must keep dedicated API `12000`, Worker `12001`, and Supervisor
`12002` identities and use the real orchestrator's ownership-aware secret,
state, and UDS projections instead of converging services onto a host user.

Development PostgreSQL trust authentication is permitted only on the isolated
internal control bridge. The official-image bootstrap superuser is not given
to an application process: a non-superuser migrator owns the database/schema
and grants default table/sequence privileges to a distinct non-superuser
application role used by API and Worker. Production must replace local trust
with TLS and managed credentials while retaining these least-privilege role
boundaries.

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
