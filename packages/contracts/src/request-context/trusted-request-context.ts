import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  parseStrictUtcTimestamp,
  SchemaVersionSchema,
  UtcTimestampSchema,
} from "../common/primitives.js";
import { type ContractViolation, violation } from "../common/validation.js";
import { ProfileStatusSchema } from "../profile/profile.js";
import {
  CaseRefSchema,
  ConsentSnapshotRefSchema,
  EntitlementSnapshotRefSchema,
  type EntitlementSnapshotRef,
  StudentRefSchema,
  validateCaseScope,
} from "../runtime/refs.js";
import {
  MembershipRoleSchema,
  MembershipStatusSchema,
  TenantModeSchema,
} from "../tenant/identity.js";

export const TrustedRequestContextSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    tenant_mode: TenantModeSchema,
    tenant_id: OpaqueIdSchema,
    actor_id: OpaqueIdSchema,
    original_actor_id: OpaqueIdSchema,
    membership_id: OpaqueIdSchema,
    effective_role: MembershipRoleSchema,
    profile_id: OpaqueIdSchema,
    student_ref: Type.Optional(StudentRefSchema),
    case_ref: Type.Optional(CaseRefSchema),
    entitlement_snapshot_ref: EntitlementSnapshotRefSchema,
    consent_snapshot_ref: Type.Optional(ConsentSnapshotRefSchema),
    capability_ids: Type.Array(OpaqueIdSchema, { uniqueItems: true }),
    container_id: OpaqueIdSchema,
    conversation_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
    client_request_id: OpaqueIdSchema,
    context_id: OpaqueIdSchema,
    issuer: OpaqueIdSchema,
    audience: Type.Array(OpaqueIdSchema, { minItems: 1, uniqueItems: true }),
    issued_at: UtcTimestampSchema,
    expires_at: UtcTimestampSchema,
    key_id: OpaqueIdSchema,
    delegation_id: Type.Optional(OpaqueIdSchema),
    delegation_reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    target_profile_id: Type.Optional(OpaqueIdSchema),
  },
  {
    additionalProperties: false,
    $id: "core-agent://v1/trusted-request-context",
  },
);

export const SignedTrustedRequestContextSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    algorithm: Type.Literal("EdDSA"),
    key_id: OpaqueIdSchema,
    payload: TrustedRequestContextSchema,
    signature: Type.String({ minLength: 1 }),
  },
  {
    additionalProperties: false,
    $id: "core-agent://v1/signed-trusted-request-context",
  },
);

export type TrustedRequestContext = Static<typeof TrustedRequestContextSchema>;
export type SignedTrustedRequestContext = Static<typeof SignedTrustedRequestContextSchema>;

/**
 * Server-derived facts used to compare an untrusted transported context with
 * current authority. Callers must not populate this object from client input.
 */
export interface TrustedContextAuthority {
  expected_issuer: string;
  expected_audience: string;
  now: string;
  membership: {
    membership_id: string;
    tenant_id: string;
    actor_id: string;
    roles: readonly ("admin" | "consultant" | "student")[];
    status: Static<typeof MembershipStatusSchema>;
  };
  profile: {
    profile_id: string;
    tenant_id: string;
    owner_actor_id: string;
    status: Static<typeof ProfileStatusSchema>;
  };
}

export interface EntitlementAwareTrustedContextAuthority extends TrustedContextAuthority {
  entitlement_snapshot: {
    snapshot_ref: EntitlementSnapshotRef;
    capability_ids: readonly string[];
  };
}

const MAX_CONTEXT_TTL_NANOSECONDS = 300_000_000_000n;

