# Conversation Reliability v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve precise, durable Agent Run failure semantics from the managed Hermes gateway to the Web transcript, while exposing only calm public reasons and an idempotent explicit retry to users.

**Architecture:** Add one closed internal failure vocabulary to Contracts and Agent Run persistence. The managed Hermes product image projects provider failures into a strict allowlisted terminal frame; Runtime Core validates and classifies it; Worker persists the code and emits it in `run.failed`; the Client Gateway maps it to a smaller public reason and owns child-Run retry admission; Web renders localized partial or zero-content states without technical details.

**Tech Stack:** TypeScript 5, TypeBox, Node test runner, Kysely/PostgreSQL, React 19, Vite, Vitest, Playwright, Python 3 standard library for the pinned Hermes overlay, Docker BuildKit.

## Global Constraints

- Keep MCP, Skills, Identity, entitlements, billing, and long-term memory outside this milestone.
- Do not add automatic provider fallback or replay any Run automatically after dispatch.
- Never send internal codes, raw exception text, provider bodies, URLs, model names, credentials, or tracebacks to the Browser.
- Keep failed Agent Runs immutable. Explicit retry always creates one child Run with `parent_run_id` referencing the failed Run.
- Preserve old `run.failed` events by accepting an absent code as `RUN_FAILURE_UNKNOWN`; every new producer must write a code.
- Apply the Hermes change only to the pinned managed product image and fail its build when the expected upstream source no longer matches.
- Do not publish an image, change the published product-image lock, push commits, or deploy during this implementation without separate explicit approval. Local builds and tests are in scope.
- Use red-green-refactor for each behavior change and commit after each completed task.

---

### Task 1: Add the closed failure vocabulary to Contracts v0.4.0

**Files:**

- Create: `packages/contracts/src/runtime/failures.ts`
- Modify: `packages/contracts/src/runtime/resources.ts`
- Modify: `packages/contracts/src/events/product-event.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/registry.ts`
- Modify: `packages/contracts/tests/runtime.test.ts`
- Modify: `packages/contracts/tests/product-event.test.ts`
- Modify: `packages/contracts/package.json`
- Modify: `packages/contracts/CHANGELOG.md`
- Modify: `packages/contracts/compatibility-change.json`
- Create: `packages/contracts/compat/v1/releases/0.4.0/`
- Regenerate: `packages/contracts/compat/v1/*.schema.json`

- [ ] **Step 1: Write failing vocabulary and resource tests**

Add tests that accept every approved internal code and reject arbitrary strings. Cover a failed `AgentRun` with `failure_code`, a non-failed Run without it, and rejection of a succeeded Run carrying it.

```ts
const internalFailureCodes = [
  "MODEL_BUSY",
  "MODEL_SERVICE_UNAVAILABLE",
  "MODEL_RESPONSE_TIMEOUT",
  "MODEL_ACCESS_DENIED",
  "MODEL_NOT_AVAILABLE",
  "MODEL_RESPONSE_INVALID",
  "MODEL_STREAM_INTERRUPTED",
  "MODEL_EMPTY_RESPONSE",
  "AGENT_RUNTIME_NOT_READY",
  "RUN_INTERNAL_ERROR",
  "RUN_FAILURE_UNKNOWN",
] as const;
```

- [ ] **Step 2: Write failing ProductEvent compatibility tests**

Prove that a new `run.failed` event accepts `payload.code`, a legacy event without `code` still validates, and an unknown code is rejected. Also assert that `summary` remains optional and never replaces the code.

```ts
const failedPayload = {
  run_id: "run_01",
  status: "failed",
  code: "MODEL_SERVICE_UNAVAILABLE",
  summary: "Agent execution failed after dispatch",
};
```

- [ ] **Step 3: Run the focused tests and observe failure**

Run: `npm run test -w @core-agent/contracts -- --test-name-pattern='failure|run.failed'`

