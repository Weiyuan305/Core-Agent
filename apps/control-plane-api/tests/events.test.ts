import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import test from "node:test";

import type { ProductEvent } from "@core-agent/contracts";
import { appendProductEvents, withTenantTransaction } from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import {
  BoundedTimerEventNotifier,
  formatSseEvent,
  parseEventCursor,
  writeSseChunk,
  type EventNotifier,
  type EventWaitInput,
} from "../src/sse.js";
import {
  buildHttpAdmissionApp,
  createRuntimeDatabase,
  resetHttpAdmissionDatabase,
  seedHttpReadyTenant,
  trustedContextHeaders,
} from "./admission-http-test-support.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);
const now = new Date("2026-08-05T02:00:00.000Z");

interface ParsedSseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: ProductEvent;
}

class ManualEventNotifier implements EventNotifier {
  private credits = 0;
  private readonly waiters: Array<() => void> = [];
  private waitCalls = 0;
  private readonly waitObservers: Array<() => void> = [];

  public async waitUntilWaiting(): Promise<void> {
    if (this.waitCalls > 0) return;
    await new Promise<void>((resolve) => this.waitObservers.push(resolve));
  }

  public wake(): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.credits += 1;
    else waiter();
  }

  public async wait(input: EventWaitInput): Promise<void> {
    this.waitCalls += 1;
    for (const observer of this.waitObservers.splice(0)) observer();
    if (this.credits > 0) {
      this.credits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        input.signal.removeEventListener("abort", finish);
        const index = this.waiters.indexOf(finish);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      };
      input.signal.addEventListener("abort", finish, { once: true });
      this.waiters.push(finish);
    });
  }
}

async function seedConversationAndRun(
  tenantId: string,
  conversationId: string,
  runId?: string,
): Promise<void> {
  const profileId = await seedHttpReadyTenant(db, tenantId);
  await db.insertInto("conversations").values({
    tenant_id: tenantId,
    conversation_id: conversationId,
    profile_id: profileId,
    created_by_actor_id: `owner_${tenantId}`,
    status: "active",
    schema_version: 1,
    resource_version: 1,
    student_ref: null,
    case_ref: null,
    created_at: now,
    updated_at: now,
  }).execute();
  if (runId === undefined) return;
  await db.insertInto("agent_runs").values({
    tenant_id: tenantId,
    run_id: runId,
    conversation_id: conversationId,
    request_id: "request_events",
    trace_id: "trace_events",
    client_request_id: "client_events",
    idempotency_key: "idempotency_events",
    parent_run_id: null,
    schema_version: 1,
    resource_version: 1,
    status: "running",
    started_at: now,
    finished_at: null,
    failure_summary: null,
    created_at: now,
    updated_at: now,
  }).execute();
}

async function appendSyntheticEvents(
  tenantId: string,
  conversationId: string,
  runId: string,
  indexes: readonly number[],
): Promise<void> {
  await withTenantTransaction(db, tenantId, (context) => appendProductEvents(context, {
    streamId: `conversation_${conversationId}`,
    deliveryTarget: "internal_event_stream",
    events: indexes.map((index) => ({
      schema_version: 1,
      event_id: `event_${conversationId}_${index}`,
      occurred_at: `2026-08-03T12:00:0${index}.000Z`,
      tenant_id: tenantId,
      request_id: "request_events",
      trace_id: "trace_events",
      correlation_id: conversationId,
      causation_id: runId,
      conversation_id: conversationId,
      run_id: runId,
      event_type: "message.delta",
      payload: { message_id: "message_events", delta: `Synthetic ${index}` },
    })),
  }));
}

async function listen(app: FastifyInstance): Promise<{ host: string; port: number }> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Test API did not bind a TCP port");
  return { host: "127.0.0.1", port: address.port };
}

