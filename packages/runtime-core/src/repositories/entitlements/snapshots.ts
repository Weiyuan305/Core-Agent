import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";
import { assertAutomaticB2cProfile } from "../../services/entitlements/automatic-b2c-assignment.js";
import type {
  EffectiveCapabilitySet,
  EffectiveCapabilitySource,
} from "../../services/entitlements/effective-capabilities.js";

interface EffectiveAuthorityRow {
  entitlement_id: string;
  assignment_id: string | null;
  tenant_pack_release_id: string;
  capability_id: string;
  capability_version_id: string;
  version: string;
  capability_status: string;
  risk_class: string;
  artifact_ref: string;
}

export async function loadEffectiveCapabilitySources(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  profileId: string,
  now: Date,
  candidateReleaseId?: string,
  lockAuthority = true,
): Promise<readonly EffectiveCapabilitySource[]> {
  let tenantQuery = trx.selectFrom("tenants").select(["tenant_mode", "status"])
    .where("tenant_id", "=", tenantId);
  if (lockAuthority) tenantQuery = tenantQuery.forUpdate();
  const tenant = await tenantQuery.executeTakeFirst();
  if (tenant?.status !== "active") throw new DomainError("ENTITLEMENT_DENIED", "Active Tenant authority is required");
  let profileQuery = trx.selectFrom("profiles").select(["owner_actor_id", "profile_kind", "status"])
    .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId);
  if (lockAuthority) profileQuery = profileQuery.forUpdate();
  const profile = await profileQuery.executeTakeFirst();
  if (profile?.status !== "active") throw new DomainError("ENTITLEMENT_DENIED", "Active Profile authority is required");
  if (tenant.tenant_mode === "b2c") {
    await assertAutomaticB2cProfile(trx, tenantId, profileId, lockAuthority);
  } else if (tenant.tenant_mode === "b2b") {
    let membershipQuery = trx.selectFrom("memberships").select(["status", "roles", "membership_source"])
      .where("tenant_id", "=", tenantId).where("actor_id", "=", profile.owner_actor_id);
    if (lockAuthority) membershipQuery = membershipQuery.forUpdate();
    const membership = await membershipQuery.executeTakeFirst();
    if (
      profile.profile_kind !== "consultant"
      || membership?.status !== "active"
      || membership.membership_source !== "company"
      || !membership.roles.includes("consultant")
    ) throw new DomainError("ENTITLEMENT_DENIED", "Active consultant Profile authority is required");
  } else throw new DomainError("INTERNAL_ERROR", "Stored Tenant mode is invalid");

  const candidateRelease = candidateReleaseId === undefined
    ? undefined
    : await trx.selectFrom("tenant_pack_releases")
      .select(["tenant_pack_release_id", "pack_product_id", "status"])
      .where("tenant_id", "=", tenantId)
      .where("tenant_pack_release_id", "=", candidateReleaseId)
      .forUpdate().executeTakeFirst();
  if (candidateReleaseId !== undefined && candidateRelease?.status !== "preparing") {
    throw new DomainError("INVALID_STATE_TRANSITION", "A preparing Pack Release candidate is required");
  }
  const selectedCandidateId = candidateRelease?.tenant_pack_release_id ?? null;
  const selectedCandidateProductId = candidateRelease?.pack_product_id ?? null;

  const effectiveQuery = sql<EffectiveAuthorityRow>`
    select entitlement.entitlement_id,
      assignment.assignment_id,
      release.tenant_pack_release_id,
      member.capability_id,
      member.capability_version_id,
      member.version,
      capability_version.status as capability_status,
      capability_version.risk_class,
      capability_version.artifact_ref
    from entitlements as entitlement
    join tenant_pack_releases as release
      on release.tenant_id = entitlement.tenant_id
     and release.pack_product_id = entitlement.pack_product_id
     and (
       (${selectedCandidateId}::text is not null
         and entitlement.pack_product_id = ${selectedCandidateProductId}::text
         and release.tenant_pack_release_id = ${selectedCandidateId}::text
         and release.status = 'preparing')
       or
       ((${selectedCandidateId}::text is null or entitlement.pack_product_id <> ${selectedCandidateProductId}::text)
         and release.tenant_pack_release_id = entitlement.tenant_pack_release_id
         and release.pack_version_id = entitlement.pack_version_id
         and release.pack_version = entitlement.pack_version
         and release.status = 'current')
     )
    join pack_versions as pack
      on pack.pack_version_id = release.pack_version_id
     and pack.pack_product_id = release.pack_product_id
     and pack.version = release.pack_version
     and pack.status in ('published', 'retired')
    join pack_members as member on member.pack_version_id = release.pack_version_id
    join capability_versions as capability_version
      on capability_version.capability_id = member.capability_id
     and capability_version.capability_version_id = member.capability_version_id
     and capability_version.version = member.version
    left join entitlement_assignments as assignment
      on assignment.tenant_id = entitlement.tenant_id
     and assignment.entitlement_id = entitlement.entitlement_id
     and assignment.profile_id = ${profileId}
     and assignment.status in ('preparing', 'available')
    where entitlement.tenant_id = ${tenantId}
      and entitlement.status = 'active'
      and entitlement.valid_from <= ${now}
      and (entitlement.expires_at is null or entitlement.expires_at > ${now})
      and (
        (entitlement.tenant_mode = 'b2c' and entitlement.assignment_mode = 'automatic')
        or (entitlement.tenant_mode = 'b2b' and entitlement.assignment_mode = 'seat'
          and assignment.assignment_id is not null)
      )
    order by entitlement.entitlement_id collate "C", member.capability_id collate "C",
      member.capability_version_id collate "C", member.version collate "C"
    ${lockAuthority ? sql`for share of entitlement, release, pack, member, capability_version` : sql``}
  `;
  const rows = (await effectiveQuery.execute(trx)).rows;
  const sourceMap = new Map<string, { entitlementId: string; assignmentId?: string; releaseId: string; capabilities: Array<{ capabilityId: string; capabilityVersionId: string; version: string }> }>();
  for (const row of rows) {
    if (
      !["reviewed", "retired"].includes(row.capability_status)
      || row.risk_class === "external_write"
      || row.risk_class === "privileged"
      || (row.risk_class === "draft_write" && !row.artifact_ref.startsWith("manifest:sha256:"))
    ) throw new DomainError("ENTITLEMENT_DENIED", "Capability authority is blocked or unsafe");
    let source = sourceMap.get(row.entitlement_id);
    if (source === undefined) {
      source = {
        entitlementId: row.entitlement_id,
        ...(row.assignment_id === null ? {} : { assignmentId: row.assignment_id }),
        releaseId: row.tenant_pack_release_id,
        capabilities: [],
      };
      sourceMap.set(row.entitlement_id, source);
    }
    source.capabilities.push({
      capabilityId: row.capability_id,
      capabilityVersionId: row.capability_version_id,
      version: row.version,
    });
  }
  return Object.freeze([...sourceMap.values()].map((source) => Object.freeze({
    ...source,
    capabilities: Object.freeze(source.capabilities),
  })));
}

