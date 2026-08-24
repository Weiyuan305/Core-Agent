import { createHash } from "node:crypto";

import { sql, type Kysely, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { appendProductEvents, type ProductEventWithoutSequence } from "../events.js";
import { createCapabilityRuntimeManifest, type CapabilityRuntimeManifestV1 } from "../../runtime/capability-manifest.js";
import { deriveRuntimeContainerId } from "../../services/provision-tenant.js";
import { loadEffectiveCapabilitySources } from "./snapshots.js";
import { resolveEffectiveCapabilities } from "../../services/entitlements/effective-capabilities.js";
import type { CapabilityRuntimeObservation } from "../../supervisor/contracts.js";

export interface CapabilityProjectionWorkerJobRef {
  readonly tenantId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly attemptCount: number;
  readonly projectionId: string;
}

export interface StoredCapabilityProjectionFacts {
  readonly tenantId: string;
  readonly projectionId: string;
  readonly profileId: string;
  readonly snapshotId: string;
  readonly snapshotVersion: number;
  readonly runtimeId: string;
  readonly runtimeGeneration: number;
  readonly imageRef: string;
  readonly expectedProfileIds: readonly string[];
  readonly manifest: CapabilityRuntimeManifestV1;
  readonly manifestDigest: `sha256:${string}`;
  readonly candidateReleaseId?: string;
}

export type CapabilityProjectionPreparationResult =
  | { readonly kind: "ready"; readonly facts: StoredCapabilityProjectionFacts }
  | { readonly kind: "superseded" | "lease_lost" };

export type CapabilityProjectionCompletionResult = { readonly kind: "completed" | "superseded" | "lease_lost" };
export type CapabilityProjectionFailureResult = { readonly kind: "failed" | "superseded" | "lease_lost" };

class ProjectionLeaseLost extends Error {}

function safePositiveInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Stored capability projection version is invalid");
  return parsed;
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function derivedProjectionId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32)}`;
}

async function lockOwnedJob(
  trx: Transaction<RuntimeDatabase>,
  job: CapabilityProjectionWorkerJobRef,
  effectState?: "pre_effect" | "unsafe_to_replay",
) {
  let query = trx.selectFrom("worker_jobs")
    .select(["job_kind", "payload_ref", "effect_state"])
    .where("tenant_id", "=", job.tenantId)
    .where("job_id", "=", job.jobId)
    .where("attempt_count", "=", job.attemptCount)
    .where("lease_owner", "=", job.workerId)
    .where("status", "=", "running")
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`);
  if (effectState !== undefined) query = query.where("effect_state", "=", effectState);
  const row = await query.forUpdate().executeTakeFirst();
  if (
    row?.job_kind !== "reconcile_capability_projection"
    || row.payload_ref !== job.projectionId
  ) throw new ProjectionLeaseLost();
  return row;
}

async function finishJob(
  trx: Transaction<RuntimeDatabase>,
  job: CapabilityProjectionWorkerJobRef,
  values: Record<string, unknown>,
): Promise<void> {
  const updated = await trx.updateTable("worker_jobs").set(values)
    .where("tenant_id", "=", job.tenantId)
    .where("job_id", "=", job.jobId)
    .where("attempt_count", "=", job.attemptCount)
    .where("lease_owner", "=", job.workerId)
    .where("status", "=", "running")
    .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw new ProjectionLeaseLost();
}

function sameObservation(
  facts: StoredCapabilityProjectionFacts,
  observation: CapabilityRuntimeObservation,
): boolean {
  const profiles = [...facts.expectedProfileIds].sort(utf8Compare);
  return observation.tenant_id === facts.tenantId
    && observation.runtime_id === facts.runtimeId
    && observation.generation === facts.runtimeGeneration
    && observation.image_ref === facts.imageRef
    && observation.exists
    && observation.lifecycle === "running"
    && observation.health === "healthy"
    && observation.capability_manifest_digest === facts.manifestDigest
    && observation.profile_ids.length === profiles.length
    && observation.profile_ids.every((profileId, index) => profileId === profiles[index]);
}

