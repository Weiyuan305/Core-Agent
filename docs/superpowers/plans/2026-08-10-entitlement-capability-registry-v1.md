# Entitlement and Capability Registry v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authoritative product, entitlement, seat, assignment, effective Capability Snapshot, and Runtime projection pipeline that makes purchased services deterministically available to the correct Profile without exposing or invoking a real MCP tool.

**Architecture:** Global catalog resources describe reviewed immutable Capability and Pack versions; tenant-scoped releases pin one exact Pack version; Entitlements represent platform-recorded commercial rights; B2B assignments consume transactional seats while B2C active products automatically apply to the default Profile. A deterministic resolver writes immutable effective snapshots and advances a separate current pointer, then queues durable Runtime generation reconciliation; Trusted Context and Run admission consume current snapshots, while Hermes tool configuration remains empty until the separate Policy/MCP Gateway milestone.

**Tech Stack:** Node.js 22.13+, TypeScript 7, TypeBox 1.3.10, Fastify 5.11.2, Kysely 0.29.4, PostgreSQL 17, SHA-256 canonical manifests from `node:crypto`, existing Worker/Supervisor/Docker protocol, React 19, Vitest 4, Playwright 1.62.

## Global Constraints

- Complete and accept `docs/superpowers/plans/2026-08-10-identity-runtime-public-auth-v1.md` first. This plan consumes stable global Actors, system-managed platform Memberships, recent reauthentication, durable Core Sessions, and signed Trusted Context.
- Follow `docs/superpowers/specs/2026-08-10-entitlement-capability-registry-v1-design.md`; contradictions require a reviewed design amendment, not an implementation shortcut.
- Keep commercial Product, Entitlement, Assignment, effective Snapshot, Runtime projection, and executable Capability as separate layers. A purchase never stores or directly exposes raw tool names.
- A Capability Pack version contains a sorted non-empty set of exact reviewed Capability Version references. Pack nesting, `latest`, version ranges, mutable image tags, arbitrary URLs, dynamic download, customer-authored Packs, and model-proposed capabilities are forbidden.
- The first release may make only `read` or explicitly non-executing manifest entries effective. `external_write` and `privileged` remain blocked until Human Approval and stronger authentication are accepted.
- Platform super administrators manually grant/suspend/revoke/expire Entitlements with an opaque external order reference. Do not add Stripe, App Store, pricing, tax, invoice, receipt, refund processing, checkout, or payment webhooks.
- B2B seat quantity is per Entitlement/Pack. One active `(entitlement_id, profile_id)` Assignment consumes one seat; allocation must never oversubscribe under concurrent real PostgreSQL transactions.
- B2C all-in-one and add-on Packs automatically apply to the one default Profile; there is no B2C seat-assignment UI or second Profile.
- The platform pins one reviewed Pack Version per Tenant/Product. Upgrade, canary, rollback, and Runtime generation are explicit; rollback selects an earlier reviewed version and increments generation without rewriting history.
- Duplicate exact Capability Versions deduplicate. Different versions of the same `capability_id` conflict and reject the proposed activation/upgrade before the current pointer changes.
- Effective Snapshots are immutable, canonical, deterministic, tenant-scoped, and database-time evaluated. Currentness lives in a separately versioned Profile pointer.
- Suspension, expiry, revocation, Assignment removal, Profile/Membership/Tenant suspension, Pack blocking, and Capability blocking immediately prevent new Context and Run admission. A current model-only stream may finish; future write tools must recheck before external effect.
- Identity/Entitlement transactions never call Docker. They commit authority, audit, Outbox, and one idempotent Runtime intent atomically.
- B2B Runtime creation waits for the first active Pack assignment and remains running while the company has active service. B2C Runtime creation waits for the first active Entitlement, stops after exactly 30 idle minutes with the Volume preserved, and wakes through one idempotent start intent.
- An Assignment/automatic projection remains `preparing` until strict inspection proves exact Tenant, image, generation, Profile set, capability-manifest digest, and health. Failure is calm and never makes a Capability visible.
- The projected Runtime manifest contains only approved Capability IDs and exact versions. Hermes managed tools, MCP servers, Skill loading, Policy enforcement, and raw tool schemas remain empty/disabled.
- Domain services such as EduApply, IELTS teaching, housing, auto-apply, and marketing remain independent versioned services. Do not copy their implementation code into Core-Agent.
- Supabase metadata, browser input, Apple claims, prompt text, model output, Hermes memory, Profile YAML, and container labels are never entitlement authority.
- Real student/customer data, Consent, Retention, Data Governance, Composite Memory, Human Approval, and irreversible writes remain out of scope.
- Every write is idempotent, expected-versioned, audited with the real Actor, and committed through Transactional Outbox or not committed at all.
- Use red-green-refactor, focused package checks, real PostgreSQL tests for locking, fake Runtime integration, and one commit after each completed task.
- Do not push, merge, deploy, publish catalog data, grant a real customer, publish an image, or enable public feature flags without separate explicit approval.

## File Map

- `packages/contracts/src/entitlements/`: catalog, Pack, release, Entitlement, Assignment, Snapshot, and public summary schemas.
- `packages/runtime-core/src/db/entitlement-tables.ts`: Kysely row types for global catalog and tenant authority tables.
- `packages/runtime-core/src/repositories/entitlements/`: focused catalog, grant, seat, snapshot, current-pointer, and projection persistence.
- `packages/runtime-core/src/services/entitlements/`: catalog review, grants, assignments, resolver, release rollout, revocation, and admission.
- `packages/runtime-core/src/runtime/capability-manifest.ts`: canonical non-secret Runtime manifest.
- `apps/control-plane-worker/src/handlers/reconcile-capability-projection.ts`: durable generation preparation/availability.
- `apps/control-plane-worker/src/handlers/stop-idle-b2c-runtime.ts`: exactly-30-minute idle stop/wake lifecycle.
- `apps/identity-gateway/src/routes/entitlements/`: reauthenticated public-safe platform/company/student management routes.
- `apps/control-plane-web/src/client/features/services/`: product, seat, assignment, and calm preparation UI.
- `tests/integration/entitlement-capability.test.ts`: real database + fake Runtime full slice.
- `scripts/accept-capability-runtime.mjs`: opt-in local Runtime acceptance with an empty Hermes tool surface.

---

### Task 1: Release Entitlement and Capability contracts as `@core-agent/contracts` 0.7.0

**Files:**

