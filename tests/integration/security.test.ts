import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import {
  createIntegrationHarness,
  LEAK_SENTINEL,
  testHarnessInternals,
  type IntegrationHarness,
} from "./harness.js";
import {
  rehash,
  SYNTHETIC_INGRESS_KEY,
  SYNTHETIC_MODEL_ID,
  syntheticB2BProvisioningRequest,
  syntheticConversationRequest,
  syntheticRuntimeCommand,
} from "./fixtures/synthetic-tenant.js";

let harness: IntegrationHarness;

function sentinelError(work: () => void): Error {
  let captured: unknown;
  try { work(); }
  catch (error) { captured = error; }
  assert(captured instanceof Error);
  assert.equal(captured.message, "sentinel category: structured logs");
  assert.doesNotMatch(captured.message, new RegExp(LEAK_SENTINEL));
  return captured;
}

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

test("Supervisor protocol extras are rejected by frame decoding and policy", async () => {
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
    unexpected_protocol_field: "synthetic-extra-only",
  });
  assert.equal(harness.fakeSupervisor.requests.length, requestsBefore);
  assert.equal(harness.fakeSupervisor.rejectedFrameCount, rejectedBefore + 1);
});

test("Supervisor secret bytes are rejected by the pre-filter without capture", async () => {
  const provisioned = await provisionReady();
  const request = harness.fakeSupervisor.requests.find(
    (candidate) => candidate.kind === "provision"
      && candidate.runtime.tenant_id === provisioned.tenant_id,
  );
  assert(request !== undefined);
  const requestsBefore = harness.fakeSupervisor.requests.length;
  const secretRejectedBefore = harness.fakeSupervisor.secretRejectedFrameCount;
  await harness.sendUnsafeSupervisorRequest({
    ...request,
    operation_id: SYNTHETIC_INGRESS_KEY,
  });
  assert.equal(harness.fakeSupervisor.requests.length, requestsBefore);
  assert.equal(
    harness.fakeSupervisor.secretRejectedFrameCount,
    secretRejectedBefore + 1,
  );
});

