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

## Prerequisites

- Node.js 22+
- Docker with Docker Compose v2

## Runtime commands

```bash
npm test
npm run hermes:image-ref
npm run hermes:build
cp .env.runtime.example .env.runtime
# Set CORE_AGENT_API_SERVER_KEY to: openssl rand -hex 32
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml up -d
npm run hermes:bootstrap
set -a; source .env.runtime; set +a; npm run hermes:smoke
```

The legacy loopback demo above is separate from Control Plane Runtime v1. The
Runtime v1 deterministic gate is `npm run test:runtime`; its explicit real
acceptance command is `CORE_AGENT_REAL_HERMES_SMOKE=1 npm run
smoke:control-plane` after every prerequisite in the local smoke guide is met.

The development API binds only to `127.0.0.1:18642`.
The demo bootstrap copies that loopback container ingress key into each named
Profile secret scope. It is transport authentication, not a consultant
identity or authorization boundary.

## Stop the development runtime

```bash
docker compose --env-file .env.runtime -f infra/hermes/compose.dev.yaml down
```

This preserves the named volume. Add `--volumes` only when intentionally
destroying all demo-company runtime data.