async function collectSse(
  endpoint: { host: string; port: number },
  conversationId: string,
  tenantId: string,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly afterSequence?: string;
    readonly eventCount?: number;
    readonly heartbeatCount?: number;
  },
): Promise<{ readonly events: readonly ParsedSseEvent[]; readonly heartbeats: number; readonly headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const events: ParsedSseEvent[] = [];
    let heartbeats = 0;
    const request = httpRequest({
      ...endpoint,
      method: "GET",
      path: `/internal/v1/conversations/${conversationId}/events${
        options.afterSequence === undefined ? "" : `?after_sequence=${encodeURIComponent(options.afterSequence)}`
      }`,
      headers: {
        ...trustedContextHeaders({
          tenantId,
          profileId: `profile_${tenantId}`,
          conversationId,
          runId: `run_context_${conversationId}`,
        }),
        ...options.headers,
      },
    });
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for SSE frames")), 3_000);
    timeout.unref();
    const finish = (error: Error | undefined, result?: { events: readonly ParsedSseEvent[]; heartbeats: number; headers: IncomingHttpHeaders }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.destroy();
      if (error === undefined && result !== undefined) resolve(result);
      else reject(error ?? new Error("SSE collection failed"));
    };
    request.once("error", (error) => {
      if (!settled) finish(error);
    });
    request.once("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(new Error(`Unexpected SSE status ${response.statusCode}`));
        return;
      }
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        while (buffer.includes("\n\n")) {
          const boundary = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame === ": heartbeat") {
            heartbeats += 1;
          } else {
            const lines = Object.fromEntries(frame.split("\n").map((line) => {
              const separator = line.indexOf(": ");
              return [line.slice(0, separator), line.slice(separator + 2)];
            }));
            events.push({ id: lines.id!, event: lines.event!, data: JSON.parse(lines.data!) as ProductEvent });
          }
          if (
            events.length >= (options.eventCount ?? Number.POSITIVE_INFINITY)
            || heartbeats >= (options.heartbeatCount ?? Number.POSITIVE_INFINITY)
          ) {
            const result = { events: [...events], heartbeats, headers: response.headers };
            response.destroy();
            finish(undefined, result);
            return;
          }
        }
      });
      response.once("error", (error) => {
        if (!settled) finish(error);
      });
      response.once("end", () => {
        if (!settled) finish(new Error("SSE response ended before the requested frames arrived"));
      });
    });
    request.end();
  });
}

test.after(async () => { await db.destroy(); });

test("SSE conversation events route is registered", async () => {
  await resetHttpAdmissionDatabase(pool);
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db);
  try {
    assert.equal(app.hasRoute({
      method: "GET",
      url: "/internal/v1/conversations/:conversation_id/events",
    }), true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SSE conversation stream closes when its trusted context expires", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_expiry";
  const conversationId = "expiry_1";
  await seedConversationAndRun(tenantId, conversationId);
  const notifier = new ManualEventNotifier();
  const built = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: notifier });
  try {
    const endpoint = await listen(built.app);
    const headers = trustedContextHeaders({
      tenantId,
      profileId: `profile_${tenantId}`,
      conversationId,
      runId: `run_context_${conversationId}`,
      issuedAt: "2026-08-05T01:59:59.900Z",
      expiresAt: "2026-08-05T02:00:00.100Z",
    });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest({
        ...endpoint,
        method: "GET",
        path: `/internal/v1/conversations/${conversationId}/events`,
        headers,
      });
      const timeout = setTimeout(() => {
        request.destroy();
        reject(new Error("SSE stream outlived its trusted context"));
      }, 1_500);
      request.once("error", reject);
      request.once("response", (response) => {
        assert.equal(response.statusCode, 200);
        response.resume();
        response.once("end", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      request.end();
    });
  } finally {
    await built.app.close();
    await rm(built.directory, { recursive: true, force: true });
  }
});

test("strict SSE cursor parsing accepts canonical safe decimals and rejects ambiguity", () => {
  assert.equal(parseEventCursor({ lastEventId: undefined, rawHeaders: [], afterSequence: undefined }), 0);
  assert.equal(parseEventCursor({ lastEventId: "0", rawHeaders: ["Last-Event-ID", "0"], afterSequence: undefined }), 0);
  assert.equal(parseEventCursor({ lastEventId: "42", rawHeaders: ["last-event-id", "42"], afterSequence: "42" }), 42);
  assert.equal(parseEventCursor({ lastEventId: undefined, rawHeaders: [], afterSequence: String(Number.MAX_SAFE_INTEGER) }), Number.MAX_SAFE_INTEGER);
  for (const invalid of ["", "01", "-1", "+1", " 1", "1 ", "1e2", "1.0", String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => parseEventCursor({ lastEventId: invalid, rawHeaders: ["Last-Event-ID", invalid], afterSequence: undefined }), /INVALID_REQUEST/);
  }
  assert.throws(() => parseEventCursor({ lastEventId: ["1", "2"], rawHeaders: ["Last-Event-ID", "1", "Last-Event-ID", "2"], afterSequence: undefined }), /INVALID_REQUEST/);
  assert.throws(() => parseEventCursor({ lastEventId: "1", rawHeaders: ["Last-Event-ID", "1", "Last-Event-ID", "1"], afterSequence: undefined }), /INVALID_REQUEST/);
  assert.throws(() => parseEventCursor({ lastEventId: "1", rawHeaders: ["Last-Event-ID", "1"], afterSequence: "2" }), /INVALID_REQUEST/);
  assert.throws(() => parseEventCursor({ lastEventId: undefined, rawHeaders: [], afterSequence: ["1", "1"] }), /INVALID_REQUEST/);
});

