import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";

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

test("structured log scan snapshot and projection fail closed without invoking serializers", () => {
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
  let ownKeysCalls = 0;
  const stateful = new Proxy({}, {
    ownKeys() {
      ownKeysCalls += 1;
      if (ownKeysCalls === 1) return [];
      throw new Error(`snapshot failure ${LEAK_SENTINEL}`);
    },
  });
  const records: unknown[] = [];
  testHarnessInternals.captureStructuredLog(records, "worker_log", stateful, "safe");
  assert.equal(ownKeysCalls, 2);
  assert.deepEqual(
    (records[0] as { sentinelScan: unknown }).sentinelScan,
    {
      detected: false,
      incomplete: true,
      incompleteCategories: ["structured_snapshot"],
    },
  );
  sentinelError(() => testHarnessInternals.assertStructuredLogsSentinelFree(records));
  assert.equal(JSON.stringify(records).includes(LEAK_SENTINEL), false);

  let revocableOwnKeysCalls = 0;
  const snapshotRevocable = Proxy.revocable({ detail: LEAK_SENTINEL }, {
    ownKeys() {
      revocableOwnKeysCalls += 1;
      if (revocableOwnKeysCalls === 2) snapshotRevocable.revoke();
      return [];
    },
  });
  const snapshotRecords: unknown[] = [];
  assert.doesNotThrow(() => {
    testHarnessInternals.captureStructuredLog(
      snapshotRecords,
      "worker_log",
      snapshotRevocable.proxy,
      "safe",
    );
  });
  assert.equal(revocableOwnKeysCalls, 2);
  assert.notEqual(
    (snapshotRecords[0] as { fields: unknown }).fields,
    snapshotRevocable.proxy,
  );
  sentinelError(() => testHarnessInternals.assertStructuredLogsSentinelFree(snapshotRecords));
  assert.equal(JSON.stringify(snapshotRecords).includes(LEAK_SENTINEL), false);

  const projectionRevocable = Proxy.revocable({ detail: LEAK_SENTINEL }, {});
  projectionRevocable.revoke();
  const projectionRecords: unknown[] = [];
  const logger = testHarnessInternals.capturingLogger(projectionRecords);
  assert.doesNotThrow(() => logger.info(projectionRevocable.proxy, "safe"));
  assert.notEqual(
    (projectionRecords[0] as { fields: unknown }).fields,
    projectionRevocable.proxy,
  );
  sentinelError(() => testHarnessInternals.assertStructuredLogsSentinelFree(projectionRecords));
  assert.equal(JSON.stringify(projectionRecords).includes(LEAK_SENTINEL), false);
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

test("unconfirmed CREATE cancellation fails closed with its cause and without claiming database cleanup", async () => {
  const cleanupCalls: string[] = [];
  await assert.rejects(
    testHarnessInternals.createIsolatedDatabase({
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
    }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Integration setup failed; cleanup failed: create_cancellation");
      assert.deepEqual(
        (error as Error & { readonly cleanupFailures?: readonly string[] }).cleanupFailures,
        ["create_cancellation"],
      );
      assert(error.cause instanceof Error);
      assert.equal(error.cause.message, "Integration stage failed: database create");
      return true;
    },
  );
  assert.equal(cleanupCalls.some((sql) => sql.startsWith("drop database")), false);
});

test("official PostgreSQL default create failure reaps exact cleanup and leaves the target absent", async () => {
  const isolated = await testHarnessInternals.createIsolatedDatabase();
  try {
    await assert.rejects(
      testHarnessInternals.createIsolatedDatabase({
        databaseName: isolated.databaseName,
        timeoutMs: 1_000,
      }),
      /^Error: Integration stage failed: database create$/,
    );
    const direct = await isolated.controlPool.query(
      "select exists (select 1 from pg_database where datname = $1) as exists",
      [isolated.databaseName],
    ) as { rows: readonly { exists: boolean }[] };
    assert.equal(direct.rows[0]?.exists, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stable = await isolated.controlPool.query(
      "select exists (select 1 from pg_database where datname = $1) as exists",
      [isolated.databaseName],
    ) as { rows: readonly { exists: boolean }[] };
    assert.equal(stable.rows[0]?.exists, false);
  } finally {
    await isolated.controlPool.end();
  }
});

test("official PostgreSQL teardown force-releases one real held child-pool checkout", async () => {
  const isolated = await testHarnessInternals.createIsolatedDatabase();
  const childPool = new Pool({ connectionString: isolated.databaseUrl, max: 1 });
  const tracked = testHarnessInternals.trackPostgresPool(childPool, () => childPool.end());
  const held = await childPool.connect();
  let removed = 0;
  childPool.on("remove", () => { removed += 1; });
  try {
    await testHarnessInternals.dropIsolatedDatabase({
      databaseName: isolated.databaseName,
      controlDatabaseUrl: isolated.controlDatabaseUrl,
      closeOwned: [tracked],
      timeoutMs: 2_000,
      retryDelayMs: 1,
    });
    assert.equal(childPool.ended, true);
    assert.equal(removed, 1);
  } finally {
    if (!childPool.ended) {
      try { held.release(true); } catch { /* already force-released */ }
      await childPool.end().catch(() => undefined);
    }
    await isolated.controlPool.end();
  }
});

test("official PostgreSQL teardown drains a real checkout acquired after Pool.end begins", async () => {
  const isolated = await testHarnessInternals.createIsolatedDatabase();
  let connectCount = 0;
  let releaseLateConnect: (() => void) | undefined;
  let markLateConnectStarted: (() => void) | undefined;
  const lateConnectStarted = new Promise<void>((resolve) => { markLateConnectStarted = resolve; });
  const childPool = new Pool({
    connectionString: isolated.databaseUrl,
    max: 2,
    onConnect: async () => {
      connectCount += 1;
      if (connectCount !== 2) return;
      markLateConnectStarted?.();
      await new Promise<void>((resolve) => { releaseLateConnect = resolve; });
    },
  });
  const tracked = testHarnessInternals.trackPostgresPool(childPool, () => childPool.end());
  const held = await childPool.connect();
  const terminationErrors: string[] = [];
  const recordTermination = (error: Error & { readonly code?: string }): void => {
    terminationErrors.push(error.code ?? "missing");
  };
  childPool.on("error", recordTermination);
  let acquired = 0;
  childPool.on("acquire", () => { acquired += 1; });
  const lateCheckout = childPool.connect().then(
    (client) => {
      client.on("error", recordTermination);
      return "acquired" as const;
    },
    () => "terminated" as const,
  );
  await lateConnectStarted;
  const teardown = testHarnessInternals.dropIsolatedDatabase({
    databaseName: isolated.databaseName,
    controlDatabaseUrl: isolated.controlDatabaseUrl,
    closeOwned: [tracked],
    timeoutMs: 1_500,
    retryDelayMs: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  releaseLateConnect?.();
  try {
    const lateResult = await lateCheckout;
    await teardown;
    assert.equal(acquired, 1);
    assert.equal(lateResult, "acquired");
    assert(terminationErrors.length === 0 || terminationErrors.every((code) => code === "57P01"));
    assert.equal(childPool.ended, true);
  } finally {
    if (!childPool.ended) {
      try { held.release(true); } catch { /* already force-released */ }
      await childPool.end().catch(() => undefined);
    }
    await isolated.controlPool.end();
  }
});

test("official PostgreSQL child cleanup terminates an exact unowned backend and reaps before return", async () => {
  const isolated = await testHarnessInternals.createIsolatedDatabase();
  const exact = new Client({ connectionString: isolated.databaseUrl });
  const errors: string[] = [];
  exact.on("error", (error: Error & { readonly code?: string }) => { errors.push(error.code ?? "missing"); });
  await exact.connect();
  try {
    await testHarnessInternals.dropIsolatedDatabase({
      databaseName: isolated.databaseName,
      controlDatabaseUrl: isolated.controlDatabaseUrl,
      closeOwned: [],
      timeoutMs: 1_000,
      retryDelayMs: 1,
    });
    assert(errors.includes("57P01"));
    assert(errors.every((code) => code === "57P01" || code === "missing"));
    const stable = [...errors];
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(errors, stable);
  } finally {
    await exact.end().catch(() => undefined);
    await isolated.controlPool.end();
  }
});

test("official PostgreSQL child cleanup waits for owned terminal state before dropping the exact database", async () => {
  const isolated = await testHarnessInternals.createIsolatedDatabase();
  const observer = new Client({ connectionString: isolated.controlDatabaseUrl });
  let databaseExistedAtOwnedTerminal = false;
  try {
    await observer.connect();
    await testHarnessInternals.dropIsolatedDatabase({
      databaseName: isolated.databaseName,
      controlDatabaseUrl: isolated.controlDatabaseUrl,
      closeOwned: [{
        close: async () => await new Promise<void>(() => undefined),
        forceClose: async () => undefined,
        forceTerminate: () => {
          const completion = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const result = await observer.query<{ exists: boolean }>(
            "select exists (select 1 from pg_database where datname = $1) as exists",
            [isolated.databaseName],
          );
          databaseExistedAtOwnedTerminal = result.rows[0]?.exists === true;
          })();
          return { completion, terminateAndReap: async () => { await completion; } };
        },
      }],
      timeoutMs: 6_000,
      retryDelayMs: 1,
    });
    assert.equal(databaseExistedAtOwnedTerminal, true);
  } finally {
    await observer.end().catch(() => undefined);
    await isolated.controlPool.end();
  }
});
