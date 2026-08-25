import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import type { ErrorEnvelope } from "@core-agent/contracts";

export type IdentityGatewayFailureCode =
  | "INVALID_REQUEST"
  | "AUTH_INVALID"
  | "AUTH_EMAIL_UNVERIFIED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_CONFLICT"
  | "REAUTHENTICATION_REQUIRED"
  | "INTERNAL_ERROR";

export class IdentityGatewayFailure extends Error {
  readonly code: IdentityGatewayFailureCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: IdentityGatewayFailureCode, retryAfterMs?: number) {
    super(code);
    this.name = "IdentityGatewayFailure";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const publicInvalidMessage = "无法完成验证，请检查信息后重试。";

function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeCode(error: unknown): string | undefined {
  const code = ownData(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isFastifyInputFailure(error: unknown): boolean {
  const code = safeCode(error);
  const status = ownData(error, "statusCode");
  const validation = ownData(error, "validation");
  return Array.isArray(validation)
    || (typeof code === "string" && (code.startsWith("FST_ERR_CTP_") || code.startsWith("FST_ERR_VALIDATION")))
    || status === 400
    || status === 413;
}

interface ErrorDescription {
  readonly statusCode: number;
  readonly code: ErrorEnvelope["code"];
  readonly category: ErrorEnvelope["category"];
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

function describe(error: unknown): ErrorDescription {
  const code = safeCode(error);
  if (code === "SEAT_EXHAUSTED") {
    return { statusCode: 409, code: "AUTH_CONFLICT", category: "conflict", message: "可分配名额已用完。", retryable: false };
  }
  if (code === "CAPABILITY_CONFLICT") {
    return { statusCode: 409, code: "AUTH_CONFLICT", category: "conflict", message: "当前服务组合暂时无法启用，请联系支持。", retryable: false };
  }
  if (code === "SERVICE_PREPARING") {
    return { statusCode: 503, code: "SERVICE_PREPARING", category: "unavailable", message: "服务准备未完成，我们正在处理。", retryable: true };
  }
  if (code === "ENTITLEMENT_DENIED") {
    return { statusCode: 403, code: "ENTITLEMENT_DENIED", category: "authorization", message: "当前服务不可用，请联系管理员。", retryable: false };
  }
  if (code === "AUTH_RATE_LIMITED") {
    const value = ownData(error, "retryAfterMs");
    const retryAfterMs = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    return { statusCode: 429, code, category: "rate_limit", message: "尝试次数较多，请稍后再试。", retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
  if (code === "AUTH_PROVIDER_UNAVAILABLE" || code === "DEPENDENCY_UNAVAILABLE" || code === "DEPENDENCY_TIMEOUT") {
    return { statusCode: 503, code: "AUTH_PROVIDER_UNAVAILABLE", category: "unavailable", message: "登录服务暂时不可用，请稍后再试。", retryable: true };
  }
  if (code === "INVALID_REQUEST" || isFastifyInputFailure(error)) {
    return { statusCode: 400, code: "INVALID_REQUEST", category: "validation", message: "请求格式无效，请检查后重试。", retryable: false };
  }
  if (
    code === "AUTH_INVALID"
    || code === "AUTH_CALLBACK_INVALID"
    || code === "UNAUTHENTICATED"
    || code === "RESOURCE_NOT_FOUND"
  ) {
    return { statusCode: 401, code: "AUTH_INVALID", category: "authentication", message: publicInvalidMessage, retryable: false };
  }
  if (code === "AUTH_EMAIL_UNVERIFIED") {
    return { statusCode: 401, code, category: "authentication", message: publicInvalidMessage, retryable: false };
  }
  if (code === "REAUTHENTICATION_REQUIRED") {
    return { statusCode: 401, code, category: "authentication", message: publicInvalidMessage, retryable: false };
  }
  if (code === "AUTH_CONFLICT" || code === "IDEMPOTENCY_CONFLICT" || code === "RESOURCE_VERSION_CONFLICT" || code === "INVALID_STATE_TRANSITION") {
    return { statusCode: 409, code: "AUTH_CONFLICT", category: "conflict", message: publicInvalidMessage, retryable: false };
  }
  return { statusCode: 500, code: "INTERNAL_ERROR", category: "internal", message: "暂时无法完成请求，请稍后再试。", retryable: false };
}

export interface IdentityGatewayErrorMapping {
  readonly statusCode: number;
  readonly envelope: ErrorEnvelope;
}

export function mapIdentityGatewayError(
  error: unknown,
  identifiers: { readonly requestId: string; readonly traceId: string } = {
    requestId: `request_${randomUUID()}`,
    traceId: `trace_${randomUUID()}`,
  },
): IdentityGatewayErrorMapping {
  const mapped = describe(error);
  return Object.freeze({
    statusCode: mapped.statusCode,
    envelope: Object.freeze({
      schema_version: 1,
      error_id: `error_${randomUUID()}`,
      code: mapped.code,
      category: mapped.category,
      message: mapped.message,
      retryable: mapped.retryable,
      request_id: identifiers.requestId,
      trace_id: identifiers.traceId,
      ...(mapped.retryAfterMs === undefined ? {} : { retry_after_ms: mapped.retryAfterMs }),
    }),
  });
}
