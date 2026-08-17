import { randomUUID } from "node:crypto";

import {
  EmailSignInRequestSchema,
  EmailSignInResponseSchema,
  EmailSignUpRequestSchema,
  EmailSignUpResponseSchema,
  EmailVerificationRequestSchema,
  EmailVerificationResponseSchema,
  PasswordResetRequestSchema,
  PasswordResetResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Type from "typebox";

import type { GatewayIssuedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import {
  assertClientTransport,
  issueRecoveryCookie,
  issueWebSessionCookies,
  readRecoveryCookie,
  RECOVERY_COOKIE_NAME,
  clearRecoveryCookie,
  sealRecoveryCookie,
} from "../security.js";

const PasswordResetCompleteRequestSchema = Type.Object({
  schema_version: Type.Literal(1),
  authorization_code: Type.String({ minLength: 8, maxLength: 4_096 }),
  new_password: Type.String({ minLength: 8, maxLength: 1_024 }),
}, { additionalProperties: false });

function rateLimitFailure(retryAfterMs: number | null): void {
  if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
}

function clientKind(body: unknown): "web" | "iphone" | "macos" {
  const value = (body as { client_kind?: unknown }).client_kind;
  if (value !== "web" && value !== "iphone" && value !== "macos") throw new IdentityGatewayFailure("INVALID_REQUEST");
  return value;
}

function deliverSession(reply: FastifyReply, issued: GatewayIssuedSession): unknown {
  if (issued.session.client_kind === "web") {
    if (issued.csrfSecret === undefined) throw new IdentityGatewayFailure("INTERNAL_ERROR");
    issueWebSessionCookies(reply, issued.sessionSecret, issued.csrfSecret);
    return { schema_version: 1, transport: "web_cookie", session: issued.session };
  }
  return { schema_version: 1, transport: "native", session: issued.session, session_secret: issued.sessionSecret };
}

export async function registerEmailRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/email/sign-up", { schema: { body: EmailSignUpRequestSchema, response: { 202: EmailSignUpResponseSchema } } }, async (request, reply) => {
    const body = request.body as { email: string; password: string; client_kind: "web" | "iphone" | "macos" };
    assertClientTransport(request, body.client_kind, dependencies.config);
    rateLimitFailure(await dependencies.operations.consumeRateLimit({ bucketKind: "signup", accountIdentifier: body.email, clientIdentifier: request.identityContext.clientIdentifier }));
    await dependencies.provider.signUpEmail({ email: body.email, password: body.password });
    return reply.code(202).send({ schema_version: 1, verification_id: `verification_${randomUUID()}`, status: "verification_pending" });
  });

  app.post("/auth/v1/email/sign-in", { schema: { body: EmailSignInRequestSchema, response: { 200: EmailSignInResponseSchema } } }, async (request, reply) => {
    const body = request.body as { email: string; password: string; client_kind: "web" | "iphone" | "macos"; device_label?: string };
    assertClientTransport(request, body.client_kind, dependencies.config);
    rateLimitFailure(await dependencies.operations.consumeRateLimit({ bucketKind: "login", accountIdentifier: body.email, clientIdentifier: request.identityContext.clientIdentifier }));
    const subject = await dependencies.provider.signInEmail({ email: body.email, password: body.password });
    const issued = await dependencies.operations.issueSession(subject, body.client_kind, body.device_label);
    return deliverSession(reply, issued);
  });

  app.post("/auth/v1/email/verification", { schema: { body: EmailVerificationRequestSchema, response: { 200: EmailVerificationResponseSchema } } }, async (request) => {
    return dependencies.operations.executeAuthorityCommand({ kind: "email_verification", payload: request.body });
  });

  app.post("/auth/v1/password/reset/start", { schema: { body: PasswordResetRequestSchema, response: { 202: PasswordResetResponseSchema } } }, async (request, reply) => {
    assertClientTransport(request, "web", dependencies.config);
    const body = request.body as { email: string };
    rateLimitFailure(await dependencies.operations.consumeRateLimit({ bucketKind: "reset", accountIdentifier: body.email, clientIdentifier: request.identityContext.clientIdentifier }));
    const binding = await dependencies.provider.beginPasswordReset(body.email);
    issueRecoveryCookie(reply, sealRecoveryCookie(dependencies.flowCookieKey, { transactionId: binding.transaction_id, state: binding.state, expiresAt: binding.expires_at }));
    return reply.code(202).send({ schema_version: 1, accepted: true });
  });

  app.post("/auth/v1/password/reset/complete", { schema: { body: PasswordResetCompleteRequestSchema, response: { 200: PasswordResetResponseSchema } } }, async (request, reply) => {
    assertClientTransport(request, "web", dependencies.config);
    clearRecoveryCookie(reply);
    const sealed = request.cookies[RECOVERY_COOKIE_NAME];
    if (sealed === undefined) throw new IdentityGatewayFailure("AUTH_INVALID");
    const binding = readRecoveryCookie(dependencies.flowCookieKey, sealed, dependencies.now());
    const body = request.body as { authorization_code: string; new_password: string };
    const subject = await dependencies.provider.completePasswordReset({
      binding: { transaction_id: binding.transactionId, state: binding.state, expires_at: binding.expiresAt },
      authorization_code: body.authorization_code,
      new_password: body.new_password,
    });
    await dependencies.operations.executeAuthorityCommand({ kind: "password_reset_completed", payload: {}, verifiedSubject: subject });
    return { schema_version: 1, accepted: true };
  });
}

export { deliverSession };
