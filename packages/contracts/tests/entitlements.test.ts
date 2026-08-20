import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  AssignmentStatusSchema,
  CompanyAssignmentSummarySchema,
  CompanyServiceSummarySchema,
  ChangeEntitlementStatusRequestSchema,
  EntitlementAssignmentSchema,
  EntitlementSchema,
  EntitlementSourceSchema,
  EntitlementStatusSchema,
  GrantEntitlementRequestSchema,
  PublicServiceStateSchema,
  SelectTenantPackReleaseRequestSchema,
  StudentServiceSummarySchema,
  validateCompanyServiceSummary,
  validateEntitlement,
} from "../src/index.js";

const metadata = {
  schema_version: 1 as const,
  resource_version: 2,
  created_at: "2026-08-20T01:00:00Z",
  updated_at: "2026-08-20T01:05:00Z",
};

const entitlementBase = {
  ...metadata,
  entitlement_id: "entitlement_demo",
  tenant_id: "tenant_demo",
  pack_product_id: "pack.eduapply",
  tenant_pack_release_id: "tenant_release.demo.eduapply.1",
  pack_version_id: "pack_version.eduapply.1",
  pack_version: "1.0.0",
  source: "platform_manual",
  external_order_ref: "order_demo_001",
  valid_from: "2026-08-20T01:00:00Z",
  expires_at: "2027-08-20T01:00:00Z",
  status: "active",
  reason_code: "platform_grant",
};

test("entitlement and assignment vocabularies are closed", () => {
  const cases = [
    [EntitlementStatusSchema, ["active", "suspended", "expired", "revoked"], "pending"],
    [AssignmentStatusSchema, ["preparing", "available", "suspended", "expired", "failed", "revoked"], "ready"],
    [EntitlementSourceSchema, ["platform_manual"], "stripe"],
    [PublicServiceStateSchema, ["preparing", "available", "suspended", "expired", "unavailable"], "failed"],
  ] as const;

  for (const [schema, allowed, rejected] of cases) {
    for (const value of allowed) assert.equal(Schema.Check(schema, value), true, value);
    assert.equal(Schema.Check(schema, rejected), false, rejected);
  }
});

test("entitlement schema discriminates positive b2b seats from b2c automatic application", () => {
  const b2b = {
    ...entitlementBase,
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: 3,
  };
  const b2c = {
    ...entitlementBase,
    tenant_mode: "b2c",
    assignment_mode: "automatic",
  };
  assert.equal(Schema.Check(EntitlementSchema, b2b), true);
  assert.equal(Schema.Check(EntitlementSchema, b2c), true);
  assert.deepEqual(validateEntitlement(b2b), []);
  assert.deepEqual(validateEntitlement(b2c), []);

  for (const invalid of [
    { ...b2b, seat_quantity: 0 },
    { ...b2b, assignment_mode: "automatic" },
    { ...b2c, seat_quantity: 1 },
    { ...b2c, assignment_mode: "seat" },
    { ...b2c, source: "app_store" },
    { ...b2c, price: 999 },
  ]) {
    assert.equal(Schema.Check(EntitlementSchema, invalid), false);
  }
});

test("entitlement resources exhaustively bind each status to truthful reasons", () => {
  const statuses = ["active", "suspended", "expired", "revoked"] as const;
  const reasons = [
    "platform_grant",
    "administrator_suspended",
    "administrator_reactivated",
    "platform_revoked",
    "validity_expired",
  ] as const;
  const allowed = new Set([
    "active:platform_grant",
    "active:administrator_reactivated",
    "suspended:administrator_suspended",
    "expired:validity_expired",
    "revoked:platform_revoked",
  ]);
  const resource = {
    ...entitlementBase,
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: 1,
  };

  for (const status of statuses) {
    for (const reason_code of reasons) {
      assert.equal(
        Schema.Check(EntitlementSchema, { ...resource, status, reason_code }),
        allowed.has(`${status}:${reason_code}`),
        `${status}:${reason_code}`,
      );
    }
  }
});

