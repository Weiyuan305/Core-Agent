import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import { requireRecentReauthentication } from "../identity/reauthentication.js";
import { assertCommandContext } from "./command-validation.js";

export interface EntitlementCommandContext {
  readonly performingActorId: string;
  readonly performingAuthSubjectId: string;
  readonly performingSessionId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface EntitlementTransactionDependencies {
  readonly platformAuthorityTenantId: string;
  readonly databaseNow?: (trx: Transaction<RuntimeDatabase>) => Promise<Date>;
}

export interface PlatformEntitlementAuthority {
  readonly authorityTenantId: string;
  readonly membershipId: string;
}

export async function databaseClock(
  dependencies: Pick<EntitlementTransactionDependencies, "databaseNow">,
  trx: Transaction<RuntimeDatabase>,
): Promise<Date> {
  const value = dependencies.databaseNow === undefined
    ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now
    : await dependencies.databaseNow(trx);
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Entitlement database clock is invalid");
  }
  return new Date(value);
}

/** Locks current Core authority, then the server-owned platform role and Membership. */
export async function requirePlatformEntitlementAuthority(
  trx: Transaction<RuntimeDatabase>,
  dependencies: EntitlementTransactionDependencies,
  context: EntitlementCommandContext,
): Promise<PlatformEntitlementAuthority> {
  assertCommandContext(context);
  if (
    typeof dependencies.platformAuthorityTenantId !== "string"
    || dependencies.platformAuthorityTenantId.length < 1
    || dependencies.platformAuthorityTenantId.length > 255
  ) throw new DomainError("INVALID_REQUEST", "Platform authority scope is invalid");

  await requireRecentReauthentication({
    trx,
    ...(dependencies.databaseNow === undefined ? {} : { databaseNow: dependencies.databaseNow }),
  }, {
    actorId: context.performingActorId,
    authSubjectId: context.performingAuthSubjectId,
    sessionId: context.performingSessionId,
  });
  const role = await trx.selectFrom("platform_role_assignments")
    .select("status")
    .where("actor_id", "=", context.performingActorId)
    .where("role", "=", "platform_super_admin")
    .forUpdate()
    .executeTakeFirst();
  const membership = await trx.selectFrom("memberships")
    .select(["tenant_id", "membership_id"])
    .where("tenant_id", "=", dependencies.platformAuthorityTenantId)
    .where("actor_id", "=", context.performingActorId)
    .where("membership_source", "=", "platform")
    .where("status", "=", "active")
    .forUpdate()
    .executeTakeFirst();
  if (role?.status !== "active" || membership === undefined) {
    throw new DomainError("UNAUTHENTICATED", "Active platform entitlement authority is required");
  }
  return Object.freeze({
    authorityTenantId: membership.tenant_id,
    membershipId: membership.membership_id,
  });
}

export async function requireActiveTenant(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
) {
  const tenant = await trx.selectFrom("tenants")
    .select(["tenant_id", "tenant_mode", "status"])
    .where("tenant_id", "=", tenantId)
    .forUpdate()
    .executeTakeFirst();
  if (tenant === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Tenant was not found");
  if (tenant.status !== "active") throw new DomainError("INVALID_STATE_TRANSITION", "Tenant is not active");
  return tenant;
}