- Create: `packages/contracts/src/entitlements/catalog.ts`
- Create: `packages/contracts/src/entitlements/authority.ts`
- Create: `packages/contracts/src/entitlements/snapshots.ts`
- Create: `packages/contracts/src/entitlements/public-api.ts`
- Modify: `packages/contracts/src/errors/error-envelope.ts`
- Modify: `packages/contracts/src/events/product-event.ts`
- Modify: `packages/contracts/src/request-context/trusted-request-context.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/registry.ts`
- Create: `packages/contracts/tests/catalog.test.ts`
- Create: `packages/contracts/tests/entitlements.test.ts`
- Create: `packages/contracts/tests/snapshots.test.ts`
- Modify: `packages/contracts/tests/product-event.test.ts`
- Modify: `packages/contracts/tests/trusted-request-context.test.ts`
- Modify: `packages/contracts/tests/schema-generation.test.ts`
- Modify: `packages/contracts/tests/security.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/CHANGELOG.md`
- Modify: `packages/contracts/compatibility-change.json`
- Create: `packages/contracts/compat/v1/releases/0.7.0/`
- Regenerate: `packages/contracts/schemas/v1/*.schema.json`
- Regenerate: `packages/contracts/compat/v1/*.schema.json`

**Interfaces:**

- Consumes: Contracts 0.6.0, `EntitlementSnapshotRef`, `TrustedRequestContext`, `AuditEvent`, and ProductEvent helpers.
- Produces: all catalog/entitlement resources, commands, public summaries, projection states, and event/error vocabularies used by Tasks 2-12.

- [ ] **Step 1: Write failing catalog-contract tests**

Define exact closed vocabularies:

```ts
export const CapabilityKindSchema = Type.Union([
  Type.Literal("mcp"), Type.Literal("skill"), Type.Literal("policy"),
]);
export const CapabilityRiskClassSchema = Type.Union([
  Type.Literal("read"), Type.Literal("draft_write"),
  Type.Literal("external_write"), Type.Literal("privileged"),
]);
export const ApprovalRequirementSchema = Type.Union([
  Type.Literal("none"), Type.Literal("user_confirmation"), Type.Literal("human_approval"),
]);
export const CapabilityVersionStatusSchema = Type.Union([
  Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("retired"), Type.Literal("blocked"),
]);
export const PackVersionStatusSchema = Type.Union([
  Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("published"),
  Type.Literal("retired"), Type.Literal("blocked"),
]);
```

Test `Capability`, `CapabilityVersion`, `PackProduct`, `PackVersion`, `PackMember`, and `TenantPackRelease`. Reject non-canonical semantic versions, mutable artifact references, empty/duplicate members, version ranges, nested Packs, unknown kinds, arbitrary URLs, accessors, and additional fields.

- [ ] **Step 2: Write failing authority/snapshot/public-summary tests**

Cover:

```ts
export const EntitlementStatusSchema = Type.Union([
  Type.Literal("active"), Type.Literal("suspended"),
  Type.Literal("expired"), Type.Literal("revoked"),
]);
export const AssignmentStatusSchema = Type.Union([
  Type.Literal("preparing"), Type.Literal("available"), Type.Literal("suspended"),
  Type.Literal("expired"), Type.Literal("failed"), Type.Literal("revoked"),
]);
export const EntitlementSourceSchema = Type.Literal("platform_manual");
```

An Entitlement requires exact Product/Release refs, validity, source, external-order reference, status, and either B2B positive `seat_quantity` or B2C `automatic`. Snapshot entries are sorted exact `(capability_id, capability_version_id, version)` triples and contain sorted source Entitlement/Assignment/Release refs plus canonical hash.

Public summaries may expose display name, used/total seats, validity, and calm service status; they must reject artifact refs, contract refs, raw Capability IDs for B2C, external order refs, prices, receipts, tool schemas, secrets, and internal failure summaries.

- [ ] **Step 3: Write failing event/context tests**

Add event branches for `pack.release_selected`, `entitlement.activated`, `.suspended`, `.revoked`, `.expired`, `assignment.created`, `.revoked`, `entitlement_snapshot.changed`, and `service.preparing`, `.available`, `.failed`. Payloads contain only IDs, resource versions, states, generation, snapshot ref, and safe reason code.

Prove Trusted Context requires sorted unique `capability_ids` and that its `entitlement_snapshot_ref` exactly identifies the effective snapshot. Add stable errors `SEAT_EXHAUSTED`, `CAPABILITY_CONFLICT`, and `SERVICE_PREPARING` while retaining `ENTITLEMENT_DENIED`.

- [ ] **Step 4: Run focused tests and confirm red**

Run: `npm test -w @core-agent/contracts -- --test-name-pattern='catalog|entitlement|snapshot|capability|service'`

Expected: FAIL because the new resources and events do not exist.

- [ ] **Step 5: Implement and export the schemas**

Use the top-level registered-schema and immutable release-manifest policy already established by Contracts 0.6.0. Every resource is `additionalProperties: false`, includes resource metadata, uses opaque IDs, and separates private/internal fields from public summaries. New producers must sort arrays before validation; schemas must not silently coerce or sort client input.

- [ ] **Step 6: Publish the additive 0.7.0 contract release**

Set package/version authority to `0.7.0`, generate live schemas, copy the exact current manifest to `compat/v1/releases/0.7.0`, and record an additive minor change. Historical 0.2-0.6 releases remain byte-immutable.

- [ ] **Step 7: Verify and commit**

Run: `npm run contracts:check`

```bash
git add packages/contracts
git commit -m "feat(contracts): add entitlement capability authority"
```

---

### Task 2: Add catalog, Entitlement, seat, Snapshot, and projection storage in schema 13

**Files:**

- Create: `packages/runtime-core/migrations/013_entitlement_capability_authority.sql`
- Create: `packages/runtime-core/src/db/entitlement-tables.ts`
- Modify: `packages/runtime-core/src/db/database.ts`
- Modify: `packages/runtime-core/src/db/schema-version.ts`
- Modify: `packages/runtime-core/src/repositories/jobs.ts`
- Modify: `packages/runtime-core/tests/migrations.test.ts`
- Create: `packages/runtime-core/tests/entitlement-schema.test.ts`

**Interfaces:**

- Consumes: Identity schema 12 and existing migration/Worker tables.
- Produces: schema 13, `EntitlementAuthorityTables`, immutable database constraints, and new Worker job kinds.

- [ ] **Step 1: Write failing migration and immutability tests**

Prove schema 12 -> 13 and empty -> 13 migration, exact table/index/constraint inventory, tenant-scoped foreign keys, database-time validity, immutable reviewed/published rows, immutable snapshots, unique order identity, one active Assignment pair, and no seat oversubscription bypass through direct SQL.

