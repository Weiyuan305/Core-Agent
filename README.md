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

The first milestone builds a reproducible Hermes runtime image and a local
single-company container with two consultant Profiles. It intentionally has no
business MCP, custom UI, or production tenant provisioning yet.

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

The development API binds only to `127.0.0.1:18642`.
The demo bootstrap copies that loopback container ingress key into each named
Profile secret scope. It is transport authentication, not a consultant
identity or authorization boundary.
