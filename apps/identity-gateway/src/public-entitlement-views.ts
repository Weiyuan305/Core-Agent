import { types as utilTypes } from "node:util";

import type {
  CompanyAssignmentSummary,
  CompanyServiceSummary,
  StudentServiceSummary,
} from "@core-agent/contracts";
import { PublicServiceStateSchema } from "@core-agent/contracts";
import { DomainError } from "@core-agent/runtime-core";
import type { Static } from "typebox";

type PublicServiceState = Static<typeof PublicServiceStateSchema>;

type StoredEntitlementStatus = "active" | "suspended" | "expired" | "revoked";
type StoredAssignmentStatus = "preparing" | "available" | "suspended" | "expired" | "failed" | "revoked";
type StoredProjectionStatus = "preparing" | "available" | "failed";

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined || !("value" in descriptor))) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function text(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 255) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  return value;
}

function boundedDisplayName(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  if (value.length <= 200) return value;
  const bounded = value.slice(0, 200);
  return /[\uD800-\uDBFF]$/u.test(bounded) ? bounded.slice(0, -1) : bounded;
}

function date(row: Readonly<Record<string, unknown>>, key: string): Date {
  const value = row[key];
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  return value;
}

function optionalDate(row: Readonly<Record<string, unknown>>, key: string): Date | null {
  return row[key] === null ? null : date(row, key);
}

function integer(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DomainError("INTERNAL_ERROR", "Stored public service projection is invalid");
  }
  return value as number;
}

function state(
  entitlementStatus: StoredEntitlementStatus,
  assignmentStatus: StoredAssignmentStatus | undefined,
  projectionStatus: StoredProjectionStatus | undefined,
): PublicServiceState {
  if (entitlementStatus === "suspended") return "suspended";
  if (entitlementStatus === "expired") return "expired";
  if (entitlementStatus === "revoked") return "unavailable";
  if (assignmentStatus === "suspended") return "suspended";
  if (assignmentStatus === "expired") return "expired";
  if (assignmentStatus === "failed" || assignmentStatus === "revoked") return "unavailable";
  if (assignmentStatus === "available" && projectionStatus === "failed") {
    throw new DomainError("INTERNAL_ERROR", "Stored public service state is inconsistent");
  }
  if (projectionStatus === "failed") return "unavailable";
  if (assignmentStatus === "preparing" || projectionStatus === "preparing" || projectionStatus === undefined) return "preparing";
  return "available";
}

function entitlementStatus(row: Readonly<Record<string, unknown>>): StoredEntitlementStatus {
  const value = row.entitlement_status;
  if (value !== "active" && value !== "suspended" && value !== "expired" && value !== "revoked") {
    throw new DomainError("INTERNAL_ERROR", "Stored Entitlement status is invalid");
  }
  return value;
}

function assignmentStatus(row: Readonly<Record<string, unknown>>): StoredAssignmentStatus | undefined {
  const value = row.assignment_status;
  if (value === undefined) return undefined;
  if (value !== "preparing" && value !== "available" && value !== "suspended" && value !== "expired" && value !== "failed" && value !== "revoked") {
    throw new DomainError("INTERNAL_ERROR", "Stored Assignment status is invalid");
  }
  return value;
}

function projectionStatus(row: Readonly<Record<string, unknown>>): StoredProjectionStatus | undefined {
  const value = row.projection_status;
  if (value === undefined || value === null) return undefined;
  if (value !== "preparing" && value !== "available" && value !== "failed") {
    throw new DomainError("INTERNAL_ERROR", "Stored Runtime projection status is invalid");
  }
  return value;
}

export function toCompanyServiceSummary(value: unknown): CompanyServiceSummary {
  const row = plainRecord(value);
  const usedSeats = integer(row, "used_seats");
  const totalSeats = integer(row, "seat_quantity");
  if (totalSeats < 1 || usedSeats > totalSeats) throw new DomainError("INTERNAL_ERROR", "Stored seat authority is invalid");
  const expiresAt = optionalDate(row, "expires_at");
  return Object.freeze({
    schema_version: 1,
    service_id: text(row, "entitlement_id"),
    display_name: text(row, "display_name"),
    valid_from: date(row, "valid_from").toISOString(),
    ...(expiresAt === null ? {} : { expires_at: expiresAt.toISOString() }),
    service_state: state(entitlementStatus(row), assignmentStatus(row), projectionStatus(row)),
    used_seats: usedSeats,
    total_seats: totalSeats,
    available_seats: totalSeats - usedSeats,
  });
}

export function toStudentServiceSummary(value: unknown): StudentServiceSummary {
  const row = plainRecord(value);
  const expiresAt = optionalDate(row, "expires_at");
  return Object.freeze({
    schema_version: 1,
    service_id: text(row, "entitlement_id"),
    display_name: text(row, "display_name"),
    valid_from: date(row, "valid_from").toISOString(),
    ...(expiresAt === null ? {} : { expires_at: expiresAt.toISOString() }),
    service_state: state(entitlementStatus(row), assignmentStatus(row), projectionStatus(row)),
  });
}

export function toCompanyAssignmentSummary(value: unknown): CompanyAssignmentSummary {
  const row = plainRecord(value);
  const status = assignmentStatus(row);
  if (status === undefined) throw new DomainError("INTERNAL_ERROR", "Stored Assignment status is invalid");
  return Object.freeze({
    schema_version: 1,
    assignment_id: text(row, "assignment_id"),
    profile_id: text(row, "profile_id"),
    profile_display_name: boundedDisplayName(row, "profile_display_name"),
    service_display_name: text(row, "service_display_name"),
    service_state: state("active", status, status === "failed" ? "failed" : status === "available" ? "available" : "preparing"),
  });
}
