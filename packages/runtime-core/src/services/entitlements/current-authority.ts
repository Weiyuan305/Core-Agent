import type { EntitlementSnapshotRef } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import { loadEffectiveCapabilitySources } from "../../repositories/entitlements/snapshots.js";
import { deriveRuntimeContainerId } from "../provision-tenant.js";
import { resolveEffectiveCapabilities } from "./effective-capabilities.js";

export interface CurrentSnapshotAuthority {
  readonly tenantId: string;
  readonly profileId: string;
  readonly snapshotRef: EntitlementSnapshotRef;
  readonly capabilityIds: readonly string[];
  readonly pointerVersion: number;
  readonly current: boolean;
  readonly bootstrapOnly: false;
  readonly state: "current" | "preparing" | "denied";
}

export interface LoadCurrentSnapshotAuthorityInput {
  readonly trx: Transaction<RuntimeDatabase> | Kysely<RuntimeDatabase>;
  readonly tenantId: string;
  readonly profileId: string;
  readonly now: Date;
}

export interface RequireCurrentSnapshotAuthorityInput {
  readonly db: Kysely<RuntimeDatabase>;
  readonly tenantId: string;
  readonly profileId: string;
  readonly now?: Date;
}

const absentRef: EntitlementSnapshotRef = Object.freeze({
  snapshot_id: "entitlement_authority_unavailable",
  version: 1,
  evaluated_at: "1970-01-01T00:00:00.000Z",
});

function safeVersion(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Entitlement authority is unavailable", true);
  }
  return parsed;
}

function unavailable(input: LoadCurrentSnapshotAuthorityInput, state: "preparing" | "denied"): CurrentSnapshotAuthority {
  return Object.freeze({
    tenantId: input.tenantId,
    profileId: input.profileId,
    snapshotRef: absentRef,
    capabilityIds: Object.freeze([]),
    pointerVersion: 0,
    current: false,
    bootstrapOnly: false,
    state,
  });
}

async function readCurrentSnapshotAuthority(
  input: LoadCurrentSnapshotAuthorityInput,
): Promise<CurrentSnapshotAuthority> {
  let effective;
  try {
    const sources = await loadEffectiveCapabilitySources(
      input.trx as Transaction<RuntimeDatabase>,
      input.tenantId,
      input.profileId,
      input.now,
      undefined,
      false,
    );
    effective = resolveEffectiveCapabilities(sources);
  } catch (error) {
    if (error instanceof DomainError && error.code === "ENTITLEMENT_DENIED") return unavailable(input, "denied");
    throw error;
  }
  if (effective.capabilities.length === 0) return unavailable(input, "denied");

  const pointer = await input.trx.selectFrom("profile_snapshot_pointers")
    .innerJoin("entitlement_snapshots", (join) => join
      .onRef("entitlement_snapshots.tenant_id", "=", "profile_snapshot_pointers.tenant_id")
      .onRef("entitlement_snapshots.profile_id", "=", "profile_snapshot_pointers.profile_id")
      .onRef("entitlement_snapshots.snapshot_id", "=", "profile_snapshot_pointers.snapshot_id"))
    .select([
      "profile_snapshot_pointers.snapshot_id",
      "profile_snapshot_pointers.snapshot_version",
      "profile_snapshot_pointers.evaluated_at",
      "profile_snapshot_pointers.resource_version",
      "entitlement_snapshots.canonical_input_hash",
    ])
    .where("profile_snapshot_pointers.tenant_id", "=", input.tenantId)
    .where("profile_snapshot_pointers.profile_id", "=", input.profileId)
    .executeTakeFirst();
  if (pointer === undefined || pointer.canonical_input_hash !== effective.canonicalInputHash) {
    return unavailable(input, "denied");
  }
  const snapshotCapabilities = await input.trx.selectFrom("entitlement_snapshot_capabilities")
    .select(["capability_id", "capability_version_id", "version"])
    .where("tenant_id", "=", input.tenantId)
    .where("profile_id", "=", input.profileId)
    .where("snapshot_id", "=", pointer.snapshot_id)
    .orderBy("capability_order", "asc").execute();
  if (
    snapshotCapabilities.length !== effective.capabilities.length
    || snapshotCapabilities.some((row, index) => {
      const expected = effective.capabilities[index];
      return expected === undefined
        || row.capability_id !== expected.capabilityId
        || row.capability_version_id !== expected.capabilityVersionId
        || row.version !== expected.version;
    })
  ) return unavailable(input, "denied");

  const projection = await input.trx.selectFrom("capability_runtime_projections")
    .select(["runtime_generation", "capability_manifest_digest", "status"])
    .where("tenant_id", "=", input.tenantId)
    .where("profile_id", "=", input.profileId)
    .where("snapshot_id", "=", pointer.snapshot_id)
    .orderBy("runtime_generation", "desc").executeTakeFirst();
  const runtime = await input.trx.selectFrom("runtime_containers")
    .select(["generation", "capability_manifest_digest", "desired_state", "observed_state", "health_status"])
    .where("tenant_id", "=", input.tenantId)
    .where("container_id", "=", deriveRuntimeContainerId(input.tenantId))
    .executeTakeFirst();
  const current = projection?.status === "available"
    && runtime?.desired_state === "running"
    && runtime.observed_state === "ready"
    && runtime.health_status === "healthy"
    && runtime.generation === safeVersion(projection.runtime_generation)
    && runtime.capability_manifest_digest === projection.capability_manifest_digest;
  return Object.freeze({
    tenantId: input.tenantId,
    profileId: input.profileId,
    snapshotRef: Object.freeze({
      snapshot_id: pointer.snapshot_id,
      version: safeVersion(pointer.snapshot_version),
      evaluated_at: pointer.evaluated_at.toISOString(),
    }),
    capabilityIds: Object.freeze(effective.capabilities.map((capability) => capability.capabilityId)),
    pointerVersion: safeVersion(pointer.resource_version),
    current,
    bootstrapOnly: false,
    state: current ? "current" : "preparing",
  });
}

