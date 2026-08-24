import { createHash } from "node:crypto";

import { AssignPackSeatRequestSchema, type AssignPackSeatRequest } from "@core-agent/contracts";
import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import {
  isDatabaseTransactionRetryExhaustedError,
  withDatabaseTransactionRetry,
} from "../../db/transaction-retry.js";
import { beginIdempotentCommand, completeIdempotentCommand, DomainError } from "../../domain/idempotency.js";
import { lockEntitlementAssignments } from "../../repositories/entitlements/assignments.js";
import { lockEntitlement } from "../../repositories/entitlements/entitlements.js";
import { databaseClock, type EntitlementCommandContext } from "./authority.js";
import {
  lockEligibleConsultantProfile,
  requireCompanyAdminAuthority,
  type AssignmentCommandDependencies,
} from "./assignment-authority.js";
import { validateEntitlementCommand } from "./command-validation.js";
import { appendCustomerEntitlementLifecycleEffects } from "./transaction-effects.js";

export interface AssignPackSeatDependencies extends AssignmentCommandDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

export interface PackSeatAssignmentResult {
  readonly schema_version: 1;
  readonly assignment_id: string;
  readonly entitlement_id: string;
  readonly profile_id: string;
  readonly status: "preparing" | "revoked";
  readonly reason_code: "seat_assigned" | "administrator_revoked";
  readonly resource_version: number;
  readonly used_seats: number;
  readonly total_seats: number;
  readonly available_seats: number;
}

const dayMs = 24 * 60 * 60 * 1_000;
const operation = "entitlements.assignment.create";

function assignmentId(entitlementId: string, profileId: string): string {
  return `assignment_${createHash("sha256").update(`${entitlementId}\0${profileId}`, "utf8").digest("hex").slice(0, 32)}`;
}

export function storedAssignmentResult(value: unknown): PackSeatAssignmentResult {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { assignment_id?: unknown }).assignment_id !== "string"
    || !Number.isSafeInteger((value as { resource_version?: unknown }).resource_version)
  ) throw new DomainError("INTERNAL_ERROR", "Stored Pack seat response is invalid");
  return Object.freeze({ ...(value as PackSeatAssignmentResult) });
}

