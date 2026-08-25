import assert from "node:assert/strict";
import test from "node:test";

import {
  createCapabilityVersion,
  DomainError,
  grantEntitlement,
  type SupervisorRequestV2,
} from "@core-agent/runtime-core";

import {
  createIntegrationHarness,
  ENTITLEMENT_PRIVATE_CANARIES,
  type IntegrationHarness,
} from "./harness.js";
import {
  entitlementSliceInternals,
  prepareB2BEntitlementSlice,
  type PreparedEntitlementSlice,
} from "./fixtures/entitlement-slice.js";

let harness: IntegrationHarness;
let slice: PreparedEntitlementSlice;

test.before(async () => {
  harness = await createIntegrationHarness("entitlement-capability");
  slice = await prepareB2BEntitlementSlice(harness);
});

test.after(async () => {
  await harness?.close();
});

test("reviewed catalog authority reaches one exact v2 Runtime manifest and available assignment", async () => {
  const pointer = await harness.db.selectFrom("profile_snapshot_pointers").selectAll()
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId).executeTakeFirstOrThrow();
  const snapshot = await harness.db.selectFrom("entitlement_snapshots").selectAll()
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .where("snapshot_id", "=", pointer.snapshot_id).executeTakeFirstOrThrow();
  const capabilities = await harness.db.selectFrom("entitlement_snapshot_capabilities").selectAll()
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .where("snapshot_id", "=", pointer.snapshot_id).orderBy("capability_order", "asc").execute();
  assert.match(snapshot.canonical_input_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(capabilities.map((row) => row.capability_id), [slice.capabilityId]);
  const projection = await harness.db.selectFrom("capability_runtime_projections").selectAll()
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId)
    .where("snapshot_id", "=", pointer.snapshot_id).executeTakeFirstOrThrow();

  const projectionRequests = harness.fakeSupervisor.requests.filter((request): request is SupervisorRequestV2 => request.protocol_version === 2);
  assert.deepEqual(projectionRequests.map((request) => request.kind), ["provision", "inspect"]);
  const provision = projectionRequests[0]!;
  assert.equal(provision.kind, "provision");
  assert.equal(provision.capability_manifest_digest, projection.capability_manifest_digest);
  assert.equal(provision.capability_manifest.tenant_id, slice.tenantId);
  assert.deepEqual(provision.capability_manifest.capabilities.map((item) => item.capability_id), [slice.capabilityId]);
  assert.equal(provision.capability_manifest.capabilities[0]?.capability_version_id, slice.capabilityVersionId);
  assert.equal(JSON.stringify(provision).includes("external_order"), false);

  const runtime = await harness.db.selectFrom("runtime_containers").selectAll()
    .where("tenant_id", "=", slice.tenantId).where("container_id", "=", slice.runtimeId).executeTakeFirstOrThrow();
  assert.equal(runtime.capability_manifest_digest, projection.capability_manifest_digest);
  assert.equal(runtime.observed_state, "ready");
  assert.equal(runtime.health_status, "healthy");
  const assignment = await harness.db.selectFrom("entitlement_assignments").select("status")
    .where("assignment_id", "=", slice.assignmentId).executeTakeFirstOrThrow();
  assert.equal(assignment.status, "available");
  assert.equal((await harness.db.selectFrom("capability_versions").select("artifact_ref")
    .where("capability_version_id", "=", slice.capabilityVersionId).executeTakeFirstOrThrow()).artifact_ref,
    ENTITLEMENT_PRIVATE_CANARIES.artifact);
  assert.equal((await harness.db.selectFrom("entitlements").select("external_order_ref")
    .where("entitlement_id", "=", slice.entitlementId).executeTakeFirstOrThrow()).external_order_ref,
    ENTITLEMENT_PRIVATE_CANARIES.external_order);
});

