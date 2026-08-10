# Hermes upstream synchronization

This runbook updates the vendored Hermes source without replacing Core-Agent's
product boundaries. It is an operator-run intake procedure, not a dependency
bot or release workflow. The synchronization pull request must not automatically
publish an image and must not automatically commit
`infra/hermes/product-images.lock.json`.

Use anonymous synthetic fixtures only. Do not place provider credentials,
customer or student content, private Profile data, or raw upstream responses in
commands, commits, test output, or review notes.

## Authority and inputs

The only accepted upstream is
`https://github.com/NousResearch/hermes-agent.git`, configured as
`hermes-upstream`. An operator selects one reviewed release tag and records its
exact commit and tree. Never use an unpinned `latest` build, a branch tip, or a
direct pull from upstream `main` or `master`.

In the command block below, replace `vYYYY.MM.DD` with the real candidate tag.
The explicit guard and source-lock generator both reject the literal example.
Run the complete procedure from a normal Core-Agent checkout with Git, Node.js,
npm, uv, Docker Buildx, and the repository's integration-test dependencies.

```bash
UPSTREAM_TAG=vYYYY.MM.DD
test "$UPSTREAM_TAG" != vYYYY.MM.DD
[[ "$UPSTREAM_TAG" =~ ^v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$ ]]
UPSTREAM_REF="refs/tags/${UPSTREAM_TAG}"

git switch main
git pull --ff-only origin main
test -z "$(git status --short)"
git switch -c "chore/hermes-upstream-${UPSTREAM_TAG}"

test "$(git remote get-url hermes-upstream)" = "https://github.com/NousResearch/hermes-agent.git"
git fetch --no-tags hermes-upstream "$UPSTREAM_REF"
UPSTREAM_COMMIT="$(git rev-parse 'FETCH_HEAD^{commit}')"
UPSTREAM_TREE="$(git rev-parse 'FETCH_HEAD^{tree}')"
test "${#UPSTREAM_COMMIT}" -eq 40
test "${#UPSTREAM_TREE}" -eq 40
case "$UPSTREAM_COMMIT$UPSTREAM_TREE" in
  *[!0-9a-f]*) exit 1 ;;
esac
```

Record the tag, commit, and tree in the pull-request description. Do not record
the contents of any source or runtime secret.

## Import and lock the candidate

The subtree pull creates the upstream intake boundary. Do not replace
`third_party/hermes-agent` by copying a release archive, and do not use a nested
Git checkout or submodule.

```bash
git subtree pull --prefix=third_party/hermes-agent hermes-upstream "$UPSTREAM_COMMIT" --squash

node scripts/generate-hermes-source-lock.mjs \
  --upstream-ref "$UPSTREAM_REF" \
  --upstream-commit "$UPSTREAM_COMMIT"
npm run hermes:source:verify

forbidden="$(
  git ls-files -- third_party/hermes-agent \
    | LC_ALL=C grep -E '(^|/)(\.git|\.venv|venv|node_modules|__pycache__|\.pytest_cache|\.env)(/|$)|\.(pem|key|p12|pfx)$' \
    || true
)"
test -z "$forbidden"

git diff --check
git diff --stat main -- third_party/hermes-agent infra/hermes/upstream-source.lock.json
git diff main -- third_party/hermes-agent infra/hermes/upstream-source.lock.json
```

The generated lock must name the selected tag and exact commit, reproduce
`UPSTREAM_TREE`, retain the MIT license digest, and bind the post-merge product
tree. Any mismatch rejects the candidate; never edit the lock by hand.

## Seam-by-seam downstream review

Review the upstream diff and our downstream changes as separate evidence. The
pull request must contain a short note for every seam below, even when the result
is "no change":

- **prompt identity and SOUL/Profile behavior** — confirm Core-Agent remains the
  product identity and no upstream prompt exposes Hermes as the user-facing
  product.
- **gateway streaming and errors** — compare SSE framing, partial completion,
  terminal envelopes, and the closed Core-Agent error projection.
- **Profile lifecycle** — verify creation, reconciliation, deletion, tenant
  ownership, and the B2B multi-Profile versus B2C single-Profile rules.
- **memory consent and ACL** — inspect memory reads/writes, company-advisor and
  student memory separation, consent, retention, and authorization checks.
- **plugin, tool, Skill, MCP, and Policy hooks** — enumerate new or changed
  execution hooks and prove unpurchased capabilities stay unavailable.
