import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  createIntegrationHarness,
  LEAK_SENTINEL,
  type IntegrationHarness,
} from "./harness.js";
import {
  rehash,
  syntheticB2BProvisioningRequest,
  syntheticConversationRequest,
  syntheticRuntimeCommand,
} from "./fixtures/synthetic-tenant.js";

let harness: IntegrationHarness;

function uniqueTenant(label: string): string {
  return `tenant_security_${label}_${randomBytes(3).toString("hex")}`;
}

async function provisionReady() {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeReady(provisioned.runtime_id);
  return provisioned;
}

async function errorResponse(
  method: string,
  path: string,
  tenantId: string,
  payload?: unknown,
) {
  const response = await harness.requestJson(method, path, {
    tenantId,
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: response.status,
    code: (response.body as { code: string }).code,
    message: (response.body as { message: string }).message,
  };
}

test.before(async () => {
  harness = await createIntegrationHarness("security");
});

test.after(async () => {
  await harness?.close();
});

test("cross-tenant Runtime access hides foreign existence", async () => {
  const first = await provisionReady();
  const second = await provisionReady();
  const foreign = await errorResponse(
    "GET",
    `/internal/v1/tenants/${second.tenant_id}/runtime`,
    first.tenant_id,
  );
  const absent = await errorResponse(
    "GET",
    "/internal/v1/tenants/tenant_security_absent/runtime",
    first.tenant_id,
  );
  assert.deepEqual(foreign, absent);
  assert.equal(foreign.code, "RESOURCE_NOT_FOUND");
});

test("cross-tenant Conversation access hides foreign existence", async () => {
  const first = await provisionReady();
  const second = await provisionReady();
  const conversation = await harness.createConversation({
    tenant_id: second.tenant_id,
    profile_id: second.profile_ids[0]!,
  });
  const foreign = await errorResponse(
    "GET",
    `/internal/v1/conversations/${conversation.conversation_id}/events`,
    first.tenant_id,
  );
  const absent = await errorResponse(
    "GET",
    "/internal/v1/conversations/conversation_security_absent/events",
    first.tenant_id,
  );
  assert.deepEqual(foreign, absent);
  assert.equal(foreign.code, "RESOURCE_NOT_FOUND");
});

test("forged cross-tenant Profile binding hides foreign existence", async () => {
  const first = await provisionReady();
  const second = await provisionReady();
  const foreignRequest = syntheticConversationRequest(
    first.tenant_id,
    second.profile_ids[0]!,
    `foreign_${randomBytes(3).toString("hex")}`,
  );
  const absentRequest = syntheticConversationRequest(
    first.tenant_id,
    "profile_security_absent",
    `absent_${randomBytes(3).toString("hex")}`,
  );
  const foreign = await errorResponse(
    "POST",
    "/internal/v1/conversations",
    first.tenant_id,
    foreignRequest,
  );
  const absent = await errorResponse(
    "POST",
    "/internal/v1/conversations",
    first.tenant_id,
    absentRequest,
  );
  assert.deepEqual(foreign, absent);
  assert.equal(foreign.code, "RESOURCE_NOT_FOUND");
});

test("cross-tenant Run access hides foreign existence", async () => {
  const first = await provisionReady();
  const second = await provisionReady();
  const conversation = await harness.createConversation({
    tenant_id: second.tenant_id,
    profile_id: second.profile_ids[0]!,
  });
  const run = await harness.createRun(
    conversation.conversation_id,
    "Synthetic foreign Run",
    { tenantId: second.tenant_id },
  );
  await harness.worker.untilRunStatus(run.run_id, "succeeded");
  const foreign = await errorResponse(
    "GET",
    `/internal/v1/runs/${run.run_id}`,
    first.tenant_id,
  );
  const absent = await errorResponse(
    "GET",
    "/internal/v1/runs/run_security_absent",
    first.tenant_id,
  );
  assert.deepEqual(foreign, absent);
  assert.equal(foreign.code, "RESOURCE_NOT_FOUND");
});

test("terminal Runtime rejects invalid transition before Worker effects", async () => {
  const provisioned = await provisionReady();
  const runtimeResponse = await harness.requestJson(
    "GET",
    `/internal/v1/tenants/${provisioned.tenant_id}/runtime`,
    { tenantId: provisioned.tenant_id },
  );
  assert.equal(runtimeResponse.status, 200);
  const version = (runtimeResponse.body as { resource_version: number }).resource_version;
  const deleted = await harness.requestJson(
    "POST",
    `/internal/v1/tenants/${provisioned.tenant_id}/runtime-commands`,
    {
      tenantId: provisioned.tenant_id,
      payload: syntheticRuntimeCommand("delete_runtime", "delete", version),
    },
  );
  assert.equal(deleted.status, 202);
  await harness.worker.untilRuntimeStatus(provisioned.runtime_id, "deleted");

  const terminalResponse = await harness.requestJson(
    "GET",
    `/internal/v1/tenants/${provisioned.tenant_id}/runtime`,
    { tenantId: provisioned.tenant_id },
  );
  assert.equal(terminalResponse.status, 200);
  const terminalVersion = (terminalResponse.body as { resource_version: number })
    .resource_version;
  const supervisorBefore = harness.fakeSupervisor.requests.length;
  const invalid = await errorResponse(
    "POST",
    `/internal/v1/tenants/${provisioned.tenant_id}/runtime-commands`,
    provisioned.tenant_id,
    syntheticRuntimeCommand("invalid_start", "start", terminalVersion),
  );
  assert.equal(invalid.status, 409);
  assert.equal(invalid.code, "INVALID_STATE_TRANSITION");
  assert.equal(harness.fakeSupervisor.requests.length, supervisorBefore);
});

test("stale resource version fails before Worker effects", async () => {
  const provisioned = await provisionReady();
  const runtimeResponse = await harness.requestJson(
    "GET",
    `/internal/v1/tenants/${provisioned.tenant_id}/runtime`,
    { tenantId: provisioned.tenant_id },
  );
  assert.equal(runtimeResponse.status, 200);
  const version = (runtimeResponse.body as { resource_version: number }).resource_version;
  const supervisorBefore = harness.fakeSupervisor.requests.length;
  const stale = await errorResponse(
    "POST",
    `/internal/v1/tenants/${provisioned.tenant_id}/runtime-commands`,
    provisioned.tenant_id,
    syntheticRuntimeCommand("stale_stop", "stop", version - 1),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "RESOURCE_VERSION_CONFLICT");
  assert.equal(harness.fakeSupervisor.requests.length, supervisorBefore);
});

test("unpinned image is rejected before persistence", async () => {
  const tenantId = uniqueTenant("unpinned");
  const request = syntheticB2BProvisioningRequest(tenantId);
  const invalid = rehash({
    ...request,
    runtime: { ...request.runtime, image_ref: "managed/runtime-task16:v1" },
  });
  const response = await harness.requestJson(
    "POST",
    "/internal/v1/tenant-provisioning",
    { payload: invalid },
  );
  assert.equal(response.status, 400);
  assert.equal((response.body as { code: string }).code, "INVALID_REQUEST");
  assert.equal(await harness.db.selectFrom("tenants").select("tenant_id")
    .where("tenant_id", "=", tenantId).executeTakeFirst(), undefined);
});

test("unknown provider and model are rejected before persistence", async () => {
  for (const [label, change] of [
    ["provider", { provider_config_id: "provider_unknown" }],
    ["model", { model_id: "model_unknown" }],
  ] as const) {
    const tenantId = uniqueTenant(label);
    const request = syntheticB2BProvisioningRequest(tenantId);
    const response = await harness.requestJson(
      "POST",
      "/internal/v1/tenant-provisioning",
      { payload: rehash({ ...request, ...change }) },
    );
    assert.equal(response.status, 400);
    assert.equal((response.body as { code: string }).code, "INVALID_REQUEST");
    assert.equal(await harness.db.selectFrom("tenants").select("tenant_id")
      .where("tenant_id", "=", tenantId).executeTakeFirst(), undefined);
  }
});

test("secret-like request properties fail before logs or persistence", async () => {
  const tenantId = uniqueTenant("secret_property");
  const request = syntheticB2BProvisioningRequest(tenantId);
  const supervisorBefore = harness.fakeSupervisor.requests.length;
  const response = await harness.requestJson(
    "POST",
    "/internal/v1/tenant-provisioning",
    { payload: { ...request, api_key: LEAK_SENTINEL } },
  );
  assert.equal(response.status, 400);
  assert.equal((response.body as { code: string }).code, "INVALID_REQUEST");
  assert.equal(harness.fakeSupervisor.requests.length, supervisorBefore);
  assert.equal(await harness.db.selectFrom("tenants").select("tenant_id")
    .where("tenant_id", "=", tenantId).executeTakeFirst(), undefined);
  assert.equal(JSON.stringify(harness.structuredLogs).includes(LEAK_SENTINEL), false);
  assert.equal(JSON.stringify(harness.errorEnvelopes).includes(LEAK_SENTINEL), false);
});

test("Supervisor protocol extras and secret bytes are rejected without capture", async () => {
  const provisioned = await provisionReady();
  const request = harness.fakeSupervisor.requests.find(
    (candidate) => candidate.kind === "provision"
      && candidate.runtime.tenant_id === provisioned.tenant_id,
  );
  assert(request !== undefined);
  const requestsBefore = harness.fakeSupervisor.requests.length;
  const rejectedBefore = harness.fakeSupervisor.rejectedFrameCount;
  await harness.sendUnsafeSupervisorRequest({
    ...request,
    environment: { API_KEY: LEAK_SENTINEL },
  });
  assert.equal(harness.fakeSupervisor.requests.length, requestsBefore);
  assert.equal(harness.fakeSupervisor.rejectedFrameCount, rejectedBefore + 1);
});
