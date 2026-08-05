import assert from "node:assert/strict";
import test from "node:test";

import { ConversationSchema } from "@core-agent/contracts";
import Schema from "typebox/schema";
import { Pool } from "pg";

import { createRuntimeDatabase, DomainError } from "../src/index.js";
import { createConversation } from "../src/services/create-conversation.js";
import {
  admissionNow,
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
const conversationValidator = Schema.Compile(ConversationSchema);

function conversationRequest(tenantId: string, profileId: string, idempotencyKey = `idem_${tenantId}`) {
  return withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: idempotencyKey,
    tenant_id: tenantId,
    profile_id: profileId,
  });
}

test.beforeEach(async () => resetAdmissionDatabase(pool));
test.after(async () => db.destroy());

test("Conversation admission atomically creates one active Conversation, one Hermes Session, event, audit, Outbox, and replay", async () => {
  const tenantId = "tenant_conversation_admission";
  const { profileId } = await seedReadyTenant(db, tenantId);
  const request = withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: "idem_conversation_admission",
    tenant_id: tenantId,
    profile_id: profileId,
    student_ref: { student_id: "student_a", source_system: "eduapply" },
    case_ref: { case_id: "case_a", student_id: "student_a", capability_id: "eduapply" },
  });

  const first = await createConversation({ db, now: () => admissionNow }, serviceContext(tenantId), request);
  const replay = await createConversation({ db, now: () => admissionNow }, serviceContext(tenantId), request);

  assert.equal(conversationValidator.Check(first), true);
  assert.deepEqual(replay, first);
  const sessions = await db.selectFrom("sessions").selectAll().where("tenant_id", "=", tenantId).execute();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.conversation_id, first.conversation_id);
  assert.equal(sessions[0]?.profile_id, profileId);
  assert.equal(sessions[0]?.actor_id, "core_agent_provisioner");
  assert.equal(sessions[0]?.status, "active");
  assert.match(sessions[0]?.hermes_session_ref ?? "", /^hermes_session_/);
  assert.equal(sessions[0]?.last_active_at.toISOString(), admissionNow.toISOString());
  assert.equal(sessions[0]?.expires_at.toISOString(), "2026-09-04T01:00:00.000Z");
  assert.deepEqual(
    await db.selectFrom("product_events").select(["event_type", "sequence"]).where("tenant_id", "=", tenantId).execute(),
    [{ event_type: "conversation.created", sequence: "1" }],
  );
  assert.equal(await db.selectFrom("audit_events").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("outbox").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
  const idempotency = await db.selectFrom("idempotency_records").select(["status", "result_ref", "response_json"])
    .where("tenant_id", "=", tenantId).where("idempotency_key", "=", request.idempotency_key).executeTakeFirstOrThrow();
  assert.equal(idempotency.status, "completed");
  assert.equal(idempotency.result_ref, first.conversation_id);
  assert.deepEqual(idempotency.response_json, first);
});

test("Conversation admission rejects invalid tenant/case authority before writing", async () => {
  const tenantId = "tenant_conversation_invalid_scope";
  const { profileId } = await seedReadyTenant(db, tenantId);
  const badCase = withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: "idem_bad_case",
    tenant_id: tenantId,
    profile_id: profileId,
    student_ref: { student_id: "student_a", source_system: "eduapply" },
    case_ref: { case_id: "case_a", student_id: "student_b", capability_id: "eduapply" },
  });
  await assert.rejects(
    createConversation({ db }, serviceContext(tenantId), badCase),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    createConversation({ db }, serviceContext("tenant_other"), conversationRequest(tenantId, profileId, "idem_wrong_authority")),
    (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
  );
  assert.equal(await db.selectFrom("conversations").selectAll().execute().then((rows) => rows.length), 0);
  assert.equal(await db.selectFrom("idempotency_records").selectAll().execute().then((rows) => rows.length), 0);
});

