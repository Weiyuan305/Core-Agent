import { createHash } from "node:crypto";

import {
  IdentityGraphSchema,
  validateIdentityGraph,
  type IdentityGraph,
  type RuntimeContainer,
} from "@core-agent/contracts";
import Type, { type Static } from "typebox";
import Schema from "typebox/schema";
import type { Kysely, Transaction } from "kysely";

import type { ProviderCatalog } from "../config/provider-catalog.js";
import { loadRuntimeImageLock } from "../config/image-lock.js";
import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId, type TenantTransaction } from "../db/transaction.js";
import { appendAuditEvent, appendProductEvents } from "../repositories/events.js";
import { ResourceRepositories } from "../repositories/index.js";
import { deriveManagedRuntimeNames } from "../runtime/managed-names.js";
import { SecretReferenceRepository } from "../repositories/secret-references.js";
import { assertSecretReferenceId } from "../secrets/secret-store.js";
import {
  beginIdempotentCommand,
  canonicalPayloadHash,
  completeIdempotentCommand,
  DomainError,
} from "../domain/idempotency.js";

const idSchema = Type.String({ minLength: 1, maxLength: 255 });
const secretReferenceIdSchema = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" });
const immutableImageSchema = Type.String({ pattern: "^.+@sha256:[a-f0-9]{64}$", maxLength: 2_048 });

