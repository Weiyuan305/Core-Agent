# Identity Runtime and Public Auth v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-capable shared authentication, stable platform identity, invitation-only B2B onboarding, open B2C onboarding, durable Core Sessions, and cryptographically verified Trusted Context without exposing Supabase credentials or making the private Control Plane public.

**Architecture:** Core-Agent PostgreSQL remains the authority for Actor, Tenant, Membership, Profile, Session, invitation, platform role, and deletion state. A new public `identity-gateway` Fastify process uses a provider-neutral adapter whose first implementation integrates managed Supabase Auth through `@supabase/supabase-js` 2.112.2, then issues opaque Core Sessions and short-lived Ed25519 contexts; the existing Control Plane remains private and trusts only contexts verified against current database authority. Existing Runtime Core keeps the shared database and transaction machinery, but identity repositories and services live in focused `identity/` subdirectories so a later auth-provider replacement does not alter business identifiers.

**Tech Stack:** Node.js 22.13+, TypeScript 7, TypeBox 1.3.10, Fastify 5.11.2, `@fastify/cookie` 11.1.2, `@supabase/supabase-js` 2.112.2, Kysely 0.29.4, PostgreSQL 17, Ed25519 from `node:crypto`, React 19, Vitest 4, Playwright 1.62.

## Global Constraints

- Follow the approved design at `docs/superpowers/specs/2026-08-10-identity-runtime-public-auth-v1-design.md`; if implementation pressure contradicts it, stop and amend the design through review instead of silently changing semantics.
- The shared Identity Gateway is the only public trust boundary in this milestone. Never publish the Control Plane, Worker, Supervisor, PostgreSQL, Hermes gateway, or bootstrap credential.
- Supabase authenticates email/password and Apple only. It never authorizes Tenant, Membership, Profile, platform role, Entitlement, Capability, or Runtime access.
- Business foreign keys use stable Core-Agent `actor_id`; no Supabase user ID, JWT, role claim, `user_metadata`, access token, or refresh token enters a business table, public response, event, audit payload, log, trace, or Hermes request.
- B2C students may self-register. Every B2B administrator and consultant is invitation-only.
- An ordinary human Actor has exactly one active or invited ordinary Membership, in either one B2B Tenant or one B2C Tenant. Only `platform_super_admin` may have system-managed Memberships across B2B Tenants.
- Platform Memberships are permanent, source `platform`, management-only, non-seat-consuming, immutable to customer administrators, and always preserve the real platform Actor in audit.
- Company administrators have no Profile unless an explicit, versioned consultant-role command creates one. An Agent Profile never follows from the `admin` role alone.
- Require verified email. Do not add MFA, phone login, magic links, SSO, SCIM, passkeys, payments, real MCP, Skills, Composite Memory, real student documents, Human Approval, or irreversible external writes.
- Management, invitation, membership, identity-linking, Entitlement, Session-management, and deletion mutations require password reauthentication within 10 minutes. Apple-only accounts must add a verified password before those mutations.
- Core Session secrets are 256-bit opaque random values, returned once, stored only as SHA-256 digests, idle-expire after exactly 7 days, and absolute-expire after exactly 30 days.
- Web uses `Secure; HttpOnly; SameSite=Lax` for the Core Session Cookie and a separate Session-bound CSRF token. Future Apple clients use PKCE and Keychain, not the Web Cookie.
- Trusted Context uses canonical JSON, Ed25519, a maximum 300-second lifetime, explicit issuer/audience, an allowlisted `key_id`, and a current-authority check after signature verification.
- Account deletion revokes access immediately, allows exactly 30 days for recovery, deletes authentication PII at expiry, pseudonymizes retained audit identity, and never deletes a company or Hermes Volume implicitly.
- Preserve the current loopback synthetic Web flow behind its existing development path until public-auth acceptance is complete. Feature flag rollback disables public admission without deleting identity history.
- Every write is idempotent, versioned, tenant-scoped where applicable, auditable, and committed with ProductEvent/Outbox or not committed at all.
- Use red-green-refactor for every behavior change. Run focused tests before implementation, then the relevant package checks, and commit after every task.
- Do not push, merge, deploy, create a Supabase production project, rotate real credentials, or enable public routes without separate explicit approval.

## File Map

- `packages/contracts/src/identity/`: provider-neutral public auth, invitation, Core Session, platform role, and deletion wire types.
- `packages/runtime-core/src/db/identity-tables.ts`: Kysely row types for global Actor and private identity authority tables.
- `packages/runtime-core/src/repositories/identity/`: durable identity, invitation, Session, OAuth transaction, rate-limit, and deletion access.
- `packages/runtime-core/src/services/identity/`: transactional onboarding, B2B administration, platform projection, Session, deletion, and Trusted Context use cases.
- `apps/identity-gateway/`: the only new public backend, including provider adapters and `/auth/v1` routes.
- `apps/control-plane-api/src/trusted-context-auth.ts`: private consumer-side signature and current-authority admission.
- `apps/control-plane-worker/src/handlers/`: bounded platform-membership and account-deletion jobs.
- `apps/control-plane-web/src/client/features/auth/`: public login, registration, invitation, and account settings UI; the conversation workspace remains a sibling feature.
- `tests/integration/identity-auth.test.ts`: fake-provider end-to-end slice with real PostgreSQL.
- `scripts/accept-supabase-auth.mjs`: opt-in non-sensitive provider acceptance; never part of the default CI secret path.

---

### Task 1: Release provider-neutral Identity contracts as `@core-agent/contracts` 0.5.0

**Files:**

- Create: `packages/contracts/src/identity/public-auth.ts`
- Create: `packages/contracts/src/identity/authority.ts`
- Modify: `packages/contracts/src/tenant/identity.ts`
- Modify: `packages/contracts/src/profile/profile.ts`
- Modify: `packages/contracts/src/errors/error-envelope.ts`
- Modify: `packages/contracts/src/events/product-event.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/scripts/check-compatibility.ts`
- Modify: `packages/contracts/scripts/check-compatibility-history.ts`
- Modify: `packages/contracts/tests/identity.test.ts`
- Create: `packages/contracts/tests/public-auth.test.ts`
- Modify: `packages/contracts/tests/schema-generation.test.ts`
- Modify: `packages/contracts/tests/compatibility-history.test.ts`
- Modify: `packages/contracts/tests/security.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/CHANGELOG.md`
- Modify: `packages/contracts/compatibility-change.json`
- Create: `packages/contracts/compat/v1/releases/0.5.0/`
- Regenerate: `packages/contracts/schemas/v1/*.schema.json`
- Regenerate: `packages/contracts/compat/v1/*.schema.json`