test("Conversation admission hides absent, cross-tenant, inactive, and untrusted identity resources behind generic not found", async () => {
  const activeTenant = "tenant_conversation_hidden_active";
  const otherTenant = "tenant_conversation_hidden_other";
  const inactiveTenant = "tenant_conversation_hidden_inactive";
  const inactiveProfileTenant = "tenant_conversation_hidden_profile";
  const actorTenant = "tenant_conversation_hidden_actor";
  const { profileId } = await seedReadyTenant(db, activeTenant);
  const { profileId: otherProfileId } = await seedReadyTenant(db, otherTenant);
  const { profileId: inactiveTenantProfile } = await seedReadyTenant(db, inactiveTenant, { tenantStatus: "suspended" });
  const { profileId: inactiveProfile } = await seedReadyTenant(db, inactiveProfileTenant, { profileStatus: "suspended" });
  const { profileId: actorProfile } = await seedReadyTenant(db, actorTenant);
  await db.updateTable("actors").set({ status: "disabled" }).where("tenant_id", "=", actorTenant).where("actor_id", "=", "core_agent_provisioner").execute();

  const attempts = [
    [activeTenant, "profile_absent", "idem_absent_profile"],
    [activeTenant, otherProfileId, "idem_cross_profile"],
    [inactiveTenant, inactiveTenantProfile, "idem_inactive_tenant"],
    [inactiveProfileTenant, inactiveProfile, "idem_inactive_profile"],
    [actorTenant, actorProfile, "idem_inactive_actor"],
  ] as const;
  for (const [tenantId, selectedProfileId, key] of attempts) {
    await assert.rejects(
      createConversation({ db }, serviceContext(tenantId), conversationRequest(tenantId, selectedProfileId, key)),
      (error: unknown) => error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND" && error.message.includes("RESOURCE_NOT_FOUND"),
    );
  }
  assert.equal(profileId.startsWith("profile_"), true);
  assert.equal(await db.selectFrom("conversations").selectAll().execute().then((rows) => rows.length), 0);
});

test("Conversation admission requires the managed Runtime to be desired running, observed ready, and healthy", async () => {
  const cases = [
    ["tenant_conversation_runtime_stopped", { runtimeDesiredState: "stopped" as const, runtimeObservedState: "stopped" as const }],
    ["tenant_conversation_runtime_failed", { runtimeObservedState: "failed" as const }],
    ["tenant_conversation_runtime_unhealthy", { runtimeHealthStatus: "unhealthy" as const }],
  ] as const;
  for (const [tenantId, options] of cases) {
    const { profileId } = await seedReadyTenant(db, tenantId, options);
    await assert.rejects(
      createConversation({ db }, serviceContext(tenantId), conversationRequest(tenantId, profileId)),
      (error: unknown) => error instanceof DomainError && error.code === "RUNTIME_NOT_READY",
    );
  }
  assert.equal(await db.selectFrom("conversations").selectAll().execute().then((rows) => rows.length), 0);
});

test("Conversation idempotency rejects changed payloads and fails closed on a tampered replay result reference", async () => {
  const tenantId = "tenant_conversation_idempotency";
  const { profileId } = await seedReadyTenant(db, tenantId);
  const request = conversationRequest(tenantId, profileId, "idem_conversation_replay");
  await createConversation({ db }, serviceContext(tenantId), request);
  const changed = withPayloadHash({
    schema_version: 1 as const,
    idempotency_key: request.idempotency_key,
    tenant_id: tenantId,
    profile_id: profileId,
    student_ref: { student_id: "student_changed", source_system: "eduapply" },
  });
  await assert.rejects(
    createConversation({ db }, serviceContext(tenantId), changed),
    (error: unknown) => error instanceof DomainError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await db.updateTable("idempotency_records").set({ result_ref: "conversation_attacker" })
    .where("tenant_id", "=", tenantId).where("idempotency_key", "=", request.idempotency_key).execute();
  await assert.rejects(
    createConversation({ db }, serviceContext(tenantId), request),
    (error: unknown) => error instanceof DomainError && error.code === "INTERNAL_ERROR",
  );
  assert.equal(await db.selectFrom("conversations").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("sessions").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
});

test("Conversation identical replay survives later managed Runtime readiness drift without new rows", async () => {
  const tenantId = "tenant_conversation_replay_drift";
  const { profileId } = await seedReadyTenant(db, tenantId);
  const request = conversationRequest(tenantId, profileId, "idem_conversation_replay_drift");
  const first = await createConversation({ db, now: () => admissionNow }, serviceContext(tenantId), request);
  await db.updateTable("runtime_containers").set({ observed_state: "failed", health_status: "unhealthy" })
    .where("tenant_id", "=", tenantId).execute();
  const replay = await createConversation({ db, now: () => admissionNow }, serviceContext(tenantId), request);
  assert.deepEqual(replay, first);
  assert.equal(await db.selectFrom("conversations").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
  assert.equal(await db.selectFrom("sessions").selectAll().where("tenant_id", "=", tenantId).execute().then((rows) => rows.length), 1);
});
