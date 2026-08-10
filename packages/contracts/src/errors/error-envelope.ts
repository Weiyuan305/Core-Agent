import Type, { type Static } from "typebox";

import {
  OpaqueIdSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
} from "../common/primitives.js";

export const ErrorCategorySchema = Type.Union([
  Type.Literal("validation"),
  Type.Literal("authentication"),
  Type.Literal("authorization"),
  Type.Literal("conflict"),
  Type.Literal("rate_limit"),
  Type.Literal("dependency"),
  Type.Literal("unavailable"),
  Type.Literal("timeout"),
  Type.Literal("internal"),
]);

export const StableErrorCodeSchema = Type.Union([
  Type.Literal("INVALID_REQUEST"),
  Type.Literal("UNAUTHENTICATED"),
  Type.Literal("RESOURCE_NOT_FOUND"),
  Type.Literal("RESOURCE_VERSION_CONFLICT"),
  Type.Literal("INVALID_STATE_TRANSITION"),
  Type.Literal("RUNTIME_NOT_READY"),
  Type.Literal("SUPERVISOR_REJECTED"),
  Type.Literal("TENANT_SCOPE_MISMATCH"),
  Type.Literal("PROFILE_NOT_ACTIVE"),
  Type.Literal("CONTEXT_EXPIRED"),
  Type.Literal("ENTITLEMENT_DENIED"),
  Type.Literal("APPROVAL_REQUIRED"),
  Type.Literal("IDEMPOTENCY_CONFLICT"),
  Type.Literal("DEPENDENCY_UNAVAILABLE"),
  Type.Literal("DEPENDENCY_TIMEOUT"),
  Type.Literal("INTERNAL_ERROR"),
  Type.Literal("AUTH_INVALID"),
  Type.Literal("AUTH_EMAIL_UNVERIFIED"),
  Type.Literal("AUTH_RATE_LIMITED"),
  Type.Literal("AUTH_PROVIDER_UNAVAILABLE"),
  Type.Literal("AUTH_CALLBACK_INVALID"),
  Type.Literal("AUTH_CONFLICT"),
  Type.Literal("REAUTHENTICATION_REQUIRED"),
], { "x-extensible-union": true });

const FieldErrorSchema = Type.Object(
  {
    path: OpaqueIdSchema,
    code: OpaqueIdSchema,
    message: Type.String({ maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const ErrorEnvelopeSchema = Type.Object(
  {
    schema_version: SchemaVersionSchema,
    error_id: OpaqueIdSchema,
    code: StableErrorCodeSchema,
    category: ErrorCategorySchema,
    message: Type.String({ maxLength: 2000 }),
    retryable: Type.Boolean(),
    request_id: OpaqueIdSchema,
    trace_id: OpaqueIdSchema,
    retry_after_ms: Type.Optional(Type.Integer({ minimum: 0 })),
    field_errors: Type.Optional(Type.Array(FieldErrorSchema)),
    resource_type: Type.Optional(OpaqueIdSchema),
    resource_id: Type.Optional(OpaqueIdSchema),
    resource_version: Type.Optional(ResourceVersionSchema),
    current_state: Type.Optional(OpaqueIdSchema),
  },
  { additionalProperties: false, $id: "core-agent://v1/error-envelope" },
);

export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;
