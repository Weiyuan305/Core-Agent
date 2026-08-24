import { RevokePackSeatRequestSchema, type RevokePackSeatRequest } from "@core-agent/contracts";
import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { beginIdempotentCommand, completeIdempotentCommand, DomainError } from "../../domain/idempotency.js";
import { discoverAssignment, lockEntitlementAssignments } from "../../repositories/entitlements/assignments.js";
import { lockEntitlement } from "../../repositories/entitlements/entitlements.js";
import { databaseClock, type EntitlementCommandContext } from "./authority.js";
import {
  lockEligibleConsultantProfile,
  requireCompanyAdminAuthority,
  type AssignmentCommandDependencies,
} from "./assignment-authority.js";
import { storedAssignmentResult, type PackSeatAssignmentResult } from "./assign-pack-seat.js";
import { validateEntitlementCommand } from "./command-validation.js";
import { appendCustomerEntitlementLifecycleEffects } from "./transaction-effects.js";

export interface RevokePackSeatDependencies extends AssignmentCommandDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

const operation = "entitlements.assignment.revoke";
const dayMs = 24 * 60 * 60 * 1_000;

export async function revokePackSeat(
  dependencies: RevokePackSeatDependencies,
  context: EntitlementCommandContext,
  raw: unknown,
): Promise<PackSeatAssignmentResult> {
  const input = validateEntitlementCommand<RevokePackSeatRequest>(RevokePackSeatRequestSchema, raw);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const discovered = await discoverAssignment(trx, input.assignment_id);
    if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Pack seat assignment was not found");
    const actingMembershipId = await requireCompanyAdminAuthority(trx, dependencies, context, discovered.tenant_id);
    const now = await databaseClock(dependencies, trx);
    const admission = await beginIdempotentCommand<PackSeatAssignmentResult>({ tenantId: discovered.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") return storedAssignmentResult(admission.response);
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Pack seat revocation is already in progress");

    const entitlement = await lockEntitlement(trx, discovered.entitlement_id);
    if (entitlement === undefined || entitlement.tenant_id !== discovered.tenant_id || entitlement.seat_quantity === null) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Pack seat authority changed");
    }
    const assignments = await lockEntitlementAssignments(trx, discovered.tenant_id, discovered.entitlement_id);
    const assignment = assignments.find((candidate) => candidate.assignment_id === input.assignment_id);
    if (assignment === undefined || assignment.profile_id !== discovered.profile_id) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Pack seat assignment changed");
    }
    const assignmentVersion = Number(assignment.resource_version);
    if (assignmentVersion !== input.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Pack seat assignment changed");
    }
    if (assignment.status === "revoked" || assignment.status === "expired") {
      throw new DomainError("INVALID_STATE_TRANSITION", "Pack seat assignment is terminal");
    }
    await lockEligibleConsultantProfile(trx, discovered.tenant_id, discovered.profile_id);
    const usedSeats = assignments.filter((candidate) => candidate.status === "preparing" || candidate.status === "available").length;
    const wasConsuming = assignment.status === "preparing" || assignment.status === "available";
    const nextUsed = usedSeats - (wasConsuming ? 1 : 0);
    const nextVersion = assignmentVersion + 1;
    await trx.updateTable("entitlement_assignments").set({
      status: "revoked",
      reason_code: "administrator_revoked",
      resource_version: nextVersion,
      updated_at: now,
    }).where("assignment_id", "=", assignment.assignment_id).execute();
    await dependencies.resolveProfileSnapshotInTransaction({
      trx,
      now,
      tenantId: discovered.tenant_id,
      profileId: discovered.profile_id,
      evidence: {
        actorId: context.performingActorId,
        membershipId: actingMembershipId,
        requestId: context.requestId,
        traceId: context.traceId,
      },
    });
    const result: PackSeatAssignmentResult = Object.freeze({
      schema_version: 1,
      assignment_id: assignment.assignment_id,
      entitlement_id: assignment.entitlement_id,
      profile_id: assignment.profile_id,
      status: "revoked",
      reason_code: "administrator_revoked",
      resource_version: nextVersion,
      used_seats: nextUsed,
      total_seats: entitlement.seat_quantity,
      available_seats: entitlement.seat_quantity - nextUsed,
    });
    await appendCustomerEntitlementLifecycleEffects(trx, actingMembershipId, context, {
      tenantId: discovered.tenant_id,
      resourceType: "assignment",
      resourceId: assignment.assignment_id,
      resourceVersion: nextVersion,
      operation,
      idempotencyKey: input.idempotency_key,
      eventType: "assignment.revoked",
      eventPayload: {
        assignment_id: assignment.assignment_id,
        entitlement_id: assignment.entitlement_id,
        profile_id: assignment.profile_id,
        status: "revoked",
        reason_code: "administrator_revoked",
        resource_version: nextVersion,
      },
      profileId: assignment.profile_id,
      reconcilePayloadRef: assignment.profile_id,
      now,
    });
    await completeIdempotentCommand({ tenantId: discovered.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      resultRef: assignment.assignment_id,
      response: result,
      updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}
