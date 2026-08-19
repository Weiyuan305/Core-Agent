import {
  AccountDeletionCancelRequestSchema,
  AccountDeletionCancelResponseSchema,
  AccountDeletionRequestSchema,
  AccountDeletionResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { assertClientTransport, assertProtectedWritePayloadHash, requireMutationCredentials } from "../security.js";

async function protectedAuthority(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  assertClientTransport(request, "web", dependencies.config);
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

async function requestAuthority(
  request: FastifyRequest,
  dependencies: IdentityGatewayRouteDependencies,
): Promise<GatewayAuthenticatedSession> {
  try {
    return await protectedAuthority(request, dependencies);
  } catch (error) {
    const authenticateRecovery = dependencies.operations.authenticateDeletionRecoverySession;
    if (authenticateRecovery === undefined) throw error;
    assertClientTransport(request, "web", dependencies.config);
    const credential = requireMutationCredentials(request);
    return authenticateRecovery({
      sessionSecret: credential.sessionSecret,
      csrfSecret: credential.csrfSecret,
      requireCsrf: true,
    });
  }
}

export async function registerAccountRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/account/deletion/request", { schema: { body: AccountDeletionRequestSchema, response: { 200: AccountDeletionResponseSchema } } }, async (request) => {
    assertProtectedWritePayloadHash("account_deletion_request", request.body as Record<string, unknown>);
    const authority = await requestAuthority(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "account_deletion_request", payload: request.body, authority });
  });
  app.post("/auth/v1/account/deletion/cancel", { schema: { body: AccountDeletionCancelRequestSchema, response: { 200: AccountDeletionCancelResponseSchema } } }, async (request) => {
    assertProtectedWritePayloadHash("account_deletion_cancel", request.body as Record<string, unknown>);
    assertClientTransport(request, "web", dependencies.config);
    const credential = requireMutationCredentials(request);
    const authenticateRecovery = dependencies.operations.authenticateDeletionRecoverySession;
    if (authenticateRecovery === undefined) throw new Error("Deletion recovery authentication is unavailable");
    const authority = await authenticateRecovery({
      sessionSecret: credential.sessionSecret,
      csrfSecret: credential.csrfSecret,
      requireCsrf: true,
      allowCancelled: true,
    });
    return dependencies.operations.executeAuthorityCommand({ kind: "account_deletion_cancel", payload: request.body, authority });
  });
}
