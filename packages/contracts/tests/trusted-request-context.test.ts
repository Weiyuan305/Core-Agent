import assert from "node:assert/strict";
import test from "node:test";
import Schema from "typebox/schema";

import {
  SignedTrustedRequestContextSchema,
  TrustedRequestContextSchema,
  validateSignedContextEnvelope,
  validateEntitlementAwareTrustedRequestContext,
  validateTrustedRequestContext,
  type SignedTrustedRequestContext,
  type TrustedRequestContext,
  type TrustedContextAuthority,
  type EntitlementAwareTrustedContextAuthority,
} from "../src/index.js";

const context: TrustedRequestContext = {
  schema_version: 1,
  tenant_mode: "b2b",
  tenant_id: "tenant_demo",
  actor_id: "actor_consultant",
  original_actor_id: "actor_consultant",
  membership_id: "membership_demo",
  effective_role: "consultant",
  profile_id: "profile_demo",
  student_ref: { student_id: "student_demo", source_system: "eduapply" },
  case_ref: {
    case_id: "case_demo",
    student_id: "student_demo",
    capability_id: "eduapply.application",
  },
  entitlement_snapshot_ref: {
    snapshot_id: "entitlement_demo",
    version: 7,
    evaluated_at: "2026-08-03T01:00:00Z",
  },
  capability_ids: ["eduapply.application"],
  container_id: "container_demo",
  conversation_id: "conversation_demo",
  run_id: "run_demo",
  request_id: "request_demo",
  trace_id: "trace_demo",
  client_request_id: "client_request_demo",
  context_id: "context_demo",
  issuer: "core-agent-control-plane",
  audience: ["capability-gateway"],
  issued_at: "2026-08-03T01:00:00Z",
  expires_at: "2026-08-03T01:05:00Z",
  key_id: "key_demo",
};

const authority: TrustedContextAuthority = {
  expected_issuer: "core-agent-control-plane",
  expected_audience: "capability-gateway",
  now: "2026-08-03T01:02:00Z",
  membership: {
    membership_id: "membership_demo",
    tenant_id: "tenant_demo",
    actor_id: "actor_consultant",
    roles: ["consultant"] as const,
    status: "active" as const,
  },
  profile: {
    profile_id: "profile_demo",
    tenant_id: "tenant_demo",
    owner_actor_id: "actor_consultant",
    status: "active" as const,
  },
};

test("accepts a short-lived server-derived context", () => {
  assert.equal(Schema.Compile(TrustedRequestContextSchema).Check(context), true);
  assert.deepEqual(validateTrustedRequestContext(context, authority), []);
});

test("rejects expiration, wrong audience, and forged role", () => {
  assert.deepEqual(
    validateTrustedRequestContext(context, {
      ...authority,
      now: "2026-08-03T01:06:00Z",
      expected_audience: "audit-runtime",
      membership: { ...authority.membership, roles: ["student"] },
    }).map((item) => item.code),
    [
      "EFFECTIVE_ROLE_NOT_GRANTED",
      "CONTEXT_AUDIENCE_MISMATCH",
      "CONTEXT_EXPIRED",
    ],
  );
});

test("rejects suspended memberships and excessive TTL", () => {
  const longLived = { ...context, expires_at: "2026-08-03T01:10:00Z" };
  assert.deepEqual(
    validateTrustedRequestContext(longLived, {
      ...authority,
      membership: { ...authority.membership, status: "suspended" },
    }).map((item) => item.code),
    ["MEMBERSHIP_NOT_ACTIVE", "CONTEXT_TTL_EXCEEDED"],
  );
});

test("fails closed when an inverted validity window is both future-issued and expired", () => {
  const invertedWindow = {
    ...context,
    issued_at: "2026-08-03T01:03:00Z",
    expires_at: "2026-08-03T01:01:00Z",
  };
  assert.deepEqual(
    validateTrustedRequestContext(invertedWindow, authority).map((item) => item.code),
    ["CONTEXT_NOT_YET_VALID", "CONTEXT_EXPIRED"],
  );
});

