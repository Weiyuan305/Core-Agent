# Hermes Runtime Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Core-Agent Hermes product image to private GHCR for amd64 and arm64 and produce a deterministic, reviewed, immutable product-image lock.

**Architecture:** A pure Node.js helper validates release identity, maps OCI manifest descriptors to the two supported platforms, compares an existing tag without overwriting it, and serializes the current `ManagedImageLock` shape. A manually dispatched, commit-pinned GitHub Actions workflow builds platform images by digest, assembles the two approved tags, re-reads the registry manifest, and uploads a candidate lock without modifying the repository.

**Tech Stack:** Node.js 22.13.0, Node test runner, YAML, Docker Buildx, GHCR, GitHub Actions.

## Global Constraints

- Registry is exactly `ghcr.io/weiyuan305/core-agent-hermes-runtime` and remains private.
- First release is exactly `v0.1.0`; no implementation creates or accepts `latest`.
- Supported platforms are exactly `linux/amd64` and `linux/arm64`.
- The workflow is `workflow_dispatch` only and builds a full commit reachable from `origin/main`.
- GitHub workflow permissions are exactly `contents: read` and `packages: write`.
- Every third-party Action is pinned to a full 40-character commit SHA.
- The workflow never commits the candidate lock and never receives a user-supplied registry credential.
- Repository files, workflow logs, artifacts, and `.env.runtime` contain no credential bytes.

---

### Task 1: Deterministic product-lock generator

