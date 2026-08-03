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
