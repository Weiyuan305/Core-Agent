import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyMigrations,
  canonicalJson,
  createRedactor,
  createRuntimeDatabase,
  deriveRuntimeContainerId,
  encodeSignedTrustedContext,
  loadProviderCatalog,
  resolveProfileSnapshotInTransaction,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { TrustedRequestContext } from "@core-agent/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Pool } from "pg";

import { buildControlPlaneApp } from "../src/app.js";
import type { EventNotifier } from "../src/sse.js";

export const bootstrapKey = "synthetic-bootstrap-key-00000001";
export const admissionHttpNow = new Date("2026-08-05T02:00:00.000Z");
const trustedContextKeyPair = generateKeyPairSync("ed25519");
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "runtime-core", "migrations");
const testRoot = join(dirname(fileURLToPath(import.meta.url)), ".tmp");
const providerCatalog = loadProviderCatalog([{
  provider_config_id: "provider_http_admission",
  base_url: "https://provider.example/v1",
  model_ids: ["model_http_admission"],
  credential_secret_ref: "provider_secret_http_admission",
  timeout_ms: 10_000,
  max_safe_retries: 1,
}]);
const imageLock = {
  schemaVersion: 1,
  repository: "managed/runtime",
  tag: "v1",
  platforms: {
    "linux/amd64": { reference: `managed/runtime:v1@sha256:${"a".repeat(64)}` },
    "linux/arm64": { reference: `managed/runtime:v1@sha256:${"b".repeat(64)}` },
  },
};
const logger = {
  child() { return this; }, info() {}, error() {}, warn() {}, debug() {}, fatal() {}, trace() {}, silent() {}, level: "silent",
} as unknown as FastifyBaseLogger;

const snapshotAuthorityByTenant = new Map<string, {
  readonly snapshotId: string;
  readonly version: number;
  readonly evaluatedAt: string;
  readonly capabilityIds: readonly string[];
}>();

export async function resetHttpAdmissionDatabase(pool: Pool): Promise<void> {
  snapshotAuthorityByTenant.clear();
  await pool.query("drop schema public cascade; create schema public;");
  await applyMigrations(pool, migrationsDirectory);
}

