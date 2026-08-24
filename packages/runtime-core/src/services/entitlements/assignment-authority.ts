import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import { requireRecentReauthentication } from "../identity/reauthentication.js";
import {
  requireActiveTenant,
  type EntitlementCommandContext,
  type EntitlementTransactionDependencies,
} from "./authority.js";
import { assertCommandContext } from "./command-validation.js";

export interface AssignmentResolverInput {
  readonly trx: Transaction<RuntimeDatabase>;
  readonly now: Date;
  readonly tenantId: string;
  readonly profileId: string;
  readonly evidence: {
    readonly actorId: string;
    readonly membershipId: string;
    readonly requestId: string;
    readonly traceId: string;
  };
}

export interface AssignmentCommandDependencies extends EntitlementTransactionDependencies {
  readonly resolveProfileSnapshotInTransaction: (input: AssignmentResolverInput) => Promise<unknown>;
}

export async function requireCompanyAdminAuthority(
  trx: Transaction<RuntimeDatabase>,
  dependencies: AssignmentCommandDependencies,
  context: EntitlementCommandContext,
  tenantId: string,
): Promise<string> {
  assertCommandContext(context);
  await requireRecentReauthentication({
    trx,
    ...(dependencies.databaseNow === undefined ? {} : { databaseNow: dependencies.databaseNow }),
  }, {
    actorId: context.performingActorId,
    authSubjectId: context.performingAuthSubjectId,
    sessionId: context.performingSessionId,
  });
  const tenant = await requireActiveTenant(trx, tenantId);
  if (tenant.tenant_mode !== "b2b") throw new DomainError("INVALID_STATE_TRANSITION", "Pack seats require an active B2B Tenant");
  const membership = await trx.selectFrom("memberships").select(["membership_id", "roles", "status", "membership_source"])
    .where("tenant_id", "=", tenantId)
    .where("actor_id", "=", context.performingActorId)
    .forUpdate().executeTakeFirst();
  if (
    membership?.status !== "active"
    || membership.membership_source !== "company"
    || !membership.roles.includes("admin")
  ) throw new DomainError("UNAUTHENTICATED", "Active company administrator authority is required");
  return membership.membership_id;
}

export async function lockEligibleConsultantProfile(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  profileId: string,
): Promise<void> {
  const discovered = await trx.selectFrom("profiles").select("owner_actor_id")
    .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId).executeTakeFirst();
  if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Consultant Profile was not found");
  const membership = await trx.selectFrom("memberships").select(["status", "roles", "membership_source"])
    .where("tenant_id", "=", tenantId).where("actor_id", "=", discovered.owner_actor_id)
    .forUpdate().executeTakeFirst();
  if (
    membership?.status !== "active"
    || membership.membership_source !== "company"
    || !membership.roles.includes("consultant")
  ) throw new DomainError("UNAUTHENTICATED", "An active company consultant Membership is required");
  const profile = await trx.selectFrom("profiles").select(["profile_kind", "status", "owner_actor_id"])
    .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId)
    .forUpdate().executeTakeFirst();
  if (
    profile?.status !== "active"
    || profile.profile_kind !== "consultant"
    || profile.owner_actor_id !== discovered.owner_actor_id
  ) throw new DomainError("UNAUTHENTICATED", "An active consultant Profile is required");
  await trx.selectFrom("profile_snapshot_pointers").select("profile_id")
    .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId)
    .forUpdate().executeTakeFirst();
}
