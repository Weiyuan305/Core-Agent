# Core-Agent

Core-Agent is the central orchestration platform for the study-abroad product
family. Hermes Agent supplies the agent runtime; this repository owns the
product distribution and the platform layers around it.

## Repository boundary

Core-Agent contains runtime distribution, Control Plane, trusted identity and
entitlement contracts, memory/policy plugins, Capability/MCP routing, the
product event protocol, audit, and evals.

EduApply, IELTS teaching, housing, and browser execution remain independent
domain services and connect through versioned MCP interfaces.

## Current milestone

Runtime v1 now implements the internal single-node Control Plane: PostgreSQL
migrations and repositories, the private Fastify API, durable Worker jobs and
SSE, and the Docker-owning Runtime Supervisor. Deterministic unit, PostgreSQL,
fake-integration, Compose, and security gates are implemented. The opt-in real
Hermes acceptance smoke is available but AC10 remains pending until it runs on
a target platform with a reviewed Core-Agent product-image digest.

## Control Plane Contracts

The versioned Control Plane wire contracts live in
[`packages/contracts`](packages/contracts). Run the complete release gate from
the repository root:

```bash
npm run contracts:check
```

See the [contract consumption guide](packages/contracts/README.md) and the
[Control Plane Contracts v1 design specification](docs/superpowers/specs/2026-08-03-control-plane-contracts-v1-design.md).
The public Web client, Apple client, MCP Server, business Tools, and real-user
Identity/Consent/Retention/Data Governance remain outside this milestone.

## Runtime v1 design and operations

The implemented internal, single-node design is
[Control Plane Runtime v1](docs/superpowers/specs/2026-08-03-control-plane-runtime-v1-design.md).
Its decisions are indexed in [`docs/architecture`](docs/architecture/README.md).
Use the [local smoke guide](docs/operations/runtime-v1-local-smoke.md),
[production boundary](docs/operations/runtime-v1-production-boundary.md), and
[acceptance evidence](docs/operations/runtime-v1-acceptance-evidence.md) for
release work.

## Publish Hermes Runtime

The Core-Agent Hermes product image is published manually to the private
`ghcr.io/weiyuan305/core-agent-hermes-runtime` package by
`.github/workflows/publish-hermes-runtime.yml`. The workflow accepts only a
canonical release version and a full source commit already reachable from
`main`; it publishes immutable amd64/arm64 manifests and never creates a
`latest` tag.

The workflow uploads, but never commits, a candidate lock. An operator must
compare its two platform digests with GHCR and then commit the bytes unchanged
as `infra/hermes/product-images.lock.json`. See the
[local smoke guide](docs/operations/runtime-v1-local-smoke.md#publish-and-review-the-private-hermes-runtime)
for the exact private pull and review procedure.

## Strict smoke and interactive chat

Both real-runtime commands require the reviewed product-image lock and the
private local environment described by the local smoke guide. The strict smoke
uses one fixed prompt and emits only allowlisted acceptance evidence:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane
```

The interactive client sends anonymous synthetic prompts through the Control
Plane and streams assistant text only to the current terminal:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:control-plane
```

Use `--keep-runtime` only when the running synthetic topology must remain for
inspection. An interactive kept session writes a private exact-target receipt;
clean it with `npm run chat:cleanup`. The interactive client is a developer
acceptance surface, not the future Web, Apple, or customer-data interface.

## Prerequisites

- Node.js >=22.13.0
- Docker Engine/CLI with Docker Compose v2 and Docker Buildx

## Deterministic verification

```bash
npm test
npm run check
npm run test:runtime
```

PostgreSQL and real integration gates require the dedicated test database
described by the Runtime v1 operations documents. The only supported real
acceptance paths for this milestone are the exact, opt-in Control Plane smoke
and interactive workflows in the
[local smoke guide](docs/operations/runtime-v1-local-smoke.md); do not assemble
a legacy Hermes-only Compose/bootstrap sequence from old commands.