Expected: tests fail because `AgentRunFailureCodeSchema` and `payload.code` do not exist.

- [ ] **Step 4: Implement and export the vocabulary**

Define a TypeBox union and exported static type in `runtime/failures.ts`:

```ts
export const AgentRunFailureCodeSchema = Type.Union(
  AGENT_RUN_FAILURE_CODES.map((code) => Type.Literal(code)),
  { $id: "AgentRunFailureCode" },
);

export type AgentRunFailureCode = Static<typeof AgentRunFailureCodeSchema>;
```

Model the Agent Run terminal invariant as a union/intersection so `status: "failed"` requires `failure_code` and all other statuses forbid it. Add optional `code` only to the `run.failed` event branch for historical compatibility. Register and export the new schema.

- [ ] **Step 5: Release the additive contract snapshot**

Bump `@core-agent/contracts` and `CONTRACT_PACKAGE_VERSION` from `0.3.0` to `0.4.0`. Preserve the current live schemas under `compat/v1/releases/0.3.0`, generate the new live schemas, copy them to `releases/0.4.0`, and record the additive compatibility decision in the changelog and manifest.

Run: `npm run contracts:schemas`

- [ ] **Step 6: Verify the contract package**

Run: `npm run contracts:check`

Expected: build, tests, schema drift, fixtures, and compatibility checks pass.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add agent run failure vocabulary"
```

---

### Task 2: Persist failure codes and terminalize Runs structurally

**Files:**

- Create: `packages/runtime-core/migrations/009_agent_run_failure_code.sql`
- Modify: `packages/runtime-core/src/db/database.ts`
- Modify: `packages/runtime-core/src/repositories/run.ts`
- Modify: `packages/runtime-core/src/repositories/worker-agent-run.ts`
- Modify: `apps/control-plane-worker/src/handlers/execute-agent-run.ts`
- Modify: `packages/runtime-core/tests/migrations.test.ts`
- Modify: `packages/runtime-core/tests/agent-run-execution.test.ts`
- Modify: `apps/control-plane-worker/tests/execute-agent-run.test.ts`

- [ ] **Step 1: Write the failing migration tests**

Assert that migration `009`:

1. adds nullable `agent_runs.failure_code`;
2. backfills failed rows to `RUN_FAILURE_UNKNOWN`;
3. requires a code when `status = 'failed'`;
4. requires `NULL` for every other status;
5. leaves `failure_summary` unchanged.

The constraint must be equivalent to:

```sql
CHECK (
  (status = 'failed' AND failure_code IS NOT NULL)
  OR
  (status <> 'failed' AND failure_code IS NULL)
)
```

- [ ] **Step 2: Write failing repository and Worker tests**

Change the test port to accept structured failure input:

```ts
type AgentRunFailure = Readonly<{
  code: AgentRunFailureCode;
  summary: string;
}>;
```

Assert that `fail(job, failure)` atomically persists `failure_code`, preserves the redacted operator summary, and emits:

```ts
{
  event_type: "run.failed",
  payload: {
    run_id: job.runId,
    status: "failed",
    code: "MODEL_SERVICE_UNAVAILABLE",
    summary: "Agent execution failed after dispatch",
  },
}
```

Retain the existing tests proving that a post-dispatch error is not automatically replayed.

- [ ] **Step 3: Run focused tests and observe failure**

Run: `npm run test -w @core-agent/control-plane-worker -- --test-name-pattern='failed|replay'`

Run: `npm run build:runtime-deps && npm run test:postgres -w @core-agent/runtime-core -- --test-name-pattern='migration|failed'`

Expected: tests fail on the old `fail(job, summary)` interface and missing column.

- [ ] **Step 4: Add the migration and typed database field**

Apply the column, backfill, allowlist constraint, and terminal-state constraint in one migration. Extend Kysely's `agent_runs` row type with `failure_code: AgentRunFailureCode | null` and include the field in repository insert, select, and contract mapping.

- [ ] **Step 5: Implement structured terminalization**

Change the repository and Worker port to `fail(job, failure)`. The repository must select only the allowlisted code from the typed value; it may redact `summary`, but it must not derive the code from summary text. Use `RUN_INTERNAL_ERROR` for invariant/recovery failures with no more precise classification.

- [ ] **Step 6: Verify Worker and PostgreSQL behavior**

Run: `npm run check -w @core-agent/control-plane-worker`

Run: `npm run build:runtime-deps && npm run test:postgres -w @core-agent/runtime-core`

Expected: all Worker tests and runtime PostgreSQL suites pass.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime-core apps/control-plane-worker
git commit -m "feat(runtime): persist structured run failures"
```

