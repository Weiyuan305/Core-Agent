import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

import type { Kysely, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { beginIdempotentCommand, canonicalPayloadHash, completeIdempotentCommand, DomainError } from "../../domain/idempotency.js";
import { lockPackMembersAndCapabilities, lockPackVersion } from "../../repositories/entitlements/catalog.js";
import type { CatalogCommandContext, CatalogCommandDependencies } from "./manage-capability.js";
import { validateCatalogCommandInput, validateCatalogTransition, type ValidatedPackCreate } from "./catalog-validation.js";

export interface PackWriteResult { readonly schema_version: 1; readonly pack_version_id: string; readonly pack_product_id: string; readonly version: string; readonly status: "draft" | "reviewed" | "published" | "retired" | "blocked"; readonly resource_version: number; }
const dayMs = 24 * 60 * 60 * 1_000;
function safeVersion(value: string): number { const number = Number(value); if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1) throw new DomainError("INTERNAL_ERROR", "Stored catalog version is invalid"); return number; }
function safeContext(context: CatalogCommandContext): void { if ([context.performingActorId, context.requestId, context.traceId].some((value) => typeof value !== "string" || value.length < 1 || value.length > 255)) throw new DomainError("INVALID_REQUEST", "Catalog command context is invalid"); }
function assertPayloadHash(input: { payload_hash: string }): void { const { payload_hash: _hash, ...payload } = input; if (input.payload_hash !== canonicalPayloadHash(payload)) throw new DomainError("INVALID_REQUEST", "Payload hash does not match the canonical catalog command"); }
function auditId(key: string, action: string): string { return `audit_catalog_${createHash("sha256").update(`${key}:${action}`, "utf8").digest("hex").slice(0, 32)}`; }
async function platformScope(trx: Transaction<RuntimeDatabase>, context: CatalogCommandContext): Promise<{ tenantId: string; membershipId: string }> {
  const actor = await trx.selectFrom("actors").select("status").where("actor_id", "=", context.performingActorId).forUpdate().executeTakeFirst();
  const role = await trx.selectFrom("platform_role_assignments").select("status").where("actor_id", "=", context.performingActorId).where("role", "=", "platform_super_admin").forUpdate().executeTakeFirst();
  const membership = await trx.selectFrom("memberships").select(["tenant_id", "membership_id"]).where("actor_id", "=", context.performingActorId).where("membership_source", "=", "platform").where("status", "=", "active").orderBy("tenant_id", "asc").orderBy("membership_id", "asc").forUpdate().executeTakeFirst();
  if (actor?.status !== "active" || role?.status !== "active" || membership === undefined) throw new DomainError("UNAUTHENTICATED", "Active platform authority is required");
  return { tenantId: membership.tenant_id, membershipId: membership.membership_id };
}
async function audit(trx: Transaction<RuntimeDatabase>, scope: { tenantId: string; membershipId: string }, context: CatalogCommandContext, key: string, action: string, resourceId: string, version: number, now: Date): Promise<void> {
  await trx.insertInto("platform_authority_audit").values({ platform_authority_audit_id: auditId(key, action), authority_tenant_id: scope.tenantId, actor_id: context.performingActorId, membership_id: scope.membershipId, action, decision: "allowed", outcome: "succeeded", resource_type: "pack_version", resource_id: resourceId, resource_version: version, request_id: context.requestId, trace_id: context.traceId, reason_summary: "Platform catalog lifecycle command accepted", change_summary: null, occurred_at: now }).execute();
}
function assertReplay(value: unknown): asserts value is PackWriteResult { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("INTERNAL_ERROR", "Stored catalog response is invalid"); }
function canonicalMembers(input: ValidatedPackCreate): readonly { capability_id: string; capability_version_id: string; version: string }[] {
  const compare = (left: string, right: string): number => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  const sorted = [...input.members].sort((left, right) => compare(left.capability_id, right.capability_id) || compare(left.capability_version_id, right.capability_version_id) || compare(left.version, right.version));
  if (new Set(sorted.map((member) => member.capability_id)).size !== sorted.length || new Set(sorted.map((member) => `${member.capability_version_id}\0${member.version}`)).size !== sorted.length) throw new DomainError("INVALID_REQUEST", "Pack members are not an exact unique Capability Version set");
  return Object.freeze(sorted);
}
async function transition(dependencies: CatalogCommandDependencies, context: CatalogCommandContext, raw: unknown, desired: "reviewed" | "published" | "retired" | "blocked"): Promise<PackWriteResult> {
  const input = validateCatalogTransition(raw, "pack"); assertPayloadHash(input); safeContext(context);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date(); const scope = await platformScope(trx, context); const operation = `entitlements.pack.${desired}`;
    const admission = await beginIdempotentCommand<PackWriteResult>({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, now, expiresAt: new Date(now.getTime() + dayMs) });
    if (admission.kind === "replay") { assertReplay(admission.response); return Object.freeze(admission.response); }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Catalog command is already in progress");
    const pack = await lockPackVersion(trx, input.pack_version_id!); if (pack === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Pack Version was not found");
    const version = safeVersion(pack.resource_version); if (version !== input.expected_resource_version) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Pack Version changed");
    const allowed = desired === "reviewed" ? pack.status === "draft" : desired === "published" ? pack.status === "reviewed" : desired === "retired" ? pack.status === "published" : pack.status !== "blocked";
    if (!allowed) throw new DomainError("INVALID_STATE_TRANSITION", "Pack Version transition is not allowed");
    if (desired === "published") {
      const product = await trx.selectFrom("pack_products").select("tenant_modes").where("pack_product_id", "=", pack.pack_product_id).forUpdate().executeTakeFirst();
      if (product === undefined) throw new DomainError("INTERNAL_ERROR", "Pack Product authority is missing");
      const locked = await lockPackMembersAndCapabilities(trx, pack.pack_version_id);
      if (locked.members.length < 1 || locked.capabilities.length !== locked.members.length) throw new DomainError("INVALID_STATE_TRANSITION", "Pack members are not publishable authority");
      for (const member of locked.members) {
        const capability = locked.capabilities.find((candidate) => candidate.capability_version_id === member.capability_version_id);
        if (capability === undefined || capability.capability_id !== member.capability_id || capability.version !== member.version || capability.status !== "reviewed" || !dependencies.knownContractRefs.includes(capability.contract_ref) || capability.compatibility_json === null || typeof capability.compatibility_json !== "object") throw new DomainError("INVALID_STATE_TRANSITION", "Pack members are not publishable authority");
        const compatibility = capability.compatibility_json as { core_contract_version?: unknown; runtime_protocol_version?: unknown; tenant_modes?: unknown };
        const compatibilityModes = Array.isArray(compatibility.tenant_modes) ? compatibility.tenant_modes as unknown[] : undefined;
        if (compatibility.core_contract_version !== dependencies.platformCompatibility.core_contract_version || compatibility.runtime_protocol_version !== dependencies.platformCompatibility.runtime_protocol_version || compatibilityModes === undefined || product.tenant_modes.some((mode) => !compatibilityModes.includes(mode)) || capability.risk_class === "external_write" || capability.risk_class === "privileged" || (capability.risk_class === "draft_write" && !capability.artifact_ref.startsWith("manifest:sha256:"))) throw new DomainError("INVALID_STATE_TRANSITION", "Pack members are not publishable authority");
      }
    }
    const resourceVersion = version + 1;
    await trx.updateTable("pack_versions").set({ status: desired, resource_version: resourceVersion, updated_at: now }).where("pack_version_id", "=", pack.pack_version_id).execute();
    const result: PackWriteResult = Object.freeze({ schema_version: 1, pack_version_id: pack.pack_version_id, pack_product_id: pack.pack_product_id, version: pack.version, status: desired, resource_version: resourceVersion });
    await audit(trx, scope, context, input.idempotency_key, operation, pack.pack_version_id, resourceVersion, now);
    await completeIdempotentCommand({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, resultRef: pack.pack_version_id, response: result, updatedAt: now }); return result;
  }, { isolationLevel: "serializable" });
}

