import {
  AssignPackSeatRequestSchema,
  ChangeEntitlementStatusRequestSchema,
  CompanyAssignmentSummarySchema,
  CompanyServiceSummarySchema,
  GrantEntitlementRequestSchema,
  OpaqueIdSchema,
  ResourceVersionSchema,
  RevokePackSeatRequestSchema,
  SchemaVersionSchema,
  SelectTenantPackReleaseRequestSchema,
  StudentServiceSummarySchema,
  TenantModeSchema,
  UtcTimestampSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Type from "typebox";
import { canonicalPayloadHash } from "@core-agent/runtime-core";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import { assertClientTransport, requireMutationCredentials, requireSessionCredential } from "../security.js";

const TenantQuerySchema = Type.Object({ tenant_id: OpaqueIdSchema }, { additionalProperties: false });
const CompanyManageableServiceSummarySchema = Type.Object({
  ...CompanyServiceSummarySchema.properties,
  entitlement_resource_version: ResourceVersionSchema,
}, { additionalProperties: false });
const CompanyManageableAssignmentSummarySchema = Type.Object({
  ...CompanyAssignmentSummarySchema.properties,
  assignment_resource_version: ResourceVersionSchema,
}, { additionalProperties: false });
const ServiceResponseSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  services: Type.Array(CompanyManageableServiceSummarySchema),
}, { additionalProperties: false });
const AssignmentResponseSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  assignments: Type.Array(CompanyManageableAssignmentSummarySchema),
}, { additionalProperties: false });
const StudentResponseSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  services: Type.Array(StudentServiceSummarySchema),
}, { additionalProperties: false });
const PlatformEntitlementResponseSchema = Type.Object({
  schema_version: SchemaVersionSchema,
  entitlements: Type.Array(Type.Object({
    schema_version: SchemaVersionSchema,
    entitlement_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    tenant_mode: TenantModeSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("suspended"), Type.Literal("expired"), Type.Literal("revoked")]),
    valid_from: UtcTimestampSchema,
    expires_at: Type.Optional(UtcTimestampSchema),
    resource_version: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const PlatformMutationSchema = Type.Union([
  Type.Object({ action: Type.Literal("select_release"), command: SelectTenantPackReleaseRequestSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("grant"), command: GrantEntitlementRequestSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("change_status"), command: ChangeEntitlementStatusRequestSchema }, { additionalProperties: false }),
]);
const AssignmentMutationSchema = Type.Union([
  Type.Object({ action: Type.Literal("assign"), tenant_id: OpaqueIdSchema, command: AssignPackSeatRequestSchema }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("revoke"), tenant_id: OpaqueIdSchema, command: RevokePackSeatRequestSchema }, { additionalProperties: false }),
]);
const MutationResponseSchema = Type.Union([
  Type.Object({
    schema_version: SchemaVersionSchema,
    release_id: OpaqueIdSchema,
    generation: Type.Integer({ minimum: 1 }),
    state: Type.Union([Type.Literal("current"), Type.Literal("preparing"), Type.Literal("replay")]),
  }, { additionalProperties: false }),
  Type.Object({
    schema_version: SchemaVersionSchema,
    entitlement_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    pack_product_id: OpaqueIdSchema,
    status: Type.Union([Type.Literal("active"), Type.Literal("suspended"), Type.Literal("revoked"), Type.Literal("expired")]),
    reason_code: OpaqueIdSchema,
    resource_version: Type.Integer({ minimum: 1 }),
    valid_from: UtcTimestampSchema,
    expires_at: Type.Optional(UtcTimestampSchema),
    seat_quantity: Type.Optional(Type.Integer({ minimum: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    schema_version: SchemaVersionSchema,
    assignment_id: OpaqueIdSchema,
    entitlement_id: OpaqueIdSchema,
    profile_id: OpaqueIdSchema,
    status: Type.Union([Type.Literal("preparing"), Type.Literal("revoked")]),
    reason_code: OpaqueIdSchema,
    resource_version: Type.Integer({ minimum: 1 }),
    used_seats: Type.Integer({ minimum: 0 }),
    total_seats: Type.Integer({ minimum: 1 }),
    available_seats: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
]);

function assertCommandHash(command: unknown): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw new IdentityGatewayFailure("INVALID_REQUEST");
  const { payload_hash: supplied, ...facts } = command as Record<string, unknown>;
  if (typeof supplied !== "string" || supplied !== canonicalPayloadHash(facts)) throw new IdentityGatewayFailure("INVALID_REQUEST");
}

async function rate(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies, route: string, mutating: boolean): Promise<void> {
  const retryAfter = await dependencies.operations.consumeRateLimit({
    bucketKind: mutating ? "reauthenticate" : "login",
    accountIdentifier: `route:${route}`,
    clientIdentifier: request.identityContext.clientIdentifier,
    dimensions: "client",
  });
  if (retryAfter !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfter);
}

async function readAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies, route: string): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  await rate(request, dependencies, route, false);
  return dependencies.operations.authenticateSession({ sessionSecret: requireSessionCredential(request), requireCsrf: false });
}

async function writeAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies, route: string): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  await rate(request, dependencies, route, true);
  const credentials = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credentials.sessionSecret, csrfSecret: credentials.csrfSecret, requireCsrf: true });
}

