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

import type { GatewayAuthenticatedSession, GatewayIssuedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import { assertClientTransport, assertInvitationAcceptancePayloadHash, requireMutationCredentials } from "../security.js";
import { canonicalWebAppleCallback } from "./apple.js";
import { completeReservedEmailProviderStart, deliverSession } from "./email.js";

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
    const body = request.body as {
      idempotency_key: string;
      payload_hash: string;
      email: string;
      password: string;
      client_kind: "web" | "iphone" | "macos";
      device_label?: string;
    } & Record<string, unknown>;
    assertClientTransport(request, body.client_kind, dependencies.config);
    const normalizedEmail = body.email.toLowerCase();
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "signup", accountIdentifier: normalizedEmail, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    const binding = await dependencies.operations.beginEmailVerification({
      idempotencyKey: body.idempotency_key,
      payloadHash: body.payload_hash,
      normalizedEmail,
      clientKind: body.client_kind,
      ...(body.device_label === undefined ? {} : { deviceLabel: body.device_label }),
      invitationSecret: String(body.invitation_secret),
    });
    if (binding.kind === "in_progress") throw new IdentityGatewayFailure("AUTH_CONFLICT");
    if (binding.kind === "reserved") {
      await completeReservedEmailProviderStart(dependencies, binding, { email: normalizedEmail, password: body.password });
    }
    return reply.code(202).send({ schema_version: 1, verification_id: binding.verificationId, status: "verification_pending" });
  });

  app.post("/auth/v1/invitations/accept", { schema: { body: InvitationAcceptanceRequestSchema, response: { 200: InvitationAcceptanceResponseSchema } } }, async (request, reply) => {
    const body = request.body as { invitation_secret: string; authentication_proof: { kind: "email_password" | "apple"; client_kind: "web" | "iphone" | "macos"; verification_proof?: string }; device_label?: string } & Record<string, unknown>;
    assertInvitationAcceptancePayloadHash(body as never);
    assertClientTransport(request, body.authentication_proof.client_kind, dependencies.config);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "invitation_accept", accountIdentifier: body.invitation_secret, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    if (body.authentication_proof.kind === "apple") {
      const appleRetryAfterMs = await dependencies.operations.consumeRateLimit({
        bucketKind: "apple_callback",
        accountIdentifier: "route:apple_invitation_callback",
        clientIdentifier: request.identityContext.clientIdentifier,
      });
      if (appleRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", appleRetryAfterMs);
    }
    const subject = body.authentication_proof.kind === "email_password"
      ? await dependencies.provider.verifyCurrentSubject({ accessToken: body.authentication_proof.verification_proof! })
      : await dependencies.provider.completeApple(body.authentication_proof.client_kind === "web"
        ? canonicalWebAppleCallback(request, reply, dependencies, {
          ...(body.authentication_proof as unknown as Record<string, unknown>),
          schema_version: body.schema_version as 1,
          idempotency_key: body.idempotency_key as string,
          payload_hash: body.payload_hash as `sha256:${string}`,
        } as never, "sign_in")
        : body.authentication_proof as never);
    const { authentication_proof: _authenticationProof, device_label: _deviceLabel, ...durablePayload } = body;
    const result = await dependencies.operations.executeAuthorityCommand({
      kind: "invitation_accept",
      payload: { ...durablePayload, device_label: body.device_label, client_kind: body.authentication_proof.client_kind },
      verifiedSubject: subject,
    }) as Record<string, unknown> & { issuedSession?: GatewayIssuedSession };
    if (result.issuedSession === undefined) throw new IdentityGatewayFailure("INTERNAL_ERROR");
    const { issuedSession, ...publicResult } = result;
    const delivery = deliverSession(reply, issuedSession, body.authentication_proof.client_kind) as Record<string, unknown>;
    return { ...publicResult, ...delivery };
  });

  app.post("/auth/v1/invitations/revoke", { schema: { body: InvitationRevokeRequestSchema, response: { 200: InvitationRevokeResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "invitation_revoke", payload: request.body, authority });
  });
}