export async function seedHttpReadyTenant(db: Kysely<RuntimeDatabase>, tenantId: string): Promise<string> {
  const profileId = `profile_${tenantId}`;
  const ownerId = `owner_${tenantId}`;
  await db.insertInto("tenants").values({ tenant_id: tenantId, schema_version: 1, resource_version: 1, tenant_mode: "b2c", status: "active", display_name: "HTTP admission tenant", created_at: admissionHttpNow, updated_at: admissionHttpNow }).execute();
  await db.insertInto("actors").values([
    { actor_id: ownerId, schema_version: 1, resource_version: 1, actor_kind: "human", display_name: "Owner", status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
    { actor_id: "core_agent_provisioner", schema_version: 1, resource_version: 1, actor_kind: "service", display_name: "Core Agent Provisioner", status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
  ]).onConflict((conflict) => conflict.column("actor_id").doNothing()).execute();
  await db.insertInto("memberships").values([
    { tenant_id: tenantId, membership_id: `membership_${tenantId}`, actor_id: ownerId, schema_version: 1, resource_version: 1, roles: ["student"], membership_source: "self", seat_ref: null, status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
    { tenant_id: tenantId, membership_id: "core_agent_provisioner_admin", actor_id: "core_agent_provisioner", schema_version: 1, resource_version: 1, roles: ["admin"], membership_source: "platform", seat_ref: null, status: "active", created_at: admissionHttpNow, updated_at: admissionHttpNow },
  ]).execute();
  await db.insertInto("profiles").values({ tenant_id: tenantId, profile_id: profileId, schema_version: 1, resource_version: 1, owner_actor_id: ownerId, profile_kind: "default", hermes_profile_ref: `hermes_${tenantId}`, description: "HTTP admission profile", status: "active", provider_config_id: "provider_http_admission", model_id: "model_http_admission", created_at: admissionHttpNow, updated_at: admissionHttpNow }).execute();
  await db.insertInto("runtime_containers").values({ tenant_id: tenantId, container_id: deriveRuntimeContainerId(tenantId), schema_version: 1, resource_version: 1, command_version: 0, runtime_kind: "hermes", desired_state: "running", observed_state: "ready", image_ref: imageLock.platforms["linux/amd64"].reference, runtime_platform: "linux/amd64", generation: 1, volume_ref: `volume_${tenantId}`, health_status: "healthy", last_probed_at: admissionHttpNow, failure_summary: null, created_at: admissionHttpNow, updated_at: admissionHttpNow }).execute();
  const suffix = createHash("sha256").update(tenantId, "utf8").digest("hex").slice(0, 24);
  const capabilityId = `capability_http_${suffix}`;
  const capabilityVersionId = `capability_version_http_${suffix}`;
  const packProductId = `pack_product_http_${suffix}`;
  const packVersionId = `pack_version_http_${suffix}`;
  const releaseId = `release_http_${suffix}`;
  await db.insertInto("capabilities").values({
    capability_id: capabilityId, display_name: "HTTP admission capability", owning_domain: "admission",
    kind: "mcp", resource_version: 1, created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  await db.insertInto("capability_versions").values({
    capability_version_id: capabilityVersionId, capability_id: capabilityId, version: "1.0.0", kind: "mcp",
    artifact_ref: `manifest:sha256:${createHash("sha256").update(capabilityVersionId).digest("hex")}`,
    contract_ref: "admission/http-capability@1.0.0", risk_class: "read", approval_requirement: "none",
    compatibility_json: {
      core_contract_version: "0.8.0", domain_contract_version: "1.0.0",
      runtime_protocol_version: "1.0.0", tenant_modes: ["b2c"],
    },
    status: "reviewed", resource_version: 1, created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  await db.insertInto("pack_products").values({
    pack_product_id: packProductId, display_name: "HTTP admission pack", tenant_modes: ["b2c"],
    resource_version: 1, created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  await db.insertInto("pack_versions").values({
    pack_version_id: packVersionId, pack_product_id: packProductId, version: "1.0.0", status: "draft",
    resource_version: 1, created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  await db.insertInto("pack_members").values({
    pack_member_id: `pack_member_http_${suffix}`, pack_version_id: packVersionId, member_order: 1,
    capability_id: capabilityId, capability_version_id: capabilityVersionId, version: "1.0.0",
    resource_version: 1, created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  await db.updateTable("pack_versions").set({ status: "reviewed", resource_version: 2, updated_at: admissionHttpNow })
    .where("pack_version_id", "=", packVersionId).execute();
  await db.updateTable("pack_versions").set({ status: "published", resource_version: 3, updated_at: admissionHttpNow })
    .where("pack_version_id", "=", packVersionId).execute();
  await db.insertInto("tenant_pack_releases").values({
    tenant_pack_release_id: releaseId, tenant_id: tenantId, pack_product_id: packProductId,
    pack_version_id: packVersionId, pack_version: "1.0.0", generation: 1, status: "preparing",
    resource_version: 1, created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  await db.updateTable("tenant_pack_releases").set({ status: "current", resource_version: 2, updated_at: admissionHttpNow })
    .where("tenant_pack_release_id", "=", releaseId).execute();
  await db.insertInto("entitlements").values({
    entitlement_id: `entitlement_http_${suffix}`, tenant_id: tenantId, pack_product_id: packProductId,
    tenant_pack_release_id: releaseId, pack_version_id: packVersionId, pack_version: "1.0.0",
    source: "platform_manual", external_order_ref: `http_order_${suffix}`, tenant_mode: "b2c",
    assignment_mode: "automatic", seat_quantity: null, valid_from: admissionHttpNow, expires_at: null,
    status: "active", reason_code: "platform_grant", resource_version: 1,
    created_at: admissionHttpNow, updated_at: admissionHttpNow,
  }).execute();
  const snapshot = await db.transaction().execute((trx) => resolveProfileSnapshotInTransaction({
    trx, tenantId, profileId, now: admissionHttpNow,
    evidence: {
      actorId: "core_agent_provisioner", membershipId: "core_agent_provisioner_admin",
      requestId: `request_http_seed_${suffix}`, traceId: `trace_http_seed_${suffix}`,
    },
  }));
  await db.updateTable("capability_runtime_projections").set({ status: "available", updated_at: admissionHttpNow })
    .where("projection_id", "=", snapshot.projection.projectionId).execute();
  await db.updateTable("runtime_containers").set({
    generation: snapshot.projection.generation, capability_manifest_digest: snapshot.canonicalInputHash,
  }).where("tenant_id", "=", tenantId).execute();
  snapshotAuthorityByTenant.set(tenantId, Object.freeze({
    snapshotId: snapshot.snapshotRef.snapshot_id,
    version: snapshot.snapshotRef.version,
    evaluatedAt: snapshot.snapshotRef.evaluated_at,
    capabilityIds: snapshot.capabilityIds,
  }));
  await db.deleteFrom("outbox").where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("product_events").where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("audit_events").where("tenant_id", "=", tenantId).execute();
  await db.deleteFrom("stream_sequences").where("tenant_id", "=", tenantId).execute();
  return profileId;
}

export function trustedContextHeaders(input: {
  readonly tenantId: string;
  readonly profileId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly clientRequestId?: string;
  readonly capabilityIds?: readonly string[];
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}): Record<string, string> {
  const currentSnapshot = snapshotAuthorityByTenant.get(input.tenantId);
  const context: TrustedRequestContext = {
    schema_version: 1,
    tenant_mode: "b2c",
    tenant_id: input.tenantId,
    actor_id: `owner_${input.tenantId}`,
    original_actor_id: `owner_${input.tenantId}`,
    membership_id: `membership_${input.tenantId}`,
    effective_role: "student",
    profile_id: input.profileId,
    entitlement_snapshot_ref: {
      snapshot_id: currentSnapshot?.snapshotId ?? "snapshot_http_admission",
      version: currentSnapshot?.version ?? 1,
      evaluated_at: currentSnapshot?.evaluatedAt ?? "2026-08-05T01:58:00.000Z",
    },
    capability_ids: [...(input.capabilityIds ?? currentSnapshot?.capabilityIds ?? ["capability_http_admission"])],
    container_id: deriveRuntimeContainerId(input.tenantId),
    conversation_id: input.conversationId,
    run_id: input.runId,
    request_id: input.requestId ?? "request_http_context",
    trace_id: input.traceId ?? "trace_http_context",
    client_request_id: input.clientRequestId ?? "client_http_context",
    context_id: `context_${input.runId}`,
    issuer: "identity-gateway",
    audience: ["control-plane-api"],
    issued_at: input.issuedAt ?? "2026-08-05T01:59:00.000Z",
    expires_at: input.expiresAt ?? "2026-08-05T02:04:00.000Z",
    key_id: "key_http_admission",
  };
  return {
    "x-core-agent-context": encodeSignedTrustedContext({
      schema_version: 1,
      algorithm: "EdDSA",
      key_id: context.key_id,
      payload: context,
      signature: sign(null, Buffer.from(canonicalJson(context), "utf8"), trustedContextKeyPair.privateKey).toString("base64url"),
    }),
  };
}

export async function buildHttpAdmissionApp(
  databaseUrl: string,
  db: Kysely<RuntimeDatabase>,
  options: { readonly eventNotifier?: EventNotifier } = {},
): Promise<{ app: FastifyInstance; directory: string }> {
  await mkdir(testRoot, { recursive: true, mode: 0o700 });
  await chmod(testRoot, 0o700);
  const directory = await mkdtemp(join(testRoot, "admission-"));
  await chmod(directory, 0o700);
  const bootstrapKeyFile = join(directory, "bootstrap-key");
  await writeFile(bootstrapKeyFile, `${bootstrapKey}\n`, { mode: 0o600 });
  const app = await buildControlPlaneApp({
    environment: {
      databaseUrl,
      databasePasswordFile: join(directory, "database-password"),
      bootstrapKeyFile,
      apiHost: "127.0.0.1",
      apiPort: 8787,
      secretRoot: directory,
      supervisorSocket: join(directory, "supervisor.sock"),
      providerCatalogFile: join(directory, "providers.json"),
      workerId: "worker_test",
    },
    db,
    providerCatalog,
    imageLock,
    logger,
    redactor: createRedactor([bootstrapKey]),
    trustedContext: {
      keys: [{
        keyId: "key_http_admission", publicKey: trustedContextKeyPair.publicKey, status: "active",
        activatedAt: "2026-08-05T00:00:00.000Z",
      }],
      expectedIssuer: "identity-gateway",
      expectedAudience: "control-plane-api",
      databaseNow: async () => new Date(admissionHttpNow),
    },
    ...(options.eventNotifier === undefined ? {} : { eventNotifier: options.eventNotifier }),
  });
  return { app, directory };
}

export { createRuntimeDatabase };
