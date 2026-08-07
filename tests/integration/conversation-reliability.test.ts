import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AGENT_RUN_FAILURE_CODES,
  type AgentRunFailureCode,
} from "@core-agent/contracts";
import type { FastifyInstance } from "fastify";

import { buildClientGatewayApp } from "../../apps/control-plane-web/src/server/app.js";
import { mapAgentRunFailureCode } from "../../apps/control-plane-web/src/server/failure-reasons.js";
import {
  createRuntimeChatPort,
  type ManagedSession,
  type RunPromptOptions,
} from "../../apps/control-plane-web/src/server/runtime-chat-port.js";
import {
  decodeClientFrame,
  type ClientFrame,
  type ClientRunFailureReason,
} from "../../apps/control-plane-web/src/shared/protocol.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
  type ProvisionedSyntheticTenant,
} from "./harness.js";
import { HERMES_CONVERSATION_SCENARIOS } from "./fakes/fake-hermes.js";

interface BrowserSession {
  readonly conversationId: string;
  readonly mutationHeaders: Readonly<Record<string, string>>;
}

interface StoredRun {
  readonly run_id: string;
  readonly status: string;
  readonly failure_code: AgentRunFailureCode | null;
  readonly failure_summary: string | null;
  readonly parent_run_id: string | null;
}

const failureCodes = new Set<AgentRunFailureCode>(AGENT_RUN_FAILURE_CODES);
const publicForbidden = /(?:MODEL_|RUN_INTERNAL|AGENT_RUNTIME|Hermes|Worker|traceback|tokenhub|failure_summary|provider)/iu;

let harness: IntegrationHarness;
let provisioned: ProvisionedSyntheticTenant;
let gateway: FastifyInstance;
let browser: BrowserSession;
let staticRoot: string;

