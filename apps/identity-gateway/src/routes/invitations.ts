import {
  InvitationAcceptanceRequestSchema,
  InvitationAcceptanceResponseSchema,
  InvitationEmailRegistrationRequestSchema,
  InvitationEmailRegistrationResponseSchema,
  InvitationInspectRequestSchema,
  InvitationInspectResponseSchema,
  InvitationRevokeRequestSchema,
  InvitationRevokeResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import { assertClientTransport, requireMutationCredentials } from "../security.js";

async function authenticateMutation(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

export async function registerInvitationRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/invitations/inspect", { schema: { body: InvitationInspectRequestSchema, response: { 200: InvitationInspectResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    return dependencies.operations.executeAuthorityCommand({ kind: "invitation_inspect", payload: request.body });
  });

  app.post("/auth/v1/invitations/register", { schema: { body: InvitationEmailRegistrationRequestSchema, response: { 202: InvitationEmailRegistrationResponseSchema } } }, async (request, reply) => {
    const body = request.body as { email: string; password: string; client_kind: "web" | "iphone" | "macos" } & Record<string, unknown>;
    assertClientTransport(request, body.client_kind, dependencies.config);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "signup", accountIdentifier: body.email, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    await dependencies.provider.signUpEmail({ email: body.email, password: body.password });
    const { password: _password, ...durablePayload } = body;
    await dependencies.operations.executeAuthorityCommand({ kind: "invitation_email_registration", payload: durablePayload });
    return reply.code(202).send({ schema_version: 1, status: "verification_pending" });
  });

  app.post("/auth/v1/invitations/accept", { schema: { body: InvitationAcceptanceRequestSchema, response: { 200: InvitationAcceptanceResponseSchema } } }, async (request, reply) => {
    const body = request.body as { invitation_secret: string; authentication_proof: { kind: "email_password" | "apple"; client_kind: "web" | "iphone" | "macos"; verification_proof?: string }; device_label?: string } & Record<string, unknown>;
    assertClientTransport(request, body.authentication_proof.client_kind, dependencies.config);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "invitation_accept", accountIdentifier: body.invitation_secret, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    const subject = body.authentication_proof.kind === "email_password"
      ? await dependencies.provider.verifyCurrentSubject({ accessToken: body.authentication_proof.verification_proof! })
      : await dependencies.provider.completeApple(body.authentication_proof as never);
    const { authentication_proof: _authenticationProof, device_label: _deviceLabel, ...durablePayload } = body;
    const result = await dependencies.operations.executeAuthorityCommand({ kind: "invitation_accept", payload: durablePayload, verifiedSubject: subject });
    const issued = await dependencies.operations.issueSession(subject, body.authentication_proof.client_kind);
    if (issued.session.client_kind === "web") {
      const { deliverSession } = await import("./email.js");
      const delivery = deliverSession(reply, issued) as Record<string, unknown>;
      return { ...(result as object), ...delivery };
    }
    return { ...(result as object), schema_version: 1, transport: "native", session: issued.session, session_secret: issued.sessionSecret };
  });

  app.post("/auth/v1/invitations/revoke", { schema: { body: InvitationRevokeRequestSchema, response: { 200: InvitationRevokeResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "invitation_revoke", payload: request.body, authority });
  });
}