export function validateTrustedRequestContext(
  context: TrustedRequestContext,
  authority: TrustedContextAuthority,
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (authority.membership.status !== "active") {
    violations.push(
      violation(
        "MEMBERSHIP_NOT_ACTIVE",
        "membership_id",
        "Trusted context requires an active membership",
      ),
    );
  }

  if (
    context.tenant_id !== authority.membership.tenant_id
    || context.tenant_id !== authority.profile.tenant_id
    || authority.membership.tenant_id !== authority.profile.tenant_id
  ) {
    violations.push(
      violation(
        "TENANT_SCOPE_MISMATCH",
        "tenant_id",
        "Context, membership, and profile must belong to the same tenant",
      ),
    );
  }

  if (
    context.membership_id !== authority.membership.membership_id
    || context.actor_id !== authority.membership.actor_id
  ) {
    violations.push(
      violation(
        "MEMBERSHIP_CONTEXT_MISMATCH",
        "membership_id",
        "Context membership or actor does not match current authority",
      ),
    );
  }

  if (
    context.profile_id !== authority.profile.profile_id
    || authority.profile.status !== "active"
  ) {
    violations.push(
      violation(
        "PROFILE_CONTEXT_MISMATCH",
        "profile_id",
        "Context profile does not match an active authoritative profile",
      ),
    );
  }

  if (!authority.membership.roles.includes(context.effective_role)) {
    violations.push(
      violation(
        "EFFECTIVE_ROLE_NOT_GRANTED",
        "effective_role",
        "Effective role is not granted by the current membership",
      ),
    );
  }

  if (context.issuer !== authority.expected_issuer) {
    violations.push(
      violation(
        "CONTEXT_ISSUER_MISMATCH",
        "issuer",
        "Context issuer does not match the expected authority",
      ),
    );
  }

  if (!context.audience.includes(authority.expected_audience)) {
    violations.push(
      violation(
        "CONTEXT_AUDIENCE_MISMATCH",
        "audience",
        "Context audience does not include the expected recipient",
      ),
    );
  }

  const now = parseStrictUtcTimestamp(authority.now);
  const issuedAt = parseStrictUtcTimestamp(context.issued_at);
  const expiresAt = parseStrictUtcTimestamp(context.expires_at);

  if (now === undefined) {
    violations.push(
      violation(
        "AUTHORITY_TIME_INVALID",
        "authority.now",
        "Authority comparison time must be a valid timestamp",
      ),
    );
  } else {
    if (issuedAt !== undefined && now < issuedAt) {
      violations.push(
        violation(
          "CONTEXT_NOT_YET_VALID",
          "issued_at",
          "Context was issued after the authority comparison time",
        ),
      );
    }
    if (expiresAt !== undefined && now >= expiresAt) {
      violations.push(
        violation(
          "CONTEXT_EXPIRED",
          "expires_at",
          "Context has expired at the authority comparison time",
        ),
      );
    }
  }

  if (
    issuedAt !== undefined
    && expiresAt !== undefined
    && expiresAt - issuedAt > MAX_CONTEXT_TTL_NANOSECONDS
  ) {
    violations.push(
      violation(
        "CONTEXT_TTL_EXCEEDED",
        "expires_at",
        "Context lifetime exceeds 300 seconds",
      ),
    );
  }

  violations.push(...validateCaseScope(context.student_ref, context.case_ref));

  const delegationFieldsPresent = [
    context.delegation_id,
    context.delegation_reason,
    context.target_profile_id,
  ].map((field) => field !== undefined);
  const delegationFieldCount = delegationFieldsPresent.filter(Boolean).length;

  if (delegationFieldCount !== 0 && delegationFieldCount !== delegationFieldsPresent.length) {
    violations.push(
      violation(
        "DELEGATION_FIELDS_INCOMPLETE",
        "delegation_id",
        "Delegation id, reason, and target profile must be provided together",
      ),
    );
  }

  if (
    authority.profile.owner_actor_id !== context.actor_id
    && context.delegation_id === undefined
  ) {
    violations.push(
      violation(
        "DELEGATION_REQUIRED",
        "delegation_id",
        "Acting on another actor's profile requires explicit delegation",
      ),
    );
  }

  if (
    context.target_profile_id !== undefined
    && context.target_profile_id !== context.profile_id
  ) {
    violations.push(
      violation(
        "DELEGATION_TARGET_MISMATCH",
        "target_profile_id",
        "Delegation target must match the selected context profile",
      ),
    );
  }

  if (
    context.delegation_id === undefined
    && context.original_actor_id !== context.actor_id
  ) {
    violations.push(
      violation(
        "ORIGINAL_ACTOR_MISMATCH",
        "original_actor_id",
        "Original actor must equal the effective actor without delegation",
      ),
    );
  }

  return violations;
}

