# ADR 0009: Shared Identity Gateway and Provider-Independent Authority

**Status:** Implementation complete; real provider acceptance pending before public deployment
**Date:** 2026-08-10

## Context

Runtime v1 has a private Control Plane, durable Runtime lifecycle, isolated
tenant Hermes containers, and a loopback synthetic Web client. It has no public
human authentication, provider-session validation, cryptographic Trusted
Context issuer, invitation authority, or Entitlement store.

The product requires B2B company administrators and consultants, B2C student
registration, Web login, future native Apple login, and a later migration from a
managed authentication provider to self-hosted infrastructure. It also requires
one central authority to decide which purchased Capability Pack is available to
which Profile.

Making the private Control Plane public would mix Internet authentication with
Runtime orchestration. Treating Supabase JWT claims or user metadata as product
authority would bind business identities and permissions to the temporary
provider. Deploying a complete Identity stack for every company would duplicate
credentials, Apple configuration, account recovery, and operational work while
the real tenant isolation requirement belongs to Runtime and business data.

## Decision

Core-Agent will add one shared public Identity Gateway for Web and future Apple
clients.

The first authentication adapter uses managed Supabase Auth for verified
email/password and Sign in with Apple. The Gateway maps each external provider
subject to a stable Core-Agent `actor_id`, creates an opaque Core Session, and
terminates provider tokens at the public trust boundary.

Core-Agent PostgreSQL remains the sole authority for Tenant, Actor, Membership,
Profile, platform role, Session, invitation, Entitlement, Capability Pack,
Profile assignment, and effective Capability Snapshot. Supabase JWT role claims
and user metadata are never authorization inputs.

The Gateway issues canonical Ed25519-signed Trusted Context with a maximum
five-minute lifetime. Private Control Plane and future Policy/MCP consumers
verify the signature and current authority rather than trusting client fields.

Normal users belong to one B2B or B2C Tenant. Platform super administrators are
separate internal platform Actors with permanent, system-managed administrator
Memberships in every B2B Tenant. Their real identity remains present in every
request and audit event; no impersonation is permitted.

Each company continues to use its own Hermes Runtime container and Volume. The
shared Identity service does not weaken that Runtime isolation.

The provider adapter is replaceable. A self-hosted provider later maps a new
subject to the same Actor, revokes old Sessions, and requires reauthentication;
business resource identifiers do not change.

## Consequences

### Positive

- Public authentication does not expose the private Control Plane.
- Web, iPhone, and macOS can share one identity and Session protocol.
- Supabase accelerates the first release without owning product roles or
  Entitlements.
- Later self-hosting does not migrate Tenant, Profile, Conversation, audit, or
  Entitlement foreign keys.
- Authentication, authorization, and Runtime isolation have separate owners.
- Future Policy/MCP enforcement receives a cryptographically verifiable,
  provider-neutral context.

### Costs and accepted risks

- The platform operates another public process, Session store, signing-key
  lifecycle, invitation workflow, and account-deletion workflow.
- Managed Supabase availability affects new login and reauthentication.
- Web Sign in with Apple requires an operational secret-rotation procedure.
- The first release has no MFA. Administrative writes require recent password
  reauthentication, and irreversible external actions remain disabled.
- Permanent platform-super-administrator access across B2B Tenants is an
  explicit product decision. It requires visible platform-origin Memberships
  and complete tenant audit; it is not least privilege.

## Alternatives considered

### Put public login into the private Control Plane

Rejected because it would publish a service that owns internal Runtime and
tenant orchestration authority and would make later client/API boundaries hard
to separate.

### Store Identity and Entitlement in Supabase tables and metadata

Rejected because it would split product authority across providers, weaken the
future self-host migration, and invite clients to treat provider claims as
current business permission.

### Deploy authentication per company

Rejected for v1 because credential recovery, Apple configuration, security
updates, and account operations are platform concerns. Company Runtime and data
remain isolated without duplicating authentication.

### Build password and Apple authentication inside Core-Agent immediately

Rejected because it adds credential storage, email verification, password reset,
OAuth maintenance, and abuse prevention before the product has validated the
public identity flows. The adapter retains a path to self-hosting later.

## Related specifications

- [Identity Runtime and Public Auth v1](../superpowers/specs/2026-08-10-identity-runtime-public-auth-v1-design.md)
- [Entitlement and Capability Registry v1](../superpowers/specs/2026-08-10-entitlement-capability-registry-v1-design.md)
- [Control Plane Contracts v1](../superpowers/specs/2026-08-03-control-plane-contracts-v1-design.md)
- [Control Plane Runtime v1](../superpowers/specs/2026-08-03-control-plane-runtime-v1-design.md)

## Operational acceptance

The decision is implemented through Identity schema `12`, Contracts `0.6.0`,
Identity Gateway `0.1.0`, and the provider-independent authority/session/context
services. Deterministic release evidence and the optional live-provider result
are tracked separately: default CI contains no Supabase or Apple credentials,
and public deployment remains blocked until a redacted opt-in acceptance report
passes.

Deployment, key/provider rotation, kill-switch, Session-revocation, and
forward-only rollback procedures are in
[Identity Runtime and Public Auth v1 operations](../operations/identity-runtime-public-auth-v1.md).
The release matrix is in
[Identity Runtime and Public Auth v1 test evidence](../testing/identity-runtime-public-auth-v1.md),
and residual security limits are in
[Runtime v1 and public Identity threat model](../security/runtime-v1-threat-model.md).
