# Hermes Runtime Release and Interactive Chat Design

**Status:** Approved for implementation planning  
**Date:** 2026-08-06  
**First release:** `v0.1.0`

## 1. Purpose

Package the Core-Agent Hermes distribution as a private, immutable, multi-platform
product image and prove the complete Control Plane conversation path before any MCP,
business Skill, or long-term memory integration begins.

The milestone has two separate user journeys:

1. a strict real-runtime acceptance smoke whose output remains an allowlist of
   non-sensitive evidence; and
2. an interactive terminal client for synthetic multi-turn conversation through the
   Control Plane.

Both journeys use the same managed Runtime lifecycle. Neither may bypass the Control
Plane to call Hermes directly.

## 2. Scope

### 2.1 Included

- A manually dispatched GitHub Actions workflow that publishes the Core-Agent Hermes
  product image to private GHCR.
- Separate `linux/amd64` and `linux/arm64` builds derived from the existing pinned
  Hermes base-image lock.
- Immutable `v0.1.0` and source-commit tags, with no `latest` tag.
- A deterministic candidate `ManagedImageLock` artifact containing the two platform
  RepoDigests.
- A reviewed product lock at `infra/hermes/product-images.lock.json`.
- A reusable managed synthetic Runtime session boundary shared by the strict smoke and
  interactive chat client.
- An interactive terminal client that supports multi-turn input, a fresh Conversation,
  exact API/Worker restart, normal exit, and explicit runtime retention.
- Automated static, unit, integration-seam, security, and cleanup tests.
- A Colima arm64 runbook for real image pull, AC10 smoke, interactive chat, restart,
  context-isolation, and cleanup evidence.

### 2.2 Excluded

- MCP Gateway, MCP Server, business Tools, and domain Skills.
- Entitlement-driven capability installation.
- Long-term company, consultant, or student memory.
- Web, macOS, iOS, or other graphical clients.
- Customer or student data.
- Kubernetes, multi-node scheduling, or production rollout automation.
- Automatic GHCR publication on ordinary branch or `main` pushes.

## 3. Release Architecture

### 3.1 Registry and visibility

The product repository is:

```text
ghcr.io/weiyuan305/core-agent-hermes-runtime
```

The package remains private. GitHub Actions publishes with the repository-scoped
`GITHUB_TOKEN`; the workflow receives only `contents: read` and `packages: write`.
Local Docker authenticates through its credential store with a credential limited to
`read:packages`. The repository, scripts, and `.env.runtime` never accept or store a
GitHub token.

### 3.2 Trigger and source authority

`.github/workflows/publish-hermes-runtime.yml` is `workflow_dispatch` only. Its inputs
are:

- `version`, initially `v0.1.0`, matching `^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$`; and
- `source_commit`, a full 40-character lowercase commit already reachable from
  `refs/heads/main`.

The workflow checks out the exact source commit, not the mutable branch head. A source
commit that is absent from `main` fails before registry authentication or build.

### 3.3 Image construction

The workflow builds `infra/hermes/Dockerfile` once for each supported platform. Each
job resolves `HERMES_BASE_IMAGE` from the matching entry in
`infra/hermes/base-images.lock.json`; it never uses a floating Hermes image.

The release publishes:

```text
ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.0
ghcr.io/weiyuan305/core-agent-hermes-runtime:sha-<first-12-source-commit-characters>
```

Both tags identify the same multi-platform image. No workflow or script creates or
accepts `latest`.

The workflow refuses to replace an existing version whose platform manifest digests
differ from the candidate. An idempotent rerun is permitted only when the existing
amd64 and arm64 digests exactly match the candidate.

### 3.4 Candidate and reviewed image locks

After both platform images exist, a final job queries GHCR rather than trusting only
build-step outputs. It verifies the platform manifest and generates this exact shape:

```json
{
  "schemaVersion": 1,
  "repository": "ghcr.io/weiyuan305/core-agent-hermes-runtime",
  "tag": "v0.1.0",
  "platforms": {
    "linux/amd64": {
      "reference": "ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.0@sha256:<64-lowercase-hex>"
    },
    "linux/arm64": {
      "reference": "ghcr.io/weiyuan305/core-agent-hermes-runtime:v0.1.0@sha256:<64-lowercase-hex>"
    }
  }
}
```

The candidate is uploaded as `hermes-product-image-lock-v0.1.0`; the workflow does not
write to the repository. An operator reviews the source commit, repository, tag, two
platform digests, and GHCR manifest before committing the bytes unchanged as
`infra/hermes/product-images.lock.json`.