- **provider redaction** — confirm credentials, provider bodies, URLs, headers,
  model diagnostics, and hidden reasoning cannot cross the public boundary.
- **Docker, user, filesystem, and network** — recheck the non-root user, fixed
  entrypoint, volume ownership, secret mounts, private backplane, and bounded
  egress.
- **Python and Node locks** — review `pyproject.toml`, `uv.lock`, every
  `package.json`, and every npm lock change for supply-chain and runtime impact.
- **license notices** — retain the upstream MIT notice and identify every added,
  removed, or changed third-party notice.

Attach paths, commit identities, test names, and bounded final states. Do not
paste prompts, conversations, credentials, or provider response content.

## Conflict and candidate rejection rules

Reject an upstream candidate that requires weakening any of these boundaries:

- tenant isolation or Profile ownership;
- SecretStore purpose separation or credential redaction;
- closed error projection or the versioned public protocol;
- non-root execution, immutable images, filesystem ownership, or network
  isolation;
- human approval for writes or other consequential external actions.

Never select the whole all-upstream or all-downstream side mechanically. Each
logical conflict and each downstream reapplication requires a focused commit and
test. If a conflict cannot be isolated and explained, abort the subtree pull and
reject or split the candidate instead of weakening a product boundary.

## Upstream and Core-Agent gates

First run the new tag's own pinned upstream CI commands. The accepted baseline
uses the following dependency and test surface; if upstream changes its workflow,
review that change and update this block in a focused runbook commit before
acceptance.

```bash
(
  cd third_party/hermes-agent
  uv sync --locked --python 3.11 \
    --extra all --extra dev --extra anthropic --extra mistral \
    --extra fal --extra modal --extra daytona --extra hindsight \
    --extra parallel-web
  HERMES_DISABLE_LAZY_INSTALLS=1 uv run scripts/run_tests.sh
  uv run ruff check .
  npm ci
  npm run check
)

npm run hermes:source:verify
npm run check
npm test
npm run test:postgres
npm run test:integration
```

All commands must pass from a clean candidate branch. A skipped or unavailable
gate is a recorded blocker, not an implicit pass.

## Two-platform candidate and live acceptance

Build the exact candidate for both supported Linux platforms without changing
the accepted product lock. Local tags are disposable evidence and are never
runtime release authority.

```bash
npm run hermes:build -- \
  --platform linux/amd64 \
  --tag core-agent/hermes-runtime:upstream-candidate-amd64
npm run hermes:build -- \
  --platform linux/arm64 \
  --tag core-agent/hermes-runtime:upstream-candidate-arm64
```

Run deterministic, synthetic, browser, and live-provider acceptance using the
procedures linked from
[the source-vendoring evidence record](../testing/hermes-source-vendoring.md)
and [the local smoke guide](runtime-v1-local-smoke.md). Record only identities,
counts, final states, and pass/fail results. Any regression in Profile routing,
streaming, error projection, cleanup, memory authorization, or the Web
conversation rejects the candidate.

## Manual publication and lock review

Merge the synchronization pull request only after its review gates pass. Image
publication is a separate approval after the accepted commit is reachable from
`main`. An authorized operator manually dispatches **Publish Hermes Runtime**
with a new canonical version and the full accepted Core-Agent commit. The
workflow must build `linux/amd64` and `linux/arm64`; it uploads a candidate
`product-images.lock.json` and does not commit it.

Before any lock change, verify that GHCR remains private, both registry digests
match the candidate artifact, the Core-Agent and upstream revision labels are
exact, and the version and commit tags resolve to one reviewed manifest. Compare
the candidate `product-images.lock.json` byte-for-byte with the accepted lock.
The upstream synchronization branch must not automatically commit
`product-images.lock.json`; lock acceptance is a separate reviewed release
commit under Task 8.

## Rollback and evidence

Before cutover, record the previously accepted product digest from the current
lock as the rollback point. A rollback selects that immutable digest and must
increment the Runtime generation; it never retags a mutable name. Preserve
PostgreSQL truth, tenant volumes, and redacted evidence. Follow
[the production boundary](runtime-v1-production-boundary.md#rollback) for code,
schema, resource-adoption, and data-preservation rules.

The synchronization pull request is complete only when it contains the upstream
tag/commit/tree, the regenerated source lock, the seam review, exact gate results,
two-platform build evidence, live acceptance result, and an explicit statement
that publication and product-lock acceptance remain separate manual actions.