test("entitlement semantic validation rejects an inverted validity window", () => {
  const invalid = {
    ...entitlementBase,
    tenant_mode: "b2b" as const,
    assignment_mode: "seat" as const,
    seat_quantity: 1,
    valid_from: "2027-08-20T01:00:00Z",
    expires_at: "2026-08-20T01:00:00Z",
  };
  assert.deepEqual(
    validateEntitlement(invalid).map((item) => item.code),
    ["ENTITLEMENT_VALIDITY_INVERTED"],
  );
});

test("assignment resource remains tenant scoped and closed", () => {
  const assignment = {
    ...metadata,
    assignment_id: "assignment_demo",
    tenant_id: "tenant_demo",
    entitlement_id: "entitlement_demo",
    profile_id: "profile_demo",
    status: "preparing",
    reason_code: "seat_assigned",
  };
  assert.equal(Schema.Check(EntitlementAssignmentSchema, assignment), true);
  assert.equal(Schema.Check(EntitlementAssignmentSchema, { ...assignment, external_order_ref: "private" }), false);
  assert.equal(Schema.Check(EntitlementAssignmentSchema, { ...assignment, status: "ready" }), false);
});

test("assignment resources exhaustively bind each status to truthful reasons", () => {
  const statuses = ["preparing", "available", "suspended", "expired", "failed", "revoked"] as const;
  const reasons = [
    "seat_assigned",
    "administrator_suspended",
    "authority_suspended",
    "validity_expired",
    "runtime_preparation_failed",
    "administrator_revoked",
  ] as const;
  const allowed = new Set([
    "preparing:seat_assigned",
    "available:seat_assigned",
    "suspended:administrator_suspended",
    "suspended:authority_suspended",
    "expired:validity_expired",
    "failed:runtime_preparation_failed",
    "revoked:administrator_revoked",
  ]);
  const resource = {
    ...metadata,
    assignment_id: "assignment_demo",
    tenant_id: "tenant_demo",
    entitlement_id: "entitlement_demo",
    profile_id: "profile_demo",
  };

  for (const status of statuses) {
    for (const reason_code of reasons) {
      assert.equal(
        Schema.Check(EntitlementAssignmentSchema, { ...resource, status, reason_code }),
        allowed.has(`${status}:${reason_code}`),
        `${status}:${reason_code}`,
      );
    }
  }
});

test("grant command accepts only exact platform manual b2b or b2c authority", () => {
  const command = {
    schema_version: 1,
    idempotency_key: "idem_grant_demo",
    payload_hash: `sha256:${"d".repeat(64)}`,
    tenant_id: "tenant_demo",
    pack_product_id: "pack.eduapply",
    source: "platform_manual",
    external_order_ref: "order_demo_001",
    expected_resource_version: 2,
    expires_at: "2027-08-20T01:00:00Z",
    tenant_mode: "b2b",
    assignment_mode: "seat",
    seat_quantity: 3,
  };
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, command), true);
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, { ...command, source: "stripe" }), false);
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, { ...command, seat_quantity: 0 }), false);
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, { ...command, receipt: "private" }), false);
  const { expected_resource_version: _version, ...withoutVersion } = command;
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, withoutVersion), false);
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, { ...command, expected_resource_version: 0 }), false);
  assert.equal(Schema.Check(GrantEntitlementRequestSchema, { ...command, expected_resource_version: 1.5 }), false);
});

test("Pack release selection requires positive optimistic concurrency authority", () => {
  const command = {
    schema_version: 1,
    idempotency_key: "idem_select_release",
    payload_hash: `sha256:${"a".repeat(64)}`,
    tenant_id: "tenant_demo",
    pack_product_id: "pack.eduapply",
    pack_version_id: "pack_version.eduapply.1",
    expected_resource_version: 2,
  };
  assert.equal(Schema.Check(SelectTenantPackReleaseRequestSchema, command), true);
  const { expected_resource_version: _version, ...withoutVersion } = command;
  assert.equal(Schema.Check(SelectTenantPackReleaseRequestSchema, withoutVersion), false);
  assert.equal(Schema.Check(SelectTenantPackReleaseRequestSchema, { ...command, expected_resource_version: 0 }), false);
  assert.equal(Schema.Check(SelectTenantPackReleaseRequestSchema, { ...command, expected_resource_version: 1.5 }), false);
});

