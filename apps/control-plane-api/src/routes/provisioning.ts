import {
  TenantProvisioningRequestSchema,
  DomainError,
  provisionTenant,
  type ProviderCatalog,
  type RuntimeDatabase,
  type TenantProvisioningRequest,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

export interface ProvisioningRouteDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly providerCatalog: ProviderCatalog;
  readonly imageLock: unknown;
}

export async function registerProvisioningRoutes(
  app: FastifyInstance,
  dependencies: ProvisioningRouteDependencies,
): Promise<void> {
  app.post<{ Body: TenantProvisioningRequest }>("/internal/v1/tenant-provisioning", {
    config: { tenantScoped: false },
    schema: { body: TenantProvisioningRequestSchema },
  }, async (request, reply) => {
    const context = request.apiContext;
    if ("authenticationKind" in context) {
      throw new DomainError("UNAUTHENTICATED", "Trusted context cannot access bootstrap provisioning");
    }
    const response = await provisionTenant(
      dependencies,
      {
        tenantId: request.body.identity_graph.tenant.tenant_id,
        requestId: context.requestId, traceId: context.traceId,
        actorId: context.actorId, membershipId: context.membershipId, effectiveRole: context.effectiveRole,
      },
      request.body,
    );
    return reply.code(202).send(response);
  });
}
