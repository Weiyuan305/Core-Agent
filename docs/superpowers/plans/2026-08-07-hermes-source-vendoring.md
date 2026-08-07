# Hermes Source Vendoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the exact accepted Hermes source into the Core-Agent monorepo, preserve a verifiable upstream relationship, build the existing managed company runtime from that source, and establish a controlled repeatable update path without changing product behavior during migration.

**Architecture:** Import one immutable upstream snapshot at third_party/hermes-agent through a squashed Git subtree and bind it to a checked-in source lock. Build a local upstream-source image from that tree, then add the existing Core-Agent managed layer in a second image stage; publish only after deterministic, multi-platform, synthetic, and live-provider equivalence gates pass. Future upstream intake uses explicit commits, dedicated branches, subtree merges, source-lock regeneration, and the same release gates.

**Tech Stack:** Git subtree, Node.js 22.13+, Python 3.11+, upstream Hermes Python/Node toolchain, Docker Buildx, GitHub Actions, GHCR, Node test runner, PostgreSQL integration tests, Playwright.

## Global Constraints

- Do not execute this plan until the current Conversation Reliability live-provider acceptance criterion is recorded as passed using the existing reviewed product image.
- Import only from https://github.com/NousResearch/hermes-agent.git and resolve refs/tags/v2026.7.30 to a full immutable commit before the first tree change. If that ref does not exist or cannot be reconciled with the accepted image, stop the migration and add a new reviewed source-provenance decision before continuing.
- Use git subtree --squash; do not add a submodule, nested .git, separate product repository, or untracked directory copy.
- Import only Git-tracked source. Reject .env, .venv, node_modules, caches, private keys, credentials, customer data, student data, and generated runtime state.
- Preserve the upstream MIT LICENSE and copyright notice in the vendored tree and distributed image.
- Keep third_party/hermes-agent outside the root npm workspaces. Its dependency installation and tests are isolated from apps/* and packages/*.
- Prefer Core-Agent product configuration, plugins, and external services. Modify vendored Hermes source only where the managed product contract cannot be enforced through those boundaries.
- Keep every downstream Hermes source change in a focused hermes-scoped commit with a failing test first.
- The migration candidate must add no Product Identity, memory, Capability, MCP, Skill, billing, or user-facing feature behavior.
- Keep the current official-image product digest as rollback authority until the source-built image completes every acceptance gate and a separately approved lock update is committed.
- Do not publish an image, change infra/hermes/product-images.lock.json, deploy, or push during Tasks 1 through 6 without separate explicit approval.
- Keep the final runtime non-root, immutable outside /opt/data, secret-free at build time, private-networked, and isolated one container plus persistent volume per B2B tenant.
- Support exactly linux/amd64 and linux/arm64; do not create or consume a mutable latest tag.
- Every source update is operator-initiated on a dedicated branch. No bot or scheduled job may merge an upstream change or alter the product-image lock automatically.

## File Structure

The migration creates and owns these boundaries:

~~~text
third_party/
└── hermes-agent/                         # squashed upstream subtree plus reviewed downstream source commits

infra/hermes/
├── Dockerfile                            # canonical source-built product layer after cutover
├── Dockerfile.upstream-image             # pre-cutover product layer retained during equivalence work
├── upstream-source.lock.json             # upstream and downstream source identity
├── managed/                              # product configuration, unchanged
├── runtime/                              # initializer and gateway entrypoint, unchanged
└── patches/                              # accepted historical overlay evidence, not applied after cutover

scripts/
├── generate-hermes-source-lock.mjs       # atomically writes the source lock from reviewed Git objects
├── verify-hermes-source.mjs              # validates lock shape, current subtree, license, and forbidden paths
└── build-hermes-source-image.mjs          # builds source base followed by Core-Agent product image

docs/operations/
└── hermes-upstream-sync.md               # exact update, review, release, and rollback runbook
~~~

infra/hermes/upstream-source.lock.json has one closed shape:

~~~json
{
  "schema_version": 1,
  "source_mode": "git-subtree-squash",
  "upstream_repository": "https://github.com/NousResearch/hermes-agent.git",
  "upstream_ref": "refs/tags/v2026.7.30",
  "upstream_commit": "40 lowercase hexadecimal characters",
  "upstream_tree": "40 lowercase hexadecimal characters",
  "product_tree": "40 lowercase hexadecimal characters",
  "license": "MIT",
  "license_sha256": "64 lowercase hexadecimal characters"
}
~~~

The descriptive lengths above document validation. The committed file is generated from actual Git objects during Task 2 and contains no symbolic value.

---

### Task 1: Add source-lock generation and verification gates

**Files:**

- Create: scripts/generate-hermes-source-lock.mjs
- Create: scripts/verify-hermes-source.mjs
- Create: tests/runtime/hermes-source-vendoring.test.mjs
- Modify: package.json
- Modify: .github/workflows/runtime-contract.yml

**Interfaces:**

- Consumes: repository root, third_party/hermes-agent, an explicit upstream ref and commit, and a supplied Git command port for tests.
- Produces: generateHermesSourceLock(options), validateHermesSourceLock(value), and verifyHermesSource(options).

- [ ] **Step 1: Write failing closed-shape and provenance tests**

Add table-driven tests that reject extra keys, a non-official repository, a branch ref on first import, uppercase or short object IDs, an unknown license, a mismatched product tree, a missing license, a changed license digest, and forbidden tracked paths.

Use this exact valid fixture shape:

~~~js
const lock = Object.freeze({
  schema_version: 1,
  source_mode: "git-subtree-squash",
  upstream_repository: "https://github.com/NousResearch/hermes-agent.git",
  upstream_ref: "refs/tags/v2026.7.30",
  upstream_commit: "1".repeat(40),
  upstream_tree: "2".repeat(40),
  product_tree: "3".repeat(40),
  license: "MIT",
  license_sha256: "4".repeat(64),
});
~~~

The fake Git port returns only bounded object IDs and tracked path names. Assert every public error is one of HERMES_SOURCE_LOCK_INVALID, HERMES_SOURCE_TREE_MISMATCH, HERMES_SOURCE_LICENSE_INVALID, or HERMES_SOURCE_CONTENT_REJECTED; no failing path or Git stderr is reflected.

- [ ] **Step 2: Run the focused test and observe failure**

Run: node --test tests/runtime/hermes-source-vendoring.test.mjs

Expected: FAIL because both source-lock modules are absent.

- [ ] **Step 3: Implement the closed lock validator**

Use exact-key validation and immutable return values:

~~~js
const lockKeys = Object.freeze([
  "license",
  "license_sha256",
  "product_tree",
  "schema_version",
  "source_mode",
  "upstream_commit",
  "upstream_ref",
  "upstream_repository",
  "upstream_tree",
]);

const gitObjectPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

export function validateHermesSourceLock(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidLock();
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(lockKeys)) throw invalidLock();
  if (value.schema_version !== 1 || value.source_mode !== "git-subtree-squash") throw invalidLock();
  if (value.upstream_repository !== "https://github.com/NousResearch/hermes-agent.git") throw invalidLock();
  if (!/^refs\/tags\/[A-Za-z0-9._-]{1,128}$/u.test(value.upstream_ref)) throw invalidLock();
  if (!gitObjectPattern.test(value.upstream_commit)
    || !gitObjectPattern.test(value.upstream_tree)
    || !gitObjectPattern.test(value.product_tree)
    || !digestPattern.test(value.license_sha256)
    || value.license !== "MIT") throw invalidLock();
  return Object.freeze({ ...value });
}
~~~

All error constructors use fixed messages and never append caught messages, Git stderr, or filesystem paths.

- [ ] **Step 4: Implement deterministic generation and atomic write**

generateHermesSourceLock() must:

1. require the explicit ref and full commit;
2. execute `git rev-parse "${UPSTREAM_COMMIT}^{commit}"` and require an exact match;
3. execute `git rev-parse "${UPSTREAM_COMMIT}^{tree}"` for upstream_tree;
4. require no unstaged change below third_party/hermes-agent, execute git write-tree,
   and resolve third_party/hermes-agent from that index tree for product_tree;
5. hash third_party/hermes-agent/LICENSE as bytes with SHA-256;
6. require its first line to equal MIT License;
7. serialize sorted two-space JSON with one trailing newline; and
8. write a private temporary file followed by an atomic rename to infra/hermes/upstream-source.lock.json.

The CLI surface is exact:

~~~text
node scripts/generate-hermes-source-lock.mjs \
  --upstream-ref refs/tags/v2026.7.30 \
  --upstream-commit "$UPSTREAM_COMMIT"
~~~

Missing, repeated, or unknown arguments exit nonzero with HERMES_SOURCE_LOCK_ARGUMENTS_INVALID.

- [ ] **Step 5: Implement repository verification**

verifyHermesSource() rejects unstaged changes below the subtree, computes the
current subtree from the Git index, compares it with the lock and license, then
reads tracked paths using:

~~~text
git ls-files -z -- third_party/hermes-agent
~~~

Reject a tracked path when its subtree-relative segments include .git, .venv, venv, node_modules, __pycache__, .pytest_cache, or .env, or when the basename ends with .pem, .key, .p12, or .pfx. Require LICENSE, pyproject.toml, uv.lock, Dockerfile, and gateway/platforms/api_server.py.

- [ ] **Step 6: Add root and CI gates**

Add these scripts without adding third_party to workspaces:

~~~json
{
  "hermes:source:lock": "node scripts/generate-hermes-source-lock.mjs",
  "hermes:source:verify": "node scripts/verify-hermes-source.mjs"
}
~~~

Add npm run hermes:source:verify after npm ci in the deterministic runtime CI job. Until Task 2 creates the tree and lock, the verifier supports one repository-controlled bootstrap state: both paths absent. If exactly one exists, verification fails. Task 2 removes the bootstrap allowance in the same commit that adds the subtree.

- [ ] **Step 7: Verify and commit**

Run: node --test tests/runtime/hermes-source-vendoring.test.mjs

Run: npm run test:runtime

Expected: all runtime tests pass while both source paths are absent.

~~~bash
git add scripts/generate-hermes-source-lock.mjs scripts/verify-hermes-source.mjs tests/runtime/hermes-source-vendoring.test.mjs package.json .github/workflows/runtime-contract.yml
git commit -m "build(hermes): add vendored source provenance gates"
~~~

---

### Task 2: Import the exact accepted upstream snapshot through Git subtree

**Files:**

- Create: third_party/hermes-agent/ from the reviewed upstream commit
- Create: infra/hermes/upstream-source.lock.json
- Modify: scripts/verify-hermes-source.mjs
- Modify: tests/runtime/hermes-source-vendoring.test.mjs
- Modify: .gitignore only if the imported upstream tree requires repository-root exclusions

**Interfaces:**

- Consumes: successful live-provider acceptance evidence, official upstream tag v2026.7.30, Task 1 generators, and a clean dedicated migration worktree.
- Produces: one auditable squashed subtree import and a lock binding the accepted upstream source to the current product tree.

- [ ] **Step 1: Prove the execution precondition**

Read docs/testing/conversation-reliability-v1.md and require the live-provider criterion to be recorded as passed with a reviewed product-image digest.

Run:

~~~bash
git status --short --branch
git rev-parse HEAD
~~~

Expected: the migration worktree is clean and its base commit is reachable from main.

- [ ] **Step 2: Fetch and resolve the explicit upstream ref**

Run:

~~~bash
git remote add hermes-upstream https://github.com/NousResearch/hermes-agent.git
git fetch --no-tags hermes-upstream refs/tags/v2026.7.30
git rev-parse FETCH_HEAD^{commit}
git rev-parse FETCH_HEAD^{tree}
~~~

Expected: both rev-parse commands print one full lowercase 40-character object ID. Keep the commit output as UPSTREAM_COMMIT for the remaining import steps. Do not read from an upstream branch.

- [ ] **Step 3: Bind the source to the accepted image release**

Require infra/hermes/base-images.lock.json to name nousresearch/hermes-agent:v2026.7.30 for both platforms. Inspect the accepted image metadata and release evidence for the resolved commit. If the image does not expose enough provenance to bind it to the fetched source, stop; do not infer a commit from date or file similarity.

- [ ] **Step 4: Import the subtree**

Run:

~~~bash
git subtree add \
  --prefix=third_party/hermes-agent \
  hermes-upstream \
  "$UPSTREAM_COMMIT" \
  --squash
~~~

Expected: Git creates the subtree and a squashed merge without a nested .git directory.

- [ ] **Step 5: Generate the real source lock and close bootstrap mode**

Run:

~~~bash
node scripts/generate-hermes-source-lock.mjs \
  --upstream-ref refs/tags/v2026.7.30 \
  --upstream-commit "$UPSTREAM_COMMIT"
~~~

Remove the both-absent allowance from verifyHermesSource(). From this commit onward, missing source or lock is always an error.

- [ ] **Step 6: Verify import hygiene**

Run:

~~~bash
npm run hermes:source:verify
git ls-files -- third_party/hermes-agent/.git third_party/hermes-agent/.venv third_party/hermes-agent/node_modules
git status --short
~~~

Expected: verification passes and the forbidden-path query prints nothing.

- [ ] **Step 7: Commit the source identity**

~~~bash
git add infra/hermes/upstream-source.lock.json scripts/verify-hermes-source.mjs tests/runtime/hermes-source-vendoring.test.mjs
git commit -m "build(hermes): bind accepted upstream source"
~~~

---

### Task 3: Move the accepted terminal projection into downstream source

**Files:**

- Create: third_party/hermes-agent/core_agent_error_projection.py
- Modify: third_party/hermes-agent/gateway/platforms/api_server.py
- Create: third_party/hermes-agent/tests/test_core_agent_error_projection.py
- Modify: infra/hermes/upstream-source.lock.json
- Modify: tests/runtime/hermes-release.test.mjs

**Interfaces:**

- Consumes: the accepted bytes and behavior in infra/hermes/runtime/error_projection.py and infra/hermes/patches/v2026.7.30-gateway-error-projection.patch.
- Produces: the same closed choices plus hermes failure terminal directly in the vendored source, with no raw provider reflection.

- [ ] **Step 1: Add failing downstream Python tests**

Cover the six accepted provider codes, status/text classification, unknown fallback, partial flag, exact key sets, and hostile exception accessors. Assert projected JSON never contains the exception string, URL, model name, traceback, credential marker, message, or error.

Use this terminal assertion:

~~~py
assert project_terminal_failure(RuntimeError("provider unavailable"), partial=False) == {
    "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
    "hermes": {
        "completed": False,
        "partial": False,
        "failed": True,
        "error_code": "model_service_unavailable",
        "retryable": True,
    },
}
~~~

- [ ] **Step 2: Run against pristine source and observe failure**

Run:

~~~bash
cd third_party/hermes-agent
uv run --frozen pytest -q tests/test_core_agent_error_projection.py
~~~

Expected: FAIL because core_agent_error_projection is absent.

- [ ] **Step 3: Apply the accepted implementation**

Copy the bytes of infra/hermes/runtime/error_projection.py to third_party/hermes-agent/core_agent_error_projection.py, then apply the reviewed patch to third_party/hermes-agent/gateway/platforms/api_server.py. Do not broaden classification, add logging values, or change terminal shape during migration.

- [ ] **Step 4: Replace image-overlay assertions with source assertions**

Update tests/runtime/hermes-release.test.mjs to require the vendored API server import and call, no reflected raw failure text, retained historical ADR 0007 evidence, and no historical installer execution in the source build.

- [ ] **Step 5: Run tests and regenerate the product-tree lock**

Run the downstream Python test, stage only the reviewed subtree changes, regenerate
the source lock using its existing upstream ref and commit, stage the lock, then run
npm run hermes:source:verify and node --test tests/runtime/hermes-release.test.mjs.

The generator reads product_tree from the Git index, so the sequence is exact:

~~~bash
git add third_party/hermes-agent
node scripts/generate-hermes-source-lock.mjs \
  --upstream-ref refs/tags/v2026.7.30 \
  --upstream-commit "$UPSTREAM_COMMIT"
git add infra/hermes/upstream-source.lock.json
~~~

Expected: all focused tests pass. product_tree changes while upstream_commit and upstream_tree remain unchanged.

- [ ] **Step 6: Commit**

~~~bash
git add third_party/hermes-agent infra/hermes/upstream-source.lock.json tests/runtime/hermes-release.test.mjs
git commit -m "feat(hermes): own managed terminal projection in source"
~~~

---

### Task 4: Build a source-based candidate without changing release authority

**Files:**

- Create: infra/hermes/Dockerfile.source
- Create: scripts/build-hermes-source-image.mjs
- Create: tests/runtime/hermes-source-image.test.mjs
- Modify: package.json
- Modify: .dockerignore

**Interfaces:**

- Consumes: verified source lock, upstream subtree Dockerfile, Core-Agent managed files, explicit platform, and explicit local product tag.
- Produces: buildSourceImageArgs(input), buildProductImageArgs(input), and a local core-agent/hermes-runtime:source-candidate image.

- [ ] **Step 1: Write failing build-orchestration tests**

Assert the builder executes exactly two Docker Buildx calls in order:

1. source context third_party/hermes-agent, upstream Dockerfile, --platform,
   --load, HERMES_GIT_SHA set to the source lock's upstream_commit, and an
   internal tag derived from its first 12 characters plus platform slug;
2. root context, infra/hermes/Dockerfile.source, the same platform, --load,
   HERMES_SOURCE_IMAGE set to that derived internal tag, and the caller product
   tag.

Reject extra arguments, remote product tags, mutable latest, unknown platforms, mismatched source lock, and Docker spawn/nonzero failures with fixed messages.

- [ ] **Step 2: Run focused tests and observe failure**

Run: node --test tests/runtime/hermes-source-image.test.mjs

Expected: FAIL because the source image builder and Dockerfile are absent.

- [ ] **Step 3: Create the source product Dockerfile**

Start with this boundary:

~~~dockerfile
# syntax=docker/dockerfile:1.7

ARG HERMES_SOURCE_IMAGE
FROM ${HERMES_SOURCE_IMAGE}

LABEL org.opencontainers.image.title="Core-Agent Hermes Runtime"
LABEL org.opencontainers.image.description="Source-built managed Hermes runtime for Core-Agent"
LABEL org.opencontainers.image.vendor="Core-Agent"

USER root

COPY infra/hermes/managed/config.yaml /etc/hermes/config.yaml
COPY infra/hermes/runtime/initialize.py /opt/core-agent/initialize.py
COPY infra/hermes/runtime/gateway-entrypoint.sh /opt/core-agent/gateway-entrypoint.sh
~~~

Reuse the current exact ownership, mode, environment, non-root USER hermes, and fixed entrypoint instructions. Do not copy or run install_error_projection.py; Task 3 made that behavior part of reviewed source.

- [ ] **Step 4: Implement the two-stage local builder**

The CLI accepts only:

~~~text
node scripts/build-hermes-source-image.mjs \
  --platform linux/arm64 \
  --tag core-agent/hermes-runtime:source-candidate
~~~

Default platform comes from existing hostToImagePlatform() mapping. Call verifyHermesSource() before Docker. Set the source build context to the subtree so Core-Agent secrets and files cannot enter that stage.

- [ ] **Step 5: Add strict build contexts**

Keep root .dockerignore exclusions for Git metadata, local secrets, runtime state, dependencies, screenshots, and dumps. Require imported upstream .dockerignore to exclude its own .git, local environment, caches, and runtime state. Tests fail if .env, .git, .venv, node_modules, or local runtime state can enter a build context.

- [ ] **Step 6: Verify local candidate**

Run:

~~~bash
node --test tests/runtime/hermes-source-image.test.mjs
npm run hermes:source:verify
npm run hermes:source:build -- --tag core-agent/hermes-runtime:source-candidate
docker image inspect core-agent/hermes-runtime:source-candidate
~~~

Expected: image builds for host platform; inspect reports non-root runtime user, fixed gateway entrypoint, and no secret-bearing environment value.

- [ ] **Step 7: Commit**

~~~bash
git add infra/hermes/Dockerfile.source scripts/build-hermes-source-image.mjs tests/runtime/hermes-source-image.test.mjs package.json .dockerignore
git commit -m "build(hermes): create source-built runtime candidate"
~~~

---

### Task 5: Prove functional and security equivalence

**Files:**

- Create: docs/testing/hermes-source-vendoring.md
- Modify: tests/runtime/runtime-contract.test.mjs
- Modify: tests/runtime/hermes-release.test.mjs
- Modify: docs/operations/runtime-v1-local-smoke.md

**Interfaces:**

- Consumes: accepted official-image product digest and local source-built candidate.
- Produces: bounded equivalence evidence containing only commits, tree IDs, image IDs/digests, event types, fixed failure codes, counts, and final states.

- [ ] **Step 1: Add failing image-contract tests**

Require /opt/data as only persistent Hermes state root, expected non-root identity, fixed gateway entrypoint, exact managed tool surface, no Docker/provider/bootstrap/Control Plane credential in image, private networking, resource limits, and closed failure projection.

- [ ] **Step 2: Run deterministic gates**

Run:

~~~bash
npm run hermes:source:verify
npm run check
npm test
npm run test:postgres
npm run test:integration
~~~

Expected: every command passes. Record only suite counts and final status.

- [ ] **Step 3: Run container and synthetic acceptance**

Run existing Compose/runtime gates against core-agent/hermes-runtime:source-candidate, followed by strict synthetic smoke. Verify provisioning, two Profile routes, multi-turn reuse, new Conversation isolation, restart recovery, explicit retry, ordered cleanup, and secret zeroization.

Expected: same allowlisted states and event families as accepted official-image product; no transcript or secret value enters evidence.

- [ ] **Step 4: Run browser acceptance**

Run deterministic browser tests at both viewports, then opt-in local Web against source candidate using anonymous prompts.

Expected: streaming, new Conversation, partial/zero-content failure, and retry remain product-identical; Browser never receives Hermes, provider names, internal codes, URLs, or raw errors.

- [ ] **Step 5: Run operator-approved live-provider equivalence**

Use same configured provider/model and anonymous prompts as accepted baseline. Prove multi-turn response, new Conversation, API/Worker restart recovery, and explicit retry after controlled failure.

Expected: all outcomes pass. Provider unavailability leaves migration unaccepted.

- [ ] **Step 6: Complete evidence and commit**

Record Core-Agent commit, upstream commit/tree, product tree, candidate image ID/digest, platform, commands, counts, and final states. Exclude prompts, assistant text, headers, credentials, provider bodies, internal paths, and customer data.

~~~bash
git add docs/testing/hermes-source-vendoring.md tests/runtime/runtime-contract.test.mjs tests/runtime/hermes-release.test.mjs docs/operations/runtime-v1-local-smoke.md
git commit -m "test(hermes): verify source-built runtime equivalence"
~~~

---

### Task 6: Make source builds canonical while preserving rollback

**Files:**

- Rename: infra/hermes/Dockerfile to infra/hermes/Dockerfile.upstream-image
- Rename: infra/hermes/Dockerfile.source to infra/hermes/Dockerfile
- Modify: scripts/build-hermes-image.mjs
- Modify: .github/workflows/publish-hermes-runtime.yml
- Modify: tests/runtime/hermes-release.test.mjs
- Modify: tests/runtime/runtime-contract.test.mjs
- Modify: README.md
- Modify: docs/architecture/0008-vendored-hermes-source-and-upstream-sync.md

**Interfaces:**

- Consumes: accepted Task 5 evidence and existing manual private release protocol.
- Produces: source-backed canonical local and CI builds; published product lock remains unchanged until Task 8.

- [ ] **Step 1: Write failing canonical-build tests**

Require npm run hermes:build and publish workflow to verify source lock, build third_party/hermes-agent first, pass locked upstream commit as HERMES_GIT_SHA, and build product from local source image. Require OCI labels for Core-Agent and upstream commits. Reject unpinned branch and latest references.

- [ ] **Step 2: Rename Dockerfiles and update local build**

Make accepted source product Dockerfile canonical. Preserve old official-image Dockerfile under Dockerfile.upstream-image as migration evidence and diagnostics; default scripts and release workflows must not select it.

scripts/build-hermes-image.mjs becomes a thin adapter over build-hermes-source-image.mjs. Remove official base-image resolution from default path without deleting historical base-images.lock.json.

- [ ] **Step 3: Update multi-platform publishing**

For each platform matrix entry:

1. run npm run hermes:source:verify;
2. build upstream source for exact platform;
3. build and push product by digest;
4. label it with Core-Agent and locked upstream commits; and
5. preserve private visibility, digest validation, immutable version/SHA tags, and candidate-lock artifact behavior.

- [ ] **Step 4: Verify workflow and local contracts**

Run:

~~~bash
npm run hermes:source:verify
node --test tests/runtime/hermes-release.test.mjs tests/runtime/runtime-contract.test.mjs
npm run check
npm test
git diff --check
~~~

Expected: all pass and infra/hermes/product-images.lock.json remains byte-for-byte unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add infra/hermes scripts/build-hermes-image.mjs .github/workflows/publish-hermes-runtime.yml tests/runtime README.md docs/architecture/0008-vendored-hermes-source-and-upstream-sync.md
git commit -m "build(hermes): make vendored source canonical"
~~~

---

### Task 7: Document and test repeatable upstream intake

**Files:**

- Create: docs/operations/hermes-upstream-sync.md
- Modify: README.md
- Modify: docs/operations/runtime-v1-production-boundary.md
- Modify: tests/runtime/hermes-source-vendoring.test.mjs

**Interfaces:**

- Consumes: source lock, hermes-upstream remote, explicit reviewed upstream commit, and canonical release gates.
- Produces: one operator-run update procedure that preserves downstream modifications and cannot publish automatically.

- [ ] **Step 1: Write failing runbook contract tests**

Require commands for remote verification, explicit fetch/ref resolution, dedicated branch, subtree pull, lock regeneration, forbidden scan, downstream diff review, upstream tests, Core-Agent gates, two-platform build, live acceptance, manual publish, lock review, and rollback. Reject latest, direct upstream-main pull, automatic merge, and automatic product-lock commit.

- [ ] **Step 2: Write upstream sync runbook**

Prescribe:

~~~bash
git switch main
git pull --ff-only origin main
git switch -c chore/hermes-upstream-vYYYY.MM.DD
git remote get-url hermes-upstream
git fetch --no-tags hermes-upstream refs/tags/vYYYY.MM.DD
git rev-parse FETCH_HEAD^{commit}
git rev-parse FETCH_HEAD^{tree}
git subtree pull --prefix=third_party/hermes-agent hermes-upstream "$UPSTREAM_COMMIT" --squash
node scripts/generate-hermes-source-lock.mjs --upstream-ref refs/tags/vYYYY.MM.DD --upstream-commit "$UPSTREAM_COMMIT"
npm run hermes:source:verify
~~~

vYYYY.MM.DD is an operator-supplied candidate in the runbook. Scripts reject the literal example value.

- [ ] **Step 3: Require seam-by-seam review**

Require notes for prompt identity and SOUL/Profile behavior; gateway streaming/errors; Profile lifecycle; memory and consent/ACL seams; plugin/tool/Skill/MCP/Policy hooks; provider redaction; Docker/user/filesystem/network; Python/Node locks; and license notices.

- [ ] **Step 4: Define conflict and rejection rules**

Reject candidates that require weakening tenant isolation, SecretStore, error projection, public protocol, non-root execution, immutable images, or human approval for writes. Resolve each conflict with a focused commit and test; never choose all-upstream or all-downstream mechanically.

- [ ] **Step 5: Verify and commit**

Run: node --test tests/runtime/hermes-source-vendoring.test.mjs

Run: git diff --check

Expected: runbook contract passes.

~~~bash
git add docs/operations/hermes-upstream-sync.md README.md docs/operations/runtime-v1-production-boundary.md tests/runtime/hermes-source-vendoring.test.mjs
git commit -m "docs(hermes): define controlled upstream synchronization"
~~~

---

### Task 8: Publish, review, lock, and cut over accepted source image

**Files:**

- Modify: infra/hermes/product-images.lock.json using existing candidate-lock artifact
- Modify: docs/testing/hermes-source-vendoring.md
- Modify: docs/operations/runtime-v1-acceptance-evidence.md
- Modify: docs/architecture/0008-vendored-hermes-source-and-upstream-sync.md
- Modify: README.md

**Interfaces:**

- Consumes: explicit publication approval, accepted Core-Agent commit on main, source lock, Task 5 evidence, and manual private workflow.
- Produces: reviewed immutable amd64/arm64 source-built product references and documented rollback point.

- [ ] **Step 1: Re-run pre-publication gates**

Run from clean exact release checkout:

~~~bash
npm ci
npm run hermes:source:verify
npm run check
npm test
npm run test:postgres
npm run test:integration
git status --short
~~~

Expected: every command passes and status is clean.

- [ ] **Step 2: Dispatch manual private release**

Supply canonical new version and full accepted Core-Agent commit. Workflow builds both platforms and uploads candidate lock; it does not commit it.

- [ ] **Step 3: Review registry state**

Compare workflow digests with GHCR, require private visibility, verify exact Core-Agent/upstream labels, and confirm version/SHA tags resolve to one manifest. Any mismatch rejects release.

- [ ] **Step 4: Commit candidate-lock bytes unchanged**

Copy artifact to infra/hermes/product-images.lock.json without reformatting. Require product-lock/runtime tests and a byte diff containing only version, source commit, and two platform digests.

- [ ] **Step 5: Canary and record rollback**

Provision one synthetic tenant, run strict smoke and local Web live acceptance, and record previous product-image digest as rollback. Rollback selects that digest and increments Runtime generation.

- [ ] **Step 6: Finalize documentation and commit**

Mark ADR 0008 cutover evidence complete without rewriting ADR 0001 or ADR 0007. Record only identities, digests, commands, counts, and final states.

~~~bash
git add infra/hermes/product-images.lock.json docs/testing/hermes-source-vendoring.md docs/operations/runtime-v1-acceptance-evidence.md docs/architecture/0008-vendored-hermes-source-and-upstream-sync.md README.md
git commit -m "release(hermes): accept source-built managed runtime"
~~~

---

## Final Acceptance Matrix

| Requirement | Evidence |
| --- | --- |
| Live-provider baseline completed before import | Conversation Reliability evidence reviewed in Task 2 |
| Exact upstream source provenance | Source lock plus generator/verifier tests |
| One-repository checkout | Tracked subtree with no nested Git repository |
| No dependency/cache/secret contamination | Tracked-path and build-context negative gates |
| Required MIT notice preserved | License digest and image/source inspection |
| Downstream changes distinguishable | Focused hermes commits and product-tree identity |
| Repeatable upstream intake | Dedicated-branch subtree runbook and contract tests |
| Existing managed behavior preserved | Deterministic, PostgreSQL, integration, browser, synthetic, and live evidence |
| amd64 and arm64 supported | Manual private workflow platform digests |
| Rollback preserved | Previous product-image digest and Runtime generation procedure |
| No automatic upstream release | Workflow/runbook static gates and manual approvals |
| No new feature mixed into migration | Source-vendoring evidence and reviewed diff |

## Execution Handoff

This plan is intentionally deferred. The next active operation is current live-provider conversation acceptance, not Task 1 above. Once that acceptance is recorded, execute this plan in an isolated worktree using superpowers:subagent-driven-development or superpowers:executing-plans, with a review checkpoint after every task and separate approval before publication or product-image lock change.
