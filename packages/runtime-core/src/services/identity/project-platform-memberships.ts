import { createHash } from "node:crypto";

import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import type { TenantTransaction } from "../../db/transaction.js";
import { DomainError } from "../../domain/idempotency.js";
import { appendAuditEvent, appendProductEvents } from "../../repositories/events.js";
import { platformMembershipId } from "../../repositories/identity/platform-roles.js";

export interface PlatformMembershipProjectionPage {
  readonly processed: number;
  readonly nextCursor: string | null;
  readonly done: boolean;
}

function derivedId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored platform Membership version is invalid");
  }
  return version;
}

export async function projectPlatformMemberships(
  db: Kysely<RuntimeDatabase>,
  assignmentId: string,
  cursor: string | null,
  limit: number,
): Promise<PlatformMembershipProjectionPage> {
  if (assignmentId.length < 1 || assignmentId.length > 255) {
    throw new DomainError("INVALID_REQUEST", "Platform assignment ID is invalid");
  }
  if (cursor !== null && (cursor.length < 1 || cursor.length > 255)) {
    throw new DomainError("INVALID_REQUEST", "Platform projection cursor is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DomainError("INVALID_REQUEST", "Platform projection limit must be 1 through 100");
  }
  const assignment = await db.selectFrom("platform_role_assignments")
    .select(["actor_id", "role"])
    .where("platform_role_assignment_id", "=", assignmentId)
    .executeTakeFirst();
  if (assignment === undefined || assignment.role !== "platform_super_admin") {
    throw new DomainError("RESOURCE_NOT_FOUND", "Platform role assignment was not found");
  }
  let tenantQuery = db.selectFrom("tenants").select("tenant_id")
    .where("tenant_mode", "=", "b2b").orderBy("tenant_id", "asc").limit(limit + 1);
  if (cursor !== null) tenantQuery = tenantQuery.where("tenant_id", ">", cursor);
  const candidates = await tenantQuery.execute();
  const page = candidates.slice(0, limit);

  for (const candidate of page) {
    await withDatabaseTransactionRetry(db, async (trx) => {
      const actor = await trx.selectFrom("actors").select("status")
        .where("actor_id", "=", assignment.actor_id).forUpdate().executeTakeFirst();
      if (actor === undefined) throw new DomainError("INTERNAL_ERROR", "Platform role Actor was not found");
      const currentAssignment = await trx.selectFrom("platform_role_assignments")
        .select(["actor_id", "role", "status", "resource_version"])
        .where("platform_role_assignment_id", "=", assignmentId).forUpdate().executeTakeFirst();
      if (
        currentAssignment === undefined
        || currentAssignment.actor_id !== assignment.actor_id
        || currentAssignment.role !== "platform_super_admin"
      ) throw new DomainError("INVALID_STATE_TRANSITION", "Platform authority changed during projection");
      const tenant = await trx.selectFrom("tenants").select(["tenant_id", "tenant_mode"])
        .where("tenant_id", "=", candidate.tenant_id).forUpdate().executeTakeFirst();
      if (tenant === undefined || tenant.tenant_mode !== "b2b") return;
      const membershipId = platformMembershipId(assignment.actor_id, tenant.tenant_id);
      const existing = await trx.selectFrom("memberships")
        .select(["actor_id", "membership_source", "roles", "seat_ref", "status", "resource_version"])
        .where("tenant_id", "=", tenant.tenant_id)
        .where("membership_id", "=", membershipId)
        .forUpdate().executeTakeFirst();
      const desiredStatus = currentAssignment.status === "active" ? "active" : "revoked";
      let resourceVersion: number;
      let changed = false;
      const now = new Date();
      if (existing === undefined) {
        if (desiredStatus === "revoked") return;
        await trx.insertInto("memberships").values({
          tenant_id: tenant.tenant_id,
          membership_id: membershipId,
          actor_id: assignment.actor_id,
          schema_version: 1,
          resource_version: 1,
          roles: ["admin"],
          membership_source: "platform",
          seat_ref: null,
          status: "active",
          created_at: now,
          updated_at: now,
        }).execute();
        resourceVersion = 1;
        changed = true;
      } else {
        if (
          existing.actor_id !== assignment.actor_id
          || existing.membership_source !== "platform"
          || existing.roles.length !== 1
          || existing.roles[0] !== "admin"
          || existing.seat_ref !== null
        ) throw new DomainError("INVALID_STATE_TRANSITION", "Stored platform Membership conflicts with projection");
        resourceVersion = safeVersion(existing.resource_version);
        if (existing.status !== desiredStatus) {
          resourceVersion += 1;
          await trx.updateTable("memberships").set({
            status: desiredStatus,
            resource_version: resourceVersion,
            updated_at: now,
          }).where("tenant_id", "=", tenant.tenant_id)
            .where("membership_id", "=", membershipId)
            .execute();
          changed = true;
        }
      }
      if (!changed) return;
      const tenantTransaction: TenantTransaction = { tenantId: tenant.tenant_id, trx };
      const statusReason = desiredStatus === "active" ? "platform_role_projected" : "platform_role_revoked";
      const seed = `${assignmentId}:${tenant.tenant_id}:${resourceVersion}:${desiredStatus}`;
      const eventId = derivedId("event_platform_membership", seed);
      const requestId = derivedId("request_platform_membership", seed);
      const traceId = derivedId("trace_platform_membership", seed);
      await appendProductEvents(tenantTransaction, {
        streamId: membershipId,
        deliveryTarget: "internal_event_stream",
        events: [{
          schema_version: 1,
          event_id: eventId,
          occurred_at: now.toISOString(),
          tenant_id: tenant.tenant_id,
          request_id: requestId,
          trace_id: traceId,
          correlation_id: derivedId("correlation_platform", seed),
          causation_id: derivedId("causation_platform", seed),
          event_type: "membership.changed",
          payload: {
            membership_id: membershipId,
            actor_id: assignment.actor_id,
            status: desiredStatus,
            reason_code: statusReason,
            resource_version: resourceVersion,
          },
        }],
      });
      await appendAuditEvent(tenantTransaction, {
        schema_version: 1,
        audit_event_id: derivedId("audit_platform_membership", seed),
        occurred_at: now.toISOString(),
        tenant_id: tenant.tenant_id,
        actor_id: assignment.actor_id,
        membership_id: membershipId,
        effective_role: "admin",
        action: desiredStatus === "active" ? "identity.platform-membership.project" : "identity.platform-membership.revoke",
        resource_type: "membership",
        resource_id: membershipId,
        decision: "allowed",
        outcome: "succeeded",
        request_id: requestId,
        trace_id: traceId,
        reason_summary: desiredStatus === "active"
          ? "Projected active platform administrator authority"
          : "Retained and revoked platform administrator projection",
        resource_version: resourceVersion,
      });
    }, { isolationLevel: "serializable" });
  }

  const hasMore = candidates.length > limit;
  return Object.freeze({
    processed: page.length,
    nextCursor: hasMore ? page.at(-1)?.tenant_id ?? null : null,
    done: !hasMore,
  });
}