test("fake Hermes rejects a query-bearing Profile route and records only its category", async () => {
  const requestsBefore = harness.fakeHermes.requests.length;
  const response = await fetch(
    `${harness.fakeHermes.origin}/p/hermes_query_probe/v1/chat/completions?unexpected=1`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${SYNTHETIC_INGRESS_KEY}`,
        "content-type": "application/json",
        "x-hermes-session-id": "hermes_session_query_probe",
      },
      body: JSON.stringify({
        model: SYNTHETIC_MODEL_ID,
        messages: [{ role: "user", content: "Synthetic query probe" }],
        stream: true,
      }),
      signal: AbortSignal.timeout(1_000),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(harness.fakeHermes.requests.length, requestsBefore);
  assert.deepEqual(harness.fakeHermes.rejections.at(-1), {
    category: "route_query",
  });
});

test("structured log scanning reaches deep late Error and nonplain data", () => {
  let nestedValue: unknown = { value: LEAK_SENTINEL };
  for (let depth = 0; depth < 8; depth += 1) nestedValue = { nested: nestedValue };
  const objectBeyondSnapshot: Record<string, string> = {};
  for (let index = 0; index < 101; index += 1) {
    objectBeyondSnapshot[`field_${index}`] = index === 100 ? LEAK_SENTINEL : "safe";
  }
  class NestedNonPlain {
    readonly nested = { detail: LEAK_SENTINEL };
  }
  for (const fields of [
    nestedValue,
    objectBeyondSnapshot,
    Array.from({ length: 101 }, (_, index) => index === 100 ? LEAK_SENTINEL : "safe"),
    new Error(`nested failure ${LEAK_SENTINEL}`, {
      cause: { detail: LEAK_SENTINEL },
    }),
    new NestedNonPlain(),
  ]) {
    const records: unknown[] = [];
    testHarnessInternals.captureStructuredLog(records, "worker_log", fields, "safe");
    sentinelError(() => testHarnessInternals.assertStructuredLogsSentinelFree(records));
  }
});

test("structured log scanning fails closed without invoking serializers", () => {
  let invoked = 0;
  const ownSerializer = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(ownSerializer, "secret", {
    enumerable: true,
    get() { invoked += 1; return LEAK_SENTINEL; },
  });
  Object.defineProperty(ownSerializer, "toJSON", {
    enumerable: true,
    value() { invoked += 1; return LEAK_SENTINEL; },
  });
  class PrototypeToJson {
    toJSON() { invoked += 1; return LEAK_SENTINEL; }
  }
  class PrototypeAccessor {
    get detail() { invoked += 1; return LEAK_SENTINEL; }
  }
  for (const fields of [
    ownSerializer,
    new PrototypeToJson(),
    new PrototypeAccessor(),
    Array.from({ length: 100_001 }, () => "safe"),
    new Proxy({}, {
      ownKeys() { throw new Error(`proxy ${LEAK_SENTINEL}`); },
    }),
  ]) {
    const records: unknown[] = [];
    testHarnessInternals.captureStructuredLog(records, "worker_log", fields, "safe");
    sentinelError(() => testHarnessInternals.assertStructuredLogsSentinelFree(records));
  }
  assert.equal(invoked, 0);
});

test("bounded cleanup continues through hangs and partial setup failures", async () => {
  const resources = { controlPoolOpen: true, databaseExists: true, poolOpen: true };
  const failures = await testHarnessInternals.runCleanupStages([
    { category: "hanging close", work: () => new Promise<void>(() => undefined) },
    { category: "earlier close", work: async () => { throw new Error(LEAK_SENTINEL); } },
    { category: "database pool", work: async () => { resources.poolOpen = false; } },
    { category: "database drop", work: async () => {
      assert.equal(resources.poolOpen, false);
      resources.databaseExists = false;
    } },
    { category: "control pool", work: async () => { resources.controlPoolOpen = false; } },
  ], 25);
  assert.deepEqual(failures, ["hanging close", "earlier close"]);
  assert.deepEqual(resources, {
    controlPoolOpen: false,
    databaseExists: false,
    poolOpen: false,
  });
  assert.doesNotMatch(failures.join(","), new RegExp(LEAK_SENTINEL));
});

for (const failure of ["reject", "timeout"] as const) {
  test(`isolated database ${failure} cancels CREATE before exact cleanup`, async () => {
    const createCalls: string[] = [];
    const cleanupCalls: string[] = [];
    let rejectCreate!: (error: Error) => void;
    const pendingCreate = new Promise<unknown>((_resolve, reject) => { rejectCreate = reject; });
    await assert.rejects(testHarnessInternals.createIsolatedDatabase({
      configuredUrl: "postgresql://test:test@127.0.0.1/core_agent_control",
      databaseName: "core_agent_test_0123456789abcdef",
      createSession: {
        connect: async () => { createCalls.push("connect"); },
        query: async (sql: string) => {
          createCalls.push(sql);
          if (failure === "reject") throw new Error("raw create failure");
          return pendingCreate;
        },
        close: async () => {
          createCalls.push("close");
          if (failure === "timeout") rejectCreate(new Error("cancelled create"));
        },
      },
      controlPool: {
        query: async (sql: string) => { createCalls.push(sql); },
        end: async () => { createCalls.push("end"); },
      },
      cleanupControlPool: {
        query: async (sql: string) => { cleanupCalls.push(sql); },
        end: async () => { cleanupCalls.push("end"); },
      },
      timeoutMs: 25,
    }), /^Error: Integration stage failed: database create$/);
    assert(cleanupCalls.includes(
      'drop database if exists "core_agent_test_0123456789abcdef" with (force)',
    ));
    assert.equal(createCalls.at(-1), "end");
    assert.equal(cleanupCalls.at(-1), "end");
  });
}

test("timed out delayed CREATE cannot advance after cleanup", async () => {
  let cancelled = false;
  let created = false;
  let rejectCreate!: (error: Error) => void;
  const createOperation = new Promise<unknown>((_resolve, reject) => { rejectCreate = reject; });
  const cleanupCalls: string[] = [];
  await assert.rejects(testHarnessInternals.createIsolatedDatabase({
    configuredUrl: "postgresql://test:test@127.0.0.1/core_agent_control",
    databaseName: "core_agent_test_0123456789abcdef",
    createSession: {
      connect: async () => undefined,
      query: () => createOperation,
      close: async () => {
        cancelled = true;
        rejectCreate(new Error("cancelled create"));
      },
    },
    controlPool: { query: async () => undefined, end: async () => undefined },
    cleanupControlPool: {
      query: async (sql: string) => { cleanupCalls.push(sql); },
      end: async () => { cleanupCalls.push("end"); },
    },
    timeoutMs: 25,
  }), /^Error: Integration stage failed: database create$/);
  const advanceDelayedCreate = (): void => { if (!cancelled) created = true; };
  advanceDelayedCreate();
  assert.equal(cancelled, true);
  assert.equal(created, false);
  assert(cleanupCalls.some((sql) => sql.startsWith("drop database")));
});

test("unconfirmed CREATE cancellation fails closed without claiming cleanup", async () => {
  const cleanupCalls: string[] = [];
  await assert.rejects(testHarnessInternals.createIsolatedDatabase({
    configuredUrl: "postgresql://test:test@127.0.0.1/core_agent_control",
    databaseName: "core_agent_test_0123456789abcdef",
    createSession: {
      connect: async () => undefined,
      query: () => new Promise(() => undefined),
      close: () => new Promise(() => undefined),
    },
    controlPool: { query: async () => undefined, end: async () => undefined },
    cleanupControlPool: {
      query: async (sql: string) => { cleanupCalls.push(sql); },
      end: async () => { cleanupCalls.push("end"); },
    },
    timeoutMs: 25,
  }), /^Error: Integration stage failed: database create cancellation$/);
  assert.equal(cleanupCalls.some((sql) => sql.startsWith("drop database")), false);
});