---

### Task 3: Classify managed Hermes stream outcomes in Runtime Core

**Files:**

- Modify: `packages/runtime-core/src/hermes/client.ts`
- Modify: `packages/runtime-core/src/hermes/stream-parser.ts`
- Modify: `packages/runtime-core/src/index.ts`
- Modify: `packages/runtime-core/tests/hermes-client.test.ts`
- Modify: `apps/control-plane-worker/src/handlers/execute-agent-run.ts`
- Modify: `apps/control-plane-worker/tests/execute-agent-run.test.ts`

- [ ] **Step 1: Add a table-driven failing parser matrix**

For each managed terminal code, feed bounded SSE containing a terminal followed by `[DONE]` and assert the exact `AgentRunFailureCode`:

```ts
const managedHermesCases = [
  ["model_busy", "MODEL_BUSY"],
  ["model_service_unavailable", "MODEL_SERVICE_UNAVAILABLE"],
  ["model_response_timeout", "MODEL_RESPONSE_TIMEOUT"],
  ["model_access_denied", "MODEL_ACCESS_DENIED"],
  ["model_not_available", "MODEL_NOT_AVAILABLE"],
  ["model_response_invalid", "MODEL_RESPONSE_INVALID"],
] as const;
```

Also cover duplicate terminals, data after terminal, unknown `hermes` fields, missing `[DONE]`, contradictory flags, legacy `error.message`, generic Hermes errors, interrupted streams, and successful terminal output with no assistant text.

- [ ] **Step 2: Prove no raw provider text escapes**

Inject unique canary strings into legacy `error.message`, nested raw bodies, and arbitrary keys. Assert they appear in neither `HermesStreamError.message`, `cause`, serialized error, Worker summary, nor ProductEvent payload.

- [ ] **Step 3: Run focused tests and observe failure**

Run: `npm run test -w @core-agent/runtime-core -- --test-name-pattern='Hermes|managed|terminal|canary'`

Expected: managed error frames are currently ignored or collapsed into `EMPTY_ASSISTANT_OUTPUT`.

- [ ] **Step 4: Implement the exact managed terminal validator**

Accept only this shape:

```ts
type ManagedHermesTerminal = Readonly<{
  completed: false;
  partial: boolean;
  failed: true;
  error_code:
    | "model_busy"
    | "model_service_unavailable"
    | "model_response_timeout"
    | "model_access_denied"
    | "model_not_available"
    | "model_response_invalid";
  retryable: boolean;
}>;
```

`HermesStreamError` must carry `failureCode: AgentRunFailureCode` and `retryable: boolean` while keeping a fixed, non-sensitive message. Map legacy generic error frames to `MODEL_RESPONSE_INVALID`, premature end after a delta to `MODEL_STREAM_INTERRUPTED`, and a valid success terminal with zero text to `MODEL_EMPTY_RESPONSE`.

- [ ] **Step 5: Preserve dispatch safety in the Worker**

Catch `HermesStreamError` and pass its `failureCode` to structured terminalization. Use `retryable` only in the existing pre-dispatch bounded retry path. Once the job is marked `unsafe_to_replay`, terminalize and require explicit user retry.

