import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  assignPackSeat,
  canonicalPayloadHash,
  changeEntitlementStatus,
  createCapabilityVersion,
  createPackVersion,
  grantEntitlement,
  issueCoreSession,
  publishPackVersion,
  resolveProfileSnapshotInTransaction,
  reviewCapabilityVersion,
  reviewPackVersion,
  selectTenantPackRelease,
  type EntitlementCommandContext,
} from "@core-agent/runtime-core";

import {
  ENTITLEMENT_PRIVATE_CANARIES,
  type IntegrationHarness,
  type ProvisionedSyntheticTenant,
} from "../harness.js";

const contractRef = "integration/capability@1.0.0";

function protectedCommand<T extends Record<string, unknown>>(facts: T): T & { readonly payload_hash: string } {
  return Object.freeze({ ...facts, payload_hash: canonicalPayloadHash(facts) });
}

function suffix(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

async function waitFor<T>(load: () => Promise<T>, accepted: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const value = await load();
    if (accepted(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface PreparedEntitlementSlice {
  readonly harness: IntegrationHarness;
  readonly provisioned: ProvisionedSyntheticTenant;
  readonly tenantId: string;
  readonly runtimeId: string;
  readonly profileId: string;
  readonly platformActorId: string;
  readonly platformTenantId: string;
  readonly platformContext: EntitlementCommandContext;
  readonly companyContext: EntitlementCommandContext;
  readonly capabilityId: string;
  readonly capabilityVersionId: string;
  readonly packProductId: string;
  readonly packVersionId: string;
  readonly entitlementId: string;
  readonly assignmentId: string;
}

async function createAuthorities(harness: IntegrationHarness, provisioned: ProvisionedSyntheticTenant) {
  const tenantId = provisioned.tenant_id;
  const marker = suffix(tenantId);
  const now = new Date();
  const platformTenantId = `tenant_platform_${marker}`;
  const platformActorId = `actor_platform_${marker}`;
  const platformAuthSubjectId = `auth_platform_${marker}`;
  const platformSessionId = `session_platform_${marker}`;
  const companyActorId = `actor_${tenantId}`;
  const companyAuthSubjectId = `auth_company_${marker}`;
  const companySessionId = `session_company_${marker}`;

  await harness.db.insertInto("tenants").values({
    tenant_id: platformTenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2b",
    status: "active", display_name: "Integration platform authority", created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("actors").values({
    actor_id: platformActorId, schema_version: 1, resource_version: 1, actor_kind: "human",
    display_name: "Integration platform administrator", status: "active", created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("auth_subjects").values({
    auth_subject_id: platformAuthSubjectId, actor_id: platformActorId, provider: "supabase",
    provider_subject: `provider_platform_${marker}`, provider_identity_kind: "email_password",
    verified_at: now, status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("memberships").values({
    tenant_id: platformTenantId, membership_id: `membership_platform_${marker}`, actor_id: platformActorId,
    schema_version: 1, resource_version: 1, roles: ["admin"], membership_source: "platform",
    seat_ref: null, status: "active", created_at: now, updated_at: now,
  }).execute();
  await harness.db.insertInto("platform_role_assignments").values({
    platform_role_assignment_id: `platform_role_${marker}`, actor_id: platformActorId,
    role: "platform_super_admin", status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await harness.db.updateTable("memberships").set({ roles: ["admin", "consultant"], updated_at: now })
    .where("tenant_id", "=", tenantId).where("actor_id", "=", companyActorId).executeTakeFirstOrThrow();
  await harness.db.insertInto("auth_subjects").values({
    auth_subject_id: companyAuthSubjectId, actor_id: companyActorId, provider: "supabase",
    provider_subject: `provider_company_${marker}`, provider_identity_kind: "email_password",
    verified_at: now, status: "active", resource_version: 1, created_at: now, updated_at: now,
  }).execute();
  await issueCoreSession({ db: harness.db }, { sessionId: platformSessionId, actorId: platformActorId, authSubjectId: platformAuthSubjectId, clientKind: "web" });
  await issueCoreSession({ db: harness.db }, { sessionId: companySessionId, actorId: companyActorId, authSubjectId: companyAuthSubjectId, clientKind: "web" });
  await harness.db.updateTable("core_sessions").set({ reauthenticated_at: now, updated_at: now })
    .where("session_id", "in", [platformSessionId, companySessionId]).execute();

  return Object.freeze({
    platformTenantId,
    platformActorId,
    platformContext: Object.freeze({
      performingActorId: platformActorId, performingAuthSubjectId: platformAuthSubjectId,
      performingSessionId: platformSessionId, requestId: `request_platform_${marker}`, traceId: `trace_platform_${marker}`,
    }),
    companyContext: Object.freeze({
      performingActorId: companyActorId, performingAuthSubjectId: companyAuthSubjectId,
      performingSessionId: companySessionId, requestId: `request_company_${marker}`, traceId: `trace_company_${marker}`,
    }),
  });
}

export async function prepareB2BEntitlementSlice(harness: IntegrationHarness): Promise<PreparedEntitlementSlice> {
  const provisioned = await harness.provisionSyntheticB2B();
  await harness.worker.untilRuntimeStatus(provisioned.runtime_id, "ready");
  await harness.stopWorker();
  const authorities = await createAuthorities(harness, provisioned);
  const tenantId = provisioned.tenant_id;
  const profileId = provisioned.profile_ids[0]!;
  const marker = suffix(tenantId);
  const capabilityId = `capability_slice_${marker}`;
  const capabilityVersionId = `capability_version_slice_${marker}`;
  const packProductId = `pack_slice_${marker}`;
  const packVersionId = `pack_version_slice_${marker}_v1`;
  const catalogDependencies = {
    db: harness.db,
    knownContractRefs: [contractRef],
    platformCompatibility: { core_contract_version: "0.8.0", runtime_protocol_version: "1.0.0" },
    catalogAuthorityTenantId: authorities.platformTenantId,
  } as const;
  const catalogContext = {
    performingActorId: authorities.platformActorId,
    requestId: authorities.platformContext.requestId,
    traceId: authorities.platformContext.traceId,
  } as const;
  await createCapabilityVersion(catalogDependencies, catalogContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_capability_create_${marker}`,
    capability_id: capabilityId, capability_version_id: capabilityVersionId,
    display_name: "Integration read capability", owning_domain: "integration", kind: "mcp" as const,
    version: "1.0.0", artifact_ref: ENTITLEMENT_PRIVATE_CANARIES.artifact,
    contract_ref: contractRef, risk_class: "read" as const, approval_requirement: "none" as const,
    compatibility: { core_contract_version: "0.8.0", domain_contract_version: "1.0.0", runtime_protocol_version: "1.0.0", tenant_modes: ["b2b"] as const },
    expected_resource_version: null,
  }));
  await reviewCapabilityVersion(catalogDependencies, catalogContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_capability_review_${marker}`,
    capability_version_id: capabilityVersionId, expected_resource_version: 1,
  }));
  await createPackVersion(catalogDependencies, catalogContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_pack_create_${marker}`,
    pack_product_id: packProductId, pack_version_id: packVersionId,
    display_name: "Integration service", tenant_modes: ["b2b"] as const, version: "1.0.0",
    expected_resource_version: null,
    members: [{ capability_id: capabilityId, capability_version_id: capabilityVersionId, version: "1.0.0" }],
  }));
  await reviewPackVersion(catalogDependencies, catalogContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_pack_review_${marker}`,
    pack_version_id: packVersionId, expected_resource_version: 1,
  }));
  await publishPackVersion(catalogDependencies, catalogContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_pack_publish_${marker}`,
    pack_version_id: packVersionId, expected_resource_version: 2,
  }));
  const entitlementDependencies = { db: harness.db, platformAuthorityTenantId: authorities.platformTenantId } as const;
  const release = await selectTenantPackRelease(entitlementDependencies, authorities.platformContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_release_${marker}`, tenant_id: tenantId,
    pack_product_id: packProductId, pack_version_id: packVersionId, expected_resource_version: 1,
  }));
  assert.equal(release.kind, "current");
  const entitlement = await grantEntitlement(entitlementDependencies, authorities.platformContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_grant_${marker}`, tenant_id: tenantId,
    pack_product_id: packProductId, source: "platform_manual" as const,
    external_order_ref: ENTITLEMENT_PRIVATE_CANARIES.external_order,
    expected_resource_version: 1, tenant_mode: "b2b" as const, assignment_mode: "seat" as const, seat_quantity: 1,
  }));
  const assignment = await assignPackSeat({
    db: harness.db,
    platformAuthorityTenantId: authorities.platformTenantId,
    authorityTenantId: tenantId,
    resolveProfileSnapshotInTransaction,
  }, authorities.companyContext, protectedCommand({
    schema_version: 1 as const, idempotency_key: `slice_seat_${marker}`,
    entitlement_id: entitlement.entitlement_id, expected_resource_version: 1, profile_id: profileId,
  }));
  assert.equal(assignment.status, "preparing");
  await harness.startWorker();
  await waitFor(
    () => harness.db.selectFrom("capability_runtime_projections").selectAll()
      .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId)
      .orderBy("runtime_generation", "desc").executeTakeFirst(),
    (row) => row?.status === "available",
    "capability projection availability",
  );
  await waitFor(
    () => harness.db.selectFrom("entitlement_assignments").select("status")
      .where("tenant_id", "=", tenantId).where("assignment_id", "=", assignment.assignment_id).executeTakeFirst(),
    (row) => row?.status === "available",
    "assignment availability",
  );
  return Object.freeze({
    harness, provisioned, tenantId, runtimeId: provisioned.runtime_id, profileId,
    platformActorId: authorities.platformActorId, platformTenantId: authorities.platformTenantId,
    platformContext: authorities.platformContext, companyContext: authorities.companyContext,
    capabilityId, capabilityVersionId, packProductId, packVersionId,
    entitlementId: entitlement.entitlement_id, assignmentId: assignment.assignment_id,
  });
}

export async function suspendSliceEntitlement(slice: PreparedEntitlementSlice): Promise<void> {
  const row = await slice.harness.db.selectFrom("entitlements").select("resource_version")
    .where("entitlement_id", "=", slice.entitlementId).executeTakeFirstOrThrow();
  await changeEntitlementStatus(
    { db: slice.harness.db, platformAuthorityTenantId: slice.platformTenantId },
    slice.platformContext,
    protectedCommand({
      schema_version: 1 as const, idempotency_key: `slice_suspend_${suffix(slice.tenantId)}`,
      entitlement_id: slice.entitlementId, expected_resource_version: Number(row.resource_version),
      status: "suspended" as const, reason_code: "administrator_suspended" as const,
    }),
  );
}

export const entitlementSliceInternals = Object.freeze({ protectedCommand, suffix, waitFor });
