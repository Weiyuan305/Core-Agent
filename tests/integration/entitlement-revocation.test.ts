import assert from "node:assert/strict";
import test from "node:test";

import {
  DomainError,
  loadCurrentSnapshotAuthority,
  recheckCapabilityBeforeEffect,
} from "@core-agent/runtime-core";

import { createIntegrationHarness, type IntegrationHarness } from "./harness.js";
import {
  entitlementSliceInternals,
  prepareB2BEntitlementSlice,
  suspendSliceEntitlement,
  type PreparedEntitlementSlice,
} from "./fixtures/entitlement-slice.js";
import {
  syntheticConversationRequest,
  syntheticRunRequest,
} from "./fixtures/synthetic-tenant.js";

let harness: IntegrationHarness;
let slice: PreparedEntitlementSlice;

test.before(async () => {
  harness = await createIntegrationHarness("entitlement-revocation");
  slice = await prepareB2BEntitlementSlice(harness);
});

test.after(async () => {
  await harness?.close();
});

test("revocation denies new admission and stale pre-effect authority while an already-dispatched model-only Run completes", async () => {
  const conversation = await harness.createConversation({
    tenant_id: slice.tenantId,
    profile_id: slice.profileId,
  });
  const authority = await loadCurrentSnapshotAuthority({
    trx: harness.db,
    tenantId: slice.tenantId,
    profileId: slice.profileId,
    now: new Date(),
  });
  assert.equal(authority.current, true);

  const callsBefore = harness.fakeHermes.executionCallCount;
  const release = harness.fakeHermes.holdNextSuccess();
  let run: Awaited<ReturnType<IntegrationHarness["createRun"]>> | undefined;
  try {
    run = await harness.createRun(
      conversation.conversation_id,
      "Finish only the already-dispatched model response.",
      { tenantId: slice.tenantId },
    );
    await entitlementSliceInternals.waitFor(
      async () => harness.fakeHermes.executionCallCount,
      (count) => count === callsBefore + 1,
      "Hermes dispatch before revocation",
    );
    assert.equal((await harness.db.selectFrom("worker_jobs").select("effect_state")
      .where("tenant_id", "=", slice.tenantId).where("run_id", "=", run.run_id)
      .executeTakeFirstOrThrow()).effect_state, "unsafe_to_replay");

    await suspendSliceEntitlement(slice);

    let externalEffects = 0;
    await assert.rejects(recheckCapabilityBeforeEffect({
      db: harness.db,
      tenantId: slice.tenantId,
      profileId: slice.profileId,
      capabilityId: slice.capabilityId,
      expectedSnapshotRef: authority.snapshotRef,
      effect: async () => { externalEffects += 1; },
    }), (error: unknown) => error instanceof DomainError && error.code === "ENTITLEMENT_DENIED");
    assert.equal(externalEffects, 0);

    const conversationRequest = syntheticConversationRequest(
      slice.tenantId,
      slice.profileId,
      `revoked_${entitlementSliceInternals.suffix(slice.tenantId)}`,
    );
    const deniedConversation = await harness.requestJson("POST", "/internal/v1/conversations", {
      tenantId: slice.tenantId,
      payload: conversationRequest,
    });
    assert.equal(deniedConversation.status, 401);
    assert.equal((deniedConversation.body as { code?: unknown }).code, "UNAUTHENTICATED");

    const deniedRunRequest = syntheticRunRequest(
      `revoked_${entitlementSliceInternals.suffix(slice.tenantId)}`,
      "This new effect must not start.",
    );
    const deniedRun = await harness.requestJson(
      "POST",
      `/internal/v1/conversations/${encodeURIComponent(conversation.conversation_id)}/runs`,
      { tenantId: slice.tenantId, payload: deniedRunRequest },
    );
    assert.equal(deniedRun.status, 401);
    assert.equal((deniedRun.body as { code?: unknown }).code, "UNAUTHENTICATED");
    assert.equal(harness.fakeHermes.executionCallCount, callsBefore + 1);
  } finally {
    release();
  }

  assert(run !== undefined);
  await harness.worker.untilRunStatus(run.run_id, "succeeded");
  await entitlementSliceInternals.waitFor(
    () => harness.db.selectFrom("worker_jobs").select(["status", "lease_owner", "lease_expires_at"])
      .where("tenant_id", "=", slice.tenantId).where("run_id", "=", run.run_id)
      .executeTakeFirst(),
    (job) => job?.status === "succeeded" && job.lease_owner === null && job.lease_expires_at === null,
    "completed Run job lease release",
  );
  assert.equal((await harness.db.selectFrom("agent_runs").select("status")
    .where("tenant_id", "=", slice.tenantId).where("run_id", "=", run.run_id)
    .executeTakeFirstOrThrow()).status, "succeeded");
  const admissionAudit = await harness.db.selectFrom("audit_events").select("entitlement_snapshot_ref")
    .where("tenant_id", "=", slice.tenantId).where("action", "=", "agent_run.create")
    .where("resource_id", "=", run.run_id).executeTakeFirstOrThrow();
  assert.deepEqual(admissionAudit.entitlement_snapshot_ref, authority.snapshotRef);
});
