import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { SignedTrustedRequestContext } from "@core-agent/contracts";
import {
  canonicalJson,
  createEntitlementSnapshotAuthorityPort,
  deriveRuntimeContainerId,
  encodeSignedTrustedContext,
  issueCoreSession,
  issueTrustedContext,
} from "@core-agent/runtime-core";

import { authenticateTrustedContextRequest } from "../../apps/control-plane-api/src/trusted-context-auth.js";
import { createIntegrationHarness, type IntegrationHarness } from "./harness.js";

const now = new Date("2026-08-20T06:00:00.000Z");
const pair = generateKeyPairSync("ed25519");
const keyId = "key_task11_trusted_context";
const actorId = "actor_task11_trusted";
const authSubjectId = "auth_subject_task11_trusted";
const tenantId = "tenant_task11_trusted";
const membershipId = "membership_task11_trusted";
const profileId = "profile_task11_trusted";
const containerId = deriveRuntimeContainerId(tenantId);
const conversationId = "conversation_task11_trusted";
const runId = "run_task11_trusted";

let harness: IntegrationHarness;
let sessionId: string;
let capabilityIds: readonly string[];

test.before(async () => {
  harness = await createIntegrationHarness("trusted-context");
  await harness.db.insertInto("tenants").values({
    tenant_id: tenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: "Task11 trusted tenant", created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("actors").values({
    actor_id: actorId, schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: "Task11 trusted consultant", status: "active", created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("auth_subjects").values({
    auth_subject_id: authSubjectId, actor_id: actorId, provider: "supabase",
    provider_subject: "provider_task11_trusted", provider_identity_kind: "email_password",
    verified_at: now, status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("memberships").values({
    tenant_id: tenantId, membership_id: membershipId, actor_id: actorId,
    schema_version: 1, resource_version: 1, roles: ["consultant"], membership_source: "company",
    seat_ref: null, status: "active", created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("profiles").values({
    tenant_id: tenantId, profile_id: profileId, schema_version: 1, resource_version: 1,
    owner_actor_id: actorId, profile_kind: "consultant", hermes_profile_ref: "hermes_task11_trusted",
    description: "Task11 trusted consultant", status: "active",
    provider_config_id: "provider_task11_trusted", model_id: "model_task11_trusted",
    created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("runtime_containers").values({
    tenant_id: tenantId, container_id: containerId, schema_version: 1, resource_version: 1,
    command_version: 1, runtime_kind: "hermes", desired_state: "running", observed_state: "ready",
    image_ref: `managed/runtime:v1@sha256:${"a".repeat(64)}`, runtime_platform: "linux/arm64",
    generation: 1, volume_ref: "volume_task11_trusted", health_status: "healthy",
    last_probed_at: now, failure_summary: null, created_at: now, updated_at: now,
  }).execute();
  capabilityIds = (await harness.seedEntitlementAuthority({ tenantId, profileIds: [profileId], now })).capabilityIds;
  await harness.db.insertInto("conversations").values({
    tenant_id: tenantId, conversation_id: conversationId, profile_id: profileId,
    created_by_actor_id: actorId, status: "active", schema_version: 1, resource_version: 1,
    student_ref: null, case_ref: null, created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("agent_runs").values({
    tenant_id: tenantId, run_id: runId, conversation_id: conversationId,
    request_id: "request_task11_trusted", trace_id: "trace_task11_trusted",
    client_request_id: "client_task11_trusted", idempotency_key: "idem_task11_trusted",
    parent_run_id: null, schema_version: 1, resource_version: 1, status: "queued",
    started_at: null, finished_at: null, failure_code: null, failure_summary: null,
    created_at: now, updated_at: now,
  }).execute();
  const session = await issueCoreSession({ db: harness.db }, {
    sessionId: "session_task11_trusted", actorId, authSubjectId, clientKind: "web",
  });
  sessionId = session.session.session_id;
});

test.after(async () => {
  await harness?.close();
});

async function signedContext(): Promise<SignedTrustedRequestContext> {
  return issueTrustedContext({
    db: harness.db,
    signingKey: { keyId, privateKey: pair.privateKey },
    issuer: "identity-gateway",
    audience: ["control-plane-api"],
    databaseNow: async () => new Date(now),
    entitlementSnapshotAuthority: createEntitlementSnapshotAuthorityPort(),
  }, {
    sessionId, tenantId, membershipId, effectiveRole: "consultant", profileId, containerId,
    conversationId, runId, requestId: "request_task11_trusted", traceId: "trace_task11_trusted",
    clientRequestId: "client_task11_trusted", contextId: "context_task11_trusted", ttlSeconds: 300,
  });
}

async function authenticate(envelope: SignedTrustedRequestContext) {
  const encoded = encodeSignedTrustedContext(envelope);
  return authenticateTrustedContextRequest({
    db: harness.db,
    keys: [{
      keyId, publicKey: pair.publicKey, status: "active",
      activatedAt: "2026-08-20T05:00:00.000Z",
    }],
    expectedIssuer: "identity-gateway",
    expectedAudience: "control-plane-api",
    databaseNow: async () => new Date("2026-08-20T06:01:00.000Z"),
  }, {
    headers: { "x-core-agent-context": encoded },
    rawHeaders: ["x-core-agent-context", encoded],
  });
}

function resign(envelope: SignedTrustedRequestContext, fields: Partial<SignedTrustedRequestContext["payload"]>): SignedTrustedRequestContext {
  const payload = { ...envelope.payload, ...fields };
  return {
    ...envelope,
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload), "utf8"), pair.privateKey).toString("base64url"),
  };
}

test("trusted context derives Control Plane Actor Membership Profile and role from current PostgreSQL authority", async () => {
  const envelope = await signedContext();
  assert.deepEqual(envelope.payload.capability_ids, capabilityIds);
  const authority = await authenticate(envelope);
  assert.deepEqual({
    actorId: authority.actorId,
    membershipId: authority.membershipId,
    profileId: authority.profileId,
    effectiveRole: authority.effectiveRole,
  }, { actorId, membershipId, profileId, effectiveRole: "consultant" });

  await assert.rejects(signedContext().then((context) => authenticate(resign(context, {
    effective_role: "admin",
  }))), /UNAUTHENTICATED|RESOURCE_NOT_FOUND|trusted context/i);
  await assert.rejects(signedContext().then((context) => authenticate(resign(context, {
    actor_id: "actor_browser_forged",
    original_actor_id: "actor_browser_forged",
  }))), /UNAUTHENTICATED|RESOURCE_NOT_FOUND|trusted context/i);
});
