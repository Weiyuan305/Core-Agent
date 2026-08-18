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
  assertReauthenticationPayloadHash,
  clearWebSessionCookies,
  requireMutationCredentials,
  requireSessionCredential,
  requireNativeSessionCredential,
  rawHeaderValues,
  reauthenticationDurableFacts,
} from "../security.js";

const EmptyMutationSchema = Type.Object({ schema_version: Type.Literal(1) }, { additionalProperties: false });

async function authenticateMutation(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

async function authenticateAnyMutation(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  if (rawHeaderValues(request, "authorization").length === 1) {
    assertClientTransport(request, "iphone", dependencies.config);
    const authority = await dependencies.operations.authenticateSession({
      sessionSecret: requireNativeSessionCredential(request), requireCsrf: false,
    });
    if (authority.session.client_kind !== "iphone" && authority.session.client_kind !== "macos") {
      throw new IdentityGatewayFailure("AUTH_INVALID");
    }
    return authority;
  }
  assertClientTransport(request, "web", dependencies.config);
  const authority = await authenticateMutation(request, dependencies);
  if (authority.session.client_kind !== "web") throw new IdentityGatewayFailure("AUTH_INVALID");
  return authority;
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
    const body = request.body as {
      schema_version: 1; idempotency_key: string; payload_hash: string;
      expected_resource_version: number; password: string;
    };
    assertReauthenticationPayloadHash(body);
    const authority = await authenticateAnyMutation(request, dependencies);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "reauthenticate", accountIdentifier: authority.actorId, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    const email = await dependencies.operations.loadNormalizedEmail(authority);
    const subject = await dependencies.provider.reauthenticatePassword({ email, password: body.password });
    return dependencies.operations.executeAuthorityCommand({
      kind: "reauthenticate",
      payload: { ...reauthenticationDurableFacts(body), payload_hash: body.payload_hash },
      authority,
      verifiedSubject: subject,
    });
  });
}
