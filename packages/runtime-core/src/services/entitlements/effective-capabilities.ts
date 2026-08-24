import { createHash } from "node:crypto";

import { DomainError } from "../../domain/idempotency.js";

export interface EffectiveCapabilityTriple {
  readonly capabilityId: string;
  readonly capabilityVersionId: string;
  readonly version: string;
}

export interface EffectiveCapabilitySource {
  readonly entitlementId: string;
  readonly assignmentId?: string;
  readonly releaseId: string;
  readonly capabilities: readonly EffectiveCapabilityTriple[];
}

export interface EffectiveCapabilitySet {
  readonly sourceEntitlementIds: readonly string[];
  readonly sourceAssignmentIds: readonly string[];
  readonly sourceReleaseIds: readonly string[];
  readonly capabilities: readonly EffectiveCapabilityTriple[];
  readonly canonicalInputHash: `sha256:${string}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 && !value.includes("\0");
}

function assertSource(source: EffectiveCapabilitySource): void {
  if (
    source === null || typeof source !== "object" || Array.isArray(source)
    || !validIdentity(source.entitlementId)
    || (source.assignmentId !== undefined && !validIdentity(source.assignmentId))
    || !validIdentity(source.releaseId)
    || !Array.isArray(source.capabilities) || source.capabilities.length > 1_000
  ) throw new DomainError("INTERNAL_ERROR", "Effective capability source is invalid");
  for (const capability of source.capabilities) {
    if (
      capability === null || typeof capability !== "object" || Array.isArray(capability)
      || !validIdentity(capability.capabilityId)
      || !validIdentity(capability.capabilityVersionId)
      || !validIdentity(capability.version)
    ) throw new DomainError("INTERNAL_ERROR", "Effective capability source is invalid");
  }
}

function sorted(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareUtf8));
}

/** Pure, provider-independent effective Capability resolver over already-authoritative rows. */
export function resolveEffectiveCapabilities(
  sources: readonly EffectiveCapabilitySource[],
): EffectiveCapabilitySet {
  if (!Array.isArray(sources) || sources.length > 1_000) {
    throw new DomainError("INTERNAL_ERROR", "Effective capability source set is invalid");
  }
  for (const source of sources) assertSource(source);
  const byCapability = new Map<string, EffectiveCapabilityTriple>();
  for (const source of sources) {
    for (const capability of source.capabilities) {
      const existing = byCapability.get(capability.capabilityId);
      if (
        existing !== undefined
        && (
          existing.capabilityVersionId !== capability.capabilityVersionId
          || existing.version !== capability.version
        )
      ) throw new DomainError("CAPABILITY_CONFLICT", "Effective Pack authority contains incompatible Capability versions");
      byCapability.set(capability.capabilityId, Object.freeze({ ...capability }));
    }
  }
  const sourceEntitlementIds = sorted(sources.map((source) => source.entitlementId));
  const sourceAssignmentIds = sorted(sources.flatMap((source) => source.assignmentId === undefined ? [] : [source.assignmentId]));
  const sourceReleaseIds = sorted(sources.map((source) => source.releaseId));
  const capabilities = Object.freeze([...byCapability.values()].sort((left, right) => (
    compareUtf8(left.capabilityId, right.capabilityId)
    || compareUtf8(left.capabilityVersionId, right.capabilityVersionId)
    || compareUtf8(left.version, right.version)
  )));
  const canonical = JSON.stringify({
    capabilities: capabilities.map((capability) => ({
      capability_id: capability.capabilityId,
      capability_version_id: capability.capabilityVersionId,
      version: capability.version,
    })),
    source_assignment_ids: sourceAssignmentIds,
    source_entitlement_ids: sourceEntitlementIds,
    source_release_ids: sourceReleaseIds,
  });
  const canonicalInputHash = `sha256:${createHash("sha256")
    .update(`core-agent-entitlement-snapshot-v1\0${canonical}`, "utf8")
    .digest("hex")}` as const;
  return Object.freeze({
    sourceEntitlementIds,
    sourceAssignmentIds,
    sourceReleaseIds,
    capabilities,
    canonicalInputHash,
  });
}
