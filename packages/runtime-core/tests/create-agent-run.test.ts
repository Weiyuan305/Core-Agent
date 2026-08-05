import assert from "node:assert/strict";
import test from "node:test";

import { AgentRunSchema } from "@core-agent/contracts";
import Schema from "typebox/schema";
import { Pool } from "pg";

import { createRuntimeDatabase, DomainError, getAgentRun } from "../src/index.js";
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
const runValidator = Schema.Compile(AgentRunSchema);
const farFutureNow = new Date("2400-04-01T00:00:00.000Z");
const expiredRetention = new Date("2000-01-01T00:00:00.000Z");

function conversationRequest(tenantId: string, profileId: string, key: string) {
  return withPayloadHash({ schema_version: 1 as const, idempotency_key: key, tenant_id: tenantId, profile_id: profileId });
}

function runRequest(key: string, clientRequestId = `client_${key}`, clientMessageId = `message_${key}`, content = "Hello central agent") {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: key,
    client_request_id: clientRequestId,
    input_message: { client_message_id: clientMessageId, content },
  });
}

async function setupConversation(tenantId: string, conversationKey = `idem_conversation_${tenantId}`) {
  const { profileId } = await seedReadyTenant(db, tenantId);
  const context = serviceContext(tenantId);
  const conversation = await createConversation({ db, now: () => admissionNow }, context, conversationRequest(tenantId, profileId, conversationKey));
  return { context, conversation, profileId };
}

test.beforeEach(async () => resetAdmissionDatabase(pool));
test.after(async () => db.destroy());

test("Agent Run admission atomically creates queued Run, completed user Message, bounded job, ordered events, audit, Outbox, and replay", async () => {
  const tenantId = "tenant_run_admission";
  const { profileId } = await seedReadyTenant(db, tenantId);
  const context = serviceContext(tenantId);
  const conversation = await createConversation({ db, now: () => admissionNow }, context, withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: "idem_conversation_for_run",
    tenant_id: tenantId,
    profile_id: profileId,
  }));
  const request = withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: "idem_run_admission",
    client_request_id: "client_request_run_admission",
    input_message: { client_message_id: "client_message_run_admission", content: "Keep this exact message." },
  });

  const first = await createAgentRun(
    { db, providerCatalog, now: () => admissionNow },
    context,
    conversation.conversation_id,
    request,
  );
  const replay = await createAgentRun(
    { db, providerCatalog, now: () => admissionNow },
    context,
    conversation.conversation_id,
    request,
  );

  assert.equal(runValidator.Check(first), true);
  assert.deepEqual(replay, first);
  assert.equal(first.status, "queued");
  const message = await db.selectFrom("messages").selectAll().where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  assert.equal(message.run_id, first.run_id);
  assert.equal(message.role, "user");
  assert.equal(message.status, "completed");
  assert.equal(message.content, "Keep this exact message.");
  const job = await db.selectFrom("worker_jobs").selectAll().where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  assert.equal(job.job_kind, "execute_agent_run");
  assert.equal(job.payload_ref, first.run_id);
  assert.equal(job.run_id, first.run_id);
  assert.equal(job.container_id, null);
  assert.equal(job.runtime_command, null);
  assert.equal(job.target_command_version, null);
  assert.equal(job.effect_state, "pre_effect");
  assert.equal(job.max_attempts, 3, "max_safe_retries + first attempt");
  assert.deepEqual(
    await db.selectFrom("product_events").select(["event_type", "sequence"]).where("tenant_id", "=", tenantId)
      .orderBy("sequence").execute(),
    [
      { event_type: "conversation.created", sequence: "1" },
      { event_type: "message.created", sequence: "2" },
      { event_type: "run.queued", sequence: "3" },
    ],
  );
  assert.equal(await db.selectFrom("audit_events").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 2);
  assert.equal(await db.selectFrom("outbox").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 3);
});

