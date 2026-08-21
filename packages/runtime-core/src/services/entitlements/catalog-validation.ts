import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import { DomainError } from "../../domain/idempotency.js";

const canonicalSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const contractRef = /^[a-z0-9][a-z0-9._/-]{0,127}@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const npmIntegrity = /^[A-Za-z0-9+/]{85}[AQgw]==$/u;
const ociComponent = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const scopedPackage = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/u;
const plainPackage = /^[a-z0-9][a-z0-9._~-]*$/u;

export interface CatalogCompatibility {
  readonly core_contract_version: string;
  readonly domain_contract_version: string;
  readonly runtime_protocol_version: string;
  readonly tenant_modes: readonly ("b2b" | "b2c")[];
}

export interface CatalogMemberInput {
  readonly capability_id: string;
  readonly capability_version_id: string;
  readonly version: string;
}

export interface ValidatedCapabilityCreate {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly capability_id: string;
  readonly capability_version_id: string;
  readonly display_name: string;
  readonly owning_domain: string;
  readonly kind: "mcp" | "skill" | "policy";
  readonly version: string;
  readonly artifact_ref: string;
  readonly contract_ref: string;
  readonly risk_class: "read" | "draft_write" | "external_write" | "privileged";
  readonly approval_requirement: "none" | "user_confirmation" | "human_approval";
  readonly compatibility: CatalogCompatibility;
  readonly expected_resource_version: null;
}

export interface ValidatedVersionTransition {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly capability_version_id?: string;
  readonly pack_version_id?: string;
  readonly expected_resource_version: number;
}

export interface ValidatedPackCreate {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly pack_product_id: string;
  readonly pack_version_id: string;
  readonly display_name: string;
  readonly tenant_modes: readonly ("b2b" | "b2c")[];
  readonly version: string;
  readonly expected_resource_version: null;
  readonly members: readonly CatalogMemberInput[];
}

function invalid(): never { throw new DomainError("INVALID_REQUEST", "Catalog command does not satisfy its contract"); }

function ownValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
  return descriptor.value;
}

function plainRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== keys.length) invalid();
  for (const key of keys) ownValue(value, key);
  if (ownKeys.some((key) => !keys.includes(key as string))) invalid();
  return value as Record<string, unknown>;
}

function plainArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol") || keys.length !== value.length + 1 || !keys.includes("length")) invalid();
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
    values.push(descriptor.value);
  }
  return values;
}