Attempt `UPDATE` and `DELETE` on reviewed Capability Version, published Pack Version/member, Tenant release history, and Snapshot rows; expect named fail-closed triggers. Current pointer updates remain allowed only through an expected-version function/service transaction.

- [ ] **Step 2: Create exact global catalog tables**

Migration 013 creates:

```sql
create table capabilities (
  capability_id text primary key,
  display_name text not null check (char_length(display_name) between 1 and 200),
  owning_domain text not null,
  kind text not null check (kind in ('mcp', 'skill', 'policy')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table capability_versions (
  capability_version_id text primary key,
  capability_id text not null references capabilities(capability_id),
  version text not null,
  kind text not null check (kind in ('mcp', 'skill', 'policy')),
  artifact_ref text not null,
  contract_ref text not null,
  risk_class text not null check (risk_class in ('read', 'draft_write', 'external_write', 'privileged')),
  approval_requirement text not null check (approval_requirement in ('none', 'user_confirmation', 'human_approval')),
  compatibility_json jsonb not null,
  status text not null check (status in ('draft', 'reviewed', 'retired', 'blocked')),
  resource_version bigint not null check (resource_version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (capability_id, version)
);
```

Also create `pack_products`, `pack_versions`, `pack_members`, and private `platform_authority_audit`. Catalog audit stores real platform Actor, action, decision, outcome, resource/version, request/trace, and safe summary; it stores no customer content or provider secrets.

- [ ] **Step 3: Create exact tenant authority tables**

Create `tenant_pack_releases`, `entitlements`, `entitlement_assignments`, `entitlement_snapshots`, `entitlement_snapshot_sources`, `entitlement_snapshot_capabilities`, `profile_snapshot_pointers`, `capability_runtime_projections`, and `runtime_activity`.

Essential uniqueness/locking keys are:

```sql
unique (tenant_id, pack_product_id, generation),
unique (tenant_id, source, external_order_ref),
unique (tenant_id, entitlement_id, profile_id),
unique (tenant_id, profile_id, canonical_input_hash),
unique (tenant_id, profile_id, snapshot_version),
primary key (tenant_id, profile_id),
unique (tenant_id, runtime_generation)
```

Add Worker kinds `reconcile_capability_projection` and `stop_idle_b2c_runtime`; add nullable `capability_manifest_digest` to `runtime_containers`, with `sha256:<64 lowercase hex>` validation.

- [ ] **Step 4: Define focused Kysely table types and indexes**

Make `RuntimeDatabase` extend:

```ts
export interface EntitlementAuthorityTables {
  capabilities: CapabilityTable;
  capability_versions: CapabilityVersionTable;
  pack_products: PackProductTable;
  pack_versions: PackVersionTable;
  pack_members: PackMemberTable;
  platform_authority_audit: PlatformAuthorityAuditTable;
  tenant_pack_releases: TenantPackReleaseTable;
  entitlements: EntitlementTable;
  entitlement_assignments: EntitlementAssignmentTable;
  entitlement_snapshots: EntitlementSnapshotTable;
  entitlement_snapshot_sources: EntitlementSnapshotSourceTable;
  entitlement_snapshot_capabilities: EntitlementSnapshotCapabilityTable;
  profile_snapshot_pointers: ProfileSnapshotPointerTable;
  capability_runtime_projections: CapabilityRuntimeProjectionTable;
  runtime_activity: RuntimeActivityTable;
}
```

Add claim/current-authority indexes proven with `EXPLAIN` for active Entitlements, active Assignments, Profile pointers, affected Tenant releases, due expiry, due idle stop, and projection Worker claims.

- [ ] **Step 5: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/migrations.test.ts packages/runtime-core/tests/entitlement-schema.test.ts`

Run: `npm run test:postgres -w @core-agent/runtime-core`

```bash
git add packages/runtime-core
git commit -m "feat(entitlements): add capability authority schema"
```

---

### Task 3: Implement immutable Capability and Pack catalog review/publication

**2026-08-21 approved implementation amendment:** Preserve the immutable Contracts
0.7.0 release byte-for-byte and publish compatible Contracts 0.8.0 catalog lifecycle
ProductEvent branches. Capability versions emit only
`created/reviewed/retired/blocked`; Pack versions emit only
`created/reviewed/published/retired/blocked`. Their closed payloads carry only the
version ID, stable Capability/Pack-product ID, closed status, and resource version.
The service must call validated `appendProductEvents` so event, Outbox, resource,
audit, and idempotency commit atomically; `readEventsAfter` must reconstruct every
emitted branch and exact replay must append none. Historical 0.2.0–0.7.0 releases and
migrations 010–013 remain untouched.

Final review hardening: inject one server-managed `catalogAuthorityTenantId` into
catalog command dependencies and require the real Actor's active platform Membership
there. Reuse Contracts artifact validation at the Runtime boundary; reject hostile
cyclic/deep/oversized inputs before hashing; use exact UTF-8 Capability Version lock
order; and queue Capability/Pack block recomputation only for exact `preparing` or
`current` releases. First family/product creation must be race-safe and preserve all
stable family metadata.

**Files:**

- Create: `packages/runtime-core/src/repositories/entitlements/catalog.ts`
- Create: `packages/runtime-core/src/services/entitlements/catalog-validation.ts`
- Create: `packages/runtime-core/src/services/entitlements/manage-capability.ts`
- Create: `packages/runtime-core/src/services/entitlements/manage-pack.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/catalog-management.test.ts`
- Create: `packages/runtime-core/tests/catalog-security.test.ts`

**Interfaces:**

- Consumes: global platform authority from Identity, schema 13 catalog tables, expected versions, idempotency.
- Produces: draft/review/retire/block Capability and Pack commands plus immutable reviewed resources.

- [ ] **Step 1: Write failing publication and hostile-input tests**

Cover draft creation, exact replay, changed-payload conflict, review, publication, retirement, blocking, and forbidden reverse transitions. Publication must reject empty/duplicate members, unknown/unreviewed/blocked members, kind mismatch, mutable artifacts, unknown contract refs, incompatible platform/protocol metadata, unsupported risk classes, customer mode mismatch, and Pack nesting.

Use getters, proxies, polluted prototypes, sparse arrays, duplicate keys, oversized metadata, and canary secrets. Assert no accessor runs and no input/provider text enters error, audit, event, or log output.

- [ ] **Step 2: Implement canonical semantic version and immutable artifact validation**

Use exact-version validation only:

```ts
const canonicalSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const immutableArtifacts = [
  /^oci:[A-Za-z0-9][A-Za-z0-9./:_-]{0,511}@sha256:[a-f0-9]{64}$/u,
  /^npm:@?[A-Za-z0-9._/-]+@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)#sha512-[A-Za-z0-9+/=]+$/u,
  /^manifest:sha256:[a-f0-9]{64}$/u,
] as const;
```

The compatibility object is an exact plain record of `core_contract_version`, `domain_contract_version`, `runtime_protocol_version`, and supported `tenant_modes`; canonicalize and hash it before review.

- [ ] **Step 3: Implement review and publication transactions**

Lock platform Actor/role then resource/version. Reviewing a Capability freezes all executable metadata. Publishing a Pack locks every referenced Capability Version in sorted ID order, checks current reviewed state and first-release risk boundary, stores sorted members, marks Pack immutable, writes platform audit, and completes idempotency atomically.

Blocking a Capability is an explicit versioned write that records affected Tenant releases and queues bounded recomputation jobs; it never edits historical Pack members or Snapshots.

- [ ] **Step 4: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/catalog-management.test.ts packages/runtime-core/tests/catalog-security.test.ts`