test("Agent Run replay and conflict remain stable after idempotency retention expiry", async () => {
  const tenantId = "tenant_run_expired_tombstone";
  const { profileId } = await seedReadyTenant(db, tenantId);
  const context = serviceContext(tenantId);
  const conversation = await createConversation(
    { db, now: () => farFutureNow },
    context,
    conversationRequest(tenantId, profileId, "idem_conversation_for_expired_run"),
  );
  const request = runRequest("idem_run_expired_tombstone", "client_expired_run", "message_expired_run");
  const dependencies = { db, providerCatalog, now: () => farFutureNow };
  const first = await createAgentRun(dependencies, context, conversation.conversation_id, request);
  assert.deepEqual(
    await db.selectFrom("idempotency_records").select(["created_at", "updated_at", "expires_at"])
      .where("tenant_id", "=", tenantId).where("idempotency_key", "=", request.idempotency_key)
      .executeTakeFirstOrThrow(),
    {
      created_at: farFutureNow,
      updated_at: farFutureNow,
      expires_at: new Date("2400-04-02T00:00:00.000Z"),
    },
  );
  await db.updateTable("idempotency_records").set({ expires_at: expiredRetention })
    .where("tenant_id", "=", tenantId).where("idempotency_key", "=", request.idempotency_key).execute();

  assert.deepEqual(await createAgentRun(dependencies, context, conversation.conversation_id, request), first);
  const changed = runRequest(request.idempotency_key, "client_changed_after_expiry", "message_changed_after_expiry", "Changed after expiry");
  await assert.rejects(
    createAgentRun(dependencies, context, conversation.conversation_id, changed),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(
    await db.selectFrom("idempotency_records").select(["payload_hash", "operation", "expires_at"])
      .where("tenant_id", "=", tenantId).where("idempotency_key", "=", request.idempotency_key)
      .executeTakeFirstOrThrow(),
    { payload_hash: request.payload_hash, operation: "agent_run.create", expires_at: expiredRetention },
  );
  assert.equal(await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
});

test("Agent Run rejects absent/cross-tenant Conversation and Session failures with the same generic not found", async () => {
  const first = await setupConversation("tenant_run_hidden_a");
  const second = await setupConversation("tenant_run_hidden_b");
  const scenarios = [
    [first.context, "conversation_absent", runRequest("idem_absent_conversation")],
    [first.context, second.conversation.conversation_id, runRequest("idem_cross_conversation")],
  ] as const;
  for (const [context, conversationId, request] of scenarios) {
    await assert.rejects(
      createAgentRun({ db, providerCatalog }, context, conversationId, request),
      (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
    );
  }

  await db.updateTable("sessions").set({ expires_at: new Date("2026-08-04T00:00:00.000Z") })
    .where("tenant_id", "=", first.context.tenantId).execute();
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, first.context, first.conversation.conversation_id, runRequest("idem_expired_session")),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("Agent Run fails closed on duplicate or Profile-mismatched active Sessions", async () => {
  const duplicate = await setupConversation("tenant_run_duplicate_session");
  const original = await db.selectFrom("sessions").selectAll().where("tenant_id", "=", duplicate.context.tenantId).executeTakeFirstOrThrow();
  await db.insertInto("sessions").values({
    ...original,
    session_id: "session_duplicate",
    hermes_session_ref: "hermes_session_duplicate",
  }).execute();
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, duplicate.context, duplicate.conversation.conversation_id, runRequest("idem_duplicate_session")),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );

  const mismatch = await setupConversation("tenant_run_mismatch_session");
  const secondOwner = "owner_second_profile";
  await db.insertInto("actors").values({ tenant_id: mismatch.context.tenantId, actor_id: secondOwner, schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Second", status: "active", created_at: admissionNow, updated_at: admissionNow }).execute();
  await db.insertInto("profiles").values({ tenant_id: mismatch.context.tenantId, profile_id: "profile_second", schema_version: 1, resource_version: 1, owner_actor_id: secondOwner, profile_kind: "default", hermes_profile_ref: "hermes_second", description: "Second profile", status: "active", provider_config_id: "provider_admission", model_id: "model_admission", created_at: admissionNow, updated_at: admissionNow }).execute();
  await db.updateTable("sessions").set({ profile_id: "profile_second" }).where("tenant_id", "=", mismatch.context.tenantId).execute();
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, mismatch.context, mismatch.conversation.conversation_id, runRequest("idem_mismatch_session")),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("Agent Run admission requires active tenant/Profile and ready healthy managed Runtime", async () => {
  const cases = [
    ["tenant_run_inactive_tenant", "tenant"],
    ["tenant_run_inactive_profile", "profile"],
    ["tenant_run_desired_stopped", "desired"],
    ["tenant_run_observed_stopped", "observed"],
    ["tenant_run_health_unhealthy", "health"],
  ] as const;
  for (const [tenantId, mutation] of cases) {
    const setup = await setupConversation(tenantId);
    if (mutation === "tenant") await db.updateTable("tenants").set({ status: "suspended" }).where("tenant_id", "=", tenantId).execute();
    if (mutation === "profile") await db.updateTable("profiles").set({ status: "suspended" }).where("tenant_id", "=", tenantId).execute();
    if (mutation === "desired") await db.updateTable("runtime_containers").set({ desired_state: "stopped" }).where("tenant_id", "=", tenantId).execute();
    if (mutation === "observed") await db.updateTable("runtime_containers").set({ observed_state: "stopped" }).where("tenant_id", "=", tenantId).execute();
    if (mutation === "health") await db.updateTable("runtime_containers").set({ health_status: "unhealthy" }).where("tenant_id", "=", tenantId).execute();
    await assert.rejects(
      createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, runRequest(`idem_${mutation}_run`)),
      (error: unknown) => error instanceof DomainError && error.code === (["desired", "observed", "health"].includes(mutation) ? "RUNTIME_NOT_READY" : "RESOURCE_NOT_FOUND"),
    );
  }
});

test("Agent Run identical replay survives later Runtime and Session admission drift without new rows", async () => {
  const setup = await setupConversation("tenant_run_replay_drift");
  const request = runRequest("idem_run_replay_drift", "client_run_replay_drift", "message_run_replay_drift");
  const first = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, request);
  await db.updateTable("runtime_containers").set({ observed_state: "failed", health_status: "unhealthy" })
    .where("tenant_id", "=", setup.context.tenantId).execute();
  await db.updateTable("sessions").set({ expires_at: new Date("2026-08-04T00:00:00.000Z") })
    .where("tenant_id", "=", setup.context.tenantId).execute();
  const replay = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, request);
  assert.deepEqual(replay, first);
  assert.equal(await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("worker_jobs").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 1);
});

test("Agent Run retry creates a distinct queued child only from a failed parent in the same Conversation", async () => {
  const setup = await setupConversation("tenant_run_retry");
  const parentRequest = runRequest("idem_parent_run", "client_parent_run", "message_parent_run");
  const parent = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, parentRequest);
  await db.updateTable("agent_runs").set({ status: "failed", finished_at: admissionNow, failure_summary: "Synthetic parent failure" })
    .where("tenant_id", "=", setup.context.tenantId).where("run_id", "=", parent.run_id).execute();
  const childInput = withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: "idem_child_run",
    client_request_id: "client_child_run",
    input_message: { client_message_id: "message_child_run", content: "Retry explicitly" },
    parent_run_id: parent.run_id,
  });
  const child = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, childInput);
  assert.notEqual(child.run_id, parent.run_id);
  assert.equal(child.parent_run_id, parent.run_id);
  assert.equal(child.status, "queued");

  const nonFailed = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, runRequest("idem_nonfailed_parent", "client_nonfailed", "message_nonfailed"));
  const invalidParent = withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: "idem_invalid_parent_child",
    client_request_id: "client_invalid_parent_child",
    input_message: { client_message_id: "message_invalid_parent_child", content: "Must fail closed" },
    parent_run_id: nonFailed.run_id,
  });
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, invalidParent),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("Agent Run retry hides absent, cross-tenant, and other-Conversation parents behind generic not found", async () => {
  const first = await setupConversation("tenant_run_parent_a", "idem_parent_conversation_a");
  const second = await setupConversation("tenant_run_parent_b", "idem_parent_conversation_b");
  const secondParent = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, second.context, second.conversation.conversation_id, runRequest("idem_parent_other_tenant", "client_parent_other_tenant", "message_parent_other_tenant"));
  await db.updateTable("agent_runs").set({ status: "failed", finished_at: admissionNow, failure_summary: "Synthetic" })
    .where("tenant_id", "=", second.context.tenantId).where("run_id", "=", secondParent.run_id).execute();
  const secondConversation = await createConversation({ db, now: () => admissionNow }, first.context, conversationRequest(first.context.tenantId, first.profileId, "idem_second_conversation_same_tenant"));
  const otherConversationParent = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, first.context, secondConversation.conversation_id, runRequest("idem_parent_other_conversation", "client_parent_other_conversation", "message_parent_other_conversation"));
  await db.updateTable("agent_runs").set({ status: "failed", finished_at: admissionNow, failure_summary: "Synthetic" })
    .where("tenant_id", "=", first.context.tenantId).where("run_id", "=", otherConversationParent.run_id).execute();

  for (const [key, parentRunId] of [
    ["idem_child_absent_parent", "run_absent"],
    ["idem_child_cross_tenant_parent", secondParent.run_id],
    ["idem_child_other_conversation_parent", otherConversationParent.run_id],
  ] as const) {
    const input = withPayloadHash({
      schema_version: 1 as const,
      idempotency_key: key,
      client_request_id: `client_${key}`,
      input_message: { client_message_id: `message_${key}`, content: "Explicit retry" },
      parent_run_id: parentRunId,
    });
    await assert.rejects(
      createAgentRun({ db, providerCatalog, now: () => admissionNow }, first.context, first.conversation.conversation_id, input),
      (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
    );
  }
});

