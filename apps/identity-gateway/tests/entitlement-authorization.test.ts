import assert from "node:assert/strict";
import test from "node:test";

import {
  toCompanyAssignmentSummary,
  toCompanyServiceSummary,
  toStudentServiceSummary,
} from "../src/public-entitlement-views.js";

test("public entitlement projections allowlist fields and map calm states", () => {
  const internal = {
    entitlement_id: "entitlement_01", pack_product_id: "pack_01", display_name: "Student Suite",
    entitlement_resource_version: 4,
    valid_from: new Date("2026-08-24T00:00:00.000Z"), expires_at: null,
    entitlement_status: "active", assignment_status: "available", projection_status: "available",
    used_seats: 1, seat_quantity: 3,
    artifact_ref: "oci:registry.invalid/private@sha256:secret", contract_ref: "private/contract",
    external_order_ref: "order_secret", runtime_container_id: "container_secret",
    failure_summary: "provider internal failure",
  } as const;
  const company = toCompanyServiceSummary(internal);
  assert.deepEqual(company, {
    schema_version: 1, service_id: "entitlement_01", display_name: "Student Suite",
    entitlement_resource_version: 4,
    valid_from: "2026-08-24T00:00:00.000Z", service_state: "available",
    used_seats: 1, total_seats: 3, available_seats: 2,
  });
  assert.doesNotMatch(JSON.stringify(company), /artifact|contract|order|container|failure/u);

  const student = toStudentServiceSummary({ ...internal, assignment_status: "preparing", projection_status: "preparing" });
  assert.equal(student.service_state, "preparing");

  const assignment = toCompanyAssignmentSummary({
    assignment_id: "assignment_01", profile_id: "profile_01", profile_display_name: "Consultant profile",
    assignment_resource_version: 3,
    service_display_name: "Company Suite", assignment_status: "failed",
    failure_summary: "technical failure must stay private",
  });
  assert.deepEqual(assignment, {
    schema_version: 1, assignment_id: "assignment_01", profile_id: "profile_01",
    assignment_resource_version: 3,
    profile_display_name: "Consultant profile", service_display_name: "Company Suite", service_state: "unavailable",
  });

  const longDisplayName = toCompanyAssignmentSummary({
    assignment_id: "assignment_long", profile_id: "profile_long", profile_display_name: "x".repeat(300),
    assignment_resource_version: 1,
    service_display_name: "Company Suite", assignment_status: "available",
  });
  assert.equal(longDisplayName.profile_display_name.length, 200);
});

test("public entitlement projections reject impossible or accessor-backed rows", () => {
  const accessor = Object.defineProperty({}, "entitlement_id", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => toCompanyServiceSummary(accessor as never), { code: "INTERNAL_ERROR" });
  assert.throws(() => toStudentServiceSummary({
    entitlement_id: "entitlement_01", display_name: "Suite", valid_from: new Date(), expires_at: null,
    entitlement_status: "active", assignment_status: "available", projection_status: "failed",
  } as never), { code: "INTERNAL_ERROR" });
});
