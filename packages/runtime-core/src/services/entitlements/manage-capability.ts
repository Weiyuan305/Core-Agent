import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { beginIdempotentCommand, completeIdempotentCommand, DomainError } from "../../domain/idempotency.js";
import { appendCatalogLifecycleEvent, lockCapabilityVersion } from "../../repositories/entitlements/catalog.js";
import { canonicalCompatibility, validateCatalogCommandInput, validateCatalogTransition, type ValidatedCapabilityCreate, type ValidatedVersionTransition } from "./catalog-validation.js";

export interface CatalogCommandDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly now?: () => Date;
  readonly knownContractRefs: readonly string[];
  readonly platformCompatibility: { readonly core_contract_version: string; readonly runtime_protocol_version: string };
}
export interface CatalogCommandContext { readonly performingActorId: string; readonly requestId: string; readonly traceId: string; }
export interface CapabilityWriteResult { readonly schema_version: 1; readonly capability_version_id: string; readonly capability_id: string; readonly version: string; readonly status: "draft" | "reviewed" | "retired" | "blocked"; readonly resource_version: number; readonly compatibility_hash?: string; }

const dayMs = 24 * 60 * 60 * 1_000;
function safeVersion(value: string): number { const number = Number(value); if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1) throw new DomainError("INTERNAL_ERROR", "Stored catalog version is invalid"); return number; }
function safeContext(context: CatalogCommandContext): void { if ([context.performingActorId, context.requestId, context.traceId].some((value) => typeof value !== "string" || value.length < 1 || value.length > 255)) throw new DomainError("INVALID_REQUEST", "Catalog command context is invalid"); }
function auditId(key: string, action: string): string { return `audit_catalog_${createHash("sha256").update(`${key}:${action}`, "utf8").digest("hex").slice(0, 32)}`; }
function eventId(key: string, action: string): string { return `event_catalog_${createHash("sha256").update(`${key}:${action}`, "utf8").digest("hex").slice(0, 32)}`; }
async function platformScope(trx: Transaction<RuntimeDatabase>, context: CatalogCommandContext): Promise<{ tenantId: string; membershipId: string }> {
  const actor = await trx.selectFrom("actors").select("status").where("actor_id", "=", context.performingActorId).forUpdate().executeTakeFirst();
  if (actor?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active platform authority is required");
  const role = await trx.selectFrom("platform_role_assignments").select("status").where("actor_id", "=", context.performingActorId).where("role", "=", "platform_super_admin").forUpdate().executeTakeFirst();
  if (role?.status !== "active") throw new DomainError("UNAUTHENTICATED", "Active platform authority is required");
  const membership = await trx.selectFrom("memberships").select(["tenant_id", "membership_id"]).where("actor_id", "=", context.performingActorId).where("membership_source", "=", "platform").where("status", "=", "active").orderBy("tenant_id", "asc").orderBy("membership_id", "asc").forUpdate().executeTakeFirst();
  if (membership === undefined) throw new DomainError("UNAUTHENTICATED", "Active platform authority is required");
  return { tenantId: membership.tenant_id, membershipId: membership.membership_id };
}
async function appendPlatformAudit(trx: Transaction<RuntimeDatabase>, scope: { tenantId: string; membershipId: string }, context: CatalogCommandContext, idempotencyKey: string, action: string, resourceId: string, resourceVersion: number, now: Date): Promise<void> {
  await trx.insertInto("platform_authority_audit").values({ platform_authority_audit_id: auditId(idempotencyKey, action), authority_tenant_id: scope.tenantId, actor_id: context.performingActorId, membership_id: scope.membershipId, action, decision: "allowed", outcome: "succeeded", resource_type: "capability_version", resource_id: resourceId, resource_version: resourceVersion, request_id: context.requestId, trace_id: context.traceId, reason_summary: "Platform catalog lifecycle command accepted", change_summary: null, occurred_at: now }).execute();
}
function assertCapabilityCompatibility(input: ValidatedCapabilityCreate, dependencies: CatalogCommandDependencies): string {
  if (!dependencies.knownContractRefs.includes(input.contract_ref) || input.compatibility.core_contract_version !== dependencies.platformCompatibility.core_contract_version || input.compatibility.runtime_protocol_version !== dependencies.platformCompatibility.runtime_protocol_version) throw new DomainError("INVALID_STATE_TRANSITION", "Capability metadata is not compatible with the platform catalog");
  return canonicalCompatibility(input.compatibility).hash;
}
function assertReplay(value: unknown): asserts value is CapabilityWriteResult { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INTERNAL_ERROR", "Stored catalog response is invalid"); }
async function appendLifecycle(trx: Transaction<RuntimeDatabase>, scope: { tenantId: string }, context: CatalogCommandContext, key: string, action: string, result: CapabilityWriteResult, now: Date): Promise<void> {
  await appendCatalogLifecycleEvent(trx, { tenantId: scope.tenantId, eventId: eventId(key, action), streamId: result.capability_version_id, eventType: `catalog.capability.${result.status === "draft" ? "created" : result.status}`, resourceType: "capability_version", resourceId: result.capability_version_id, resourceVersion: result.resource_version, requestId: context.requestId, traceId: context.traceId, occurredAt: now });
}

async function transition(dependencies: CatalogCommandDependencies, context: CatalogCommandContext, raw: unknown, desired: "reviewed" | "retired" | "blocked"): Promise<CapabilityWriteResult> {
  const input = validateCatalogTransition(raw, "capability"); safeContext(context);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date(); const scope = await platformScope(trx, context);
    const operation = `entitlements.capability.${desired}`;
    const admission = await beginIdempotentCommand<CapabilityWriteResult>({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, now, expiresAt: new Date(now.getTime() + dayMs) });
    if (admission.kind === "replay") { assertReplay(admission.response); return Object.freeze(admission.response); }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Catalog command is already in progress");
    const row = await lockCapabilityVersion(trx, input.capability_version_id!);
    if (row === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Capability Version was not found");
    const version = safeVersion(row.resource_version); if (version !== input.expected_resource_version) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Capability Version changed");
    const allowed = desired === "reviewed" ? row.status === "draft" : desired === "retired" ? row.status === "reviewed" : row.status !== "blocked";
    if (!allowed) throw new DomainError("INVALID_STATE_TRANSITION", "Capability Version transition is not allowed");
    const compatibilityHash = desired === "reviewed" ? canonicalCompatibility(row.compatibility_json).hash : undefined;
    const resourceVersion = version + 1;
    await trx.updateTable("capability_versions").set({ status: desired, resource_version: resourceVersion, updated_at: now }).where("capability_version_id", "=", row.capability_version_id).execute();
    if (desired === "blocked") {
      const affected = await trx.selectFrom("pack_members").innerJoin("tenant_pack_releases", "tenant_pack_releases.pack_version_id", "pack_members.pack_version_id").select(["tenant_pack_releases.tenant_id", "tenant_pack_releases.tenant_pack_release_id"]).where("pack_members.capability_version_id", "=", row.capability_version_id).orderBy("tenant_pack_releases.tenant_id", "asc").orderBy("tenant_pack_releases.tenant_pack_release_id", "asc").execute();
      for (const release of affected) {
        const jobId = `job_catalog_block_${createHash("sha256").update(`${row.capability_version_id}:${release.tenant_id}:${release.tenant_pack_release_id}`, "utf8").digest("hex").slice(0, 32)}`;
        await trx.insertInto("worker_jobs").values({ tenant_id: release.tenant_id, job_id: jobId, job_kind: "reconcile_capability_projection", status: "queued", attempt_count: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, next_attempt_at: now, payload_ref: release.tenant_pack_release_id, runtime_command: null, target_command_version: null, effect_state: "pre_effect", last_error_summary: null, run_id: null, container_id: null, created_at: now, updated_at: now }).onConflict((conflict) => conflict.columns(["tenant_id", "job_id"]).doNothing()).execute();
      }
    }
    const result: CapabilityWriteResult = Object.freeze({ schema_version: 1, capability_version_id: row.capability_version_id, capability_id: row.capability_id, version: row.version, status: desired, resource_version: resourceVersion, ...(compatibilityHash === undefined ? {} : { compatibility_hash: compatibilityHash }) });
    await appendPlatformAudit(trx, scope, context, input.idempotency_key, operation, row.capability_version_id, resourceVersion, now);
    await appendLifecycle(trx, scope, context, input.idempotency_key, operation, result, now);
    await completeIdempotentCommand({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, resultRef: row.capability_version_id, response: result, updatedAt: now });
    return result;
  }, { isolationLevel: "serializable" });
}

export async function createCapabilityVersion(dependencies: CatalogCommandDependencies, context: CatalogCommandContext, raw: unknown): Promise<CapabilityWriteResult> {
  const input = validateCatalogCommandInput(raw, "capability") as ValidatedCapabilityCreate; safeContext(context); const compatibilityHash = assertCapabilityCompatibility(input, dependencies);
  try { return await withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date(); const scope = await platformScope(trx, context); const operation = "entitlements.capability.create";
    const admission = await beginIdempotentCommand<CapabilityWriteResult>({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, now, expiresAt: new Date(now.getTime() + dayMs) });
    if (admission.kind === "replay") { assertReplay(admission.response); return Object.freeze(admission.response); }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Catalog command is already in progress");
    const existing = await lockCapabilityVersion(trx, input.capability_version_id); if (existing !== undefined) throw new DomainError("IDEMPOTENCY_CONFLICT", "Capability Version identity conflicts");
    const sameVersion = await trx.selectFrom("capability_versions").select("capability_version_id").where("capability_id", "=", input.capability_id).where("version", "=", input.version).forUpdate().executeTakeFirst();
    if (sameVersion !== undefined) throw new DomainError("IDEMPOTENCY_CONFLICT", "Capability Version identity conflicts");
    const family = await trx.selectFrom("capabilities").select(["kind"]).where("capability_id", "=", input.capability_id).forUpdate().executeTakeFirst();
    if (family !== undefined && family.kind !== input.kind) throw new DomainError("INVALID_STATE_TRANSITION", "Capability kind does not match its family");
    if (family === undefined) await trx.insertInto("capabilities").values({ capability_id: input.capability_id, display_name: input.display_name, owning_domain: input.owning_domain, kind: input.kind, resource_version: 1, created_at: now, updated_at: now }).execute();
    await trx.insertInto("capability_versions").values({ capability_version_id: input.capability_version_id, capability_id: input.capability_id, version: input.version, kind: input.kind, artifact_ref: input.artifact_ref, contract_ref: input.contract_ref, risk_class: input.risk_class, approval_requirement: input.approval_requirement, compatibility_json: input.compatibility, status: "draft", resource_version: 1, created_at: now, updated_at: now }).execute();
    const result: CapabilityWriteResult = Object.freeze({ schema_version: 1, capability_version_id: input.capability_version_id, capability_id: input.capability_id, version: input.version, status: "draft", resource_version: 1, compatibility_hash: compatibilityHash });
    await appendPlatformAudit(trx, scope, context, input.idempotency_key, operation, input.capability_version_id, 1, now);
    await appendLifecycle(trx, scope, context, input.idempotency_key, operation, result, now);
    await completeIdempotentCommand({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, resultRef: input.capability_version_id, response: result, updatedAt: now }); return result;
  }, { isolationLevel: "serializable" }); } catch (error) { if (catalogUniqueConflict(error, "capability_versions_capability_id_version_key")) throw new DomainError("IDEMPOTENCY_CONFLICT", "Capability Version identity conflicts"); throw error; }
}
function catalogUniqueConflict(error: unknown, constraint: string): boolean { if (error === null || typeof error !== "object") return false; const code = Object.getOwnPropertyDescriptor(error, "code"); const name = Object.getOwnPropertyDescriptor(error, "constraint"); return code !== undefined && name !== undefined && "value" in code && "value" in name && code.value === "23505" && name.value === constraint; }
export const reviewCapabilityVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "reviewed");
export const retireCapabilityVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "retired");
export const blockCapabilityVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "blocked");
