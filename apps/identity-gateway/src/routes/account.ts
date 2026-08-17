import {
  AccountDeletionCancelRequestSchema,
  AccountDeletionCancelResponseSchema,
  AccountDeletionRequestSchema,
  AccountDeletionResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { assertClientTransport, requireMutationCredentials } from "../security.js";

async function protectedAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

export async function registerAccountRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/account/deletion/request", { schema: { body: AccountDeletionRequestSchema, response: { 200: AccountDeletionResponseSchema } } }, async (request) => {
    const authority = await protectedAuthority(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "account_deletion_request", payload: request.body, authority });
  });
  app.post("/auth/v1/account/deletion/cancel", { schema: { body: AccountDeletionCancelRequestSchema, response: { 200: AccountDeletionCancelResponseSchema } } }, async (request) => {
    const authority = await protectedAuthority(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "account_deletion_cancel", payload: request.body, authority });
  });
}