export const TenantProvisioningRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  idempotency_key: idSchema,
  payload_hash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  client_request_id: idSchema,
  identity_graph: IdentityGraphSchema,
  provider_config_id: idSchema,
  model_id: idSchema,
  runtime: Type.Object({
    image_ref: immutableImageSchema,
    platform: Type.Union([Type.Literal("linux/amd64"), Type.Literal("linux/arm64")]),
    ingress_secret_ref: secretReferenceIdSchema,
  }, { additionalProperties: false }),
  profile_runtime_config: Type.Array(Type.Object({
    profile_id: idSchema,
    description: Type.String({ minLength: 1, maxLength: 2_000 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export type TenantProvisioningRequest = Static<typeof TenantProvisioningRequestSchema>;

export interface ProvisioningContext {
  readonly tenantId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly actorId: "core_agent_provisioner";
  readonly membershipId: "core_agent_provisioner_admin";
  readonly effectiveRole: "admin";
}

export interface ProvisionTenantDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly providerCatalog: ProviderCatalog;
  readonly imageLock: unknown;
  readonly now?: () => Date;
}

export interface ProvisionTenantResponse {
  readonly schema_version: 1;
  readonly status: "accepted";
  readonly tenant: { readonly tenant_id: string; readonly resource_version: number };
  readonly runtime: { readonly container_id: string; readonly resource_version: number };
}

const requestValidator = Schema.Compile(TenantProvisioningRequestSchema);

function invalid(message: string): never {
  throw new DomainError("INVALID_REQUEST", message);
}

function deriveId(prefix: string, tenantId: string): string {
  return `${prefix}_${createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 32)}`;
}

export function deriveRuntimeContainerId(tenantId: string): string {
  assertTenantId(tenantId);
  return deriveId("runtime", tenantId);
}

export function deriveRuntimeVolumeRef(tenantId: string): string {
  return deriveManagedRuntimeNames({
    tenant_id: tenantId,
    runtime_id: deriveRuntimeContainerId(tenantId),
    generation: 1,
  }).volume;
}

function validateInitialMetadata(graph: IdentityGraph): void {
  const resources = [graph.tenant, ...graph.actors, ...graph.memberships, ...graph.profiles];
  if (resources.some((resource) => resource.schema_version !== 1 || resource.resource_version !== 1)) {
    invalid("Provisioning resources must start at version one");
  }
  if (graph.tenant.status !== "provisioning" || graph.profiles.some((profile) => profile.status !== "provisioning")) {
    invalid("Tenant and profiles must start in provisioning state");
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function validateIdentityRequest(graph: IdentityGraph): void {
  if (validateIdentityGraph(graph).length > 0) invalid("Identity graph is inconsistent");
  if (graph.tenant.tenant_mode === "b2b" && graph.profiles.length < 1) {
    invalid("B2B provisioning requires a consultant profile");
  }
  validateInitialMetadata(graph);
  if (graph.actors.some((actor) => actor.actor_kind !== "human")) invalid("Provisioning accepts human actors only");
  const clientResourceIds = [
    graph.tenant.tenant_id,
    ...graph.actors.map((actor) => actor.actor_id),
    ...graph.memberships.flatMap((membership) => [membership.membership_id, ...(membership.seat_ref === undefined ? [] : [membership.seat_ref])]),
    ...graph.profiles.flatMap((profile) => [profile.profile_id, profile.hermes_profile_ref]),
  ];
  if (clientResourceIds.some((id) => id.startsWith("core_agent_"))) invalid("Client resource ID uses a reserved prefix");
  assertUnique(graph.actors.map((actor) => actor.actor_id), "Actor IDs");
  assertUnique(graph.memberships.map((membership) => membership.membership_id), "Membership IDs");
  assertUnique(graph.memberships.map((membership) => membership.actor_id), "Membership actors");
  assertUnique(graph.profiles.map((profile) => profile.profile_id), "Profile IDs");
  assertUnique(graph.profiles.map((profile) => profile.hermes_profile_ref), "Hermes profile references");
  if (graph.profiles.some((profile) => !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(profile.hermes_profile_ref))) {
    invalid("Hermes profile reference is invalid");
  }
}

function profileDescriptions(request: TenantProvisioningRequest): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>();
  for (const config of request.profile_runtime_config) {
    if (descriptions.has(config.profile_id)) invalid("Profile runtime configuration must be unique");
    descriptions.set(config.profile_id, config.description);
  }
  const profileIds = new Set(request.identity_graph.profiles.map((profile) => profile.profile_id));
  if (
    descriptions.size !== profileIds.size
    || [...descriptions.keys()].some((profileId) => !profileIds.has(profileId))
    || [...profileIds].some((profileId) => !descriptions.has(profileId))
  ) invalid("Profile runtime configuration must exactly cover every profile");
  return descriptions;
}

function payloadWithoutHash(request: TenantProvisioningRequest): Omit<TenantProvisioningRequest, "payload_hash"> {
  const { payload_hash: _payloadHash, ...payload } = request;
  return payload;
}

function assertProvisioningResponse(
  value: unknown,
  expectedTenantId: string,
  expectedContainerId: string,
): asserts value is ProvisionTenantResponse {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 4
    || (value as ProvisionTenantResponse).schema_version !== 1
    || (value as ProvisionTenantResponse).status !== "accepted"
  ) throw new DomainError("INTERNAL_ERROR", "Stored provisioning response is invalid");
  const tenant = (value as ProvisionTenantResponse).tenant;
  const runtime = (value as ProvisionTenantResponse).runtime;
  if (
    tenant?.tenant_id !== expectedTenantId || tenant.resource_version !== 1
    || runtime?.container_id !== expectedContainerId || runtime.resource_version !== 1
    || Object.keys(tenant).length !== 2 || Object.keys(runtime).length !== 2
  ) throw new DomainError("INTERNAL_ERROR", "Stored provisioning response is invalid");
}

function isRetryableSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && ["40001", "40P01"].includes(String((error as { code?: unknown }).code));
}

async function serializable<T>(db: Kysely<RuntimeDatabase>, work: (trx: Transaction<RuntimeDatabase>) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.transaction().setIsolationLevel("serializable").execute(work);
    } catch (error) {
      if (!isRetryableSerializationFailure(error) || attempt === 2) throw error;
    }
  }
  throw new DomainError("INTERNAL_ERROR", "Serializable transaction retry exhausted");
}

export async function provisionTenant(
  dependencies: ProvisionTenantDependencies,
  context: ProvisioningContext,
  input: unknown,
): Promise<ProvisionTenantResponse> {
  if (!requestValidator.Check(input)) invalid("Provisioning request does not satisfy its contract");
  const request = input as TenantProvisioningRequest;
  assertTenantId(context.tenantId);
  if (request.identity_graph.tenant.tenant_id !== context.tenantId) invalid("Provisioning tenant scope does not match authority");
  validateIdentityRequest(request.identity_graph);
  const descriptions = profileDescriptions(request);
  if (request.payload_hash !== canonicalPayloadHash(payloadWithoutHash(request))) invalid("Payload hash does not match the canonical request");

  let provider;
  try {
    provider = dependencies.providerCatalog.require(request.provider_config_id, request.model_id);
    assertSecretReferenceId(provider.credential_secret_ref);
    assertSecretReferenceId(request.runtime.ingress_secret_ref);
  } catch {
    invalid("Managed provider, model, or secret reference is invalid");
  }
  let managedImageLock;
  try {
    managedImageLock = loadRuntimeImageLock(dependencies.imageLock);
  } catch {
    invalid("Managed image lock is invalid");
  }
  if (request.runtime.image_ref !== managedImageLock.platforms[request.runtime.platform].reference) {
    invalid("Runtime image is not the managed pinned image for the platform");
  }
  if (provider.credential_secret_ref === request.runtime.ingress_secret_ref) invalid("Secret references must have distinct purposes");

  const tenantId = context.tenantId;
  const containerId = deriveRuntimeContainerId(tenantId);
  const volumeRef = deriveRuntimeVolumeRef(tenantId);
  const operation = "tenant.provision";

  return serializable(dependencies.db, async (trx) => {
    const now = (dependencies.now?.() ?? new Date());
    const nowIso = now.toISOString();
    const graph = request.identity_graph;
    const insertedTenant = await trx.insertInto("tenants").values({
      tenant_id: tenantId, schema_version: 1, resource_version: 1,
      tenant_mode: graph.tenant.tenant_mode, status: "provisioning",
      display_name: graph.tenant.display_name, created_at: now, updated_at: now,
    }).onConflict((conflict) => conflict.column("tenant_id").doNothing()).returning("tenant_id").executeTakeFirst();
    const tenantTransaction: TenantTransaction = { tenantId, trx };
    const admission = await beginIdempotentCommand<ProvisionTenantResponse>(tenantTransaction, {
      key: request.idempotency_key,
      payloadHash: request.payload_hash,
      operation,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    });
    if (admission.kind === "replay") {
      if (admission.resultRef !== containerId) {
        throw new DomainError("INTERNAL_ERROR", "Provisioning replay result reference is invalid");
      }
      assertProvisioningResponse(admission.response, tenantId, containerId);
      return admission.response;
    }
    if (admission.kind === "in_progress") throw new DomainError("IDEMPOTENCY_CONFLICT", "Provisioning command is already in progress");
    if (insertedTenant === undefined) throw new DomainError("RESOURCE_VERSION_CONFLICT", "Tenant already exists");

    const repositories = new ResourceRepositories(dependencies.db).forTransaction(tenantTransaction);
    for (const actor of graph.actors) {
      await repositories.actors.insert({ ...actor, schema_version: 1, resource_version: 1, created_at: nowIso, updated_at: nowIso });
    }
    for (const membership of graph.memberships) {
      await repositories.memberships.insert({ ...membership, schema_version: 1, resource_version: 1, created_at: nowIso, updated_at: nowIso });
    }
    await repositories.actors.insert({
      schema_version: 1, resource_version: 1, actor_id: context.actorId, actor_kind: "service",
      display_name: "Core Agent Provisioner", status: "active", created_at: nowIso, updated_at: nowIso,
    });
    await repositories.memberships.insert({
      schema_version: 1, resource_version: 1, membership_id: context.membershipId,
      tenant_id: tenantId, actor_id: context.actorId, roles: ["admin"], status: "active",
      created_at: nowIso, updated_at: nowIso,
    });
    for (const profile of graph.profiles) {
      await repositories.profiles.insert({
        ...profile, schema_version: 1, resource_version: 1, status: "provisioning",
        created_at: nowIso, updated_at: nowIso,
        description: descriptions.get(profile.profile_id)!,
        provider_config_id: provider.provider_config_id,
        model_id: request.model_id,
      });
    }
    const secretReferences = new SecretReferenceRepository(tenantTransaction);
    await secretReferences.insert({
      reference_id: provider.credential_secret_ref, version: 1, purpose: "model_provider", status: "active",
      created_at: nowIso, updated_at: nowIso,
    });
    await secretReferences.insert({
      reference_id: request.runtime.ingress_secret_ref, version: 1, purpose: "hermes_ingress", status: "active",
      created_at: nowIso, updated_at: nowIso,
    });
    const runtime: RuntimeContainer = {
      schema_version: 1, resource_version: 1, tenant_id: tenantId, container_id: containerId,
      runtime_kind: "hermes", desired_state: "running", observed_state: "requested",
      image_ref: request.runtime.image_ref, generation: 1, volume_ref: volumeRef,
      health_status: "unknown", created_at: nowIso, updated_at: nowIso,
    };
    await repositories.runtimes.insert(runtime);
    await trx.updateTable("runtime_containers").set({ runtime_platform: request.runtime.platform })
      .where("tenant_id", "=", tenantId).where("container_id", "=", containerId).execute();

    const jobId = deriveId("job_provision", `${tenantId}:${request.idempotency_key}`);
    const eventId = deriveId("event_runtime", `${tenantId}:${request.idempotency_key}`);
    const auditEventId = deriveId("audit_provision", `${tenantId}:${request.idempotency_key}`);
    await trx.insertInto("worker_jobs").values({
      tenant_id: tenantId, job_id: jobId, job_kind: "provision_runtime", status: "queued",
      attempt_count: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null,
      next_attempt_at: now, payload_ref: containerId, effect_state: "pre_effect",
      runtime_command: null,
      target_command_version: null,
      last_error_summary: null, run_id: null, container_id: containerId, created_at: now, updated_at: now,
    }).execute();
    await appendProductEvents(tenantTransaction, {
      streamId: `runtime_${containerId}`,
      deliveryTarget: "internal_event_stream",
      events: [{
        schema_version: 1, event_id: eventId, occurred_at: nowIso,
        tenant_id: tenantId, request_id: context.requestId, trace_id: context.traceId,
        correlation_id: request.client_request_id, causation_id: jobId,
        event_type: "runtime.status_changed", payload: { container_id: containerId, observed_state: "requested" },
      }],
    });
    await appendAuditEvent(tenantTransaction, {
      schema_version: 1, audit_event_id: auditEventId, occurred_at: nowIso, tenant_id: tenantId,
      actor_id: context.actorId, membership_id: context.membershipId, effective_role: context.effectiveRole,
      action: "tenant.provision", resource_type: "runtime_container", resource_id: containerId,
      decision: "allowed", outcome: "pending", request_id: context.requestId, trace_id: context.traceId,
      reason_summary: "Accepted managed tenant provisioning", resource_version: 1,
    });
    const response: ProvisionTenantResponse = {
      schema_version: 1, status: "accepted",
      tenant: { tenant_id: tenantId, resource_version: 1 },
      runtime: { container_id: containerId, resource_version: 1 },
    };
    await completeIdempotentCommand(tenantTransaction, {
      key: request.idempotency_key,
      payloadHash: request.payload_hash,
      operation,
      resultRef: containerId,
      response,
      updatedAt: now,
    });
    return response;
  });
}
