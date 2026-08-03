# ADR 0005: Hermes Profile Bootstrap Without Container Exec

Status: Accepted

Date: 2026-08-03

Derived from decision IDs: D08, D10, D11

## Context

The existing development bootstrap creates Profiles and writes Profile-scoped
API keys by running `docker compose exec` in an already running Hermes
container. Runtime v1 has accepted a stricter boundary: Runtime Supervisor must
not offer arbitrary container `exec`, and no secret value may appear in Docker
configuration environment.

The pinned Hermes source provides Profile creation through its local CLI and a
separate Web management server, while the production gateway API provides
Profile-scoped conversation routes such as
`/p/<profile>/v1/chat/completions`. Enabling a second general management server
inside every company runtime would enlarge the attack surface and still require
a separate secret-provisioning contract.

## Decision

Add a fixed initialization mode to the Core-Agent Hermes product image.
Runtime Supervisor may launch it only as part of an allowlisted `provision`
operation and only before the company gateway starts.

The initializer:

- is pinned by immutable image digest;
- receives a versioned RuntimeBootstrapBundle through a server-derived,
  read-only file path;
- validates the bundle inside the initializer;
- mounts only the target company volume and read-only secret staging files;
- has no network, Docker Socket, shell API, added capability, host namespace,
  or arbitrary command;
- invokes the pinned Hermes Profile creation behavior with fixed safe flags;
- writes only declared Profile descriptions, provider/model configuration, and
  required Profile `.env` values;
- uses atomic replacement and `0600` permissions for secret-bearing files;
- writes a non-secret manifest containing bundle version, tenant/runtime IDs,
  Profile references, image digest, and canonical hash.

Supervisor resolves opaque SecretStore references; secret values never cross
the Control Plane HTTP API or appear in the Unix protocol. Temporary bootstrap
files live in a Supervisor-owned restricted directory or tmpfs and are removed
after the initializer exits.

The product gateway entrypoint receives the ingress secret as a read-only file,
reads it immediately before process start, and exports `API_SERVER_KEY` only in
the gateway process environment. The Docker container configuration contains
the secret file path, not its value.

The Worker calls a named Profile only through the supported multiplex route:
`/p/<hermes_profile_ref>/v1/chat/completions`.

## Alternatives considered

### Continue using `docker exec`

Rejected because a generic exec facility defeats the narrow Supervisor
boundary and makes command/argument injection a host-authority concern.

### Expose the Hermes Web management server

Rejected because Runtime v1 needs a narrow provisioning operation, not a full
Profile administration UI/API inside every company container. It also does not
solve file-backed secret injection by itself.

### Directly manipulate Docker volume host paths

Rejected because Docker-managed volume paths are engine implementation details,
vary across Linux, Docker Desktop, and Colima, and would require unsafe raw host
path authority.

### Put keys in Docker environment configuration

Rejected because Docker inspection can expose configured environment values to
any caller with Docker authority.

### Patch upstream Hermes core first

Rejected for Runtime v1 because a product-image initializer and entrypoint are
sufficient. If future Hermes layout changes make this adapter unsafe, a
documented upstream/plugin proposal may supersede this ADR under ADR 0001.

## Consequences

- The product image owns two stable entry modes: volume initialization and
  gateway runtime.
- Initializer compatibility becomes part of every pinned Hermes upgrade test.
- Profile files contain operational secret projections inside each isolated
  tenant volume; SecretStore remains their source and PostgreSQL stores only
  references.
- Secret rotation is not implied by initial provisioning and requires Runtime
  v1.1 design.
- Tests must inspect container configuration, initializer networking,
  capabilities, commands, mounts, output, and generated file permissions.

## Supersession rule

Enabling a general management server, arbitrary exec, environment-configured
secret values, or a different Profile storage contract requires a superseding
ADR and threat-model review.