test("entitlement status commands cannot forge database-clock expiry", () => {
  const command = {
    schema_version: 1,
    idempotency_key: "idem_status_demo",
    payload_hash: `sha256:${"f".repeat(64)}`,
    entitlement_id: "entitlement_demo",
    expected_resource_version: 2,
    status: "suspended",
    reason_code: "administrator_suspended",
  };
  assert.equal(Schema.Check(ChangeEntitlementStatusRequestSchema, command), true);
  assert.equal(Schema.Check(ChangeEntitlementStatusRequestSchema, {
    ...command,
    status: "active",
    reason_code: "administrator_reactivated",
  }), true);
  assert.equal(Schema.Check(ChangeEntitlementStatusRequestSchema, {
    ...command,
    status: "revoked",
    reason_code: "platform_revoked",
  }), true);
  assert.equal(Schema.Check(ChangeEntitlementStatusRequestSchema, {
    ...command,
    status: "expired",
    reason_code: "validity_expired",
  }), false);
});

test("company summaries expose only calm seat and validity fields", () => {
  const summary = {
    schema_version: 1,
    service_id: "service_demo",
    display_name: "EduApply",
    used_seats: 2,
    total_seats: 3,
    available_seats: 1,
    valid_from: "2026-08-20T01:00:00Z",
    expires_at: "2027-08-20T01:00:00Z",
    service_state: "available",
  };
  assert.equal(Schema.Check(CompanyServiceSummarySchema, summary), true);
  assert.deepEqual(validateCompanyServiceSummary(summary), []);
  for (const field of [
    "artifact_ref", "contract_ref", "capability_ids", "external_order_ref",
    "price", "receipt", "tool_schema", "secret", "failure_summary",
  ] as const) {
    assert.equal(Schema.Check(CompanyServiceSummarySchema, { ...summary, [field]: "private" }), false, field);
  }
  assert.deepEqual(
    validateCompanyServiceSummary({ ...summary, used_seats: 4 }).map((item) => item.code),
    ["COMPANY_SERVICE_SEATS_EXCEEDED", "COMPANY_SERVICE_SEATS_INCONSISTENT"],
  );
  assert.deepEqual(
    validateCompanyServiceSummary({ ...summary, available_seats: 2 }).map((item) => item.code),
    ["COMPANY_SERVICE_SEATS_INCONSISTENT"],
  );
});

test("company summary validation rejects accessors without invoking them", () => {
  let getterCalls = 0;
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "used_seats", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  assert.deepEqual(
    validateCompanyServiceSummary(hostile).map((item) => item.code),
    ["COMPANY_SERVICE_SUMMARY_NOT_PLAIN_DATA"],
  );
  assert.equal(getterCalls, 0);
});

test("student summaries never expose raw capability or commercial internals", () => {
  const summary = {
    schema_version: 1,
    service_id: "service_demo",
    display_name: "Student all-in-one",
    valid_from: "2026-08-20T01:00:00Z",
    service_state: "preparing",
  };
  assert.equal(Schema.Check(StudentServiceSummarySchema, summary), true);
  for (const field of [
    "capability_id", "capability_ids", "artifact_ref", "contract_ref", "external_order_ref",
    "price", "receipt", "tool_schema", "secret", "failure_summary",
  ] as const) {
    assert.equal(Schema.Check(StudentServiceSummarySchema, { ...summary, [field]: "private" }), false, field);
  }
});

test("company assignment summaries expose display identity and calm service state only", () => {
  const summary = {
    schema_version: 1,
    assignment_id: "assignment_demo",
    profile_id: "profile_demo",
    profile_display_name: "Consultant Demo",
    service_display_name: "EduApply",
    service_state: "available",
  };
  assert.equal(Schema.Check(CompanyAssignmentSummarySchema, summary), true);
  assert.equal(Schema.Check(CompanyAssignmentSummarySchema, { ...summary, entitlement_id: "private" }), false);
  assert.equal(Schema.Check(CompanyAssignmentSummarySchema, { ...summary, failure_summary: "private" }), false);
});