- [ ] **Step 6: Verify Runtime Core and Worker**

Run: `npm run check -w @core-agent/runtime-core`

Run: `npm run check -w @core-agent/control-plane-worker`

Expected: parser matrix, redaction, timeout, replay-safety, and static gates pass.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime-core apps/control-plane-worker
git commit -m "feat(runtime): classify hermes terminal failures"
```

---

### Task 4: Add the pinned managed-Hermes error projection overlay

**Files:**

- Create: `infra/hermes/runtime/error_projection.py`
- Create: `infra/hermes/runtime/install_error_projection.py`
- Create: `infra/hermes/patches/v2026.7.30-gateway-error-projection.patch`
- Modify: `infra/hermes/Dockerfile`
- Create: `tests/runtime/hermes-error-projection.test.mjs`
- Modify: `tests/runtime/hermes-release.test.mjs`
- Create: `docs/adr/0010-managed-hermes-error-projection.md`
- Modify: `docs/runbooks/hermes-runtime-release.md`

- [ ] **Step 1: Capture and pin the exact upstream patch target**

Build or inspect the locally resolved `nousresearch/hermes-agent:v2026.7.30` source used by `infra/hermes/base-images.lock.json`. Record the exact relative gateway path and SHA-256 in `install_error_projection.py`. The installer must exit nonzero when the file is absent, its hash differs, or the patch has already drifted.

Do not use the unrelated local Hermes checkout as the patch source.

- [ ] **Step 2: Write failing pure projection tests**

Test the complete known mapping and unknown fallback without Docker. The only emitted error object is:

```py
{
    "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
    "hermes": {
        "completed": False,
        "partial": partial,
        "failed": True,
        "error_code": safe_code,
        "retryable": retryable,
    },
}
```

Assert exact keys recursively. Reject or discard raw `message`, body, URL, provider, model, credential, and traceback inputs.

- [ ] **Step 3: Run the runtime test and observe failure**

Run: `node --test tests/runtime/hermes-error-projection.test.mjs`

Expected: the projection module and installer do not exist.

- [ ] **Step 4: Implement the pure projection and exact overlay installer**

Map known Hermes/provider classifications to the six lowercase managed codes. Unknown exceptions become `model_response_invalid`. Patch only the `/v1/chat/completions` terminal projection and its safe classification token. Keep logs to fixed codes and bounded identifiers; never interpolate the exception string.

The Dockerfile copies the projection, installer, and patch, then runs the installer at build time. The patch is reviewable text; the installer performs the hash and exact-context gate before mutation.

- [ ] **Step 5: Document the plugin-first exception and rollback**

ADR 0010 must record why request-construction and generic post-LLM plugin hooks do not cover every abnormal provider terminal path, why the overlay is narrowly allowed, which upstream revision it targets, and that rollback selects the previous product-image digest.

- [ ] **Step 6: Verify the overlay and local product image**

Run: `npm run test:runtime`

Run: `npm run hermes:build -- --tag core-agent-hermes-runtime:conversation-reliability-local`

Run a local error-fixture smoke against the built image and assert the exact terminal record plus `[DONE]`. Do not publish the tag and do not change `infra/hermes/product-images.lock.json`.

- [ ] **Step 7: Commit**

```bash
git add infra/hermes tests/runtime docs/adr docs/runbooks/hermes-runtime-release.md
git commit -m "feat(hermes): project safe terminal failure codes"
```

---

### Task 5: Map public reasons and admit one idempotent child-Run retry

**Files:**

- Modify: `apps/control-plane-web/src/shared/protocol.ts`
- Create: `apps/control-plane-web/src/server/failure-reasons.ts`
- Create: `apps/control-plane-web/src/server/retry-store.ts`
- Modify: `apps/control-plane-web/src/server/runtime-chat-port.ts`
- Modify: `apps/control-plane-web/src/server/app.ts`
- Modify: `scripts/lib/managed-runtime-session.mjs`
- Modify: `apps/control-plane-web/tests/protocol.test.ts`
- Modify: `apps/control-plane-web/tests/runtime-chat-port.test.ts`
- Modify: `apps/control-plane-web/tests/app.test.ts`

- [ ] **Step 1: Write failing public mapping tests**

Define the closed public union:

```ts
export type ClientRunFailureReason =
  | "BUSY"
  | "TEMPORARILY_UNAVAILABLE"
  | "TOOK_TOO_LONG"
  | "SERVICE_UNAVAILABLE"
  | "REPLY_INTERRUPTED"
  | "NO_REPLY"
  | "ASSISTANT_PREPARING"
  | "UNKNOWN";
