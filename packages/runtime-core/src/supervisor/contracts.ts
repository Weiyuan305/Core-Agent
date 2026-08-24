import { createHash } from "node:crypto";

import {
  validateCapabilityRuntimeManifest,
  type CapabilityRuntimeManifestV1,
} from "../runtime/capability-manifest.js";
import type { SecretReference } from "../secrets/secret-store.js";

export const MAX_SUPERVISOR_FRAME_BYTES = 262_144;
export const SUPERVISOR_DEADLINE_BUDGET = Object.freeze({
  initializerTimeoutMs: 25_000,
  verifierTimeoutMs: 25_000,
  reconciliationTimeoutMs: 10_000,
  effectOverheadMs: 10_000,
  effectTimeoutMs: 120_000,
  admissionTimeoutMs: 1_000,
  operationTimeoutMs: 150_000,
  cancellationSettlementTimeoutMs: 20_000,
  clientTimeoutMs: 180_000,
} as const);
export const MAX_SUPERVISOR_TIMEOUT_MS = SUPERVISOR_DEADLINE_BUDGET.clientTimeoutMs;
export const REMOVED_RUNTIME_IMAGE_REF = `managed/removed@sha256:${"0".repeat(64)}` as const;

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

export interface SupervisorEnvelopeDataV2 {
  readonly protocol_version: 2;
  readonly operation_id: string;
}

export interface CapabilityProvisionRuntimeCommandDataV2 extends SupervisorEnvelopeDataV2 {
  readonly kind: "provision";
  readonly runtime: ProvisionRuntimeCommandDataV1["runtime"];
  readonly capability_manifest: CapabilityRuntimeManifestV1;
  readonly capability_manifest_digest: `sha256:${string}`;
}

export interface CapabilityInspectRuntimeCommandDataV2 extends SupervisorEnvelopeDataV2 {
  readonly kind: "inspect";
  readonly tenant_id: string;
  readonly runtime_id: string;
  readonly generation: number;
  readonly capability_manifest_digest: `sha256:${string}`;
}

export type SupervisorRequestDataV2 = CapabilityProvisionRuntimeCommandDataV2 | CapabilityInspectRuntimeCommandDataV2;
export type CapabilityProvisionRuntimeCommandV2 = CapabilityProvisionRuntimeCommandDataV2 & { readonly request_hash: string };
export type CapabilityInspectRuntimeCommandV2 = CapabilityInspectRuntimeCommandDataV2 & { readonly request_hash: string };
export type SupervisorRequestV2 = CapabilityProvisionRuntimeCommandV2 | CapabilityInspectRuntimeCommandV2;
export type SupervisorRequest = SupervisorRequestV1 | SupervisorRequestV2;

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

export interface CapabilityRuntimeObservation extends RuntimeObservation {
  readonly profile_ids: readonly string[];
  readonly capability_manifest_digest: `sha256:${string}`;
}

export type SupervisorResponseV2 =
  | {
    readonly protocol_version: 2;
    readonly operation_id: string;
    readonly outcome: "accepted";
    readonly observation: CapabilityRuntimeObservation;
  }
  | {
    readonly protocol_version: 2;
    readonly operation_id: string;
    readonly outcome: "rejected" | "failed";
    readonly code: "SUPERVISOR_REJECTED" | "DEPENDENCY_UNAVAILABLE" | "DEPENDENCY_TIMEOUT";
    readonly retryable: boolean;
    readonly summary: string;
  };

export type SupervisorResponse = SupervisorResponseV1 | SupervisorResponseV2;

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

function ownEnumerableDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw rejected();
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw rejected();
  return descriptor.value;
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