async function eventually<T>(
  load: () => Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 6_000;
  while (true) {
    const value = await load();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function payloadRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function readRunEvents(
  runId: string,
  onDelta: (delta: string) => void,
): Promise<{
  readonly eventTypes: readonly string[];
  readonly terminal:
    | { readonly status: "succeeded" }
    | { readonly status: "failed"; readonly failureCode: AgentRunFailureCode };
}> {
  const rows = await eventually(
    () => harness.db.selectFrom("product_events")
      .select(["event_type", "payload", "sequence"])
      .where("run_id", "=", runId)
      .orderBy("sequence")
      .execute(),
    (events) => events.some((event) => (
      event.event_type === "run.completed" || event.event_type === "run.failed"
    )),
    "terminal ProductEvent",
  );
  for (const row of rows) {
    if (row.event_type !== "message.delta") continue;
    const delta = payloadRecord(row.payload).delta;
    assert.equal(typeof delta, "string");
    onDelta(delta);
  }
  const terminal = rows.at(-1);
  assert(terminal !== undefined);
  const eventTypes = Object.freeze(rows.map((row) => row.event_type));
  if (terminal.event_type === "run.completed") {
    return Object.freeze({ eventTypes, terminal: Object.freeze({ status: "succeeded" }) });
  }
  assert.equal(terminal.event_type, "run.failed");
  const failureCode = payloadRecord(terminal.payload).failure_code;
  assert.equal(typeof failureCode, "string");
  assert(failureCodes.has(failureCode as AgentRunFailureCode));
  return Object.freeze({
    eventTypes,
    terminal: Object.freeze({
      status: "failed",
      failureCode: failureCode as AgentRunFailureCode,
    }),
  });
}

function managedSession(): ManagedSession {
  const context = Object.freeze({
    tenantId: provisioned.tenant_id,
    profileId: provisioned.profile_ids[0]!,
  });
  return Object.freeze({
    context,
    operations: Object.freeze({
      async createConversation(value: unknown): Promise<string> {
        assert.deepEqual(value, context);
        const conversation = await harness.createConversation({
          tenant_id: context.tenantId,
          profile_id: context.profileId,
        });
        return conversation.conversation_id;
      },
      async createRun(
        value: unknown,
        conversationId: string,
        content: string,
        options?: RunPromptOptions,
      ): Promise<string> {
        assert.deepEqual(value, context);
        const run = await harness.createRun(conversationId, content, {
          tenantId: context.tenantId,
          ...(options === undefined ? {} : { parentRunId: options.parentRunId }),
        });
        return run.run_id;
      },
      async readEvents(
        value: unknown,
        _conversationId: string,
        runId: string,
        onDelta: (delta: string) => void,
      ) {
        assert.deepEqual(value, context);
        return readRunEvents(runId, onDelta);
      },
      restartApiWorker: () => harness.restartApi(),
    }),
  });
}

async function bootstrapBrowser(): Promise<BrowserSession> {
  const response = await gateway.inject({
    method: "GET",
    url: "/client/v1/bootstrap",
    headers: { host: "127.0.0.1:4173", "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { csrf: string; selectedConversationId: string };
  const setCookie = response.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  return Object.freeze({
    conversationId: body.selectedConversationId,
    mutationHeaders: Object.freeze({
      host: "127.0.0.1:4173",
      origin: "http://127.0.0.1:4173",
      "sec-fetch-site": "same-origin",
      cookie: (setCookie as string).split(";", 1)[0]!,
      "x-core-agent-csrf": body.csrf,
    }),
  });
}

function frames(body: string): readonly ClientFrame[] {
  return Object.freeze(body.trim().split("\n\n").map((block) => {
    assert.match(block, /^data: /u);
    return decodeClientFrame(block.slice(6));
  }));
}

async function runIds(): Promise<Set<string>> {
  return new Set((await harness.db.selectFrom("agent_runs").select("run_id").execute())
    .map((run) => run.run_id));
}

async function onlyNewRun(before: ReadonlySet<string>): Promise<StoredRun> {
  const rows = await harness.db.selectFrom("agent_runs")
    .select(["run_id", "status", "failure_code", "failure_summary", "parent_run_id"])
    .orderBy("created_at", "desc")
    .execute();
  const created = rows.filter((row) => !before.has(row.run_id));
  assert.equal(created.length, 1);
  return created[0]!;
}

async function submitRun(
  message: string,
  conversationId = browser.conversationId,
): Promise<{ readonly body: string; readonly run: StoredRun; readonly frames: readonly ClientFrame[] }> {
  const before = await runIds();
  const response = await gateway.inject({
    method: "POST",
    url: `/client/v1/conversations/${conversationId}/runs`,
    headers: browser.mutationHeaders,
    payload: { message },
  });
  assert.equal(response.statusCode, 200);
  return Object.freeze({
    body: response.body,
    run: await onlyNewRun(before),
    frames: frames(response.body),
  });
}

async function retryRun(
  conversationId = browser.conversationId,
): Promise<{ readonly body: string; readonly response: Awaited<ReturnType<typeof gateway.inject>> }> {
  const response = await gateway.inject({
    method: "POST",
    url: `/client/v1/conversations/${conversationId}/retries`,
    headers: browser.mutationHeaders,
  });
  return Object.freeze({ body: response.body, response });
}

async function assertDurableFailure(
  result: Awaited<ReturnType<typeof submitRun>>,
  expectedCode: AgentRunFailureCode,
  expectedReason: ClientRunFailureReason,
  options: { readonly partial?: boolean } = {},
): Promise<void> {
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.failure_code, expectedCode);
  assert.equal(typeof result.run.failure_summary, "string");
  assert((result.run.failure_summary?.length ?? 0) > 0);
  assert.deepEqual(result.frames.at(-1), { type: "run.failed", reason: expectedReason });
  assert.equal(mapAgentRunFailureCode(expectedCode), expectedReason);
  assert.doesNotMatch(result.body, publicForbidden);
  assert.doesNotMatch(result.body, new RegExp(expectedCode, "u"));
  assert.equal(result.body.includes(result.run.run_id), false);
  assert.equal(result.body.includes(result.run.failure_summary!), false);

  const failedEvents = await harness.db.selectFrom("product_events")
    .select(["event_type", "payload"])
    .where("run_id", "=", result.run.run_id)
    .where("event_type", "=", "run.failed")
    .execute();
  assert.equal(failedEvents.length, 1);
  assert.equal(payloadRecord(failedEvents[0]!.payload).failure_code, expectedCode);
  const deltas = result.frames.filter((frame) => frame.type === "message.delta");
  assert.equal(deltas.length > 0, options.partial === true);
  const assistantMessages = await harness.db.selectFrom("messages")
    .select("message_id")
    .where("run_id", "=", result.run.run_id)
    .where("role", "=", "assistant")
    .execute();
  assert.equal(assistantMessages.length, 0);
}

test.before(async () => {
  harness = await createIntegrationHarness("conversation-reliability");
  provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  staticRoot = await mkdtemp(join(tmpdir(), "core-agent-reliability-web-"));
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Core Agent</title>", "utf8");
  gateway = await buildClientGatewayApp({
    port: createRuntimeChatPort(managedSession()),
    staticRoot,
  });
  browser = await bootstrapBrowser();
});

test.after(async () => {
  await gateway?.close();
  await harness?.close();
  if (staticRoot !== undefined) await rm(staticRoot, { recursive: true, force: true });
});

test("happy path completes through Worker, durable events, and the public Gateway", async () => {
  harness.fakeHermes.enqueue(HERMES_CONVERSATION_SCENARIOS.happy_path);
  const result = await submitRun("Synthetic reliability happy path");
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.failure_code, null);
  assert.equal(result.run.failure_summary, null);
  assert.deepEqual(result.frames.map((frame) => frame.type), [
    "run.started",
    "message.delta",
    "message.delta",
    "message.completed",
    "run.completed",
  ]);
  assert.doesNotMatch(result.body, publicForbidden);
});

test("provider failures persist one closed code and expose only a public reason", async () => {
  const scenarios = [
    ["busy", HERMES_CONVERSATION_SCENARIOS.busy, "MODEL_BUSY", "BUSY", false],
    ["unavailable", HERMES_CONVERSATION_SCENARIOS.unavailable, "MODEL_SERVICE_UNAVAILABLE", "TEMPORARILY_UNAVAILABLE", false],
    ["timeout", HERMES_CONVERSATION_SCENARIOS.timeout, "MODEL_RESPONSE_TIMEOUT", "TOOK_TOO_LONG", false],
    ["denied", HERMES_CONVERSATION_SCENARIOS.denied, "MODEL_ACCESS_DENIED", "SERVICE_UNAVAILABLE", false],
    ["missing model", HERMES_CONVERSATION_SCENARIOS.missing_model, "MODEL_NOT_AVAILABLE", "SERVICE_UNAVAILABLE", false],
    ["malformed response", HERMES_CONVERSATION_SCENARIOS.malformed_response, "MODEL_RESPONSE_INVALID", "TEMPORARILY_UNAVAILABLE", false],
    ["mid-stream interruption", HERMES_CONVERSATION_SCENARIOS.mid_stream_interruption, "MODEL_STREAM_INTERRUPTED", "REPLY_INTERRUPTED", true],
    ["empty response", HERMES_CONVERSATION_SCENARIOS.empty_response, "MODEL_EMPTY_RESPONSE", "NO_REPLY", false],
    ["unknown managed error", HERMES_CONVERSATION_SCENARIOS.unknown_error, "MODEL_RESPONSE_INVALID", "TEMPORARILY_UNAVAILABLE", false],
  ] as const satisfies readonly (readonly [
    string,
    (typeof HERMES_CONVERSATION_SCENARIOS)[keyof typeof HERMES_CONVERSATION_SCENARIOS],
    AgentRunFailureCode,
    ClientRunFailureReason,
    boolean,
  ])[];

  for (const [label, script, code, reason, partial] of scenarios) {
    harness.fakeHermes.enqueue(script);
    const result = await submitRun(`Synthetic reliability ${label}`);
    await assertDurableFailure(result, code, reason, { partial });
  }
});

test("Runtime inspection failure is durable but only exposes assistant preparation", async () => {
  harness.fakeSupervisor.enqueue({
    kind: "reject",
    retryable: false,
    summary: "Synthetic runtime inspection rejection",
  });
  const result = await submitRun("Synthetic runtime not ready");
  await assertDurableFailure(result, "AGENT_RUNTIME_NOT_READY", "ASSISTANT_PREPARING");
  const retry = await retryRun();
  assert.equal(retry.response.statusCode, 409);
  assert.deepEqual(retry.response.json(), {
    error: {
      code: "CLIENT_RETRY_UNAVAILABLE",
      message: "This reply cannot be retried.",
    },
  });
});

test("concurrent retry requests create one child and replay its public frames", async () => {
  harness.fakeHermes.enqueue(HERMES_CONVERSATION_SCENARIOS.busy);
  const parent = await submitRun("Synthetic coalesced retry parent");
  const executionsBefore = harness.fakeHermes.executionCallCount;
  const release = harness.fakeHermes.holdNextSuccess();
  const first = retryRun();
  await eventually(
    async () => harness.fakeHermes.executionCallCount,
    (count) => count === executionsBefore + 1,
    "one retry execution",
  );
  const second = retryRun();
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.response.statusCode, 200);
  assert.equal(secondResult.response.statusCode, 200);
  assert.deepEqual(frames(firstResult.body), frames(secondResult.body));
  assert.equal(frames(firstResult.body).at(-1)?.type, "run.completed");
  assert.equal(harness.fakeHermes.executionCallCount, executionsBefore + 1);
  const children = await harness.db.selectFrom("agent_runs")
    .select(["run_id", "parent_run_id", "status"])
    .where("parent_run_id", "=", parent.run.run_id)
    .execute();
  assert.equal(children.length, 1);
  assert.equal(children[0]!.status, "succeeded");

  const replayed = await retryRun();
  assert.equal(replayed.response.statusCode, 200);
  assert.deepEqual(frames(replayed.body), frames(firstResult.body));
  assert.equal(harness.fakeHermes.executionCallCount, executionsBefore + 1);
});

test("a failed retry advances the auditable parent to the failed child", async () => {
  harness.fakeHermes.enqueue(HERMES_CONVERSATION_SCENARIOS.busy);
  const parent = await submitRun("Synthetic retry chain parent");
  harness.fakeHermes.enqueue(HERMES_CONVERSATION_SCENARIOS.unavailable);
  const firstRetry = await retryRun();
  assert.equal(firstRetry.response.statusCode, 200);
  assert.deepEqual(frames(firstRetry.body).at(-1), {
    type: "run.failed",
    reason: "TEMPORARILY_UNAVAILABLE",
  });
  const child = await harness.db.selectFrom("agent_runs")
    .select(["run_id", "parent_run_id", "status"])
    .where("parent_run_id", "=", parent.run.run_id)
    .executeTakeFirstOrThrow();
  assert.equal(child.status, "failed");

  harness.fakeHermes.enqueue(HERMES_CONVERSATION_SCENARIOS.happy_path);
  const secondRetry = await retryRun();
  assert.equal(secondRetry.response.statusCode, 200);
  assert.equal(frames(secondRetry.body).at(-1)?.type, "run.completed");
  const grandchild = await harness.db.selectFrom("agent_runs")
    .select(["parent_run_id", "status"])
    .where("parent_run_id", "=", child.run_id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(grandchild, { parent_run_id: child.run_id, status: "succeeded" });
});

test("unsafe-to-replay recovery survives API and Worker restart without another provider call", async () => {
  const internalConversation = await harness.createConversation({
    tenant_id: provisioned.tenant_id,
    profile_id: provisioned.profile_ids[0]!,
  });
  const callsBefore = harness.fakeHermes.executionCallCount;
  const release = harness.fakeHermes.holdNextSuccess();
  const run = await harness.createRun(
    internalConversation.conversation_id,
    "Synthetic unsafe recovery",
    { tenantId: provisioned.tenant_id },
  );
  await eventually(
    async () => harness.fakeHermes.executionCallCount,
    (count) => count === callsBefore + 1,
    "dispatched Hermes request",
  );
  await harness.stopWorker();
  release();
  const interrupted = await harness.db.selectFrom("worker_jobs")
    .select(["status", "effect_state"])
    .where("run_id", "=", run.run_id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(interrupted, { status: "running", effect_state: "unsafe_to_replay" });
  await harness.db.updateTable("worker_jobs").set({
    lease_expires_at: new Date(0),
  }).where("run_id", "=", run.run_id).execute();
  await harness.restartApi();
  await harness.startWorker("worker_recovered_after_dispatch");
  await harness.worker.untilRunStatus(run.run_id, "failed");
  const stored = await harness.getRun(run.run_id);
  assert.equal(stored.failure_code, "RUN_INTERNAL_ERROR");
  assert.equal(mapAgentRunFailureCode(stored.failure_code), "UNKNOWN");
  assert.equal(harness.fakeHermes.executionCallCount, callsBefore + 1);
  const failedEvents = await harness.db.selectFrom("product_events")
    .select("event_id")
    .where("run_id", "=", run.run_id)
    .where("event_type", "=", "run.failed")
    .execute();
  assert.equal(failedEvents.length, 1);
});

test("public Conversation identifiers cannot be used to cross access retry state", async () => {
  const created = await gateway.inject({
    method: "POST",
    url: "/client/v1/conversations",
    headers: browser.mutationHeaders,
    payload: {},
  });
  assert.equal(created.statusCode, 201);
  const foreignPublicId = (created.json() as { id: string }).id;
  const absent = await retryRun("chat_00000000000000000000000000000000");
  const foreign = await retryRun(foreignPublicId);
  assert.equal(absent.response.statusCode, 404);
  assert.equal(foreign.response.statusCode, 409);
  assert.doesNotMatch(absent.body, /conversation_/u);
  assert.doesNotMatch(foreign.body, /conversation_/u);
});
