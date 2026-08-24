import { createHash } from "node:crypto";

import {
  SelectTenantPackReleaseRequestSchema,
  type SelectTenantPackReleaseRequest,
} from "@core-agent/contracts";
import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
  DomainError,
} from "../../domain/idempotency.js";
import {
  lockTenantPackReleases,
  tenantHasActivePackAuthority,
} from "../../repositories/entitlements/releases.js";
import {
  databaseClock,
  requireActiveTenant,
  requirePlatformEntitlementAuthority,
  type EntitlementCommandContext,
  type EntitlementTransactionDependencies,
} from "./authority.js";
import { validateEntitlementCommand } from "./command-validation.js";
import { appendEntitlementLifecycleEffects } from "./transaction-effects.js";

export interface SelectTenantPackReleaseDependencies extends EntitlementTransactionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

export interface TenantPackReleaseSelectionResult {
  readonly kind: "current" | "preparing" | "replay";
  readonly releaseId: string;
  readonly generation: number;
}

const operation = "entitlements.release.select";
const idempotencyLifetimeMs = 24 * 60 * 60 * 1_000;

function releaseId(input: SelectTenantPackReleaseRequest, generation: number): string {
  return `tenant_pack_release_${createHash("sha256")
    .update(`${input.tenant_id}\0${input.pack_product_id}\0${input.pack_version_id}\0${generation}`, "utf8")
    .digest("hex").slice(0, 32)}`;
}

function storedReplay(value: unknown): TenantPackReleaseSelectionResult {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { releaseId?: unknown }).releaseId !== "string"
    || !Number.isSafeInteger((value as { generation?: unknown }).generation)
  ) throw new DomainError("INTERNAL_ERROR", "Stored release selection response is invalid");
  return Object.freeze({
    kind: "replay",
    releaseId: (value as { releaseId: string }).releaseId,
    generation: (value as { generation: number }).generation,
  });
}

export async function selectTenantPackRelease(
  dependencies: SelectTenantPackReleaseDependencies,
  context: EntitlementCommandContext,
  raw: unknown,
): Promise<TenantPackReleaseSelectionResult> {
  const input = validateEntitlementCommand<SelectTenantPackReleaseRequest>(SelectTenantPackReleaseRequestSchema, raw);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const authority = await requirePlatformEntitlementAuthority(trx, dependencies, context);
    const now = await databaseClock(dependencies, trx);
    const tenant = await requireActiveTenant(trx, input.tenant_id);
    const admission = await beginIdempotentCommand<TenantPackReleaseSelectionResult>(
      { tenantId: input.tenant_id, trx },
      {
        key: input.idempotency_key,
        payloadHash: input.payload_hash,
        operation,
        now,
        expiresAt: new Date(now.getTime() + idempotencyLifetimeMs),
      },
    );
    if (admission.kind === "replay") return storedReplay(admission.response);
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Release selection is already in progress");

    const pack = await trx.selectFrom("pack_versions")
      .innerJoin("pack_products", "pack_products.pack_product_id", "pack_versions.pack_product_id")
      .select([
        "pack_versions.pack_version_id",
        "pack_versions.pack_product_id",
        "pack_versions.version",
        "pack_versions.status",
        "pack_products.tenant_modes",
      ])
      .where("pack_versions.pack_version_id", "=", input.pack_version_id)
      .where("pack_versions.pack_product_id", "=", input.pack_product_id)
      .forUpdate("pack_products")
      .forUpdate("pack_versions")
      .executeTakeFirst();
    if (pack === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Published Pack Version was not found");
    if (
      pack.status !== "published"
      || (tenant.tenant_mode !== "b2b" && tenant.tenant_mode !== "b2c")
      || !pack.tenant_modes.includes(tenant.tenant_mode)
    ) {
      throw new DomainError("INVALID_STATE_TRANSITION", "Pack Version is not eligible for this Tenant");
    }

    const history = await lockTenantPackReleases(trx, input.tenant_id, input.pack_product_id);
    const current = history.find((candidate) => candidate.status === "current");
    if ((current === undefined ? 1 : Number(current.resource_version)) !== input.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Tenant Pack Release changed");
    }
    const generation = history.reduce((maximum, candidate) => Math.max(maximum, Number(candidate.generation)), 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new DomainError("INTERNAL_ERROR", "Stored release generation is invalid");
    const identifier = releaseId(input, generation);
    const hasAuthority = await tenantHasActivePackAuthority(trx, input.tenant_id, input.pack_product_id, now);
    const desiredStatus = hasAuthority === undefined ? "current" : "preparing";

    await trx.insertInto("tenant_pack_releases").values({
      tenant_pack_release_id: identifier,
      tenant_id: input.tenant_id,
      pack_product_id: input.pack_product_id,
      pack_version_id: input.pack_version_id,
      pack_version: pack.version,
      generation,
      status: "preparing",
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    if (desiredStatus === "current") {
      if (current !== undefined) {
        await trx.updateTable("tenant_pack_releases").set({
          status: "superseded",
          resource_version: Number(current.resource_version) + 1,
          updated_at: now,
        }).where("tenant_pack_release_id", "=", current.tenant_pack_release_id).execute();
      }
      await trx.updateTable("tenant_pack_releases").set({ status: "current", updated_at: now })
        .where("tenant_pack_release_id", "=", identifier).execute();
    }

    const result: TenantPackReleaseSelectionResult = Object.freeze({
      kind: desiredStatus,
      releaseId: identifier,
      generation,
    });
    await appendEntitlementLifecycleEffects(trx, authority, context, {
      tenantId: input.tenant_id,
      resourceType: "tenant_pack_release",
      resourceId: identifier,
      resourceVersion: 1,
      operation,
      idempotencyKey: input.idempotency_key,
      ...(desiredStatus === "current" ? {
        eventType: "pack.release_selected",
        eventPayload: {
          tenant_pack_release_id: identifier,
          pack_product_id: input.pack_product_id,
          pack_version_id: input.pack_version_id,
          generation,
          status: "current",
          resource_version: 1,
        },
      } : {}),
      ...(desiredStatus === "preparing" ? { reconcilePayloadRef: identifier } : {}),
      now,
    });
    await completeIdempotentCommand({ tenantId: input.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      resultRef: identifier,
      response: result,
      updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}
