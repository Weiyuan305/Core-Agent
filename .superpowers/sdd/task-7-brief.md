### Task 7: Build the public Identity Gateway and `/auth/v1` route family

**Files:**

- Modify: `packages/contracts/src/identity/public-auth.ts`
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/tests/identity-contracts.test.ts`
- Create: `packages/contracts/compat/v1/releases/0.6.0/`
- Modify: `packages/contracts/package.json`
- Modify: `package-lock.json`
- Create: `apps/identity-gateway/src/config.ts`
- Create: `apps/identity-gateway/src/security.ts`
- Create: `apps/identity-gateway/src/errors.ts`
- Create: `apps/identity-gateway/src/app.ts`
- Create: `apps/identity-gateway/src/server.ts`
- Create: `apps/identity-gateway/src/main.ts`
- Create: `apps/identity-gateway/src/routes/email.ts`
- Create: `apps/identity-gateway/src/routes/apple.ts`
- Create: `apps/identity-gateway/src/routes/sessions.ts`
- Create: `apps/identity-gateway/src/routes/invitations.ts`
- Create: `apps/identity-gateway/src/routes/companies.ts`
- Create: `apps/identity-gateway/src/routes/account.ts`
- Create: `apps/identity-gateway/tests/security.test.ts`
- Create: `apps/identity-gateway/tests/routes.test.ts`
- Create: `apps/identity-gateway/tests/errors.test.ts`
- Create: `apps/identity-gateway/tests/composition.test.ts`
- Create: `apps/identity-gateway/tests/postgres/production-composition.test.ts`
- Create: `packages/runtime-core/migrations/012_email_verification_transactions.sql`
- Create: `packages/runtime-core/src/repositories/identity/email-verification-transactions.ts`
- Create: `packages/runtime-core/tests/email-verification-transactions.test.ts`
- Modify: `packages/runtime-core/src/db/identity-tables.ts`
- Modify: `packages/runtime-core/src/db/migrate.ts`
- Modify: `packages/runtime-core/src/db/schema-version.ts`
- Modify: `packages/runtime-core/src/services/identity/register-b2c.ts`
- Modify: `packages/runtime-core/src/services/identity/core-session.ts`
- Modify: `packages/runtime-core/src/services/identity/create-b2b-company.ts`
- Modify: `packages/runtime-core/src/services/identity/manage-invitation.ts`
- Modify: `packages/runtime-core/src/services/identity/change-membership-roles.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Tasks 3-6 services and `AuthProviderAdapter`.
- Produces: one public Fastify app at `/auth/v1`, opaque Cookie/CSRF transport, calm errors, and server-derived management authority.

**User-approved review amendment:**

- Schema 12 is a forward-only migration adding the dedicated
  `email_verification_transactions` table. It durably binds deterministic start
  idempotency and payload conflict to encrypted normalized-email/client/device
  state, provider-verification facts, database-clock expiry, and one-time
  pending/consumed/expired transitions. It stores no plaintext email, password,
  verification code, provider token, or Session secret.
- Migration 012 includes the least-privilege Identity role ACL and exact schema
  manifest/catalog coverage. Historical migrations 010/011 remain byte-identical.
- The Entitlement migration reservation moves from schema 12 to schema 13.
- Production composition owns managed secret resolution, PostgreSQL, the pinned
  Supabase adapter, and every Task 3-6 operation consumed by the registered route
  families. Account deletion alone remains explicitly unavailable until Task 9.
- Apple start consumes independent stable client and server-derived account
  limits before provider or durable start effects. Invitation Apple callback
  consumes its callback client and transaction-account limits before provider,
  then only the invitation-account limit after lookup.
- The initial Web Apple-link Cookie authenticates the authorization expiry plus
  an exact thirty-minute settlement deadline and remains usable only for durable
  `provider_started`/`provider_completed` reconciliation after authorization
  expiry. PostgreSQL time terminalizes and scrubs at the settlement boundary.
- Existing-Session invitation acceptance applies the Task 6 recent-reauth guard
  and exact Session/Actor/AuthSubject locks in the same serializable transaction;
  provider-verified onboarding does not require an old Session.
- Real PostgreSQL coverage proves restart/replay/conflict/concurrent consumption,
  email verification -> Task 3 registration -> Task 6 Session issuance, and a
  Task 4 protected mutation with Task 6 authority rechecked in the caller-owned
  mutation transaction.
- The still-unmerged migration 012 also adds the precise combined
  `email_password_apple` provider-identity state and password-reset provider
  completion checkpoints. Same-subject Apple linking CAS-updates one AuthSubject;
  new Apple B2C and invited B2B identities are created only in the post-provider
  serializable domain phase.
- Password-reset completion checkpoints an encrypted exact provider subject and
  the server-validated completion payload hash with causal provider evidence before Core Session revocation. A retry after Core
  rollback skips the provider mutation, retains the recovery Cookie on retryable
  failure, and consumes the transaction only after revocation commits.
