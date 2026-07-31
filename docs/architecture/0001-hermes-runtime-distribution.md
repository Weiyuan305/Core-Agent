# ADR 0001: Hermes Runtime Distribution Boundary

Status: Accepted

## Context

Core-Agent needs Hermes memory, Profile, Skill, tool, and gateway behavior
without turning the product into a long-lived source fork. It also needs
repeatable company containers and a controlled upgrade/rollback path.

## Decision

Build a thin product image from an official Hermes image pinned by tag and
architecture-specific digest. Store persistent runtime data only under
`/opt/data`. Bake non-secret managed defaults into `/etc/hermes/config.yaml`.
Expose the API server only on the host loopback during development.

The product repository owns distribution and platform extensions. Hermes source
changes are allowed only after a plugin or external-service implementation has
been proven insufficient and the patch is documented in a separate ADR.

## Security boundary

Managed scope prevents ordinary profile configuration from overriding selected
defaults, but malformed managed config is fail-open and filesystem permissions
are its enforcement mechanism. Therefore tenant authorization and capability
checks must later be enforced by the Control Plane, MCP Gateway, container
isolation, and service credentials.

## Consequences

- Upstream upgrades are explicit and testable.
- AMD64 and ARM64 builds use different immutable digests.
- Runtime data survives image changes.
- This phase does not yet provide production multi-tenant authorization.

## Compatibility floor

Profile-prefixed OpenAI API routing requires Hermes `v2026.7.30` or newer.
Core-Agent uses the official image pinned by platform digest instead of
carrying a private source patch for this behavior.

Named Profile routes resolve `API_SERVER_KEY` from the selected Profile secret
scope. In the loopback-only demo runtime, bootstrap provisions the container
ingress key into each named Profile. This key authenticates transport into the
company container; it is not consultant identity or entitlement. Production
consultant authorization belongs in the external Control Plane.
