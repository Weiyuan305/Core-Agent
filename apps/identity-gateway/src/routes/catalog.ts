import { types as utilTypes } from "node:util";

import {
  ApprovalRequirementSchema,
  CapabilityCompatibilitySchema,
  CapabilityKindSchema,
  CapabilityRiskClassSchema,
  CanonicalSemanticVersionSchema,
  ExactContractRefSchema,
  IdempotencyRequestSchema,
  ImmutableArtifactRefSchema,
  OpaqueIdSchema,
  PackMemberRefSchema,
  ResourceVersionSchema,
  SchemaVersionSchema,
  TenantModeSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Type from "typebox";
import { canonicalPayloadHash } from "@core-agent/runtime-core";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import { assertClientTransport, requireMutationCredentials, requireSessionCredential } from "../security.js";

const IdempotencyFields = IdempotencyRequestSchema.properties;
const TransitionFields = {
  ...IdempotencyFields,
  expected_resource_version: ResourceVersionSchema,
} as const;

const CatalogCommandSchema = Type.Union([
  Type.Object({
    action: Type.Literal("capability_create"),
    command: Type.Object({
      ...IdempotencyFields,
      capability_id: OpaqueIdSchema,
      capability_version_id: OpaqueIdSchema,
      display_name: Type.String({ minLength: 1, maxLength: 200 }),
      owning_domain: Type.String({ minLength: 1, maxLength: 200 }),
      kind: CapabilityKindSchema,
      version: CanonicalSemanticVersionSchema,
      artifact_ref: ImmutableArtifactRefSchema,
      contract_ref: ExactContractRefSchema,
      risk_class: CapabilityRiskClassSchema,
      approval_requirement: ApprovalRequirementSchema,
      compatibility: CapabilityCompatibilitySchema,
      expected_resource_version: Type.Null(),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  ...(["capability_review", "capability_retire", "capability_block"] as const).map((action) => Type.Object({
    action: Type.Literal(action),
    command: Type.Object({ ...TransitionFields, capability_version_id: OpaqueIdSchema }, { additionalProperties: false }),
  }, { additionalProperties: false })),
  Type.Object({
    action: Type.Literal("pack_create"),
    command: Type.Object({
      ...IdempotencyFields,
      pack_product_id: OpaqueIdSchema,
      pack_version_id: OpaqueIdSchema,
      display_name: Type.String({ minLength: 1, maxLength: 200 }),
      tenant_modes: Type.Array(TenantModeSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
      version: CanonicalSemanticVersionSchema,
      expected_resource_version: Type.Null(),
      members: Type.Array(PackMemberRefSchema, { minItems: 1, maxItems: 128 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  ...(["pack_review", "pack_publish", "pack_retire", "pack_block"] as const).map((action) => Type.Object({
    action: Type.Literal(action),
    command: Type.Object({ ...TransitionFields, pack_version_id: OpaqueIdSchema }, { additionalProperties: false }),
  }, { additionalProperties: false })),
]);

const CatalogResponseSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  capabilities: Type.Array(Type.Object({
    schema_version: SchemaVersionSchema,
    capability_id: OpaqueIdSchema,
    capability_version_id: Type.Optional(OpaqueIdSchema),
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    kind: CapabilityKindSchema,
    status: Type.Union([Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("retired"), Type.Literal("blocked")]),
    resource_version: Type.Optional(ResourceVersionSchema),
  }, { additionalProperties: false })),
  packs: Type.Array(Type.Object({
    schema_version: SchemaVersionSchema,
    pack_product_id: OpaqueIdSchema,
    pack_version_id: Type.Optional(OpaqueIdSchema),
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    tenant_modes: Type.Array(TenantModeSchema, { minItems: 1, maxItems: 2, uniqueItems: true }),
    status: Type.Union([Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("published"), Type.Literal("retired"), Type.Literal("blocked")]),
    resource_version: Type.Optional(ResourceVersionSchema),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const MutationResponseSchema = Type.Union([
  Type.Object({
    schema_version: SchemaVersionSchema,
    capability_version_id: OpaqueIdSchema,
    capability_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
    status: Type.Union([Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("retired"), Type.Literal("blocked")]),
    resource_version: ResourceVersionSchema,
  }, { additionalProperties: false }),
  Type.Object({
    schema_version: SchemaVersionSchema,
    pack_version_id: OpaqueIdSchema,
    pack_product_id: OpaqueIdSchema,
    version: CanonicalSemanticVersionSchema,
    status: Type.Union([Type.Literal("draft"), Type.Literal("reviewed"), Type.Literal("published"), Type.Literal("retired"), Type.Literal("blocked")]),
    resource_version: ResourceVersionSchema,
  }, { additionalProperties: false }),
]);

async function rate(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies, mutating: boolean): Promise<void> {
  const retryAfter = await dependencies.operations.consumeRateLimit({
    bucketKind: mutating ? "reauthenticate" : "login",
    accountIdentifier: mutating ? "route:platform-catalog-write" : "route:platform-catalog-read",
    clientIdentifier: request.identityContext.clientIdentifier,
    dimensions: "client",
  });
  if (retryAfter !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfter);
}

async function readAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  await rate(request, dependencies, false);
  return dependencies.operations.authenticateSession({ sessionSecret: requireSessionCredential(request), requireCsrf: false });
}

async function writeAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  await rate(request, dependencies, true);
  const credentials = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credentials.sessionSecret, csrfSecret: credentials.csrfSecret, requireCsrf: true });
}

const catalogKinds = Object.freeze({
  capability_create: "catalog_capability_create",
  capability_review: "catalog_capability_review",
  capability_retire: "catalog_capability_retire",
  capability_block: "catalog_capability_block",
  pack_create: "catalog_pack_create",
  pack_review: "catalog_pack_review",
  pack_publish: "catalog_pack_publish",
  pack_retire: "catalog_pack_retire",
  pack_block: "catalog_pack_block",
} as const);

function assertCommandHash(command: unknown): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw new IdentityGatewayFailure("INVALID_REQUEST");
  const { payload_hash: supplied, ...facts } = command as Record<string, unknown>;
  if (typeof supplied !== "string" || supplied !== canonicalPayloadHash(facts)) throw new IdentityGatewayFailure("INVALID_REQUEST");
}

function ownData(value: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new IdentityGatewayFailure("INTERNAL_ERROR");
  return descriptor.value;
}

function publicMutationResult(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value)) {
    throw new IdentityGatewayFailure("INTERNAL_ERROR");
  }
  const row = value as Readonly<Record<string, unknown>>;
  const capabilityVersionId = ownData(row, "capability_version_id");
  if (typeof capabilityVersionId === "string") return {
    schema_version: ownData(row, "schema_version"),
    capability_version_id: capabilityVersionId,
    capability_id: ownData(row, "capability_id"),
    version: ownData(row, "version"),
    status: ownData(row, "status"),
    resource_version: ownData(row, "resource_version"),
  };
  const packVersionId = ownData(row, "pack_version_id");
  if (typeof packVersionId === "string") return {
    schema_version: ownData(row, "schema_version"),
    pack_version_id: packVersionId,
    pack_product_id: ownData(row, "pack_product_id"),
    version: ownData(row, "version"),
    status: ownData(row, "status"),
    resource_version: ownData(row, "resource_version"),
  };
  throw new IdentityGatewayFailure("INTERNAL_ERROR");
}

export async function registerCatalogRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.get("/app/v1/platform/catalog", { schema: { response: { 200: CatalogResponseSchema } } }, async (request) => {
    const authority = await readAuthority(request, dependencies);
    return dependencies.operations.executeAuthorityCommand({ kind: "platform_catalog_list", payload: {}, authority });
  });
  app.post("/app/v1/platform/catalog", {
    schema: { body: CatalogCommandSchema, response: { 200: MutationResponseSchema } },
  }, async (request) => {
    const body = request.body as { action: keyof typeof catalogKinds; command: unknown };
    assertCommandHash(body.command);
    const authority = await writeAuthority(request, dependencies);
    return publicMutationResult(await dependencies.operations.executeProtectedAuthorityCommand({
      kind: catalogKinds[body.action], payload: body.command, authority,
    }));
  });
}