Run: `npm run check -w @core-agent/runtime-core`

```bash
git add packages/runtime-core
git commit -m "feat(entitlements): add reviewed capability catalog"
```

---

### Task 4: Implement Tenant Pack Releases and platform-manual Entitlement lifecycle

**Files:**

- Create: `packages/runtime-core/src/repositories/entitlements/releases.ts`
- Create: `packages/runtime-core/src/repositories/entitlements/entitlements.ts`
- Create: `packages/runtime-core/src/services/entitlements/select-pack-release.ts`
- Create: `packages/runtime-core/src/services/entitlements/manage-entitlement.ts`
- Create: `packages/runtime-core/src/services/entitlements/expire-entitlements.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/tenant-pack-release.test.ts`
- Create: `packages/runtime-core/tests/manage-entitlement.test.ts`

**Interfaces:**

- Consumes: reviewed Pack versions, real platform Actor/re-auth authority, tenant identity, schema 13.
- Produces: `selectTenantPackRelease`, grant/suspend/reactivate/revoke/expire Entitlement commands, and affected-Profile recomputation intents.

- [ ] **Step 1: Write failing release/grant state-machine tests**

Prove:

- one current exact reviewed Pack Version per Tenant/Product;
- generation starts at 1 and increments for every rollout/rollback attempt that becomes current;
- no Entitlement may activate without a current reviewed release;
- grant source is exactly `platform_manual` and external order identity is unique within Tenant/source;
- same order/Product/payload replays one result; Tenant/Product/validity/seat change conflicts;
- B2B requires positive `seat_quantity`; B2C requires `automatic` and no seat count;
- database time controls start/expiry;
- suspended may reactivate within validity; revoked is terminal; expiry cannot be client-forged; and
- every accepted transition commits AuditEvent, ProductEvent, Outbox, affected Profile recomputation, and Runtime intent atomically.

- [ ] **Step 2: Implement release selection without premature currentness**

Create release candidates in `preparing`; resolve every affected Profile and detect conflicts before advancing current. The service returns:

```ts
export type ReleaseSelectionResult =
  | { readonly kind: "preparing"; readonly releaseId: string; readonly generation: number }
  | { readonly kind: "current"; readonly releaseId: string; readonly generation: number }
  | { readonly kind: "replay"; readonly releaseId: string; readonly generation: number };
```

For a Tenant with no active Entitlement for the Product, static catalog/conflict validation may make the first release `current` without a Runtime; this breaks the initial release -> grant -> Runtime dependency cycle safely. When active authority already depends on the Product, Task 8 makes the candidate release `current` only after Runtime manifest/health proof. Failure leaves the prior current release and pointers untouched.

- [ ] **Step 3: Implement Entitlement commands and expiry claims**

Lock Tenant, current Pack Release, Entitlement/order identity, then affected Profile pointers. Use the database clock for `valid_from`, `expires_at`, and transition decisions. Never store price, receipt, card, payment payload, customer note, or tool name.

Expiry Worker selection uses `FOR UPDATE SKIP LOCKED`, pages of 100, and deterministic idempotent transitions. It recomputes authority immediately and queues projection without direct Runtime calls.

- [ ] **Step 4: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/tenant-pack-release.test.ts packages/runtime-core/tests/manage-entitlement.test.ts`

```bash
git add packages/runtime-core
git commit -m "feat(entitlements): add grants and tenant releases"
```

---

### Task 5: Implement concurrency-safe B2B Pack seat assignments

**Files:**

- Create: `packages/runtime-core/src/repositories/entitlements/assignments.ts`
- Create: `packages/runtime-core/src/services/entitlements/assign-pack-seat.ts`
- Create: `packages/runtime-core/src/services/entitlements/revoke-pack-seat.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/b2b-seat-assignment.test.ts`
- Create: `packages/runtime-core/tests/b2b-seat-concurrency.test.ts`

**Interfaces:**

- Consumes: Identity current authority/Profile rules, active B2B Entitlement, Snapshot resolver port from Task 6.
- Produces: `assignPackSeat`, `revokePackSeat`, and exact used/available seat summaries.

- [ ] **Step 1: Write failing eligibility and replay tests**

Reject cross-Tenant company admin/Profile, inactive Tenant/Membership/Profile/Entitlement, platform-source Membership, admin without consultant Profile, Pack unavailable to B2B, duplicate active pair, stale expected version, and missing recent reauthentication.

Identical idempotency replay returns the same Assignment. Revocation immediately frees one seat, preserves history, recomputes the Profile, and cannot be replayed with a different reason/Profile.

- [ ] **Step 2: Write the real PostgreSQL oversubscription test**

For an Entitlement with `seat_quantity = 3`, begin 20 concurrent serializable transactions assigning 20 eligible Profiles. Assert exactly 3 succeed, 17 return `SEAT_EXHAUSTED`, one row per successful pair, no duplicate Audit/Outbox, and used seats never exceed 3 at any observation point.

- [ ] **Step 3: Implement the mandatory lock order**

Within one transaction:

```ts
const lockOrder = Object.freeze([
  "tenant",
  "acting_membership",
  "entitlement",
  "active_assignments_sorted_by_profile_id",
  "target_membership",
  "target_profile",
  "profile_snapshot_pointer",
] as const);
```

Lock the Entitlement and all active assignments before counting; insert the unique pair, append audit/event/outbox, invoke resolver in the same transaction, and create one projection intent. SQLSTATE `40001`/`40P01` may use existing bounded retry; a post-lock seat exhaustion is a final authority denial.

- [ ] **Step 4: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/b2b-seat-assignment.test.ts packages/runtime-core/tests/b2b-seat-concurrency.test.ts`

