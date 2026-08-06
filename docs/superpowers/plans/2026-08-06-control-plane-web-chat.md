# Core Agent B2B Web Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished Apple-style B2B consultant Web workspace that runs through the existing managed Runtime lifecycle and streams real Hermes responses without exposing privileged Control Plane credentials to the browser.

**Architecture:** Add one `@core-agent/control-plane-web` workspace containing a React/Vite client and a loopback-only Fastify Client Gateway. The Gateway enters `runManagedRuntimeSession()`, maps browser-safe Conversation identities to exact internal identities in memory, validates same-origin cookie/CSRF state, and translates the existing create-Run/read-events operations into a bounded client SSE protocol. UI components depend only on a typed `ClientGatewayPort`, so later Swift clients can implement the same product flow without reusing Web UI code.

**Tech Stack:** Node.js 22.13+, TypeScript 7.0.2, React 19.2.8, React DOM 19.2.8, Vite 8.2.0, Fastify 5.11.2, Motion 13.0.0, Vitest 4.1.10, Testing Library 16.3.2, Playwright 1.62.1, CSS custom properties.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-06-control-plane-web-chat-design.md` exactly.
- Bind the demo Gateway only to `127.0.0.1`; disable CORS and reject unexpected Host, Origin, and cross-site fetch metadata.
- Browser code must never receive bootstrap, ingress, provider, Docker, Supervisor, internal Tenant/Profile/Runtime, or internal Conversation identifiers.
- Accept only anonymous synthetic messages of 1–4000 characters with the existing control-character policy.
- Keep the current Control Plane and managed Runtime as final execution authority; never call Hermes or the provider from the browser.
- Use one visible synthetic demo student only. Do not render fake usable students, MCPs, Skills, metrics, or domain features.
- Use `#0066cc` as the only interaction accent, `#ffffff` and `#f5f5f7` surfaces, `#1d1d1f` primary ink, system typography, hairline structure, and no decorative gradients or chrome shadows.
- Body text is 17px; display/section titles use weight 600; no UI text uses weight 500.
- Minimum touch target is 44×44px. Motion must respect reduced motion, reduced transparency, and increased contrast.
- Add executable behavior through failing tests first. Every task ends with focused passing tests and a commit.
- Do not log transcript content, raw upstream errors, secrets, or internal resource identifiers.

---

## File map

```text
apps/control-plane-web/
├── index.html                         Vite document shell
├── package.json                       pinned workspace dependencies and scripts
├── playwright.config.ts               browser-test server and device matrix
├── tsconfig.client.json               no-emit browser typecheck
├── tsconfig.server.json               Gateway build
├── vite.config.ts                     client build to dist/client
├── src/
│   ├── shared/
│   │   └── protocol.ts                client frames, public errors, limits
│   ├── server/
│   │   ├── app.ts                     Fastify routes and stream translation
│   │   ├── main.ts                    managed Runtime and process lifecycle
│   │   ├── runtime-chat-port.ts       adapter over managed Runtime operations
│   │   ├── security.ts                Host/Origin/cookie/CSRF boundary
│   │   └── session-store.ts           browser-safe Conversation mapping
│   └── client/
│       ├── main.tsx                   React entry
│       ├── app.tsx                    bootstrap and workspace composition
│       ├── api/client-gateway.ts      same-origin fetch and SSE parser
│       ├── state/chat-reducer.ts      deterministic transcript state
│       ├── components/                focused visual components
│       ├── icons.tsx                  coherent inline SVG icon set
│       └── styles/                    tokens, layout, components, accessibility
└── tests/
    ├── protocol.test.ts               frame/error contracts
    ├── security.test.ts               same-origin and CSRF gate
    ├── app.test.ts                    Gateway behavior with fake managed port
    ├── runtime-chat-port.test.ts      exact operations and bounded errors
    ├── chat-reducer.test.ts           ordered client state
    ├── workspace.test.tsx             component interactions/accessibility
    ├── fixtures/fake-web-server.ts    isolated browser-test Gateway
    └── web-chat.spec.ts               desktop/mobile end-to-end checks
```

Root files modified by the plan:

- `package.json` — add build/check/test/start scripts for the Web workspace.
- `package-lock.json` — lock all new dependencies exactly.
- `.github/workflows/runtime-contract.yml` — add a Web job or Web commands to the existing unit gate.
- `README.md` — document the synthetic Web demo command and safety boundary.
- `docs/operations/runtime-v1-local-smoke.md` — add real Web acceptance and cleanup steps.
- `tests/runtime/control-plane-compose.test.mjs` — protect Web documentation and no-secret boundary.

