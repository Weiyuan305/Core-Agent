import { createHash } from "node:crypto";

import type { SecretReference } from "../secrets/secret-store.js";

export const MAX_SUPERVISOR_FRAME_BYTES = 262_144;
export const MAX_SUPERVISOR_TIMEOUT_MS = 10_000;

export interface SupervisorEnvelopeDataV1 {
  readonly protocol_version: 1;
  readonly operation_id: string;
}

export interface ProvisionRuntimeCommandDataV1 extends SupervisorEnvelopeDataV1 {
  readonly kind: "provision";
  readonly runtime: {
    readonly tenant_id: string;
    readonly runtime_id: string;
    readonly generation: number;
    readonly image_ref: string;
    readonly platform: "linux/amd64" | "linux/arm64";
    readonly volume_ref: string;
    readonly ingress_secret_ref: SecretReference;
    readonly profiles: readonly {
      readonly profile_id: string;
      readonly hermes_profile_ref: string;
      readonly description: string;
      readonly provider_config_id: string;
      readonly provider_base_url: string;
      readonly model_id: string;
      readonly provider_secret_ref: SecretReference;
    }[];
  };
}

export interface LifecycleRuntimeCommandDataV1 extends SupervisorEnvelopeDataV1 {
  readonly kind: "inspect" | "start" | "stop" | "restart" | "delete";
  readonly tenant_id: string;
  readonly runtime_id: string;
  readonly generation: number;
}

export type SupervisorRequestDataV1 = ProvisionRuntimeCommandDataV1 | LifecycleRuntimeCommandDataV1;
export type ProvisionRuntimeCommandV1 = ProvisionRuntimeCommandDataV1 & { readonly request_hash: string };
export type LifecycleRuntimeCommandV1 = LifecycleRuntimeCommandDataV1 & { readonly request_hash: string };
export type SupervisorRequestV1 = ProvisionRuntimeCommandV1 | LifecycleRuntimeCommandV1;

export interface RuntimeObservation {
  readonly tenant_id: string;
  readonly runtime_id: string;
  readonly generation: number;
  readonly exists: boolean;
  readonly lifecycle: "created" | "running" | "stopped" | "removed";
  readonly health: "unknown" | "healthy" | "degraded" | "unhealthy";
  readonly image_ref: string;
  readonly private_origin?: string;
}

export type SupervisorResponseV1 =
  | {
    readonly protocol_version: 1;
    readonly operation_id: string;
    readonly outcome: "accepted";
    readonly observation: RuntimeObservation;
  }
  | {
    readonly protocol_version: 1;
    readonly operation_id: string;
    readonly outcome: "rejected" | "failed";
    readonly code: "SUPERVISOR_REJECTED" | "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT";
    readonly retryable: boolean;
    readonly summary: string;
  };

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const immutableImagePattern = /^[A-Za-z0-9][A-Za-z0-9./:_-]{0,511}@sha256:[a-f0-9]{64}$/;
const requestHashPattern = /^sha256:[a-f0-9]{64}$/;
const lifecycleKinds = ["inspect", "start", "stop", "restart", "delete"] as const;

function rejected(): Error {
  return new Error("SUPERVISOR_REJECTED: Invalid Runtime Supervisor metadata");
}

function exactRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw rejected();
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) {
    throw rejected();
  }
}

function exactArray(value: unknown, minimum: number, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum) {
    throw rejected();
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.slice(0, -1).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) throw rejected();
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw rejected();
}

function assertBoundedString(value: unknown, minimum: number, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw rejected();
  }
}

function assertPositiveSafeInteger(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw rejected();
}

function validateSecretReference(value: unknown, purpose: "hermes_ingress" | "model_provider"): void {
  exactRecord(value, ["reference_id", "version", "purpose"]);
  assertId(value.reference_id);
  assertPositiveSafeInteger(value.version);
  if (value.purpose !== purpose) throw rejected();
}

function validateProfile(value: unknown): void {
  exactRecord(value, [
    "profile_id", "hermes_profile_ref", "description", "provider_config_id",
    "provider_base_url", "model_id", "provider_secret_ref",
  ]);
  assertId(value.profile_id);
  assertId(value.hermes_profile_ref);
  assertBoundedString(value.description, 1, 2_000);
  assertId(value.provider_config_id);
  assertBoundedString(value.provider_base_url, 1, 2_048);
  assertBoundedString(value.model_id, 1, 255);
  validateSecretReference(value.provider_secret_ref, "model_provider");
}

function validateRuntime(value: unknown): void {
  exactRecord(value, [
    "tenant_id", "runtime_id", "generation", "image_ref", "platform", "volume_ref",
    "ingress_secret_ref", "profiles",
  ]);
  assertId(value.tenant_id);
  assertId(value.runtime_id);
  assertPositiveSafeInteger(value.generation);
  if (typeof value.image_ref !== "string" || !immutableImagePattern.test(value.image_ref)) throw rejected();
  if (value.platform !== "linux/amd64" && value.platform !== "linux/arm64") throw rejected();
  assertId(value.volume_ref);
  validateSecretReference(value.ingress_secret_ref, "hermes_ingress");
  exactArray(value.profiles, 1, 64);
  for (const profile of value.profiles) validateProfile(profile);
}

