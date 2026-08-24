import { createHash } from "node:crypto";

import {
  ChangeEntitlementStatusRequestSchema,
  GrantEntitlementRequestSchema,
  type ChangeEntitlementStatusRequest,
  type GrantEntitlementRequest,
} from "@core-agent/contracts";
import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import {
  beginIdempotentCommand,
  completeIdempotentCommand,
  DomainError,
} from "../../domain/idempotency.js";
import { lockEntitlement } from "../../repositories/entitlements/entitlements.js";
import { lockCurrentTenantPackRelease } from "../../repositories/entitlements/releases.js";
import {
  databaseClock,
  requireActiveTenant,
  requirePlatformEntitlementAuthority,
  type EntitlementCommandContext,
  type EntitlementTransactionDependencies,
} from "./authority.js";
import { validateEntitlementCommand } from "./command-validation.js";
import { resolveProfileSnapshotInTransaction } from "./resolve-profile-snapshot.js";
import { appendEntitlementLifecycleEffects } from "./transaction-effects.js";

export interface ManageEntitlementDependencies extends EntitlementTransactionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

export interface EntitlementWriteResult {
  readonly schema_version: 1;
  readonly entitlement_id: string;
  readonly tenant_id: string;
  readonly pack_product_id: string;
  readonly status: "active" | "suspended" | "revoked" | "expired";
  readonly reason_code: "platform_grant" | "administrator_suspended" | "administrator_reactivated" | "platform_revoked" | "validity_expired";
  readonly resource_version: number;
  readonly valid_from: string;
  readonly expires_at?: string;
  readonly seat_quantity?: number;
}

const dayMs = 24 * 60 * 60 * 1_000;

