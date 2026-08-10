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
SSE, the Docker-owning Runtime Supervisor, and a loopback consultant Web client.
Deterministic unit, browser, PostgreSQL, fake-integration, Compose, and security
gates are implemented. AC10 and the Conversation Reliability live-provider gate
passed on the target platform with the reviewed `v0.1.3` Core-Agent product-image
digest; the bounded evidence is recorded in the
[Runtime v1 acceptance record](docs/operations/runtime-v1-acceptance-evidence.md)
and [Conversation Reliability record](docs/testing/conversation-reliability-v1.md).

The runtime distribution vendors the reviewed Hermes source into this monorepo.
Local and release builds now build that locked source first and then create the
same isolated company runtime product image. The accepted decision and controlled
execution steps are recorded in
[ADR 0008](docs/architecture/0008-vendored-hermes-source-and-upstream-sync.md) and
the [Hermes source vendoring plan](docs/superpowers/plans/2026-08-07-hermes-source-vendoring.md).

## Control Plane Contracts

The versioned Control Plane wire contracts live in
[`packages/contracts`](packages/contracts). Run the complete release gate from
the repository root:

```bash
npm run contracts:check
```

See the [contract consumption guide](packages/contracts/README.md) and the
[Control Plane Contracts v1 design specification](docs/superpowers/specs/2026-08-03-control-plane-contracts-v1-design.md).
Production Web authentication, Apple clients, MCP Server, business Tools, and
real-user Identity/Consent/Retention/Data Governance remain outside this
milestone.

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

## Build Hermes Runtime locally

The canonical local build verifies the source lock, builds
`third_party/hermes-agent`, and then builds the Core-Agent product layer with both
the Core-Agent and upstream Hermes revisions recorded in image labels:

```bash
npm run hermes:source:verify
npm run hermes:build -- --tag core-agent/hermes-runtime:dev
```

`infra/hermes/Dockerfile.upstream-image` and
`infra/hermes/base-images.lock.json` are retained as historical migration and
diagnostic evidence only; no default local or CI build selects them. The accepted
`infra/hermes/product-images.lock.json` remains unchanged until a separately
approved manual release is built, reviewed on both platforms, and cut over.

## Strict smoke, terminal chat, and consultant Web

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
acceptance surface, not a customer-data interface.

The consultant Web demo uses the same managed Runtime lifecycle behind a narrow
same-origin Gateway. It is loopback-only, exposes one synthetic demo student,
accepts anonymous synthetic messages only, and keeps privileged Control Plane
and provider authority out of the browser. After completing the local smoke
prerequisites, start it from the repository root:

```bash
set -a
source .env.runtime
set +a
npm run web:control-plane
```

Open only the fixed `WEB_READY` URL printed by the process. Stop with `Ctrl-C` so
the Web server closes before the managed Runtime enters ordered cleanup. See the
[local smoke guide](docs/operations/runtime-v1-local-smoke.md#local-consultant-web-demo)
for the complete acceptance sequence.

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
acceptance paths for this milestone are the exact Control Plane smoke,
interactive terminal, and local consultant Web workflows in the
[local smoke guide](docs/operations/runtime-v1-local-smoke.md); do not assemble
a legacy Hermes-only Compose/bootstrap sequence from old commands.
