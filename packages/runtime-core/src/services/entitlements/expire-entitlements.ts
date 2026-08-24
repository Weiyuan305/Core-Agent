import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import { claimDueEntitlements } from "../../repositories/entitlements/entitlements.js";
import {
  databaseClock,
  type EntitlementCommandContext,
  type EntitlementTransactionDependencies,
  type PlatformEntitlementAuthority,
} from "./authority.js";
import { assertCommandContext } from "./command-validation.js";
import { resolveProfileSnapshotInTransaction } from "./resolve-profile-snapshot.js";
import { appendEntitlementLifecycleEffects } from "./transaction-effects.js";

export interface ExpireEntitlementsDependencies extends EntitlementTransactionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  /** Server-owned audit identity for the expiry worker, never supplied by a public request. */
  readonly expiryContext: EntitlementCommandContext;
}

async function requireExpiryAuthority(
  trx: Transaction<RuntimeDatabase>,
  dependencies: ExpireEntitlementsDependencies,
): Promise<PlatformEntitlementAuthority> {
  assertCommandContext(dependencies.expiryContext);
  const actor = await trx.selectFrom("actors").select("status")
    .where("actor_id", "=", dependencies.expiryContext.performingActorId).forUpdate().executeTakeFirst();
  const role = await trx.selectFrom("platform_role_assignments").select("status")
    .where("actor_id", "=", dependencies.expiryContext.performingActorId)
    .where("role", "=", "platform_super_admin").forUpdate().executeTakeFirst();
  const membership = await trx.selectFrom("memberships").select(["tenant_id", "membership_id"])
    .where("tenant_id", "=", dependencies.platformAuthorityTenantId)
    .where("actor_id", "=", dependencies.expiryContext.performingActorId)
    .where("membership_source", "=", "platform")
    .where("status", "=", "active").forUpdate().executeTakeFirst();
  if (actor?.status !== "active" || role?.status !== "active" || membership === undefined) {
    throw new DomainError("UNAUTHENTICATED", "Active expiry worker authority is required");
  }
  return Object.freeze({ authorityTenantId: membership.tenant_id, membershipId: membership.membership_id });
}

async function affectedProfileIds(
  trx: Transaction<RuntimeDatabase>,
  row: { tenant_id: string; tenant_mode: "b2b" | "b2c"; entitlement_id: string },
): Promise<readonly string[]> {
  const profiles = row.tenant_mode === "b2c"
    ? await trx.selectFrom("profiles").select("profile_id")
      .where("tenant_id", "=", row.tenant_id).where("status", "=", "active")
      .orderBy("profile_id", "asc").forUpdate().execute()
    : await trx.selectFrom("profiles")
      .innerJoin("entitlement_assignments", (join) => join
        .onRef("entitlement_assignments.tenant_id", "=", "profiles.tenant_id")
        .onRef("entitlement_assignments.profile_id", "=", "profiles.profile_id"))
      .select("profiles.profile_id")
      .where("profiles.tenant_id", "=", row.tenant_id)
      .where("entitlement_assignments.entitlement_id", "=", row.entitlement_id)
      .where("entitlement_assignments.status", "in", ["preparing", "available", "suspended"])
      .orderBy("profiles.profile_id", "asc").forUpdate("profiles").execute();
  return Object.freeze([...new Set(profiles.map((profile) => profile.profile_id))]);
}

/** Claims one database-time page. Callers repeat until the returned page contains fewer than 100 IDs. */
export async function expireEntitlements(
  dependencies: ExpireEntitlementsDependencies,
): Promise<readonly string[]> {
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const authority = await requireExpiryAuthority(trx, dependencies);
    const now = await databaseClock(dependencies, trx);
    const due = await claimDueEntitlements(trx, now, 100);
    const expired: string[] = [];
    for (const row of due) {
      const nextVersion = Number(row.resource_version) + 1;
      if (!Number.isSafeInteger(nextVersion)) throw new DomainError("INTERNAL_ERROR", "Stored Entitlement version is invalid");
      const profiles = await affectedProfileIds(trx, row);
      await trx.updateTable("entitlements").set({
        status: "expired",
        reason_code: "validity_expired",
        resource_version: nextVersion,
        updated_at: now,
      }).where("entitlement_id", "=", row.entitlement_id).where("status", "=", "active").execute();
      const key = `expiry-${row.entitlement_id}-${nextVersion}`;
      await appendEntitlementLifecycleEffects(trx, authority, dependencies.expiryContext, {
        tenantId: row.tenant_id,
        resourceType: "entitlement",
        resourceId: row.entitlement_id,
        resourceVersion: nextVersion,
        operation: "entitlements.entitlement.expire",
        idempotencyKey: key,
        eventType: "entitlement.expired",
        eventPayload: {
          entitlement_id: row.entitlement_id,
          pack_product_id: row.pack_product_id,
          status: "expired",
          reason_code: "validity_expired",
          resource_version: nextVersion,
        },
        reconcilePayloadRef: profiles[0] ?? row.entitlement_id,
        now,
      });
      for (const profileId of profiles) {
        await resolveProfileSnapshotInTransaction({
          trx,
          now,
          tenantId: row.tenant_id,
          profileId,
          evidence: {
            actorId: dependencies.expiryContext.performingActorId,
            membershipId: authority.membershipId,
            auditTenantId: authority.authorityTenantId,
            requestId: dependencies.expiryContext.requestId,
            traceId: dependencies.expiryContext.traceId,
          },
        });
      }
      expired.push(row.entitlement_id);
    }
    return Object.freeze(expired);
  }, { isolationLevel: "serializable" });
}
