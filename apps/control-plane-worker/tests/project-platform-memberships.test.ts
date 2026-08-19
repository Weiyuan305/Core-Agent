import assert from "node:assert/strict";
import test from "node:test";

import { handleProjectPlatformMemberships } from "../src/handlers/project-platform-memberships.js";

const baseJob = {
  tenantId: "tenant_scope",
  jobId: "job_platform_projection",
  payloadRef: "platform_assignment_a",
  attemptCount: 1,
  maxAttempts: 5,
};

test("platform Membership projection drains every deterministic page before completing the owned job", async () => {
  const calls: Array<{ assignmentId: string; cursor: string | null; limit: number }> = [];
  let completed = 0;
  const result = await handleProjectPlatformMemberships({
    project: async (assignmentId, cursor, limit) => {
      calls.push({ assignmentId, cursor, limit });
      return cursor === null
        ? { processed: 100, nextCursor: "tenant_100", done: false }
        : { processed: 7, nextCursor: null, done: true };
    },
    succeed: async () => { completed += 1; return true; },
    retry: async () => true,
    fail: async () => true,
  }, baseJob, new AbortController().signal);

  assert.deepEqual(result, { kind: "succeeded" });
  assert.equal(completed, 1);
  assert.deepEqual(calls, [
    { assignmentId: "platform_assignment_a", cursor: null, limit: 100 },
    { assignmentId: "platform_assignment_a", cursor: "tenant_100", limit: 100 },
  ]);
});

test("platform Membership projection retries a replay-safe failed page under the lease fence", async () => {
  const calls: string[] = [];
  const result = await handleProjectPlatformMemberships({
    project: async () => { throw new Error("synthetic Bearer secret failure"); },
    succeed: async () => { calls.push("succeed"); return true; },
    retry: async (_job, summary) => { calls.push(`retry:${summary}`); return true; },
    fail: async () => { calls.push("fail"); return true; },
  }, baseJob, new AbortController().signal);

  assert.deepEqual(result, { kind: "retry", summary: "synthetic Bearer [REDACTED] failure" });
  assert.deepEqual(calls, ["retry:synthetic Bearer [REDACTED] failure"]);
});

test("final projection failure terminalizes without reporting false success", async () => {
  const result = await handleProjectPlatformMemberships({
    project: async () => { throw new Error("stored projection is invalid"); },
    succeed: async () => true,
    retry: async () => true,
    fail: async () => true,
  }, { ...baseJob, attemptCount: 5 }, new AbortController().signal);

  assert.deepEqual(result, { kind: "failed", summary: "stored projection is invalid" });
});

test("projection refuses a non-advancing cursor and preserves lease-loss ownership", async () => {
  const stuck = await handleProjectPlatformMemberships({
    project: async () => ({ processed: 100, nextCursor: "tenant_100", done: false }),
    succeed: async () => true,
    retry: async () => false,
    fail: async () => true,
  }, baseJob, new AbortController().signal);
  assert.deepEqual(stuck, { kind: "failed", summary: "Worker job lease lost" });

  const controller = new AbortController();
  controller.abort();
  let projected = 0;
  const aborted = await handleProjectPlatformMemberships({
    project: async () => { projected += 1; return { processed: 0, nextCursor: null, done: true }; },
    succeed: async () => true,
    retry: async () => true,
    fail: async () => true,
  }, baseJob, controller.signal);
  assert.deepEqual(aborted, { kind: "failed", summary: "Worker job lease lost" });
  assert.equal(projected, 0);
});
