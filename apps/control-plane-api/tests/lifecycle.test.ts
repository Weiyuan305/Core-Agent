import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { cleanupFailedAppStartup } from "../src/app.js";

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
