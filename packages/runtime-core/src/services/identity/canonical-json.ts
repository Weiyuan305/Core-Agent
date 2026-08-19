import { types as utilTypes } from "node:util";

import { DomainError } from "../../domain/idempotency.js";

function invalidCanonicalJson(): never {
  throw new DomainError("INVALID_REQUEST", "Trusted context canonical JSON is invalid");
}

function canonicalArray(value: readonly unknown[]): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) invalidCanonicalJson();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol") || keys.length !== value.length + 1 || !keys.includes("length")) {
    invalidCanonicalJson();
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalidCanonicalJson();
    items.push(canonicalValue(descriptor.value));
  }
  return `[${items.join(",")}]`;
}

function canonicalObject(value: object): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidCanonicalJson();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) invalidCanonicalJson();
  const stringKeys = keys as string[];
  stringKeys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const fields: string[] = [];
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalidCanonicalJson();
    fields.push(`${JSON.stringify(key)}:${canonicalValue(descriptor.value)}`);
  }
  return `{${fields.join(",")}}`;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalidCanonicalJson();
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || utilTypes.isProxy(value)) invalidCanonicalJson();
  return Array.isArray(value) ? canonicalArray(value) : canonicalObject(value);
}

/** Strict deterministic JSON for signatures. It never evaluates accessors or Proxy traps. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}