test("fails closed on a malformed authority comparison time", () => {
  assert.deepEqual(
    validateTrustedRequestContext(context, {
      ...authority,
      now: "not-a-date",
    }).map((item) => ({ code: item.code, path: item.path })),
    [{ code: "AUTHORITY_TIME_INVALID", path: "authority.now" }],
  );
});

test("authority comparison time requires a real UTC-Z calendar timestamp", () => {
  const invalid = [
    "2026-02-30T01:02:00Z",
    "2026-02-29T01:02:00Z",
    "2026-03-02T09:02:00+08:00",
    "2026-08-03T01:02:00.1234567890Z",
  ];
  for (const now of invalid) {
    assert.deepEqual(
      validateTrustedRequestContext(context, { ...authority, now })
        .map((item) => ({ code: item.code, path: item.path })),
      [{ code: "AUTHORITY_TIME_INVALID", path: "authority.now" }],
      now,
    );
  }

  const valid = [
    {
      now: "2024-02-29T01:02:00Z",
      issued_at: "2024-02-29T01:00:00Z",
      expires_at: "2024-02-29T01:05:00Z",
    },
    {
      now: "2026-08-03T01:02:00.1Z",
      issued_at: context.issued_at,
      expires_at: context.expires_at,
    },
    {
      now: "2026-08-03T01:02:00.123456789Z",
      issued_at: context.issued_at,
      expires_at: context.expires_at,
    },
  ];
  for (const { now, issued_at, expires_at } of valid) {
    assert.deepEqual(
      validateTrustedRequestContext(
        { ...context, issued_at, expires_at },
        { ...authority, now },
      ),
      [],
      now,
    );
  }
});

test("compares issued and expiry boundaries at nanosecond precision", () => {
  const preciseContext = {
    ...context,
    issued_at: "2026-08-03T01:00:00.123900000Z",
    expires_at: "2026-08-03T01:05:00.123900000Z",
  };
  assert.deepEqual(
    validateTrustedRequestContext(preciseContext, {
      ...authority,
      now: "2026-08-03T01:00:00.123800000Z",
    }).map((item) => item.code),
    ["CONTEXT_NOT_YET_VALID"],
  );

  const expiryBoundary = {
    ...context,
    issued_at: "2026-08-03T01:00:00Z",
    expires_at: "2026-08-03T01:05:00.123900000Z",
  };
  const cases = [
    { now: "2026-08-03T01:05:00.123800000Z", expired: false },
    { now: "2026-08-03T01:05:00.123900000Z", expired: true },
    { now: "2026-08-03T01:05:00.123900001Z", expired: true },
  ];
  for (const { now, expired } of cases) {
    assert.equal(
      validateTrustedRequestContext(expiryBoundary, { ...authority, now })
        .some((item) => item.code === "CONTEXT_EXPIRED"),
      expired,
      now,
    );
  }
});

test("enforces the 300-second TTL boundary at nanosecond precision", () => {
  const issuedAt = "2026-08-03T01:00:00.123900000Z";
  const cases = [
    { expiresAt: "2026-08-03T01:05:00.123900000Z", exceeded: false },
    { expiresAt: "2026-08-03T01:05:00.123900001Z", exceeded: true },
  ];
  for (const { expiresAt, exceeded } of cases) {
    assert.equal(
      validateTrustedRequestContext(
        { ...context, issued_at: issuedAt, expires_at: expiresAt },
        authority,
      ).some((item) => item.code === "CONTEXT_TTL_EXCEEDED"),
      exceeded,
      expiresAt,
    );
  }
});