```bash
git add packages/runtime-core
git commit -m "feat(entitlements): enforce b2b pack seats"
```

---

### Task 6: Resolve deterministic B2B/B2C effective Capability Snapshots

**Files:**

- Create: `packages/runtime-core/src/repositories/entitlements/snapshots.ts`
- Create: `packages/runtime-core/src/services/entitlements/effective-capabilities.ts`
- Create: `packages/runtime-core/src/services/entitlements/resolve-profile-snapshot.ts`
- Create: `packages/runtime-core/src/services/entitlements/automatic-b2c-assignment.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/effective-capabilities.test.ts`
- Create: `packages/runtime-core/tests/snapshot-immutability.test.ts`
- Create: `packages/runtime-core/tests/b2c-automatic-assignment.test.ts`

**Interfaces:**

- Consumes: current in-window Entitlements, current Tenant releases, B2B Assignments or B2C default Profile.
- Produces: `resolveEffectiveCapabilities`, `persistProfileSnapshot`, `readCurrentEntitlementSnapshot`, staged release-candidate snapshots, and immutable current-pointer advancement.

- [ ] **Step 1: Write a complete resolver matrix**

Cover empty authority, one Pack, suite + add-on union, duplicate exact versions, three-Pack dedupe, conflict on two versions of one family, immediately blocked resources, retired versions retained only through an already-current historical release, expired/suspended/revoked authority, B2B unassigned rights, B2C automatic rights, deterministic ordering, identical-input reuse, and concurrent recomputation.

On conflict, assert the command fails with `CAPABILITY_CONFLICT`, the proposed Entitlement/release activation is not current, the prior Snapshot pointer remains byte-identical, and no Runtime intent for the conflicting set exists.

- [ ] **Step 2: Implement pure canonical resolution**

The pure function accepts already validated plain rows and returns:

```ts
export interface EffectiveCapabilitySet {
  readonly sourceEntitlementIds: readonly string[];
  readonly sourceAssignmentIds: readonly string[];
  readonly sourceReleaseIds: readonly string[];
  readonly capabilities: readonly {
    capabilityId: string;
    capabilityVersionId: string;
    version: string;
  }[];
  readonly canonicalInputHash: `sha256:${string}`;
}
```

Sort every source list and capability triple using ASCII comparison. Group by `capabilityId`; one exact version succeeds and deduplicates, more than one exact version throws before hashing. Hash canonical JSON with domain prefix `core-agent-entitlement-snapshot-v1\0`.

- [ ] **Step 3: Persist immutable Snapshot and separate pointer**

Under Profile pointer lock, reuse a Snapshot with identical canonical hash or insert the next monotonic `snapshot_version`. Insert all source/capability child rows. Ordinary grant/assignment/revocation evaluation expected-version advances the authority pointer immediately and records projection state `preparing`; Trusted Context remains denied until projection availability. A Pack-release upgrade stores the new Snapshot as `pending_release_snapshot_id` and leaves the prior current pointer unchanged until Task 8 proves the new Runtime generation. Append the appropriate Snapshot/release event, AuditEvent, Outbox, and one `capability_runtime_projections` row in the same transaction.

An empty set is a real immutable Snapshot used to deny new Runs and remove future projected capabilities; it is never represented by a missing pointer after a Profile has been evaluated.

- [ ] **Step 4: Implement B2C automatic assignment**

For a B2C Tenant, assert exactly one active student Membership and one default Profile. Every active in-window Entitlement with a current release contributes automatically. There is no Assignment row and no seat mutation. Removing one add-on removes only capabilities not supplied by another Pack.

- [ ] **Step 5: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/effective-capabilities.test.ts packages/runtime-core/tests/snapshot-immutability.test.ts packages/runtime-core/tests/b2c-automatic-assignment.test.ts`

```bash
git add packages/runtime-core
git commit -m "feat(entitlements): resolve immutable capability snapshots"
```

---

### Task 7: Enforce current Snapshot authority in Trusted Context, Run admission, revocation, and account deletion

**Files:**

- Create: `packages/runtime-core/src/services/entitlements/current-authority.ts`
- Create: `packages/runtime-core/src/services/entitlements/revoke-actor-entitlements.ts`
- Modify: `packages/runtime-core/src/services/identity/trusted-context.ts`
- Modify: `packages/runtime-core/src/services/identity/manage-account-deletion.ts`
- Modify: `packages/runtime-core/src/services/create-conversation.ts`
- Modify: `packages/runtime-core/src/services/create-agent-run.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Create: `packages/runtime-core/tests/entitlement-admission.test.ts`
- Create: `packages/runtime-core/tests/revocation-semantics.test.ts`
- Modify: `packages/runtime-core/tests/create-conversation.test.ts`
- Modify: `packages/runtime-core/tests/create-agent-run.test.ts`

**Interfaces:**

- Consumes: current Profile Snapshot pointer and all underlying current authority.
- Produces: concrete `EntitlementSnapshotAuthorityPort`, `requireCurrentSnapshot`, `recheckCapabilityBeforeEffect`, and deletion Entitlement revocation.

- [ ] **Step 1: Write failing current/obsolete-context tests**

Issue a valid signed Context, then suspend/revoke/expire Entitlement, remove Assignment, suspend Profile/Membership/Tenant, block Pack/Capability, or advance release. Prove every transition immediately denies new Context/Conversation/Run, even while the old signature/TTL remains cryptographically valid.

Prove an already-streaming model-only Run may finish and record its historical Snapshot ref. Simulate a future write effect by calling `recheckCapabilityBeforeEffect`; stale authority must deny before the fake external effect counter increments.

- [ ] **Step 2: Implement current Snapshot validation**

Load and lock-free verify:

```ts
export interface CurrentSnapshotAuthority {
  readonly snapshotRef: EntitlementSnapshotRef;
  readonly capabilityIds: readonly string[];
  readonly tenantId: string;
  readonly profileId: string;
  readonly pointerVersion: number;
  readonly current: boolean;
}
```

`current` is true only when pointer, immutable Snapshot, active Tenant/Membership/Profile, current releases, active in-window Entitlements, valid Assignments/B2C automatic mode, unblocked Pack/Capabilities, and non-obsolete Runtime projection generation agree. Authority database failure is `DEPENDENCY_UNAVAILABLE` and fails closed.

- [ ] **Step 3: Integrate Trusted Context and Run admission**

