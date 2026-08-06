# Interactive Control Plane Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a safe terminal client that packages and exercises real multi-turn Hermes conversation through the existing Control Plane without enabling MCP or long-term memory.

**Architecture:** Move the current real-smoke implementation behind a shared managed-session module while retaining a thin compatibility entrypoint. Add a port-driven chat loop that creates Runs, renders bounded SSE deltas, supports fresh Conversation and exact API/Worker restart commands, and delegates all lifecycle cleanup to the shared session.

**Tech Stack:** Node.js 22.13.0, Node readline, Fetch/SSE, Docker Compose, existing Fastify/PostgreSQL/Worker/Supervisor/Hermes runtime.

## Global Constraints

- The terminal client calls only the Control Plane API and never calls Hermes directly.
- Inputs and resource identifiers are synthetic; customer and student data are prohibited.
- MCP, business Skills, and long-term memory plugins remain disabled.
- User messages are 1–4000 characters and contain no C0/DEL controls.
- Transcript content is displayed only on the current terminal and persisted only by the existing Control Plane Message model.
- Errors contain fixed codes only, without raw provider, Docker, database, secret-path, or transcript content.
- Default cleanup deletes the exact Runtime and stops exact Compose services without deleting volumes.
- `--keep-runtime` is explicit and still zeroes every secret buffer held by the client.

---

### Task 1: Characterize and extract the managed Runtime session module

**Files:**
- Create by move: `scripts/lib/managed-runtime-session.mjs`
- Recreate as wrapper: `scripts/smoke-control-plane.mjs`
- Modify: `tests/runtime/runtime-contract.test.mjs`
- Create: `tests/runtime/managed-runtime-session.test.mjs`

**Interfaces:**
- `scripts/smoke-control-plane.mjs` continues exporting every current named export.
- `scripts/lib/managed-runtime-session.mjs` exports the current helpers and
  `createManagedRuntimeDependencies(environment, signal)`.
- `runControlPlaneSmoke(options)` retains its current return, stdout, error-code, argument,
  opt-in, cleanup, and keep-runtime behavior.

- [ ] **Step 1: Write failing module-boundary tests**

Add a test importing `createManagedRuntimeDependencies` from the missing shared module.
Read the wrapper source and require it to contain no Docker command strings, secret-file
reads, SQL, provisioning payload, or SSE parser. Re-run the existing complete
`runtime-contract.test.mjs` as the compatibility baseline.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test tests/runtime/managed-runtime-session.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Move implementation and create the compatibility wrapper**

Move the implementation file to `scripts/lib/managed-runtime-session.mjs`, update its
repository-root URL from `..` to `../..`, update the socket-preflight import to
`../preflight-runtime-docker-socket.mjs`, export the former
`createDefaultDependencies` as `createManagedRuntimeDependencies`, and remove its CLI
`main()` block.

The new wrapper is exactly responsible for signal-to-exit-code adaptation:

```js
#!/usr/bin/env node
import { pathToFileURL } from "node:url";
export * from "./lib/managed-runtime-session.mjs";
import { runControlPlaneSmoke, smokePublicErrorCode } from "./lib/managed-runtime-session.mjs";

export async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try { await runControlPlaneSmoke({ signal: controller.signal }); }
  catch (error) {
    process.stderr.write(`${smokePublicErrorCode(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
```

- [ ] **Step 4: Verify compatibility and commit**

Run:

```bash
node --test tests/runtime/managed-runtime-session.test.mjs tests/runtime/runtime-contract.test.mjs
```

Expected: all existing and new tests PASS.

Commit: `refactor(runtime): share managed smoke session`

---

### Task 2: Add one reusable lifecycle orchestrator

**Files:**
- Modify: `scripts/lib/managed-runtime-session.mjs`
- Modify: `tests/runtime/managed-runtime-session.test.mjs`
- Modify: `tests/runtime/runtime-contract.test.mjs`

**Interfaces:**
- Produces: `runManagedRuntimeSession({ environment, keepRuntime, signal, dependencies, use }): Promise<unknown>`
- `use(session)` receives `{ context, runtime, operations }` only after readiness.
- `runControlPlaneSmoke()` becomes a strict caller of this orchestrator.

- [ ] **Step 1: Write failing ordered-lifecycle and cleanup tests**

Use an injected port that records calls. Require this success order:

```text
validatePrerequisites,startTopology,prepareProvisioningContext,provision,pollRuntime,use,
deleteRuntime,waitForContainerRemoval,stopTopology,releaseProductImageLockSnapshot,releaseSecrets
```

Require all cleanup calls after `use` throws, first-cleanup-error preservation, no delete/
stop/snapshot release for successful `keepRuntime`, and `releaseSecrets` in every path.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/runtime/managed-runtime-session.test.mjs`

Expected: FAIL because `runManagedRuntimeSession` is missing.

- [ ] **Step 3: Implement minimal lifecycle orchestration**

Implement one state machine with `topologyOwned`, `context`, `primaryError`, and
`cleanupError`. It must set topology ownership immediately before start, preserve the
first cleanup error, and call `use(Object.freeze({ context, runtime, operations: deps }))`.
Wrap only public-boundary failures in the existing fixed smoke error; never attach
secret-bearing values to `message`.

- [ ] **Step 4: Refactor strict smoke onto the orchestrator**

Move only the current provision/run/evidence callback into `use`; keep strict output
validation in `runControlPlaneSmoke`. The wrapper continues emitting one allowlisted
JSON object after cleanup succeeds.

- [ ] **Step 5: Verify all smoke contracts and commit**

Run:

```bash
node --test tests/runtime/managed-runtime-session.test.mjs tests/runtime/runtime-contract.test.mjs
npm run test:runtime
```

Expected: all tests PASS.

Commit: `refactor(runtime): centralize managed session cleanup`

---

### Task 3: Generalize Conversation Run and SSE operations

**Files:**
- Modify: `scripts/lib/managed-runtime-session.mjs`
- Modify: `tests/runtime/managed-runtime-session.test.mjs`
- Modify: `tests/runtime/runtime-contract.test.mjs`

**Interfaces:**
- `operations.createConversation(context): Promise<string>`
- `operations.createRun(context, conversationId, content): Promise<string>`
- `operations.readEvents(context, conversationId, runId, onDelta?): Promise<readonly string[]>`
- `operations.restartApiWorker(): Promise<void>`

- [ ] **Step 1: Write failing arbitrary-synthetic-content tests**

Require `createRun` to construct a strict v1 request whose payload hash covers the exact
input message, whose IDs remain synthetic, and whose content is the caller's validated
string. Require the existing smoke caller to pass its fixed prompt explicitly.

- [ ] **Step 2: Write failing delta callback and restart tests**

Feed SSE events for two Runs in one Conversation. Require `onDelta(delta)` only for
`message.delta` envelopes matching the active tenant, conversation, and Run. Require
restart argv to be exactly:

```text
docker compose --project-name core-agent-runtime-v1-smoke -f infra/runtime/compose.dev.yaml up -d --force-recreate api worker
```

and require a subsequent `/health/ready` 200 response.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/runtime/managed-runtime-session.test.mjs tests/runtime/runtime-contract.test.mjs`

Expected: FAIL on the first generalized operation.

- [ ] **Step 4: Implement generalized operations without weakening smoke validation**

Add one content validator shared with chat, make the callback optional, preserve aggregate
SSE byte/event limits, and keep terminal-event requirements. Add `restartApiWorker()`
through the existing argv-only bounded child seam.

- [ ] **Step 5: Verify and commit**

Run the two focused suites and `npm run test:runtime`.

Expected: all PASS.

Commit: `feat(runtime): expose managed conversation operations`

---

### Task 4: Port-driven interactive chat loop

**Files:**
- Create: `scripts/lib/control-plane-chat.mjs`
- Create: `tests/runtime/chat-control-plane.test.mjs`

**Interfaces:**
- `parseChatArguments(argv): Readonly<{ keepRuntime: boolean }>`
- `validateChatInput(value): string`
- `runInteractiveChat({ port, input, output, errorOutput, signal }): Promise<{ conversationId: string }>`
- Port methods: `createConversation()`, `runPrompt(conversationId, content, onDelta)`, `restartApiWorker()`.

- [ ] **Step 1: Write failing argument and input tests**

Require only zero args or one `--keep-runtime`. Require `/new`, `/restart`, and `/exit`
as exact commands. Reject empty/whitespace-only input, more than 4000 characters, C0/DEL
controls, invalid types, and command prefixes such as `/exit now`.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/runtime/chat-control-plane.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement validators and verify GREEN**

Use fixed errors `CHAT_ARGUMENT_INVALID` and `CHAT_INPUT_INVALID`; never include input in
messages. Run the focused test until PASS, then commit:

```text
test(chat): define bounded terminal input
```

- [ ] **Step 4: Write failing multi-turn command tests**

Use an async injected line source with:

```text
first synthetic question
follow-up synthetic question
/new
isolated synthetic question
/restart
/exit
```

Require the first two prompts to share Conversation A, `/new` to create Conversation B,
the third prompt to use B, restart exactly once, deltas to reach only `output.write`, and
fixed status text to contain no prompt/delta content.

- [ ] **Step 5: Implement the minimal chat loop**

The loop writes the anonymous-data warning once, creates the initial Conversation, awaits
each Run before reading another line, emits assistant deltas as received, adds one newline
after a terminal Run, and maps port failures to fixed `CHAT_RUN_FAILED` or
`CHAT_RESTART_FAILED` codes. It owns no Docker or secret operation.

- [ ] **Step 6: Verify abort/error behavior and commit**

Add cases for EOF, already-aborted signal, abort during Run, failed Run, and output-write
failure. Require the loop to stop without accepting later input.

Run: `node --test tests/runtime/chat-control-plane.test.mjs`

Expected: all PASS.

Commit: `feat(chat): add interactive Control Plane loop`

---

### Task 5: Terminal entrypoint and managed cleanup integration

**Files:**
- Create: `scripts/chat-control-plane.mjs`
- Create: `scripts/cleanup-control-plane-chat.mjs`
- Modify: `package.json`
- Modify: `tests/runtime/chat-control-plane.test.mjs`
- Modify: `tests/runtime/managed-runtime-session.test.mjs`

**Interfaces:**
- CLI: `npm run chat:control-plane`
- CLI retained mode: `npm run chat:control-plane -- --keep-runtime`
- CLI retained cleanup: `npm run chat:cleanup`

- [ ] **Step 1: Write failing entrypoint contract tests**

Require the entrypoint to use `node:readline/promises`, pass stdin/stdout through injected
adapters, compose `runManagedRuntimeSession()` with `runInteractiveChat()`, install only
`SIGINT`/`SIGTERM` handlers, and expose only fixed error codes on stderr. For
`--keep-runtime`, require an `O_EXCL` owner-only `0600` receipt beneath the configured
state root with exactly `schemaVersion`, `composeProject`, `tenantId`, `profileId`,
`runtimeId`, and `lockSnapshotName`. Reject any pre-existing receipt and fall back to
default cleanup.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/runtime/chat-control-plane.test.mjs`

Expected: FAIL with `ENOENT` or missing entrypoint export.

- [ ] **Step 3: Implement the entrypoint**

Parse arguments before any Docker call. Build the managed dependencies only after
environment validation. Inside the session callback adapt operations to the chat port:

```js
{
  createConversation: () => operations.createConversation(context),
  runPrompt: async (conversationId, content, onDelta) => {
    const runId = await operations.createRun(context, conversationId, content);
    const events = await operations.readEvents(context, conversationId, runId, onDelta);
    if (events.at(-1) !== "run.completed") throw new ChatError("CHAT_RUN_FAILED");
  },
  restartApiWorker: () => operations.restartApiWorker(),
}
```

Close readline in `finally`; lifecycle cleanup remains owned by
`runManagedRuntimeSession`.

- [ ] **Step 4: Implement exact retained-runtime cleanup**

The cleanup entrypoint accepts no argv. It loads the configured environment, securely
opens the fixed receipt through `O_RDONLY | O_NOFOLLOW`, requires current-owner regular
`0600` single-link metadata before and after a bounded read, validates exact synthetic
identifiers and project name, then calls the shared delete, container-absence, Compose
down, snapshot-release, and secret-zeroization operations. It removes the receipt only
after all cleanup operations settle; failure exposes one fixed `CHAT_CLEANUP_FAILED`
code and preserves the receipt for an exact retry.

- [ ] **Step 5: Add root scripts and verify fake integration**

Add:

```json
"chat:control-plane": "node scripts/chat-control-plane.mjs",
"chat:cleanup": "node scripts/cleanup-control-plane-chat.mjs"
```

Run focused chat/session/runtime suites. Expected: PASS with no Docker call in injected
tests.

- [ ] **Step 6: Commit**

Commit: `feat(chat): run managed terminal conversations`

---

### Task 6: Interactive operations guide and complete deterministic verification

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/runtime-v1-local-smoke.md`
- Modify: `tests/runtime/chat-control-plane.test.mjs`

**Interfaces:**
- Documents default chat, `/new`, `/restart`, `/exit`, `--keep-runtime`, and exact retained-runtime cleanup.

- [ ] **Step 1: Write failing documentation assertions**

Require both docs to distinguish strict acceptance output from interactive transcript and
contain the exact commands and synthetic-only warning.

- [ ] **Step 2: Verify RED and write operations guidance**

Run the focused test, then document:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:control-plane
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run chat:control-plane -- --keep-runtime
```

Document `/restart` as API/Worker-only, `/new` as a new Hermes session, default volume
retention, no transcript capture, and `npm run chat:cleanup` as the exact no-argument
retained-runtime cleanup command.

- [ ] **Step 3: Run complete deterministic gates**

Run:

```bash
npm test
npm run check
node scripts/verify-no-secret.mjs synthetic-chat-plan-sentinel-v1
git diff --check
```

Expected: all exit 0 and the sentinel scanner emits nothing.

- [ ] **Step 4: Commit documentation**

Commit: `docs(chat): document synthetic terminal acceptance`

---

### Task 7: Real Colima arm64 conversation acceptance

**Files:**
- Modify only after a real run: `docs/operations/runtime-v1-acceptance-evidence.md`

**Interfaces:**
- Consumes: reviewed `infra/hermes/product-images.lock.json`, private GHCR login, three protected local secret leaves, and completed `.env.runtime`.
- Produces: bounded AC1–AC10 runtime evidence without transcript content.

- [ ] **Step 1: Verify selected local platform and immutable images**

Select the `colima` context, prove its canonical Unix endpoint, pull the reviewed arm64
product image by digest plus locked Node/PostgreSQL images, and inspect the product
entrypoint without printing environment secrets.

- [ ] **Step 2: Prepare protected projections**

Create distinct canonical bootstrap/provider/ingress roots with `0700` directories and
`0600`, single-link secret leaves. Generate synthetic bootstrap/ingress values and place
the already-authorized TokenHub credential in `provider_tokenhub_main.v1` without
printing any value. Complete `.env.runtime` with paths/references only.

- [ ] **Step 3: Run strict real smoke**

Run network/path preflight, Compose config, then:

```bash
CORE_AGENT_REAL_HERMES_SMOKE=1 npm run smoke:control-plane
```

Expected: runtime `ready`, Run `succeeded`, terminal `run.completed`, positive assistant
message count, successful cleanup, and no leaked sentinel.

- [ ] **Step 4: Run interactive multi-turn acceptance**

Run `npm run chat:control-plane`; manually use one anonymous first prompt, one
same-Conversation follow-up, `/new`, one isolated prompt, `/restart`, one post-restart
prompt, and `/exit`. Record only IDs, counts, states, and pass/fail conclusions.

- [ ] **Step 5: Verify cleanup and write bounded evidence**

Confirm the exact Compose project has no running service, no managed Runtime container
remains, expected data volumes remain, database/image/log scans contain no secret, and
plugins remain disabled. Append an allowlisted evidence record and commit:

```text
docs(runtime): record v0.1.0 real conversation acceptance
```