- Email-verification and reset-completion routes consume stable pre-provider rate
  buckets. Invalid OTP proofs have a durable bounded attempt count. Production
  Session inspection advances bounded idle activity without changing mutation CAS
  versions during authentication.

- [ ] **Step 1: Write failing HTTP security tests**

Inject requests and prove:

- exact host/origin allowlists, one Host, one Origin, no duplicate Cookie/authorization headers;
- JSON-only mutations and a 64 KiB body limit;
- `Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` Core Session Cookie;
- a separate `Secure; SameSite=Lax` CSRF Cookie and matching `x-core-agent-csrf` header for mutations;
- no wildcard CORS, no credentialed cross-origin access, no open redirect;
- OAuth redirects match an exact configured allowlist;
- account/invitation/Tenant enumeration returns identical status, body shape, and bounded timing class; and
- provider/internal/cookie/key/database details never enter responses.
- password-reset start returns its opaque binding only in a dedicated
  `Secure; HttpOnly; SameSite=Lax` recovery Cookie; the binding never enters
  public JSON, and the provider redirect remains the exact configured URL with
  no per-transaction query parameters.
- Apple Web sign-in/link start creates a separate short-lived
  `Secure; HttpOnly; SameSite=Lax` Apple-flow Cookie containing the Core
  transaction binding. Web callback authority comes from that Cookie, requires
  an exact transaction match, and clears it on every terminal callback path.
  Native iPhone/macOS clients instead bind `transaction_id` to their local
  nonce/PKCE flow context. The Apple-flow and password-recovery Cookies have
  different names, purposes, and parsers and are never interchangeable.
- publish an additive `AppleIdentityLinkStartRequest` in Contracts 0.6.0. It
  contains the current password plus the released Web/native Apple start
  fields, but no email, provider token, or provider proof. Its route requires
  an active Core Session and recent Core reauthentication, loads the current
  normalized email server-side, then calls
  `reauthenticateAndBeginAppleLink`. `AppleIdentityLinkRequest` remains the
  password/token-free callback contract.

- [ ] **Step 2: Implement strict configuration**

Require `IDENTITY_DATABASE_URL`, exact public origins, Cookie host, public base URL, provider URL/key references, Apple redirect allowlists, Session HMAC reference, PII HMAC reference, signing key reference, port, and feature flag. Bind loopback by default; require `IDENTITY_GATEWAY_CONTAINER_BIND=1` for `0.0.0.0`. Reject unknown/blank/relative URLs and production `http:` origins.

- [ ] **Step 3: Implement route composition and calm error mapping**

Register the approved route families under `/auth/v1`. All handlers follow this sequence:

```ts
const routeSequence = Object.freeze([
  "validate_transport",
  "consume_rate_limit",
  "authenticate_session_if_required",
  "require_recent_reauthentication_if_required",
  "call_provider_if_required",
  "execute_authority_command",
  "issue_or_revoke_core_session",
  "return_public_view",
] as const);
```

Map `AUTH_INVALID`, unknown Session, unknown invitation, and unknown account to the same Chinese public copy: `“无法完成验证，请检查信息后重试。”` Map rate limiting to `“尝试次数较多，请稍后再试。”` and provider outage to `“登录服务暂时不可用，请稍后再试。”` Never expose Supabase or Hermes product names.

- [ ] **Step 4: Implement cookie and native transport separation**

Web receives Session secret only in `Set-Cookie`; the JSON body contains `AuthSessionView`. Native Apple clients receive the opaque secret once in the TLS response and no Cookie. Both paths create the same database resource. Reject a Web request attempting native response mode and vice versa.

Password-reset completion reads the recovery transaction/state/expiry only
from the dedicated HttpOnly Cookie, combines it with the provider callback code
and submitted new password, consumes it once, and clears the Cookie on every
terminal outcome.

Apple Web start stores `transaction_id`, expiry, and the Core callback state in
the dedicated Apple-flow HttpOnly Cookie and returns only the provider
authorization URL. Apple Web callback reconstructs the adapter's Core
transaction/state binding from that Cookie (request fields are never authority),
requires exact agreement before provider exchange, and clears the Cookie on
success and every bounded failure. Native start/callback has no Apple-flow
Cookie; the native app must bind `transaction_id` to the same local nonce/PKCE
context and present that exact binding on callback. The password-reset recovery
Cookie remains a separate transport and cannot satisfy an Apple callback.

The authenticated Apple link-start route accepts the current password and
Apple start fields only after active Core Session authentication plus
`requireRecentReauthentication`. It derives the current normalized email from
the private identity projection, invokes
`reauthenticateAndBeginAppleLink` once, and never receives or forwards a
Supabase access token. The link callback accepts neither password nor provider
proof.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/contracts`

Run: `npm run check -w @core-agent/identity-gateway`

Run: `npm test -w @core-agent/identity-gateway -- --test-name-pattern='security|enumeration|cookie|origin|csrf'`

```bash
git add apps/identity-gateway packages/contracts package.json package-lock.json
git commit -m "feat(identity): add public identity gateway"
```

---