test("Agent Run rejects a Session whose actor is not the immutable Conversation creator and trusted service", async () => {
  const setup = await setupConversation("tenant_run_session_actor");
  await db.updateTable("sessions").set({ actor_id: `owner_${setup.context.tenantId}` })
    .where("tenant_id", "=", setup.context.tenantId).execute();
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, runRequest("idem_session_actor_mismatch")),
    (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("Agent Run idempotency and client identities reject changed payload, client request collision, client message collision, and tampered replay", async () => {
  const setup = await setupConversation("tenant_run_identity");
  const request = runRequest("idem_run_identity", "client_identity", "message_identity", "Original content");
  const run = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, request);
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, runRequest(request.idempotency_key, "client_identity", "message_identity", "Changed content")),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, runRequest("idem_client_request_collision", "client_identity", "message_distinct")),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, runRequest("idem_client_message_collision", "client_distinct", "message_identity")),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await db.updateTable("idempotency_records").set({ result_ref: "run_attacker" })
    .where("tenant_id", "=", setup.context.tenantId).where("idempotency_key", "=", request.idempotency_key).execute();
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, request),
    (error: unknown) => error instanceof DomainError && error.code === "INTERNAL_ERROR",
  );
  assert.equal(await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(run.status, "queued");
});

test("Agent Run late job failure rolls back Message, Run, job, events, audit, Outbox, and idempotency completion", async () => {
  const setup = await setupConversation("tenant_run_rollback");
  const before = {
    events: await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length),
    audits: await db.selectFrom("audit_events").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length),
    outbox: await db.selectFrom("outbox").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length),
  };
  await pool.query(`
    create function reject_run_completion() returns trigger language plpgsql as $$
    begin
      if new.operation = 'agent_run.create' and new.status = 'completed' then raise exception 'synthetic late failure'; end if;
      return new;
    end $$;
    create trigger reject_run_completion before update on idempotency_records for each row execute function reject_run_completion();
  `);
  const request = runRequest("idem_run_rollback", "client_run_rollback", "message_run_rollback");
  await assert.rejects(
    createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, request),
    /synthetic late failure/,
  );
  assert.equal(await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("worker_jobs").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("idempotency_records").selectAll().where("tenant_id", "=", setup.context.tenantId).where("idempotency_key", "=", request.idempotency_key).execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("product_events").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), before.events);
  assert.equal(await db.selectFrom("audit_events").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), before.audits);
  assert.equal(await db.selectFrom("outbox").selectAll().where("tenant_id", "=", setup.context.tenantId).execute().then((rows) => rows.length), before.outbox);
});