**Interfaces:**

- Consumes: `OpaqueIdSchema`, `ResourceMetadataFields`, `UtcTimestampSchema`, `IdempotencyRequestSchema`, and the current `ErrorEnvelopeSchema`.
- Produces: `AuthSubject`, `PlatformRoleAssignment`, `Invitation`, `CoreSession`, `AccountDeletion`, every `/auth/v1` request/response schema, `MembershipSource`, and additive stable error/event branches used by Tasks 2-12.

- [ ] **Step 1: Write failing tests for the approved identity vocabulary**

Add table-driven tests for `membership_source`, actor deletion states, provider identity kinds, Core Session client kinds/states, invitation roles/states, and platform roles. The test values must be exactly:

```ts
const membershipSources = ["self", "company", "platform"] as const;
const actorStatuses = ["active", "disabled", "deletion_pending", "deleted"] as const;
const providerKinds = ["email_password", "apple"] as const;
const coreSessionClients = ["web", "iphone", "macos"] as const;
const coreSessionStatuses = ["active", "revoked", "expired"] as const;
const invitationStatuses = ["pending", "accepted", "revoked", "expired", "replaced"] as const;
const platformRoles = ["platform_super_admin"] as const;
```

Also prove that a platform Membership must contain `admin`, may not contain `consultant` or `student`, and has no `seat_ref`; a B2C graph has one active student and one default Profile; and an ordinary Actor cannot appear in two identity graphs as active/invited authority.

- [ ] **Step 2: Write failing route-schema and secret-surface tests**

Compile exact schemas for sign-up, sign-in, password reset, Apple start/callback/link, Session inspection/revocation, reauthentication, invitation acceptance, company creation, company membership, and deletion. Use closed request shapes such as:

```ts
export const EmailSignInRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  email: Type.String({ minLength: 3, maxLength: 320, format: "email" }),
  password: Type.String({ minLength: 8, maxLength: 1_024 }),
  client_kind: CoreSessionClientKindSchema,
  device_label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
}, { additionalProperties: false, $id: "core-agent://v1/email-sign-in-request" });

export const AuthSessionViewSchema = Type.Object({
  schema_version: Type.Literal(1),
  actor_id: OpaqueIdSchema,
  session_id: OpaqueIdSchema,
  client_kind: CoreSessionClientKindSchema,
  idle_expires_at: UtcTimestampSchema,
  absolute_expires_at: UtcTimestampSchema,
  reauthentication_required: Type.Boolean(),
}, { additionalProperties: false, $id: "core-agent://v1/auth-session-view" });
```

Assert that response schemas reject `password`, `email`, `provider_subject`, `access_token`, `refresh_token`, `authorization`, raw claims, `key_id`, and provider error bodies. Auth request schemas may accept `email` and `password`; fixtures, generated examples, events, resources, and responses may not contain literal personal data or credentials.

- [ ] **Step 3: Make historical contract manifests capable of accepting new top-level schemas**

First add failing tests proving that releases `0.2.0` through `0.4.0` keep their own immutable file inventory, while the new `0.5.0` release must exactly match the current registry. Implement release discovery with this rule:

```ts
interface ReleaseSnapshot {
  readonly version: string;
  readonly directory: string;
  readonly schemaFiles: readonly string[];
}

function validateReleaseManifest(
  snapshot: ReleaseSnapshot,
  currentVersion: string,
  currentFiles: readonly string[],
): string[] {
  if (snapshot.schemaFiles.length === 0) return [`release ${snapshot.version} is empty`];
  if (snapshot.schemaFiles.some((name) => !/^[a-z0-9-]+\.schema\.json$/u.test(name))) {
    return [`release ${snapshot.version} contains an invalid schema filename`];
  }
  if (snapshot.version !== currentVersion) return [];
  const actual = [...snapshot.schemaFiles].sort();
  const expected = [...currentFiles].sort();
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [`release ${snapshot.version} does not match the current schema manifest`];
}
```

Compatibility comparison must compare every common schema across all accepted releases and treat a newly introduced schema as additive. The history gate must still reject any modification/deletion/rename below `compat/v1` and require the complete current manifest when a new release directory is added.

- [ ] **Step 4: Run the focused tests and confirm red**

Run: `npm test -w @core-agent/contracts -- --test-name-pattern='identity|auth|manifest|security'`

Expected: FAIL because the identity schemas, new vocabulary, and per-release manifest behavior do not exist.

- [ ] **Step 5: Implement and export the closed identity contracts**

Add the resource schemas with `additionalProperties: false`. Extend Membership additively with optional `membership_source`; new producers must always populate it even though optionality preserves old v1 payloads. Add the stable public codes:

```ts
const identityErrorCodes = [
  "AUTH_INVALID",
  "AUTH_EMAIL_UNVERIFIED",
  "AUTH_RATE_LIMITED",
  "AUTH_PROVIDER_UNAVAILABLE",
  "AUTH_CALLBACK_INVALID",
  "AUTH_CONFLICT",
  "REAUTHENTICATION_REQUIRED",
] as const;
```

Add bounded event branches for `identity.registered`, `invitation.created`, `invitation.accepted`, `membership.changed`, `session.revoked`, `account.deletion_requested`, `account.deletion_cancelled`, and `account.deleted`. Payloads contain only IDs, state, safe reason code, and version.

- [ ] **Step 6: Publish the additive 0.5.0 snapshot**

Set both `packages/contracts/package.json.version` and `CONTRACT_PACKAGE_VERSION` to `0.5.0`. Generate schemas, copy the exact live manifest into `compat/v1/releases/0.5.0`, record `change_level: minor`, and add a changelog entry that explicitly states provider tokens and authentication PII are excluded.

Run: `npm run contracts:schemas`

- [ ] **Step 7: Verify and commit the contract release**

Run: `npm run contracts:check`