`scripts/generate-hermes-product-lock.mjs` owns version validation, manifest parsing,
deterministic JSON serialization, and collision comparison. The generated lock must be
accepted by both `loadRuntimeImageLock()` and the existing real-smoke product-lock
validator before upload.

## 4. Managed Runtime Session Boundary

### 4.1 Responsibility

`scripts/lib/managed-runtime-session.mjs` becomes the single lifecycle boundary used
by real acceptance and interactive chat. It owns:

- environment and local Unix Docker-context validation;
- immutable base/product image validation;
- runtime network and protected-path preflight;
- stable product-lock snapshot staging;
- protected bootstrap, provider, and ingress secret reads;
- exact Compose topology start and readiness;
- synthetic Tenant/Profile/Runtime provisioning;
- Conversation and Agent Run requests;
- bounded SSE consumption;
- exact Runtime deletion, container-absence proof, Compose shutdown, snapshot cleanup,
  and secret-buffer zeroization.

It exposes operations, not terminal policy. It does not read stdin or print assistant
content. Its callers decide whether deltas are retained, displayed, or discarded.

### 4.2 Strict smoke compatibility

`scripts/smoke-control-plane.mjs` uses the shared session without changing its public
contract:

- the fixed prompt remains `synthetic-runtime-v1-smoke`;
- opt-in still requires `CORE_AGENT_REAL_HERMES_SMOKE=1`;
- stdout remains one JSON object with the existing `SMOKE_OUTPUT_KEYS` and no assistant
  text;
- stderr remains fixed stage/error codes;
- database and managed-container secret scans remain mandatory;
- default and `--keep-runtime` cleanup semantics remain unchanged.

Refactoring is accepted only if all current runtime-contract tests remain green and new
compatibility tests prove byte-for-byte equivalent successful output shape and argument
behavior.

## 5. Interactive Terminal Client

### 5.1 Command and modes

The root package adds:

```text
npm run chat:control-plane
npm run chat:control-plane -- --keep-runtime
```

The default command owns one managed synthetic session and cleans it on exit. The
explicit `--keep-runtime` mode retains the running topology, managed Hermes Runtime, and
product-lock snapshot after releasing all secret buffers held by the client process.

The client accepts no customer-supplied Tenant, Profile, Runtime, image, provider,
command, or Compose project identifiers. All resource identities are generated with the
existing `synthetic-runtime-v1-*` policy.

### 5.2 Conversation flow

After the Runtime reaches `ready`, the client creates one Conversation. Each non-command
line:

1. is checked for 1–4000 characters, valid UTF-8 text, and absence of C0/DEL control
   characters other than the terminal newline consumed by the reader;
2. creates a new Agent Run through
   `POST /internal/v1/conversations/:conversation_id/runs`;
3. consumes the Conversation SSE endpoint;
4. displays only assistant deltas belonging to that Run; and
5. waits for `run.completed` or reports a fixed failure code.

The Control Plane continues to send one stable Hermes session reference for all Runs in
the same Conversation. The client never reconstructs or submits prior messages itself.

Supported terminal commands are:

- `/new`: create a new Conversation with a distinct session reference;
- `/restart`: recreate only the exact Compose `api` and `worker` services, wait for
  `/health/ready`, then continue the current Conversation;
- `/exit`: end input and run default cleanup unless `--keep-runtime` was selected.

EOF is equivalent to `/exit`. `SIGINT` and `SIGTERM` abort current network work and then
enter the same bounded cleanup path.

### 5.3 Terminal and transcript policy

Assistant text is written only to the current stdout terminal. User text is read only
from stdin. Neither is written to log records, acceptance evidence, files, process
arguments, environment variables, GitHub artifacts, or error summaries.

The client displays a fixed warning that only anonymous synthetic prompts are allowed.
The first milestone does not attempt content classification; use with real personal or
customer data is prohibited operationally.

## 6. Failure and Cleanup Semantics

### 6.1 Bounded public errors

Release and runtime failures expose stable codes and identifiers only. Provider response
bodies, response headers, Docker JSON, database rows, raw exceptions, credentials, and
secret paths never reach public errors or chat output.

One failed Agent Run does not silently retry after Hermes dispatch. The client reports
the Run's terminal status and permits another explicit user input only when the managed
Runtime remains healthy.

### 6.2 Default cleanup

Default cleanup executes all steps even when an earlier step fails, while preserving the
first error:

1. request exact managed Runtime deletion;
2. wait for the exact labeled Hermes container to disappear;
3. prove the expected managed data volume remains;
4. run exact-project `docker compose down --remove-orphans` without `--volumes`;
5. remove the staged product-lock snapshot;
6. zero bootstrap, provider, and ingress buffers.

