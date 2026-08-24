import { createHash } from "node:crypto";

import type { EntitlementSnapshotRef } from "@core-agent/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { DomainError } from "../../domain/idempotency.js";
import { appendAuditEvent, appendProductEvents, type ProductEventWithoutSequence } from "../../repositories/events.js";
import {
  insertSnapshotAggregate,
  loadEffectiveCapabilitySources,
} from "../../repositories/entitlements/snapshots.js";
import { resolveEffectiveCapabilities } from "./effective-capabilities.js";

export interface SnapshotResolutionEvidence {
  readonly actorId: string;
  readonly membershipId: string;
  /** Platform commands audit through their server-derived platform Membership. */
  readonly auditTenantId?: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface ResolveProfileSnapshotInput {
  readonly tenantId: string;
  readonly profileId: string;
  /** A preparing release is evaluated and projected without changing current authority. */
  readonly candidateReleaseId?: string;
  readonly evidence: SnapshotResolutionEvidence;
}

export interface ResolveProfileSnapshotTransactionInput extends ResolveProfileSnapshotInput {
  readonly trx: Transaction<RuntimeDatabase>;
  readonly now: Date;
}

export interface ResolveProfileSnapshotDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

export interface ResolvedProfileSnapshot {
  readonly snapshotRef: EntitlementSnapshotRef;
  readonly capabilityIds: readonly string[];
  readonly canonicalInputHash: string;
  readonly pointerVersion: number;
  readonly reused: boolean;
  readonly staged: boolean;
  readonly projection: {
    readonly projectionId: string;
    readonly generation: number;
    readonly status: "preparing" | "available" | "failed";
  };
}

function derivedId(prefix: string, ...values: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(values.join("\0"), "utf8").digest("hex").slice(0, 32)}`;
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new DomainError("INTERNAL_ERROR", "Stored Snapshot version is invalid");
  return version;
}

function validateEvidence(evidence: SnapshotResolutionEvidence): void {
  const values = [
    evidence.actorId,
    evidence.membershipId,
    evidence.requestId,
    evidence.traceId,
    ...(evidence.auditTenantId === undefined ? [] : [evidence.auditTenantId]),
  ];
  for (const value of values) {
    if (typeof value !== "string" || value.length < 1 || value.length > 255 || value.includes("\0")) {
      throw new DomainError("INVALID_REQUEST", "Snapshot resolution evidence is invalid");
    }
  }
}

async function requireEvidenceMembership(
  trx: Transaction<RuntimeDatabase>,
  input: ResolveProfileSnapshotInput,
): Promise<void> {
  validateEvidence(input.evidence);
  const auditTenantId = input.evidence.auditTenantId ?? input.tenantId;
  const membership = await trx.selectFrom("memberships").select(["actor_id", "status"])
    .where("tenant_id", "=", auditTenantId)
    .where("membership_id", "=", input.evidence.membershipId)
    .forUpdate().executeTakeFirst();
  if (membership?.status !== "active" || membership.actor_id !== input.evidence.actorId) {
    throw new DomainError("UNAUTHENTICATED", "Active Snapshot resolution Membership is required");
  }
}

async function storedProjection(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  profileId: string,
  snapshotId: string,
) {
  const projection = await trx.selectFrom("capability_runtime_projections")
    .select(["projection_id", "runtime_generation", "status"])
    .where("tenant_id", "=", tenantId)
    .where("profile_id", "=", profileId)
    .where("snapshot_id", "=", snapshotId)
    .orderBy("runtime_generation", "desc").executeTakeFirst();
  if (projection === undefined) {
    throw new DomainError("INTERNAL_ERROR", "Current Snapshot projection is missing");
  }
  return projection;
}

export async function resolveProfileSnapshotInTransaction(
  input: ResolveProfileSnapshotTransactionInput,
): Promise<ResolvedProfileSnapshot> {
  await requireEvidenceMembership(input.trx, input);
  const sources = await loadEffectiveCapabilitySources(
    input.trx,
    input.tenantId,
    input.profileId,
    input.now,
    input.candidateReleaseId,
  );
  const effective = resolveEffectiveCapabilities(sources);
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
    .forUpdate("profile_snapshot_pointers").executeTakeFirst();
  if (input.candidateReleaseId !== undefined) {
    const stagedSnapshot = await input.trx.selectFrom("capability_runtime_projections")
      .innerJoin("entitlement_snapshots", (join) => join
        .onRef("entitlement_snapshots.tenant_id", "=", "capability_runtime_projections.tenant_id")
        .onRef("entitlement_snapshots.profile_id", "=", "capability_runtime_projections.profile_id")
        .onRef("entitlement_snapshots.snapshot_id", "=", "capability_runtime_projections.snapshot_id"))
      .select([
        "entitlement_snapshots.snapshot_id",
        "entitlement_snapshots.snapshot_version",
        "entitlement_snapshots.evaluated_at",
        "capability_runtime_projections.projection_id",
        "capability_runtime_projections.runtime_generation",
        "capability_runtime_projections.status",
      ])
      .where("capability_runtime_projections.tenant_id", "=", input.tenantId)
      .where("capability_runtime_projections.profile_id", "=", input.profileId)
      .where("capability_runtime_projections.tenant_pack_release_id", "=", input.candidateReleaseId)
      .where("entitlement_snapshots.canonical_input_hash", "=", effective.canonicalInputHash)
      .orderBy("entitlement_snapshots.snapshot_version", "desc")
      .forUpdate("capability_runtime_projections").executeTakeFirst();
    if (stagedSnapshot !== undefined) {
      return Object.freeze({
        snapshotRef: Object.freeze({
          snapshot_id: stagedSnapshot.snapshot_id,
          version: safeVersion(stagedSnapshot.snapshot_version),
          evaluated_at: stagedSnapshot.evaluated_at.toISOString(),
        }),
        capabilityIds: Object.freeze(effective.capabilities.map((capability) => capability.capabilityId)),
        canonicalInputHash: effective.canonicalInputHash,
        pointerVersion: pointer === undefined ? 0 : safeVersion(pointer.resource_version),
        reused: true,
        staged: true,
        projection: Object.freeze({
          projectionId: stagedSnapshot.projection_id,
          generation: safeVersion(stagedSnapshot.runtime_generation),
          status: stagedSnapshot.status,
        }),
      });
    }
  }
  if (input.candidateReleaseId === undefined && pointer?.canonical_input_hash === effective.canonicalInputHash) {
    const projection = await storedProjection(input.trx, input.tenantId, input.profileId, pointer.snapshot_id);
    return Object.freeze({
      snapshotRef: Object.freeze({
        snapshot_id: pointer.snapshot_id,
        version: safeVersion(pointer.snapshot_version),
        evaluated_at: pointer.evaluated_at.toISOString(),
      }),
      capabilityIds: Object.freeze(effective.capabilities.map((capability) => capability.capabilityId)),
      canonicalInputHash: effective.canonicalInputHash,
      pointerVersion: safeVersion(pointer.resource_version),
      reused: true,
      staged: false,
      projection: Object.freeze({
        projectionId: projection.projection_id,
        generation: safeVersion(projection.runtime_generation),
        status: projection.status,
      }),
    });
  }

  const maximumSnapshot = await input.trx.selectFrom("entitlement_snapshots")
    .select(sql<string>`coalesce(max(snapshot_version), 0)`.as("maximum"))
    .where("tenant_id", "=", input.tenantId).where("profile_id", "=", input.profileId)
    .executeTakeFirstOrThrow();
  const snapshotVersion = Number(maximumSnapshot.maximum) + 1;
  if (!Number.isSafeInteger(snapshotVersion)) throw new DomainError("INTERNAL_ERROR", "Snapshot version overflow");
  const snapshotId = derivedId("entitlement_snapshot", input.tenantId, input.profileId, String(snapshotVersion), effective.canonicalInputHash);
  const snapshot = await insertSnapshotAggregate(input.trx, {
    tenantId: input.tenantId,
    profileId: input.profileId,
    snapshotId,
    snapshotVersion,
    effective,
  });
  const expectedPointerVersion = pointer === undefined ? 0 : safeVersion(pointer.resource_version);
  const staged = input.candidateReleaseId !== undefined;
  const pointerVersion = staged
    ? expectedPointerVersion
    : safeVersion((await sql<{ resource_version: string }>`
      select resource_version
      from advance_profile_snapshot_pointer(
        ${input.tenantId}, ${input.profileId}, ${expectedPointerVersion}, ${snapshotId}
      )
    `.execute(input.trx)).rows[0]?.resource_version ?? "0");

  const generationRow = await input.trx.selectFrom("capability_runtime_projections")
    .select(sql<string>`coalesce(max(runtime_generation), 0)`.as("maximum"))
    .where("tenant_id", "=", input.tenantId).executeTakeFirstOrThrow();
  const generation = Number(generationRow.maximum) + 1;
  if (!Number.isSafeInteger(generation)) throw new DomainError("INTERNAL_ERROR", "Runtime projection generation overflow");
  const projectionId = derivedId("capability_projection", input.tenantId, input.profileId, String(generation), snapshotId);
  const projectionReleaseId = effective.sourceReleaseIds.length === 1 ? effective.sourceReleaseIds[0]! : null;
  await sql`
    insert into capability_runtime_projections (
      projection_id, tenant_id, profile_id, snapshot_id, snapshot_version, evaluated_at,
      tenant_pack_release_id, runtime_generation, capability_manifest_digest, status,
      reason_code, resource_version, created_at, updated_at
    )
    select ${projectionId}, snapshot.tenant_id, snapshot.profile_id, snapshot.snapshot_id,
      snapshot.snapshot_version, snapshot.evaluated_at, ${projectionReleaseId}, ${generation},
      ${effective.canonicalInputHash}, 'preparing', null, 1,
      snapshot.evaluated_at, snapshot.evaluated_at
    from entitlement_snapshots as snapshot
    where snapshot.tenant_id = ${input.tenantId}
      and snapshot.profile_id = ${input.profileId}
      and snapshot.snapshot_id = ${snapshotId}
  `.execute(input.trx);

  const snapshotRef: EntitlementSnapshotRef = Object.freeze({
    snapshot_id: snapshotId,
    version: snapshotVersion,
    evaluated_at: snapshot.evaluated_at.toISOString(),
  });
  const events: ProductEventWithoutSequence[] = [];
  if (!staged) events.push({
    schema_version: 1,
    event_id: derivedId("event_snapshot", input.tenantId, input.profileId, String(snapshotVersion)),
    occurred_at: snapshot.evaluated_at.toISOString(),
    tenant_id: input.tenantId,
    request_id: input.evidence.requestId,
    trace_id: input.evidence.traceId,
    correlation_id: derivedId("correlation_snapshot", input.evidence.requestId),
    causation_id: derivedId("causation_snapshot", input.evidence.requestId),
    profile_id: input.profileId,
    event_type: "entitlement_snapshot.changed",
    payload: {
      profile_id: input.profileId,
      entitlement_snapshot_ref: snapshotRef,
      resource_version: pointerVersion,
    },
  } as unknown as ProductEventWithoutSequence);
  events.push({
    schema_version: 1,
    event_id: derivedId("event_service_preparing", input.tenantId, input.profileId, String(snapshotVersion)),
    occurred_at: snapshot.evaluated_at.toISOString(),
    tenant_id: input.tenantId,
    request_id: input.evidence.requestId,
    trace_id: input.evidence.traceId,
    correlation_id: derivedId("correlation_snapshot", input.evidence.requestId),
    causation_id: derivedId("causation_snapshot", input.evidence.requestId),
    profile_id: input.profileId,
    event_type: "service.preparing",
    payload: {
      profile_id: input.profileId,
      generation,
      entitlement_snapshot_ref: snapshotRef,
      state: "preparing",
    },
  } as unknown as ProductEventWithoutSequence);
  await appendProductEvents(
    { tenantId: input.tenantId, trx: input.trx },
    { streamId: input.profileId, deliveryTarget: "internal_event_stream", events },
  );
  const auditTenantId = input.evidence.auditTenantId ?? input.tenantId;
  await appendAuditEvent({ tenantId: auditTenantId, trx: input.trx }, {
    schema_version: 1,
    audit_event_id: derivedId("audit_snapshot", input.tenantId, input.profileId, String(snapshotVersion)),
    occurred_at: snapshot.evaluated_at.toISOString(),
    tenant_id: auditTenantId,
    actor_id: input.evidence.actorId,
    membership_id: input.evidence.membershipId,
    effective_role: "admin",
    action: "entitlements.snapshot.resolve",
    resource_type: "entitlement_snapshot",
    resource_id: snapshotId,
    decision: "allowed",
    outcome: "succeeded",
    request_id: input.evidence.requestId,
    trace_id: input.evidence.traceId,
    reason_summary: staged
      ? "Staged a candidate Profile entitlement authority"
      : "Resolved current Profile entitlement authority",
    resource_version: 1,
    entitlement_snapshot_ref: snapshotRef,
  });
  return Object.freeze({
    snapshotRef,
    capabilityIds: Object.freeze(effective.capabilities.map((capability) => capability.capabilityId)),
    canonicalInputHash: effective.canonicalInputHash,
    pointerVersion,
    reused: false,
    staged,
    projection: Object.freeze({ projectionId, generation, status: "preparing" }),
  });
}

export async function resolveProfileSnapshot(
  dependencies: ResolveProfileSnapshotDependencies,
  input: ResolveProfileSnapshotInput,
): Promise<ResolvedProfileSnapshot> {
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new DomainError("INTERNAL_ERROR", "Snapshot database clock is invalid");
    }
    return resolveProfileSnapshotInTransaction({ ...input, trx, now });
  });
}