export async function createPackVersion(dependencies: CatalogCommandDependencies, context: CatalogCommandContext, raw: unknown): Promise<PackWriteResult> {
  const input = validateCatalogCommandInput(raw, "pack") as ValidatedPackCreate; assertPayloadHash(input); safeContext(context); const members = canonicalMembers(input);
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = dependencies.now?.() ?? new Date(); const scope = await platformScope(trx, context); const operation = "entitlements.pack.create";
    const admission = await beginIdempotentCommand<PackWriteResult>({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, now, expiresAt: new Date(now.getTime() + dayMs) });
    if (admission.kind === "replay") { assertReplay(admission.response); return Object.freeze(admission.response); }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Catalog command is already in progress");
    const existing = await lockPackVersion(trx, input.pack_version_id); if (existing !== undefined) throw new DomainError("IDEMPOTENCY_CONFLICT", "Pack Version identity conflicts");
    const product = await trx.selectFrom("pack_products").select("tenant_modes").where("pack_product_id", "=", input.pack_product_id).forUpdate().executeTakeFirst();
    if (product !== undefined && JSON.stringify(product.tenant_modes) !== JSON.stringify(input.tenant_modes)) throw new DomainError("INVALID_STATE_TRANSITION", "Pack Product customer modes are immutable");
    if (product === undefined) await trx.insertInto("pack_products").values({ pack_product_id: input.pack_product_id, display_name: input.display_name, tenant_modes: [...input.tenant_modes], resource_version: 1, created_at: now, updated_at: now }).execute();
    await trx.insertInto("pack_versions").values({ pack_version_id: input.pack_version_id, pack_product_id: input.pack_product_id, version: input.version, status: "draft", resource_version: 1, created_at: now, updated_at: now }).execute();
    for (const [index, member] of members.entries()) await trx.insertInto("pack_members").values({ pack_member_id: `pack_member_${createHash("sha256").update(`${input.pack_version_id}:${member.capability_version_id}`, "utf8").digest("hex").slice(0, 32)}`, pack_version_id: input.pack_version_id, member_order: index + 1, capability_id: member.capability_id, capability_version_id: member.capability_version_id, version: member.version, resource_version: 1, created_at: now, updated_at: now }).execute();
    const result: PackWriteResult = Object.freeze({ schema_version: 1, pack_version_id: input.pack_version_id, pack_product_id: input.pack_product_id, version: input.version, status: "draft", resource_version: 1 });
    await audit(trx, scope, context, input.idempotency_key, operation, input.pack_version_id, 1, now);
    await completeIdempotentCommand({ tenantId: scope.tenantId, trx }, { key: input.idempotency_key, payloadHash: input.payload_hash, operation, resultRef: input.pack_version_id, response: result, updatedAt: now }); return result;
  }, { isolationLevel: "serializable" });
}
export const reviewPackVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "reviewed");
export const publishPackVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "published");
export const retirePackVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "retired");
export const blockPackVersion = (dependencies: CatalogCommandDependencies, context: CatalogCommandContext, input: unknown) => transition(dependencies, context, input, "blocked");
