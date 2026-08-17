import {
  ReauthenticationRequestSchema,
  ReauthenticationResponseSchema,
  SessionInspectRequestSchema,
  SessionInspectResponseSchema,
  SessionRevokeRequestSchema,
  SessionRevokeResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Type from "typebox";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import {
  assertClientTransport,
  clearWebSessionCookies,
  requireMutationCredentials,
  requireSessionCredential,
} from "../security.js";

const EmptyMutationSchema = Type.Object({ schema_version: Type.Literal(1) }, { additionalProperties: false });

async function authenticateMutation(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

export async function registerSessionRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.get("/auth/v1/session", { schema: { response: { 200: SessionInspectResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await dependencies.operations.authenticateSession({ sessionSecret: requireSessionCredential(request), requireCsrf: false });
    return { schema_version: 1, session: authority.session };
  });

  app.post("/auth/v1/session/inspect", { schema: { body: SessionInspectRequestSchema, response: { 200: SessionInspectResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    return dependencies.operations.executeAuthorityCommand({ kind: "session_inspect", payload: request.body, authority });
  });

  app.post("/auth/v1/session/sign-out", { schema: { body: EmptyMutationSchema } }, async (request, reply) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    await dependencies.operations.executeAuthorityCommand({ kind: "session_sign_out", payload: {}, authority });
    clearWebSessionCookies(reply);
    return { schema_version: 1, signed_out: true };
  });

  app.post("/auth/v1/sessions/revoke", { schema: { body: SessionRevokeRequestSchema, response: { 200: SessionRevokeResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "session_revoke", payload: request.body, authority });
  });

  app.post("/auth/v1/reauthenticate", { schema: { body: ReauthenticationRequestSchema, response: { 200: ReauthenticationResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    const body = request.body as { password: string };
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "reauthenticate", accountIdentifier: authority.actorId, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    const email = await dependencies.operations.loadNormalizedEmail(authority);
    const subject = await dependencies.provider.reauthenticatePassword({ email, password: body.password });
    const { password: _password, ...durablePayload } = body as typeof body & {
      readonly schema_version: 1;
      readonly idempotency_key: string;
      readonly payload_hash: string;
      readonly expected_resource_version: number;
    };
    return dependencies.operations.executeAuthorityCommand({ kind: "reauthenticate", payload: durablePayload, authority, verifiedSubject: subject });
  });
}