test("SSE frame serializes the complete validated ProductEvent exactly once", () => {
  const event: ProductEvent = {
    schema_version: 1,
    event_id: "event_42",
    occurred_at: "2026-08-03T12:00:00.000Z",
    sequence: 42,
    tenant_id: "tenant_1",
    request_id: "request_1",
    trace_id: "trace_1",
    correlation_id: "conversation_1",
    causation_id: "run_1",
    conversation_id: "conversation_1",
    run_id: "run_1",
    event_type: "message.delta",
    payload: { message_id: "message_1", delta: "Synthetic\nvalue" },
  };
  assert.equal(formatSseEvent(event), `id: 42\nevent: message.delta\ndata: ${JSON.stringify(event)}\n\n`);
});

test("production notifier waits 15 seconds and resolves promptly on abort", async () => {
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  let cleared = false;
  const notifier = new BoundedTimerEventNotifier({
    setTimeout(handler, milliseconds) { callback = handler; delay = milliseconds; return "timer"; },
    clearTimeout(handle) { assert.equal(handle, "timer"); cleared = true; },
  });
  const timeoutController = new AbortController();
  const timedWait = notifier.wait({ tenantId: "tenant_1", streamId: "conversation_1", signal: timeoutController.signal });
  assert.equal(delay, 15_000);
  callback!();
  await timedWait;
  const abortController = new AbortController();
  const abortedWait = notifier.wait({ tenantId: "tenant_1", streamId: "conversation_1", signal: abortController.signal });
  abortController.abort();
  await abortedWait;
  assert.equal(cleared, true);
});

test("SSE writes wait for backpressure drain and stop waiting on abort", async () => {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write: () => false,
  }) as unknown as ServerResponse;
  const controller = new AbortController();
  const drained = writeSseChunk(response, "data: synthetic\n\n", controller.signal);
  let settled = false;
  void drained.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  response.emit("drain");
  assert.equal(await drained, true);

  const abortedController = new AbortController();
  const aborted = writeSseChunk(response, "data: synthetic\n\n", abortedController.signal);
  abortedController.abort();
  assert.equal(await aborted, false);
});

test("SSE resumes strictly after Last-Event-ID from persisted rows across an API restart", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_resume";
  const conversationId = "resume_1";
  const runId = "run_resume_1";
  await seedConversationAndRun(tenantId, conversationId, runId);
  await appendSyntheticEvents(tenantId, conversationId, runId, [1, 2, 3, 4]);

  const notifierA = new ManualEventNotifier();
  const first = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: notifierA });
  try {
    const endpoint = await listen(first.app);
    const response = await collectSse(endpoint, conversationId, tenantId, { eventCount: 2 });
    assert.deepEqual(response.events.map((event) => event.id), ["1", "2"]);
  } finally {
    await first.app.close();
    await rm(first.directory, { recursive: true, force: true });
  }

  const notifierB = new ManualEventNotifier();
  const second = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: notifierB });
  try {
    const endpoint = await listen(second.app);
    const response = await collectSse(endpoint, conversationId, tenantId, {
      headers: { "Last-Event-ID": "2" },
      eventCount: 2,
    });
    assert.deepEqual(response.events.map((event) => event.id), ["3", "4"]);
    assert.deepEqual(response.events.map((event) => event.event), ["message.delta", "message.delta"]);
    assert.deepEqual(response.events.map((event) => event.data.sequence), [3, 4]);
    assert.equal(response.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(response.headers["cache-control"], "no-cache, no-transform");
    assert.equal(response.headers["x-accel-buffering"], "no");
    const firstConnectionResume = await collectSse(endpoint, conversationId, tenantId, {
      afterSequence: "2",
      eventCount: 2,
    });
    assert.deepEqual(firstConnectionResume.events.map((event) => event.id), ["3", "4"]);
  } finally {
    await second.app.close();
    await rm(second.directory, { recursive: true, force: true });
  }
});

