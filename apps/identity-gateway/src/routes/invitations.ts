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
import { ProviderFailure } from "../providers/provider-errors.js";
import { assertClientTransport, assertInvitationAcceptancePayloadHash, clearAppleFlowCookie, requireMutationCredentials, requireNativeSessionCredential } from "../security.js";
import { canonicalWebAppleCallback } from "./apple.js";
import { completeReservedEmailProviderStart, deliverSession } from "./email.js";

async function authenticateMutation(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

async function authenticateClientMutation(
  request: FastifyRequest,
  dependencies: IdentityGatewayRouteDependencies,
  clientKind: "web" | "iphone" | "macos",
): Promise<GatewayAuthenticatedSession> {
  const authority = clientKind === "web"
    ? await authenticateMutation(request, dependencies)
    : await dependencies.operations.authenticateSession({
      sessionSecret: requireNativeSessionCredential(request), requireCsrf: false,
    });
  if (authority.session.client_kind !== clientKind) throw new IdentityGatewayFailure("AUTH_INVALID");
  return authority;
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
    const retryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "signup", accountIdentifier: "route:invitation_register",
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "client",
    });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    const inspected = await dependencies.operations.executeAuthorityCommand({
      kind: "invitation_rate_identity", payload: { invitation_secret: body.invitation_secret },
    }) as { readonly invitation_id?: unknown };
    if (typeof inspected.invitation_id !== "string") throw new IdentityGatewayFailure("AUTH_INVALID");
    const accountRetryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "signup", accountIdentifier: inspected.invitation_id,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
    });
    if (accountRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", accountRetryAfterMs);
    const passwordProof = Buffer.from(body.password, "utf8");
    let binding: Awaited<ReturnType<typeof dependencies.operations.beginEmailVerification>>;
    try {
      binding = await dependencies.operations.beginEmailVerification({
        idempotencyKey: body.idempotency_key,
        payloadHash: body.payload_hash,
        passwordProof,
        normalizedEmail,
        clientKind: body.client_kind,
        ...(body.device_label === undefined ? {} : { deviceLabel: body.device_label }),
        invitationSecret: String(body.invitation_secret),
      });
    } finally {
      passwordProof.fill(0);
    }
    if (binding.kind === "in_progress") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    if (binding.kind === "reserved") {
      await completeReservedEmailProviderStart(dependencies, binding, { email: normalizedEmail, password: body.password });
    }
    return reply.code(202).send({ schema_version: 1, verification_id: binding.verificationId, status: "verification_pending" });
  });

  app.post("/auth/v1/invitations/accept", { schema: { body: InvitationAcceptanceRequestSchema, response: { 200: InvitationAcceptanceResponseSchema } } }, async (request, reply) => {
    const body = request.body as {
      invitation_secret: string;
      client_kind?: "web" | "iphone" | "macos";
      authentication_proof?: {
        kind: "apple" | "email_password";
        client_kind: "web" | "iphone" | "macos";
      };
      device_label?: string;
    } & Record<string, unknown>;
    assertInvitationAcceptancePayloadHash(body as never);
    if ((body.client_kind === undefined) === (body.authentication_proof === undefined)) {
      throw new IdentityGatewayFailure("INVALID_REQUEST");
    }
    // The 0.5 provider-proof shape remains parseable for additive wire
    // compatibility, but it is never authentication authority in the Gateway.
    if (body.authentication_proof?.kind === "email_password") {
      throw new IdentityGatewayFailure("INVALID_REQUEST");
    }
    const expectedClientKind = body.client_kind ?? body.authentication_proof?.client_kind;
    if (expectedClientKind === undefined) throw new IdentityGatewayFailure("INVALID_REQUEST");
    assertClientTransport(request, expectedClientKind, dependencies.config);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "invitation_accept", accountIdentifier: "route:invitation_accept",
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "client",
    });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    if (body.authentication_proof?.kind === "apple") {
      const appleRetryAfterMs = await dependencies.operations.consumeRateLimit({
        bucketKind: "apple_callback",
        accountIdentifier: "route:apple_invitation_callback",
        clientIdentifier: request.identityContext.clientIdentifier,
        dimensions: "client",
      });
      if (appleRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", appleRetryAfterMs);
    }
    const inspected = await dependencies.operations.executeAuthorityCommand({
      kind: "invitation_rate_identity", payload: { invitation_secret: body.invitation_secret },
    }) as { readonly invitation_id?: unknown };
    if (typeof inspected.invitation_id !== "string") throw new IdentityGatewayFailure("AUTH_INVALID");
    const accountRetryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "invitation_accept", accountIdentifier: inspected.invitation_id,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
    });
    if (accountRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", accountRetryAfterMs);
    const authority = body.authentication_proof === undefined
      ? await authenticateClientMutation(request, dependencies, expectedClientKind)
      : undefined;
    const subject = body.authentication_proof === undefined
      ? undefined
      : await dependencies.provider.completeApple(body.authentication_proof.client_kind === "web"
        ? canonicalWebAppleCallback(request, reply, dependencies, {
          ...(body.authentication_proof as unknown as Record<string, unknown>),
          schema_version: body.schema_version as 1,
          idempotency_key: body.idempotency_key as string,
          payload_hash: body.payload_hash as `sha256:${string}`,
        } as never, "sign_in")
        : body.authentication_proof as never);
    const { authentication_proof: _authenticationProof, client_kind: _clientKind, device_label: _deviceLabel, ...durablePayload } = body;
    const result = await dependencies.operations.executeAuthorityCommand({
      kind: "invitation_accept",
      payload: { ...durablePayload, device_label: body.device_label, client_kind: expectedClientKind },
      ...(authority === undefined ? {} : { authority }),
      ...(subject === undefined ? {} : { verifiedSubject: subject }),
    }) as Record<string, unknown> & { issuedSession?: GatewayIssuedSession };
    if (result.issuedSession === undefined) throw new IdentityGatewayFailure("INTERNAL_ERROR");
    const { issuedSession, ...publicResult } = result;
    const delivery = deliverSession(reply, issuedSession, expectedClientKind) as Record<string, unknown>;
    if (body.authentication_proof?.kind === "apple" && expectedClientKind === "web") clearAppleFlowCookie(reply);
    return { ...publicResult, ...delivery };
  });

  app.post("/auth/v1/invitations/revoke", { schema: { body: InvitationRevokeRequestSchema, response: { 200: InvitationRevokeResponseSchema } } }, async (request) => {
    assertClientTransport(request, "web", dependencies.config);
    const authority = await authenticateMutation(request, dependencies);
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "invitation_revoke", payload: request.body, authority });
  });
}
