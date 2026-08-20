# Runtime v1 and public Identity threat model

## Scope and prohibited use

This model covers the public Identity Gateway, provider adapter, Core identity
authority, Core Sessions, Trusted Context, the private Control Plane, and
tenant-isolated Runtime boundary. Real customer or **student data is
prohibited** in this release. Payments, MCP/Skills execution, Human Approval,
final submissions, and irreversible external actions remain disabled.

MFA is **not enabled** in v1. Password reauthentication, short management
windows, rate limits, visible platform authority, audit, and disabled
irreversible actions reduce impact but do not replace MFA.

## Assets and trust boundaries

- Provider credentials, Apple secret, signing private keys, Session/PII HMAC
  material, PostgreSQL credentials, provider tokens, OAuth codes, and Cookies
  are secret assets.
- Actor, Tenant, Membership, Profile, invitation, Entitlement, Session,
  deletion, audit, and business resource IDs are authoritative only in Core
  PostgreSQL.
- The Internet terminates at the Identity Gateway. Supabase is authentication
  evidence, never business authority. The Control Plane and Runtime lifecycle
  ports remain private.
- Trusted Context crosses Gateway-to-Control-Plane only as a canonical
  Ed25519-signed, audience-bound, maximum-300-second envelope.
- Each Hermes Runtime remains separated by Tenant container, network, and
  Volume. Identity sharing does not merge Runtime storage.

## Threats and controls

| Threat | Required control | Failure response |
| --- | --- | --- |
| credential or token disclosure | `0600` purpose-separated files; no env/argv/log/database secret; sentinel and closed-report scans | rotate/revoke, disable public auth, revoke Sessions |
| account/invitation enumeration | stable calm envelopes, uniform public status, bounded timing tests | fail closed; no provider body |
| login/reset/OTP abuse | independent account/client HMAC buckets, bounded OTP attempts, durable leases | `429`/stable rejection; no partial identity |
| CSRF or cross-origin Cookie use | Secure HttpOnly SameSite Cookies, exact Origin/Host, CSRF double submit, duplicate-header rejection | reject before provider/DB effect |
| OAuth interception/replay | exact redirect allowlist, one-time state/nonce/PKCE, short auth and settlement windows, purpose-separated HMAC | terminalize/scrub transaction; no Session |
| provider identity collision | exact provider subject/email-method compatibility, same-email CAS, explicit password-authenticated manual link | deny and retain separate Actors |
| provider outage/unknown outcome | durable reservation/fencing/checkpoint, provider work outside DB retry, bounded settlement recovery | block new provider work; valid Core Sessions are not extended |
| stale or revoked authority | DB-clock Session checks, current Actor/AuthSubject/Tenant/Membership/Profile locks, serializable mutation | reject and audit |
| platform impersonation | immutable platform-origin Membership, original Actor retained, tenant audit/outbox | reject non-platform grant/revoke |
| cross-Tenant access | server-derived authority, composite Tenant keys, no provider metadata/JWT claims | fail closed |
| signing-key substitution | allowlisted unique `key_id`, Ed25519 type checks, publish-before-activate rotation, unknown/retired rejection | disable key and revoke affected Sessions |
| SSRF/public Control Plane | closed provider/base URLs, exact redirect schemes, private Control Plane/firewall, no fallback port | remove route; investigate configuration |
| deletion data loss | immediate access revocation, 30-day recovery, bounded PII deletion, no company/Volume cascade | stop worker; restore authority from retained state |
| acceptance evidence leakage | disposable empty project, synthetic identities, interactive URL only in browser argv, closed redacted report, exact cleanup | report fails and is not retained |

## Residual risks and release conditions

- No MFA raises account-takeover risk; public administrative use stays limited
  and irreversible actions stay disabled.
- Supabase and Apple availability affects new login, reset, linking, and
  reauthentication. Existing unexpired Core Sessions continue only under their
  own idle/absolute limits and are not silently extended.
- Apple Web secrets expire; missing the six-month rotation fails Apple login.
- A malicious endpoint may still create load before rate limiting; edge limits
  complement, but never replace, application account/client limits.
- Real provider acceptance is interactive and operator-controlled. Default CI
  proves fail-closed orchestration but cannot claim a live Apple pass.
- Public deployment is blocked until all deterministic gates and a redacted
  opt-in provider report pass with successful cleanup.

## Incident priorities

First disable public admission, then revoke affected Core Sessions, rotate the
specific secret/key, preserve audit and database evidence without raw secrets,
and restore the previous reviewed Gateway binary. Never expose the Control
Plane, accept provider JWT claims as authority, bypass PKCE/nonce/state, or
down-migrate as an incident shortcut.
