import { types as utilTypes } from "node:util";

import type { TSchema } from "typebox";
import Schema from "typebox/schema";

import { canonicalPayloadHash, DomainError } from "../../domain/idempotency.js";

const maximumDepth = 24;
const maximumNodes = 512;
const maximumUtf8Bytes = 64 * 1_024;

function invalid(): never {
  throw new DomainError("INVALID_REQUEST", "Entitlement command does not satisfy its contract");
}

function copyOwnData(
  value: unknown,
  budget = { nodes: 0, bytes: 0, ancestors: new Set<object>() },
  depth = 0,
): unknown {
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value, "utf8");
    if (budget.bytes > maximumUtf8Bytes) invalid();
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object" || utilTypes.isProxy(value) || depth > maximumDepth) invalid();
  if (budget.ancestors.has(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || value.length > 256) invalid();
  } else if (prototype !== Object.prototype && prototype !== null) invalid();
  budget.nodes += 1;
  if (budget.nodes > maximumNodes) invalid();
  budget.ancestors.add(value);

  let copied: unknown;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol") || keys.length !== value.length + 1 || !keys.includes("length")) invalid();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
      result.push(copyOwnData(descriptor.value, budget, depth + 1));
    }
    copied = result;
  } else {
    const result: Record<string, unknown> = Object.create(null);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64 || keys.some((key) => typeof key !== "string")) invalid();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
      budget.bytes += Buffer.byteLength(key, "utf8");
      if (budget.bytes > maximumUtf8Bytes) invalid();
      result[key] = copyOwnData(descriptor.value, budget, depth + 1);
    }
    copied = result;
  }
  budget.ancestors.delete(value);
  return copied;
}

/** Copies accessor-free wire data, validates the public schema, and binds its exact canonical payload hash. */
export function validateEntitlementCommand<T>(schema: TSchema, value: unknown): T {
  const copied = copyOwnData(value);
  if (!Schema.Check(schema, copied) || copied === null || typeof copied !== "object" || Array.isArray(copied)) invalid();
  const record = copied as Record<string, unknown>;
  const received = record.payload_hash;
  if (typeof received !== "string") invalid();
  const { payload_hash: _payloadHash, ...payload } = record;
  if (received !== canonicalPayloadHash(payload)) invalid();
  return Object.freeze(copied) as T;
}

export function assertCommandContext(context: {
  readonly performingActorId: string;
  readonly performingAuthSubjectId: string;
  readonly performingSessionId: string;
  readonly requestId: string;
  readonly traceId: string;
}): void {
  for (const value of Object.values(context)) {
    if (typeof value !== "string" || value.length < 1 || value.length > 255 || value.includes("\0")) invalid();
  }
}
