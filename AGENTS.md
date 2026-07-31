# Core-Agent Repository Rules

## Ownership

This repository owns the central agent platform: Hermes distribution,
Control Plane, trusted context contracts, policy and memory plugins,
Capability/MCP routing, event protocol, audit, and evals.

Domain products such as EduApply, IELTS teaching, housing, and auto-apply
remain separate services. Integrate them through versioned MCP contracts;
do not copy their application code into this repository.

## Architecture constraints

- Keep final orchestration authority in one central agent runtime.
- Prefer Hermes plugins and external services before proposing an upstream core patch.
- Treat Hermes managed scope as configuration management, not as a hard security boundary.
- Enforce tenant identity, entitlement, and write approval outside model-controlled input.
- Keep B2B tenant data isolated by container and persistent volume.
- Keep business truth and durable memory in Supabase; local Hermes state is runtime state.
- Never commit credentials, generated API keys, customer data, or student data.

## Change discipline

- Add a spec and implementation plan before starting a new subsystem.
- Add tests before implementation for executable behavior.
- Pin upstream images and dependencies; do not use `latest`.
- Preserve rollback paths for every image or protocol change.