```

Test every internal-to-public mapping from the approved specification, absent/unknown code to `UNKNOWN`, exact frame parsing, and rejection of extra keys such as `code`, `message`, `run_id`, and `provider`.

- [ ] **Step 2: Write failing retry admission tests**

Cover:

1. `POST /client/v1/conversations/:id/retries` accepts an empty body only;
2. it uses the latest retryable failed Run stored server-side;
3. it sends the original server-side message and `parent_run_id`;
4. two concurrent clicks produce one child Run;
5. repeating after admission returns/streams the same child instead of creating another;
6. `SERVICE_UNAVAILABLE`, success, an in-flight Run, and an unknown Conversation reject retry without leaking internal IDs.

- [ ] **Step 3: Run focused Web tests and observe failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/protocol.test.ts tests/runtime-chat-port.test.ts tests/app.test.ts`

Expected: protocol still exposes `CLIENT_RUN_FAILED`, Runtime Chat loses the terminal code/run ID, and the retry route is absent.

- [ ] **Step 4: Return structured terminal results inside the server boundary**

Change the managed port to return a server-only result:

```ts
type RunPromptResult = Readonly<
  | { status: "succeeded"; runId: string }
  | { status: "failed"; runId: string; failureCode: AgentRunFailureCode }
>;
```

Extend `readEvents` to validate and return the terminal event's allowlisted code. Missing legacy codes become `RUN_FAILURE_UNKNOWN`. Do not expose the Run ID or internal code in `ClientFrame`.

- [ ] **Step 5: Add parent-aware synthetic Run creation**

Extend `createSyntheticRunRequest` with a closed options object containing `parentRunId` and a caller-supplied stable nonce/idempotency material. Include `parent_run_id` only for explicit retry and derive all request identifiers from the failed parent so retries are stable across duplicate HTTP requests.

- [ ] **Step 6: Implement the bounded retry store and route**

Store only `{conversationId, failedRunId, originalMessage, publicReason, childRunId?}` in process memory for the local demo. Keep it tenant/session scoped, bounded to the Conversation lifetime, and never return its internal fields. A per-parent promise guard serializes concurrent admissions. Only retryable public reasons expose the route.

- [ ] **Step 7: Emit public frames only**

Change the Browser terminal frame to:

```ts
{ type: "run.failed", reason: mapFailureCode(failureCode) }
```

The Gateway emits `UNKNOWN` when it cannot safely classify an internal terminal. It does not reuse `CLIENT_RUN_FAILED` as UI state.

- [ ] **Step 8: Verify the server and protocol**

Run: `npm run check -w @core-agent/control-plane-web`

