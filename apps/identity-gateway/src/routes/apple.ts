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
  assertAppleCallbackPayloadHash,
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

function authorizationState(start: AppleAuthorizationStart, providerUrl: string, redirectUri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(start.authorization_url);
  } catch {
    throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  const state = parsed.searchParams.get("state");
  const redirectValues = [...parsed.searchParams.getAll("redirect_to"), ...parsed.searchParams.getAll("redirect_uri")];
  const provider = new URL(providerUrl);
  const providerEndpoint = parsed.origin === provider.origin && parsed.pathname === "/auth/v1/authorize"
    && redirectValues.length === 1 && redirectValues[0] === redirectUri;
  const directAppleEndpoint = new URL(redirectUri).protocol === "coreagent:"
    && parsed.origin === "https://appleid.apple.com" && parsed.pathname === "/auth/authorize"
    && redirectValues.length === 1 && redirectValues[0] === new URL("/auth/v1/callback", provider).toString();
  if ((!providerEndpoint && !directAppleEndpoint) || parsed.protocol !== "https:"
    || parsed.username !== "" || parsed.password !== ""
    || parsed.hash !== "" || parsed.searchParams.getAll("state").length !== 1
    || state === null || state.length < 1 || state.length > 4_096
    || parsed.searchParams.has("next") || parsed.searchParams.has("return_to")) {
    throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  return state;
}

function issueFlowCookie(reply: FastifyReply, dependencies: IdentityGatewayRouteDependencies, start: AppleAuthorizationStart, redirectUri: string, flowKind: "sign_in" | "link"): void {
  issueAppleFlowCookie(reply, sealAppleFlowCookie(dependencies.flowCookieKey, {
    transactionId: start.transaction_id,
    state: authorizationState(start, dependencies.config.providerUrl, redirectUri),
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

export function canonicalWebAppleCallback(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: IdentityGatewayRouteDependencies,
  body: AppleCallbackBody,
  flowKind: "sign_in" | "link",
): AppleAuthorizationCallback {
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
  const authority = clientKind === "web"
    ? await authenticateMutation(request, dependencies)
    : await dependencies.operations.authenticateSession({
      sessionSecret: requireNativeSessionCredential(request),
      requireCsrf: false,
    });
  if (authority.session.client_kind !== clientKind) throw new IdentityGatewayFailure("AUTH_INVALID");
  return authority;
}

async function consumePreAuthRateLimit(
  request: FastifyRequest,
  dependencies: IdentityGatewayRouteDependencies,
  bucketKind: "apple_start" | "apple_link" | "apple_callback",
  routeKey: string,
): Promise<void> {
  const retryAfterMs = await dependencies.operations.consumeRateLimit({
    bucketKind,
    accountIdentifier: routeKey,
    clientIdentifier: request.identityContext.clientIdentifier,
  });
  if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
}

export async function registerAppleRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/apple/start", { schema: { body: AppleAuthorizationStartRequestSchema } }, async (request, reply) => {
    const body = request.body as AppleStartBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertExactRedirect(body.client_kind, body.redirect_uri, dependencies.config);
    await consumePreAuthRateLimit(request, dependencies, "apple_start", `route:apple_start:${body.client_kind}`);
    const start = await dependencies.provider.beginApple(request.body as never);
    authorizationState(start, dependencies.config.providerUrl, body.redirect_uri);
    if (body.client_kind === "web") {
      issueFlowCookie(reply, dependencies, start, body.redirect_uri, "sign_in");
      return { schema_version: 1, authorization_url: start.authorization_url };
    }
    return nativeStartResponse(start);
  });

  app.post("/auth/v1/apple/callback", { schema: { body: AppleAuthorizationCallbackRequestSchema, response: { 200: AppleAuthorizationCallbackResponseSchema } } }, async (request, reply) => {
    const body = request.body as AppleCallbackBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertAppleCallbackPayloadHash(body, "apple_sign_in");
    await consumePreAuthRateLimit(request, dependencies, "apple_callback", "route:apple_sign_in_callback");
    const callback = body.client_kind === "web"
      ? canonicalWebAppleCallback(request, reply, dependencies, body, "sign_in")
      : body;
    const subject = await dependencies.provider.completeApple(callback);
    const issued = await dependencies.operations.issueSession(subject, body.client_kind, body.device_label, {
      idempotencyKey: body.idempotency_key,
      payloadHash: body.payload_hash,
      operation: "apple_sign_in",
    });
    if (body.client_kind === "web") clearAppleFlowCookie(reply);
    return deliverSession(reply, issued, body.client_kind);
  });

  app.post("/auth/v1/apple/link/start", { schema: { body: AppleIdentityLinkStartRequestSchema } }, async (request, reply) => {
    const body = request.body as AppleStartBody & { readonly password: string };
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertExactRedirect(body.client_kind, body.redirect_uri, dependencies.config);
    await consumePreAuthRateLimit(request, dependencies, "apple_link", `route:apple_link:${body.client_kind}`);
    const authority = await authenticateClientMutation(request, dependencies, body.client_kind);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({ bucketKind: "reauthenticate", accountIdentifier: authority.actorId, clientIdentifier: request.identityContext.clientIdentifier });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    await dependencies.operations.requireRecentReauthentication(authority);
    const email = await dependencies.operations.loadNormalizedEmail(authority);
    const start = await dependencies.provider.reauthenticateAndBeginAppleLink({
      ...(request.body as object),
      authenticatedActorId: authority.actorId,
      email,
    } as never);
    authorizationState(start, dependencies.config.providerUrl, body.redirect_uri);
    if (body.client_kind === "web") {
      issueFlowCookie(reply, dependencies, start, body.redirect_uri, "link");
      return { schema_version: 1, authorization_url: start.authorization_url };
    }
    return nativeStartResponse(start);
  });

  app.post("/auth/v1/apple/link/callback", { schema: { body: AppleIdentityLinkRequestSchema, response: { 200: AppleIdentityLinkResponseSchema } } }, async (request, reply) => {
    const body = request.body as AppleCallbackBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertAppleCallbackPayloadHash(body, "apple_link");
    await consumePreAuthRateLimit(request, dependencies, "apple_callback", "route:apple_link_callback");
    const authority = await authenticateClientMutation(request, dependencies, body.client_kind);
    await dependencies.operations.requireRecentReauthentication(authority);
    const callback = body.client_kind === "web"
      ? canonicalWebAppleCallback(request, reply, dependencies, body, "link")
      : body;
    const subject = await dependencies.provider.linkApple({ ...callback, authenticatedActorId: authority.actorId });
    const result = await dependencies.operations.executeProtectedAuthorityCommand({
      kind: "apple_identity_link",
      payload: {
        schema_version: body.schema_version, idempotency_key: body.idempotency_key,
        payload_hash: body.payload_hash, transaction_id: callback.transaction_id,
      },
      authority,
      verifiedSubject: subject,
    });
    if (body.client_kind === "web") clearAppleFlowCookie(reply);
    return result;
  });
}
