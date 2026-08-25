import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { Pool } from "pg";

import {
  bootstrapBuiltinPolicy,
  closePolicySession,
  createRuntimeDatabase,
  createSyntheticMcpInvocationPort,
  deriveRuntimeContainerId,
  invokeAuthorizedTool,
  issueToolDecision,
  issueTrustedContext,
  listAuthorizedTools,
  loadCurrentSnapshotAuthority,
  openPolicySession,
  resolveProfileSnapshotInTransaction,
  sweepExpiredPolicyProofs,
  type PolicyProofKey,
} from "../src/index.js";
import { admissionNow, resetAdmissionDatabase, seedReadyTenant } from "./admission-test-support.js";
import { buildPolicyMcpGatewayApp, type PolicyMcpGatewayOperations } from "../../../apps/policy-mcp-gateway/src/server.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.slice(1).startsWith("core_agent_")) {
  throw new Error("CONTROL_PLANE_TEST_DATABASE_URL must name a disposable core_agent_ database");
}
const pool = new Pool({ connectionString: databaseUrl, max: 16 });
const db = createRuntimeDatabase(pool);
const bindingDocument = JSON.parse(await readFile(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "policy-mcp", "synthetic-bindings.json"),
  "utf8",
));
const proofBytes = Buffer.alloc(32, 0x51);
const proofKey: PolicyProofKey = Object.freeze({
  withBytes: <T>(use: (bytes: Uint8Array) => T): T => use(proofBytes),
});
const execFileAsync = promisify(execFile);
const workerToken = "policy-postgres-worker-token-00000001";
const pluginToken = "policy-postgres-plugin-token-00000001";
const runtimeToken = "policy-postgres-runtime-token-0000001";
const foreignRuntimeToken = "policy-postgres-runtime-token-foreign01";

const tenantId = "tenant_policy_postgres";
const ownerId = `owner_${tenantId}`;
const membershipId = `membership_${tenantId}`;
const conversationId = "conversation_policy_postgres";
const runId = "run_policy_postgres";
const coreSessionId = "core_session_policy_postgres";
const hermesSessionRef = "hermes_session_policy_postgres";
const requestId = "request_policy_postgres";
const traceId = "trace_policy_postgres";
const clientRequestId = "client_policy_postgres";

