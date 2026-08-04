import {
  RuntimeCommandRequestSchema,
  commandRuntime,
  getTenantRuntime,
  type RuntimeCommandRequest,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import Type, { type Static } from "typebox";

const TenantPathSchema = Type.Object({
  tenant_id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" }),
}, { additionalProperties: false });
type TenantPath = Static<typeof TenantPathSchema>;

export interface RuntimeRouteDependencies {
  readonly db: Kysely<RuntimeDatabase>;
}

export async function registerRuntimeRoutes(app: FastifyInstance, dependencies: RuntimeRouteDependencies): Promise<void> {
  app.get<{ Params: TenantPath }>("/internal/v1/tenants/:tenant_id/runtime", {
    config: { tenantScoped: true },
    schema: { params: TenantPathSchema },
  }, async (request) => getTenantRuntime(dependencies.db, request.apiContext.tenantId!, request.params.tenant_id));

  app.post<{ Params: TenantPath; Body: RuntimeCommandRequest }>("/internal/v1/tenants/:tenant_id/runtime-commands", {
    config: { tenantScoped: true },
    schema: { params: TenantPathSchema, body: RuntimeCommandRequestSchema },
  }, async (request, reply) => {
    if (request.params.tenant_id !== request.apiContext.tenantId) {
      await getTenantRuntime(dependencies.db, request.apiContext.tenantId!, request.params.tenant_id);
    }
    const context = request.apiContext;
    const response = await commandRuntime(dependencies, {
      tenantId: context.tenantId!, requestId: context.requestId, traceId: context.traceId,
      actorId: context.actorId, membershipId: context.membershipId, effectiveRole: context.effectiveRole,
    }, request.body);
    return reply.code(202).send(response);
  });
}