async function snapshotManifest(
  trx: Transaction<RuntimeDatabase>,
  input: {
    readonly tenantId: string;
    readonly profileId: string;
    readonly snapshotId: string;
    readonly snapshotVersion: number;
    readonly runtimeGeneration: number;
  },
) {
  const rows = await trx.selectFrom("entitlement_snapshot_capabilities")
    .innerJoin("capability_versions", (join) => join
      .onRef("capability_versions.capability_id", "=", "entitlement_snapshot_capabilities.capability_id")
      .onRef("capability_versions.capability_version_id", "=", "entitlement_snapshot_capabilities.capability_version_id")
      .onRef("capability_versions.version", "=", "entitlement_snapshot_capabilities.version"))
    .select([
      "entitlement_snapshot_capabilities.capability_id",
      "entitlement_snapshot_capabilities.capability_version_id",
      "entitlement_snapshot_capabilities.version",
      "capability_versions.kind",
      "capability_versions.risk_class",
      "capability_versions.status",
    ])
    .where("entitlement_snapshot_capabilities.tenant_id", "=", input.tenantId)
    .where("entitlement_snapshot_capabilities.profile_id", "=", input.profileId)
    .where("entitlement_snapshot_capabilities.snapshot_id", "=", input.snapshotId)
    .orderBy("entitlement_snapshot_capabilities.capability_order", "asc")
    .execute();
  if (rows.length === 0 || rows.some((row) => !["reviewed", "retired"].includes(row.status))) {
    throw new Error("Capability projection Snapshot is unavailable");
  }
  return createCapabilityRuntimeManifest({
    tenantId: input.tenantId,
    snapshotId: input.snapshotId,
    snapshotVersion: input.snapshotVersion,
    runtimeGeneration: input.runtimeGeneration,
    capabilities: rows.map((row) => ({
      capabilityId: row.capability_id,
      capabilityVersionId: row.capability_version_id,
      version: row.version,
      kind: row.kind,
      riskClass: row.risk_class,
    })),
  });
}

async function markSuperseded(
  trx: Transaction<RuntimeDatabase>,
  job: CapabilityProjectionWorkerJobRef,
  projectionId: string,
  now: Date,
): Promise<void> {
  await trx.updateTable("capability_runtime_projections").set({
    status: "failed",
    reason_code: "runtime_preparation_failed",
    resource_version: sql`resource_version + 1`,
    updated_at: now,
  }).where("tenant_id", "=", job.tenantId)
    .where("projection_id", "=", projectionId)
    .where("status", "=", "preparing").execute();
  await finishJob(trx, job, {
    status: "succeeded",
    lease_owner: null,
    lease_expires_at: null,
    last_error_summary: "Superseded by changed entitlement authority",
    updated_at: now,
  });
}