export async function loadCurrentSnapshotAuthority(
  input: LoadCurrentSnapshotAuthorityInput,
): Promise<CurrentSnapshotAuthority> {
  try {
    return await readCurrentSnapshotAuthority(input);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Entitlement authority is unavailable", true);
  }
}

export async function requireCurrentSnapshotAuthority(
  input: RequireCurrentSnapshotAuthorityInput,
): Promise<CurrentSnapshotAuthority> {
  try {
    const authority = await withDatabaseTransactionRetry(input.db, async (trx) => loadCurrentSnapshotAuthority({
      trx,
      tenantId: input.tenantId,
      profileId: input.profileId,
      now: input.now === undefined
        ? (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now ?? new Date(Number.NaN)
        : new Date(input.now),
    }));
    if (authority.current) return authority;
    if (authority.state === "preparing") throw new DomainError("SERVICE_PREPARING", "Capability service is preparing", true);
    throw new DomainError("ENTITLEMENT_DENIED", "Current entitlement authority is unavailable");
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Entitlement authority is unavailable", true);
  }
}

export async function requireCurrentSnapshot(
  input: RequireCurrentSnapshotAuthorityInput,
): Promise<CurrentSnapshotAuthority> {
  return requireCurrentSnapshotAuthority(input);
}

export async function recheckCapabilityBeforeEffect<T>(input: RequireCurrentSnapshotAuthorityInput & {
  readonly capabilityId: string;
  readonly expectedSnapshotRef: EntitlementSnapshotRef;
  readonly effect: () => Promise<T>;
}): Promise<T> {
  const authority = await requireCurrentSnapshotAuthority(input);
  if (
    authority.snapshotRef.snapshot_id !== input.expectedSnapshotRef.snapshot_id
    || authority.snapshotRef.version !== input.expectedSnapshotRef.version
    || authority.snapshotRef.evaluated_at !== input.expectedSnapshotRef.evaluated_at
    || !authority.capabilityIds.includes(input.capabilityId)
  ) throw new DomainError("ENTITLEMENT_DENIED", "Capability authority changed before the external effect");
  return input.effect();
}

export function createEntitlementSnapshotAuthorityPort() {
  return Object.freeze({
    async loadCurrentSnapshot(input: LoadCurrentSnapshotAuthorityInput) {
      return loadCurrentSnapshotAuthority(input);
    },
  });
}