function identifier(prefix: string, ...values: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(values.join("\0"), "utf8").digest("hex").slice(0, 32)}`;
}

function rowResult(row: {
  entitlement_id: string;
  tenant_id: string;
  pack_product_id: string;
  status: EntitlementWriteResult["status"];
  reason_code: EntitlementWriteResult["reason_code"];
  resource_version: string;
  valid_from: Date;
  expires_at: Date | null;
  seat_quantity: number | null;
}): EntitlementWriteResult {
  const resourceVersion = Number(row.resource_version);
  if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1) {
    throw new DomainError("INTERNAL_ERROR", "Stored Entitlement resource version is invalid");
  }
  return Object.freeze({
    schema_version: 1,
    entitlement_id: row.entitlement_id,
    tenant_id: row.tenant_id,
    pack_product_id: row.pack_product_id,
    status: row.status,
    reason_code: row.reason_code,
    resource_version: resourceVersion,
    valid_from: row.valid_from.toISOString(),
    ...(row.expires_at === null ? {} : { expires_at: row.expires_at.toISOString() }),
    ...(row.seat_quantity === null ? {} : { seat_quantity: row.seat_quantity }),
  });
}

function replay(value: unknown): EntitlementWriteResult {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || typeof (value as { entitlement_id?: unknown }).entitlement_id !== "string"
    || typeof (value as { status?: unknown }).status !== "string"
  ) throw new DomainError("INTERNAL_ERROR", "Stored Entitlement response is invalid");
  return Object.freeze({ ...(value as EntitlementWriteResult) });
}

async function lockAffectedProfiles(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  tenantMode: "b2b" | "b2c",
  entitlementId?: string,
): Promise<readonly string[]> {
  const query = tenantMode === "b2c"
    ? trx.selectFrom("profiles").select("profile_id")
      .where("tenant_id", "=", tenantId).where("status", "=", "active")
    : trx.selectFrom("profiles")
      .innerJoin("entitlement_assignments", (join) => join
        .onRef("entitlement_assignments.tenant_id", "=", "profiles.tenant_id")
        .onRef("entitlement_assignments.profile_id", "=", "profiles.profile_id"))
      .select("profiles.profile_id")
      .where("profiles.tenant_id", "=", tenantId)
      .where("entitlement_assignments.entitlement_id", "=", entitlementId ?? "")
      .where("entitlement_assignments.status", "in", ["preparing", "available", "suspended"]);
  const profiles = await query.orderBy("profile_id", "asc").forUpdate("profiles").execute();
  const profileIds = [...new Set(profiles.map((profile) => profile.profile_id))];
  for (const profileId of profileIds) {
    await trx.selectFrom("profile_snapshot_pointers").select("profile_id")
      .where("tenant_id", "=", tenantId).where("profile_id", "=", profileId)
      .forUpdate().executeTakeFirst();
  }
  return Object.freeze(profileIds);
}

function transitionEvent(status: EntitlementWriteResult["status"]): string {
  if (status === "active") return "entitlement.activated";
  if (status === "suspended") return "entitlement.suspended";
  if (status === "revoked") return "entitlement.revoked";
  return "entitlement.expired";
}

async function resolveAffectedProfiles(
  trx: Transaction<RuntimeDatabase>,
  now: Date,
  authority: { authorityTenantId: string; membershipId: string },
  context: EntitlementCommandContext,
  tenantId: string,
  profileIds: readonly string[],
): Promise<void> {
  for (const profileId of profileIds) {
    await resolveProfileSnapshotInTransaction({
      trx,
      now,
      tenantId,
      profileId,
      evidence: {
        actorId: context.performingActorId,
        membershipId: authority.membershipId,
        auditTenantId: authority.authorityTenantId,
        requestId: context.requestId,
        traceId: context.traceId,
      },
    });
  }
}

export async function grantEntitlement(
  dependencies: ManageEntitlementDependencies,
  context: EntitlementCommandContext,
  raw: unknown,
): Promise<EntitlementWriteResult> {
  const input = validateEntitlementCommand<GrantEntitlementRequest>(GrantEntitlementRequestSchema, raw);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const authority = await requirePlatformEntitlementAuthority(trx, dependencies, context);
    const now = await databaseClock(dependencies, trx);
    const tenant = await requireActiveTenant(trx, input.tenant_id);
    if (tenant.tenant_mode !== input.tenant_mode || input.expected_resource_version !== 1) {
      throw new DomainError("INVALID_REQUEST", "Entitlement grant mode or initial version is invalid");
    }
    const operation = "entitlements.entitlement.grant";
    const admission = await beginIdempotentCommand<EntitlementWriteResult>({ tenantId: input.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") return replay(admission.response);
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Entitlement grant is already in progress");

    const release = await lockCurrentTenantPackRelease(trx, input.tenant_id, input.pack_product_id);
    if (release === undefined) throw new DomainError("INVALID_STATE_TRANSITION", "A current Pack Release is required");
    const existingOrder = await trx.selectFrom("entitlements").selectAll()
      .where("tenant_id", "=", input.tenant_id)
      .where("source", "=", "platform_manual")
      .where("external_order_ref", "=", input.external_order_ref)
      .forUpdate().executeTakeFirst();
    if (existingOrder !== undefined) throw new DomainError("IDEMPOTENCY_CONFLICT", "External order identity is already bound");
    const expiresAt = input.expires_at === undefined ? null : new Date(input.expires_at);
    if (expiresAt !== null && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime())) {
      throw new DomainError("INVALID_REQUEST", "Entitlement expiry must be after the database grant time");
    }
    const entitlementId = identifier("entitlement", input.tenant_id, input.source, input.external_order_ref);
    await trx.insertInto("entitlements").values({
      entitlement_id: entitlementId,
      tenant_id: input.tenant_id,
      pack_product_id: input.pack_product_id,
      tenant_pack_release_id: release.tenant_pack_release_id,
      pack_version_id: release.pack_version_id,
      pack_version: release.pack_version,
      source: "platform_manual",
      external_order_ref: input.external_order_ref,
      tenant_mode: input.tenant_mode,
      assignment_mode: input.assignment_mode,
      seat_quantity: input.tenant_mode === "b2b" ? input.seat_quantity : null,
      valid_from: now,
      expires_at: expiresAt,
      status: "active",
      reason_code: "platform_grant",
      resource_version: 1,
      created_at: now,
      updated_at: now,
    }).execute();
    const profileIds = await lockAffectedProfiles(trx, input.tenant_id, input.tenant_mode, entitlementId);
    const result = rowResult({
      entitlement_id: entitlementId,
      tenant_id: input.tenant_id,
      pack_product_id: input.pack_product_id,
      status: "active",
      reason_code: "platform_grant",
      resource_version: "1",
      valid_from: now,
      expires_at: expiresAt,
      seat_quantity: input.tenant_mode === "b2b" ? input.seat_quantity : null,
    });
    await appendEntitlementLifecycleEffects(trx, authority, context, {
      tenantId: input.tenant_id,
      resourceType: "entitlement",
      resourceId: entitlementId,
      resourceVersion: 1,
      operation,
      idempotencyKey: input.idempotency_key,
      eventType: "entitlement.activated",
      eventPayload: {
        entitlement_id: entitlementId,
        pack_product_id: input.pack_product_id,
        status: "active",
        reason_code: "platform_grant",
        resource_version: 1,
      },
      reconcilePayloadRef: profileIds[0] ?? entitlementId,
      now,
    });
    await resolveAffectedProfiles(trx, now, authority, context, input.tenant_id, profileIds);
    await completeIdempotentCommand({ tenantId: input.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      resultRef: entitlementId,
      response: result,
      updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}

export async function changeEntitlementStatus(
  dependencies: ManageEntitlementDependencies,
  context: EntitlementCommandContext,
  raw: unknown,
): Promise<EntitlementWriteResult> {
  const input = validateEntitlementCommand<ChangeEntitlementStatusRequest>(ChangeEntitlementStatusRequestSchema, raw);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const authority = await requirePlatformEntitlementAuthority(trx, dependencies, context);
    const now = await databaseClock(dependencies, trx);
    const discovered = await trx.selectFrom("entitlements")
      .select(["tenant_id", "pack_product_id"])
      .where("entitlement_id", "=", input.entitlement_id).executeTakeFirst();
    if (discovered === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Entitlement was not found");
    await requireActiveTenant(trx, discovered.tenant_id);
    const release = await lockCurrentTenantPackRelease(trx, discovered.tenant_id, discovered.pack_product_id);
    if (release === undefined) throw new DomainError("INVALID_STATE_TRANSITION", "A current Pack Release is required");
    const row = await lockEntitlement(trx, input.entitlement_id);
    if (
      row === undefined
      || row.tenant_id !== discovered.tenant_id
      || row.pack_product_id !== discovered.pack_product_id
    ) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Entitlement changed");
    const operation = `entitlements.entitlement.${input.status}`;
    const admission = await beginIdempotentCommand<EntitlementWriteResult>({ tenantId: row.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      now,
      expiresAt: new Date(now.getTime() + dayMs),
    });
    if (admission.kind === "replay") return replay(admission.response);
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Entitlement transition is already in progress");
    const resourceVersion = Number(row.resource_version);
    if (resourceVersion !== input.expected_resource_version) {
      throw new DomainError("RESOURCE_VERSION_CONFLICT", "Entitlement changed");
    }
    const allowed = input.status === "active"
      ? row.status === "suspended" && (row.expires_at === null || now < row.expires_at)
      : input.status === "suspended"
        ? row.status === "active"
        : row.status === "active" || row.status === "suspended";
    if (!allowed) throw new DomainError("INVALID_STATE_TRANSITION", "Entitlement transition is not allowed");
    const nextVersion = resourceVersion + 1;
    await trx.updateTable("entitlements").set({
      status: input.status,
      reason_code: input.reason_code,
      resource_version: nextVersion,
      updated_at: now,
    }).where("entitlement_id", "=", row.entitlement_id).execute();
    const profileIds = await lockAffectedProfiles(trx, row.tenant_id, row.tenant_mode, row.entitlement_id);
    const result = rowResult({ ...row, status: input.status, reason_code: input.reason_code, resource_version: String(nextVersion) });
    await appendEntitlementLifecycleEffects(trx, authority, context, {
      tenantId: row.tenant_id,
      resourceType: "entitlement",
      resourceId: row.entitlement_id,
      resourceVersion: nextVersion,
      operation,
      idempotencyKey: input.idempotency_key,
      eventType: transitionEvent(input.status),
      eventPayload: {
        entitlement_id: row.entitlement_id,
        pack_product_id: row.pack_product_id,
        status: input.status,
        reason_code: input.reason_code,
        resource_version: nextVersion,
      },
      reconcilePayloadRef: profileIds[0] ?? row.entitlement_id,
      now,
    });
    await resolveAffectedProfiles(trx, now, authority, context, row.tenant_id, profileIds);
    await completeIdempotentCommand({ tenantId: row.tenant_id, trx }, {
      key: input.idempotency_key,
      payloadHash: input.payload_hash,
      operation,
      resultRef: row.entitlement_id,
      response: result,
      updatedAt: now,
    });
    return result;
  }, { isolationLevel: "serializable" });
}
