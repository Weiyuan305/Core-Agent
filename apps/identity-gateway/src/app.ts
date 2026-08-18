import { randomUUID } from "node:crypto";

import cookie from "@fastify/cookie";
import type { AuthSessionView } from "@core-agent/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { IdentityGatewayConfig } from "./config.js";
import { mapIdentityGatewayError } from "./errors.js";
import type { AppleLinkProviderObservation, AuthProviderAdapter, PasswordResetProviderObservation, ProviderClientKind, VerifiedProviderSubject } from "./providers/auth-provider.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerAppleRoutes } from "./routes/apple.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import {
  clearAppleFlowCookie,
  clearRecoveryCookie,
  MAX_IDENTITY_BODY_BYTES,
  validatePublicTransport,
} from "./security.js";

export const routeSequence = Object.freeze([
  "validate_transport",
  "consume_rate_limit",
  "authenticate_session_if_required",
  "require_recent_reauthentication_if_required",
  "call_provider_if_required",
  "execute_authority_command",
  "issue_or_revoke_core_session",
  "return_public_view",
] as const);

export interface GatewayIssuedSession {
  readonly session: AuthSessionView;
  readonly sessionSecret: string;
  readonly csrfSecret?: string;
}

export interface GatewayAuthenticatedSession {
  readonly actorId: string;
  readonly authSubjectId: string;
  readonly session: Readonly<Record<string, unknown>>;
}

export interface IdentityGatewayOperations {
  readonly beginEmailVerification: (input: {
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly passwordProof: Uint8Array;
    readonly normalizedEmail: string;
    readonly clientKind: ProviderClientKind;
    readonly deviceLabel?: string;
    readonly invitationSecret?: string;
  }) => Promise<{
    readonly verificationId: string;
    readonly kind: "reserved" | "in_progress" | "finalized_replay";
    readonly providerStartAttempt: number;
  }>;
  readonly finalizeEmailVerificationStart: (input: {
    readonly verificationId: string;
    readonly providerStartAttempt: number;
  } & (
    | { readonly outcome: "failed" }
    | { readonly outcome: "finalized"; readonly expectedProviderSubject: string }
  )) => Promise<void>;
  readonly checkpointEmailVerification: (input: {
    readonly verificationId: string;
    readonly verifiedSubject: VerifiedProviderSubject;
  }) => Promise<void>;
  readonly admitEmailVerificationProviderAttempt: (input: {
    readonly verificationId: string;
    readonly verificationProofDigest: string;
  }) => Promise<
    | { readonly kind: "in_progress" }
    | { readonly kind: "verified"; readonly subject: VerifiedProviderSubject }
    | { readonly kind: "started"; readonly expectedProviderSubject: string }
    | { readonly kind: "recovery" }
  >;
  readonly releaseEmailVerificationProviderAttempt: (input: {
    readonly verificationId: string;
    readonly verificationProofDigest: string;
  }) => Promise<void>;
  readonly terminalizeEmailVerificationProviderAttempt: (input: {
    readonly verificationId: string;
    readonly verificationProofDigest: string;
  }) => Promise<void>;
  readonly prepareEmailVerification: (input: {
    readonly verificationId: string;
  }) => Promise<{
    readonly clientKind: ProviderClientKind;
    readonly deviceLabel?: string;
    readonly providerVerification:
      | { readonly kind: "pending"; readonly expectedProviderSubject: string }
      | { readonly kind: "verified"; readonly subject: VerifiedProviderSubject };
  }>;
  readonly completeEmailVerification: (input: {
    readonly verificationId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
  }) => Promise<{
    readonly actorId: string;
    readonly authSubjectId: string;
    readonly clientKind: ProviderClientKind;
    readonly deviceLabel?: string;
    readonly issuedSession: GatewayIssuedSession;
  }>;
  readonly consumeRateLimit: (input: {
    readonly bucketKind: "signup" | "login" | "reset" | "email_verification" | "reset_complete" | "apple_start" | "apple_link" | "apple_callback" | "invitation_accept" | "reauthenticate";
    readonly accountIdentifier: string;
    readonly clientIdentifier: string;
    readonly dimensions?: "both" | "account" | "client";
  }) => Promise<number | null>;
  readonly preparePasswordReset: (normalizedEmail: string) => Promise<VerifiedProviderSubject>;
  readonly issueSession: (
    subject: VerifiedProviderSubject,
    clientKind: ProviderClientKind,
    deviceLabel?: string,
    idempotency?: {
      readonly idempotencyKey: string;
      readonly payloadHash: string;
      readonly operation: "email_sign_in" | "email_verification" | "apple_sign_in" | "invitation_accept";
      /** Transient caller-owned bytes; implementations must not retain them. */
      readonly secretProof?: Uint8Array;
    },
  ) => Promise<GatewayIssuedSession>;
  readonly authenticateSession: (input: {
    readonly sessionSecret: string;
    readonly csrfSecret?: string;
    readonly requireCsrf: boolean;
    readonly advanceActivity?: boolean;
  }) => Promise<GatewayAuthenticatedSession>;
  /** Implementations must use Task 6's caller-owned transaction guard. */
  readonly requireRecentReauthentication: (authority: GatewayAuthenticatedSession) => Promise<void>;
  readonly loadNormalizedEmail: (authority: GatewayAuthenticatedSession) => Promise<string>;
  readonly readAppleLinkSettlement: (input: {
    readonly transactionId: string;
    readonly actorId: string;
    readonly payloadHash: string;
  }) => Promise<string>;
  /** Protected durable implementations recheck authority and mutate in one caller-owned transaction. */
  readonly executeAuthorityCommand: (input: {
    readonly kind: string;
    readonly payload: unknown;
    readonly authority?: GatewayAuthenticatedSession;
    readonly verifiedSubject?: VerifiedProviderSubject;
    readonly passwordResetObservation?: PasswordResetProviderObservation;
    /** Transient caller-owned bytes; implementations must not retain them. */
    readonly secretProof?: Uint8Array;
  }) => Promise<unknown>;
  /** Rechecks recent authority and performs the durable mutation in one caller-owned transaction. */
  readonly executeProtectedAuthorityCommand: (input: {
    readonly kind: string;
    readonly payload: unknown;
    readonly authority: GatewayAuthenticatedSession;
    readonly verifiedSubject?: VerifiedProviderSubject;
    readonly appleLinkObservation?: AppleLinkProviderObservation;
  }) => Promise<unknown>;
}

