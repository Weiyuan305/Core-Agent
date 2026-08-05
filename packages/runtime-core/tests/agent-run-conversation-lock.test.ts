import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

import {
  agentRunConversationLockKey,
  createRuntimeDatabase,
  withAgentRunConversationLock,
} from "../src/index.js";
import { createAgentRun } from "../src/services/create-agent-run.js";
import { createConversation } from "../src/services/create-conversation.js";
import {
  admissionNow,
  providerCatalog,
  resetAdmissionDatabase,
  seedReadyTenant,
  serviceContext,
  withPayloadHash,
} from "./admission-test-support.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl });
const db = createRuntimeDatabase(pool);

function timeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 2_000)),
  ]);
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

async function addConversationRun(tenantId: string, suffix: string, profileId?: string) {
  const selectedProfileId = profileId ?? (await seedReadyTenant(db, tenantId)).profileId;
  const context = serviceContext(tenantId);
  const conversation = await createConversation({ db, now: () => admissionNow }, context, withPayloadHash({
    schema_version: 1 as const, idempotency_key: `idem_lock_conversation_${suffix}`,
    tenant_id: tenantId, profile_id: selectedProfileId,
  }));
  const run = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, context, conversation.conversation_id, withPayloadHash({
    schema_version: 1 as const, idempotency_key: `idem_lock_run_${suffix}`,
    client_request_id: `client_lock_run_${suffix}`,
    input_message: { client_message_id: `client_lock_message_${suffix}`, content: `Prompt ${suffix}` },
  }));
  return { conversation, run, profileId: selectedProfileId };
}

async function addRun(tenantId: string, conversationId: string, suffix: string) {
  return createAgentRun({ db, providerCatalog, now: () => admissionNow }, serviceContext(tenantId), conversationId, withPayloadHash({
    schema_version: 1 as const, idempotency_key: `idem_lock_run_${suffix}`,
    client_request_id: `client_lock_run_${suffix}`,
    input_message: { client_message_id: `client_lock_message_${suffix}`, content: `Prompt ${suffix}` },
  }));
}

test.beforeEach(async () => resetAdmissionDatabase(pool));
test.after(async () => db.destroy());

test("Conversation execution lock keeps two Runs on one Hermes Session serial across the whole callback", async () => {
  const first = await addConversationRun("tenant_lock_same", "same_first");
  const secondRun = await addRun("tenant_lock_same", first.conversation.conversation_id, "same_second");
  const held = gate();
  const firstEntered = gate();
  let secondEntered = false;

  const firstWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_same", runId: first.run.run_id }, async () => {
    firstEntered.release();
    await held.wait;
    return "first";
  });
  await timeout(firstEntered.wait, "first Conversation callback");
  const secondWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_same", runId: secondRun.run_id }, async () => {
    secondEntered = true;
    return "second";
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(secondEntered, false, "second Run must not enter begin/Hermes while the first owns the Session lock");
  held.release();
  assert.deepEqual(await timeout(Promise.all([firstWork, secondWork]), "serialized Conversation work"), ["first", "second"]);
  assert.equal(secondEntered, true);
});

test("Conversation execution lock keeps different Conversations and tenants concurrent in a separate namespace", async () => {
  const first = await addConversationRun("tenant_lock_parallel", "parallel_first");
  const second = await addConversationRun("tenant_lock_parallel", "parallel_second", first.profileId);
  const otherTenant = await addConversationRun("tenant_lock_other", "parallel_other");
  const held = gate();
  const firstEntered = gate();
  const parallelEntries: string[] = [];
  const firstWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_parallel", runId: first.run.run_id }, async () => {
    firstEntered.release(); await held.wait; return "first";
  });
  await timeout(firstEntered.wait, "first parallel callback");
  const secondWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_parallel", runId: second.run.run_id }, async () => { parallelEntries.push("conversation"); return "second"; });
  const tenantWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_other", runId: otherTenant.run.run_id }, async () => { parallelEntries.push("tenant"); return "tenant"; });
  await timeout(Promise.all([secondWork, tenantWork]), "independent Conversation callbacks");
  assert.deepEqual(parallelEntries.sort(), ["conversation", "tenant"]);
  held.release();
  assert.equal(await timeout(firstWork, "first parallel work"), "first");
  assert.notEqual(
    agentRunConversationLockKey("tenant_lock_parallel", first.conversation.conversation_id),
    `tenant_lock_parallel:${first.conversation.conversation_id}`,
    "Agent Session lock namespace must not reuse the Runtime lock key",
  );
});

test("Conversation execution lock resolves immutable Run scope inside the authority tenant before callback", async () => {
  const setup = await addConversationRun("tenant_lock_scope", "scope");
  let entered = false;
  await assert.rejects(withAgentRunConversationLock(db, { tenantId: "tenant_lock_attacker", runId: setup.run.run_id }, async () => { entered = true; }));
  assert.equal(entered, false);
});

test("Conversation execution lock wait honors Worker cancellation without entering begin or Hermes", async () => {
  const setup = await addConversationRun("tenant_lock_abort", "abort_first");
  const secondRun = await addRun("tenant_lock_abort", setup.conversation.conversation_id, "abort_second");
  const held = gate();
  const firstEntered = gate();
  let secondEntered = false;
  const firstWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_abort", runId: setup.run.run_id }, async () => {
    firstEntered.release(); await held.wait;
  });
  await timeout(firstEntered.wait, "abort lock owner");
  const controller = new AbortController();
  const secondWork = withAgentRunConversationLock(db, { tenantId: "tenant_lock_abort", runId: secondRun.run_id, signal: controller.signal }, async () => { secondEntered = true; });
  controller.abort();
  try {
    await assert.rejects(timeout(secondWork, "cancelled Conversation lock waiter"), /aborted/i);
  } finally {
    held.release();
    await timeout(firstWork, "abort lock owner release");
  }
  await secondWork.catch(() => undefined);
  assert.equal(secondEntered, false);
});