export async function assignPackSeat(
  dependencies: AssignPackSeatDependencies,
  context: EntitlementCommandContext,
  raw: unknown,
): Promise<PackSeatAssignmentResult> {
  const input = validateEntitlementCommand<AssignPackSeatRequest>(AssignPackSeatRequestSchema, raw);
  try {
    return await withDatabaseTransactionRetry(dependencies.db, async (trx) => {
      const discovered = await trx.selectFrom("entitlements").select("tenant_id")
        .where("entitlement_id", "=", input.entitlement_id).executeTakeFirst();
      if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Entitlement was not found");
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
      if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Pack seat assignment is already in progress");

      const entitlement = await lockEntitlement(trx, input.entitlement_id);
      if (entitlement === undefined || entitlement.tenant_id !== discovered.tenant_id) {
        throw new DomainError("RESOURCE_VERSION_CONFLICT", "Entitlement changed");
      }
      if (
        entitlement.tenant_mode !== "b2b"
        || entitlement.assignment_mode !== "seat"
        || entitlement.status !== "active"
        || entitlement.valid_from > now
        || (entitlement.expires_at !== null && entitlement.expires_at <= now)
        || entitlement.seat_quantity === null
      ) throw new DomainError("ENTITLEMENT_DENIED", "Active B2B seat authority is required");
      if (Number(entitlement.resource_version) !== input.expected_resource_version) {
        throw new DomainError("RESOURCE_VERSION_CONFLICT", "Entitlement changed");
      }
      const release = await trx.selectFrom("tenant_pack_releases").select("status")
        .where("tenant_id", "=", entitlement.tenant_id)
        .where("tenant_pack_release_id", "=", entitlement.tenant_pack_release_id)
        .where("pack_product_id", "=", entitlement.pack_product_id)
        .forUpdate().executeTakeFirst();
      if (release?.status !== "current") throw new DomainError("ENTITLEMENT_DENIED", "Current Pack authority is required");

      const assignments = await lockEntitlementAssignments(trx, entitlement.tenant_id, entitlement.entitlement_id);
      if (assignments.some((candidate) => candidate.profile_id === input.profile_id)) {
        throw new DomainError("INVALID_STATE_TRANSITION", "Profile already has Pack assignment history");
      }
      const usedSeats = assignments.filter((candidate) => candidate.status === "preparing" || candidate.status === "available").length;
      if (usedSeats >= entitlement.seat_quantity) throw new DomainError("SEAT_EXHAUSTED", "Pack seat capacity is exhausted");
      await lockEligibleConsultantProfile(trx, entitlement.tenant_id, input.profile_id);

      const identifier = assignmentId(entitlement.entitlement_id, input.profile_id);
      await trx.insertInto("entitlement_assignments").values({
        assignment_id: identifier,
        tenant_id: entitlement.tenant_id,
        entitlement_id: entitlement.entitlement_id,
        profile_id: input.profile_id,
        status: "preparing",
        reason_code: "seat_assigned",
        resource_version: 1,
        created_at: now,
        updated_at: now,
      }).execute();
      await dependencies.resolveProfileSnapshotInTransaction({
        trx,
        now,
        tenantId: entitlement.tenant_id,
        profileId: input.profile_id,
      });
      const nextUsed = usedSeats + 1;
      const result: PackSeatAssignmentResult = Object.freeze({
        schema_version: 1,
        assignment_id: identifier,
        entitlement_id: entitlement.entitlement_id,
        profile_id: input.profile_id,
        status: "preparing",
        reason_code: "seat_assigned",
        resource_version: 1,
        used_seats: nextUsed,
        total_seats: entitlement.seat_quantity,
        available_seats: entitlement.seat_quantity - nextUsed,
      });
      await appendCustomerEntitlementLifecycleEffects(trx, actingMembershipId, context, {
        tenantId: entitlement.tenant_id,
        resourceType: "assignment",
        resourceId: identifier,
        resourceVersion: 1,
        operation,
        idempotencyKey: input.idempotency_key,
        eventType: "assignment.created",
        eventPayload: {
          assignment_id: identifier,
          entitlement_id: entitlement.entitlement_id,
          profile_id: input.profile_id,
          status: "preparing",
          reason_code: "seat_assigned",
          resource_version: 1,
        },
        profileId: input.profile_id,
        reconcilePayloadRef: input.profile_id,
        now,
      });
      await completeIdempotentCommand({ tenantId: entitlement.tenant_id, trx }, {
        key: input.idempotency_key,
        payloadHash: input.payload_hash,
        operation,
        resultRef: identifier,
        response: result,
        updatedAt: now,
      });
      return result;
    }, { isolationLevel: "serializable" });
  } catch (error) {
    if (isDatabaseTransactionRetryExhaustedError(error)) {
      const durable = await dependencies.db.selectFrom("entitlements")
        .select(["seat_quantity", "tenant_id"])
        .where("entitlement_id", "=", input.entitlement_id).executeTakeFirst();
      if (durable?.seat_quantity !== null && durable?.seat_quantity !== undefined) {
        const assignments = await dependencies.db.selectFrom("entitlement_assignments")
          .select("assignment_id")
          .where("tenant_id", "=", durable.tenant_id)
          .where("entitlement_id", "=", input.entitlement_id)
          .where("status", "in", ["preparing", "available"]).execute();
        if (assignments.length >= durable.seat_quantity) {
          throw new DomainError("SEAT_EXHAUSTED", "Pack seat capacity is exhausted");
        }
      }
    }
    if (error !== null && typeof error === "object") {
      const code = Object.getOwnPropertyDescriptor(error, "code");
      const constraint = Object.getOwnPropertyDescriptor(error, "constraint");
      if (
        code !== undefined && "value" in code && code.value === "23514"
        && constraint !== undefined && "value" in constraint
        && constraint.value === "entitlement_assignments_seat_capacity_check"
      ) throw new DomainError("SEAT_EXHAUSTED", "Pack seat capacity is exhausted");
    }
    throw error;
  }
}