The cleanup never selects resources using only a broad label and never removes the
PostgreSQL or Hermes data volumes. An exception cannot implicitly convert default cleanup
into `--keep-runtime`.

### 6.3 Retained-runtime cleanup

When `--keep-runtime` succeeds after topology ownership, the client retains services,
the managed Runtime, and its product-lock snapshot but zeroes its in-process secret
buffers. Before releasing those buffers it atomically writes one owner-only `0600`
retained-runtime receipt beneath the configured Supervisor state root. The receipt has a
closed schema containing only the exact Compose project and synthetic Tenant, Profile,
Runtime, and lock-snapshot identifiers; it contains no credential, path supplied by a
model, prompt, response, or provider content. Receipt creation uses `O_EXCL`, and failure
to create a uniquely owned receipt falls back to default cleanup rather than leaving an
unmanageable Runtime.

The operations guide provides `npm run chat:cleanup` as the only retained-runtime
cleanup command. It accepts no identifiers or paths from argv, securely reads and
revalidates the receipt and configured environment, performs exact deletion and
shutdown, removes the snapshot and receipt, and zeroes its bootstrap material. It never
offers wildcard deletion or `docker system prune`.

## 7. Test Strategy

### 7.1 Workflow and release tests

`tests/runtime/hermes-release.test.mjs` parses the workflow and release helper to prove:

- `workflow_dispatch` is the only trigger;
- permissions are exactly `contents: read` and `packages: write`;
- Actions use full commit SHAs;
- the platforms are exactly `linux/amd64` and `linux/arm64`;
- neither workflow nor helper contains a `latest` release path;
- version/source-commit validation fails closed;
- missing, duplicate, malformed, or mismatched platform manifests are rejected;
- a different existing version digest is a collision;
- serialization is deterministic; and
- the candidate passes both current ManagedImageLock consumers.

### 7.2 Session and chat tests

`tests/runtime/chat-control-plane.test.mjs` and focused shared-session tests use injected
HTTP, SSE, child-process, clock, signal, stdin, and stdout seams. They prove:

- split UTF-8 SSE deltas are displayed in order;
- multiple Runs retain one Conversation session identity;
- `/new` changes the Conversation and session identity;
- `/restart` targets only `api` and `worker`, then waits for readiness;
- empty, overlong, and control-character input never creates a Run;
- `/exit`, EOF, `SIGINT`, `SIGTERM`, transport failure, and terminal Run failure enter
  the specified cleanup path;
- all cleanup steps run after an earlier cleanup failure and the first failure wins;
- `--keep-runtime` never deletes owned resources but still zeroes secrets; and
- secrets, provider bodies, raw errors, and transcript content are absent from bounded
  diagnostics.

Existing `tests/runtime/runtime-contract.test.mjs` remains authoritative for the strict
smoke's public contract. The complete `npm test` and `npm run check` gates must pass.

### 7.3 Real acceptance

The Colima arm64 acceptance uses the reviewed arm64 digest and anonymous inputs only. It
must demonstrate:

1. private GHCR pull by digest;
2. successful Tenant, Profile, and Runtime provisioning;
3. a non-empty streamed first response;
4. a same-Conversation follow-up that uses the same Hermes session reference;
5. `/new` creating a distinct Conversation/session reference;
6. `/restart` preserving PostgreSQL Conversation, Run, and Message records and allowing
   the current Conversation to continue;
7. MCP and long-term memory plugins remaining disabled; and
8. default cleanup leaving no running managed container and no secret in the bounded
   database/image/log evidence scans.

The evidence record contains only platform, source commit, image references/digests,
timestamp, synthetic resource IDs, final states, event types, restart result, cleanup
result, and assistant-message counts. It never contains prompts, responses, credentials,
raw dependency output, or personal data.

## 8. Documentation and Traceability

- Update `docs/operations/runtime-v1-local-smoke.md` with private GHCR login, candidate
  lock review, interactive chat, restart, and retained-runtime cleanup procedures.
- Update `docs/operations/runtime-v1-acceptance-evidence.md` only after a real gate runs;
  do not convert pending criteria from tests alone.
- Update `README.md` to distinguish the strict smoke from the interactive synthetic
  client.
- Record the workflow run URL, source commit, reviewed lock commit, and real acceptance
  timestamp without including secrets or transcript content.

## 9. Acceptance Boundary

This milestone is complete only when the release workflow, deterministic lock,
refactored strict smoke, terminal client, complete automated gates, and one real Colima
arm64 acceptance all pass. Image publication alone is not completion. A successful
direct Hermes call that bypasses the Control Plane is not evidence. MCP work begins only
after this milestone is accepted.
