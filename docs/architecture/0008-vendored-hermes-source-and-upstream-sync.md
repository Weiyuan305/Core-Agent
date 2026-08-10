# ADR 0008: Vendored Hermes Source and Controlled Upstream Sync

Status: Accepted; source build canonical, release cutover pending

Date: 2026-08-07

Decision ID: D21

## Context

ADR 0001 chose a thin Core-Agent product image derived from an official,
digest-pinned Hermes image. That decision was appropriate while Core-Agent
owned only managed configuration and a small runtime wrapper. ADR 0007 later
approved one narrow, hash-checked source overlay because the upstream gateway
could otherwise expose raw provider failures.

The planned product now needs more than an isolated terminal projection. Core-Agent
will need a product identity, managed-mode behavior, memory adapters, and explicit
Policy/Capability integration seams. Keeping every downstream change as an opaque
image-time patch would make source review, testing, upstream comparison, and conflict
resolution progressively harder.

The product is still operated by one team and released as one central platform.
Splitting the runtime into a second product repository would add release and access
coordination before separate ownership or release cadence exists. A raw directory
copy would be worse: it would lose a verifiable upstream identity and make later
updates ambiguous.

## Decision

After the managed image completed mandatory live-provider acceptance, Core-Agent
imported the exact accepted Hermes upstream source into
`third_party/hermes-agent` using `git subtree --squash`.

The import is governed by these rules:

- The only upstream is `https://github.com/NousResearch/hermes-agent.git`.
- Import and update commands resolve an explicit reviewed ref to a full immutable
  commit before changing the tree. A moving branch, Docker tag alone, or `latest`
  is not accepted as source identity.
- `infra/hermes/upstream-source.lock.json` records the upstream repository, reviewed
  ref, upstream commit, upstream tree, current downstream subtree, license identity,
  and license digest.
- The subtree contains only upstream Git-tracked source plus reviewed Core-Agent
  changes. It never contains a nested `.git`, `.venv`, `node_modules`, cache,
  generated customer data, local configuration, or credentials.
- The upstream MIT `LICENSE` and copyright notice remain in the vendored tree and
  in distributed copies as required by that license.
- Product configuration, secrets, tenant data, and domain MCP services remain
  outside `third_party/hermes-agent`. Direct source edits are reserved for seams
  where a plugin or external service cannot satisfy the managed product contract.
- Every direct downstream edit uses a focused `hermes`-scoped commit and has a test
  that fails against the unmodified upstream behavior.
- `third_party/hermes-agent` is not added to the root npm workspaces. Its upstream
  Python, Node, and native checks remain isolated from Core-Agent workspace install
  and run only in dedicated source/runtime jobs.

The source enters the product through a multi-stage or two-stage Docker build. Build
dependencies, Git metadata, upstream tests, and development tooling do not become
writable runtime state. The final Core-Agent runtime image retains the current
non-root identity, managed configuration, private `/opt/data` state boundary, fixed
gateway entrypoint, immutable image digest, and per-company container/volume model.

The vendored source does not replace Docker. Source ownership and runtime isolation
are independent: source lives in the monorepo; every company still runs an isolated
Linux container built from a reviewed Core-Agent commit.

## Upstream update policy

Upstream changes are never pulled automatically into `main` or into a published
image. Each update uses a dedicated branch and one explicit candidate commit.

An update must:

1. fetch and resolve the reviewed upstream ref;
2. compare the candidate with the previously locked upstream commit;
3. inspect gateway, prompt identity, Profile, memory, plugin/policy, dependency,
   Docker, security, and license changes;
4. merge the candidate through `git subtree pull --squash`;
5. resolve conflicts without weakening Core-Agent managed boundaries;
6. regenerate and verify the source lock;
7. run upstream-focused tests and every Core-Agent deterministic gate;
8. build amd64 and arm64 candidate images;
9. complete synthetic and live-provider acceptance before changing the product-image
   lock; and
10. retain the previously accepted product-image digest as rollback authority.

Product modifications and upstream intake remain separate commits. This keeps review
clear: one commit describes what Nous Research changed; later commits describe what
Core-Agent intentionally carries downstream.

## Migration gate outcome

The Conversation Reliability and source-candidate live-provider criteria are
recorded as passed. The verified two-stage source build is therefore the canonical
local and CI build path. `npm run hermes:build` verifies the source lock, builds the
vendored Hermes tree for the selected platform, and then builds the Core-Agent
product layer from that local source image.

The former official-image overlay is retained at
`infra/hermes/Dockerfile.upstream-image` as historical migration and diagnostic
evidence only. Default scripts and release workflows never select it. Its
`base-images.lock.json` remains reviewable without acting as current build
authority.

Canonical build selection does not itself authorize publication or runtime cutover.
The accepted `product-images.lock.json` remains unchanged until the separately
approved manual workflow publishes and an operator reviews both platform digests.
Until that cutover succeeds, ADR 0001's accepted product digest remains operational
and rollback authority. After cutover, this record supersedes only ADR 0001's
decision to consume Hermes solely through the official prebuilt image; digest
pinning, persistent state, tenant isolation, and rollback requirements remain in
force.

## Alternatives considered

### Continue image overlays indefinitely

Rejected as the long-term direction. It remains the current accepted baseline, but
multiple core changes would become difficult to review and rebase as independent
hash-sensitive patches.

### Separate Core-Agent and Hermes product repositories

Deferred. This becomes useful when separate teams or release cadences exist. At the
current stage it creates coordination cost without increasing isolation at runtime.

### Git submodule

Rejected. It still requires a second repository and creates detached checkout,
recursive clone, CI cache, and contributor setup failure modes.

### Raw source copy

Rejected. It loses an enforceable upstream commit relationship and invites accidental
inclusion of local dependencies, caches, generated state, or credentials.

### Full unsquashed upstream history in the product repository

Rejected for the first import. A squashed subtree keeps the product repository and
clone cost bounded while the source lock preserves immutable upstream provenance.

## Consequences

- One repository contains the complete buildable product and reviewed agent runtime
  source.
- Core-Agent accepts responsibility for source-level security review, dependency
  updates, conflict resolution, and multi-platform image validation.
- Clone size and CI inputs increase, so path-filtered jobs and strict build contexts
  are required.
- Upstream updates become explicit engineering work rather than a base-image digest
  change.
- Product branding can change without exposing Hermes to end users, while required
  third-party license notices remain preserved outside the chat surface.
- A published source-built image is always traceable to both a Core-Agent commit and
  the locked upstream Hermes commit.

## Related records

- [Hermes Runtime distribution boundary](0001-hermes-runtime-distribution.md)
- [Managed Hermes terminal error projection](0007-managed-hermes-error-projection.md)
- [Hermes source vendoring implementation plan](../superpowers/plans/2026-08-07-hermes-source-vendoring.md)
- [Conversation Reliability v1 design](../superpowers/specs/2026-08-07-conversation-reliability-v1-design.md)