function validateRequestData(value: unknown): asserts value is SupervisorRequestDataV1 | SupervisorRequestDataV2 {
  const kind = ownEnumerableDataValue(value, "kind");
  if (kind === "provision") {
    const protocolVersion = ownEnumerableDataValue(value, "protocol_version");
    const keys = protocolVersion === 2
      ? ["protocol_version", "operation_id", "kind", "runtime", "capability_manifest", "capability_manifest_digest"]
      : ["protocol_version", "operation_id", "kind", "runtime"];
    exactRecord(value, keys);
    if (value.protocol_version !== 1 && value.protocol_version !== 2) throw rejected();
    assertId(value.operation_id);
    const runtime = value.runtime;
    validateRuntime(runtime);
    if (value.protocol_version === 2) {
      let manifest: CapabilityRuntimeManifestV1;
      try {
        manifest = validateCapabilityRuntimeManifest(value.capability_manifest, value.capability_manifest_digest);
      } catch {
        throw rejected();
      }
      if (
        manifest.tenant_id !== (runtime as ProvisionRuntimeCommandDataV1["runtime"]).tenant_id
        || manifest.runtime_generation !== (runtime as ProvisionRuntimeCommandDataV1["runtime"]).generation
      ) throw rejected();
    }
    return;
  }
  if (!lifecycleKinds.includes(kind as never)) throw rejected();
  const protocolVersion = ownEnumerableDataValue(value, "protocol_version");
  const keys = protocolVersion === 2
    ? ["protocol_version", "operation_id", "kind", "tenant_id", "runtime_id", "generation", "capability_manifest_digest"]
    : ["protocol_version", "operation_id", "kind", "tenant_id", "runtime_id", "generation"];
  exactRecord(value, keys);
  if (value.protocol_version !== 1 && value.protocol_version !== 2) throw rejected();
  if (value.protocol_version === 2 && kind !== "inspect") throw rejected();
  assertId(value.operation_id);
  assertId(value.tenant_id);
  assertId(value.runtime_id);
  assertPositiveSafeInteger(value.generation);
  if (value.protocol_version === 2 && (
    typeof value.capability_manifest_digest !== "string"
    || !requestHashPattern.test(value.capability_manifest_digest)
  )) throw rejected();
}

function requestDataFromUnknown(value: unknown): SupervisorRequestDataV1 | SupervisorRequestDataV2 {
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

export function validateSupervisorRequest(value: unknown): SupervisorRequest {
  const requestHash = ownEnumerableDataValue(value, "request_hash");
  if (typeof requestHash !== "string" || !requestHashPattern.test(requestHash)) throw rejected();
  const data = requestDataFromUnknown(value);
  if (requestHash !== canonicalSupervisorRequestHash(data)) throw rejected();
  return value as SupervisorRequest;
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

function validateCapabilityObservation(value: unknown): void {
  const required = [
    "tenant_id", "runtime_id", "generation", "exists", "lifecycle", "health", "image_ref",
    "profile_ids", "capability_manifest_digest",
  ];
  const keys = typeof value === "object" && value !== null && Object.hasOwn(value, "private_origin")
    ? [...required, "private_origin"]
    : required;
  exactRecord(value, keys);
  validateObservation(Object.fromEntries(required.slice(0, 7).map((key) => [key, ownEnumerableDataValue(value, key)]).concat(
    Object.hasOwn(value, "private_origin") ? [["private_origin", ownEnumerableDataValue(value, "private_origin")]] : [],
  )));
  exactArray(value.profile_ids, value.exists === false ? 0 : 1, 64);
  const seen = new Set<string>();
  for (const profileId of value.profile_ids) {
    assertId(profileId);
    if (seen.has(profileId)) throw rejected();
    seen.add(profileId);
  }
  if (typeof value.capability_manifest_digest !== "string" || !requestHashPattern.test(value.capability_manifest_digest)) throw rejected();
}

export function validateSupervisorResponse(value: unknown): SupervisorResponse {
  const outcome = ownEnumerableDataValue(value, "outcome");
  const protocolVersion = ownEnumerableDataValue(value, "protocol_version");
  if (outcome === "accepted") {
    exactRecord(value, ["protocol_version", "operation_id", "outcome", "observation"]);
    if (protocolVersion !== 1 && protocolVersion !== 2) throw rejected();
    assertId(value.operation_id);
    if (protocolVersion === 1) validateObservation(value.observation);
    else validateCapabilityObservation(value.observation);
  } else {
    exactRecord(value, ["protocol_version", "operation_id", "outcome", "code", "retryable", "summary"]);
    if ((protocolVersion !== 1 && protocolVersion !== 2) || (outcome !== "rejected" && outcome !== "failed")) throw rejected();
    assertId(value.operation_id);
    if (!["SUPERVISOR_REJECTED", "DEPENDENCY_UNAVAILABLE", "DEPENDENCY_TIMEOUT"].includes(value.code as string)) throw rejected();
    if (typeof value.retryable !== "boolean") throw rejected();
    assertBoundedString(value.summary, 1, 1_000);
  }
  return value as SupervisorResponse;
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