function validateRequestData(value: unknown): asserts value is SupervisorRequestDataV1 {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "kind")) throw rejected();
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "provision") {
    exactRecord(value, ["protocol_version", "operation_id", "kind", "runtime"]);
    if (value.protocol_version !== 1) throw rejected();
    assertId(value.operation_id);
    validateRuntime(value.runtime);
    return;
  }
  if (!lifecycleKinds.includes(kind as never)) throw rejected();
  exactRecord(value, ["protocol_version", "operation_id", "kind", "tenant_id", "runtime_id", "generation"]);
  if (value.protocol_version !== 1) throw rejected();
  assertId(value.operation_id);
  assertId(value.tenant_id);
  assertId(value.runtime_id);
  assertPositiveSafeInteger(value.generation);
}

function requestDataFromUnknown(value: unknown): SupervisorRequestDataV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw rejected();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== Object.keys(value).length
    || ownKeys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) throw rejected();
  const entries = Object.entries(value).filter(([key]) => key !== "request_hash");
  const data = Object.fromEntries(entries);
  validateRequestData(data);
  const expectedCount = Object.hasOwn(value, "request_hash") ? Object.keys(data).length + 1 : Object.keys(data).length;
  if (Object.keys(value).length !== expectedCount) throw rejected();
  return data;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw rejected();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw rejected();
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function canonicalSupervisorRequestHash(value: unknown): string {
  const data = requestDataFromUnknown(value);
  return `sha256:${createHash("sha256").update(canonicalJson(data), "utf8").digest("hex")}`;
}

export function validateSupervisorRequest(value: unknown): SupervisorRequestV1 {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "request_hash")) throw rejected();
  const requestHash = (value as { request_hash?: unknown }).request_hash;
  if (typeof requestHash !== "string" || !requestHashPattern.test(requestHash)) throw rejected();
  const data = requestDataFromUnknown(value);
  if (requestHash !== canonicalSupervisorRequestHash(data)) throw rejected();
  return value as SupervisorRequestV1;
}

function validateObservation(value: unknown): void {
  const required = ["tenant_id", "runtime_id", "generation", "exists", "lifecycle", "health", "image_ref"];
  const keys = typeof value === "object" && value !== null && Object.hasOwn(value, "private_origin")
    ? [...required, "private_origin"]
    : required;
  exactRecord(value, keys);
  assertId(value.tenant_id);
  assertId(value.runtime_id);
  assertPositiveSafeInteger(value.generation);
  if (typeof value.exists !== "boolean") throw rejected();
  if (!["created", "running", "stopped", "removed"].includes(value.lifecycle as string)) throw rejected();
  if (!["unknown", "healthy", "degraded", "unhealthy"].includes(value.health as string)) throw rejected();
  if (typeof value.image_ref !== "string" || !immutableImagePattern.test(value.image_ref)) throw rejected();
  if (Object.hasOwn(value, "private_origin")) assertBoundedString(value.private_origin, 1, 2_048);
}

export function validateSupervisorResponse(value: unknown): SupervisorResponseV1 {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "outcome")) throw rejected();
  const outcome = (value as { outcome?: unknown }).outcome;
  if (outcome === "accepted") {
    exactRecord(value, ["protocol_version", "operation_id", "outcome", "observation"]);
    if (value.protocol_version !== 1) throw rejected();
    assertId(value.operation_id);
    validateObservation(value.observation);
  } else {
    exactRecord(value, ["protocol_version", "operation_id", "outcome", "code", "retryable", "summary"]);
    if (value.protocol_version !== 1 || (outcome !== "rejected" && outcome !== "failed")) throw rejected();
    assertId(value.operation_id);
    if (!["SUPERVISOR_REJECTED", "DEPENDENCY_UNAVAILABLE", "DEPENDENCY_TIMEOUT"].includes(value.code as string)) throw rejected();
    if (typeof value.retryable !== "boolean") throw rejected();
    assertBoundedString(value.summary, 1, 1_000);
  }
  return value as SupervisorResponseV1;
}

export function encodeSupervisorFrame(value: unknown): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(value), "utf8");
  } catch {
    throw rejected();
  }
  if (payload.length === 0 || payload.length > MAX_SUPERVISOR_FRAME_BYTES) throw rejected();
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeSupervisorFrame(frame: Uint8Array): unknown {
  if (frame.byteLength < 4) throw rejected();
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = bytes.readUInt32BE(0);
  if (length === 0 || length > MAX_SUPERVISOR_FRAME_BYTES || bytes.length !== length + 4) throw rejected();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4));
  } catch {
    throw rejected();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw rejected();
  }
}
