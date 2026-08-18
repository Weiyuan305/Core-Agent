import {
  EmailSignInRequestSchema,
  EmailSignInResponseSchema,
  EmailSignUpRequestSchema,
  EmailSignUpResponseSchema,
  EmailVerificationRequestSchema,
  EmailVerificationResponseSchema,
  PasswordResetRequestSchema,
  PasswordResetCompletionRequestSchema,
  PasswordResetResponseSchema,
} from "@core-agent/contracts";
import { canonicalPayloadHash } from "@core-agent/runtime-core";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { GatewayIssuedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import { ProviderFailure } from "../providers/provider-errors.js";
import type { VerifiedProviderSubject } from "../providers/auth-provider.js";
import {
  assertClientTransport,
  assertEmailVerificationPayloadHash,
  issueRecoveryCookie,
  issueWebSessionCookies,
  readRecoveryCookie,
  RECOVERY_COOKIE_NAME,
  clearRecoveryCookie,
  sealRecoveryCookie,
} from "../security.js";

function rateLimitFailure(retryAfterMs: number | null): void {
  if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
}

function clientKind(body: unknown): "web" | "iphone" | "macos" {
  const value = (body as { client_kind?: unknown }).client_kind;
  if (value !== "web" && value !== "iphone" && value !== "macos") throw new IdentityGatewayFailure("INVALID_REQUEST");
  return value;
}

function deliverSession(reply: FastifyReply, issued: GatewayIssuedSession, expectedClientKind: "web" | "iphone" | "macos"): unknown {
  if (issued.session.client_kind !== expectedClientKind) throw new IdentityGatewayFailure("INTERNAL_ERROR");
  if (expectedClientKind === "web") {
    if (issued.csrfSecret === undefined) throw new IdentityGatewayFailure("INTERNAL_ERROR");
    issueWebSessionCookies(reply, issued.sessionSecret, issued.csrfSecret);
    return { schema_version: 1, transport: "web_cookie", session: issued.session };
  }
  return { schema_version: 1, transport: "native", session: issued.session, session_secret: issued.sessionSecret };
}

async function completeReservedEmailProviderStart(
  dependencies: IdentityGatewayRouteDependencies,
  binding: { readonly verificationId: string },
  credential: { readonly email: string; readonly password: string },
): Promise<void> {
  try {
    const started = await dependencies.provider.signUpEmail(credential);
    await dependencies.operations.finalizeEmailVerificationStart({
      verificationId: binding.verificationId,
      outcome: "finalized",
      expectedProviderSubject: started.expectedProviderSubject,
    });
  } catch (error) {
    if (error instanceof ProviderFailure && error.code !== "AUTH_PROVIDER_UNAVAILABLE") {
      await dependencies.operations.finalizeEmailVerificationStart({
        verificationId: binding.verificationId, outcome: "failed",
      });
    }
    throw error;
  }
}

export async function registerEmailRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/email/sign-up", { schema: { body: EmailSignUpRequestSchema, response: { 202: EmailSignUpResponseSchema } } }, async (request, reply) => {
    const body = request.body as { email: string; password: string; client_kind: "web" | "iphone" | "macos" };
    assertClientTransport(request, body.client_kind, dependencies.config);
    const normalizedEmail = body.email.toLowerCase();
    rateLimitFailure(await dependencies.operations.consumeRateLimit({ bucketKind: "signup", accountIdentifier: normalizedEmail, clientIdentifier: request.identityContext.clientIdentifier }));
    const idempotency = request.body as { idempotency_key: string; payload_hash: string; device_label?: string };
    const binding = await dependencies.operations.beginEmailVerification({
      idempotencyKey: idempotency.idempotency_key,
      payloadHash: idempotency.payload_hash,
      normalizedEmail,
      clientKind: body.client_kind,
      ...(idempotency.device_label === undefined ? {} : { deviceLabel: idempotency.device_label }),
    });
    if (binding.kind === "in_progress") throw new IdentityGatewayFailure("AUTH_CONFLICT");
    if (binding.kind === "reserved") {
      await completeReservedEmailProviderStart(dependencies, binding, { email: normalizedEmail, password: body.password });
    }
    return reply.code(202).send({ schema_version: 1, verification_id: binding.verificationId, status: "verification_pending" });
  });

  app.post("/auth/v1/email/sign-in", { schema: { body: EmailSignInRequestSchema, response: { 200: EmailSignInResponseSchema } } }, async (request, reply) => {
    const body = request.body as { email: string; password: string; client_kind: "web" | "iphone" | "macos"; device_label?: string };
    assertClientTransport(request, body.client_kind, dependencies.config);
    const normalizedEmail = body.email.toLowerCase();
    rateLimitFailure(await dependencies.operations.consumeRateLimit({ bucketKind: "login", accountIdentifier: normalizedEmail, clientIdentifier: request.identityContext.clientIdentifier }));
    const subject = await dependencies.provider.signInEmail({ email: normalizedEmail, password: body.password });
    const requestIdempotency = request.body as { idempotency_key: string; payload_hash: string };
    const issued = await dependencies.operations.issueSession(subject, body.client_kind, body.device_label, {
      idempotencyKey: requestIdempotency.idempotency_key,
      payloadHash: requestIdempotency.payload_hash,
      operation: "email_sign_in",
    });
    return deliverSession(reply, issued, body.client_kind);
  });

  app.post("/auth/v1/email/verification", { schema: { body: EmailVerificationRequestSchema, response: { 200: EmailVerificationResponseSchema } } }, async (request, reply) => {
    const body = request.body as {
      schema_version: 1; idempotency_key: string; payload_hash: string;
      verification_id: string; verification_code: string;
    };
    assertEmailVerificationPayloadHash(body);
    const binding = await dependencies.operations.prepareEmailVerification({ verificationId: body.verification_id });
    assertClientTransport(request, binding.clientKind, dependencies.config);
    rateLimitFailure(await dependencies.operations.consumeRateLimit({
      bucketKind: "email_verification", accountIdentifier: "route:email_verification",
      clientIdentifier: request.identityContext.clientIdentifier,
    }));
    const providerVerification = binding.providerVerification;
    let subject: VerifiedProviderSubject;
    if (providerVerification.kind === "verified") {
      subject = providerVerification.subject;
    } else {
      const verificationProofDigest = `sha256:${createHash("sha256").update(body.verification_code, "utf8").digest("hex")}`;
      const attempt = await dependencies.operations.admitEmailVerificationProviderAttempt({
        verificationId: body.verification_id,
        verificationProofDigest,
      });
      if (attempt.kind === "in_progress") throw new IdentityGatewayFailure("AUTH_CONFLICT");
      if (attempt.kind === "verified") {
        subject = attempt.subject;
      } else {
        let verificationFailure: unknown;
        try {
          subject = await dependencies.provider.verifyEmail({
            verificationCode: body.verification_code,
            expectedProviderSubject: attempt.expectedProviderSubject,
          });
        } catch (error) {
          verificationFailure = error;
          const recovery = await dependencies.operations.readEmailVerificationProviderRecovery({
            verificationId: body.verification_id,
            verificationProofDigest,
          });
          try {
            subject = await dependencies.provider.recoverVerifiedEmailSubject({
              expectedProviderSubject: recovery.expectedProviderSubject,
              expectedNormalizedEmail: recovery.expectedNormalizedEmail,
              verificationStartedAt: recovery.verificationStartedAt,
              recoveryNotAfter: recovery.recoveryNotAfter,
            });
          } catch (recoveryError) {
            if (verificationFailure instanceof ProviderFailure
              && verificationFailure.code === "AUTH_CALLBACK_INVALID"
              && recoveryError instanceof ProviderFailure
              && (recoveryError.code === "AUTH_CALLBACK_INVALID" || recoveryError.code === "AUTH_EMAIL_UNVERIFIED")) {
              await dependencies.operations.releaseEmailVerificationProviderAttempt({
                verificationId: body.verification_id,
                verificationProofDigest,
              });
              throw verificationFailure;
            }
            throw recoveryError;
          }
        }
        await dependencies.operations.checkpointEmailVerification({
          verificationId: body.verification_id,
          verifiedSubject: subject,
        });
      }
    }
    const requestIdempotency = request.body as { idempotency_key: string; payload_hash: string };
    const completed = await dependencies.operations.completeEmailVerification({
      verificationId: body.verification_id,
      idempotencyKey: requestIdempotency.idempotency_key,
      payloadHash: requestIdempotency.payload_hash,
    });
    return deliverSession(reply, completed.issuedSession, binding.clientKind);
  });

  app.post("/auth/v1/password/reset/start", { schema: { body: PasswordResetRequestSchema, response: { 202: PasswordResetResponseSchema } } }, async (request, reply) => {
    assertClientTransport(request, "web", dependencies.config);
    const body = request.body as { email: string };
    const normalizedEmail = body.email.toLowerCase();
    rateLimitFailure(await dependencies.operations.consumeRateLimit({ bucketKind: "reset", accountIdentifier: normalizedEmail, clientIdentifier: request.identityContext.clientIdentifier }));
    const idempotency = request.body as { idempotency_key: string; payload_hash: string };
    const binding = await dependencies.provider.beginPasswordReset({
      email: normalizedEmail,
      idempotencyKey: idempotency.idempotency_key,
      payloadHash: idempotency.payload_hash,
    });
    issueRecoveryCookie(reply, sealRecoveryCookie(dependencies.flowCookieKey, { transactionId: binding.transaction_id, state: binding.state, expiresAt: binding.expires_at }));
    return reply.code(202).send({ schema_version: 1, accepted: true });
  });

  app.post("/auth/v1/password/reset/complete", { schema: { body: PasswordResetCompletionRequestSchema, response: { 200: PasswordResetResponseSchema } } }, async (request, reply) => {
    assertClientTransport(request, "web", dependencies.config);
    rateLimitFailure(await dependencies.operations.consumeRateLimit({
      bucketKind: "reset_complete", accountIdentifier: "route:password_reset_completion",
      clientIdentifier: request.identityContext.clientIdentifier,
    }));
    const sealed = request.cookies[RECOVERY_COOKIE_NAME];
    if (sealed === undefined) throw new IdentityGatewayFailure("AUTH_INVALID");
    const binding = readRecoveryCookie(dependencies.flowCookieKey, sealed, dependencies.now());
    const body = request.body as {
      schema_version: 1; idempotency_key: string; payload_hash: string;
      authorization_code: string; new_password: string;
    };
    const expectedPayloadHash = canonicalPayloadHash({
      schema_version: body.schema_version, idempotency_key: body.idempotency_key,
      reset_code_digest: `sha256:${createHash("sha256").update(body.authorization_code, "utf8").digest("hex")}`,
      new_value_digest: `sha256:${createHash("sha256").update(body.new_password, "utf8").digest("hex")}`,
    });
    if (body.payload_hash !== expectedPayloadHash) throw new IdentityGatewayFailure("INVALID_REQUEST");
    const subject = await dependencies.provider.completePasswordReset({
      binding: { transaction_id: binding.transactionId, state: binding.state, expires_at: binding.expiresAt },
      authorization_code: body.authorization_code,
      new_password: body.new_password,
      payloadHash: expectedPayloadHash,
    });
    await dependencies.operations.executeAuthorityCommand({
      kind: "password_reset_completed",
      payload: { idempotency_key: body.idempotency_key, payload_hash: body.payload_hash, transaction_id: binding.transactionId },
      verifiedSubject: subject,
    });
    clearRecoveryCookie(reply);
    return { schema_version: 1, accepted: true };
  });
}

export { completeReservedEmailProviderStart, deliverSession };