export class CapabilityProjectionRepository {
  public constructor(
    private readonly db: Kysely<RuntimeDatabase>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async prepare(job: CapabilityProjectionWorkerJobRef): Promise<CapabilityProjectionPreparationResult> {
    try {
      return await withDatabaseTransactionRetry(this.db, async (trx) => {
        await lockOwnedJob(trx, job);
        const projection = await trx.selectFrom("capability_runtime_projections")
          .innerJoin("entitlement_snapshots", (join) => join
            .onRef("entitlement_snapshots.tenant_id", "=", "capability_runtime_projections.tenant_id")
            .onRef("entitlement_snapshots.profile_id", "=", "capability_runtime_projections.profile_id")
            .onRef("entitlement_snapshots.snapshot_id", "=", "capability_runtime_projections.snapshot_id"))
          .select([
            "capability_runtime_projections.projection_id",
            "capability_runtime_projections.profile_id",
            "capability_runtime_projections.snapshot_id",
            "capability_runtime_projections.snapshot_version",
            "capability_runtime_projections.runtime_generation",
            "capability_runtime_projections.capability_manifest_digest",
            "capability_runtime_projections.tenant_pack_release_id",
            "capability_runtime_projections.status",
          ])
          .where("capability_runtime_projections.tenant_id", "=", job.tenantId)
          .where("capability_runtime_projections.projection_id", "=", job.projectionId)
          .forUpdate("capability_runtime_projections").executeTakeFirst();
        if (projection === undefined || projection.status !== "preparing") {
          await finishJob(trx, job, {
            status: "succeeded", lease_owner: null, lease_expires_at: null,
            last_error_summary: "Capability projection was already terminal", updated_at: this.now(),
          });
          return { kind: "superseded" } as const;
        }
        const runtimeId = deriveRuntimeContainerId(job.tenantId);
        const runtime = await trx.selectFrom("runtime_containers")
          .select(["generation", "image_ref"])
          .where("tenant_id", "=", job.tenantId)
          .where("container_id", "=", runtimeId)
          .forUpdate().executeTakeFirstOrThrow();
        const maximum = await trx.selectFrom("capability_runtime_projections")
          .select(sql<string>`coalesce(max(runtime_generation), 0)`.as("maximum"))
          .where("tenant_id", "=", job.tenantId).executeTakeFirstOrThrow();
        const storedGeneration = safePositiveInteger(projection.runtime_generation);
        const existing = await snapshotManifest(trx, {
          tenantId: job.tenantId,
          profileId: projection.profile_id,
          snapshotId: projection.snapshot_id,
          snapshotVersion: safePositiveInteger(projection.snapshot_version),
          runtimeGeneration: storedGeneration,
        });
        const hasReservedGeneration = storedGeneration > runtime.generation;
        const runtimeGeneration = hasReservedGeneration
          ? storedGeneration
          : Math.max(runtime.generation, safePositiveInteger(maximum.maximum)) + 1;
        if (!Number.isSafeInteger(runtimeGeneration)) throw new Error("Capability projection generation overflow");
        const created = hasReservedGeneration ? existing : await snapshotManifest(trx, {
          tenantId: job.tenantId,
          profileId: projection.profile_id,
          snapshotId: projection.snapshot_id,
          snapshotVersion: safePositiveInteger(projection.snapshot_version),
          runtimeGeneration,
        });
        if (
          storedGeneration !== runtimeGeneration
          || projection.capability_manifest_digest !== created.digest
        ) {
          await trx.updateTable("capability_runtime_projections").set({
            runtime_generation: runtimeGeneration,
            capability_manifest_digest: created.digest,
            resource_version: sql`resource_version + 1`,
            updated_at: this.now(),
          }).where("tenant_id", "=", job.tenantId)
            .where("projection_id", "=", projection.projection_id)
            .where("status", "=", "preparing").executeTakeFirstOrThrow();
        }
        const profiles = await trx.selectFrom("profiles").select("profile_id")
          .where("tenant_id", "=", job.tenantId)
          .where("status", "in", ["provisioning", "active"])
          .execute();
        if (profiles.length === 0) throw new Error("Capability projection Profiles are unavailable");
        const releaseStatus = projection.tenant_pack_release_id === null
          ? undefined
          : await trx.selectFrom("tenant_pack_releases").select("status")
            .where("tenant_id", "=", job.tenantId)
            .where("tenant_pack_release_id", "=", projection.tenant_pack_release_id)
            .executeTakeFirst();
        if (projection.tenant_pack_release_id !== null && releaseStatus?.status === "failed") {
          await markSuperseded(trx, job, projection.projection_id, this.now());
          return { kind: "superseded" } as const;
        }
        if (projection.tenant_pack_release_id !== null && releaseStatus?.status === "preparing") {
          const earlier = await trx.selectFrom("capability_runtime_projections")
            .select("projection_id")
            .where("tenant_id", "=", job.tenantId)
            .where("tenant_pack_release_id", "=", projection.tenant_pack_release_id)
            .where("status", "=", "preparing")
            .where("runtime_generation", "<", projection.runtime_generation)
            .executeTakeFirst();
          if (earlier !== undefined) throw new Error("Earlier Pack release projection Profile is still preparing");
        }
        const expectedProfileIds = Object.freeze(profiles.map((row) => row.profile_id).sort(utf8Compare));
        return Object.freeze({
          kind: "ready" as const,
          facts: Object.freeze({
            tenantId: job.tenantId,
            projectionId: projection.projection_id,
            profileId: projection.profile_id,
            snapshotId: projection.snapshot_id,
            snapshotVersion: safePositiveInteger(projection.snapshot_version),
            runtimeId,
            runtimeGeneration,
            imageRef: runtime.image_ref,
            expectedProfileIds,
            manifest: created.manifest,
            manifestDigest: created.digest,
            ...(projection.tenant_pack_release_id !== null && releaseStatus?.status === "preparing"
              ? { candidateReleaseId: projection.tenant_pack_release_id }
              : {}),
          }),
        });
      }, { isolationLevel: "serializable" });
    } catch (error) {
      if (error instanceof ProjectionLeaseLost) return { kind: "lease_lost" };
      throw error;
    }
  }

  public async complete(
    job: CapabilityProjectionWorkerJobRef,
    facts: StoredCapabilityProjectionFacts,
    observation: CapabilityRuntimeObservation,
  ): Promise<CapabilityProjectionCompletionResult> {
    try {
      return await withDatabaseTransactionRetry(this.db, async (trx) => {
        await lockOwnedJob(trx, job, "unsafe_to_replay");
        if (!sameObservation(facts, observation)) throw new Error("Capability projection observation mismatch");
        let sources;
        try {
          const release = facts.candidateReleaseId === undefined
            ? undefined
            : await trx.selectFrom("tenant_pack_releases").select("status")
              .where("tenant_id", "=", facts.tenantId)
              .where("tenant_pack_release_id", "=", facts.candidateReleaseId)
              .forUpdate().executeTakeFirst();
          sources = await loadEffectiveCapabilitySources(
            trx,
            facts.tenantId,
            facts.profileId,
            this.now(),
            release?.status === "preparing" ? facts.candidateReleaseId : undefined,
          );
        } catch {
          await markSuperseded(trx, job, facts.projectionId, this.now());
          return { kind: "superseded" } as const;
        }
        const effective = resolveEffectiveCapabilities(sources);
        const expectedTriples = facts.manifest.capabilities.map((capability) =>
          `${capability.capability_id}\0${capability.capability_version_id}\0${capability.version}`);
        const actualTriples = effective.capabilities.map((capability) =>
          `${capability.capabilityId}\0${capability.capabilityVersionId}\0${capability.version}`);
        if (expectedTriples.length !== actualTriples.length || expectedTriples.some((value, index) => value !== actualTriples[index])) {
          await markSuperseded(trx, job, facts.projectionId, this.now());
          return { kind: "superseded" } as const;
        }
        const projection = await trx.selectFrom("capability_runtime_projections")
          .select(["projection_id", "status", "runtime_generation", "capability_manifest_digest", "snapshot_id", "snapshot_version", "evaluated_at", "profile_id"])
          .where("tenant_id", "=", facts.tenantId)
          .where("projection_id", "=", facts.projectionId)
          .forUpdate().executeTakeFirst();
        const runtime = await trx.selectFrom("runtime_containers")
          .select(["generation", "image_ref"])
          .where("tenant_id", "=", facts.tenantId)
          .where("container_id", "=", facts.runtimeId)
          .forUpdate().executeTakeFirst();
        if (
          projection?.status !== "preparing"
          || projection.profile_id !== facts.profileId
          || projection.snapshot_id !== facts.snapshotId
          || safePositiveInteger(projection.runtime_generation) !== facts.runtimeGeneration
          || projection.capability_manifest_digest !== facts.manifestDigest
          || runtime === undefined
          || runtime.image_ref !== facts.imageRef
          || runtime.generation >= facts.runtimeGeneration
        ) {
          await markSuperseded(trx, job, facts.projectionId, this.now());
          return { kind: "superseded" } as const;
        }
        const now = this.now();
        let completedProjections = [projection];
        let candidateFinalized = false;
        if (facts.candidateReleaseId !== undefined) {
          const candidate = await trx.selectFrom("tenant_pack_releases")
            .select(["pack_product_id", "pack_version_id", "pack_version", "status"])
            .where("tenant_id", "=", facts.tenantId)
            .where("tenant_pack_release_id", "=", facts.candidateReleaseId)
            .forUpdate().executeTakeFirst();
          if (candidate?.status !== "preparing") {
            await markSuperseded(trx, job, facts.projectionId, now);
            return { kind: "superseded" } as const;
          }
          const releaseProjections = await trx.selectFrom("capability_runtime_projections")
            .select([
              "projection_id", "profile_id", "snapshot_id", "snapshot_version", "evaluated_at",
              "runtime_generation", "capability_manifest_digest", "status",
            ])
            .where("tenant_id", "=", facts.tenantId)
            .where("tenant_pack_release_id", "=", facts.candidateReleaseId)
            .orderBy("profile_id", "asc")
            .forUpdate().execute();
          if (
            releaseProjections.length === 0
            || releaseProjections.some((row) => row.status === "failed")
          ) {
            await markSuperseded(trx, job, facts.projectionId, now);
            return { kind: "superseded" } as const;
          }
          const otherPending = releaseProjections.some((row) =>
            row.projection_id !== facts.projectionId && row.status === "preparing");
          if (!otherPending && releaseProjections.some((row) =>
            row.projection_id !== facts.projectionId && row.status !== "available")) {
            throw new Error("Pack release projection state is invalid");
          }
          await trx.updateTable("capability_runtime_projections").set({
            status: "available", reason_code: null,
            resource_version: sql`resource_version + 1`, updated_at: now,
          }).where("tenant_id", "=", facts.tenantId)
            .where("projection_id", "=", facts.projectionId)
            .where("status", "=", "preparing").executeTakeFirstOrThrow();
          if (otherPending) {
            await finishJob(trx, job, {
              status: "succeeded", lease_owner: null, lease_expires_at: null,
              last_error_summary: null, updated_at: now,
            });
            return { kind: "completed" } as const;
          }
          completedProjections = releaseProjections;
          candidateFinalized = true;
          await trx.updateTable("tenant_pack_releases").set({
            status: "superseded", resource_version: sql`resource_version + 1`, updated_at: now,
          }).where("tenant_id", "=", facts.tenantId)
            .where("pack_product_id", "=", candidate.pack_product_id)
            .where("status", "=", "current").execute();
          await trx.updateTable("tenant_pack_releases").set({
            status: "current", resource_version: sql`resource_version + 1`, updated_at: now,
          }).where("tenant_id", "=", facts.tenantId)
            .where("tenant_pack_release_id", "=", facts.candidateReleaseId).executeTakeFirstOrThrow();
          await trx.updateTable("entitlements").set({
            tenant_pack_release_id: facts.candidateReleaseId,
            pack_version_id: candidate.pack_version_id,
            pack_version: candidate.pack_version,
            resource_version: sql`resource_version + 1`,
            updated_at: now,
          }).where("tenant_id", "=", facts.tenantId)
            .where("pack_product_id", "=", candidate.pack_product_id)
            .where("status", "=", "active").execute();
          for (const releaseProjection of releaseProjections) {
            const pointer = await trx.selectFrom("profile_snapshot_pointers")
              .select("resource_version")
              .where("tenant_id", "=", facts.tenantId)
              .where("profile_id", "=", releaseProjection.profile_id)
              .forUpdate().executeTakeFirst();
            const expectedVersion = pointer === undefined ? 0 : safePositiveInteger(pointer.resource_version);
            await sql`select * from advance_profile_snapshot_pointer(
              ${facts.tenantId}, ${releaseProjection.profile_id}, ${expectedVersion}, ${releaseProjection.snapshot_id}
            )`.execute(trx);
          }
        }
        if (!candidateFinalized) {
          await trx.updateTable("capability_runtime_projections").set({
            status: "available", reason_code: null,
            resource_version: sql`resource_version + 1`, updated_at: now,
          }).where("tenant_id", "=", facts.tenantId)
            .where("projection_id", "=", facts.projectionId)
            .where("status", "=", "preparing").executeTakeFirstOrThrow();
        }
        const completedProfileIds = completedProjections.map((row) => row.profile_id);
        await trx.updateTable("entitlement_assignments").set({
          status: "available", reason_code: "seat_assigned",
          resource_version: sql`resource_version + 1`, updated_at: now,
        }).where("tenant_id", "=", facts.tenantId)
          .where("profile_id", "in", completedProfileIds)
          .where("status", "=", "preparing").execute();
        await trx.updateTable("runtime_containers").set({
          generation: facts.runtimeGeneration,
          capability_manifest_digest: facts.manifestDigest,
          desired_state: "running",
          observed_state: "ready",
          health_status: "healthy",
          last_probed_at: now,
          failure_summary: null,
          resource_version: sql`resource_version + 1`,
          updated_at: now,
        }).where("tenant_id", "=", facts.tenantId)
          .where("container_id", "=", facts.runtimeId)
          .where("generation", "<", facts.runtimeGeneration).executeTakeFirstOrThrow();
        for (const completedProjection of completedProjections) {
          const event = {
            schema_version: 1,
            event_id: derivedProjectionId(
              "event_service_available",
              completedProjection.projection_id,
              String(completedProjection.runtime_generation),
            ),
            occurred_at: now.toISOString(),
            tenant_id: facts.tenantId,
            request_id: derivedProjectionId("request_projection", job.jobId),
            trace_id: derivedProjectionId("trace_projection", job.jobId),
            correlation_id: derivedProjectionId(
              "correlation_projection",
              completedProjection.projection_id,
            ),
            causation_id: derivedProjectionId("causation_projection", job.jobId),
            profile_id: completedProjection.profile_id,
            event_type: "service.available",
            payload: {
              profile_id: completedProjection.profile_id,
              generation: safePositiveInteger(completedProjection.runtime_generation),
              entitlement_snapshot_ref: {
                snapshot_id: completedProjection.snapshot_id,
                version: safePositiveInteger(completedProjection.snapshot_version),
                evaluated_at: completedProjection.evaluated_at.toISOString(),
              },
              state: "available",
            },
          } as unknown as ProductEventWithoutSequence;
          await appendProductEvents(
            { tenantId: facts.tenantId, trx },
            { streamId: completedProjection.profile_id, deliveryTarget: "internal_event_stream", events: [event] },
          );
        }
        await finishJob(trx, job, {
          status: "succeeded", lease_owner: null, lease_expires_at: null,
          last_error_summary: null, updated_at: now,
        });
        return { kind: "completed" } as const;
      }, { isolationLevel: "serializable" });
    } catch (error) {
      if (error instanceof ProjectionLeaseLost) return { kind: "lease_lost" };
      throw error;
    }
  }

  public async retry(
    job: CapabilityProjectionWorkerJobRef,
    summary: string,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const result = await this.db.updateTable("worker_jobs").set({
      status: "retrying", lease_owner: null, lease_expires_at: null,
      next_attempt_at: nextAttemptAt, last_error_summary: summary.slice(0, 500), updated_at: this.now(),
    }).where("tenant_id", "=", job.tenantId)
      .where("job_id", "=", job.jobId)
      .where("job_kind", "=", "reconcile_capability_projection")
      .where("payload_ref", "=", job.projectionId)
      .where("attempt_count", "=", job.attemptCount)
      .where("lease_owner", "=", job.workerId)
      .where("status", "=", "running")
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  public async fail(
    job: CapabilityProjectionWorkerJobRef,
    reasonCode: "runtime_preparation_failed" | "runtime_health_check_failed" | "capability_manifest_mismatch",
    summary: string,
  ): Promise<CapabilityProjectionFailureResult> {
    try {
      return await withDatabaseTransactionRetry(this.db, async (trx) => {
        await lockOwnedJob(trx, job);
        const projection = await trx.selectFrom("capability_runtime_projections")
          .select([
            "status", "profile_id", "tenant_pack_release_id", "snapshot_id", "snapshot_version",
            "evaluated_at", "runtime_generation",
          ]).where("tenant_id", "=", job.tenantId)
          .where("projection_id", "=", job.projectionId).forUpdate().executeTakeFirst();
        if (projection?.status !== "preparing") {
          await finishJob(trx, job, {
            status: "succeeded", lease_owner: null, lease_expires_at: null,
            last_error_summary: "Capability projection was already terminal", updated_at: this.now(),
          });
          return { kind: "superseded" } as const;
        }
        const now = this.now();
        const release = projection.tenant_pack_release_id === null
          ? undefined
          : await trx.selectFrom("tenant_pack_releases").select("status")
            .where("tenant_id", "=", job.tenantId)
            .where("tenant_pack_release_id", "=", projection.tenant_pack_release_id)
            .forUpdate().executeTakeFirst();
        const candidateFailure = release?.status === "preparing";
        let failedProjectionUpdate = trx.updateTable("capability_runtime_projections").set({
          status: "failed", reason_code: reasonCode,
          resource_version: sql`resource_version + 1`, updated_at: now,
        }).where("tenant_id", "=", job.tenantId);
        failedProjectionUpdate = candidateFailure
          ? failedProjectionUpdate
            .where("tenant_pack_release_id", "=", projection.tenant_pack_release_id)
            .where("status", "in", ["preparing", "available"])
          : failedProjectionUpdate
            .where("projection_id", "=", job.projectionId)
            .where("status", "=", "preparing");
        await failedProjectionUpdate.execute();
        if (candidateFailure) {
          await trx.updateTable("tenant_pack_releases").set({
            status: "failed",
            resource_version: sql`resource_version + 1`,
            updated_at: now,
          }).where("tenant_id", "=", job.tenantId)
            .where("tenant_pack_release_id", "=", projection.tenant_pack_release_id)
            .where("status", "=", "preparing").executeTakeFirstOrThrow();
        } else {
          await trx.updateTable("entitlement_assignments").set({
            status: "failed", reason_code: "runtime_preparation_failed",
            resource_version: sql`resource_version + 1`, updated_at: now,
          }).where("tenant_id", "=", job.tenantId)
            .where("profile_id", "=", projection.profile_id)
            .where("status", "=", "preparing").execute();
        }
        const event = {
          schema_version: 1,
          event_id: derivedProjectionId("event_service_failed", job.projectionId, String(projection.runtime_generation)),
          occurred_at: now.toISOString(),
          tenant_id: job.tenantId,
          request_id: derivedProjectionId("request_projection", job.jobId),
          trace_id: derivedProjectionId("trace_projection", job.jobId),
          correlation_id: derivedProjectionId("correlation_projection", job.projectionId),
          causation_id: derivedProjectionId("causation_projection", job.jobId),
          profile_id: projection.profile_id,
          event_type: "service.failed",
          payload: {
            profile_id: projection.profile_id,
            generation: safePositiveInteger(projection.runtime_generation),
            entitlement_snapshot_ref: {
              snapshot_id: projection.snapshot_id,
              version: safePositiveInteger(projection.snapshot_version),
              evaluated_at: projection.evaluated_at.toISOString(),
            },
            state: "failed",
            reason_code: reasonCode,
          },
        } as unknown as ProductEventWithoutSequence;
        await appendProductEvents(
          { tenantId: job.tenantId, trx },
          { streamId: projection.profile_id, deliveryTarget: "internal_event_stream", events: [event] },
        );
        await finishJob(trx, job, {
          status: "failed", lease_owner: null, lease_expires_at: null,
          last_error_summary: summary.slice(0, 500), updated_at: now,
        });
        return { kind: "failed" } as const;
      }, { isolationLevel: "serializable" });
    } catch (error) {
      if (error instanceof ProjectionLeaseLost) return { kind: "lease_lost" };
      throw error;
    }
  }
}

export function capabilityProjectionJobId(projectionId: string): string {
  return `job_capability_projection_${createHash("sha256").update(projectionId, "utf8").digest("hex").slice(0, 32)}`;
}