test("notifier wake re-queries the database before streaming newly persisted events", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_notify";
  const conversationId = "notify_1";
  const runId = "run_notify_1";
  await seedConversationAndRun(tenantId, conversationId, runId);
  const notifier = new ManualEventNotifier();
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: notifier });
  try {
    const pending = collectSse(await listen(app), conversationId, tenantId, { eventCount: 1 });
    await notifier.waitUntilWaiting();
    await appendSyntheticEvents(tenantId, conversationId, runId, [1]);
    notifier.wake();
    const response = await pending;
    assert.deepEqual(response.events.map((event) => event.id), ["1"]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty notifier wake re-queries persisted events before sending a heartbeat", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_heartbeat";
  const conversationId = "heartbeat_1";
  await seedConversationAndRun(tenantId, conversationId);
  const notifier = new ManualEventNotifier();
  notifier.wake();
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: notifier });
  try {
    const response = await collectSse(await listen(app), conversationId, tenantId, { heartbeatCount: 1 });
    assert.equal(response.heartbeats, 1);
    assert.deepEqual(response.events, []);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disconnect does not mutate the active Run", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_disconnect";
  const conversationId = "disconnect_1";
  const runId = "run_disconnect_1";
  await seedConversationAndRun(tenantId, conversationId, runId);
  const notifier = new ManualEventNotifier();
  notifier.wake();
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: notifier });
  try {
    await collectSse(await listen(app), conversationId, tenantId, { heartbeatCount: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const run = await db.selectFrom("agent_runs").select("status")
      .where("tenant_id", "=", tenantId).where("run_id", "=", runId).executeTakeFirstOrThrow();
    assert.equal(run.status, "running");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cross-tenant conversation and invalid cursor fail with JSON before SSE headers", async () => {
  await resetHttpAdmissionDatabase(pool);
  const tenantId = "tenant_http_events_errors";
  const conversationId = "errors_1";
  await seedConversationAndRun(tenantId, conversationId);
  const { app, directory } = await buildHttpAdmissionApp(databaseUrl, db, { eventNotifier: new ManualEventNotifier() });
  try {
    const crossTenant = await app.inject({
      method: "GET",
      url: `/internal/v1/conversations/${conversationId}/events`,
      headers: trustedContextHeaders({
        tenantId: "tenant_other", profileId: "profile_tenant_other", conversationId,
        runId: "run_context_errors",
      }),
    });
    const absent = await app.inject({
      method: "GET",
      url: "/internal/v1/conversations/absent/events",
      headers: trustedContextHeaders({
        tenantId, profileId: `profile_${tenantId}`, conversationId: "absent", runId: "run_context_absent",
      }),
    });
    const invalidCursor = await app.inject({
      method: "GET",
      url: `/internal/v1/conversations/${conversationId}/events`,
      headers: {
        ...trustedContextHeaders({
          tenantId, profileId: `profile_${tenantId}`, conversationId, runId: "run_context_errors",
        }),
        "last-event-id": "01",
      },
    });
    assert.equal(crossTenant.statusCode, 404);
    assert.equal(absent.statusCode, 404);
    assert.equal(invalidCursor.statusCode, 400);
    assert.equal((crossTenant.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
    assert.equal((absent.json() as { code: string }).code, "RESOURCE_NOT_FOUND");
    assert.equal(
      (crossTenant.json() as { message: string }).message,
      (absent.json() as { message: string }).message,
    );
    assert.equal((invalidCursor.json() as { code: string }).code, "INVALID_REQUEST");
    assert.match(crossTenant.headers["content-type"] ?? "", /^application\/json/);
    assert.match(invalidCursor.headers["content-type"] ?? "", /^application\/json/);
    assert.notEqual(crossTenant.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.notEqual(invalidCursor.headers["content-type"], "text/event-stream; charset=utf-8");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
