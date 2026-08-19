import assert from "node:assert/strict";
import test from "node:test";

import {
  handleFinalizeAccountDeletion,
  type AccountDeletionFinalizationPort,
} from "../src/handlers/finalize-account-deletion.js";

const baseJob = Object.freeze({
  tenantId: "tenant_deletion",
  jobId: "job_finalize_deletion",
  payloadRef: "account_deletion_01",
  attemptCount: 1,
  maxAttempts: 5,
  effectState: "pre_effect" as const,
  recoveryOnly: false,
});

function port(calls: string[], overrides: Partial<AccountDeletionFinalizationPort> = {}): AccountDeletionFinalizationPort {
  return {
    load: async () => ({
      kind: "due", providerSubjects: ["provider-subject-a", "provider-subject-b"], nextCursor: null, done: true,
    }),
    markEffectDispatched: async () => { calls.push("mark"); return true; },
    inspectProviderSubject: async (subject) => { calls.push(`inspect:${subject}`); return "present"; },
    deleteProviderSubject: async (subject) => { calls.push(`delete:${subject}`); },
    finalize: async () => { calls.push("finalize"); return "deleted"; },
    succeed: async () => { calls.push("succeed"); return true; },
    retry: async (_job, summary) => { calls.push(`retry:${summary}`); return true; },
    fail: async (_job, summary) => { calls.push(`fail:${summary}`); return true; },
    ...overrides,
  };
}

test("finalizer fences the external effect, inspects every subject, deletes present users, then atomically finalizes Core", async () => {
  const calls: string[] = [];
  const result = await handleFinalizeAccountDeletion(port(calls), baseJob, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(calls, [
    "mark",
    "inspect:provider-subject-a", "delete:provider-subject-a",
    "inspect:provider-subject-b", "delete:provider-subject-b",
    "finalize", "succeed",
  ]);
});

test("finalizer pages every provider subject while fencing the external effect exactly once", async () => {
  const calls: string[] = [];
  const firstPage = Array.from({ length: 50 }, (_, index) => `provider-subject-${String(index).padStart(2, "0")}`);
  const secondPage = ["provider-subject-50", "provider-subject-51"];
  const result = await handleFinalizeAccountDeletion(port(calls, {
    load: async (_job, cursor, limit) => {
      calls.push(`load:${cursor ?? "start"}:${limit}`);
      return cursor === null
        ? { kind: "due", providerSubjects: firstPage, nextCursor: firstPage.at(-1)!, done: false }
        : { kind: "due", providerSubjects: secondPage, nextCursor: null, done: true };
    },
    inspectProviderSubject: async (subject) => { calls.push(`inspect:${subject}`); return "absent"; },
  }), baseJob, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.equal(calls.filter((call) => call === "mark").length, 1);
  assert.deepEqual(calls.filter((call) => call.startsWith("load:")), [
    "load:start:50", "load:provider-subject-49:50",
  ]);
  assert.equal(calls.filter((call) => call.startsWith("inspect:")).length, 52);
  assert.deepEqual(calls.slice(-2), ["finalize", "succeed"]);
});

test("unsafe recovery inspects provider authority and never repeats an absent external effect", async () => {
  const calls: string[] = [];
  const result = await handleFinalizeAccountDeletion(port(calls, {
    inspectProviderSubject: async (subject) => { calls.push(`inspect:${subject}`); return "absent"; },
  }), { ...baseJob, attemptCount: 5, effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(calls, ["inspect:provider-subject-a", "inspect:provider-subject-b", "finalize", "succeed"]);
});

test("ambiguous provider inspection and post-provider Core failure use fixed non-sensitive summaries", async () => {
  const inspectionCalls: string[] = [];
  const inspection = await handleFinalizeAccountDeletion(port(inspectionCalls, {
    inspectProviderSubject: async () => { throw new Error("provider-subject-sensitive token=secret"); },
  }), { ...baseJob, attemptCount: 2, effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.deepEqual(inspection, { kind: "retry", summary: "Identity provider deletion is unavailable" });
  assert.deepEqual(inspectionCalls, ["retry:Identity provider deletion is unavailable"]);

  const finalizeCalls: string[] = [];
  const finalize = await handleFinalizeAccountDeletion(port(finalizeCalls, {
    inspectProviderSubject: async (subject) => { finalizeCalls.push(`inspect:${subject}`); return "absent"; },
    finalize: async () => { throw new Error("Core finalization unavailable"); },
  }), { ...baseJob, attemptCount: 2, effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.deepEqual(finalize, { kind: "retry", summary: "Account deletion Core finalization is unavailable" });
  assert.deepEqual(finalizeCalls, [
    "inspect:provider-subject-a", "inspect:provider-subject-b", "retry:Account deletion Core finalization is unavailable",
  ]);
});

test("only cancelled and deleted rows terminalize without provider effects", async () => {
  for (const kind of ["cancelled", "deleted"] as const) {
    const calls: string[] = [];
    const result = await handleFinalizeAccountDeletion(port(calls, {
      load: async () => ({ kind, providerSubjects: [], nextCursor: null, done: true }),
    }), baseJob, new AbortController().signal);
    assert.deepEqual(result, { kind: "succeeded" });
    assert.deepEqual(calls, ["succeed"]);
  }
});

test("not-due and missing deletion authority retry instead of losing the finalizer job", async () => {
  for (const [kind, summary] of [
    ["not_due", "Account deletion finalization is not due"],
    ["not_found", "Account deletion authority is unavailable"],
  ] as const) {
    const calls: string[] = [];
    const result = await handleFinalizeAccountDeletion(port(calls, {
      load: async () => ({ kind, providerSubjects: [], nextCursor: null, done: true }),
    }), baseJob, new AbortController().signal);
    assert.deepEqual(result, { kind: "retry", summary });
    assert.deepEqual(calls, [`retry:${summary}`]);
  }
});

test("failure classification never invokes an Error message accessor", async () => {
  let accessorCalls = 0;
  const hostile = new Error("unused");
  Object.defineProperty(hostile, "message", {
    configurable: true,
    get() {
      accessorCalls += 1;
      throw new Error("message accessor must not run");
    },
  });
  const calls: string[] = [];
  const result = await handleFinalizeAccountDeletion(port(calls, {
    inspectProviderSubject: async () => { throw hostile; },
  }), { ...baseJob, attemptCount: 2, effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.deepEqual(result, { kind: "retry", summary: "Identity provider deletion is unavailable" });
  assert.deepEqual(calls, ["retry:Identity provider deletion is unavailable"]);
  assert.equal(accessorCalls, 0);
});

test("final attempt terminalizes a bounded redacted failure and lease loss never reports ownership", async () => {
  const calls: string[] = [];
  const failed = await handleFinalizeAccountDeletion(port(calls, {
    inspectProviderSubject: async () => { throw new Error("Bearer provider-secret failed"); },
  }), { ...baseJob, attemptCount: 5, effectState: "unsafe_to_replay", recoveryOnly: true }, new AbortController().signal);
  assert.deepEqual(failed, { kind: "failed", summary: "Identity provider deletion is unavailable" });
  assert.deepEqual(calls, ["fail:Identity provider deletion is unavailable"]);

  const leaseLost = await handleFinalizeAccountDeletion(port([], {
    markEffectDispatched: async () => false,
  }), baseJob, new AbortController().signal);
  assert.deepEqual(leaseLost, { kind: "failed", summary: "Worker job lease lost" });
});
