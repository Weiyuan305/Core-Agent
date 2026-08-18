import {
  AppleAuthorizationCallbackRequestSchema,
  AppleAuthorizationCallbackResponseSchema,
  AppleAuthorizationStartRequestSchema,
  AppleAuthorizationStartResponseSchema,
  AppleIdentityLinkRequestSchema,
  AppleIdentityLinkResponseSchema,
  AppleIdentityLinkStartRequestSchema,
  AppleIdentityLinkStartResponseSchema,
} from "@core-agent/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { GatewayAuthenticatedSession, IdentityGatewayRouteDependencies } from "../app.js";
import { IdentityGatewayFailure } from "../errors.js";
import {
  type AppleAuthorizationCallback,
  type AppleAuthorizationStart,
  type AppleLinkProviderObservation,
} from "../providers/auth-provider.js";
import { ProviderFailure } from "../providers/provider-errors.js";
import {
  ANONYMOUS_APPLE_START_GLOBAL_CIRCUIT_BREAKER_ACCOUNT,
  APPLE_LINK_SETTLEMENT_SECONDS,
  APPLE_FLOW_COOKIE_NAME,
  appleFlowStateMatches,
  assertAppleCallbackPayloadHash,
  assertClientTransport,
  assertExactRedirect,
  clearAppleFlowCookie,
  issueAppleFlowCookie,
  issueAppleLinkSettlementCookie,
  isOAuthProofString,
  readAppleFlowCookie,
  requireMutationCredentials,
  requireNativeSessionCredential,
  sealAppleFlowCookie,
  safeSecretEqual,
} from "../security.js";
import { isProviderAuthorizationUrl } from "../oauth-proof.js";
import { deliverSession } from "./email.js";

type AppleStartBody = {
  readonly idempotency_key: string;
  readonly client_kind: "web" | "iphone" | "macos";
  readonly redirect_uri: string;
  readonly device_label?: string;
  readonly nonce?: string;
  readonly pkce_code_challenge?: string;
  readonly password?: string;
};

type AppleCallbackBody = AppleAuthorizationCallback & { readonly device_label?: string };

function authorizationState(start: AppleAuthorizationStart, providerUrl: string, redirectUri: string): string {
  if (!isProviderAuthorizationUrl(start.authorization_url)) {
    throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
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
    || !isOAuthProofString(state)
    || parsed.searchParams.has("next") || parsed.searchParams.has("return_to")) {
    throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  return state;
}

function issueFlowCookie(
  reply: FastifyReply,
  dependencies: IdentityGatewayRouteDependencies,
  start: AppleAuthorizationStart,
  state: string,
  flowKind: "sign_in" | "link",
  actorId?: string,
): void {
  const binding = {
    transactionId: start.transaction_id,
    state,
    expiresAt: start.expires_at,
    flowKind,
    ...(actorId === undefined ? {} : { actorId }),
    ...(flowKind === "link" ? {
      settlementNotAfter: new Date(Date.parse(start.expires_at) + APPLE_LINK_SETTLEMENT_SECONDS * 1_000).toISOString(),
    } : {}),
  } as const;
  const sealed = sealAppleFlowCookie(dependencies.flowCookieKey, binding);
  if (flowKind === "link") issueAppleLinkSettlementCookie(reply, sealed);
  else issueAppleFlowCookie(reply, sealed);
}

function isAppleLinkObservation(value: unknown): value is AppleLinkProviderObservation {
  return typeof value === "object" && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 4
    && (value as { kind?: unknown }).kind === "apple_link_provider_observation"
    && (value as { outcome?: unknown }).outcome === "in_progress"
    && typeof (value as { transactionId?: unknown }).transactionId === "string"
    && typeof (value as { payloadHash?: unknown }).payloadHash === "string";
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
  expectedActorId?: string,
): AppleAuthorizationCallback {
  const sealed = request.cookies[APPLE_FLOW_COOKIE_NAME];
  if (sealed === undefined) throw new IdentityGatewayFailure("AUTH_INVALID");
  const binding = readAppleFlowCookie(dependencies.flowCookieKey, sealed, dependencies.now());
  if (binding.flowKind !== flowKind || binding.clientKind !== "web"
    || !safeSecretEqual(binding.transactionId, body.transaction_id)
    || !appleFlowStateMatches(dependencies.flowCookieKey, binding, body.state)
    || (flowKind === "sign_in" && binding.actorId !== undefined)
    || (flowKind === "link" && (binding.actorId === undefined || expectedActorId === undefined
      || !safeSecretEqual(binding.actorId, expectedActorId)))) {
    throw new IdentityGatewayFailure("AUTH_INVALID");
  }
  return {
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    payload_hash: body.payload_hash,
    client_kind: "web",
    transaction_id: binding.transactionId,
    authorization_code: body.authorization_code,
    state: body.state,
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
    dimensions: "client",
  });
  if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
}