test("category canaries enter their real authority ingress and cannot cross its closed schema", async () => {
  const marker = entitlementSliceInternals.suffix(slice.tenantId);
  const catalogDependencies = {
    db: harness.db,
    knownContractRefs: ["integration/capability@1.0.0"],
    platformCompatibility: { core_contract_version: "0.8.0", runtime_protocol_version: "1.0.0" },
    catalogAuthorityTenantId: slice.platformTenantId,
  } as const;
  const catalogContext = {
    performingActorId: slice.platformActorId,
    requestId: `request_canary_${marker}`,
    traceId: `trace_canary_${marker}`,
  } as const;
  for (const category of ["tool_schema", "provider_secret"] as const) {
    const facts = {
      schema_version: 1 as const,
      idempotency_key: `canary_catalog_${category}_${marker}`,
      capability_id: `capability_canary_${category}_${marker}`,
      capability_version_id: `capability_version_canary_${category}_${marker}`,
      display_name: "Canary rejection capability",
      owning_domain: "integration",
      kind: "mcp" as const,
      version: "1.0.0",
      artifact_ref: `manifest:sha256:${"d".repeat(64)}`,
      contract_ref: "integration/capability@1.0.0",
      risk_class: "read" as const,
      approval_requirement: "none" as const,
      compatibility: {
        core_contract_version: "0.8.0",
        domain_contract_version: "1.0.0",
        runtime_protocol_version: "1.0.0",
        tenant_modes: ["b2b"] as const,
      },
      expected_resource_version: null,
    };
    await assert.rejects(
      createCapabilityVersion(catalogDependencies, catalogContext, {
        ...entitlementSliceInternals.protectedCommand(facts),
        [category]: ENTITLEMENT_PRIVATE_CANARIES[category],
      }),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
  for (const category of ["price", "receipt", "customer_content"] as const) {
    const facts = {
      schema_version: 1 as const,
      idempotency_key: `canary_grant_${category}_${marker}`,
      tenant_id: slice.tenantId,
      pack_product_id: slice.packProductId,
      source: "platform_manual" as const,
      external_order_ref: `canary_order_${category}_${marker}`,
      expected_resource_version: 1,
      tenant_mode: "b2b" as const,
      assignment_mode: "seat" as const,
      seat_quantity: 1,
    };
    await assert.rejects(
      grantEntitlement(
        { db: harness.db, platformAuthorityTenantId: slice.platformTenantId },
        slice.platformContext,
        {
          ...entitlementSliceInternals.protectedCommand(facts),
          [category]: ENTITLEMENT_PRIVATE_CANARIES[category],
        },
      ),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_REQUEST",
    );
  }
});

test("a new Conversation and Run are admitted with the current immutable Snapshot authority", async () => {
  const conversation = await harness.createConversation({ tenant_id: slice.tenantId, profile_id: slice.profileId });
  harness.fakeHermes.enqueue("success");
  const run = await harness.createRun(conversation.conversation_id, "Prove the current service slice.", { tenantId: slice.tenantId });
  const completed = await harness.worker.untilRunStatus(run.run_id, "succeeded");
  assert.equal(completed.status, "succeeded");
  const audit = await harness.db.selectFrom("audit_events").select("entitlement_snapshot_ref")
    .where("tenant_id", "=", slice.tenantId).where("action", "=", "agent_run.create")
    .where("resource_id", "=", run.run_id).where("decision", "=", "allowed")
    .executeTakeFirst();
  assert(audit?.entitlement_snapshot_ref !== null && audit?.entitlement_snapshot_ref !== undefined);
  const pointer = await harness.db.selectFrom("profile_snapshot_pointers").select(["snapshot_id", "snapshot_version", "evaluated_at"])
    .where("tenant_id", "=", slice.tenantId).where("profile_id", "=", slice.profileId).executeTakeFirstOrThrow();
  assert.deepEqual(audit.entitlement_snapshot_ref, {
    snapshot_id: pointer.snapshot_id,
    version: Number(pointer.snapshot_version),
    evaluated_at: pointer.evaluated_at.toISOString(),
  });
});
