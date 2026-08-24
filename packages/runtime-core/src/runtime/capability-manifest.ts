import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

export const MAX_CAPABILITY_RUNTIME_MANIFEST_ENTRIES = 256;
export const MAX_CAPABILITY_RUNTIME_MANIFEST_BYTES = 65_536;

export type CapabilityRuntimeManifestKind = "mcp" | "skill" | "policy";

export interface CapabilityRuntimeManifestV1 {
  readonly schema_version: 1;
  readonly tenant_id: string;
  readonly snapshot_id: string;
  readonly snapshot_version: number;
  readonly runtime_generation: number;
  readonly capabilities: readonly {
    readonly capability_id: string;
    readonly capability_version_id: string;
    readonly version: string;
    readonly kind: CapabilityRuntimeManifestKind;
  }[];
}

export interface CapabilityRuntimeManifestInput {
  readonly tenantId: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly runtimeGeneration: number;
  readonly capabilities: readonly {
    readonly capabilityId: string;
    readonly capabilityVersionId: string;
    readonly version: string;
    readonly kind: CapabilityRuntimeManifestKind;
    readonly riskClass: "read" | "draft_write" | "external_write" | "privileged";
  }[];
}

export interface CreatedCapabilityRuntimeManifest {
  readonly manifest: CapabilityRuntimeManifestV1;
  readonly canonicalJson: string;
  readonly digest: `sha256:${string}`;
}

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const semanticVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function invalid(): Error {
  return new Error("CAPABILITY_MANIFEST_INVALID: Invalid Capability Runtime manifest");
}

function ownPlainRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) throw invalid();
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== keys.length
      || !keys.every((key) => Object.hasOwn(value, key))
      || actual.some((key) => typeof key !== "string" || !keys.includes(key))
      || keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })
    ) throw invalid();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CAPABILITY_MANIFEST_INVALID:")) throw error;
    throw invalid();
  }
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw invalid();
  return descriptor.value;
}

function exactArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) throw invalid();
  try {
    if (
      Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1
      || value.length > MAX_CAPABILITY_RUNTIME_MANIFEST_ENTRIES
    ) throw invalid();
    const keys = Reflect.ownKeys(value);
    const expected = [...Array.from({ length: value.length }, (_, index) => String(index)), "length"];
    if (
      keys.length !== expected.length
      || keys.some((key) => typeof key !== "string" || !expected.includes(key))
      || expected.slice(0, -1).some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })
    ) throw invalid();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CAPABILITY_MANIFEST_INVALID:")) throw error;
    throw invalid();
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw invalid();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

function version(value: unknown): string {
  if (typeof value !== "string" || value.length > 255 || !semanticVersionPattern.test(value)) throw invalid();
  return value;
}

function kind(value: unknown): CapabilityRuntimeManifestKind {
  if (value !== "mcp" && value !== "skill" && value !== "policy") throw invalid();
  return value;
}

function asciiCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): CapabilityRuntimeManifestV1 {
  ownPlainRecord(value, [
    "schema_version", "tenant_id", "snapshot_id", "snapshot_version", "runtime_generation", "capabilities",
  ]);
  if (ownData(value, "schema_version") !== 1) throw invalid();
  const tenantId = identifier(ownData(value, "tenant_id"));
  const snapshotId = identifier(ownData(value, "snapshot_id"));
  const snapshotVersion = positiveInteger(ownData(value, "snapshot_version"));
  const runtimeGeneration = positiveInteger(ownData(value, "runtime_generation"));
  const capabilitiesValue = ownData(value, "capabilities");
  exactArray(capabilitiesValue);
  const capabilities = capabilitiesValue.map((entry) => {
    ownPlainRecord(entry, ["capability_id", "capability_version_id", "version", "kind"]);
    return Object.freeze({
      capability_id: identifier(ownData(entry, "capability_id")),
      capability_version_id: identifier(ownData(entry, "capability_version_id")),
      version: version(ownData(entry, "version")),
      kind: kind(ownData(entry, "kind")),
    });
  });
  const sorted = [...capabilities].sort((left, right) => (
    asciiCompare(left.capability_id, right.capability_id)
    || asciiCompare(left.capability_version_id, right.capability_version_id)
    || asciiCompare(left.version, right.version)
    || asciiCompare(left.kind, right.kind)
  ));
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const previous = sorted[index - 1];
    if (previous !== undefined) {
      if (previous.capability_id === current.capability_id) throw invalid();
      if (capabilities[index] !== undefined && (
        capabilities[index]!.capability_id !== current.capability_id
        || capabilities[index]!.capability_version_id !== current.capability_version_id
        || capabilities[index]!.version !== current.version
        || capabilities[index]!.kind !== current.kind
      )) throw invalid();
    }
  }
  const manifest = Object.freeze({
    schema_version: 1 as const,
    tenant_id: tenantId,
    snapshot_id: snapshotId,
    snapshot_version: snapshotVersion,
    runtime_generation: runtimeGeneration,
    capabilities: Object.freeze(sorted),
  });
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > MAX_CAPABILITY_RUNTIME_MANIFEST_BYTES) throw invalid();
  return manifest;
}

export function createCapabilityRuntimeManifest(input: CapabilityRuntimeManifestInput): CreatedCapabilityRuntimeManifest {
  ownPlainRecord(input, ["tenantId", "snapshotId", "snapshotVersion", "runtimeGeneration", "capabilities"]);
  const capabilitiesValue = ownData(input, "capabilities");
  exactArray(capabilitiesValue);
  const unique = new Map<string, {
    capability_id: string;
    capability_version_id: string;
    version: string;
    kind: CapabilityRuntimeManifestKind;
  }>();
  for (const entry of capabilitiesValue) {
    ownPlainRecord(entry, ["capabilityId", "capabilityVersionId", "version", "kind", "riskClass"]);
    const capabilityId = identifier(ownData(entry, "capabilityId"));
    const capabilityVersionId = identifier(ownData(entry, "capabilityVersionId"));
    const capabilityVersion = version(ownData(entry, "version"));
    const capabilityKind = kind(ownData(entry, "kind"));
    const riskClass = ownData(entry, "riskClass");
    if (riskClass !== "read" && riskClass !== "draft_write") throw invalid();
    const existing = unique.get(capabilityId);
    if (existing !== undefined && (
      existing.capability_version_id !== capabilityVersionId
      || existing.version !== capabilityVersion
      || existing.kind !== capabilityKind
    )) throw invalid();
    unique.set(capabilityId, {
      capability_id: capabilityId,
      capability_version_id: capabilityVersionId,
      version: capabilityVersion,
      kind: capabilityKind,
    });
  }
  const manifest = canonicalize({
    schema_version: 1,
    tenant_id: ownData(input, "tenantId"),
    snapshot_id: ownData(input, "snapshotId"),
    snapshot_version: ownData(input, "snapshotVersion"),
    runtime_generation: ownData(input, "runtimeGeneration"),
    capabilities: [...unique.values()].sort((left, right) => asciiCompare(left.capability_id, right.capability_id)),
  });
  const canonicalJson = JSON.stringify(manifest);
  return Object.freeze({
    manifest,
    canonicalJson,
    digest: `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`,
  });
}

export function validateCapabilityRuntimeManifest(
  value: unknown,
  expectedDigest: unknown,
): CapabilityRuntimeManifestV1 {
  if (typeof expectedDigest !== "string" || !digestPattern.test(expectedDigest)) throw invalid();
  const manifest = canonicalize(value);
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex")}`;
  if (digest !== expectedDigest) throw invalid();
  return manifest;
}
