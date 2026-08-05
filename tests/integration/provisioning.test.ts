import assert from "node:assert/strict";
import test from "node:test";

import {
  createIntegrationHarness,
  LEAK_SENTINEL,
  type IntegrationHarness,
} from "./harness.js";
import {
  rehash,
  SYNTHETIC_INGRESS_KEY,
} from "./fixtures/synthetic-tenant.js";

let harness: IntegrationHarness;

test.before(async () => {
  harness = await createIntegrationHarness("provisioning");
});

test.after(async () => {
  await harness?.close();
});

test("each integration file owns one strictly named isolated database", () => {
  assert.match(harness.databaseName, /^core_agent_test_[a-f0-9]{16}$/);
});

test("duplicate provisioning creates one tenant runtime job and Supervisor operation", async () => {
  const provisioned = await harness.provisionSyntheticB2B();
  const replay = await harness.requestJson(
    "POST",
    "/internal/v1/tenant-provisioning",
    { payload: provisioned.request },
  );
  assert.equal(replay.status, 202);
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);

  const tenantId = provisioned.tenant_id;
  for (const table of ["tenants", "runtime_containers", "worker_jobs"] as const) {
    const row = await harness.db.selectFrom(table)
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    assert.equal(row.count, "1", table);
  }
  assert.equal(
    harness.fakeSupervisor.requests.filter(
      (request) => request.kind === "provision"
        && request.runtime.tenant_id === tenantId,
    ).length,
    1,
  );
});

test("same idempotency key with a different payload fails before Supervisor", async () => {
  await harness.stopWorker();
  const before = harness.fakeSupervisor.requests.length;
  const provisioned = await harness.provisionSyntheticB2B();
  const changed = rehash({
    ...provisioned.request,
    client_request_id: `${provisioned.request.client_request_id}_changed`,
  });
  const conflict = await harness.requestJson(
    "POST",
    "/internal/v1/tenant-provisioning",
    { payload: changed },
  );
  assert.equal(conflict.status, 409);
  assert.equal((conflict.body as { code: string }).code, "IDEMPOTENCY_CONFLICT");
  assert.equal(harness.fakeSupervisor.requests.length, before);

  await harness.startWorker();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
});

test("Supervisor permanent rejection fails Runtime with a redacted summary", async () => {
  harness.fakeSupervisor.enqueue({
    kind: "reject",
    retryable: false,
    summary: `Permanent rejection Bearer ${SYNTHETIC_INGRESS_KEY} ${LEAK_SENTINEL}`,
  });
  const provisioned = await harness.provisionSyntheticB2B();
  const runtime = await harness.worker.untilRuntimeStatus(
    provisioned.runtime_id,
    "failed",
  );
  const summary = String(runtime.failure_summary);
  assert.equal(summary, "Runtime provisioning failed");
  assert.doesNotMatch(summary, /synthetic-ingress|synthetic-leak/);
});

test("fake Supervisor persists operation ID and hash across restart", async () => {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  const request = harness.fakeSupervisor.requests.find(
    (candidate) => candidate.kind === "provision"
      && candidate.runtime.tenant_id === provisioned.tenant_id,
  );
  assert(request !== undefined);
  const before = harness.fakeSupervisor.requests.length;
  await harness.restartSupervisor();
  const replay = await harness.executeSupervisor(request);
  assert.equal(replay.outcome, "accepted");
  assert.equal(harness.fakeSupervisor.requests.length, before);
});