export function validateEntitlementAwareTrustedRequestContext(
  context: TrustedRequestContext,
  authority: EntitlementAwareTrustedContextAuthority,
): ContractViolation[] {
  const violations = validateTrustedRequestContext(context, authority);
  const entitlementAuthority = (
    authority as Partial<EntitlementAwareTrustedContextAuthority>
  ).entitlement_snapshot;
  if (
    entitlementAuthority === undefined
    || entitlementAuthority === null
    || entitlementAuthority.snapshot_ref === undefined
    || entitlementAuthority.snapshot_ref === null
    || !Array.isArray(entitlementAuthority.capability_ids)
  ) {
    violations.push(violation(
      "ENTITLEMENT_AUTHORITY_REQUIRED",
      "authority.entitlement_snapshot",
      "Entitlement-aware validation requires the authoritative snapshot and Capability ids",
    ));
    return violations;
  }

  for (let index = 1; index < context.capability_ids.length; index += 1) {
    if (context.capability_ids[index - 1]! >= context.capability_ids[index]!) {
      violations.push(violation(
        "CAPABILITY_IDS_NOT_SORTED",
        "capability_ids",
        "Trusted context Capability ids must use canonical order",
      ));
      break;
    }
  }
  for (let index = 1; index < entitlementAuthority.capability_ids.length; index += 1) {
    if (entitlementAuthority.capability_ids[index - 1]! >= entitlementAuthority.capability_ids[index]!) {
      violations.push(violation(
        "ENTITLEMENT_AUTHORITY_CAPABILITIES_NOT_CANONICAL",
        "authority.entitlement_snapshot.capability_ids",
        "Authoritative Capability ids must be unique and canonically sorted",
      ));
      break;
    }
  }

  const effectiveRef = entitlementAuthority.snapshot_ref;
  const contextRef = context.entitlement_snapshot_ref;
  if (
    contextRef.snapshot_id !== effectiveRef.snapshot_id
    || contextRef.version !== effectiveRef.version
    || contextRef.evaluated_at !== effectiveRef.evaluated_at
  ) {
    violations.push(violation(
      "ENTITLEMENT_SNAPSHOT_MISMATCH",
      "entitlement_snapshot_ref",
      "Trusted context must reference the effective entitlement snapshot",
    ));
  }
  if (
    context.capability_ids.length !== entitlementAuthority.capability_ids.length
    || context.capability_ids.some((capabilityId, index) => (
      capabilityId !== entitlementAuthority.capability_ids[index]
    ))
  ) {
    violations.push(violation(
      "ENTITLEMENT_CAPABILITIES_MISMATCH",
      "capability_ids",
      "Trusted context Capability ids must match the effective entitlement snapshot",
    ));
  }

  return violations;
}

/**
 * Validates only signed-envelope transport metadata. A successful result does
 * not establish that the signature is cryptographically valid; Identity
 * Runtime must perform signature verification before trusting the payload.
 */
export function validateSignedContextEnvelope(
  envelope: SignedTrustedRequestContext,
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  if (envelope.schema_version !== envelope.payload.schema_version) {
    violations.push(
      violation(
        "CONTEXT_SCHEMA_VERSION_MISMATCH",
        "schema_version",
        "Envelope and payload schema versions must match",
      ),
    );
  }
  if (envelope.key_id !== envelope.payload.key_id) {
    violations.push(
      violation(
        "CONTEXT_KEY_ID_MISMATCH",
        "key_id",
        "Envelope and payload key identifiers must match",
      ),
    );
  }
  if (envelope.algorithm !== "EdDSA") {
    violations.push(
      violation(
        "CONTEXT_ALGORITHM_UNSUPPORTED",
        "algorithm",
        "Signed context envelope algorithm must be EdDSA",
      ),
    );
  }

  return violations;
}
