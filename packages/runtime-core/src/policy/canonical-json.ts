import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { CORE_AGENT_POLICY_PROOF_FIELD } from "@core-agent/contracts";

const limits = Object.freeze({ bytes: 32 * 1024, depth: 16, nodes: 512, properties: 128, arrayItems: 128, stringBytes: 8 * 1024 });
function invalid(): never { throw new Error("Tool arguments are invalid"); }
const compareUtf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

interface Budget { nodes: number; properties: number; ancestors: Set<object> }

function copy(value: unknown, budget: Budget, depth: number, topLevel: boolean): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > limits.stringBytes) invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) invalid();
  if (depth > limits.depth || utilTypes.isProxy(value)) invalid();
  if (budget.ancestors.has(value)) invalid();
  budget.nodes += 1;
  if (budget.nodes > limits.nodes) invalid();
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > limits.arrayItems) invalid();
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string") || keys.length !== value.length + 1 || !keys.includes("length")) invalid();
      return value.map((_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) invalid();
        if (!("value" in descriptor) || !descriptor.enumerable) invalid();
        return copy(descriptor.value, budget, depth + 1, false);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string") || keys.length > limits.properties) invalid();
    budget.properties += keys.length;
    if (budget.properties > limits.properties || (topLevel && keys.includes(CORE_AGENT_POLICY_PROOF_FIELD))) invalid();
    const output: Record<string, unknown> = Object.create(null);
    for (const key of (keys as string[]).sort(compareUtf8)) {
      if (key.includes("\0") || Buffer.byteLength(key, "utf8") > 255) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) invalid();
      if (!("value" in descriptor) || !descriptor.enumerable) invalid();
      output[key] = copy(descriptor.value, budget, depth + 1, false);
    }
    return output;
  } finally {
    budget.ancestors.delete(value);
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

export interface CanonicalToolArguments {
  readonly value: Readonly<Record<string, unknown>>;
  readonly json: string;
  readonly hash: string;
}

export function canonicalizeToolArguments(value: unknown): CanonicalToolArguments {
  const copied = copy(value, { nodes: 0, properties: 0, ancestors: new Set() }, 0, true);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) invalid();
  const json = JSON.stringify(copied);
  if (Buffer.byteLength(json, "utf8") > limits.bytes) invalid();
  deepFreeze(copied);
  return Object.freeze({
    value: copied as Readonly<Record<string, unknown>>,
    json,
    hash: `sha256:${createHash("sha256").update("core-agent-policy-arguments-v1\0").update(json).digest("hex")}`,
  });
}
