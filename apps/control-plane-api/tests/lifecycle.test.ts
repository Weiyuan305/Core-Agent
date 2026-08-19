import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Fastify from "fastify";

import { cleanupFailedAppStartup } from "../src/app.js";
import * as sseModule from "../src/sse.js";

test("failed app startup invokes Fastify close hooks and zeroes the bootstrap digest", async () => {
  const app = Fastify();
  const digest = Buffer.alloc(32, 0xa5);
  let onCloseCalls = 0;
  app.addHook("onClose", async () => {
    onCloseCalls += 1;
  });

  await cleanupFailedAppStartup(app, digest);

  assert.equal(onCloseCalls, 1);
  assert.deepEqual(digest, Buffer.alloc(32));
});

test("failed app startup zeroes the digest even when a close hook fails", async () => {
  const app = Fastify();
  const digest = Buffer.alloc(32, 0xa5);
  app.addHook("onClose", async () => {
    throw new Error("synthetic close failure");
  });

  await cleanupFailedAppStartup(app, digest);

  assert.deepEqual(digest, Buffer.alloc(32));
});

test("PostgreSQL event notifier wakes matching streams without losing an early notification", async () => {
  class FakeNotificationClient extends EventEmitter {
    readonly queries: string[] = [];
    releaseCalls = 0;

    async query(sql: string): Promise<void> {
      this.queries.push(sql);
    }

    release(): void {
      this.releaseCalls += 1;
    }
  }

  const client = new FakeNotificationClient();
  const timers = new Set<() => void>();
  const clock = {
    setTimeout(handler: () => void): () => void {
      timers.add(handler);
      return handler;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as () => void);
    },
  };
  const createPostgresEventNotifier = (sseModule as unknown as {
    createPostgresEventNotifier?: (
      pool: { connect(): Promise<FakeNotificationClient> },
      waitClock: typeof clock,
    ) => Promise<{
      wait(input: { tenantId: string; streamId: string; signal: AbortSignal }): Promise<void>;
      close(): Promise<void>;
    }>;
  }).createPostgresEventNotifier;
  assert.equal(typeof createPostgresEventNotifier, "function");

  const notifier = await createPostgresEventNotifier!({ connect: async () => client }, clock);
  assert.deepEqual(client.queries, ["listen core_agent_events"]);

  const controller = new AbortController();
  let settled = false;
  const waiting = notifier.wait({
    tenantId: "tenant_lifecycle",
    streamId: "conversation_lifecycle",
    signal: controller.signal,
  }).then(() => { settled = true; });
  client.emit("notification", {
    channel: "core_agent_events",
    payload: JSON.stringify({
      tenant_id: "tenant_other",
      stream_id: "conversation_lifecycle",
      last_committed_sequence: 1,
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  client.emit("notification", {
    channel: "core_agent_events",
    payload: JSON.stringify({
      tenant_id: "tenant_lifecycle",
      stream_id: "conversation_lifecycle",
      last_committed_sequence: 2,
    }),
  });
  await waiting;
  assert.equal(settled, true);

  client.emit("notification", {
    channel: "core_agent_events",
    payload: JSON.stringify({
      tenant_id: "tenant_lifecycle",
      stream_id: "conversation_early",
      last_committed_sequence: 3,
    }),
  });
  await notifier.wait({
    tenantId: "tenant_lifecycle",
    streamId: "conversation_early",
    signal: controller.signal,
  });

  await notifier.close();
  assert.deepEqual(client.queries, ["listen core_agent_events", "unlisten core_agent_events"]);
  assert.equal(client.releaseCalls, 1);
  assert.equal(timers.size, 0);
});

test("production server owns the PostgreSQL event notifier lifecycle", async () => {
  const source = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(source, /createPostgresEventNotifier\(pool\)/u);
  assert.match(source, /eventNotifier,/u);
  assert.match(source, /await eventNotifier\?\.close\(\)/u);
  assert.match(source, /CONTROL_PLANE_TRUSTED_CONTEXT_KEYS_FILE/u);
  assert.match(source, /loadTrustedContextPublicKeys/u);
  assert.match(source, /expectedIssuer: "identity-gateway"/u);
  assert.match(source, /expectedAudience: "control-plane-api"/u);
});