**Files:**
- Create: `scripts/generate-hermes-product-lock.mjs`
- Create: `tests/runtime/hermes-release.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateReleaseVersion(value: unknown): string`
- Produces: `validateSourceCommit(value: unknown): string`
- Produces: `parsePlatformManifest(value: unknown): Readonly<Record<"linux/amd64" | "linux/arm64", string>>`
- Produces: `createProductImageLock(input): ManagedImageLock-shaped plain object`
- Produces: `serializeProductImageLock(lock): string`
- Produces: `assertCompatibleExistingManifest(lock, existingManifest): void`
- CLI validation: `node scripts/generate-hermes-product-lock.mjs --validate-release --version v0.1.0 --source-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- CLI candidate: `node scripts/generate-hermes-product-lock.mjs --repository ghcr.io/weiyuan305/core-agent-hermes-runtime --version v0.1.0 --source-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --amd64-digest sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --arm64-digest sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --output /tmp/core-agent-hermes-product-images.lock.json`
- CLI verification adds `--existing-manifest /tmp/core-agent-existing-manifest.json` or `--published-manifest /tmp/core-agent-published-manifest.json` and requires its platform digests to equal the candidate before writing output.

- [ ] **Step 1: Write failing version and commit validation tests**

Add tests that import the missing helper and assert:

```js
assert.equal(validateReleaseVersion("v0.1.0"), "v0.1.0");
assert.equal(validateSourceCommit("a".repeat(40)), "a".repeat(40));
for (const value of ["latest", "0.1.0", "v01.0.0", "v0.1", "v0.1.0-rc.1", "v0.1.0\n"]) {
  assert.throws(() => validateReleaseVersion(value), /RELEASE_VERSION_INVALID/);
}
for (const value of ["a".repeat(39), "A".repeat(40), "g".repeat(40), "main"]) {
  assert.throws(() => validateSourceCommit(value), /RELEASE_SOURCE_COMMIT_INVALID/);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/runtime/hermes-release.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/generate-hermes-product-lock.mjs`.

- [ ] **Step 3: Implement closed version and source validators**

Implement data-property-only validation with these exact patterns:

```js
const versionPattern = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const sourceCommitPattern = /^[a-f0-9]{40}$/u;

export function validateReleaseVersion(value) {
  if (typeof value !== "string" || !versionPattern.test(value) || value === "latest") {
    throw new ReleaseError("RELEASE_VERSION_INVALID");
  }
  return value;
}

export function validateSourceCommit(value) {
  if (typeof value !== "string" || !sourceCommitPattern.test(value)) {
    throw new ReleaseError("RELEASE_SOURCE_COMMIT_INVALID");
  }
  return value;
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `node --test tests/runtime/hermes-release.test.mjs`

Expected: PASS.

Commit: `test(release): validate Hermes release identity`

- [ ] **Step 5: Write failing manifest and deterministic-lock tests**

Construct an OCI image-index fixture with exactly two descriptors:

```js
const manifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { digest: `sha256:${"a".repeat(64)}`, platform: { os: "linux", architecture: "amd64" } },
    { digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "arm64" } },
  ],
};
const platformDigests = parsePlatformManifest(manifest);
const lock = createProductImageLock({
  repository: "ghcr.io/weiyuan305/core-agent-hermes-runtime",
  version: "v0.1.0",
  sourceCommit: "c".repeat(40),
  platformDigests,
});
assert.deepEqual(lock.platforms, {
  "linux/amd64": { reference: `ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.0@sha256:${"a".repeat(64)}` },
  "linux/arm64": { reference: `ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.0@sha256:${"b".repeat(64)}` },
});
assert.equal(serializeProductImageLock(lock), `${JSON.stringify(lock, null, 2)}\n`);
```

Add rejection cases for duplicate platforms, a missing platform, Windows, an unknown architecture, malformed digest, extra descriptor fields implemented as accessors, wrong repository, and an existing manifest whose digest differs.

- [ ] **Step 6: Run focused test and verify RED**

Run: `node --test tests/runtime/hermes-release.test.mjs`

Expected: FAIL because the manifest functions are not exported.

- [ ] **Step 7: Implement exact OCI manifest parsing and lock serialization**

Implement these invariants:

```js
const productRepository = "ghcr.io/weiyuan305/core-agent-hermes-runtime";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const supportedPlatforms = Object.freeze(["linux/amd64", "linux/arm64"]);
```

`parsePlatformManifest()` must require one plain object with own enumerable data
properties `schemaVersion`, `mediaType`, and `manifests`; accept OCI index or Docker
manifest-list media types; require exactly two plain descriptor objects; map only
`linux/amd64` and `linux/arm64`; and return a deeply frozen object. The serializer must
emit the fixed key order shown in the design and one trailing newline.

The CLI must support validation-only, digest-candidate, existing-manifest comparison, and
published-manifest verification modes. It must open each manifest with
`O_RDONLY | O_NOFOLLOW`, bound it to 1 MiB, parse it with fatal UTF-8, write the output
using `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`
with mode `0600`, `sync()`, and never echo file content on failure.

- [ ] **Step 8: Verify helper, CLI failure bounds, and current consumers**

Run:

```bash
node --test tests/runtime/hermes-release.test.mjs
npm run build -w @core-agent/runtime-core
```

In the test, feed the generated object into `loadRuntimeImageLock()` and
`validateProductImageLock()` and require both to return the arm64 reference.

Expected: all focused tests PASS.

- [ ] **Step 9: Add the release-lock script and commit**

Add:

```json
"hermes:product-lock": "node scripts/generate-hermes-product-lock.mjs"
```

Commit: `feat(release): generate immutable Hermes product lock`

---

### Task 2: Manual private GHCR release workflow

**Files:**
- Create: `.github/workflows/publish-hermes-runtime.yml`
- Modify: `tests/runtime/hermes-release.test.mjs`

**Interfaces:**
- Consumes: `scripts/generate-hermes-product-lock.mjs`
- Produces: private GHCR tags `v0.1.0` and `sha-<12-hex>`
- Produces: artifact `hermes-product-image-lock-v0.1.0/product-images.lock.json`

- [ ] **Step 1: Write failing workflow contract tests**

Parse YAML with the existing `yaml` package and assert:

```js
assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
assert.deepEqual(workflow.permissions, { contents: "read", packages: "write" });
assert.deepEqual(workflow.jobs.build.strategy.matrix.platform, ["linux/amd64", "linux/arm64"]);
assert.equal(workflow.env.IMAGE_NAME, "ghcr.io/weiyuan305/core-agent-hermes-runtime");
```

Scan every `uses` value with
`/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/iu`, reject any `latest`, and require the
artifact name expression to begin with `hermes-product-image-lock-`.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --test tests/runtime/hermes-release.test.mjs`

Expected: FAIL with `ENOENT` for `.github/workflows/publish-hermes-runtime.yml`.

- [ ] **Step 3: Implement manual workflow and pinned Actions**

Use these exact Action commits:

```text
actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8
docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c
docker/login-action@dbcb813823bdd20940b903addbd779551569679f
docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
```

The jobs are:

1. `validate`: check out `source_commit`, fetch `origin/main`, validate both inputs with
   the Node helper, and require `git merge-base --is-ancestor "$SOURCE_COMMIT" origin/main`.
2. `build`: matrix-build one platform with its exact base lock reference and
   `push-by-digest=true,name-canonical=true,push=true`; upload a digest text artifact
   named by the normalized platform.
3. `publish`: download both digest artifacts, generate a candidate lock from those exact
   digests, inspect an existing version tag when present, compare its platform manifest
   through `--existing-manifest`, reject mismatch, create both tags only for a new
   version, inspect both final tag manifests through `--published-manifest`, generate
   `product-images.lock.json`, and upload it.

Every shell step uses `set -euo pipefail`, quoted values, fixed command names, and no
`pull_request_target`, `repository_dispatch`, untrusted shell interpolation, or broad
write permission.

- [ ] **Step 4: Verify workflow contracts and Compose/runtime gates**

Run:

```bash
node --test tests/runtime/hermes-release.test.mjs
npm run test:runtime
```

Expected: all tests PASS.

- [ ] **Step 5: Commit workflow**

Commit: `feat(release): publish private Hermes runtime images`

---

### Task 3: Release operations documentation and deterministic gates

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/runtime-v1-local-smoke.md`
- Modify: `.env.runtime.example`
- Modify: `tests/runtime/hermes-release.test.mjs`

**Interfaces:**
- Documents the exact manual workflow, artifact review, private pull, and lock location.

- [ ] **Step 1: Add failing documentation assertions**

Require the docs to contain:

```text
Publish Hermes Runtime
ghcr.io/weiyuan305/core-agent-hermes-runtime
infra/hermes/product-images.lock.json
read:packages
docker login ghcr.io
v0.1.0@sha256:
```

Require `.env.runtime.example` to default the path-only setting to the absolute reviewed
lock selected by the operator and continue rejecting any token/key value.

- [ ] **Step 2: Run focused test and verify RED**

Run: `node --test tests/runtime/hermes-release.test.mjs`

Expected: FAIL on the first missing documentation marker.

- [ ] **Step 3: Document the exact private release procedure**

Document these operator steps without embedding token values:

```bash
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username Weiyuan305 --password-stdin
docker pull "$(node scripts/resolve-hermes-image.mjs --lock infra/hermes/product-images.lock.json --platform linux/arm64)"
```

The runbook must instruct the operator to enter the token only in a private shell, unset
it immediately, review the Actions run source commit, download the candidate artifact,
compare both GHCR platform digests, and commit the unchanged lock before smoke. It must
state that local `core-agent/hermes-runtime:dev` is not AC10 evidence.

- [ ] **Step 4: Run all deterministic gates**

Run:

```bash
npm test
npm run check
node scripts/verify-no-secret.mjs synthetic-release-plan-sentinel-v1
git diff --check
```

Expected: all commands exit 0 with no sentinel output.

- [ ] **Step 5: Commit documentation**

Commit: `docs(release): document private Hermes image review`

---

### Task 4: Publish and accept the reviewed v0.1.0 lock

**Files:**
- Create after artifact review: `infra/hermes/product-images.lock.json`
- Modify after a real run: `docs/operations/runtime-v1-acceptance-evidence.md`

**Interfaces:**
- Consumes the merged workflow on `main` and its candidate artifact.
- Produces the repository-reviewed immutable product lock used by the chat plan.

- [ ] **Step 1: Merge and push the implementation before dispatch**

Use the finishing-development-branch workflow. The workflow file must exist on the
default branch before manual dispatch.

- [ ] **Step 2: Dispatch the exact first release**

After `gh auth login` is completed by the user, run:

```bash
gh workflow run publish-hermes-runtime.yml --repo Weiyuan305/Core-Agent --ref main -f version=v0.1.0 -f source_commit="$(git rev-parse origin/main)"
```

Expected: one successful workflow run with private package publication and one lock
artifact.

- [ ] **Step 3: Download and review the candidate lock**

Run `gh run download` for the successful run into a fresh `mktemp -d` directory. Compare
the artifact repository, tag, amd64 digest, and arm64 digest against
`docker buildx imagetools inspect` for the private version tag. Never display registry
credentials.

- [ ] **Step 4: Commit the reviewed lock unchanged**

Copy only `product-images.lock.json` to `infra/hermes/product-images.lock.json`, run the
focused lock tests plus `git diff --check`, and commit:

```text
chore(release): lock Hermes runtime v0.1.0
```

- [ ] **Step 5: Continue to the interactive-chat plan**

The release subproject is complete when the committed lock references the private
`v0.1.0` tag by both platform RepoDigests and the arm64 reference pulls successfully in
the selected Colima context.
