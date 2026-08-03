# ADR 0004: Internal API, Secret, and Streaming Boundaries

Status: Accepted

Date: 2026-08-03

Decision IDs: D04, D06, D08, D13, D14

## Context

Runtime v1 needs a callable API and a real Hermes conversation before the
Identity/Entitlement, MCP, Policy, Memory, and public-client phases exist. It
must not create a temporary public authentication contract or store model and
container credentials in ordinary application data.

The accepted Contracts define asynchronous Run and ProductEvent concepts but
do not yet define the user Message that starts a Run.

## Decision

### Internal API

Expose only a versioned `/internal/v1` API on loopback or private networking.
Authenticate it with one out-of-band bootstrap service key. Map that caller to
a tenant-scoped service Actor and active admin Membership for audit. Do not
present it as human authentication or a future public token.

Expose narrow provisioning, runtime-command, Conversation, Run, resource-query,
and event-stream endpoints. Do not expose generic CRUD for every identity
resource in this milestone.

### Streaming

Agent execution is asynchronous:

- Run creation returns `202 Accepted` and a durable `run_id`;
- Worker execution produces ordered ProductEvents;
- each Conversation owns a contract Session whose server-generated
  `hermes_session_ref` is sent as `X-Hermes-Session-Id` to the selected Profile;
- SSE reads committed event rows and resumes from a sequence cursor;
- a client disconnect does not cancel or fail the Run;
- an explicit retry creates a new Run with `parent_run_id`.

Do not use synchronous long-polling as the primary Run protocol and do not
introduce WebSocket state before bidirectional real-time behavior is required.
Hermes Session continuity is runtime state and does not implement the later
Composite Memory authority or consent model.

### Secrets and provider configuration

Use a pluggable `SecretStore`. PostgreSQL stores only opaque secret references,
versions, purposes, and status. The development adapter reads owner-only files
under one fixed root; a future production adapter can use a cloud secret
manager.

The fixed Hermes initializer copies the minimum required Profile secrets into
the tenant's isolated volume with `0600` permissions. The gateway ingress key
is mounted as a read-only file and read by the product entrypoint; its value is
not a Docker environment-config field. The runtime volume is an operational
projection, while SecretStore remains the source of secret material.

Provider base URLs and model IDs live in a server-managed allowlisted catalog.
API input selects a provider configuration ID and cannot submit an arbitrary
URL, model, environment variable, or secret path.

### Contract extension

Before Runtime code, publish an additive Contracts minor release containing:

- a bounded Message resource;
- a Create Agent Run request with client correlation ID and bounded user text;
- additive `message.created` event semantics;
- generated JSON Schema, fixtures, changelog, compatibility declaration, and a
  new immutable release snapshot.

The server, not the client, derives Message/Run resource IDs, tenant/Profile
binding, role, status, timestamps, and resource versions. Do not store prompt
input in an unversioned internal JSON shape.

### Quality gate

Use four layers:

1. pure unit tests;
2. real PostgreSQL migrations/concurrency/isolation tests;
3. deterministic integration tests with fake Supervisor and fake streaming
   Hermes;
4. an opt-in real Docker/Hermes smoke using user-provided secrets outside CI.

## Alternatives considered

### Implement Identity and Entitlement now

This would expand one Runtime slice into authentication, role, signing,
entitlement, purchase, and revocation systems. Those remain the next separate
platform phase.

### Public Bearer API

Rejected because it would create a security contract without login, token
issuance, revocation, tenant authority, or public gateway controls.

### Synchronous HTTP completion

Rejected because model latency and long work cause timeout pressure, prevent
durable progress, and force future Web/Apple clients to replace the protocol.

### WebSocket

Rejected for v1 because server-to-client event delivery and cursor resume are
sufficient. Bidirectional connection ownership, heartbeat, load balancing, and
reconnect state would add complexity without a current requirement.

### Encrypted secret values in PostgreSQL

Rejected for v1 because it concentrates ciphertext, key rotation, backup, and
master-key failure into the application database. References provide a cleaner
adapter boundary.

### Ordinary environment variables for all tenant secrets

Rejected because dynamic company/Profile/provider secrets cannot be addressed,
versioned, or rotated safely through one flat process environment.

### Generic resource CRUD

Rejected because the Identity Runtime has not defined public administration
semantics. One validated provisioning command is enough for the accepted
vertical slice.

### Mock-only or real-secret CI

Mock-only tests miss PostgreSQL semantics; real-secret CI risks credential
exposure and large Hermes image cost. The four-layer split preserves both
determinism and a real local proof.

## Consequences

- Runtime v1 remains unreachable to students and consultants directly.
- The later Identity/API Gateway replaces the authentication adapter without
  changing Worker, Supervisor, or durable Run semantics.
- Future Web/Mac/iOS clients can consume the same asynchronous resource and SSE
  model after public authorization is added.
- Secret Store and provider catalog adapters become explicit platform ports.
- The Contracts package receives a reviewed additive minor release before
  Runtime implementation starts.

## Supersession rule

Public authentication, WebSocket adoption, database-held secrets, arbitrary
provider URLs, or generic identity CRUD require a superseding ADR and threat
model review.