test("concurrent client request and client message collisions converge on one Run and one generic idempotency conflict", async () => {
  for (const [tenantId, first, second] of [
    [
      "tenant_run_concurrent_client_request",
      runRequest("idem_concurrent_request_a", "client_shared_request", "message_request_a"),
      runRequest("idem_concurrent_request_b", "client_shared_request", "message_request_b"),
    ],
    [
      "tenant_run_concurrent_client_message",
      runRequest("idem_concurrent_message_a", "client_message_a", "message_shared_identity"),
      runRequest("idem_concurrent_message_b", "client_message_b", "message_shared_identity"),
    ],
  ] as const) {
    const setup = await setupConversation(tenantId);
    const results = await Promise.allSettled([
      createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, first),
      createAgentRun({ db, providerCatalog, now: () => admissionNow }, setup.context, setup.conversation.conversation_id, second),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(rejected?.reason instanceof DomainError, true);
    assert.equal((rejected?.reason as DomainError).code, "IDEMPOTENCY_CONFLICT");
    assert.equal(await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
    assert.equal(await db.selectFrom("messages").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
  }
});

test("same-tenant Conversations race one tenant-global client request identity without tenant-wide admission serialization", async () => {
  const tenantId = "tenant_run_cross_conversation_race";
  const setup = await setupConversation(tenantId, "idem_cross_conversation_race_a");
  const otherConversation = await createConversation(
    { db, now: () => admissionNow },
    setup.context,
    conversationRequest(tenantId, setup.profileId, "idem_cross_conversation_race_b"),
  );
  await pool.query(`
    create sequence run_admission_race_probe;
    create function record_run_admission_race() returns trigger language plpgsql as $$
    begin
      perform nextval('run_admission_race_probe');
      perform pg_sleep(0.2);
      return new;
    end $$;
    create trigger record_run_admission_race before insert on agent_runs for each row execute function record_run_admission_race();
  `);
  const sharedClientRequestId = "client_request_cross_conversation_global";
  const results = await Promise.allSettled([
    createAgentRun(
      { db, providerCatalog, now: () => admissionNow },
      setup.context,
      setup.conversation.conversation_id,
      runRequest("idem_cross_conversation_run_a", sharedClientRequestId, "message_cross_conversation_a"),
    ),
    createAgentRun(
      { db, providerCatalog, now: () => admissionNow },
      setup.context,
      otherConversation.conversation_id,
      runRequest("idem_cross_conversation_run_b", sharedClientRequestId, "message_cross_conversation_b"),
    ),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected?.reason instanceof DomainError, true);
  assert.equal((rejected?.reason as DomainError).code, "IDEMPOTENCY_CONFLICT");
  const probe = await pool.query<{ last_value: string }>("select last_value from run_admission_race_probe");
  assert.equal(probe.rows[0]?.last_value, "2", "both Conversation admissions must reach the atomic tenant-global identity constraint");
  assert.equal(await db.selectFrom("agent_runs").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
});

test("concurrent database Message identity collision maps only messages_pkey to idempotency conflict", async () => {
  const tenantId = "tenant_run_message_constraint_race";
  const setup = await setupConversation(tenantId, "idem_message_constraint_conversation_a");
  const otherConversation = await createConversation(
    { db, now: () => admissionNow },
    setup.context,
    conversationRequest(tenantId, setup.profileId, "idem_message_constraint_conversation_b"),
  );
  await pool.query(`
    create function force_message_identity_collision() returns trigger language plpgsql as $$
    begin
      new.message_id := 'message_forced_database_collision';
      perform pg_sleep(0.2);
      return new;
    end $$;
    create trigger force_message_identity_collision before insert on messages for each row execute function force_message_identity_collision();
  `);
  const results = await Promise.allSettled([
    createAgentRun(
      { db, providerCatalog, now: () => admissionNow },
      setup.context,
      setup.conversation.conversation_id,
      runRequest("idem_message_constraint_run_a", "client_message_constraint_a", "message_constraint_a"),
    ),
    createAgentRun(
      { db, providerCatalog, now: () => admissionNow },
      setup.context,
      otherConversation.conversation_id,
      runRequest("idem_message_constraint_run_b", "client_message_constraint_b", "message_constraint_b"),
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(rejected?.reason instanceof DomainError, true);
  assert.equal((rejected?.reason as DomainError).code, "IDEMPOTENCY_CONFLICT");
});

test("unrelated PostgreSQL unique violations are not mislabeled as client identity conflicts", async () => {
  const setup = await setupConversation("tenant_run_unrelated_unique");
  await pool.query(`
    create function reject_worker_job_with_unrelated_unique() returns trigger language plpgsql as $$
    begin
      raise unique_violation using constraint = 'worker_jobs_pkey';
    end $$;
    create trigger reject_worker_job_with_unrelated_unique before insert on worker_jobs for each row execute function reject_worker_job_with_unrelated_unique();
  `);
  await assert.rejects(
    createAgentRun(
      { db, providerCatalog, now: () => admissionNow },
      setup.context,
      setup.conversation.conversation_id,
      runRequest("idem_unrelated_unique", "client_unrelated_unique", "message_unrelated_unique"),
    ),
    (error: unknown) => {
      assert.equal(error instanceof DomainError, false);
      assert.equal((error as { code?: string }).code, "23505");
      assert.equal((error as { constraint?: string }).constraint, "worker_jobs_pkey");
      return true;
    },
  );
});

test("tenant-scoped Run lookup returns generic not found for absent and cross-tenant Runs", async () => {
  const first = await setupConversation("tenant_run_get_a");
  const second = await setupConversation("tenant_run_get_b");
  const run = await createAgentRun({ db, providerCatalog, now: () => admissionNow }, first.context, first.conversation.conversation_id, runRequest("idem_get_run"));
  assert.deepEqual(await getAgentRun(db, first.context.tenantId, run.run_id), run);
  for (const [tenantId, runId] of [[second.context.tenantId, run.run_id], [first.context.tenantId, "run_absent"]] as const) {
    await assert.rejects(
      getAgentRun(db, tenantId, runId),
      (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND" && error.message === "RESOURCE_NOT_FOUND: Admission resource was not found",
    );
  }
});