Replace the Identity bootstrap empty-snapshot port. Issuer copies exact sorted `capability_ids` and Snapshot ref. Consumer verifies signature first, then compares pointer/current authority. Conversation/Run creation persists the exact Snapshot ref used for admission and rejects an empty set or preparing projection with calm `ENTITLEMENT_DENIED`/`SERVICE_PREPARING`.

- [ ] **Step 4: Integrate account deletion**

Implement the Identity deletion port in the same database transaction: revoke B2C-owned Entitlements or remove B2B Actor Assignments, recompute affected Profiles, advance empty Snapshots, and queue Runtime reconciliation. Preserve company-owned Entitlement history and other Profiles.

- [ ] **Step 5: Verify and commit**

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/entitlement-admission.test.ts packages/runtime-core/tests/revocation-semantics.test.ts packages/runtime-core/tests/create-conversation.test.ts packages/runtime-core/tests/create-agent-run.test.ts`

```bash
git add packages/runtime-core
git commit -m "feat(entitlements): enforce current snapshot admission"
```

---

### Task 8: Project exact non-executing Capability manifests through Runtime generation and rollback

**Files:**

- Create: `packages/runtime-core/src/runtime/capability-manifest.ts`
- Modify: `packages/runtime-core/src/supervisor/contracts.ts`
- Modify: `packages/runtime-core/src/repositories/worker-runtime.ts`
- Create: `packages/runtime-core/src/repositories/entitlements/projections.ts`
- Create: `apps/control-plane-worker/src/handlers/reconcile-capability-projection.ts`
- Modify: `apps/control-plane-worker/src/main.ts`
- Modify: `apps/control-plane-worker/src/worker-loop.ts`
- Modify: `apps/runtime-supervisor/src/protocol.ts`
- Modify: `apps/runtime-supervisor/src/policy.ts`
- Modify: `apps/runtime-supervisor/src/docker-adapter.ts`
- Modify: `apps/runtime-supervisor/tests/protocol.test.ts`
- Modify: `apps/runtime-supervisor/tests/policy.test.ts`
- Modify: `apps/runtime-supervisor/tests/docker-adapter.test.ts`
- Create: `apps/control-plane-worker/tests/reconcile-capability-projection.test.ts`
- Create: `packages/runtime-core/tests/capability-manifest.test.ts`

**Interfaces:**

- Consumes: pending projection, immutable Snapshot, existing Runtime command fencing, Supervisor inspection.
- Produces: canonical `CapabilityRuntimeManifestV1`, Supervisor protocol v2 provision/inspect proof, and `preparing -> available|failed` projection.

- [ ] **Step 1: Write failing canonical manifest and no-tool-surface tests**

The manifest shape is exact:

```ts
export interface CapabilityRuntimeManifestV1 {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly snapshot_id: string;
  readonly snapshot_version: number;
  readonly runtime_generation: number;
  readonly capabilities: readonly {
    capability_id: string;
    capability_version_id: string;
    version: string;
    kind: "mcp" | "skill" | "policy";
  }[];
}
```

Prove sorted/deduped entries, stable `sha256:` digest, no artifact URL/secret/contract payload/tool schema, and explicit rejection of `external_write`/`privileged`. Inspect the staged Hermes configuration and assert MCP servers/tools/Skills remain empty.

- [ ] **Step 2: Add a versioned Supervisor protocol extension**

Preserve protocol v1 for existing runtime lifecycle and add v2 provision/inspect data carrying only `capability_manifest` plus digest. Validation checks exact keys, canonical hash, Tenant/generation identity, closed kinds, and bounded entry counts/bytes. Unknown/malformed/accessor-backed manifests fail before Docker access.

- [ ] **Step 3: Materialize and prove the manifest safely**

Supervisor writes canonical JSON in the protected staging generation, creates/adopts the managed Volume/container with labels:

```ts
{
  "core-agent.capability-manifest": manifestDigest,
  "core-agent.generation": String(runtimeGeneration),
  "core-agent.tenant-id": tenantId,
}
```

Copy the file read-only to `/opt/data/.core-agent/capabilities/manifest.json`, owned by the managed Runtime UID/GID, while leaving Hermes tool configuration empty. The verifier re-hashes the file and compares label/request/expected digest before reporting healthy readiness.

- [ ] **Step 4: Implement projection Worker fencing and currentness**

Worker loads the pending Snapshot/manifest, increments Runtime generation, enqueues/provisions through existing effect fencing, and inspects exact Tenant/image/generation/Profile set/manifest digest/health. Only then may it mark projection `available`, make the prepared Tenant Pack Release current, advance affected Snapshot pointers, and expose Context admission.

Failure sets safe `failed`, retains authority and bounded retry, keeps the old release/snapshot/generation current, and never exposes the proposed set. Rollback prepares the previous reviewed manifest through a new generation.

- [ ] **Step 5: Verify and commit**

Run: `npm run check -w @core-agent/runtime-supervisor`

Run: `npm run check -w @core-agent/control-plane-worker`

Run: `npm run check -w @core-agent/runtime-core`

```bash
git add packages/runtime-core apps/control-plane-worker apps/runtime-supervisor
git commit -m "feat(runtime): project capability manifest generations"
```

---

### Task 9: Implement B2B service persistence and B2C 30-minute idle stop/wake

**Files:**

- Create: `packages/runtime-core/src/services/entitlements/runtime-lifecycle.ts`
- Create: `packages/runtime-core/src/repositories/entitlements/runtime-activity.ts`
- Create: `apps/control-plane-worker/src/handlers/stop-idle-b2c-runtime.ts`
- Modify: `apps/control-plane-worker/src/handlers/execute-agent-run.ts`
- Modify: `apps/control-plane-worker/src/main.ts`
- Modify: `apps/control-plane-worker/src/worker-loop.ts`
- Modify: `packages/runtime-core/src/services/create-agent-run.ts`
- Create: `packages/runtime-core/tests/entitlement-runtime-lifecycle.test.ts`
- Create: `apps/control-plane-worker/tests/stop-idle-b2c-runtime.test.ts`

**Interfaces:**

- Consumes: active Entitlements/Assignments, Runtime activity, current projection, durable Runtime commands.
- Produces: first-service provision intent, B2B stay-running policy, B2C idle-stop claims, and one idempotent wake-before-Run path.

- [ ] **Step 1: Write failing lifecycle tests**

Prove:

- B2B creates exactly one provision intent only after first available active Assignment;
- B2B remains desired-running while any company service remains active, even when one Profile loses a Pack;
- B2C creates exactly one provision intent on first active Entitlement before service becomes available;
- 29:59 idle does not stop; exactly 30:00 with no queued/running Run does;
- active/queued Run or recent activity cancels idle stop;
- stop preserves Volume and manifest history;
- next Run produces one idempotent start intent, waits for exact ready generation, then admits; and
- concurrent wake requests do not create duplicate Runtime commands or Runs.

- [ ] **Step 2: Define authoritative activity**

Update `runtime_activity.last_work_at` using database time when a Conversation is used, a Run is admitted/started/completed, or a Session becomes active. Idle eligibility is:

```sql
tenant_mode = 'b2c'
and runtime.desired_state = 'running'
and runtime_activity.last_work_at <= clock_timestamp() - interval '30 minutes'
and not exists (
  select 1 from agent_runs
  where tenant_id = runtime_activity.tenant_id
    and status in ('queued', 'running', 'waiting_approval')
)
```

Use `FOR UPDATE SKIP LOCKED` and recheck after acquiring the Runtime advisory lock before creating stop intent.

- [ ] **Step 3: Implement service-driven provision/stay-running**

Entitlement/Assignment transactions write a desired-service projection only. A service creates the one durable Runtime provision/start/stop intent using deterministic `(tenant_id, target_generation, command)` identity. Never call Supervisor or Docker inside authority transactions.

- [ ] **Step 4: Verify and commit**

Run: `npm run check -w @core-agent/control-plane-worker`

Run: `npm run build:runtime-deps && node --import tsx --test --test-concurrency=1 packages/runtime-core/tests/entitlement-runtime-lifecycle.test.ts apps/control-plane-worker/tests/stop-idle-b2c-runtime.test.ts`

```bash
git add packages/runtime-core apps/control-plane-worker
git commit -m "feat(runtime): add entitlement driven lifecycle"
```

---

### Task 10: Expose reauthenticated platform, company, and student management APIs

**Files:**

- Create: `apps/identity-gateway/src/routes/entitlements.ts`
- Create: `apps/identity-gateway/src/routes/catalog.ts`
- Create: `apps/identity-gateway/src/public-entitlement-views.ts`
- Modify: `apps/identity-gateway/src/app.ts`
- Modify: `apps/identity-gateway/src/errors.ts`
- Create: `apps/identity-gateway/tests/entitlement-routes.test.ts`
- Create: `apps/identity-gateway/tests/entitlement-authorization.test.ts`

**Interfaces:**

- Consumes: current Identity/re-auth authority and Tasks 3-9 services.
- Produces: public-safe `/app/v1/platform/catalog`, `/app/v1/platform/entitlements`, `/app/v1/company/services`, `/app/v1/company/assignments`, and `/app/v1/student/services` routes.

- [ ] **Step 1: Write the full HTTP authorization matrix**

Prove:

- only platform super admins with recent reauth create/review/publish/block catalog, select releases, and grant/suspend/revoke/extend Entitlements;
- company admins with recent reauth list same-Tenant Packs/seats and assign/revoke only eligible same-Tenant Profiles;
- consultants cannot administer seats;
- students list only their own B2C product summaries and availability;
- platform Membership actions retain the real platform Actor in tenant audit;
- stale Session/reauth, cross-Tenant IDs, hidden catalog IDs, external order IDs, and malformed versions fail closed; and
- unknown resource versus another Tenant resource is publicly indistinguishable.

- [ ] **Step 2: Implement allowlisted public projections**

Map internal states to:

```ts
export type PublicServiceState =
  | "preparing"
  | "available"
  | "suspended"
  | "expired"
  | "unavailable";