export interface BuildIdentityGatewayAppDependencies {
  readonly config: Pick<IdentityGatewayConfig,
    | "publicOrigins"
    | "cookieHost"
    | "publicBaseUrl"
    | "providerUrl"
    | "appleWebRedirectUris"
    | "appleNativeRedirectUris"
    | "passwordResetRedirectUri"
    | "publicAuthEnabled"
  > & { readonly trustedProxyAddresses?: ReadonlySet<string> };
  readonly provider: AuthProviderAdapter;
  readonly operations: IdentityGatewayOperations;
  readonly flowCookieKey: Uint8Array;
  readonly now?: () => Date;
}

export interface IdentityGatewayRequestContext {
  readonly requestId: string;
  readonly traceId: string;
  readonly clientIdentifier: string;
}

declare module "fastify" {
  interface FastifyRequest {
    identityContext: IdentityGatewayRequestContext;
  }
}

function clientIdentifier(request: FastifyRequest): string {
  const address = request.ip;
  return typeof address === "string" && address.length > 0 && address.length <= 128 ? address : "unknown-client";
}

export async function buildIdentityGatewayApp(dependencies: BuildIdentityGatewayAppDependencies): Promise<FastifyInstance> {
  const trustedProxyAddresses = dependencies.config.trustedProxyAddresses ?? new Set<string>();
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_IDENTITY_BODY_BYTES,
    requestIdHeader: false,
    genReqId: () => `request_${randomUUID()}`,
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
    trustProxy: (address) => trustedProxyAddresses.has(address),
  });
  await app.register(cookie);
  app.decorateRequest("identityContext");

  app.addHook("onRequest", async (request) => {
    request.identityContext = Object.freeze({
      requestId: request.id,
      traceId: `trace_${randomUUID()}`,
      clientIdentifier: clientIdentifier(request),
    });
    if (request.url === "/auth/v1" || request.url.startsWith("/auth/v1/")) {
      validatePublicTransport(request, dependencies.config);
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const identifiers = request.identityContext ?? {
      requestId: request.id,
      traceId: `trace_${randomUUID()}`,
    };
    const path = request.url.split("?", 1)[0];
    const mapped = mapIdentityGatewayError(error, identifiers);
    if ((path === "/auth/v1/apple/callback" || path === "/auth/v1/apple/link/callback" || path === "/auth/v1/invitations/accept")
      && request.cookies?.core_agent_apple_flow !== undefined
      && mapped.statusCode < 500 && mapped.statusCode !== 429) clearAppleFlowCookie(reply);
    if (path === "/auth/v1/password/reset/complete" && request.cookies?.core_agent_recovery !== undefined
      && mapped.statusCode < 500 && mapped.statusCode !== 429) clearRecoveryCookie(reply);
    void reply.code(mapped.statusCode).type("application/json").send(mapped.envelope);
  });

  const shared = Object.freeze({ ...dependencies, now: dependencies.now ?? (() => new Date()) });
  await registerEmailRoutes(app, shared);
  await registerAppleRoutes(app, shared);
  await registerSessionRoutes(app, shared);
  await registerInvitationRoutes(app, shared);
  await registerCompanyRoutes(app, shared);
  await registerAccountRoutes(app, shared);
  return app;
}

export type IdentityGatewayRouteDependencies = BuildIdentityGatewayAppDependencies & { readonly now: () => Date };
