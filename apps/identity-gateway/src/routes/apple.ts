import {
  AppleAuthorizationCallbackRequestSchema,
  AppleAuthorizationCallbackResponseSchema,
  AppleAuthorizationStartRequestSchema,
  AppleIdentityLinkRequestSchema,
  AppleIdentityLinkResponseSchema,
  AppleIdentityLinkStartRequestSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import type { AppleAuthorizationCallback, AppleAuthorizationStart } from "../providers/auth-provider.js";
import {
  APPLE_FLOW_COOKIE_NAME,
  assertClientTransport,
  assertExactRedirect,
  clearAppleFlowCookie,
  issueAppleFlowCookie,
  readAppleFlowCookie,
  requireMutationCredentials,
  requireNativeSessionCredential,
  sealAppleFlowCookie,
  safeSecretEqual,
} from "../security.js";
import { deliverSession } from "./email.js";

type AppleStartBody = {
  readonly client_kind: "web" | "iphone" | "macos";
  readonly redirect_uri: string;
  readonly device_label?: string;
  readonly password?: string;
};

type AppleCallbackBody = AppleAuthorizationCallback & { readonly device_label?: string };

function authorizationState(start: AppleAuthorizationStart, providerUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(start.authorization_url);
  } catch {
    throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  const state = parsed.searchParams.get("state");
  if (parsed.origin !== new URL(providerUrl).origin || parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || state === null || state.length < 1 || state.length > 4_096) {
    throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  return state;
}

function issueFlowCookie(reply: FastifyReply, dependencies: IdentityGatewayRouteDependencies, start: AppleAuthorizationStart, flowKind: "sign_in" | "link"): void {
  issueAppleFlowCookie(reply, sealAppleFlowCookie(dependencies.flowCookieKey, {
    transactionId: start.transaction_id,
    state: authorizationState(start, dependencies.config.providerUrl),
    expiresAt: start.expires_at,
    flowKind,
  }));
}

function nativeStartResponse(start: AppleAuthorizationStart): Record<string, unknown> {
  return {
    schema_version: 1,
    transaction_id: start.transaction_id,
    authorization_url: start.authorization_url,
    expires_at: start.expires_at,
  };
}

function canonicalWebCallback(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: IdentityGatewayRouteDependencies,
  body: AppleCallbackBody,
  flowKind: "sign_in" | "link",
): AppleAuthorizationCallback {
  clearAppleFlowCookie(reply);
  const sealed = request.cookies[APPLE_FLOW_COOKIE_NAME];
  if (sealed === undefined) throw new IdentityGatewayFailure("AUTH_INVALID");
  const binding = readAppleFlowCookie(dependencies.flowCookieKey, sealed, dependencies.now());
  if (binding.flowKind !== flowKind || !safeSecretEqual(binding.transactionId, body.transaction_id) || !safeSecretEqual(binding.state, body.state)) {
    throw new IdentityGatewayFailure("AUTH_INVALID");
  }
  return {
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    payload_hash: body.payload_hash,
    client_kind: "web",
    transaction_id: binding.transactionId,
    authorization_code: body.authorization_code,
    state: binding.state,
  };
}

async function authenticateMutation(request: FastifyRequest, dependencies: IdentityGatewayRouteDependencies): Promise<GatewayAuthenticatedSession> {
  const credential = requireMutationCredentials(request);
  return dependencies.operations.authenticateSession({ sessionSecret: credential.sessionSecret, csrfSecret: credential.csrfSecret, requireCsrf: true });
}

async function authenticateClientMutation(
  request: FastifyRequest,
  dependencies: IdentityGatewayRouteDependencies,
  clientKind: "web" | "iphone" | "macos",
): Promise<GatewayAuthenticatedSession> {
  if (clientKind === "web") return authenticateMutation(request, dependencies);
  return dependencies.operations.authenticateSession({
    sessionSecret: requireNativeSessionCredential(request),
    requireCsrf: false,
  });
}

export async function registerAppleRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/apple/start", { schema: { body: AppleAuthorizationStartRequestSchema } }, async (request, reply) => {
    const body = request.body as AppleStartBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertExactRedirect(body.client_kind, body.redirect_uri, dependencies.config);
    const start = await dependencies.provider.beginApple(request.body as never);
    authorizationState(start, dependencies.config.providerUrl);
    if (body.client_kind === "web") {
      issueFlowCookie(reply, dependencies, start, "sign_in");
      return { schema_version: 1, authorization_url: start.authorization_url };
    }
    return nativeStartResponse(start);
  });

  app.post("/auth/v1/apple/callback", { schema: { body: AppleAuthorizationCallbackRequestSchema, response: { 200: AppleAuthorizationCallbackResponseSchema } } }, async (request, reply) => {
    const body = request.body as AppleCallbackBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "apple_callback", accountIdentifier: body.transaction_id, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    const callback = body.client_kind === "web"
      ? canonicalWebCallback(request, reply, dependencies, body, "sign_in")
      : body;
    const subject = await dependencies.provider.completeApple(callback);
    const issued = await dependencies.operations.issueSession(subject, body.client_kind, body.device_label);
    return deliverSession(reply, issued);
  });

  app.post("/auth/v1/apple/link/start", { schema: { body: AppleIdentityLinkStartRequestSchema } }, async (request, reply) => {
    const body = request.body as AppleStartBody & { readonly password: string };
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertExactRedirect(body.client_kind, body.redirect_uri, dependencies.config);
    const authority = await authenticateClientMutation(request, dependencies, body.client_kind);
    await dependencies.operations.requireRecentReauthentication(authority);
    const email = await dependencies.operations.loadNormalizedEmail(authority);
    const start = await dependencies.provider.reauthenticateAndBeginAppleLink({
      ...(request.body as object),
      authenticatedActorId: authority.actorId,
      email,
    } as never);
    authorizationState(start, dependencies.config.providerUrl);
    if (body.client_kind === "web") {
      issueFlowCookie(reply, dependencies, start, "link");
      return { schema_version: 1, authorization_url: start.authorization_url };
    }
    return nativeStartResponse(start);
  });

  app.post("/auth/v1/apple/link/callback", { schema: { body: AppleIdentityLinkRequestSchema, response: { 200: AppleIdentityLinkResponseSchema } } }, async (request, reply) => {
    const body = request.body as AppleCallbackBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    const authority = await authenticateClientMutation(request, dependencies, body.client_kind);
    await dependencies.operations.requireRecentReauthentication(authority);
    const callback = body.client_kind === "web"
      ? canonicalWebCallback(request, reply, dependencies, body, "link")
      : body;
    const subject = await dependencies.provider.linkApple({ ...callback, authenticatedActorId: authority.actorId });
    return dependencies.operations.executeProtectedAuthorityCommand({ kind: "apple_identity_link", payload: {}, authority, verifiedSubject: subject });
  });
}