Expected: mapping, exact parsing, retry idempotency, body validation, and server-boundary leak tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane-web scripts/lib/managed-runtime-session.mjs
git commit -m "feat(web): add public failure and retry protocol"
```

---

### Task 6: Render calm zero-content and partial failure states in Web

**Files:**

- Create: `apps/control-plane-web/src/client/content/run-failure-copy.ts`
- Modify: `apps/control-plane-web/src/client/state/chat-reducer.ts`
- Modify: `apps/control-plane-web/src/client/components/transcript.tsx`
- Modify: `apps/control-plane-web/src/client/app.tsx`
- Modify: `apps/control-plane-web/src/styles.css`
- Create: `apps/control-plane-web/tests/run-failure-copy.test.ts`
- Modify: `apps/control-plane-web/tests/chat-reducer.test.ts`
- Modify: `apps/control-plane-web/tests/workspace.test.tsx`
- Modify: `apps/control-plane-web/tests/web-chat.spec.ts`

- [ ] **Step 1: Write the failing copy dictionary test**

Create one exhaustive Chinese dictionary keyed by `ClientRunFailureReason`. Assert the approved copy/action pairs exactly. `SERVICE_UNAVAILABLE` has no clickable action until a real support destination exists.

```ts
BUSY: { message: "现在请求较多，请稍后再试。", action: "再试一次", intent: "retry" },
TEMPORARILY_UNAVAILABLE: { message: "Core Agent 暂时无法回复，请稍后再试。", action: "再试一次", intent: "retry" },
TOOK_TOO_LONG: { message: "这次回复等待时间较长，请再试一次。", action: "重新生成", intent: "retry" },
REPLY_INTERRUPTED: { message: "这条回复没有完成，内容可能不完整。", action: "重新生成", intent: "retry" },
NO_REPLY: { message: "这次没有生成回复，请再试一次。", action: "再试一次", intent: "retry" },
SERVICE_UNAVAILABLE: { message: "这项服务暂时无法使用。如问题持续，请联系支持。", intent: "none" },
ASSISTANT_PREPARING: { message: "Core Agent 正在准备中，请稍后再试。", action: "刷新状态", intent: "refresh" },
UNKNOWN: { message: "暂时无法完成这次请求，请稍后再试。", action: "再试一次", intent: "retry" },
```

- [ ] **Step 2: Write failing reducer and component tests**

Assert that a failed turn stores `failureReason`, keeps existing assistant content, and distinguishes `content.length === 0`. A zero-content failure renders one inline status card and no empty assistant bubble. A partial failure renders text plus one incomplete notice. Retry has one loading state and is disabled while admitting/streaming.

- [ ] **Step 3: Write failing accessibility and browser tests**

Verify `aria-live="polite"`, one announcement, no focus theft, keyboard-reachable action, visible focus, and stable reduced-motion/reduced-transparency behavior. Assert the transcript never contains `503`, `SSE`, `Hermes`, `Worker`, provider/model names, an internal failure code, or `CLIENT_RUN_FAILED`.

- [ ] **Step 4: Run focused tests and observe failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/run-failure-copy.test.ts tests/chat-reducer.test.ts tests/workspace.test.tsx`

Expected: the reducer has no failure reason and Transcript still renders `回复未完成。` universally.

- [ ] **Step 5: Implement state and presentation**

Extend `ChatTurn` with optional `failureReason` only for failed assistant turns. Centralize all user copy in `run-failure-copy.ts`. Render the existing Apple-style transcript hierarchy with a subdued inline status surface, not a modal or toast. Preserve partial text and mark it incomplete; replace a zero-length streaming assistant with the status surface.

- [ ] **Step 6: Wire explicit retry and refresh**

Replace client-side resubmission of `lastSubmittedMessage` with the empty-body retry endpoint. Keep the original user message in the transcript. Disable the action until the child Run reaches a terminal state. `ASSISTANT_PREPARING` refreshes readiness/status and does not fabricate a retry.

- [ ] **Step 7: Verify Web behavior**

Run: `npm run check -w @core-agent/control-plane-web`

Run: `npm run test:browser -w @core-agent/control-plane-web`