test("requires explicit delegation when an admin targets another owner profile", () => {
  const delegated = {
    ...context,
    actor_id: "actor_admin",
    original_actor_id: "actor_admin",
    membership_id: "membership_admin",
    effective_role: "admin" as const,
  };
  const adminAuthority: TrustedContextAuthority = {
    ...authority,
    membership: {
      membership_id: "membership_admin",
      tenant_id: "tenant_demo",
      actor_id: "actor_admin",
      roles: ["admin"],
      status: "active",
    },
  };
  assert.deepEqual(
    validateTrustedRequestContext(delegated, adminAuthority).map((item) => item.code),
    ["DELEGATION_REQUIRED"],
  );
});

test("signed envelope metadata must match payload metadata", () => {
  const envelope = {
    schema_version: 1 as const,
    algorithm: "EdDSA" as const,
    key_id: "key_other",
    payload: context,
    signature: "synthetic_signature",
  };
  assert.equal(Schema.Compile(SignedTrustedRequestContextSchema).Check(envelope), true);
  assert.deepEqual(
    validateSignedContextEnvelope(envelope).map((item) => item.code),
    ["CONTEXT_KEY_ID_MISMATCH"],
  );
});

test("fails closed on tenant, membership, profile, issuer, and validity conflicts", () => {
  const mismatchedAuthority: TrustedContextAuthority = {
    ...authority,
    expected_issuer: "identity-runtime",
    now: "2026-08-03T00:59:59Z",
    membership: {
      ...authority.membership,
      membership_id: "membership_other",
      tenant_id: "tenant_other",
      actor_id: "actor_other",
    },
    profile: {
      ...authority.profile,
      profile_id: "profile_other",
      tenant_id: "tenant_other",
      status: "suspended",
    },
  };

  assert.deepEqual(
    validateTrustedRequestContext(context, mismatchedAuthority).map((item) => item.code),
    [
      "TENANT_SCOPE_MISMATCH",
      "MEMBERSHIP_CONTEXT_MISMATCH",
      "PROFILE_CONTEXT_MISMATCH",
      "CONTEXT_ISSUER_MISMATCH",
      "CONTEXT_NOT_YET_VALID",
    ],
  );
});

test("appends case scope violations before delegation violations", () => {
  const invalid = {
    ...context,
    case_ref: { ...context.case_ref!, student_id: "student_other" },
    delegation_reason: "Investigate the application",
    target_profile_id: "profile_other",
    original_actor_id: "actor_original",
  };

  assert.deepEqual(
    validateTrustedRequestContext(invalid, authority).map((item) => item.code),
    [
      "CASE_STUDENT_MISMATCH",
      "DELEGATION_FIELDS_INCOMPLETE",
      "DELEGATION_TARGET_MISMATCH",
      "ORIGINAL_ACTOR_MISMATCH",
    ],
  );
});

test("accepts complete delegation targeting the selected profile", () => {
  const delegated: TrustedRequestContext = {
    ...context,
    actor_id: "actor_admin",
    original_actor_id: "actor_admin",
    membership_id: "membership_admin",
    effective_role: "admin",
    delegation_id: "delegation_demo",
    delegation_reason: "Support escalation",
    target_profile_id: "profile_demo",
  };
  const adminAuthority: TrustedContextAuthority = {
    ...authority,
    membership: {
      membership_id: "membership_admin",
      tenant_id: "tenant_demo",
      actor_id: "actor_admin",
      roles: ["admin"],
      status: "active",
    },
  };

  assert.deepEqual(validateTrustedRequestContext(delegated, adminAuthority), []);
});

test("rejects every incomplete delegation field tuple", () => {
  const incompleteTuples: Array<Partial<Pick<
    TrustedRequestContext,
    "delegation_id" | "delegation_reason" | "target_profile_id"
  >>> = [
    { delegation_id: "delegation_demo" },
    { delegation_reason: "Support escalation" },
    { target_profile_id: "profile_demo" },
    { delegation_id: "delegation_demo", delegation_reason: "Support escalation" },
    { delegation_id: "delegation_demo", target_profile_id: "profile_demo" },
    { delegation_reason: "Support escalation", target_profile_id: "profile_demo" },
  ];

  for (const fields of incompleteTuples) {
    assert.deepEqual(
      validateTrustedRequestContext({ ...context, ...fields }, authority)
        .map((item) => item.code),
      ["DELEGATION_FIELDS_INCOMPLETE"],
      JSON.stringify(Object.keys(fields).sort()),
    );
  }
});