export async function registerAppleRoutes(app: FastifyInstance, dependencies: IdentityGatewayRouteDependencies): Promise<void> {
  app.post("/auth/v1/apple/start", { schema: { body: AppleAuthorizationStartRequestSchema, response: { 200: AppleAuthorizationStartResponseSchema } } }, async (request, reply) => {
    const body = request.body as AppleStartBody;
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertExactRedirect(body.client_kind, body.redirect_uri, dependencies.config);
    await consumePreAuthRateLimit(request, dependencies, "apple_start", `route:apple_start:${body.client_kind}`);
    const accountRetryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "apple_start", accountIdentifier: ANONYMOUS_APPLE_START_GLOBAL_CIRCUIT_BREAKER_ACCOUNT,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
      policy: "anonymous_apple_start_global_circuit_breaker",
    });
    if (accountRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", accountRetryAfterMs);
    const start = await dependencies.provider.beginApple(request.body as never);
    const state = authorizationState(start, dependencies.config.providerUrl, body.redirect_uri);
    if (body.client_kind === "web") {
      issueFlowCookie(reply, dependencies, start, state, "sign_in");
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
    const accountRetryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "apple_callback", accountIdentifier: callback.transaction_id,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
    });
    if (accountRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", accountRetryAfterMs);
    const subject = await dependencies.provider.completeApple(callback);
    const issued = await dependencies.operations.issueSession(subject, body.client_kind, body.device_label, {
      idempotencyKey: body.idempotency_key,
      payloadHash: body.payload_hash,
      operation: "apple_sign_in",
    });
    if (body.client_kind === "web") clearAppleFlowCookie(reply);
    return deliverSession(reply, issued, body.client_kind);
  });

  app.post("/auth/v1/apple/link/start", { schema: { body: AppleIdentityLinkStartRequestSchema, response: { 200: AppleIdentityLinkStartResponseSchema } } }, async (request, reply) => {
    const body = request.body as AppleStartBody & { readonly password: string };
    assertClientTransport(request, body.client_kind, dependencies.config);
    assertExactRedirect(body.client_kind, body.redirect_uri, dependencies.config);
    await consumePreAuthRateLimit(request, dependencies, "apple_link", `route:apple_link:${body.client_kind}`);
    const authority = await authenticateClientMutation(request, dependencies, body.client_kind);
    const retryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "apple_link", accountIdentifier: authority.actorId,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
    });
    if (retryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", retryAfterMs);
    await dependencies.operations.requireRecentReauthentication(authority);
    const email = await dependencies.operations.loadNormalizedEmail(authority);
    const start = await dependencies.provider.reauthenticateAndBeginAppleLink({
      ...(request.body as object),
      authenticatedActorId: authority.actorId,
      email,
    } as never);
    const state = authorizationState(start, dependencies.config.providerUrl, body.redirect_uri);
    if (body.client_kind === "web") {
      issueFlowCookie(reply, dependencies, start, state, "link", authority.actorId);
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
    const accountRetryAfterMs = await dependencies.operations.consumeRateLimit({
      bucketKind: "apple_callback", accountIdentifier: authority.actorId,
      clientIdentifier: request.identityContext.clientIdentifier, dimensions: "account",
    });
    if (accountRetryAfterMs !== null) throw new IdentityGatewayFailure("AUTH_RATE_LIMITED", accountRetryAfterMs);
    await dependencies.operations.requireRecentReauthentication(authority);
    const callback = body.client_kind === "web"
      ? canonicalWebAppleCallback(request, reply, dependencies, body, "link", authority.actorId)
      : body;
    let subject = await dependencies.provider.linkApple({ ...callback, authenticatedActorId: authority.actorId });
    if (isAppleLinkObservation(subject)) {
      const observation = subject;
      const observed = await dependencies.operations.executeProtectedAuthorityCommand({
        kind: "apple_link_provider_observation",
        payload: {
          schema_version: body.schema_version, payload_hash: body.payload_hash,
          transaction_id: callback.transaction_id,
        },
        authority,
        appleLinkObservation: observation,
      }) as { readonly kind?: unknown; readonly verifiedSubject?: unknown };
      if (observed.kind === "in_progress") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      if (observed.kind !== "completed" || observed.verifiedSubject === undefined) {
        throw new IdentityGatewayFailure("AUTH_INVALID");
      }
      subject = observed.verifiedSubject as never;
    }
    const settlementNotAfter = await dependencies.operations.readAppleLinkSettlement({
      transactionId: callback.transaction_id,
      actorId: authority.actorId,
      payloadHash: body.payload_hash,
    });
    if (body.client_kind === "web") {
      const sealed = request.cookies[APPLE_FLOW_COOKIE_NAME];
      if (sealed === undefined) throw new IdentityGatewayFailure("AUTH_INVALID");
      const binding = readAppleFlowCookie(dependencies.flowCookieKey, sealed, dependencies.now());
      issueAppleLinkSettlementCookie(reply, sealAppleFlowCookie(dependencies.flowCookieKey, {
        transactionId: binding.transactionId, state: body.state,
        ...(binding.actorId === undefined ? {} : { actorId: binding.actorId }),
        expiresAt: binding.expiresAt, flowKind: binding.flowKind,
        settlementNotAfter,
      }));
    }
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