```

Company views include Product display name, used/total/available seats, Assignment Profile display, validity, and public state. Student views include purchased Product display name and service state. Never return Capability artifact/contract/version internals, external order ref, price/receipt, Runtime/container/image IDs, tool schemas, or failure summaries.

- [ ] **Step 3: Implement route admission and calm errors**

Use Identity Gateway Core Session, CSRF, exact Origin, JSON, rate limit, and 10-minute reauth hooks. `SEAT_EXHAUSTED` maps to `“可分配名额已用完。”`; `CAPABILITY_CONFLICT` maps to `“当前服务组合暂时无法启用，请联系支持。”`; Runtime preparation failure maps to `“服务准备未完成，我们正在处理。”` Provider/catalog internals never enter copy.

- [ ] **Step 4: Verify and commit**

Run: `npm run check -w @core-agent/identity-gateway`

Run: `npm test -w @core-agent/identity-gateway -- --test-name-pattern='entitlement|catalog|seat|tenant'`

```bash
git add apps/identity-gateway
git commit -m "feat(identity): expose service entitlement administration"
```

---

### Task 11: Add product, seat, assignment, and preparation states to the Web UI

**Files:**

- Create: `apps/control-plane-web/src/client/features/services/services-api.ts`
- Create: `apps/control-plane-web/src/client/features/services/platform-catalog-view.tsx`
- Create: `apps/control-plane-web/src/client/features/services/platform-grants-view.tsx`
- Create: `apps/control-plane-web/src/client/features/services/company-services-view.tsx`
- Create: `apps/control-plane-web/src/client/features/services/company-seat-view.tsx`
- Create: `apps/control-plane-web/src/client/features/services/student-services-view.tsx`
- Create: `apps/control-plane-web/src/client/features/services/service-status.tsx`
- Create: `apps/control-plane-web/src/client/styles/services.css`
- Modify: `apps/control-plane-web/src/client/app.tsx`
- Modify: `apps/control-plane-web/src/client/components/global-navigation-rail.tsx`
- Create: `apps/control-plane-web/tests/services.test.tsx`
- Create: `apps/control-plane-web/tests/service-status.test.tsx`
- Create: `apps/control-plane-web/tests/web-services.spec.ts`
- Modify: `apps/control-plane-web/playwright.config.ts`

**Interfaces:**

- Consumes: public management views from Task 10 and existing auth shell.
- Produces: role-specific Apple-aligned management surfaces and service-aware conversation admission.

- [ ] **Step 1: Write failing desktop/compact/iPhone journeys**

Cover platform catalog draft/review/publish and manual grant; company seat totals, eligible consultant assignment, concurrent seat-exhausted refresh, revoke; B2C suite + add-on list; preparing -> available; failed calm state; suspended/expired; rollback generation; and empty service state.

Assert there is no price, checkout, fake payment, raw Capability/tool/schema/artifact, external order reference, container/image ID, technical failure code, Hermes/Supabase/provider name, or other-Tenant data. Run axe, keyboard/focus, reduced-motion, 200% zoom, and horizontal-overflow checks for every role.

- [ ] **Step 2: Implement role-specific navigation and forms**

Platform controls live under a clearly internal administration section. Company admins see `服务与名额`; students see `我的服务`; consultants without admin role do not see management navigation. Every mutation uses the auth client CSRF/re-auth flow and disables duplicate submission while pending.

- [ ] **Step 3: Integrate calm preparation with conversation admission**

When state is `preparing`, keep the composer disabled with `“服务正在准备，完成后即可开始对话。”`; when available, enable chat; when suspended/expired/unavailable, show account/service guidance. Do not poll faster than a bounded backoff and stop polling on terminal/auth/navigation states.

- [ ] **Step 4: Verify and commit**

Run: `npm run check -w @core-agent/control-plane-web`

Run: `npm run test:browser -w @core-agent/control-plane-web`

```bash
git add apps/control-plane-web
git commit -m "feat(web): add capability pack management"
```

---

### Task 12: Prove the full authority-to-Runtime slice and record rollout/rollback evidence

**Files:**

- Create: `tests/integration/entitlement-capability.test.ts`
- Create: `tests/integration/entitlement-revocation.test.ts`
- Create: `tests/integration/capability-runtime-projection.test.ts`
- Modify: `tests/integration/fakes/fake-supervisor.ts`
- Create: `scripts/accept-capability-runtime.mjs`
- Create: `docs/operations/entitlement-capability-registry-v1.md`
- Create: `docs/testing/entitlement-capability-registry-v1.md`
- Modify: `docs/security/runtime-v1-threat-model.md`
- Modify: `docs/superpowers/specs/2026-08-10-entitlement-capability-registry-v1-design.md`
- Modify: `.github/workflows/runtime-contract.yml`
- Modify: `package.json`

**Interfaces:**

- Consumes: complete catalog, Identity, Entitlement, Snapshot, Worker, Supervisor, Gateway, and Web implementations.
- Produces: default deterministic CI coverage, opt-in local Runtime proof, operator runbook, and the go/no-go boundary for the separate Policy/MCP Gateway design.

- [ ] **Step 1: Implement the real-PostgreSQL/fake-Runtime full slice**

Prove in one integration suite:

1. reviewed Capability -> published Pack -> Tenant release -> manual Entitlement;
2. B2B seat assignment or B2C automatic Profile resolution;
3. canonical immutable Snapshot and signed Trusted Context;
4. one durable provision/reconcile intent with no direct Docker call;
5. fake Supervisor exact manifest/health proof -> available;
6. new Conversation/Run admitted with exact Snapshot ref;
7. suspension/revocation immediately denies new admission while current model-only stream finishes;
8. stale pre-effect recheck denies;
9. conflicting upgrade preserves current release/snapshot/runtime;
10. valid rollback creates a new generation; and
11. B2C stop at 30 minutes and idempotent wake preserve Volume.

- [ ] **Step 2: Extend default CI and sentinel scans**

Add all deterministic packages to `npm run check`, PostgreSQL suites to `test:postgres`, full slices to `test:integration`, and service UI to Playwright. Extend database/file/event scans with canaries for price, receipt, artifact, tool schema, provider secret, external order, and customer content.

- [ ] **Step 3: Implement opt-in local Runtime acceptance**

Require `CORE_AGENT_CAPABILITY_ACCEPTANCE=1` and a disposable local Tenant. Through the same public/admin commands, load a reviewed non-executing manifest, grant/assign, prove preparing/available, inspect exact manifest digest, prove Hermes has zero managed MCP tools/Skills, revoke, stop/wake B2C, rollback, and clean up the Runtime while preserving/removing the Volume only through separately selected cleanup mode.

The script outputs redacted JSON with IDs hashed, states, generations, digests, durations, and pass/fail only.

- [ ] **Step 4: Document operations, rollout, and rollback**

Give exact commands and gates for contracts 0.7.0, schema 13, feature flags, catalog review, initial non-executing data, grant/revoke, release canary, projection health, conflict diagnosis, Worker retry, B2C idle, release rollback through a new generation, application rollback with mutations disabled, and confirmation that no real MCP is exposed.

- [ ] **Step 5: Run final acceptance**

Run: `node scripts/verify-no-secret.mjs entitlement-private-sentinel`

Run: `npm run contracts:check`

Run: `npm run check`

Run: `npm run test:postgres`

Run: `npm run test:integration`

Run: `npm run test:browser -w @core-agent/control-plane-web`

Optional approved local Runtime only: `CORE_AGENT_CAPABILITY_ACCEPTANCE=1 node scripts/accept-capability-runtime.mjs`

Expected: all deterministic gates pass; opt-in Runtime evidence proves generation/preparation/revocation/rollback/idle wake with an empty Hermes tool surface.

- [ ] **Step 6: Mark the specification implemented and commit evidence**

Record exact commands, commit SHA, contract/schema versions, test counts, concurrency counts, manifest digests, opt-in status, remaining exclusions, and rollback readiness before changing design status.

```bash
git add tests scripts docs .github/workflows/runtime-contract.yml package.json
git commit -m "docs(entitlements): record capability registry acceptance"
```

---

## Final Acceptance Checklist

- [ ] All 17 design acceptance clauses have passing deterministic or explicitly opt-in evidence.
- [ ] Only reviewed immutable Capability/Pack versions become effective; no `latest`, mutable artifact, nested Pack, or unsupported risk class passes.
- [ ] Manual grant replay is idempotent and changed order payload conflicts.
- [ ] Real PostgreSQL concurrency never exceeds B2B Pack seat quantity.
- [ ] B2C suite + add-ons resolve automatically to one default Profile.
- [ ] Exact duplicates dedupe; version conflicts preserve prior current release/Snapshot/Runtime.
- [ ] Snapshots are immutable, canonical, deterministic, tenant-scoped, and exactly referenced by Trusted Context.
- [ ] Revocation denies new Context/Run and a stale simulated write before effect.
- [ ] First B2B Assignment/first B2C Entitlement creates one durable Runtime intent without direct Docker access.
- [ ] Runtime failure never exposes a Capability and the UI remains calm.
- [ ] B2C stop occurs at 30 minutes, preserves Volume, and wakes idempotently.
- [ ] Rollback restores the prior reviewed manifest through a new generation.
- [ ] Audit/events preserve the real Actor and exclude prices, receipts, secrets, raw tool schemas, and customer content.
- [ ] Default CI and opt-in local Runtime evidence pass.
- [ ] Hermes still exposes zero managed MCP tools/Skills; completing this plan authorizes only the next Policy/MCP Gateway design cycle.