Expected: build, unit, schema drift, fixtures, security, compatibility, and history-policy tests pass.

```bash
git add packages/contracts package-lock.json
git commit -m "feat(contracts): add public identity authority"
```

---

### Task 2: Migrate from tenant-scoped Actor rows to stable global Actors and add identity authority storage

**Files:**

- Create: `packages/runtime-core/migrations/010_identity_authority.sql`
- Create: `packages/runtime-core/src/db/identity-tables.ts`
- Modify: `packages/runtime-core/src/db/database.ts`
- Modify: `packages/runtime-core/src/db/schema-version.ts`
- Modify: `packages/runtime-core/src/repositories/resources.ts`
- Modify: `packages/runtime-core/src/repositories/events.ts`
- Modify: `packages/runtime-core/src/services/provision-tenant.ts`
- Modify: `packages/runtime-core/tests/migrations.test.ts`
- Modify: `packages/runtime-core/tests/tenant-isolation.test.ts`
- Modify: `packages/runtime-core/tests/provision-tenant.test.ts`

**Interfaces:**

- Consumes: Identity contracts from Task 1 and the existing migration runner/Kysely database.
- Produces: globally unique `actors.actor_id`, identity authority tables, `IdentityAuthorityTables`, and schema version 10 for every later identity task.

- [ ] **Step 1: Write failing PostgreSQL migration tests**

Seed two tenants and prove migration 010:

1. fails closed when the same legacy `actor_id` has contradictory kind/status/display facts;
2. collapses identical legacy Actor facts into one global row;
3. preserves every Membership/Profile/Conversation/agent Session/Audit foreign key;
4. makes an ordinary active-or-invited Membership unique by `actor_id` through a partial constraint trigger;
5. permits platform-source Memberships in multiple B2B Tenants;
6. adds private tables without public read grants;
7. admits the closed Worker kinds `project_platform_memberships` and `finalize_account_deletion`; and
8. migrates exactly from schema 9 to 10.

Use real concurrent transactions to prove two ordinary invitations in different Tenants cannot both commit for one Actor.

- [ ] **Step 2: Define the exact private identity tables**

Migration 010 must create or reshape these authority tables:

```sql
create table auth_subjects (
  auth_subject_id text primary key,
  actor_id text not null references actors(actor_id),
  provider text not null check (provider in ('supabase')),
  provider_subject text not null,
  provider_identity_kind text not null check (provider_identity_kind in ('email_password', 'apple')),
  verified_at timestamptz not null,
  status text not null check (status in ('active', 'unlinked', 'revoked')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (provider, provider_subject)
);

create table core_sessions (
  session_id text primary key,
  secret_digest bytea not null unique check (octet_length(secret_digest) = 32),
  csrf_digest bytea,
  actor_id text not null references actors(actor_id),
  auth_subject_id text not null references auth_subjects(auth_subject_id),
  client_kind text not null check (client_kind in ('web', 'iphone', 'macos')),
  status text not null check (status in ('active', 'revoked', 'expired')),
  device_label text check (device_label is null or char_length(device_label) between 1 and 80),
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  reauthenticated_at timestamptz,
  revocation_reason text,
  resource_version bigint not null check (resource_version > 0),
  updated_at timestamptz not null,
  check (idle_expires_at <= absolute_expires_at)
);
```

Also create `private_identity_pii`, `platform_role_assignments`, `identity_invitations`, `oauth_transactions`, `account_deletions`, and `public_rate_limits`. Store normalized-email HMAC and encrypted/provider-owned PII separately; never store plaintext passwords, provider tokens, OAuth codes, raw claims, or Session secrets.

Replace the `worker_jobs_job_kind_check` constraint in this same forward-only migration so its allowlist includes existing kinds plus `project_platform_memberships` and `finalize_account_deletion`. Later Worker tasks wire handlers to already-valid schema values; they do not rewrite migration 010.

- [ ] **Step 3: Implement the global Actor migration**

Create `actors_v2(actor_id primary key, ...)`, copy distinct consistent facts, temporarily drop composite Actor foreign keys, rewrite them to reference global `actors(actor_id)`, then rename atomically. Add `memberships.membership_source NOT NULL DEFAULT 'company'` only for migration, backfill B2C student rows to `self`, then drop the default so every new producer is explicit.

The cross-tenant invariant must be a deferred constraint trigger that locks the global Actor row before accepting an ordinary `invited` or `active` Membership. This lock order is mandatory: Actor, Tenant, Membership, Profile.

- [ ] **Step 4: Update Kysely and existing resource repositories**

Define focused table types:

```ts
export interface IdentityAuthorityTables {
  auth_subjects: AuthSubjectTable;
  private_identity_pii: PrivateIdentityPiiTable;
  platform_role_assignments: PlatformRoleAssignmentTable;
  identity_invitations: IdentityInvitationTable;
  oauth_transactions: OauthTransactionTable;
  core_sessions: CoreSessionTable;
  account_deletions: AccountDeletionTable;
  public_rate_limits: PublicRateLimitTable;
}
```

Make `RuntimeDatabase` extend `IdentityAuthorityTables`; change `actors` to a global row type; and update every existing insert/select to remove `tenant_id` from Actor operations while retaining tenant filters for Membership and Profile.

- [ ] **Step 5: Run PostgreSQL and provisioning regression tests**

Run: `npm run build:runtime-deps && npm run test:postgres -w @core-agent/runtime-core`

Run: `npm run test:integration`

Expected: schema 10, global Actor, tenant isolation, existing provisioning, conversation, Run, event, and recovery tests all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-core tests/integration
git commit -m "feat(identity): establish global actor authority"
```

---

### Task 3: Implement transactional B2C registration and identity invariants

**Files:**

- Create: `packages/runtime-core/src/repositories/identity/identity-authority.ts`
- Create: `packages/runtime-core/src/repositories/identity/private-pii.ts`
- Create: `packages/runtime-core/src/services/identity/register-b2c.ts`
- Create: `packages/runtime-core/src/services/identity/identity-invariants.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/register-b2c.test.ts`
- Create: `packages/runtime-core/tests/identity-invariants.test.ts`

**Interfaces:**

- Consumes: schema 10, `AuthSubject`, global Actor, existing idempotency/audit/outbox utilities.
- Produces: `registerB2c(dependencies, context, command): Promise<B2cRegistrationResult>` and reusable `loadActorIdentityAuthority(trx, actorId)`.

- [ ] **Step 1: Write failing registration and rollback tests**

Use real PostgreSQL to prove one command creates exactly one global Actor, personal B2C Tenant, active student Membership with source `self`, default Profile, AuthSubject, and private PII projection, while creating zero Entitlements, Runtime rows, Worker jobs, or containers. Inject a failure after each insert and assert the entire graph rolls back.

Use this command contract:

```ts
export interface RegisterB2cCommand {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly auth_subject: VerifiedAuthSubjectInput;
  readonly display_name: string;
}

