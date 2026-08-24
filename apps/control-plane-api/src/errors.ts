import { randomUUID } from "node:crypto";

import {
  ErrorEnvelopeSchema,
  type ErrorEnvelope,
} from "@core-agent/contracts";
import {
  DomainError,
  type Redactor,
  type StableDomainErrorCode,
} from "@core-agent/runtime-core";
import Schema from "typebox/schema";

export type StableApiErrorCode = StableDomainErrorCode;

const HTTP_BY_CODE: Readonly<Record<StableApiErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  RESOURCE_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  RESOURCE_VERSION_CONFLICT: 409,
  CAPABILITY_CONFLICT: 409,
  ENTITLEMENT_DENIED: 403,
  SEAT_EXHAUSTED: 409,
  SERVICE_PREPARING: 503,
  INVALID_STATE_TRANSITION: 409,
  RUNTIME_NOT_READY: 409,
  SUPERVISOR_REJECTED: 409,
  DEPENDENCY_UNAVAILABLE: 503,
  DEPENDENCY_TIMEOUT: 504,
  INTERNAL_ERROR: 500,
};

const CATEGORY_BY_CODE: Readonly<Record<StableApiErrorCode, ErrorEnvelope["category"]>> = {
  INVALID_REQUEST: "validation",
  UNAUTHENTICATED: "authentication",
  RESOURCE_NOT_FOUND: "authorization",
  IDEMPOTENCY_CONFLICT: "conflict",
  RESOURCE_VERSION_CONFLICT: "conflict",
  CAPABILITY_CONFLICT: "conflict",
  ENTITLEMENT_DENIED: "authorization",
  SEAT_EXHAUSTED: "conflict",
  SERVICE_PREPARING: "unavailable",
  INVALID_STATE_TRANSITION: "conflict",
  RUNTIME_NOT_READY: "conflict",
  SUPERVISOR_REJECTED: "conflict",
  DEPENDENCY_UNAVAILABLE: "dependency",
  DEPENDENCY_TIMEOUT: "timeout",
  INTERNAL_ERROR: "internal",
};

const PUBLIC_MESSAGE_BY_CODE: Readonly<Record<StableApiErrorCode, string>> = {
  INVALID_REQUEST: "The request is invalid.",
  UNAUTHENTICATED: "Authentication is required.",
  RESOURCE_NOT_FOUND: "The requested resource was not found.",
  IDEMPOTENCY_CONFLICT: "The idempotency key conflicts with an earlier request.",
  RESOURCE_VERSION_CONFLICT: "The resource version has changed.",
  CAPABILITY_CONFLICT: "The requested capabilities conflict.",
  ENTITLEMENT_DENIED: "Current entitlement authority denied the request.",
  SEAT_EXHAUSTED: "No entitlement seat is available.",
  SERVICE_PREPARING: "The capability service is preparing.",
  INVALID_STATE_TRANSITION: "The requested state transition is not allowed.",
  RUNTIME_NOT_READY: "The runtime is not ready.",
  SUPERVISOR_REJECTED: "The runtime operation was rejected.",
  DEPENDENCY_UNAVAILABLE: "A required dependency is unavailable.",
  DEPENDENCY_TIMEOUT: "A required dependency timed out.",
  INTERNAL_ERROR: "An internal error occurred.",
};

const envelopeValidator = Schema.Compile(ErrorEnvelopeSchema);

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isFastifyInvalidRequest(error: unknown): boolean {
  const code = ownDataValue(error, "code");
  const statusCode = ownDataValue(error, "statusCode");
  const validation = ownDataValue(error, "validation");
  return Array.isArray(validation)
    || (typeof code === "string" && (
      code.startsWith("FST_ERR_CTP_")
      || code.startsWith("FST_ERR_VALIDATION")
    ))
    || statusCode === 400
    || statusCode === 413;
}

export interface ApiErrorMappingContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly redactor: Redactor;
}

export interface MappedApiError {
  readonly statusCode: number;
  readonly envelope: ErrorEnvelope;
  readonly internalError?: Readonly<Record<string, unknown>>;
}

function safeInternalError(error: unknown, redactor: Redactor): Readonly<Record<string, unknown>> {
  if (!(error instanceof Error)) return Object.freeze({ type: "UnknownError" });
  const message = ownDataValue(error, "message");
  const stack = ownDataValue(error, "stack");
  return Object.freeze(redactor.redact({
    type: "Error",
    message: typeof message === "string" ? message.slice(0, 2_000) : "Unknown internal error",
    ...(typeof stack === "string" ? { stack: stack.slice(0, 8_000) } : {}),
  }));
}

export function mapApiError(error: unknown, context: ApiErrorMappingContext): MappedApiError {
  let code: StableApiErrorCode = "INTERNAL_ERROR";
  let retryable = false;
  try {
    if (error instanceof DomainError) {
      code = error.code;
      retryable = (code === "DEPENDENCY_UNAVAILABLE" || code === "DEPENDENCY_TIMEOUT" || code === "SERVICE_PREPARING")
        && error.retryable === true;
    } else if (isFastifyInvalidRequest(error)) {
      code = "INVALID_REQUEST";
    }
  } catch {
    code = "INTERNAL_ERROR";
  }

  const envelope: ErrorEnvelope = {
    schema_version: 1,
    error_id: `error_${randomUUID()}`,
    code,
    category: CATEGORY_BY_CODE[code],
    message: PUBLIC_MESSAGE_BY_CODE[code],
    retryable,
    request_id: context.requestId,
    trace_id: context.traceId,
  };
  if (!envelopeValidator.Check(envelope)) throw new Error("Internal ErrorEnvelope construction failed");
  return code === "INTERNAL_ERROR"
    ? { statusCode: HTTP_BY_CODE[code], envelope, internalError: safeInternalError(error, context.redactor) }
    : { statusCode: HTTP_BY_CODE[code], envelope };
}
