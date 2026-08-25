#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  bootstrapBuiltinPolicy,
  createRuntimeDatabase,
  databaseConnectionOptions,
  deriveRuntimeContainerId,
  readProtectedDatabasePassword,
  resolveProfileSnapshotInTransaction,
} from "@core-agent/runtime-core";
import { sql } from "kysely";
import { Pool } from "pg";

const syntheticId = /^synthetic-[a-z0-9][a-z0-9-]{0,94}$/u;

function invalid() {
  throw new Error("POLICY_ACCEPTANCE_BOOTSTRAP_INVALID");
}

function marker(tenantId) {
  return createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 20);
}

function identifiers(tenantId) {
  const suffix = marker(tenantId);
  return Object.freeze({
    packProductId: `pack_policy_acceptance_${suffix}`,
    packVersionId: `pack_version_policy_acceptance_${suffix}`,
    packMemberId: `pack_member_policy_acceptance_${suffix}`,
    releaseId: `release_policy_acceptance_${suffix}`,
    entitlementId: `entitlement_policy_acceptance_${suffix}`,
    assignmentId: `assignment_policy_acceptance_${suffix}`,
  });
}

export async function bootstrapManagedPolicyAcceptance(argv = process.argv.slice(2), environment = process.env) {
  if (!Array.isArray(argv) || argv.length !== 4 || argv.some((value) => typeof value !== "string" || !syntheticId.test(value))) {
    invalid();
  }
  const [tenantId, actorId, membershipId, profileId] = argv;
  const databaseUrl = environment.CONTROL_PLANE_DATABASE_URL;
  const passwordFile = environment.CONTROL_PLANE_DATABASE_PASSWORD_FILE;
  if (typeof databaseUrl !== "string" || typeof passwordFile !== "string") invalid();
  const password = await readProtectedDatabasePassword(passwordFile);
  const pool = new Pool(databaseConnectionOptions(databaseUrl, password));
  const db = createRuntimeDatabase(pool);
  try {
    const runtimeId = deriveRuntimeContainerId(tenantId);
    const current = await db.selectFrom("runtime_containers").select(["generation", "desired_state", "observed_state", "health_status"])
      .where("tenant_id", "=", tenantId).where("container_id", "=", runtimeId).executeTakeFirst();
    const actor = await db.selectFrom("actors").select("status").where("actor_id", "=", actorId).executeTakeFirst();
    const membership = await db.selectFrom("memberships").select(["actor_id", "status"])
      .where("tenant_id", "=", tenantId).where("membership_id", "=", membershipId).executeTakeFirst();
    const profile = await db.selectFrom("profiles").select(["owner_actor_id", "status"])
      .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId).executeTakeFirst();
    if (current?.generation !== 1 || current.desired_state !== "running" || current.observed_state !== "ready"
      || current.health_status !== "healthy" || actor?.status !== "active"
      || membership?.actor_id !== actorId || membership.status !== "active"
      || profile?.owner_actor_id !== actorId || profile.status !== "active") invalid();

    const ids = identifiers(tenantId);
    const now = new Date();
    const compatibility = {
      core_contract_version: "0.9.0", domain_contract_version: "1.0.0",
      runtime_protocol_version: "1.0.0", tenant_modes: ["b2b"],
    };
    const reviewerActorId = "core_agent_policy_acceptance_reviewer";
    const document = JSON.parse(await readFile(new URL("../infra/policy-mcp/synthetic-bindings.json", import.meta.url), "utf8"));
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("actors").values({
        actor_id: reviewerActorId, schema_version: 1, resource_version: 1, actor_kind: "service",
        display_name: "Policy acceptance reviewer", status: "active", created_at: now, updated_at: now,
      }).onConflict((conflict) => conflict.column("actor_id").doNothing()).execute();
      await trx.updateTable("memberships").set({
        roles: ["admin", "consultant"], resource_version: sql`resource_version + 1`, updated_at: now,
      }).where("tenant_id", "=", tenantId).where("membership_id", "=", membershipId).executeTakeFirstOrThrow();
      await trx.insertInto("capabilities").values({
        capability_id: "core_agent.synthetic_profile", display_name: "Synthetic profile",
        owning_domain: "policy", kind: "mcp", resource_version: 1, created_at: now, updated_at: now,
      }).onConflict((conflict) => conflict.column("capability_id").doNothing()).execute();
      await trx.insertInto("capability_versions").values({
        capability_version_id: "core-agent-synthetic-profile-v1", capability_id: "core_agent.synthetic_profile",
        version: "1.0.0", kind: "mcp", artifact_ref: `manifest:sha256:${"c".repeat(64)}`,
        contract_ref: "gateway-tool-result@0.9.0", risk_class: "read", approval_requirement: "none",
        compatibility_json: compatibility, status: "reviewed", resource_version: 1, created_at: now, updated_at: now,
      }).onConflict((conflict) => conflict.column("capability_version_id").doNothing()).execute();
      await trx.insertInto("pack_products").values({
        pack_product_id: ids.packProductId, display_name: "Managed policy acceptance",
        tenant_modes: ["b2b"], resource_version: 1, created_at: now, updated_at: now,
      }).execute();
      await trx.insertInto("pack_versions").values({
        pack_version_id: ids.packVersionId, pack_product_id: ids.packProductId, version: "1.0.0",
        status: "draft", resource_version: 1, created_at: now, updated_at: now,
      }).execute();
      await trx.insertInto("pack_members").values({
        pack_member_id: ids.packMemberId, pack_version_id: ids.packVersionId, member_order: 1,
        capability_id: "core_agent.synthetic_profile", capability_version_id: "core-agent-synthetic-profile-v1",
        version: "1.0.0", resource_version: 1, created_at: now, updated_at: now,
      }).execute();
      await trx.updateTable("pack_versions").set({ status: "reviewed", resource_version: 2, updated_at: now })
        .where("pack_version_id", "=", ids.packVersionId).executeTakeFirstOrThrow();
      await trx.updateTable("pack_versions").set({ status: "published", resource_version: 3, updated_at: now })
        .where("pack_version_id", "=", ids.packVersionId).executeTakeFirstOrThrow();
      await trx.insertInto("tenant_pack_releases").values({
        tenant_pack_release_id: ids.releaseId, tenant_id: tenantId, pack_product_id: ids.packProductId,
        pack_version_id: ids.packVersionId, pack_version: "1.0.0", generation: 1, status: "preparing",
        resource_version: 1, created_at: now, updated_at: now,
      }).execute();
      await trx.updateTable("tenant_pack_releases").set({ status: "current", resource_version: 2, updated_at: now })
        .where("tenant_id", "=", tenantId).where("tenant_pack_release_id", "=", ids.releaseId).executeTakeFirstOrThrow();
      await trx.insertInto("entitlements").values({
        entitlement_id: ids.entitlementId, tenant_id: tenantId, pack_product_id: ids.packProductId,
        tenant_pack_release_id: ids.releaseId, pack_version_id: ids.packVersionId, pack_version: "1.0.0",
        source: "platform_manual", external_order_ref: `policy-acceptance-${ids.entitlementId}`,
        tenant_mode: "b2b", assignment_mode: "seat", seat_quantity: 1, valid_from: now, expires_at: null,
        status: "active", reason_code: "platform_grant", resource_version: 1, created_at: now, updated_at: now,
      }).execute();
      await trx.insertInto("entitlement_assignments").values({
        assignment_id: ids.assignmentId, tenant_id: tenantId, entitlement_id: ids.entitlementId,
        profile_id: profileId, status: "preparing", reason_code: "seat_assigned",
        resource_version: 1, created_at: now, updated_at: now,
      }).execute();
    });
    await bootstrapBuiltinPolicy(db, reviewerActorId, document);
    const snapshot = await db.transaction().execute((trx) => (
      resolveProfileSnapshotInTransaction({
        trx, tenantId, profileId, now,
        evidence: {
          actorId, membershipId,
          requestId: `synthetic-policy-request-${marker(tenantId)}`,
          traceId: `synthetic-policy-trace-${marker(tenantId)}`,
        },
      })
    ));
    if (snapshot.reused || snapshot.staged || snapshot.projection.status !== "preparing"
      || snapshot.projection.generation <= current.generation) invalid();
    const expectedGeneration = snapshot.projection.generation;
    const output = Object.freeze({
      tenant_id: tenantId, profile_id: profileId, runtime_id: runtimeId,
      projection_id: snapshot.projection.projectionId, expected_generation: expectedGeneration,
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return output;
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await bootstrapManagedPolicyAcceptance().catch(() => {
    process.stderr.write("POLICY_ACCEPTANCE_BOOTSTRAP_FAILED\n");
    process.exitCode = 1;
  });
}