export interface VerifiedAuthSubjectInput {
  readonly provider: "supabase";
  readonly providerSubject: string;
  readonly identityKind: "email_password" | "apple";
  readonly normalizedEmail: string;
  readonly verifiedAt: string;
}
```

Replay with identical payload must return byte-equivalent IDs; reuse with a different provider subject, normalized-email digest, or display name must throw `IDEMPOTENCY_CONFLICT`.

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/register-b2c.test.ts packages/runtime-core/tests/identity-invariants.test.ts`

Expected: FAIL because the identity repositories and service do not exist.

- [ ] **Step 3: Implement deterministic IDs and the serializable transaction**

Derive IDs from the idempotency identity, never email or provider subject:

```ts
function deriveIdentityId(prefix: string, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`identity.register-b2c:${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}
```

Within one serializable transaction, lock/create Actor first, insert the personal Tenant, Membership, Profile, AuthSubject, private PII digest, ProductEvent, AuditEvent, and Outbox, then complete the idempotency record. The service response contains only the public graph IDs and no PII.

- [ ] **Step 4: Enforce current-authority invariants in one reusable loader**

Return a frozen server-derived shape:

```ts
export interface ActorIdentityAuthority {
  readonly actorId: string;
  readonly actorStatus: "active" | "disabled" | "deletion_pending" | "deleted";
  readonly platformRoles: readonly "platform_super_admin"[];
  readonly memberships: readonly {
    membershipId: string;
    tenantId: string;
    tenantMode: "b2b" | "b2c";
    source: "self" | "company" | "platform";
    roles: readonly ("admin" | "consultant" | "student")[];
    status: "invited" | "active" | "suspended" | "revoked";
  }[];
}
```

Reject duplicate ordinary authority, B2C non-student roles, a second B2C Profile, a Profile without an active matching role, and any cross-Tenant resource reference.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/runtime-core`

Run: `npm run build:runtime-deps && npm run test:postgres -w @core-agent/runtime-core`

```bash
git add packages/runtime-core
git commit -m "feat(identity): add b2c identity onboarding"
```

---

### Task 4: Implement B2B company creation, invitations, roles, and platform Membership projection

**Files:**

- Create: `packages/runtime-core/src/repositories/identity/invitations.ts`
- Create: `packages/runtime-core/src/repositories/identity/platform-roles.ts`
- Create: `packages/runtime-core/src/services/identity/create-b2b-company.ts`
- Create: `packages/runtime-core/src/services/identity/manage-invitation.ts`
- Create: `packages/runtime-core/src/services/identity/accept-invitation.ts`
- Create: `packages/runtime-core/src/services/identity/change-membership-roles.ts`
- Create: `packages/runtime-core/src/services/identity/project-platform-memberships.ts`
- Modify: `packages/runtime-core/src/repositories/jobs.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/b2b-identity.test.ts`
- Create: `packages/runtime-core/tests/invitations.test.ts`
- Create: `packages/runtime-core/tests/platform-memberships.test.ts`

**Interfaces:**

- Consumes: `ActorIdentityAuthority`, schema 10 invitation/platform tables, idempotency and event utilities.
- Produces: company/invitation/acceptance/role commands and `projectPlatformMemberships(db, assignmentId, cursor, limit)` for the Worker.

- [ ] **Step 1: Write failing authority and concurrency tests**

Cover the complete matrix:

- only a real `platform_super_admin` may create a B2B Tenant and first admin invitation;
- an active company admin may invite same-Tenant `admin` or `consultant`, but cannot cross Tenant;
- a seven-day invitation stores a 32-byte secret digest and normalized-email HMAC only;
- replace/revoke/accept are optimistic-versioned and single-use;
- identical acceptance replay converges, while another Actor/email conflicts;
- consultant acceptance creates one active consultant Profile; admin acceptance creates no Profile;
- adding `consultant` to an admin is a separate command that creates one Profile; removing it suspends the Profile;
- customer admins cannot edit source `platform` Memberships;
- concurrent accept/revoke and accept/suspend produce one terminal outcome and no partial Profile.

- [ ] **Step 2: Implement invitation-secret handling**

Generate 256-bit secrets and persist only the digest:

```ts
export function issueInvitationSecret(randomBytes = nodeRandomBytes): {
  readonly secret: string;
  readonly digest: Buffer;
} {
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new DomainError("INTERNAL_ERROR", "Invitation entropy failed");
  return Object.freeze({
    secret: bytes.toString("base64url"),
    digest: createHash("sha256").update(bytes).digest(),
  });
}
```

Return the secret once. Inspection of unknown, expired, revoked, accepted, or malformed secrets produces the same public `RESOURCE_NOT_FOUND` envelope and still uses a constant-time digest comparison.

- [ ] **Step 3: Implement company creation and permanent platform projection**

Company creation locks the platform Actor, creates the Tenant, creates a source `platform` admin Membership for every active platform assignment, creates the pending customer-admin invitation, and appends tenant-scoped audit/outbox rows in one durable workflow.

The projector uses bounded pages of 100 Tenants and deterministic Membership IDs:

```ts
function platformMembershipId(actorId: string, tenantId: string): string {
  return `membership_platform_${createHash("sha256")
    .update(`${actorId}:${tenantId}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}
```

Grant/revoke of a platform role queues `project_platform_memberships`; every insert/revoke is idempotent and tenant-audited. A platform Membership has roles `["admin"]`, no Profile, no seat, source `platform`, and original/effective Actor equal to the real platform Actor.

- [ ] **Step 4: Implement invitation acceptance and role changes**

Lock in order: Actor, Tenant, invitation, Membership, Profile. Verify provider-observed normalized-email HMAC, database time, expected resource version, and target Tenant before mutating. Use the existing serializable retry helper; contention may retry, authority failure may not be converted into success.

- [ ] **Step 5: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/b2b-identity.test.ts packages/runtime-core/tests/invitations.test.ts packages/runtime-core/tests/platform-memberships.test.ts`

Run: `npm run check -w @core-agent/runtime-core`

```bash
git add packages/runtime-core
git commit -m "feat(identity): add b2b invitations and platform roles"
```

---

### Task 5: Add the provider-neutral adapter, deterministic fake, and Supabase implementation

**Files:**

- Create: `apps/identity-gateway/package.json`
- Create: `apps/identity-gateway/tsconfig.json`
- Create: `apps/identity-gateway/src/providers/auth-provider.ts`
- Create: `apps/identity-gateway/src/providers/fake-auth-provider.ts`
- Create: `apps/identity-gateway/src/providers/supabase-auth-provider.ts`
- Create: `apps/identity-gateway/src/providers/provider-errors.ts`
- Create: `apps/identity-gateway/tests/fake-auth-provider.test.ts`
- Create: `apps/identity-gateway/tests/supabase-auth-provider.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: Supabase Auth only through adapter-private tokens and PKCE state.
- Produces: `AuthProviderAdapter`, `VerifiedProviderSubject`, `ProviderFailure`, deterministic fake, and a pinned Supabase implementation used by the Gateway.

- [ ] **Step 1: Define the adapter and write compile-time/fake tests**

Use one closed interface:

```ts
export type VerifiedProviderSubject = VerifiedAuthSubjectInput;

export interface PasswordResetStart {
  readonly transaction_id: string;
  readonly state: string;
  readonly expires_at: string;
}

export interface AuthProviderAdapter {
  signUpEmail(input: EmailCredentialInput): Promise<{ readonly kind: "verification_pending" }>;
  signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart>;
  reauthenticateAndBeginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart>;
  completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject>;
  verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject>;
  reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginPasswordReset(email: string): Promise<PasswordResetStart>;
  completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject>;
  linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject>;
  revokeCurrentProviderSession(input: ProviderProof): Promise<void>;
  deleteProviderSubject(providerSubject: string): Promise<void>;
}
```

Tests must use structural traps/getters/proxies and prove the adapter reads only allowlisted own data properties, never reflects input, and never returns provider tokens or error bodies.

- [ ] **Step 2: Add Supabase 2.112.2 and confirm red**

Run: `npm install @supabase/supabase-js@2.112.2 -w @core-agent/identity-gateway`

Run: `npm test -w @core-agent/identity-gateway`

Expected: FAIL because the adapter implementations are absent.

- [ ] **Step 3: Implement bounded error mapping**

Map every provider failure to only:

```ts
export type ProviderFailureCode =
  | "AUTH_INVALID"
  | "AUTH_EMAIL_UNVERIFIED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_CALLBACK_INVALID"
  | "AUTH_CONFLICT";
```

Do not branch on public error-message text. Use provider status/code internally, discard the provider body, and log only the stable code plus request/trace IDs.

- [ ] **Step 4: Implement email/password and Apple PKCE flows**

Create a fresh server-side Supabase client per operation with persistence, auto-refresh, and URL session detection disabled. Keep access/refresh tokens inside the adapter call, validate `email_confirmed_at`, copy only the allowlisted subject facts, sign out the transient provider client, and release references.

Apple flow must persist a one-time OAuth transaction digest containing state, nonce, PKCE verifier digest, exact redirect URI, client kind, expiry, and optional authenticated Actor for linking. Link start accepts the current email/password only inside `reauthenticateAndBeginAppleLink`, authenticates and starts linking on the same operation-local provider client, persists only a digest of the verified provider subject inside the authenticated-encrypted transaction envelope, and terminally clears that transient provider Session. Link callback accepts no password or provider proof; after code exchange it constant-time verifies the returned provider-subject digest. Callback validates all fields before exchanging the code. A callback failure creates no Core Actor, AuthSubject, or Core Session.

Password recovery sends the configured Supabase redirect URI unchanged. Its
one-time transaction/state/expiry binding is adapter-internal transport state,
contains no email or provider token, and is consumed by completion together
with the callback code and new password.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/identity-gateway`

Run: `node scripts/verify-no-secret.mjs synthetic-provider-token-sentinel`

```bash
git add apps/identity-gateway package.json package-lock.json
git commit -m "feat(identity): add supabase auth adapter"
```

---

### Task 6: Implement durable Core Sessions, CSRF, reauthentication, revocation, and rate limits

**Files:**

- Create: `packages/runtime-core/src/repositories/identity/core-sessions.ts`
- Create: `packages/runtime-core/src/repositories/identity/public-rate-limits.ts`
- Create: `packages/runtime-core/src/services/identity/core-session.ts`
- Create: `packages/runtime-core/src/services/identity/reauthentication.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/core-session.test.ts`
- Create: `packages/runtime-core/tests/public-rate-limits.test.ts`

**Interfaces:**

- Consumes: verified provider subject, global Actor authority, `core_sessions`, and `public_rate_limits`.
- Produces: `issueCoreSession`, `authenticateCoreSession`, `requireRecentReauthentication`, `revokeCoreSession(s)`, and `consumePublicRateLimit`.

- [ ] **Step 1: Write failing Session lifetime and concurrency tests**

Use an injected database clock and deterministic random source to prove:

- exactly 32 random bytes for Session and CSRF secrets;
- only 32-byte SHA-256 digests persist;
- idle expiry = creation + 7 days and absolute expiry = creation + 30 days;
- bounded activity advances idle expiry to `min(now + 7 days, absolute expiry)`;
- no activity extends absolute expiry;
- expired/revoked/unknown secrets are publicly indistinguishable;
- concurrent use/revoke leaves revoked authority current;
- password reset, provider unlink, Actor disable, deletion, and sign-out revoke the required scope; and
- reauthentication is accepted at 9:59 and rejected at 10:00 or later.

- [ ] **Step 2: Implement issue/authenticate with constant-time digest handling**

The public one-time result is:

```ts
export interface IssuedCoreSession {
  readonly session: CoreSession;
  readonly sessionSecret: string;
  readonly csrfSecret?: string;
}
```

Decode base64url only after a strict 43-character pattern check, hash a fixed-size buffer, query by digest, compare again with `timingSafeEqual`, clear temporary buffers, then load current Actor/AuthSubject authority. Existing valid Core Sessions remain usable during a Supabase outage but provider activity does not extend them.

- [ ] **Step 3: Implement PostgreSQL-backed fixed-window limits**

Use separate buckets for `signup`, `login`, `reset`, `apple_callback`, `invitation_accept`, and `reauthenticate`, keyed by HMACed account identifier plus HMACed IP/device identifier. The mutation is one `INSERT ... ON CONFLICT ... DO UPDATE` bounded by database time. Return only retry-after milliseconds; never reveal which key exhausted.

- [ ] **Step 4: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/core-session.test.ts packages/runtime-core/tests/public-rate-limits.test.ts`

Run: `npm run check -w @core-agent/runtime-core`

```bash
git add packages/runtime-core
git commit -m "feat(identity): add durable core sessions"
```

---

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
- Create: `apps/identity-gateway/src/routes/email.ts`
- Create: `apps/identity-gateway/src/routes/apple.ts`
- Create: `apps/identity-gateway/src/routes/sessions.ts`
- Create: `apps/identity-gateway/src/routes/invitations.ts`
- Create: `apps/identity-gateway/src/routes/companies.ts`
- Create: `apps/identity-gateway/src/routes/account.ts`
- Create: `apps/identity-gateway/tests/security.test.ts`
- Create: `apps/identity-gateway/tests/routes.test.ts`
- Create: `apps/identity-gateway/tests/errors.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: Tasks 3-6 services and `AuthProviderAdapter`.
- Produces: one public Fastify app at `/auth/v1`, opaque Cookie/CSRF transport, calm errors, and server-derived management authority.

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

### Task 8: Make Trusted Context cryptographically real with Ed25519 and current-authority verification

**Files:**

- Create: `packages/runtime-core/src/services/identity/canonical-json.ts`
- Create: `packages/runtime-core/src/services/identity/trusted-context.ts`
- Modify: `packages/runtime-core/src/secrets/secret-store.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/trusted-context-crypto.test.ts`
- Create: `apps/control-plane-api/src/trusted-context-auth.ts`
- Modify: `apps/control-plane-api/src/app.ts`
- Modify: `apps/control-plane-api/src/auth.ts`
- Modify: `apps/control-plane-api/tests/auth.test.ts`
- Create: `apps/control-plane-api/tests/trusted-context-auth.test.ts`

**Interfaces:**

- Consumes: `SignedTrustedRequestContext`, Core Session authority, Membership/Profile authority, and an `EntitlementSnapshotAuthorityPort` supplied by the companion plan.
- Produces: `issueTrustedContext`, `verifyTrustedContextSignature`, `authenticateTrustedContextRequest`, and key-rotation-safe public-key resolution.

- [ ] **Step 1: Write failing canonicalization and signature tests**

Generate two in-memory Ed25519 key pairs and prove deterministic key-sorted UTF-8 canonical JSON, successful verification, payload/key/signature tamper rejection, issuer/audience rejection, 300-second maximum TTL, not-before/expiry checks, unknown/disabled/ambiguous key rejection, and old-key acceptance only through `max_context_ttl + clock_skew` after rotation.

Reject sparse arrays, accessors, symbol keys, non-plain objects, duplicate JSON keys at transport decode, non-canonical base64url, and payloads over 64 KiB without invoking getters.

- [ ] **Step 2: Implement canonical JSON and signing**

Use `node:crypto` only:

```ts
const bytes = Buffer.from(canonicalJson(context), "utf8");
const signature = sign(null, bytes, privateKey).toString("base64url");
const accepted = verify(null, bytes, publicKey, Buffer.from(signature, "base64url"));
```

Add SecretStore purpose `identity_signing`; load a PKCS#8 private key from the protected SecretStore, create the `KeyObject`, immediately release source material, and never persist the private key. Store only allowlisted public-key metadata and PEM/SPKI public material outside PostgreSQL secret columns.

- [ ] **Step 3: Implement issuance against current authority**

Issuance requires active Core Session, Actor, Tenant, Membership, Profile, current platform role, and current immutable Entitlement Snapshot. Sort/dedupe `capability_ids`; bind exact request/trace/client request plus existing Conversation/Run IDs; set `issued_at` from the database clock and `expires_at <= issued_at + 300s`.

For the identity-only phase, the injected Entitlement port returns a single explicit empty bootstrap snapshot and the Gateway refuses Agent Run admission. Task 7 of the Entitlement plan replaces this port with live authority before public conversations are enabled.

- [ ] **Step 4: Add alternate private Control Plane authentication**

Keep the bootstrap credential only for provisioning/operations routes. Conversation/Run routes accept a base64url `x-core-agent-context` envelope, verify signature before parsing authority, then load current Membership/Profile/revocation state. Never let a browser construct or submit Tenant/Actor/role/Profile facts independently.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/runtime-core`

Run: `npm run check -w @core-agent/control-plane-api`

Run: `npm test -w @core-agent/control-plane-api -- --test-name-pattern='context|signature|bootstrap'`

```bash
git add packages/runtime-core apps/control-plane-api
git commit -m "feat(identity): sign and verify trusted context"
```

---

### Task 9: Implement account deletion, recovery, provider cleanup, and platform projection Workers

**Files:**

- Create: `packages/runtime-core/src/repositories/identity/account-deletions.ts`
- Create: `packages/runtime-core/src/services/identity/manage-account-deletion.ts`
- Create: `apps/control-plane-worker/src/handlers/project-platform-memberships.ts`
- Create: `apps/control-plane-worker/src/handlers/finalize-account-deletion.ts`
- Modify: `apps/control-plane-worker/src/main.ts`
- Modify: `apps/control-plane-worker/src/worker-loop.ts`
- Modify: `packages/runtime-core/src/repositories/jobs.ts`
- Create: `packages/runtime-core/tests/account-deletion.test.ts`
- Create: `apps/control-plane-worker/tests/project-platform-memberships.test.ts`
- Create: `apps/control-plane-worker/tests/finalize-account-deletion.test.ts`

**Interfaces:**

- Consumes: Core Session revocation, identity authority, provider deletion adapter, Runtime stop-intent port, and a companion Entitlement revocation port.
- Produces: request/cancel/finalize deletion commands plus Worker handlers for `project_platform_memberships` and `finalize_account_deletion`.

- [ ] **Step 1: Write failing deletion state-machine tests**

Prove `active -> deletion_pending -> deleted`, exactly 30 days from database time, immediate Session and ordinary Membership revocation, new-Session denial, one Runtime stop intent, one Entitlement revocation-port call, recovery only after verified provider auth plus recent password reauth, and finalization that deletes provider links/private PII while preserving company data and Volume.

For B2B, retained Actor references become deterministic pseudonyms. For B2C, owned resources emit retention workflow intents. Audit rows retain decisions but no email/provider subject.

- [ ] **Step 2: Implement atomic deletion request and cancellation**

Lock Actor first, write `account_deletions`, set Actor `deletion_pending`, revoke Core Sessions and ordinary Memberships, call the same-transaction Entitlement port, insert Runtime stop intent, audit, ProductEvent, and Outbox. Do not call Supabase or Docker inside this transaction.

Cancellation before the deadline reactivates only the identity authority explicitly recorded in the deletion snapshot; it never recreates a revoked invitation or external Entitlement silently.

- [ ] **Step 3: Implement bounded finalization Worker**

Claim due deletions in pages of 50 with leases. Delete the provider subject idempotently; dependency failure retries within the existing bounded policy. After provider success, delete AuthSubject/private PII, pseudonymize the Actor, mark deletion terminal, and emit safe audit/event rows. A repeated job returns success without a second effect.

- [ ] **Step 4: Wire the schema-10 job kinds and prove restart recovery**

Wire the schema-10 Worker kinds `project_platform_memberships` and `finalize_account_deletion` into Kysely types, claim/dispatch, and recovery without changing migration 010. Preserve effect fencing: once provider deletion is dispatched, recovery inspects Core authority and never guesses or blindly repeats an ambiguous external effect.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/control-plane-worker`

Run: `npm run build:runtime-deps && npm run test:postgres -w @core-agent/runtime-core`

```bash
git add packages/runtime-core apps/control-plane-worker
git commit -m "feat(identity): add recoverable account deletion"
```

---

### Task 10: Add production authentication and identity administration to the Web client

**Files:**

- Create: `apps/control-plane-web/src/client/features/auth/auth-api.ts`
- Create: `apps/control-plane-web/src/client/features/auth/auth-shell.tsx`
- Create: `apps/control-plane-web/src/client/features/auth/sign-in-view.tsx`
- Create: `apps/control-plane-web/src/client/features/auth/sign-up-view.tsx`
- Create: `apps/control-plane-web/src/client/features/auth/invitation-view.tsx`
- Create: `apps/control-plane-web/src/client/features/auth/account-view.tsx`
- Create: `apps/control-plane-web/src/client/features/auth/company-members-view.tsx`
- Create: `apps/control-plane-web/src/client/features/auth/auth-copy.ts`
- Modify: `apps/control-plane-web/src/client/app.tsx`
- Modify: `apps/control-plane-web/src/client/main.tsx`
- Modify: `apps/control-plane-web/src/client/styles/tokens.css`
- Create: `apps/control-plane-web/src/client/styles/auth.css`
- Modify: `apps/control-plane-web/src/server/app.ts`
- Modify: `apps/control-plane-web/src/server/main.ts`
- Create: `apps/control-plane-web/tests/auth-shell.test.tsx`
- Create: `apps/control-plane-web/tests/auth-api.test.ts`
- Modify: `apps/control-plane-web/tests/web-chat.spec.ts`
- Create: `apps/control-plane-web/tests/web-auth.spec.ts`
- Modify: `apps/control-plane-web/playwright.config.ts`

**Interfaces:**

- Consumes: same-origin `/auth/v1` API, HttpOnly Core Session Cookie, readable CSRF Cookie, and `AuthSessionView`.
- Produces: accessible Apple-aligned auth/onboarding/admin UI and a clean handoff to the existing conversation workspace.

- [ ] **Step 1: Write failing unit and browser journeys**

Cover desktop, compact, and iPhone viewports for:

- email/password B2C registration -> verification-pending -> sign-in -> empty service state;
- Sign in with Apple redirect start without rendering provider parameters;
- invited B2B admin and consultant acceptance;
- expired/unknown invitation with identical calm copy;
- Session expiry returning to sign-in without losing unsent local draft;
- recent-reauth modal before management/deletion;
- company admin member list that cannot display/edit platform Membership controls;
- account deletion request/cancel; and
- keyboard, focus, reduced-motion, 200% zoom, screen-reader labels, no horizontal overflow, and zero axe violations.

- [ ] **Step 2: Implement a typed same-origin auth client**

Use `credentials: "same-origin"`, `Accept: application/json`, JSON-only bodies, and CSRF header only for mutations. Never read the Core Session Cookie. Map the closed error envelope into user copy in `auth-copy.ts`; do not render code strings, provider names, trace IDs, hostnames, or raw messages.

- [ ] **Step 3: Implement the auth shell and feature boundary**

`app.tsx` selects exactly one state:

```ts
type AppAdmission =
  | { readonly kind: "loading" }
  | { readonly kind: "anonymous" }
  | { readonly kind: "verification_pending" }
  | { readonly kind: "authenticated"; readonly session: AuthSessionView }
  | { readonly kind: "temporarily_unavailable" };
```

Preserve the current conversation feature unchanged. If production auth is enabled but no active Entitlement exists, show `“服务尚未开通”` with account/settings access; do not show a fake checkout or silently create a Runtime.

- [ ] **Step 4: Route same-origin auth through the Web server without duplicating authority**

The Web server reverse-proxies `/auth/v1` to the configured loopback/private Identity Gateway with bounded headers/body/timeouts and streams `Set-Cookie` unchanged. It never validates credentials or stores Sessions itself. Keep the synthetic loopback session only when `CORE_AGENT_WEB_SYNTHETIC_DEMO=1` and reject that flag in production mode.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/control-plane-web`

Run: `npm run test:browser -w @core-agent/control-plane-web`

Expected: existing conversation tests plus new auth journeys pass in all three viewport projects with no accessibility violations.

```bash
git add apps/control-plane-web
git commit -m "feat(web): add public identity experience"
```

---

### Task 11: Prove provider replacement and integrate the public/private boundary end to end

**Files:**

- Create: `tests/integration/fakes/fake-auth-provider.ts`
- Create: `tests/integration/identity-auth.test.ts`
- Create: `tests/integration/trusted-context.test.ts`
- Create: `packages/runtime-core/src/services/identity/replace-auth-provider.ts`
- Create: `packages/runtime-core/tests/replace-auth-provider.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/runtime-contract.yml`

**Interfaces:**

- Consumes: complete Gateway, Core Sessions, identity authority, Trusted Context, private Control Plane verifier.
- Produces: deterministic full-slice acceptance and `replaceAuthProviderSubject` without business-ID rewrites.

- [ ] **Step 1: Write the full fake-provider slice**

With real PostgreSQL and in-process fake provider, prove B2C registration, invited B2B onboarding, platform cross-company access, Cookie/CSRF/re-auth, Ed25519 context issuance/verification, provider outage behavior, Session revocation, deletion recovery, and public-safe errors. Assert the Control Plane sees the real Actor/Membership/Profile from verified context and never a browser-provided role.

- [ ] **Step 2: Implement provider replacement**

In one versioned transaction, add a new provider subject row pointing to the same `actor_id`, mark the old subject revoked, revoke every Core Session, and append audit/outbox. Assert that Tenant, Membership, Profile, Conversation, Entitlement snapshot reference, Runtime, and audit resource IDs do not change.

- [ ] **Step 3: Add default-CI identity jobs**

Extend root scripts:

```json
{
  "test:identity": "npm run contracts:build && npm test -w @core-agent/identity-gateway",
  "test:integration": "npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 tests/integration/*.test.ts"
}
```

Add Identity Gateway checks to unit CI and the identity integration tests to the PostgreSQL-backed integration job. Keep real Supabase credentials out of GitHub default workflows.

- [ ] **Step 4: Verify and commit**

Run: `npm test`

Run: `npm run test:postgres`

Run: `npm run test:integration`

Run: `npm run test:browser -w @core-agent/control-plane-web`

```bash
git add tests packages/runtime-core package.json .github/workflows/runtime-contract.yml
git commit -m "test(identity): cover the public auth boundary"
```

---

### Task 12: Add opt-in Supabase/Apple acceptance, operations evidence, and final release gates

**Files:**

- Create: `scripts/accept-supabase-auth.mjs`
- Create: `docs/operations/identity-runtime-public-auth-v1.md`
- Create: `docs/testing/identity-runtime-public-auth-v1.md`
- Modify: `docs/security/runtime-v1-threat-model.md`
- Modify: `docs/architecture/0009-shared-identity-gateway-and-provider-independent-authority.md`
- Modify: `docs/superpowers/specs/2026-08-10-identity-runtime-public-auth-v1-design.md`
- Modify: `scripts/verify-no-secret.mjs`

**Interfaces:**

- Consumes: all implemented identity behavior and operator-provided non-production Supabase/Apple credentials.
- Produces: reproducible release evidence, rollback procedure, key/provider rotation procedure, and the final go/no-go record for the companion Entitlement plan.

- [ ] **Step 1: Implement a non-sensitive opt-in provider acceptance script**

Require explicit environment variables and a disposable Supabase project. The script creates/uses only synthetic test identities, proves email verification, password sign-in/reauth/reset, Apple PKCE callback, same-email linking, different-relay-address manual-link requirement, logout, and cleanup. It writes a redacted pass/fail JSON report containing timestamps, stable codes, and durations only.

Abort unless `CORE_AGENT_SUPABASE_ACCEPTANCE=1`; never print URL keys, email addresses, tokens, codes, Cookies, or provider response bodies.

- [ ] **Step 2: Document deployment and rollback**

The operations guide must give exact commands for schema migration, secret-file permissions, signing-key publish/rotate/disable order, Supabase URL/redirect allowlists, Apple client-secret rotation, feature-flag rollout, Identity Gateway health, public route disablement, Session revocation, provider rollback window, and confirmation that Control Plane ports remain private.

- [ ] **Step 3: Run sentinel and complete acceptance**

Run: `node scripts/verify-no-secret.mjs identity-auth-private-sentinel`

Run: `npm run contracts:check`

Run: `npm run check`

Run: `npm run test:postgres`

Run: `npm run test:integration`

Run: `npm run test:browser -w @core-agent/control-plane-web`

Optional approved environment only: `CORE_AGENT_SUPABASE_ACCEPTANCE=1 node scripts/accept-supabase-auth.mjs`

Expected: every deterministic gate passes; the opt-in report proves the provider slice without leaking credentials; public auth may be enabled, but real student data, MCP execution, payments, and irreversible tools remain disabled.

- [ ] **Step 4: Mark the specification implemented and commit evidence**

Change the design status only after every mandatory gate passes. Record exact commands, commit SHA, package/contract/schema versions, test counts, Supabase acceptance status, known no-MFA limitation, and rollback readiness.

```bash
git add scripts docs
git commit -m "docs(identity): record public auth acceptance"
```

---

## Final Acceptance Checklist

- [ ] All 15 design acceptance clauses map to passing deterministic or explicitly opt-in evidence.
- [ ] Normal Actors cannot cross Tenant/mode boundaries; platform authority remains visibly platform-originated.
- [ ] B2C registration creates identity only; B2B self-registration remains impossible.
- [ ] Session, CSRF, Origin, PKCE, nonce, expiry, reset, revocation, and reauthentication tests pass.
- [ ] Ed25519 tamper, issuer, audience, TTL, rotation, and unknown-key tests pass.
- [ ] Supabase replacement leaves every business identifier unchanged.
- [ ] Account deletion revokes immediately, recovers for 30 days, and never deletes a company or Volume implicitly.
- [ ] Provider outage blocks new provider activity while valid unextended Core Sessions continue.
- [ ] Default CI contains no real provider secrets and all sentinel scans pass.
- [ ] Public production still blocks real student data, payments, MCP, Skills, Human Approval, and irreversible writes.
