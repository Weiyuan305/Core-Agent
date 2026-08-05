import { createHash } from "node:crypto";

import type { TenantTransaction } from "../db/transaction.js";

export type StableDomainErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "RESOURCE_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "RESOURCE_VERSION_CONFLICT"
  | "INVALID_STATE_TRANSITION"
  | "RUNTIME_NOT_READY"
  | "SUPERVISOR_REJECTED"
  | "DEPENDENCY_UNAVAILABLE"
  | "DEPENDENCY_TIMEOUT"
  | "INTERNAL_ERROR";

export class DomainError extends Error {
  public constructor(
    public readonly code: StableDomainErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(`${code}: ${message}`);
    this.name = "DomainError";
  }
}

export interface DependencyFailure {
  code: "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT" | "SUPERVISOR_REJECTED";
  retryable: boolean;
  summary: string;
}

const secretKeyPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|token)/i;

function isOpaqueSecretReferenceKey(key: string): boolean {
  return key === "ingress_secret_ref";
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DomainError("INVALID_REQUEST", "Payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new DomainError("INVALID_REQUEST", "Payload contains a sparse array");
      items.push(canonicalize(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value !== "object") throw new DomainError("INVALID_REQUEST", "Payload contains an unsupported value");

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DomainError("INVALID_REQUEST", "Payload contains a non-plain object");
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return `{${entries.map(([key, item]) => {
    if (secretKeyPattern.test(key) && !isOpaqueSecretReferenceKey(key)) {
      throw new DomainError("INVALID_REQUEST", "Payload contains a secret-shaped key");
    }
    if (item === undefined) throw new DomainError("INVALID_REQUEST", "Payload contains undefined");
    return `${JSON.stringify(key)}:${canonicalize(item)}`;
  }).join(",")}}`;
}

export function canonicalPayloadHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export type IdempotencyAdmission<T> =
  | { kind: "acquired"; recordId: string }
  | { kind: "replay"; resultRef: string; response: T }
  | { kind: "in_progress" };

export async function beginIdempotentCommand<T>(
  context: TenantTransaction,
  input: { key: string; payloadHash: string; operation: string; now: Date; expiresAt: Date },
): Promise<IdempotencyAdmission<T>> {
  if (input.key.length < 1 || input.key.length > 255) throw new DomainError("INVALID_REQUEST", "Idempotency key is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.payloadHash)) throw new DomainError("INVALID_REQUEST", "Payload hash is invalid");
  if (input.operation.length < 1 || input.operation.length > 200) throw new DomainError("INVALID_REQUEST", "Operation is invalid");
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new DomainError("INVALID_REQUEST", "Admission timestamp is invalid");
  }
  if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= input.now.getTime()) {
    throw new DomainError("INVALID_REQUEST", "Expiry is invalid");
  }
  const inserted = await context.trx.insertInto("idempotency_records").values({
    tenant_id: context.tenantId,
    idempotency_key: input.key,
    payload_hash: input.payloadHash,
    operation: input.operation,
    status: "in_progress",
    result_ref: null,
    response_json: null,
    expires_at: input.expiresAt,
    created_at: input.now,
    updated_at: input.now,
  }).onConflict((conflict) => conflict.columns(["tenant_id", "idempotency_key"]).doNothing())
    .returning("idempotency_key").executeTakeFirst();
  if (inserted !== undefined) return { kind: "acquired", recordId: input.key };

  const existing = await context.trx.selectFrom("idempotency_records")
    .select(["payload_hash", "operation", "status", "result_ref", "response_json"])
    .where("tenant_id", "=", context.tenantId)
    .where("idempotency_key", "=", input.key)
    .forUpdate().executeTakeFirstOrThrow();
  if (existing.payload_hash !== input.payloadHash || existing.operation !== input.operation) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key payload mismatch");
  }
  if (existing.status === "completed") {
    if (existing.response_json === null) throw new DomainError("INTERNAL_ERROR", "Completed idempotency record has no response");
    if (existing.result_ref === null) throw new DomainError("INTERNAL_ERROR", "Completed idempotency record has no result reference");
    return { kind: "replay", resultRef: existing.result_ref, response: existing.response_json as T };
  }
  return { kind: "in_progress" };
}

export async function completeIdempotentCommand(
  context: TenantTransaction,
  input: {
    key: string;
    payloadHash: string;
    operation: string;
    resultRef: string;
    response: unknown;
    updatedAt: Date;
  },
): Promise<void> {
  if (input.key.length < 1 || input.key.length > 255) throw new DomainError("INVALID_REQUEST", "Idempotency key is invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.payloadHash)) throw new DomainError("INVALID_REQUEST", "Payload hash is invalid");
  if (input.operation.length < 1 || input.operation.length > 200) throw new DomainError("INVALID_REQUEST", "Operation is invalid");
  if (input.resultRef.length < 1 || input.resultRef.length > 500) throw new DomainError("INVALID_REQUEST", "Result reference is invalid");
  if (!(input.updatedAt instanceof Date) || !Number.isFinite(input.updatedAt.getTime())) {
    throw new DomainError("INVALID_REQUEST", "Completion timestamp is invalid");
  }
  const completed = await context.trx.updateTable("idempotency_records").set({
    status: "completed",
    result_ref: input.resultRef,
    response_json: input.response,
    updated_at: input.updatedAt,
  }).where("tenant_id", "=", context.tenantId)
    .where("idempotency_key", "=", input.key)
    .where("payload_hash", "=", input.payloadHash)
    .where("operation", "=", input.operation)
    .where("status", "=", "in_progress")
    .executeTakeFirst();
  if (Number(completed.numUpdatedRows) !== 1) {
    throw new DomainError("INTERNAL_ERROR", "Idempotency completion did not match the admitted command");
  }
}