Expected: unit, component, protocol, and Playwright tests pass at desktop and narrow Apple-client viewport sizes.

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane-web
git commit -m "feat(web): present contextual conversation failures"
```

---

### Task 7: Prove the end-to-end reliability boundary and prepare release evidence

**Files:**

- Modify: `tests/integration/fakes/fake-hermes.ts`
- Modify: `tests/integration/agent-run.test.ts`
- Modify: `tests/integration/recovery.test.ts`
- Modify: `tests/integration/security.test.ts`
- Create: `tests/integration/conversation-reliability.test.ts`
- Modify: `package.json`
- Create: `docs/testing/conversation-reliability-v1.md`
- Modify: `docs/runbooks/local-development.md`
- Modify: `docs/superpowers/specs/2026-08-07-conversation-reliability-v1-design.md`

- [ ] **Step 1: Add deterministic fake-Hermes scenarios**

Provide named fixtures for busy, unavailable, timeout, denied, missing model, malformed response, mid-stream interruption, empty response, Runtime not ready, unknown error, and happy path. Each fixture must emit bounded protocol data and no real credentials or provider content.

- [ ] **Step 2: Add the failing end-to-end matrix**

For each server-side scenario, assert:

1. the Worker marks the Run failed exactly once;
2. `failure_code` is durable and `failure_summary` remains operator-only;
3. `run.failed.payload.code` is present for new events;
4. the Gateway maps to the expected public reason;
5. no forbidden technical text reaches the Browser;
6. partial output is retained and zero output has no empty message;
7. explicit retry creates exactly one child with the failed parent.

- [ ] **Step 3: Add restart and concurrency coverage**

Exercise API/Worker restart after `unsafe_to_replay`, duplicate retry HTTP requests, Conversation isolation, and a failed retry followed by a retry of the child. Prove no automatic replay and no cross-Conversation access.

- [ ] **Step 4: Run the deterministic full verification suite**

Run: `npm run check`

Run: `npm test`

Run: `npm run test:postgres`

Run: `npm run test:integration`

Run: `npm run test:runtime`

Run: `npm run web:build`

Run: `npm run test:browser -w @core-agent/control-plane-web`

Run: `git diff --check`

Expected: every command exits zero.

- [ ] **Step 5: Perform the local real-path acceptance**

Start the local managed Runtime, API, Worker, and Web using the existing runbook. Send a non-sensitive prompt through the real Browser path. Record only pass/fail, timestamps, Run status/code, and image digests in `docs/testing/conversation-reliability-v1.md`; never record credentials or response content.

If the configured provider is unavailable, record the real failure mapping as passed but mark the mandatory real-provider happy-path acceptance as pending. Do not claim product acceptance until a real response completes successfully.

- [ ] **Step 6: Update status and rollback documentation**

Mark the design status implemented only after deterministic verification passes. Document database forward-only migration behavior, application rollback compatibility, previous Hermes image selection, and the fact that public customer/student use still awaits Identity, Consent, Retention, and Data Governance milestones.

- [ ] **Step 7: Review scope and secrets**

Run: `git status --short`

Run: `git diff --name-only main...HEAD`

Run: `git diff main...HEAD -- . ':!package-lock.json' | rg -n '(token|api[_-]?key|authorization|provider.*message|traceback)'`

Inspect every match and confirm it is test data, an allowlist assertion, or documentation. Remove any secret or raw diagnostic content.

- [ ] **Step 8: Commit final evidence**

```bash
git add tests package.json docs
git commit -m "test: verify conversation reliability v1"
```

## Definition of Done

- Every new failed Agent Run has one allowlisted durable failure code.
- Old failed Runs/events remain readable and map safely to unknown.
- Managed Hermes emits only the exact safe error terminal and `[DONE]` for classified failures.
- No post-dispatch automatic replay and no automatic provider fallback exist.
- Browser receives only `ClientRunFailureReason`, never internal diagnostics.
- Zero-content and partial failures render the approved Chinese product states.
- Explicit retry creates exactly one auditable child Run.
- Deterministic checks pass; real-provider happy path is either recorded passing or explicitly pending.
- All changes are locally committed on the feature branch; no push, deployment, image publication, or product-image lock change occurs without explicit approval.
