# Architecture Decision Records

Architecture Decision Records (ADRs) preserve long-lived Core-Agent decisions,
the alternatives considered, and the consequences accepted at the time.

## Index

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-hermes-runtime-distribution.md) | Accepted | Hermes Runtime distribution boundary |
| [0002](0002-control-plane-runtime-topology.md) | Accepted | Single-node API, Worker, and privileged Runtime Supervisor topology |
| [0003](0003-control-plane-durable-execution-and-storage.md) | Accepted | PostgreSQL authority, Kysely, leased jobs, and Transactional Outbox |
| [0004](0004-control-plane-internal-api-security-and-streaming.md) | Accepted | Internal API, SecretStore, asynchronous Run/SSE, and Message contract addendum |
| [0005](0005-hermes-profile-bootstrap-without-container-exec.md) | Accepted | Fixed no-network Profile initializer and file-backed Hermes ingress secret |
| [0006](0006-idempotent-provisioning-and-runtime-command-intent.md) | Accepted | Atomic tenant provisioning, truthful runtime commands, and durable restart intent |

## Change policy

- Do not rewrite an accepted ADR to hide an earlier decision.
- Add a new ADR that explicitly supersedes the old record.
- Link the affected design specification and migration/compatibility plan.
- Keep rejected alternatives and consequences so future reviewers can
  understand why the original boundary existed.

The current Runtime design is
[Control Plane Runtime v1](../superpowers/specs/2026-08-03-control-plane-runtime-v1-design.md).
