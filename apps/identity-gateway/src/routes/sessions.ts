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

type ValidatedMutationCredential =
  | { readonly clientKind: "web"; readonly sessionSecret: string; readonly csrfSecret: string }
  | { readonly clientKind: "iphone" | "macos"; readonly sessionSecret: string };

function validateAnyMutationTransport(
  request: FastifyRequest,
  dependencies: IdentityGatewayRouteDependencies,
  requestedClientKind: "web" | "iphone" | "macos" | undefined,
): ValidatedMutationCredential {
  if (rawHeaderValues(request, "authorization").length === 1) {
    const sessionSecret = requireNativeSessionCredential(request);
    assertClientTransport(request, requestedClientKind === "macos" ? "macos" : "iphone", dependencies.config);
    if (requestedClientKind !== "iphone" && requestedClientKind !== "macos") {
      throw new IdentityGatewayFailure("AUTH_INVALID");
    }
    return { clientKind: requestedClientKind, sessionSecret };
  }
  if (requestedClientKind !== undefined && requestedClientKind !== "web") {
    throw new IdentityGatewayFailure("AUTH_INVALID");
  }
  assertClientTransport(request, "web", dependencies.config);
  const credential = requireMutationCredentials(request);
  return { clientKind: "web", sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret };
}

async function authenticateValidatedMutation(
  credential: ValidatedMutationCredential,
  dependencies: IdentityGatewayRouteDependencies,
): Promise<GatewayAuthenticatedSession> {
  const authority = credential.clientKind === "web"
    ? await dependencies.operations.authenticateSession({
      sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true,
    })
    : await dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, requireCsrf: false });
  if (authority.session.client_kind !== credential.clientKind) throw new IdentityGatewayFailure("AUTH_INVALID");
  return authority;
}

export async function registerSessionRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.get("/auth/v1/session", { schema: { response: { 200: SessionInspectResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await dependencies.operations.authenticateSession({
      sessionSecret: requireSessionCredential(request), requireCsrf: false, advanceActivity: true,
    });
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
      expected_resource_version: number; password: string; client_kind?: "web" | "iphone" | "macos";
    };
    assertReauthenticationPayloadHash(body);
    const credential = validateAnyMutationTransport(request, dependencies, body.client_kind);
    const preAuthRetryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "reauthenticate",
      accountIdentifier: `route:reauthenticate:${body.client_kind ?? "web"}`,
      clientIdentifier: request.identityContext.clientIdentifier,
      dimensions: "client",
    });
    if (preAuthRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", preAuthRetryAfterMs);
    const authority = await authenticateValidatedMutation(credential, dependencies);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "reauthenticate", accountIdentifier: authority.actorId,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
    });
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