test("context schema rejects duplicate capabilities, duplicate audience, and unknown fields", () => {
  const validator = Schema.Compile(TrustedRequestContextSchema);
  assert.equal(
    validator.Check({
      ...context,
      capability_ids: ["eduapply.application", "eduapply.application"],
    }),
    false,
  );
  assert.equal(
    validator.Check({
      ...context,
      audience: ["capability-gateway", "capability-gateway"],
    }),
    false,
  );
  assert.equal(validator.Check({ ...context, untrusted: true }), false);
});

test("trusted context capability ids must be in canonical sorted order", () => {
  const entitlementAuthority: EntitlementAwareTrustedContextAuthority = {
    ...authority,
    entitlement_snapshot: {
      tenant_id: context.tenant_id,
      profile_id: context.profile_id,
      snapshot_ref: context.entitlement_snapshot_ref,
      capability_ids: ["eduapply.application", "housing.read"],
    },
  };
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext({
      ...context,
      capability_ids: ["housing.read", "eduapply.application"],
    }, entitlementAuthority).map((item) => item.code),
    ["CAPABILITY_IDS_NOT_SORTED", "ENTITLEMENT_CAPABILITIES_MISMATCH"],
  );
  assert.deepEqual(validateTrustedRequestContext({
    ...context,
    capability_ids: ["housing.read", "eduapply.application"],
  }, authority), []);
});

test("trusted context must exactly match the effective entitlement snapshot", () => {
  const effectiveAuthority: EntitlementAwareTrustedContextAuthority = {
    ...authority,
    entitlement_snapshot: {
      tenant_id: context.tenant_id,
      profile_id: context.profile_id,
      snapshot_ref: context.entitlement_snapshot_ref,
      capability_ids: context.capability_ids,
    },
  };
  assert.deepEqual(validateEntitlementAwareTrustedRequestContext(context, effectiveAuthority), []);
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext(context, {
      ...effectiveAuthority,
      entitlement_snapshot: {
        ...effectiveAuthority.entitlement_snapshot,
        snapshot_ref: { ...context.entitlement_snapshot_ref, version: 8 },
      },
    }).map((item) => item.code),
    ["ENTITLEMENT_SNAPSHOT_MISMATCH"],
  );
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext(context, {
      ...effectiveAuthority,
      entitlement_snapshot: {
        ...effectiveAuthority.entitlement_snapshot,
        capability_ids: ["housing.read"],
      },
    }).map((item) => item.code),
    ["ENTITLEMENT_CAPABILITIES_MISMATCH"],
  );
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext(
      context,
      authority as EntitlementAwareTrustedContextAuthority,
    ).map((item) => item.code),
    ["ENTITLEMENT_AUTHORITY_REQUIRED"],
  );
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext(context, {
      ...effectiveAuthority,
      entitlement_snapshot: {
        ...effectiveAuthority.entitlement_snapshot,
        capability_ids: ["housing.read", "eduapply.application"],
      },
    }).map((item) => item.code),
    ["ENTITLEMENT_AUTHORITY_CAPABILITIES_NOT_CANONICAL", "ENTITLEMENT_CAPABILITIES_MISMATCH"],
  );
});