---

### Task 1: Scaffold the Web workspace and client protocol

**Files:**
- Create: `apps/control-plane-web/package.json`
- Create: `apps/control-plane-web/tsconfig.client.json`
- Create: `apps/control-plane-web/tsconfig.server.json`
- Create: `apps/control-plane-web/vite.config.ts`
- Create: `apps/control-plane-web/index.html`
- Create: `apps/control-plane-web/src/shared/protocol.ts`
- Create: `apps/control-plane-web/tests/protocol.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `CLIENT_MESSAGE_MAX_CHARS`, `ClientBootstrap`, `ClientConversation`, `ClientFrame`, `ClientPublicErrorCode`, `encodeClientFrame()`, and `decodeClientFrame()`.
- Later server and browser tasks import this single protocol module; neither creates duplicate wire types.

- [ ] **Step 1: Write the failing protocol tests**

```ts
import { describe, expect, it } from "vitest";
import { decodeClientFrame, encodeClientFrame } from "../src/shared/protocol.js";

describe("client frame protocol", () => {
  it("round-trips only the allowlisted frame vocabulary", () => {
    expect(decodeClientFrame(encodeClientFrame({ type: "message.delta", delta: "hello" })))
      .toEqual({ type: "message.delta", delta: "hello" });
  });

  it.each([
    { type: "message.delta", delta: "" },
    { type: "unknown" },
    { type: "run.failed", code: "raw upstream body" },
  ])("rejects an invalid frame: %j", (value) => {
    expect(() => decodeClientFrame(JSON.stringify(value))).toThrowError("CLIENT_FRAME_INVALID");
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/protocol.test.ts`  
Expected: FAIL because the workspace/protocol module does not exist.

- [ ] **Step 3: Add exact pinned dependencies and the minimal protocol**

Pin these package versions: React/React DOM `19.2.8`, Vite `8.2.0`, React plugin
`6.0.5`, Fastify `5.11.2`, `@fastify/static` `10.1.2`, `@fastify/cookie`
`11.1.2`, Motion `13.0.0`, Vitest `4.1.10`, Testing Library `16.3.2`, user-event
`14.6.3`, jsdom `30.0.1`, Playwright `1.62.1`, axe-core `4.13.0`, React types
`19.2.18`, and React DOM types `19.2.4`.

```ts
export const CLIENT_MESSAGE_MAX_CHARS = 4_000;
export const CLIENT_FRAME_MAX_BYTES = 16 * 1_024;

export interface ClientConversation {
  readonly id: string;
  readonly title: string;
}

export interface ClientBootstrap {
  readonly csrf: string;
  readonly runtimeState: "ready";
  readonly student: { readonly id: "demo_student"; readonly name: "演示学生" };
  readonly conversations: readonly ClientConversation[];
  readonly selectedConversationId: string;
}

export type ClientPublicErrorCode =
  | "CLIENT_CONFIGURATION_INVALID"
  | "CLIENT_CONVERSATION_FAILED"
  | "CLIENT_FRAME_INVALID"
  | "CLIENT_HOST_INVALID"
  | "CLIENT_INPUT_INVALID"
  | "CLIENT_ORIGIN_INVALID"
  | "CLIENT_RESTART_FAILED"
  | "CLIENT_RUN_BUSY"
  | "CLIENT_RUN_FAILED"
  | "CLIENT_SESSION_INVALID";

export type ClientFrame =
  | { readonly type: "run.started" }
  | { readonly type: "message.delta"; readonly delta: string }
  | { readonly type: "message.completed" }
  | { readonly type: "run.completed" }
  | { readonly type: "run.failed"; readonly code: "CLIENT_RUN_FAILED" };

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
```

`decodeClientFrame()` must accept one JSON data payload, reject inherited/accessor
properties, enforce the exact key set for each variant, bound `delta` to 1–8192 valid
UTF-8 characters, and expose only `CLIENT_FRAME_INVALID` on failure.

- [ ] **Step 4: Add Vite/server TypeScript configs and root scripts**

Root scripts:

```json
{
  "web:build": "npm run build -w @core-agent/control-plane-web",
  "web:check": "npm run check -w @core-agent/control-plane-web",
  "web:test": "npm test -w @core-agent/control-plane-web",
  "web:control-plane": "npm run web:build && npm run start -w @core-agent/control-plane-web"
}
```

Append `npm run check -w @core-agent/control-plane-web` to the root `check` command and
append `npm test -w @core-agent/control-plane-web` to `test:unit`, so ordinary root
quality gates cannot omit the Web workspace.

Vite writes only `apps/control-plane-web/dist/client`; server TypeScript writes
`apps/control-plane-web/dist/server`. `emptyOutDir` must not delete the sibling output.

- [ ] **Step 5: Install and verify the focused test passes**

Run: `npm install`  
Run: `npm test -w @core-agent/control-plane-web -- --run tests/protocol.test.ts`  
Expected: protocol tests PASS with zero failures.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json apps/control-plane-web
git commit -m "feat(web): establish client protocol workspace"
```

---

### Task 2: Enforce the loopback browser security boundary

**Files:**
- Create: `apps/control-plane-web/src/server/security.ts`
- Create: `apps/control-plane-web/src/server/session-store.ts`
- Create: `apps/control-plane-web/tests/security.test.ts`

**Interfaces:**
- Produces `createBrowserSessionStore()`, `createClientConversationStore()`, `validateBrowserRequest()`, `issueBrowserSession()`, `verifyMutationSession()`, and `ClientConversationStore`.
- Consumes protocol limits from Task 1.

- [ ] **Step 1: Write failing security and mapping tests**

```ts
it("rejects cross-site mutation metadata before invoking a handler", async () => {
  const result = validateBrowserRequest({
    host: "127.0.0.1:4173",
    origin: "https://attacker.example",
    secFetchSite: "cross-site",
  });
  expect(result).toEqual({ ok: false, code: "CLIENT_ORIGIN_INVALID" });
});

it("never accepts an internal conversation id from the browser", async () => {
  const store = createClientConversationStore();
  const publicConversation = store.add("conversation_internal_secret");
  expect(publicConversation.id).toMatch(/^chat_[a-f0-9]{32}$/u);
  expect(store.resolve("conversation_internal_secret")).toBeUndefined();
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/security.test.ts`  
Expected: FAIL because `security.ts` and `session-store.ts` do not exist.

- [ ] **Step 3: Implement exact Host/Origin/fetch-metadata checks**

```ts
const allowedHosts = new Set(["127.0.0.1", "localhost"]);

export function validateBrowserRequest(input: BrowserRequestMetadata): BrowserRequestDecision {
  const host = parseBoundedHost(input.host);
  if (!allowedHosts.has(host.hostname)) return { ok: false, code: "CLIENT_HOST_INVALID" };
  if (input.secFetchSite !== undefined && !["same-origin", "none"].includes(input.secFetchSite)) {
    return { ok: false, code: "CLIENT_ORIGIN_INVALID" };
  }
  if (input.origin !== undefined && !sameLoopbackOrigin(input.origin, host)) {
    return { ok: false, code: "CLIENT_ORIGIN_INVALID" };
  }
  return { ok: true };
}
```

Reject duplicate security headers using `rawHeaders`. Session IDs and CSRF values are
32 random bytes encoded as lowercase hex, kept only in memory, and compared with
`timingSafeEqual`. The cookie is `HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`.

- [ ] **Step 4: Implement browser-safe Conversation mapping**

`ClientConversationStore.add(internalId)` generates `chat_<32 lowercase hex>` and a
display title `对话 N`. Only exact generated public IDs resolve. Return copies/frozen
records so callers cannot mutate the mapping.

- [ ] **Step 5: Run the focused tests**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/security.test.ts`  
Expected: all security/mapping tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-web/src/server apps/control-plane-web/tests/security.test.ts
git commit -m "feat(web): protect local client gateway boundary"
```

---

### Task 3: Build the Client Gateway and bounded streaming adapter

**Files:**
- Create: `apps/control-plane-web/src/server/app.ts`
- Create: `apps/control-plane-web/src/server/runtime-chat-port.ts`
- Create: `apps/control-plane-web/tests/app.test.ts`
- Create: `apps/control-plane-web/tests/runtime-chat-port.test.ts`

**Interfaces:**
- Consumes `ManagedChatPort`, `ClientConversationStore`, session/CSRF helpers, and protocol frames.
- Produces `buildClientGatewayApp(options)` and `createRuntimeChatPort(session)`.

`runtime-chat-port.ts` owns this exact interface:

```ts
export interface ManagedChatPort {
  createConversation(): Promise<string>;
  runPrompt(
    internalConversationId: string,
    content: string,
    sink: { readonly onStarted: () => void; readonly onDelta: (delta: string) => void },
  ): Promise<void>;
  restartApiWorker(): Promise<void>;
}
```

- [ ] **Step 1: Write failing Gateway tests with an injected fake port**

```ts
const port: ManagedChatPort = {
  createConversation: vi.fn(async () => "internal_conversation_1"),
  runPrompt: vi.fn(async (_id, _content, sink) => {
    sink.onStarted();
    sink.onDelta("Hello");
  }),
  restartApiWorker: vi.fn(async () => undefined),
};

it("streams allowlisted frames without internal identities", async () => {
  const app = await buildClientGatewayApp({ port, staticRoot: fixtureRoot });
  const session = await bootstrapBrowser(app);
  const response = await app.inject({
    method: "POST",
    url: `/client/v1/conversations/${session.conversationId}/runs`,
    headers: session.mutationHeaders,
    payload: { message: "synthetic prompt" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("message.delta");
  expect(response.body).not.toContain("internal_conversation_1");
});
```

Also prove: missing/duplicate cookie, missing/wrong CSRF, cross-site Origin, extra body
properties, invalid control characters, second concurrent Run, unknown public
Conversation, restart overlap, raw thrown errors, and overlarge deltas all fail with a
stable public code and do not reflect input/upstream content.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/app.test.ts tests/runtime-chat-port.test.ts`  
Expected: FAIL because the Gateway/adapter do not exist.

- [ ] **Step 3: Implement the managed operations adapter**

```ts
export function createRuntimeChatPort({ context, operations }: ManagedSession): ManagedChatPort {
  return Object.freeze({
    createConversation: () => operations.createConversation(context),
    async runPrompt(conversationId, content, sink) {
      const runId = await operations.createRun(context, conversationId, content);
      sink.onStarted();
      const eventTypes = await operations.readEvents(context, conversationId, runId, sink.onDelta);
      if (eventTypes.at(-1) !== "run.completed") throw publicError("CLIENT_RUN_FAILED");
    },
    restartApiWorker: () => operations.restartApiWorker(),
  });
}
```

Catch every non-public error at the adapter boundary and map it to one of
`CLIENT_CONVERSATION_FAILED`, `CLIENT_RUN_FAILED`, or `CLIENT_RESTART_FAILED` without
including `cause`, message content, or internal IDs in serialized output.

- [ ] **Step 4: Implement the same-origin routes**

Routes are exactly:

```text
GET  /client/v1/bootstrap
GET  /client/v1/health
POST /client/v1/conversations
POST /client/v1/conversations/:conversationId/runs
POST /client/v1/runtime/restart
```

Bootstrap creates an initial real Conversation once, issues a browser session, and
returns one synthetic student alias plus public Conversation summaries. Mutation routes
require the cookie and `x-core-agent-csrf` header. The Run route admits one active Run
per public Conversation and writes:

```ts
await port.runPrompt(internalId, message, {
  onStarted: () => write({ type: "run.started" }),
  onDelta: (delta) => write({ type: "message.delta", delta }),
});
write({ type: "message.completed" });
write({ type: "run.completed" });
```

On failure after streaming begins, write only
`{ type: "run.failed", code: "CLIENT_RUN_FAILED" }`. Bound aggregate output to the
existing managed event limits and destroy the response if the client disconnects.

- [ ] **Step 5: Run Gateway tests**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/app.test.ts tests/runtime-chat-port.test.ts`  
Expected: all Gateway and adapter tests PASS; no raw input or internal identity appears.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-web/src/server apps/control-plane-web/tests
git commit -m "feat(web): stream managed agent runs through gateway"
```

---

### Task 4: Add the managed Web host lifecycle

**Files:**
- Create: `apps/control-plane-web/src/server/main.ts`
- Create: `apps/control-plane-web/tests/main.test.ts`
- Modify: `apps/control-plane-web/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes `runManagedRuntimeSession()`, `createRuntimeChatPort()`, and `buildClientGatewayApp()`.
- Produces `runControlPlaneWeb(options)` and the `npm run web:control-plane` entrypoint.

- [ ] **Step 1: Write failing lifecycle tests**

Inject a fake managed-session runner and fake app. Prove the app starts only after a
ready session exists, binds exactly `{ host: "127.0.0.1", port: boundedConfiguredPort }`,
closes on abort, and lets managed-session cleanup run after app close. Prove invalid
argv/environment returns only `WEB_CONFIGURATION_INVALID`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/main.test.ts`  
Expected: FAIL because `main.ts` does not exist.

- [ ] **Step 3: Implement the lifecycle entrypoint**

```ts
export async function runControlPlaneWeb(options: RunControlPlaneWebOptions = {}): Promise<void> {
  const controller = options.controller ?? new AbortController();
  await runManagedRuntimeSession({
    environment: options.environment,
    signal: controller.signal,
    use: async (session) => {
      const app = await buildClientGatewayApp({
        port: createRuntimeChatPort(session),
        staticRoot: resolveClientRoot(),
      });
      await app.listen({ host: "127.0.0.1", port: resolveWebPort(options.environment) });
      await waitForAbort(controller.signal);
      await app.close();
    },
  });
}
```

Install `SIGINT`/`SIGTERM` handlers in `main()` only, remove them in `finally`, and never
print raw caught errors. Print fixed startup metadata containing only the loopback URL
and `WEB_READY`; do not print synthetic/internal IDs.

- [ ] **Step 4: Run lifecycle tests**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/main.test.ts`  
Expected: lifecycle tests PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json apps/control-plane-web
git commit -m "feat(web): own managed runtime web lifecycle"
```

---

### Task 5: Implement the browser port and deterministic chat state

**Files:**
- Create: `apps/control-plane-web/src/client/api/client-gateway.ts`
- Create: `apps/control-plane-web/src/client/state/chat-reducer.ts`
- Create: `apps/control-plane-web/tests/client-gateway.test.ts`
- Create: `apps/control-plane-web/tests/chat-reducer.test.ts`

**Interfaces:**
- Produces `createClientGatewayPort(fetchImpl)`, `parseClientEventStream()`, `initialChatState()`, and `reduceChatState()`.
- Later components receive a `ClientGatewayPort`; they never call `fetch` directly.

```ts
export interface ClientGatewayPort {
  bootstrap(): Promise<ClientBootstrap>;
  createConversation(): Promise<ClientConversation>;
  runConversation(conversationId: string, message: string): AsyncIterable<ClientFrame>;
  restartApiWorker(): Promise<void>;
  health(): Promise<{ readonly state: "ready" }>;
}
```

- [ ] **Step 1: Write failing stream and reducer tests**

```ts
it("reassembles split UTF-8 SSE chunks in order", async () => {
  const frames = await collect(parseClientEventStream(chunks("你", "好")));
  expect(frames).toEqual([
    { type: "message.delta", delta: "你" },
    { type: "message.delta", delta: "好" },
    { type: "message.completed" },
    { type: "run.completed" },
  ]);
});

it("keeps an editable draft while a run streams", () => {
  const streaming = reduceChatState(initialChatState(), { type: "run.started", localMessage: "hello" });
  expect(reduceChatState(streaming, { type: "draft.changed", value: "next" }).draft).toBe("next");
});
```

Prove cursor/order violations, unknown events, overlarge frames, excessive aggregate
bytes, terminal duplication, truncated UTF-8, and post-terminal deltas fail closed.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/client-gateway.test.ts tests/chat-reducer.test.ts`  
Expected: FAIL because the client modules do not exist.

- [ ] **Step 3: Implement the browser port**

`bootstrap()` captures the returned CSRF value in memory. Each mutation sends
`credentials: "same-origin"`, `content-type: application/json`, and the CSRF header.
`runConversation()` returns an async iterator of decoded frames from `response.body`.
Never include CSRF in a URL or browser storage.

- [ ] **Step 4: Implement the reducer**

State is normalized by public Conversation ID. Each Conversation owns ordered turns,
one draft, and `idle | submitting | streaming | failed` status. A local consultant turn
is inserted exactly once; assistant deltas append to one active assistant turn;
`run.completed` finalizes both. Explicit retry reuses the visible text but creates a new
request invocation.

- [ ] **Step 5: Run focused tests**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/client-gateway.test.ts tests/chat-reducer.test.ts`  
Expected: all stream/reducer tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-web/src/client/api apps/control-plane-web/src/client/state apps/control-plane-web/tests
git commit -m "feat(web): model streamed conversation state"
```

---

### Task 6: Build the approved Apple-style consultant workspace

**Files:**
- Create: `apps/control-plane-web/src/client/main.tsx`
- Create: `apps/control-plane-web/src/client/app.tsx`
- Create: `apps/control-plane-web/src/client/icons.tsx`
- Create: `apps/control-plane-web/src/client/components/global-navigation-rail.tsx`
- Create: `apps/control-plane-web/src/client/components/student-conversation-sidebar.tsx`
- Create: `apps/control-plane-web/src/client/components/conversation-workspace.tsx`
- Create: `apps/control-plane-web/src/client/components/transcript.tsx`
- Create: `apps/control-plane-web/src/client/components/message-composer.tsx`
- Create: `apps/control-plane-web/src/client/components/student-context-inspector.tsx`
- Create: `apps/control-plane-web/src/client/styles/tokens.css`
- Create: `apps/control-plane-web/src/client/styles/workspace.css`
- Create: `apps/control-plane-web/src/client/styles/accessibility.css`
- Create: `apps/control-plane-web/tests/workspace.test.tsx`

**Interfaces:**
- Consumes `ClientGatewayPort` and reducer from Task 5.
- Produces the complete responsive consultant UI used by browser tests and the real host.

- [ ] **Step 1: Write failing component behavior tests**

Using Testing Library and user-event, prove:

- bootstrap renders one `演示学生` and the selected real Conversation summary;
- sending a valid prompt renders one consultant turn and streamed assistant content;
- the composer stays editable but the second send is unavailable during an active Run;
- New Conversation calls the Gateway and changes the selected Conversation;
- Restart exposes status, calls the Gateway once, and restores ready state;
- inspector open/close uses the triggering control and returns focus on close;
- mobile Back shows the student/conversation navigation without losing transcript state;
- invalid/overlong/control-character input is announced inline and never calls the port;
- stable failures render retry without raw thrown text.

- [ ] **Step 2: Run the component tests and verify failure**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/workspace.test.tsx`  
Expected: FAIL because the React components do not exist.

- [ ] **Step 3: Implement the component tree with exact visible copy**

Above-the-fold allowed copy:

```text
Core Agent
学生
最近对话
演示学生
演示空间
当前学生
申请阶段
方案规划
下一节点
确认选校
已连接
给 Core Agent 发送任务或指令
新建对话
重新启动服务
```

Do not add marketing taglines, fake metrics, capability badges, MCP/Skill rows, or extra
students. SVG icons use one 1.75px rounded stroke grammar and `currentColor`.

- [ ] **Step 4: Implement tokens and wide layout**

```css
:root {
  color: #1d1d1f;
  background: #f5f5f7;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", system-ui, sans-serif;
  --action: #0066cc;
  --canvas: #ffffff;
  --canvas-secondary: #f5f5f7;
  --ink: #1d1d1f;
  --muted: #6e6e73;
  --hairline: rgba(0, 0, 0, .08);
}

.workspace {
  display: grid;
  grid-template-columns: 56px 272px minmax(420px, 1fr) 280px;
  min-height: 100dvh;
}
```

Transcript content uses a maximum readable measure; the composer stays in normal layout
at the bottom and uses sticky/frosted material only where content scrolls beneath it.
No card/button/text shadow is allowed.

- [ ] **Step 5: Implement responsive and accessible states**

At 1180px collapse the inspector into an anchored Motion overlay. At 834px collapse the
global rail. At 640px render a NavigationStack with 44px controls and safe-area composer.
Use a critically damped Motion spring (`type: "spring", bounce: 0, duration: 0.4`) for
the inspector; use cross-fade/no transform under reduced motion. Add solid fallbacks for
reduced transparency and stronger borders/focus for increased contrast.

- [ ] **Step 6: Run component and build checks**

Run: `npm test -w @core-agent/control-plane-web -- --run tests/workspace.test.tsx`  
Run: `npm run check -w @core-agent/control-plane-web`  
Expected: component tests, typecheck, client build, and server build PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane-web
git commit -m "feat(web): build consultant conversation workspace"
```

---

### Task 7: Add browser verification, CI, documentation, and real acceptance

**Files:**
- Create: `apps/control-plane-web/playwright.config.ts`
- Create: `apps/control-plane-web/tests/fixtures/fake-web-server.ts`
- Create: `apps/control-plane-web/tests/web-chat.spec.ts`
- Modify: `.github/workflows/runtime-contract.yml`
- Modify: `README.md`
- Modify: `docs/operations/runtime-v1-local-smoke.md`
- Modify: `tests/runtime/control-plane-compose.test.mjs`

**Interfaces:**
- Consumes the production client and Gateway.
- Produces repeatable desktop/mobile browser evidence and an opt-in real Web acceptance path.

- [ ] **Step 1: Write failing browser tests against the fake managed port**

Playwright projects:

```ts
projects: [
  { name: "desktop", use: { viewport: { width: 1440, height: 960 } } },
  { name: "compact", use: { viewport: { width: 1024, height: 820 } } },
  { name: "iphone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
]
```

Tests must send one prompt, observe streaming completion, create a new Conversation,
restart, toggle the inspector, traverse mobile back navigation, tab through controls,
run axe-core, and assert no horizontal overflow at every viewport.

- [ ] **Step 2: Run browser tests and verify failure**

Run: `npm run test:browser -w @core-agent/control-plane-web`  
Expected: FAIL before fixtures/config are complete.

- [ ] **Step 3: Implement the isolated fake Web server and browser tests**

The fake port emits fixed synthetic assistant deltas and never calls Docker/provider.
It must use the production Gateway and production client build so security headers,
CSRF, streaming parser, and UI are exercised together.

- [ ] **Step 4: Add Web gates to CI and root checks**

The existing unit job exercises Web tests through the updated root `npm run check`.
Add a dedicated `web-browser` job using the workflow's existing pinned checkout and
setup-node SHAs, followed by these exact commands:

```yaml
- name: Install pinned dependencies
  run: npm ci
- name: Install pinned Chromium
  run: npx playwright install --with-deps chromium
- name: Run consultant Web browser acceptance
  run: npm run test:browser -w @core-agent/control-plane-web
```

The job uses `ubuntu-latest`, a 15-minute timeout, Node `22.13.0`, and no publish or
deployment permissions.

- [ ] **Step 5: Document local and real commands**

Document:

```bash
set -a
source .env.runtime
set +a
npm run web:control-plane
```

State clearly that the demo is loopback-only, synthetic-only, uses one managed Runtime,
and cleans on process termination. Include fixed acceptance actions: first response,
follow-up, New Conversation, API/Worker restart, mobile viewport, and normal cleanup.
Never paste prompts, assistant responses, keys, raw Docker data, or database rows.

- [ ] **Step 6: Run all local verification**

Run: `npm run web:check`  
Run: `npm run web:test`  
Run: `npm run test:browser -w @core-agent/control-plane-web`  
Run: `npm test --silent`  
Run: `npm run check --silent`  
Run: `node scripts/verify-no-secret.mjs synthetic-web-runtime-sentinel`  
Run: `git diff --check`  
Expected: every command exits 0 with zero test failures and no sentinel match.

- [ ] **Step 7: Run visual fidelity verification**

Start the fake or real Web client. Capture 1440×960 and 390×844 screenshots. Use
`view_image` on both approved concepts and both implementation screenshots in the same
review pass. Record and fix mismatches for layout, type hierarchy, palette, dividers,
message treatment, composer, inspector, navigation collapse, touch targets, and copy.

- [ ] **Step 8: Run opt-in real Hermes acceptance**

With the existing protected environment, start `npm run web:control-plane`, use only a
fixed anonymous synthetic prompt, verify one non-empty assistant completion, a same-
Conversation follow-up, New Conversation, exact API/Worker restart, post-restart Run,
and ordered cleanup. Record only statuses, event types, and counts.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/runtime-contract.yml README.md docs/operations/runtime-v1-local-smoke.md tests/runtime/control-plane-compose.test.mjs apps/control-plane-web
git commit -m "test(web): accept consultant chat experience"
```

---

## Plan self-review

- Spec coverage: security boundary, managed lifecycle, real Run streaming, new
  Conversation, restart, desktop/tablet/phone UI, Apple visual tokens, accessibility,
  cross-platform boundaries, CI, documentation, visual comparison, and real acceptance
  each map to an explicit task.
- Scope: production auth, real student/domain data, MCP/Skills, file upload, voice,
  native apps, and production history remain excluded.
- Type consistency: `ClientFrame`, `ManagedChatPort`, `ClientGatewayPort`,
  `ClientConversationStore`, `buildClientGatewayApp()`, `createRuntimeChatPort()`, and
  `runControlPlaneWeb()` have one owner and one spelling throughout the plan.
- Completeness scan: every implementation step names concrete files, interfaces,
  commands, and expected results.