function text(value: unknown, minimum = 1, maximum = 255): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) invalid();
  return value;
}
function id(value: unknown): string { return text(value, 1, 255); }
function semver(value: unknown): string { const result = text(value, 5, 128); if (!canonicalSemver.test(result)) invalid(); return result; }
function hash(value: unknown): string { const result = text(value, 71, 71); if (!/^sha256:[a-f0-9]{64}$/u.test(result)) invalid(); return result; }
function expected(value: unknown, optional: boolean): number | null {
  if (optional && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

/** Exact 0.7 catalog admission, intentionally stricter than the plan's illustrative regex. */
export function validateImmutableArtifactRef(value: unknown): string {
  const artifact = text(value, 1, 512);
  if (/^manifest:sha256:[a-f0-9]{64}$/u.test(artifact)) return artifact;
  if (artifact.startsWith("npm:")) {
    const body = artifact.slice(4); const integrityAt = body.lastIndexOf("#sha512-"); const packageAt = body.lastIndexOf("@", integrityAt);
    if (integrityAt < 1 || packageAt < 1) invalid();
    const packageName = body.slice(0, packageAt); const version = body.slice(packageAt + 1, integrityAt); const integrity = body.slice(integrityAt + 8);
    if (body.length > 214 || (!plainPackage.test(packageName) && !scopedPackage.test(packageName)) || !canonicalSemver.test(version) || !npmIntegrity.test(integrity)) invalid();
    return artifact;
  }
  if (!artifact.startsWith("oci:") || !artifact.endsWith(`@sha256:${artifact.slice(-64)}`) || !/^oci:.*@sha256:[a-f0-9]{64}$/u.test(artifact)) invalid();
  const repository = artifact.slice(4, -72);
  if (repository.length < 1 || repository.length > 255 || repository.split("/").some((component) => !ociComponent.test(component))) invalid();
  return artifact;
}

export function canonicalCompatibility(value: unknown): { readonly compatibility: CatalogCompatibility; readonly hash: string } {
  const input = plainRecord(value, ["core_contract_version", "domain_contract_version", "runtime_protocol_version", "tenant_modes"]);
  const modes = plainArray(ownValue(input, "tenant_modes"));
  if (modes.length < 1 || modes.length > 2 || modes.some((mode) => mode !== "b2b" && mode !== "b2c") || new Set(modes).size !== modes.length) invalid();
  const compatibility: CatalogCompatibility = Object.freeze({
    core_contract_version: semver(ownValue(input, "core_contract_version")),
    domain_contract_version: semver(ownValue(input, "domain_contract_version")),
    runtime_protocol_version: semver(ownValue(input, "runtime_protocol_version")),
    tenant_modes: Object.freeze([...modes].sort() as ("b2b" | "b2c")[]),
  });
  const canonical = JSON.stringify({
    core_contract_version: compatibility.core_contract_version,
    domain_contract_version: compatibility.domain_contract_version,
    runtime_protocol_version: compatibility.runtime_protocol_version,
    tenant_modes: [...compatibility.tenant_modes].sort(),
  });
  return Object.freeze({ compatibility, hash: `sha256:${createHash("sha256").update(`core-agent-capability-compatibility-v1\0${canonical}`, "utf8").digest("hex")}` });
}

export function validateCatalogCommandInput(value: unknown, kind: "capability" | "pack"): ValidatedCapabilityCreate | ValidatedPackCreate {
  const capabilityKeys = ["schema_version", "idempotency_key", "payload_hash", "capability_id", "capability_version_id", "display_name", "owning_domain", "kind", "version", "artifact_ref", "contract_ref", "risk_class", "approval_requirement", "compatibility", "expected_resource_version"] as const;
  const packKeys = ["schema_version", "idempotency_key", "payload_hash", "pack_product_id", "pack_version_id", "display_name", "tenant_modes", "version", "expected_resource_version", "members"] as const;
  const input = plainRecord(value, kind === "capability" ? capabilityKeys : packKeys);
  if (ownValue(input, "schema_version") !== 1) invalid();
  const common = { schema_version: 1 as const, idempotency_key: id(ownValue(input, "idempotency_key")), payload_hash: hash(ownValue(input, "payload_hash")) };
  if (kind === "capability") {
    const compatibility = canonicalCompatibility(ownValue(input, "compatibility")).compatibility;
    const expectedResourceVersion = expected(ownValue(input, "expected_resource_version"), true);
    if (expectedResourceVersion !== null) invalid();
    const result: ValidatedCapabilityCreate = Object.freeze({ ...common, capability_id: id(ownValue(input, "capability_id")), capability_version_id: id(ownValue(input, "capability_version_id")), display_name: text(ownValue(input, "display_name"), 1, 200), owning_domain: text(ownValue(input, "owning_domain"), 1, 200), kind: ownValue(input, "kind") as ValidatedCapabilityCreate["kind"], version: semver(ownValue(input, "version")), artifact_ref: validateImmutableArtifactRef(ownValue(input, "artifact_ref")), contract_ref: text(ownValue(input, "contract_ref"), 7, 256), risk_class: ownValue(input, "risk_class") as ValidatedCapabilityCreate["risk_class"], approval_requirement: ownValue(input, "approval_requirement") as ValidatedCapabilityCreate["approval_requirement"], compatibility, expected_resource_version: null });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result.owning_domain) || !contractRef.test(result.contract_ref) || !["mcp", "skill", "policy"].includes(result.kind) || !["read", "draft_write", "external_write", "privileged"].includes(result.risk_class) || !["none", "user_confirmation", "human_approval"].includes(result.approval_requirement)) invalid();
    return result;
  }
  const modes = plainArray(ownValue(input, "tenant_modes"));
  const members = plainArray(ownValue(input, "members")).map((member) => {
    const parsed = plainRecord(member, ["capability_id", "capability_version_id", "version"]);
    return Object.freeze({ capability_id: id(ownValue(parsed, "capability_id")), capability_version_id: id(ownValue(parsed, "capability_version_id")), version: semver(ownValue(parsed, "version")) });
  });
  if (modes.length < 1 || modes.length > 2 || modes.some((mode) => mode !== "b2b" && mode !== "b2c") || new Set(modes).size !== modes.length || members.length < 1 || members.length > 100) invalid();
  return Object.freeze({ ...common, pack_product_id: id(ownValue(input, "pack_product_id")), pack_version_id: id(ownValue(input, "pack_version_id")), display_name: text(ownValue(input, "display_name"), 1, 200), tenant_modes: Object.freeze([...modes].sort() as ("b2b" | "b2c")[]), version: semver(ownValue(input, "version")), expected_resource_version: expected(ownValue(input, "expected_resource_version"), true) as null, members: Object.freeze(members) });
}

export function validateCatalogTransition(value: unknown, resource: "capability" | "pack"): ValidatedVersionTransition {
  const identifier = resource === "capability" ? "capability_version_id" : "pack_version_id";
  const input = plainRecord(value, ["schema_version", "idempotency_key", "payload_hash", identifier, "expected_resource_version"]);
  if (ownValue(input, "schema_version") !== 1) invalid();
  return Object.freeze({ schema_version: 1, idempotency_key: id(ownValue(input, "idempotency_key")), payload_hash: hash(ownValue(input, "payload_hash")), [identifier]: id(ownValue(input, identifier)), expected_resource_version: expected(ownValue(input, "expected_resource_version"), false) as number });
}