export interface PersistedSnapshotRow {
  readonly snapshot_id: string;
  readonly snapshot_version: string;
  readonly evaluated_at: Date;
  readonly canonical_input_hash: string;
}

export async function insertSnapshotAggregate(
  trx: Transaction<RuntimeDatabase>,
  input: {
    tenantId: string;
    profileId: string;
    snapshotId: string;
    snapshotVersion: number;
    effective: EffectiveCapabilitySet;
  },
): Promise<PersistedSnapshotRow> {
  const snapshot = await trx.insertInto("entitlement_snapshots").values({
    snapshot_id: input.snapshotId,
    tenant_id: input.tenantId,
    profile_id: input.profileId,
    snapshot_version: input.snapshotVersion,
    canonical_input_hash: input.effective.canonicalInputHash,
    resource_version: 1,
  }).returning(["snapshot_id", "snapshot_version", "evaluated_at", "canonical_input_hash"])
    .executeTakeFirstOrThrow();
  const sources = [
    ["entitlement", input.effective.sourceEntitlementIds],
    ["assignment", input.effective.sourceAssignmentIds],
    ["release", input.effective.sourceReleaseIds],
  ] as const;
  for (const [kind, identifiers] of sources) {
    for (const [index, sourceId] of identifiers.entries()) {
      await trx.insertInto("entitlement_snapshot_sources").values({
        tenant_id: input.tenantId,
        profile_id: input.profileId,
        snapshot_id: input.snapshotId,
        source_kind: kind,
        source_id: sourceId,
        source_order: index + 1,
        created_at: new Date(snapshot.evaluated_at),
      }).execute();
    }
  }
  for (const [index, capability] of input.effective.capabilities.entries()) {
    await trx.insertInto("entitlement_snapshot_capabilities").values({
      tenant_id: input.tenantId,
      profile_id: input.profileId,
      snapshot_id: input.snapshotId,
      capability_id: capability.capabilityId,
      capability_version_id: capability.capabilityVersionId,
      version: capability.version,
      capability_order: index + 1,
      created_at: new Date(snapshot.evaluated_at),
    }).execute();
  }
  await sql`set constraints all immediate`.execute(trx);
  return snapshot;
}