export async function registerEntitlementRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.get("/app/v1/platform/entitlements", { schema: { response: { 200: PlatformEntitlementResponseSchema } } }, async (request) => {
    const authority = await readAuthority(request, dependencies, "platform-entitlements-read");
    return dependencies.operations.executeAuthorityCommand({ kind: "platform_entitlement_list", payload: {}, authority });
  });
  app.post("/app/v1/platform/entitlements", { schema: { body: PlatformMutationSchema, response: { 200: MutationResponseSchema } } }, async (request) => {
    const body = request.body as { action: "select_release" | "grant" | "change_status"; command: unknown };
    assertCommandHash(body.command);
    const authority = await writeAuthority(request, dependencies, "platform-entitlements-write");
    const kind = body.action === "select_release" ? "entitlement_select_release" : body.action === "grant" ? "entitlement_grant" : "entitlement_change_status";
    return dependencies.operations.executeProtectedAuthorityCommand({ kind, payload: body.command, authority });
  });
  app.get("/app/v1/company/services", { schema: { querystring: TenantQuerySchema, response: { 200: ServiceResponseSchema } } }, async (request) => {
    const authority = await readAuthority(request, dependencies, "company-services-read");
    return dependencies.operations.executeAuthorityCommand({ kind: "company_service_list", payload: request.query, authority });
  });
  app.get("/app/v1/company/assignments", { schema: { querystring: TenantQuerySchema, response: { 200: AssignmentResponseSchema } } }, async (request) => {
    const authority = await readAuthority(request, dependencies, "company-assignments-read");
    return dependencies.operations.executeAuthorityCommand({ kind: "company_assignment_list", payload: request.query, authority });
  });
  app.post("/app/v1/company/assignments", { schema: { body: AssignmentMutationSchema, response: { 200: MutationResponseSchema } } }, async (request) => {
    const body = request.body as { action: "assign" | "revoke"; tenant_id: string; command: Record<string, unknown> };
    assertCommandHash(body.command);
    const authority = await writeAuthority(request, dependencies, "company-assignments-write");
    return dependencies.operations.executeProtectedAuthorityCommand({
      kind: body.action === "assign" ? "entitlement_seat_assign" : "entitlement_seat_revoke",
      payload: { ...body.command, tenant_id: body.tenant_id }, authority,
    });
  });
  app.get("/app/v1/student/services", { schema: { response: { 200: StudentResponseSchema } } }, async (request) => {
    const authority = await readAuthority(request, dependencies, "student-services-read");
    return dependencies.operations.executeAuthorityCommand({ kind: "student_service_list", payload: {}, authority });
  });
}
