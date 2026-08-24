import { createHash } from "node:crypto";

import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import type { AccountDeletionEntitlementRevocationPort } from "../identity/manage-account-deletion.js";
import {
  resolveProfileSnapshotInTransaction,
  type ResolveProfileSnapshotTransactionInput,
} from "./resolve-profile-snapshot.js";

export interface CreateAccountDeletionEntitlementRevocationPortDependencies {
  readonly resolveProfileSnapshotInTransaction?: (
    input: ResolveProfileSnapshotTransactionInput,
  ) => Promise<unknown>;
}

async function revokeActorAuthority(
  dependencies: CreateAccountDeletionEntitlementRevocationPortDependencies,
  input: {
    readonly trx: Transaction<RuntimeDatabase>;
    readonly actorId: string;
    readonly accountDeletionId: string;
    readonly now: Date;
    readonly requestId: string;
    readonly traceId: string;
  },
): Promise<void> {
  const memberships = await input.trx.selectFrom("memberships")
    .innerJoin("tenants", "tenants.tenant_id", "memberships.tenant_id")
    .select([
      "memberships.tenant_id",
      "memberships.membership_id",
      "memberships.status",
      "tenants.tenant_mode",
    ])
    .where("memberships.actor_id", "=", input.actorId)
    .where("memberships.membership_source", "!=", "platform")
    .where("memberships.status", "=", "active")
    .orderBy("memberships.tenant_id", "asc")
    .forUpdate("memberships").execute();
  if (memberships.length !== 1) {
    throw new DomainError("INVALID_STATE_TRANSITION", "Account entitlement authority is not singular");
  }
  const membership = memberships[0]!;
  const profiles = await input.trx.selectFrom("profiles")
    .select(["profile_id", "status"])
    .where("tenant_id", "=", membership.tenant_id)
    .where("owner_actor_id", "=", input.actorId)
    .orderBy("profile_id", "asc")
    .forUpdate().execute();

  if (membership.tenant_mode === "b2c") {
    await input.trx.updateTable("entitlements").set({
      status: "revoked",
      reason_code: "platform_revoked",
      resource_version: sql`resource_version + 1`,
      updated_at: input.now,
    }).where("tenant_id", "=", membership.tenant_id)
      .where("status", "in", ["active", "suspended"])
      .execute();
  } else if (membership.tenant_mode === "b2b") {
    const profileIds = profiles.map((profile) => profile.profile_id);
    if (profileIds.length > 0) {
      await input.trx.updateTable("entitlement_assignments").set({
        status: "revoked",
        reason_code: "administrator_revoked",
        resource_version: sql`resource_version + 1`,
        updated_at: input.now,
      }).where("tenant_id", "=", membership.tenant_id)
        .where("profile_id", "in", profileIds)
        .where("status", "in", ["preparing", "available", "suspended"])
        .execute();
    }
  } else {
    throw new DomainError("INTERNAL_ERROR", "Stored Tenant mode is invalid");
  }

  const resolve = dependencies.resolveProfileSnapshotInTransaction ?? resolveProfileSnapshotInTransaction;
  for (const profile of profiles) {
    if (profile.status === "active") {
      await resolve({
        trx: input.trx,
        now: input.now,
        tenantId: membership.tenant_id,
        profileId: profile.profile_id,
        evidence: {
          actorId: input.actorId,
          membershipId: membership.membership_id,
          requestId: input.requestId,
          traceId: input.traceId,
        },
      });
    }
    const jobId = `job_account_deletion_entitlement_${createHash("sha256")
      .update(`${input.accountDeletionId}\0${membership.tenant_id}\0${profile.profile_id}`, "utf8")
      .digest("hex").slice(0, 32)}`;
    await input.trx.insertInto("worker_jobs").values({
      tenant_id: membership.tenant_id,
      job_id: jobId,
      job_kind: "reconcile_capability_projection",
      status: "queued",
      attempt_count: 0,
      max_attempts: 5,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: input.now,
      payload_ref: profile.profile_id,
      runtime_command: null,
      target_command_version: null,
      effect_state: "pre_effect",
      last_error_summary: null,
      run_id: null,
      container_id: null,
      created_at: input.now,
      updated_at: input.now,
    }).onConflict((conflict) => conflict.columns(["tenant_id", "job_id"]).doNothing()).execute();
  }
}

export function createAccountDeletionEntitlementRevocationPort(
  dependencies: CreateAccountDeletionEntitlementRevocationPortDependencies = {},
): AccountDeletionEntitlementRevocationPort {
  return Object.freeze({
    async revokeInTransaction(input: Parameters<AccountDeletionEntitlementRevocationPort["revokeInTransaction"]>[0]) {
      await revokeActorAuthority(dependencies, input);
    },
  });
}