test("entitlement snapshot authority binds tenant and profile scope", () => {
  const effectiveAuthority: EntitlementAwareTrustedContextAuthority = {
    ...authority,
    entitlement_snapshot: {
      tenant_id: context.tenant_id,
      profile_id: context.profile_id,
      snapshot_ref: context.entitlement_snapshot_ref,
      capability_ids: context.capability_ids,
    },
  };
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext(context, {
      ...effectiveAuthority,
      entitlement_snapshot: {
        ...effectiveAuthority.entitlement_snapshot,
        tenant_id: "tenant_other",
      },
    }).map((item) => ({ code: item.code, path: item.path })),
    [{
      code: "ENTITLEMENT_AUTHORITY_TENANT_MISMATCH",
      path: "authority.entitlement_snapshot.tenant_id",
    }],
  );
  assert.deepEqual(
    validateEntitlementAwareTrustedRequestContext(context, {
      ...effectiveAuthority,
      entitlement_snapshot: {
        ...effectiveAuthority.entitlement_snapshot,
        profile_id: "profile_other",
      },
    }).map((item) => ({ code: item.code, path: item.path })),
    [{
      code: "ENTITLEMENT_AUTHORITY_PROFILE_MISMATCH",
      path: "authority.entitlement_snapshot.profile_id",
    }],
  );
});

test("entitlement snapshot authority is closed and requires tenant/profile scope", () => {
  const complete = {
    tenant_id: context.tenant_id,
    profile_id: context.profile_id,
    snapshot_ref: context.entitlement_snapshot_ref,
    capability_ids: context.capability_ids,
  };
  const { tenant_id: _tenantId, ...withoutTenant } = complete;
  const { profile_id: _profileId, ...withoutProfile } = complete;
  for (const entitlement_snapshot of [
    withoutTenant,
    withoutProfile,
    { ...complete, unexpected: true },
  ]) {
    assert.deepEqual(
      validateEntitlementAwareTrustedRequestContext(context, {
        ...authority,
        entitlement_snapshot,
      } as unknown as EntitlementAwareTrustedContextAuthority).map((item) => ({
        code: item.code,
        path: item.path,
      })),
      [{
        code: "ENTITLEMENT_AUTHORITY_REQUIRED",
        path: "authority.entitlement_snapshot",
      }],
    );
  }
});

test("entitlement snapshot authority rejects accessors without invoking them", () => {
  let getterCalls = 0;
  const hostileAuthority = { ...authority } as unknown as EntitlementAwareTrustedContextAuthority;
  Object.defineProperty(hostileAuthority, "entitlement_snapshot", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {
        tenant_id: context.tenant_id,
        profile_id: context.profile_id,
        snapshot_ref: context.entitlement_snapshot_ref,
        capability_ids: context.capability_ids,
      };
    },
  });

  const violations = validateEntitlementAwareTrustedRequestContext(context, hostileAuthority);
  assert.equal(getterCalls, 0);
  assert.deepEqual(
    violations.map((item) => ({ code: item.code, path: item.path })),
    [{
      code: "ENTITLEMENT_AUTHORITY_REQUIRED",
      path: "authority.entitlement_snapshot",
    }],
  );
});

test("signed envelope rejects schema and algorithm conflicts without claiming signature validity", () => {
  const wrongSchema = {
    schema_version: 2,
    algorithm: "EdDSA",
    key_id: "key_demo",
    payload: context,
    signature: "synthetic_signature_not_cryptographically_verified",
  } as unknown as SignedTrustedRequestContext;
  const wrongAlgorithm = {
    schema_version: 1,
    algorithm: "RS256",
    key_id: "key_demo",
    payload: context,
    signature: "synthetic_signature_not_cryptographically_verified",
  } as unknown as SignedTrustedRequestContext;

  assert.deepEqual(
    validateSignedContextEnvelope(wrongSchema).map((item) => item.code),
    ["CONTEXT_SCHEMA_VERSION_MISMATCH"],
  );
  assert.deepEqual(
    validateSignedContextEnvelope(wrongAlgorithm).map((item) => item.code),
    ["CONTEXT_ALGORITHM_UNSUPPORTED"],
  );
});