async function addReviewedPolicyCapability(profileId: string, runtimeId: string): Promise<void> {
  const capabilityId = "core_agent.synthetic_profile";
  const capabilityVersionId = "core-agent-synthetic-profile-v1";
  const blockedCapabilityId = "core_agent.blocked_profile";
  const blockedCapabilityVersionId = "core-agent-blocked-profile-v1";
  const packProductId = "pack_policy_postgres";
  const packVersionId = "pack_version_policy_postgres";
  const releaseId = "release_policy_postgres";
  await db.insertInto("capabilities").values([{
    capability_id: capabilityId, display_name: "Synthetic profile", owning_domain: "policy", kind: "mcp",
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }, {
    capability_id: blockedCapabilityId, display_name: "Blocked synthetic profile", owning_domain: "policy", kind: "mcp",
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }]).execute();
  const compatibility = {
    core_contract_version: "0.9.0", domain_contract_version: "1.0.0",
    runtime_protocol_version: "1.0.0", tenant_modes: ["b2c"],
  };
  await db.insertInto("capability_versions").values([{
    capability_version_id: capabilityVersionId, capability_id: capabilityId, version: "1.0.0", kind: "mcp",
    artifact_ref: `manifest:sha256:${"c".repeat(64)}`, contract_ref: "gateway-tool-result@0.9.0",
    risk_class: "read", approval_requirement: "none", compatibility_json: compatibility,
    status: "reviewed", resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }, {
    capability_version_id: blockedCapabilityVersionId, capability_id: blockedCapabilityId, version: "1.0.0", kind: "mcp",
    artifact_ref: `manifest:sha256:${"d".repeat(64)}`, contract_ref: "gateway-tool-result@0.9.0",
    risk_class: "read", approval_requirement: "none", compatibility_json: compatibility,
    status: "reviewed", resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }]).execute();
  await db.insertInto("pack_products").values({
    pack_product_id: packProductId, display_name: "Policy PostgreSQL Pack", tenant_modes: ["b2c"],
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("pack_versions").values({
    pack_version_id: packVersionId, pack_product_id: packProductId, version: "1.0.0", status: "draft",
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("pack_members").values([{
    pack_member_id: "pack_member_policy_postgres", pack_version_id: packVersionId, member_order: 2,
    capability_id: capabilityId, capability_version_id: capabilityVersionId, version: "1.0.0",
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }, {
    pack_member_id: "pack_member_blocked_policy_postgres", pack_version_id: packVersionId, member_order: 1,
    capability_id: blockedCapabilityId, capability_version_id: blockedCapabilityVersionId, version: "1.0.0",
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }]).execute();
  await db.updateTable("pack_versions").set({ status: "reviewed", resource_version: 2, updated_at: admissionNow })
    .where("pack_version_id", "=", packVersionId).execute();
  await db.updateTable("pack_versions").set({ status: "published", resource_version: 3, updated_at: admissionNow })
    .where("pack_version_id", "=", packVersionId).execute();
  await db.insertInto("tenant_pack_releases").values({
    tenant_pack_release_id: releaseId, tenant_id: tenantId, pack_product_id: packProductId,
    pack_version_id: packVersionId, pack_version: "1.0.0", generation: 1, status: "preparing",
    resource_version: 1, created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.updateTable("tenant_pack_releases").set({ status: "current", resource_version: 2, updated_at: admissionNow })
    .where("tenant_pack_release_id", "=", releaseId).execute();
  await db.insertInto("entitlements").values({
    entitlement_id: "entitlement_policy_postgres", tenant_id: tenantId, pack_product_id: packProductId,
    tenant_pack_release_id: releaseId, pack_version_id: packVersionId, pack_version: "1.0.0",
    source: "platform_manual", external_order_ref: "synthetic_policy_postgres_order", tenant_mode: "b2c",
    assignment_mode: "automatic", seat_quantity: null, valid_from: admissionNow, expires_at: null,
    status: "active", reason_code: "platform_grant", resource_version: 1,
    created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  const snapshot = await db.transaction().execute((trx) => resolveProfileSnapshotInTransaction({
    trx, tenantId, profileId, now: admissionNow,
    evidence: {
      actorId: "core_agent_provisioner", membershipId: "core_agent_provisioner_admin",
      requestId: "request_policy_snapshot", traceId: "trace_policy_snapshot",
    },
  }));
  await db.updateTable("capability_runtime_projections").set({ status: "available", updated_at: admissionNow })
    .where("projection_id", "=", snapshot.projection.projectionId).execute();
  await db.updateTable("runtime_containers").set({
    generation: snapshot.projection.generation, capability_manifest_digest: snapshot.canonicalInputHash,
  }).where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId).execute();
  await bootstrapBuiltinPolicy(db, ownerId, bindingDocument);
  const blockedSchema = {
    type: "object", additionalProperties: false,
    properties: { profile_id: { type: "string", minLength: 1, maxLength: 64 } },
    required: ["profile_id"],
  };
  const blockedSchemaHash = `sha256:${createHash("sha256")
    .update("core-agent-mcp-input-schema-v1\0").update(JSON.stringify(blockedSchema)).digest("hex")}`;
  await db.insertInto("mcp_tool_bindings").values({
    mcp_tool_binding_id: "core-agent-blocked-profile-binding-v1",
    capability_version_id: blockedCapabilityVersionId, capability_id: blockedCapabilityId,
    capability_version: "1.0.0", mcp_server_version_id: "core-agent-synthetic-v1",
    public_tool_name: blockedCapabilityId, downstream_tool_name: "synthetic_profile",
    title: "Blocked synthetic profile", description: "Blocked acceptance fixture.",
    input_schema_json: blockedSchema, input_schema_hash: blockedSchemaHash,
    output_contract_ref: "gateway-tool-result@0.9.0", status: "blocked",
    reviewed_by_actor_id: ownerId, resource_version: 1,
  }).execute();
}

async function seedExecutionGraph(profileId: string): Promise<void> {
  await db.insertInto("auth_subjects").values({
    auth_subject_id: "subject_policy_postgres", actor_id: ownerId, provider: "supabase",
    provider_subject: "provider_policy_postgres", provider_identity_kind: "email_password",
    verified_at: admissionNow, status: "active", resource_version: 1,
    created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("core_sessions").values({
    session_id: coreSessionId, secret_digest: Buffer.alloc(32, 0x31), csrf_digest: null,
    actor_id: ownerId, auth_subject_id: "subject_policy_postgres", client_kind: "web", status: "active",
    device_label: "Policy PostgreSQL acceptance", created_at: admissionNow, last_seen_at: admissionNow,
    idle_expires_at: new Date("2030-01-01T00:00:00.000Z"),
    absolute_expires_at: new Date("2030-02-01T00:00:00.000Z"), reauthenticated_at: admissionNow,
    revocation_reason: null, resource_version: 1, updated_at: admissionNow,
  }).execute();
  await db.insertInto("conversations").values({
    tenant_id: tenantId, conversation_id: conversationId, profile_id: profileId,
    created_by_actor_id: ownerId, status: "active", schema_version: 1, resource_version: 1,
    student_ref: null, case_ref: null, created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("agent_runs").values({
    tenant_id: tenantId, run_id: runId, conversation_id: conversationId, request_id: requestId,
    trace_id: traceId, client_request_id: clientRequestId, idempotency_key: "idem_policy_postgres",
    parent_run_id: null, schema_version: 1, resource_version: 1, status: "running",
    started_at: admissionNow, finished_at: null, failure_code: null, failure_summary: null,
    created_at: admissionNow, updated_at: admissionNow,
  }).execute();
  await db.insertInto("sessions").values({
    tenant_id: tenantId, session_id: "agent_session_policy_postgres", profile_id: profileId,
    actor_id: ownerId, conversation_id: conversationId, schema_version: 1, resource_version: 1,
    status: "active", last_active_at: admissionNow, expires_at: new Date("2030-01-01T00:00:00.000Z"),
    hermes_session_ref: hermesSessionRef, created_at: admissionNow, updated_at: admissionNow,
  }).execute();
}

function gatewayOperations(
  keys: Parameters<typeof openPolicySession>[0]["trustedContextKeys"],
  maximumProofTtlMs = 30_000,
): PolicyMcpGatewayOperations {
  const invocationPort = createSyntheticMcpInvocationPort();
  const runtimeContainerId = deriveRuntimeContainerId(tenantId);
  return {
    authenticateWorker: (token) => token === workerToken,
    authenticatePlugin: async (token) => {
      if (token !== pluginToken) return undefined;
      const runtime = await db.selectFrom("runtime_containers").select("generation")
        .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeContainerId).executeTakeFirstOrThrow();
      return { tenantId, runtimeContainerId, runtimeGeneration: runtime.generation };
    },
    authenticateRuntime: async (token) => {
      if (token === runtimeToken) {
        const runtime = await db.selectFrom("runtime_containers").select("generation")
          .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeContainerId).executeTakeFirstOrThrow();
        return { tenantId, profileId: `profile_${tenantId}`, runtimeContainerId, runtimeGeneration: runtime.generation };
      }
      if (token === foreignRuntimeToken) return { tenantId: "tenant_policy_foreign", profileId: "profile_policy_foreign", runtimeContainerId: "runtime_policy_foreign", runtimeGeneration: 1 };
      return undefined;
    },
    openSession: (request) => openPolicySession({
      db, trustedContextKeys: keys, expectedIssuer: "core-agent-control-plane-worker",
      expectedAudience: "core-agent-policy-gateway",
    }, request),
    closeSession: (requestedTenantId, request) => closePolicySession(db, requestedTenantId, request),
    decide: (identity, request) => issueToolDecision({ db, proofKey, maximumProofTtlMs }, identity, request),
    resolveSession: async (identity) => {
      const active = await db.selectFrom("policy_sessions").select("policy_session_id")
        .where("tenant_id", "=", identity.tenantId).where("profile_id", "=", identity.profileId)
        .where("runtime_container_id", "=", identity.runtimeContainerId)
        .where("runtime_generation", "=", identity.runtimeGeneration).where("state", "=", "active").limit(2).execute();
      return active.length === 1 ? { policySessionId: active[0]!.policy_session_id } : undefined;
    },
    listTools: (identity, policySessionId) => listAuthorizedTools(db, identity, policySessionId),
    callTool: (input) => invokeAuthorizedTool({ db, proofKey, invocationPort }, input),
    ready: async () => true,
  };
}

async function postJson(origin: string, path: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function runRealPythonPlugin(origin: string, tokenFile: string, argumentsValue: Record<string, unknown>, toolCallId: string) {
  const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "infra", "hermes", "plugins", "core-agent-policy", "__init__.py");
  const python = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("core_agent_policy_acceptance", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module._on_pre_tool_call(
    tool_name="mcp__core_agent_gateway__core_agent_synthetic_profile",
    args=json.loads(sys.argv[2]),
    session_id=sys.argv[3],
    tool_call_id=sys.argv[4],
)
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
`;
  const execution = await execFileAsync(process.env.PYTHON ?? "python3", [
    "-c", python, pluginPath, JSON.stringify(argumentsValue), hermesSessionRef, toolCallId,
  ], {
    env: {
      ...process.env,
      CORE_AGENT_POLICY_GATEWAY_ORIGIN: origin,
      CORE_AGENT_POLICY_PLUGIN_TOKEN_FILE: tokenFile,
    },
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  return JSON.parse(execution.stdout) as { action: string; args?: Record<string, unknown>; message?: string };
}

async function signedOpenFixture(suffix: string) {
  const profileId = `profile_${tenantId}`;
  const runtime = await db.selectFrom("runtime_containers").select(["container_id", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  const keyPair = generateKeyPairSync("ed25519");
  const signedContext = await issueTrustedContext({
    db, signingKey: { keyId: `policy-${suffix}-signing-v1`, privateKey: keyPair.privateKey },
    issuer: "core-agent-control-plane-worker", audience: ["core-agent-policy-gateway"],
    entitlementSnapshotAuthority: {
      loadCurrentSnapshot: (input) => loadCurrentSnapshotAuthority({
        trx: input.trx, tenantId: input.tenantId, profileId: input.profileId, now: input.now,
      }),
    },
  }, {
    sessionId: coreSessionId, tenantId, membershipId, effectiveRole: "student", profileId,
    containerId: runtime.container_id, conversationId, runId, requestId, traceId, clientRequestId,
    contextId: `context_policy_${suffix}`, ttlSeconds: 300,
  });
  const dependencies = {
    db, trustedContextKeys: [{ keyId: `policy-${suffix}-signing-v1`, publicKey: keyPair.publicKey,
      status: "active", activatedAt: "2020-01-01T00:00:00.000Z" }],
    expectedIssuer: "core-agent-control-plane-worker", expectedAudience: "core-agent-policy-gateway",
  } as const;
  const request = {
    schema_version: 1, signed_context: signedContext, runtime_container_id: runtime.container_id,
    runtime_generation: runtime.generation, hermes_session_ref: hermesSessionRef,
    idempotency_key: `open_policy_${suffix}`, correlation_id: `correlation_policy_${suffix}`,
  } as const;
  return { dependencies, request, runtime, profileId };
}

async function openPolicyFixture(suffix: string) {
  const fixture = await signedOpenFixture(suffix);
  const opened = await openPolicySession(fixture.dependencies, fixture.request);
  return {
    opened, runtime: fixture.runtime,
    pluginIdentity: { tenantId, runtimeContainerId: fixture.runtime.container_id, runtimeGeneration: fixture.runtime.generation },
    runtimeIdentity: { tenantId, profileId: fixture.profileId, runtimeContainerId: fixture.runtime.container_id, runtimeGeneration: fixture.runtime.generation },
  };
}

test.beforeEach(async () => {
  await resetAdmissionDatabase(pool);
  const seeded = await seedReadyTenant(db, tenantId);
  await addReviewedPolicyCapability(seeded.profileId, seeded.runtimeId);
  await seedExecutionGraph(seeded.profileId);
});

test.after(async () => {
  proofBytes.fill(0);
  await db.destroy();
});

test("Policy Session admission revalidates every mutable signed authority dimension", async () => {
  const cases: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["tenant", () => db.updateTable("tenants").set({ status: "suspended" }).where("tenant_id", "=", tenantId).execute()],
    ["actor", () => db.updateTable("actors").set({ status: "disabled" }).where("actor_id", "=", ownerId).execute()],
    ["membership status", () => db.updateTable("memberships").set({ status: "suspended" })
      .where("tenant_id", "=", tenantId).where("membership_id", "=", membershipId).execute()],
    ["profile", () => db.updateTable("profiles").set({ status: "suspended" })
      .where("tenant_id", "=", tenantId).where("profile_id", "=", `profile_${tenantId}`).execute()],
    ["conversation", () => db.updateTable("conversations").set({ status: "archived" })
      .where("tenant_id", "=", tenantId).where("conversation_id", "=", conversationId).execute()],
    ["runtime desired state", () => db.updateTable("runtime_containers").set({ desired_state: "stopped" })
      .where("tenant_id", "=", tenantId).execute()],
  ];
  for (const [name, mutate] of cases) {
    const fixture = await signedOpenFixture(`admission_${name.replaceAll(" ", "_")}`);
    await mutate();
    await assert.rejects(openPolicySession(fixture.dependencies, fixture.request), (error: unknown) => (
      error instanceof Error && "code" in error && error.code === "POLICY_DENIED"
    ), name);
    assert.equal(await db.selectFrom("policy_sessions").select("policy_session_id").execute().then((rows) => rows.length), 0);
    await resetAdmissionDatabase(pool);
    const seeded = await seedReadyTenant(db, tenantId);
    await addReviewedPolicyCapability(seeded.profileId, seeded.runtimeId);
    await seedExecutionGraph(seeded.profileId);
  }
});

test("Policy Session preserves the signed effective role and denies use after that role is revoked", async () => {
  const fixture = await signedOpenFixture("signed_effective_role");
  const opened = await openPolicySession(fixture.dependencies, fixture.request);
  const persisted = await pool.query<{ effective_role: string }>(
    "select effective_role from policy_sessions where tenant_id = $1 and policy_session_id = $2",
    [tenantId, opened.policy_session_id],
  );
  assert.equal(persisted.rows[0]?.effective_role, "student");

  await db.updateTable("memberships").set({
    membership_source: "company", roles: ["consultant"], updated_at: new Date(),
  })
    .where("tenant_id", "=", tenantId).where("membership_id", "=", membershipId).execute();
  const decision = await issueToolDecision({ db, proofKey }, {
    tenantId, runtimeContainerId: fixture.runtime.container_id, runtimeGeneration: fixture.runtime.generation,
  }, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_revoked_effective_role",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reason, "CURRENT_AUTHORITY_CHANGED");
});

test("real PostgreSQL enforces one policy session one proof consumption and one audited MCP effect", async () => {
  const profileId = `profile_${tenantId}`;
  const runtime = await db.selectFrom("runtime_containers").select(["container_id", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  const keyPair = generateKeyPairSync("ed25519");
  const signedContext = await issueTrustedContext({
    db, signingKey: { keyId: "policy-postgres-signing-v1", privateKey: keyPair.privateKey },
    issuer: "core-agent-control-plane-worker", audience: ["core-agent-policy-gateway"],
    entitlementSnapshotAuthority: {
      loadCurrentSnapshot: (input) => loadCurrentSnapshotAuthority({
        trx: input.trx, tenantId: input.tenantId, profileId: input.profileId, now: input.now,
      }),
    },
  }, {
    sessionId: coreSessionId, tenantId, membershipId, effectiveRole: "student", profileId,
    containerId: runtime.container_id, conversationId, runId, requestId, traceId, clientRequestId,
    contextId: "context_policy_postgres", ttlSeconds: 300,
  });
  const openDependencies = {
    db,
    trustedContextKeys: [{
      keyId: "policy-postgres-signing-v1", publicKey: keyPair.publicKey, status: "active" as const,
      activatedAt: "2020-01-01T00:00:00.000Z",
    }],
    expectedIssuer: "core-agent-control-plane-worker", expectedAudience: "core-agent-policy-gateway",
  };
  const openRequest = {
    schema_version: 1 as const, signed_context: signedContext, runtime_container_id: runtime.container_id,
    runtime_generation: runtime.generation, hermes_session_ref: hermesSessionRef,
    idempotency_key: "open_policy_postgres", correlation_id: "correlation_policy_postgres",
  };
  const open = await openPolicySession(openDependencies, openRequest);
  assert.equal((await openPolicySession(openDependencies, openRequest)).policy_session_id, open.policy_session_id);
  const runtimeIdentity = { tenantId, profileId, runtimeContainerId: runtime.container_id, runtimeGeneration: runtime.generation };
  const pluginIdentity = { tenantId, runtimeContainerId: runtime.container_id, runtimeGeneration: runtime.generation };
  assert.deepEqual((await listAuthorizedTools(db, runtimeIdentity, open.policy_session_id)).map((tool) => tool.name),
    ["core_agent.synthetic_profile"]);
  assert.deepEqual(await listAuthorizedTools(db, { ...runtimeIdentity, profileId: "profile_same_tenant_other" }, open.policy_session_id), []);
  assert.deepEqual(await listAuthorizedTools(db, { ...runtimeIdentity, runtimeGeneration: runtime.generation + 1 }, open.policy_session_id), []);
  assert.equal((await db.selectFrom("policy_sessions").select("state").where("tenant_id", "=", tenantId)
    .where("policy_session_id", "=", open.policy_session_id).executeTakeFirstOrThrow()).state, "active");
  const wrongPlugin = await issueToolDecision({ db, proofKey }, {
    ...pluginIdentity, runtimeGeneration: runtime.generation + 1,
  }, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_wrong_plugin_generation",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(wrongPlugin.decision, "deny");
  assert.equal(await db.selectFrom("audit_events").select("audit_event_id").where("tenant_id", "=", tenantId)
    .where("action", "=", "policy.authentication").execute().then((rows) => rows.length), 1);

  const decision = await issueToolDecision({ db, proofKey }, pluginIdentity, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_policy_postgres",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(decision.decision, "allow");
  if (decision.decision !== "allow") return;
  const invocationDependencies = { db, proofKey, invocationPort: createSyntheticMcpInvocationPort() };
  assert.deepEqual(await invokeAuthorizedTool(invocationDependencies, {
    identity: runtimeIdentity, policySessionId: open.policy_session_id,
    toolName: "core_agent.synthetic_profile", proof: decision.execution_proof,
    arguments: { profile_id: "different" },
  }), { content: [{ type: "text", text: "PROOF_INVALID" }], isError: true });
  assert.deepEqual(await invokeAuthorizedTool(invocationDependencies, {
    identity: { ...runtimeIdentity, profileId: "profile_same_tenant_other" }, policySessionId: open.policy_session_id,
    toolName: "core_agent.synthetic_profile", proof: decision.execution_proof,
    arguments: { profile_id: "fixture" },
  }), { content: [{ type: "text", text: "SESSION_NOT_ACTIVE" }], isError: true });
  assert.equal((await db.selectFrom("policy_execution_proofs").select("state").where("tenant_id", "=", tenantId)
    .executeTakeFirstOrThrow()).state, "issued");

  const results = await Promise.all([
    invokeAuthorizedTool(invocationDependencies, {
      identity: runtimeIdentity, policySessionId: open.policy_session_id,
      toolName: "core_agent.synthetic_profile", proof: decision.execution_proof,
      arguments: { profile_id: "fixture" },
    }),
    invokeAuthorizedTool(invocationDependencies, {
      identity: runtimeIdentity, policySessionId: open.policy_session_id,
      toolName: "core_agent.synthetic_profile", proof: decision.execution_proof,
      arguments: { profile_id: "fixture" },
    }),
  ]);
  assert.equal(results.filter((result) => result.isError === false).length, 1);
  assert.equal(results.filter((result) => result.isError === true
    && result.content[0]?.text === "PROOF_REPLAYED").length, 1);
  assert.equal(await db.selectFrom("mcp_tool_calls").select("mcp_tool_call_id").where("tenant_id", "=", tenantId)
    .where("status", "=", "succeeded").execute().then((rows) => rows.length), 1);
  assert.deepEqual(await db.selectFrom("product_events").select("event_type").where("tenant_id", "=", tenantId)
    .where("run_id", "=", runId).orderBy("sequence").execute().then((rows) => rows.map((row) => row.event_type)),
  ["policy_session.opened", "policy.decision_recorded", "tool.requested", "tool.started", "tool.succeeded"]);
  assert.equal(await db.selectFrom("audit_events").select("audit_event_id").where("tenant_id", "=", tenantId)
    .where("action", "=", "tool.invoke").execute().then((rows) => rows.length), 1);
  const proofAudit = await db.selectFrom("audit_events").select(["entitlement_snapshot_ref", "resource_id"])
    .where("tenant_id", "=", tenantId).where("action", "=", "policy.proof.consume").executeTakeFirstOrThrow();
  assert.equal(proofAudit.resource_id.startsWith("proof-"), true);
  assert.notEqual(proofAudit.entitlement_snapshot_ref, null);
  assert.notEqual((await db.selectFrom("audit_events").select("entitlement_snapshot_ref")
    .where("tenant_id", "=", tenantId).where("action", "=", "tool.invoke")
    .executeTakeFirstOrThrow()).entitlement_snapshot_ref, null);
  assert.equal((await db.selectFrom("policy_execution_proofs").select("state").where("tenant_id", "=", tenantId)
    .executeTakeFirstOrThrow()).state, "consumed");
  const consumedProof = await db.selectFrom("policy_execution_proofs").selectAll().where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  await assert.rejects(db.updateTable("policy_execution_proofs").set({
    state: "issued", consumed_at: null, invalidated_at: null, resource_version: 3, updated_at: new Date(),
  }).where("tenant_id", "=", tenantId).where("proof_id", "=", consumedProof.proof_id).execute(), /transition/iu);
  const succeededCall = await db.selectFrom("mcp_tool_calls").selectAll().where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  await assert.rejects(db.updateTable("mcp_tool_calls").set({
    status: "requested", started_at: null, finished_at: null, reason_code: null, safe_result_summary: null,
    resource_version: 4, updated_at: new Date(),
  }).where("tenant_id", "=", tenantId).where("mcp_tool_call_id", "=", succeededCall.mcp_tool_call_id).execute(), /transition/iu);

  const activeSession = await db.selectFrom("policy_sessions").select(["created_at", "resource_version"])
    .where("tenant_id", "=", tenantId).where("policy_session_id", "=", open.policy_session_id).executeTakeFirstOrThrow();
  const beforeSessionCreation = new Date(activeSession.created_at.getTime() - 1);
  await assert.rejects(db.updateTable("policy_sessions").set({
    state: "closed", close_reason: "run_failed", closed_at: beforeSessionCreation,
    resource_version: Number(activeSession.resource_version) + 1, updated_at: activeSession.created_at,
  }).where("tenant_id", "=", tenantId).where("policy_session_id", "=", open.policy_session_id).execute(),
  /policy_sessions_state_check/iu);

  const temporalDecision = await issueToolDecision({ db, proofKey }, pluginIdentity, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_temporal_guard",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "temporal" },
  });
  assert.equal(temporalDecision.decision, "allow");
  if (temporalDecision.decision !== "allow") return;
  const issuedProof = await db.selectFrom("policy_execution_proofs").selectAll().where("tenant_id", "=", tenantId)
    .where("decision_id", "=", temporalDecision.decision_id).executeTakeFirstOrThrow();
  const beforeProofCreation = new Date(issuedProof.created_at.getTime() - 1);
  await assert.rejects(db.updateTable("policy_execution_proofs").set({
    state: "consumed", consumed_at: beforeProofCreation, resource_version: 2, updated_at: new Date(),
  }).where("tenant_id", "=", tenantId).where("proof_id", "=", issuedProof.proof_id).execute(),
  /policy_execution_proofs_state_check/iu);
  const temporalStoredDecision = await db.selectFrom("policy_decisions").select("mcp_tool_binding_id")
    .where("tenant_id", "=", tenantId).where("decision_id", "=", temporalDecision.decision_id).executeTakeFirstOrThrow();
  const requestedAt = new Date();
  await db.insertInto("mcp_tool_calls").values({
    tenant_id: tenantId, mcp_tool_call_id: "mcp-call-temporal-guard", policy_session_id: open.policy_session_id,
    decision_id: temporalDecision.decision_id, proof_id: issuedProof.proof_id,
    mcp_tool_binding_id: temporalStoredDecision.mcp_tool_binding_id!, tool_call_id: "tool_call_temporal_guard",
    public_tool_name: "core_agent.synthetic_profile", arguments_hash: issuedProof.arguments_hash,
    status: "requested", reason_code: null, safe_result_summary: null, requested_at: requestedAt,
    started_at: null, finished_at: null, resource_version: 1, updated_at: requestedAt,
  }).execute();
  await assert.rejects(db.updateTable("mcp_tool_calls").set({
    status: "failed", started_at: new Date(requestedAt.getTime() - 1), finished_at: requestedAt,
    reason_code: "DOWNSTREAM_UNAVAILABLE", safe_result_summary: "Rejected forged timeline",
    resource_version: 2, updated_at: requestedAt,
  }).where("tenant_id", "=", tenantId).where("mcp_tool_call_id", "=", "mcp-call-temporal-guard").execute(),
  /mcp_tool_calls_lifecycle_check/iu);

  assert.equal((await closePolicySession(db, tenantId, {
    schema_version: 1, policy_session_id: open.policy_session_id, run_id: runId, reason: "run_succeeded",
    idempotency_key: "close_policy_postgres", request_id: requestId, trace_id: traceId,
  })).state, "closed");
  await assert.rejects(db.updateTable("policy_sessions").set({
    state: "active", close_reason: null, closed_at: null, resource_version: 3, updated_at: new Date(),
  }).where("tenant_id", "=", tenantId).where("policy_session_id", "=", open.policy_session_id).execute(), /transition/iu);
  assert.deepEqual(await listAuthorizedTools(db, runtimeIdentity, open.policy_session_id), []);
  const afterClose = await issueToolDecision({ db, proofKey }, pluginIdentity, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_after_close",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(afterClose.decision, "deny");
  assert.equal(afterClose.reason, "SESSION_NOT_ACTIVE");
});

test("live Gateway HTTP and real Hermes Python plugin complete one reviewed synthetic MCP read", async () => {
  const profileId = `profile_${tenantId}`;
  const runtime = await db.selectFrom("runtime_containers").select(["container_id", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  const keyPair = generateKeyPairSync("ed25519");
  const signedContext = await issueTrustedContext({
    db, signingKey: { keyId: "policy-http-signing-v1", privateKey: keyPair.privateKey },
    issuer: "core-agent-control-plane-worker", audience: ["core-agent-policy-gateway"],
    entitlementSnapshotAuthority: {
      loadCurrentSnapshot: (input) => loadCurrentSnapshotAuthority({
        trx: input.trx, tenantId: input.tenantId, profileId: input.profileId, now: input.now,
      }),
    },
  }, {
    sessionId: coreSessionId, tenantId, membershipId, effectiveRole: "student", profileId,
    containerId: runtime.container_id, conversationId, runId, requestId, traceId, clientRequestId,
    contextId: "context_policy_http", ttlSeconds: 300,
  });
  const trustedKeys = [{
    keyId: "policy-http-signing-v1", publicKey: keyPair.publicKey, status: "active" as const,
    activatedAt: "2020-01-01T00:00:00.000Z",
  }];
  const app = buildPolicyMcpGatewayApp(gatewayOperations(trustedKeys, 5_000));
  const temporary = await mkdtemp(join(tmpdir(), "core-agent-policy-plugin-"));
  const tokenFile = join(temporary, "plugin-token");
  await writeFile(tokenFile, pluginToken, { encoding: "utf8", mode: 0o600 });
  await chmod(tokenFile, 0o600);
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = address.replace(/\/$/u, "");
    assert.deepEqual(await fetch(`${origin}/ready`).then((response) => response.json()), { status: "ready" });

    const openBody = {
      schema_version: 1, signed_context: signedContext, runtime_container_id: runtime.container_id,
      runtime_generation: runtime.generation, hermes_session_ref: hermesSessionRef,
      idempotency_key: "open_policy_http", correlation_id: "correlation_policy_http",
    };
    const missingAuth = await fetch(`${origin}/v1/policy-sessions/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openBody),
    });
    assert.equal(missingAuth.status, 401);
    const wrongRuntime = await postJson(origin, "/v1/policy-sessions/open", workerToken, {
      ...openBody, runtime_container_id: "runtime_forged_nonexistent",
    });
    assert.equal(wrongRuntime.status, 401);
    assert.equal((await wrongRuntime.text()).includes("runtime_forged_nonexistent"), false);
    const openedResponse = await postJson(origin, "/v1/policy-sessions/open", workerToken, openBody);
    assert.equal(openedResponse.status, 200);
    const opened = await openedResponse.json() as { policy_session_id: string; state: string };
    assert.equal(opened.state, "active");

    const initialized = await postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hermes", version: "acceptance" } },
    });
    assert.equal(initialized.status, 200);
    const mcpSessionId = initialized.headers.get("mcp-session-id") ?? "";
    assert.match(mcpSessionId, /^[A-Za-z0-9_-]{43}$/u);
    const mcpHeaders = { "mcp-session-id": mcpSessionId };
    assert.equal((await postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", method: "notifications/initialized", params: {},
    }, mcpHeaders)).status, 202);
    const stolenSession = await postJson(origin, "/mcp", foreignRuntimeToken, {
      jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
    }, mcpHeaders);
    assert.equal(stolenSession.status, 401);
    const listed = await postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", id: 3, method: "tools/list", params: {},
    }, mcpHeaders);
    assert.deepEqual((await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
      ["core_agent.synthetic_profile"]);

    const unknown = await postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", id: 4, method: "resources/list", params: {},
    }, mcpHeaders);
    assert.equal((await unknown.json() as { error: { code: number } }).error.code, -32601);
    const oversizedSentinel = "oversized-private-sentinel-should-never-echo";
    const oversized = await postJson(origin, "/mcp", runtimeToken,
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", padding: oversizedSentinel.repeat(5000) }), mcpHeaders);
    assert.equal(oversized.status, 400);
    assert.equal((await oversized.text()).includes(oversizedSentinel), false);

    const unknownDecision = await postJson(origin, "/v1/policy-decisions", pluginToken, {
      schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_unknown_http",
      tool_name: "core_agent.unknown", arguments: {},
    });
    assert.equal((await unknownDecision.json() as { decision: string }).decision, "deny");
    const blockedDecision = await postJson(origin, "/v1/policy-decisions", pluginToken, {
      schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_blocked_http",
      tool_name: "core_agent.blocked_profile", arguments: { profile_id: "fixture" },
    }).then((response) => response.json()) as { decision: string; reason: string };
    assert.equal(blockedDecision.decision, "deny");
    assert.equal(blockedDecision.reason, "CAPABILITY_NOT_EFFECTIVE");

    const pluginResult = await runRealPythonPlugin(origin, tokenFile, { profile_id: "fixture" }, "tool_call_python_http");
    assert.equal(pluginResult.action, "modify");
    assert.equal(typeof pluginResult.args?.__core_agent_policy, "string");
    const proof = String(pluginResult.args?.__core_agent_policy);
    const changedArguments = await postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", id: "changed", method: "tools/call",
      params: { name: "core_agent.synthetic_profile", arguments: { profile_id: "altered", __core_agent_policy: proof } },
    }, mcpHeaders);
    assert.equal((await changedArguments.json() as { result: { content: Array<{ text: string }> } }).result.content[0]?.text, "PROOF_INVALID");

    const calls = await Promise.all([1, 2].map((id) => postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", id: `replay-${id}`, method: "tools/call",
      params: { name: "core_agent.synthetic_profile", arguments: pluginResult.args },
    }, mcpHeaders).then((response) => response.json() as Promise<{ result: { content: Array<{ text: string }>; isError: boolean } }>)));
    assert.equal(calls.filter((result) => result.result.isError === false).length, 1);
    assert.equal(calls.filter((result) => result.result.isError === true
      && result.result.content[0]?.text === "PROOF_REPLAYED").length, 1);
    const success = calls.find((result) => result.result.isError === false)!;
    assert.deepEqual(JSON.parse(success.result.content[0]!.text), {
      fixture: "synthetic_profile", status: "available", profile_id: "fixture",
    });

    const expiringDecision = await postJson(origin, "/v1/policy-decisions", pluginToken, {
      schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_expired_http",
      tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "expired" },
    }).then((response) => response.json()) as { decision: string; execution_proof: string; decision_id: string };
    assert.equal(expiringDecision.decision, "allow");
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    assert.equal(await sweepExpiredPolicyProofs(db), 1);
    assert.equal(await sweepExpiredPolicyProofs(db), 0);
    const sweptProof = await db.selectFrom("policy_execution_proofs").select(["state", "expires_at", "invalidated_at"])
      .where("tenant_id", "=", tenantId).where("decision_id", "=", expiringDecision.decision_id)
      .executeTakeFirstOrThrow();
    assert.equal(sweptProof.state, "expired");
    assert.equal(sweptProof.invalidated_at!.getTime() >= sweptProof.expires_at.getTime(), true);
    const expired = await postJson(origin, "/mcp", runtimeToken, {
      jsonrpc: "2.0", id: "expired", method: "tools/call", params: {
        name: "core_agent.synthetic_profile",
        arguments: { profile_id: "expired", __core_agent_policy: expiringDecision.execution_proof },
      },
    }, mcpHeaders).then((response) => response.json()) as { result: { content: Array<{ text: string }> } };
    assert.equal(expired.result.content[0]?.text, "PROOF_EXPIRED");

    const closed = await postJson(origin, `/v1/policy-sessions/${encodeURIComponent(opened.policy_session_id)}/close`, workerToken, {
      schema_version: 1, policy_session_id: opened.policy_session_id, run_id: runId, reason: "run_succeeded",
      idempotency_key: "close_policy_http", request_id: requestId, trace_id: traceId,
    }, { "x-core-agent-tenant-id": tenantId });
    assert.equal((await closed.json() as { state: string }).state, "closed");
    const deniedPluginResult = await runRealPythonPlugin(origin, tokenFile, { profile_id: "fixture" }, "tool_call_closed_http");
    assert.equal(deniedPluginResult.action, "block");
    assert.equal(JSON.stringify(deniedPluginResult).includes(pluginToken), false);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("revoked entitlement invalidates the active snapshot session and every later decision", async () => {
  const profileId = `profile_${tenantId}`;
  const runtime = await db.selectFrom("runtime_containers").select(["container_id", "generation"])
    .where("tenant_id", "=", tenantId).executeTakeFirstOrThrow();
  const keyPair = generateKeyPairSync("ed25519");
  const signedContext = await issueTrustedContext({
    db, signingKey: { keyId: "policy-revocation-signing-v1", privateKey: keyPair.privateKey },
    issuer: "core-agent-control-plane-worker", audience: ["core-agent-policy-gateway"],
    entitlementSnapshotAuthority: {
      loadCurrentSnapshot: (input) => loadCurrentSnapshotAuthority({
        trx: input.trx, tenantId: input.tenantId, profileId: input.profileId, now: input.now,
      }),
    },
  }, {
    sessionId: coreSessionId, tenantId, membershipId, effectiveRole: "student", profileId,
    containerId: runtime.container_id, conversationId, runId, requestId, traceId, clientRequestId,
    contextId: "context_policy_revocation", ttlSeconds: 300,
  });
  const dependencies = {
    db,
    trustedContextKeys: [{
      keyId: "policy-revocation-signing-v1", publicKey: keyPair.publicKey, status: "active" as const,
      activatedAt: "2020-01-01T00:00:00.000Z",
    }],
    expectedIssuer: "core-agent-control-plane-worker", expectedAudience: "core-agent-policy-gateway",
  };
  const opened = await openPolicySession(dependencies, {
    schema_version: 1, signed_context: signedContext, runtime_container_id: runtime.container_id,
    runtime_generation: runtime.generation, hermes_session_ref: hermesSessionRef,
    idempotency_key: "open_policy_revocation", correlation_id: "correlation_policy_revocation",
  });
  await db.updateTable("entitlements").set({
    status: "suspended", reason_code: "administrator_suspended", resource_version: 2, updated_at: new Date(),
  }).where("tenant_id", "=", tenantId).where("entitlement_id", "=", "entitlement_policy_postgres").execute();
  const runtimeIdentity = { tenantId, profileId, runtimeContainerId: runtime.container_id, runtimeGeneration: runtime.generation };
  assert.deepEqual(await listAuthorizedTools(db, runtimeIdentity, opened.policy_session_id), []);
  const denied = await issueToolDecision({ db, proofKey }, {
    tenantId, runtimeContainerId: runtime.container_id, runtimeGeneration: runtime.generation,
  }, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_revoked",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(denied.decision, "deny");
  assert.equal(denied.reason, "SESSION_NOT_ACTIVE");
  assert.equal((await db.selectFrom("policy_decisions").select("reason_code").where("tenant_id", "=", tenantId)
    .where("tool_call_id", "=", "tool_call_revoked").executeTakeFirstOrThrow()).reason_code, "SESSION_NOT_ACTIVE");
  assert.equal(await db.selectFrom("audit_events").select("audit_event_id").where("tenant_id", "=", tenantId)
    .where("action", "=", "policy.decision").where("decision", "=", "denied")
    .execute().then((rows) => rows.length), 1);
});

test("revoked Core Session and terminal Run revoke current Policy authority before any Tool effect", async () => {
  const first = await openPolicyFixture("core_session_revoked");
  const decision = await issueToolDecision({ db, proofKey }, first.pluginIdentity, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_core_session_revoked",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(decision.decision, "allow");
  if (decision.decision !== "allow") return;
  await db.updateTable("core_sessions").set({
    status: "revoked", revocation_reason: "administrator_revoked", resource_version: 2, updated_at: new Date(),
  }).where("session_id", "=", coreSessionId).execute();
  const denied = await invokeAuthorizedTool({ db, proofKey, invocationPort: createSyntheticMcpInvocationPort() }, {
    identity: first.runtimeIdentity, policySessionId: first.opened.policy_session_id,
    toolName: "core_agent.synthetic_profile", proof: decision.execution_proof, arguments: { profile_id: "fixture" },
  });
  assert.deepEqual(denied, { content: [{ type: "text", text: "CURRENT_AUTHORITY_CHANGED" }], isError: true });
  assert.equal((await db.selectFrom("policy_execution_proofs").select("state").where("tenant_id", "=", tenantId)
    .executeTakeFirstOrThrow()).state, "invalidated");
  assert.equal((await db.selectFrom("mcp_tool_calls").select("mcp_tool_call_id").where("tenant_id", "=", tenantId).execute()).length, 0);

  await resetAdmissionDatabase(pool);
  const seeded = await seedReadyTenant(db, tenantId);
  await addReviewedPolicyCapability(seeded.profileId, seeded.runtimeId);
  await seedExecutionGraph(seeded.profileId);
  const second = await openPolicyFixture("terminal_run");
  await db.updateTable("agent_runs").set({ status: "succeeded", finished_at: new Date(), resource_version: 2, updated_at: new Date() })
    .where("tenant_id", "=", tenantId).where("run_id", "=", runId).execute();
  assert.deepEqual(await listAuthorizedTools(db, second.runtimeIdentity, second.opened.policy_session_id), []);
  assert.equal((await db.selectFrom("policy_sessions").select("state").where("tenant_id", "=", tenantId)
    .where("policy_session_id", "=", second.opened.policy_session_id).executeTakeFirstOrThrow()).state, "closed");
});

test("proof consumption rolls back when requested Tool-call persistence fails", async () => {
  const fixture = await openPolicyFixture("atomic_call");
  const decision = await issueToolDecision({ db, proofKey }, fixture.pluginIdentity, {
    schema_version: 1, hermes_session_ref: hermesSessionRef, tool_call_id: "tool_call_atomic_conflict",
    tool_name: "core_agent.synthetic_profile", arguments: { profile_id: "fixture" },
  });
  assert.equal(decision.decision, "allow");
  if (decision.decision !== "allow") return;
  const proof = await db.selectFrom("policy_execution_proofs").selectAll().where("tenant_id", "=", tenantId)
    .where("decision_id", "=", decision.decision_id).executeTakeFirstOrThrow();
  const storedDecision = await db.selectFrom("policy_decisions").selectAll().where("tenant_id", "=", tenantId)
    .where("decision_id", "=", decision.decision_id).executeTakeFirstOrThrow();
  await db.insertInto("mcp_tool_calls").values({
    tenant_id: tenantId, mcp_tool_call_id: "mcp-call-preexisting-atomic", policy_session_id: fixture.opened.policy_session_id,
    decision_id: decision.decision_id, proof_id: proof.proof_id, mcp_tool_binding_id: storedDecision.mcp_tool_binding_id!,
    tool_call_id: "tool_call_atomic_conflict", public_tool_name: "core_agent.synthetic_profile",
    arguments_hash: proof.arguments_hash, status: "requested", reason_code: null, safe_result_summary: null,
    requested_at: new Date(), started_at: null, finished_at: null, resource_version: 1, updated_at: new Date(),
  }).execute();
  await assert.rejects(invokeAuthorizedTool({ db, proofKey, invocationPort: createSyntheticMcpInvocationPort() }, {
    identity: fixture.runtimeIdentity, policySessionId: fixture.opened.policy_session_id,
    toolName: "core_agent.synthetic_profile", proof: decision.execution_proof, arguments: { profile_id: "fixture" },
  }), /mcp_tool_calls_tool_call_key|duplicate key/iu);
  assert.equal((await db.selectFrom("policy_execution_proofs").select("state").where("tenant_id", "=", tenantId)
    .where("proof_id", "=", proof.proof_id).executeTakeFirstOrThrow()).state, "issued");
});
