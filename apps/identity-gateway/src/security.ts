import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { canonicalPayloadHash } from "@core-agent/runtime-core";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { IdentityGatewayConfig } from "./config.js";
import { IdentityGatewayFailure } from "./errors.js";

export const MAX_IDENTITY_BODY_BYTES = 64 * 1024;
export const CORE_SESSION_COOKIE_NAME = "core_agent_session";
export const CORE_CSRF_COOKIE_NAME = "core_agent_csrf";
export const RECOVERY_COOKIE_NAME = "core_agent_recovery";
export const APPLE_FLOW_COOKIE_NAME = "core_agent_apple_flow";
export const ANONYMOUS_APPLE_START_GLOBAL_CIRCUIT_BREAKER_ACCOUNT = "global-circuit-breaker:anonymous-apple-start";
export const ANONYMOUS_APPLE_START_GLOBAL_CIRCUIT_BREAKER_LIMIT = 2_000;
export const ANONYMOUS_APPLE_START_GLOBAL_CIRCUIT_BREAKER_WINDOW_MS = 15 * 60 * 1_000;
export const CSRF_HEADER_NAME = "x-core-agent-csrf";
export const CORE_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const flowMaxAgeSeconds = 5 * 60;
export const PASSWORD_RESET_SETTLEMENT_SECONDS = 30 * 60;
export const APPLE_LINK_SETTLEMENT_SECONDS = 30 * 60;
const recoveryCookieMaxAgeSeconds = flowMaxAgeSeconds + PASSWORD_RESET_SETTLEMENT_SECONDS;
const APPLE_FLOW_COOKIE_MAX_HEADER_BYTES = 2_048;
const MAX_OAUTH_PROOF_CODE_POINTS = 4_096;
const MAX_OAUTH_PROOF_UTF8_BYTES = MAX_OAUTH_PROOF_CODE_POINTS * 4;

export interface RecoveryCookieBinding {
  readonly transactionId: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly settlementNotAfter: string;
}

export interface AppleFlowCookieBinding {
  readonly transactionId: string;
  readonly stateDigest: string;
  readonly clientKind: "web";
  readonly actorId?: string;
  readonly expiresAt: string;
  readonly flowKind: "sign_in" | "link";
  readonly settlementNotAfter?: string;
}

export interface AppleFlowCookieInput {
  readonly transactionId: string;
  readonly state: string;
  readonly actorId?: string;
  readonly expiresAt: string;
  readonly flowKind: "sign_in" | "link";
  readonly settlementNotAfter?: string;
}

function invalidRequest(): never {
  throw new IdentityGatewayFailure("INVALID_REQUEST");
}

function invalidAuthentication(): never {
  throw new IdentityGatewayFailure("AUTH_INVALID");
}

export function rawHeaderValues(request: FastifyRequest, name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === name) values.push(request.raw.rawHeaders[index + 1] ?? "");
  }
  return values;
}

export function validatePublicTransport(request: FastifyRequest, config: Pick<IdentityGatewayConfig, "cookieHost" | "publicOrigins" | "publicAuthEnabled">): void {
  if (!config.publicAuthEnabled) throw new IdentityGatewayFailure("AUTH_PROVIDER_UNAVAILABLE");
  const hosts = rawHeaderValues(request, "host");
  const origins = rawHeaderValues(request, "origin");
  if (hosts.length !== 1 || hosts[0] !== config.cookieHost || origins.length > 1) invalidRequest();
  if (origins.length === 1 && !config.publicOrigins.has(origins[0]!)) invalidRequest();
  const cookies = rawHeaderValues(request, "cookie");
  const authorization = rawHeaderValues(request, "authorization");
  if (
    cookies.length > 1
    || authorization.length > 1
    || cookies.some((value) => value.includes(","))
    || authorization.some((value) => value.includes(","))
  ) invalidRequest();
  const sensitiveCookies = new Set([
    CORE_SESSION_COOKIE_NAME,
    CORE_CSRF_COOKIE_NAME,
    RECOVERY_COOKIE_NAME,
    APPLE_FLOW_COOKIE_NAME,
  ]);
  if (cookies.length === 1) {
    const seen = new Set<string>();
    for (const pair of cookies[0]!.split(";")) {
      const separator = pair.indexOf("=");
      const name = separator < 0 ? pair.trim() : pair.slice(0, separator).trim();
      if (sensitiveCookies.has(name) && seen.has(name)) invalidRequest();
      if (sensitiveCookies.has(name)) seen.add(name);
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const contentTypes = rawHeaderValues(request, "content-type");
    if (contentTypes.length !== 1 || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentTypes[0]!)) invalidRequest();
  }
}

export function assertClientTransport(request: FastifyRequest, clientKind: "web" | "iphone" | "macos", config: Pick<IdentityGatewayConfig, "publicOrigins">): void {
  const origins = rawHeaderValues(request, "origin");
  const cookies = rawHeaderValues(request, "cookie");
  const authorization = rawHeaderValues(request, "authorization");
  if (clientKind === "web") {
    if (origins.length !== 1 || !config.publicOrigins.has(origins[0]!) || authorization.length !== 0) invalidRequest();
  } else if (origins.length !== 0 || cookies.length !== 0) invalidRequest();
}

export function assertExactRedirect(
  clientKind: "web" | "iphone" | "macos",
  redirectUri: string,
  config: Pick<IdentityGatewayConfig, "appleWebRedirectUris" | "appleNativeRedirectUris">,
): void {
  const allowed = clientKind === "web" ? config.appleWebRedirectUris : config.appleNativeRedirectUris;
  if (!allowed.has(redirectUri)) invalidRequest();
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const existing = reply.getHeader("set-cookie");
  if (existing === undefined) reply.header("set-cookie", value);
  else if (Array.isArray(existing)) reply.header("set-cookie", [...existing.map(String), value]);
  else reply.header("set-cookie", [String(existing), value]);
}

function cookieValue(value: string): string {
  if (!/^[A-Za-z0-9._~-]+$/u.test(value)) throw new IdentityGatewayFailure("INTERNAL_ERROR");
  return value;
}

export function issueWebSessionCookies(reply: FastifyReply, sessionSecret: string, csrfSecret: string): void {
  appendSetCookie(reply, `${CORE_SESSION_COOKIE_NAME}=${cookieValue(sessionSecret)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${CORE_SESSION_MAX_AGE_SECONDS}`);
  appendSetCookie(reply, `${CORE_CSRF_COOKIE_NAME}=${cookieValue(csrfSecret)}; Secure; SameSite=Lax; Path=/; Max-Age=${CORE_SESSION_MAX_AGE_SECONDS}`);
}

export function clearWebSessionCookies(reply: FastifyReply): void {
  appendSetCookie(reply, `${CORE_SESSION_COOKIE_NAME}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  appendSetCookie(reply, `${CORE_CSRF_COOKIE_NAME}=; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

function flowCookie(reply: FastifyReply, name: string, value: string, path: string, maxAgeSeconds = flowMaxAgeSeconds): void {
  appendSetCookie(reply, `${name}=${cookieValue(value)}; Secure; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSeconds}`);
}

function clearFlowCookie(reply: FastifyReply, name: string, path: string): void {
  appendSetCookie(reply, `${name}=; Secure; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0`);
}

export function issueRecoveryCookie(reply: FastifyReply, value: string): void {
  flowCookie(reply, RECOVERY_COOKIE_NAME, value, "/auth/v1/password/reset/complete", recoveryCookieMaxAgeSeconds);
}

export function clearRecoveryCookie(reply: FastifyReply): void {
  clearFlowCookie(reply, RECOVERY_COOKIE_NAME, "/auth/v1/password/reset/complete");
}

export function issueAppleFlowCookie(reply: FastifyReply, value: string): void {
  issueBoundedAppleFlowCookie(reply, value, flowMaxAgeSeconds);
}

export function issueAppleLinkSettlementCookie(reply: FastifyReply, value: string): void {
  issueBoundedAppleFlowCookie(reply, value, flowMaxAgeSeconds + APPLE_LINK_SETTLEMENT_SECONDS);
}

export function clearAppleFlowCookie(reply: FastifyReply): void {
  clearFlowCookie(reply, APPLE_FLOW_COOKIE_NAME, "/auth/v1");
}

function assertFlowKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new IdentityGatewayFailure("INTERNAL_ERROR");
  return Buffer.from(key);
}

function issueBoundedAppleFlowCookie(reply: FastifyReply, value: string, maxAgeSeconds: number): void {
  const header = `${APPLE_FLOW_COOKIE_NAME}=${cookieValue(value)}; Secure; HttpOnly; SameSite=Lax; Path=/auth/v1; Max-Age=${maxAgeSeconds}`;
  if (Buffer.byteLength(header, "utf8") >= APPLE_FLOW_COOKIE_MAX_HEADER_BYTES) {
    throw new IdentityGatewayFailure("INTERNAL_ERROR");
  }
  appendSetCookie(reply, header);
}

function seal(key: Uint8Array, purpose: "recovery" | "apple", value: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", assertFlowKey(key), iv);
  cipher.setAAD(Buffer.from(`core-agent:${purpose}:v1`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
}

function open(key: Uint8Array, purpose: "recovery" | "apple", value: string): unknown {
  const sealedValuePattern = purpose === "apple"
    ? /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,1536}\.[A-Za-z0-9_-]{22}$/u
    : /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{22}$/u;
  if (!sealedValuePattern.test(value)) invalidAuthentication();
  const fields = value.split(".");
  try {
    const iv = Buffer.from(fields[1]!, "base64url");
    const encrypted = Buffer.from(fields[2]!, "base64url");
    const tag = Buffer.from(fields[3]!, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", assertFlowKey(key), iv);
    decipher.setAAD(Buffer.from(`core-agent:${purpose}:v1`, "utf8"));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as unknown;
  } catch {
    invalidAuthentication();
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 2_048;
}

export function isOAuthProofString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let codePoints = 0;
  for (const _character of value) {
    codePoints += 1;
    if (codePoints > MAX_OAUTH_PROOF_CODE_POINTS) return false;
  }
  return codePoints >= 8 && Buffer.byteLength(value, "utf8") <= MAX_OAUTH_PROOF_UTF8_BYTES;
}

function appleFlowStateDigest(key: Uint8Array, flowKind: "sign_in" | "link", state: string): string {
  if (!isOAuthProofString(state)) invalidAuthentication();
  const ownedKey = assertFlowKey(key);
  const ownedState = Buffer.from(state, "utf8");
  try {
    const digest = createHmac("sha256", ownedKey)
      .update(`core-agent:apple-flow:${flowKind}:state:v1\0`, "utf8")
      .update(ownedState)
      .digest("base64url");
    return `hmac-sha256:${digest}`;
  } finally {
    ownedKey.fill(0);
    ownedState.fill(0);
  }
}

function strictFutureUtc(value: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value && timestamp > now.getTime();
}

function strictUtc(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : undefined;
}

export function sealRecoveryCookie(key: Uint8Array, binding: Omit<RecoveryCookieBinding, "settlementNotAfter">): string {
  const authorizationExpiry = strictUtc(binding.expiresAt);
  if (authorizationExpiry === undefined) invalidAuthentication();
  const settlementNotAfter = new Date(authorizationExpiry + PASSWORD_RESET_SETTLEMENT_SECONDS * 1_000).toISOString();
  return seal(key, "recovery", {
    transaction_id: binding.transactionId, state: binding.state, expires_at: binding.expiresAt,
    settlement_not_after: settlementNotAfter,
  });
}

export function readRecoveryCookie(key: Uint8Array, value: string, _now: Date): RecoveryCookieBinding {
  const parsed = open(key, "recovery", value);
  if (!exactRecord(parsed, ["transaction_id", "state", "expires_at", "settlement_not_after"])
    || !boundedString(parsed.transaction_id) || !boundedString(parsed.state)
    || !boundedString(parsed.expires_at) || !boundedString(parsed.settlement_not_after)) invalidAuthentication();
  const authorizationExpiry = strictUtc(parsed.expires_at);
  const settlementNotAfter = strictUtc(parsed.settlement_not_after);
  // Authenticate the deadline but let the database clock durably terminalize an expired checkpoint.
  if (authorizationExpiry === undefined || settlementNotAfter === undefined
    || settlementNotAfter !== authorizationExpiry + PASSWORD_RESET_SETTLEMENT_SECONDS * 1_000) invalidAuthentication();
  return {
    transactionId: parsed.transaction_id, state: parsed.state, expiresAt: parsed.expires_at,
    settlementNotAfter: parsed.settlement_not_after,
  };
}

export function sealAppleFlowCookie(key: Uint8Array, binding: AppleFlowCookieInput): string {
  if (!isOAuthProofString(binding.state)
    || (binding.flowKind === "sign_in" && binding.actorId !== undefined)
    || (binding.flowKind === "link" && !boundedString(binding.actorId))) invalidAuthentication();
  return seal(key, "apple", {
    transaction_id: binding.transactionId,
    state_digest: appleFlowStateDigest(key, binding.flowKind, binding.state),
    client_kind: "web",
    ...(binding.actorId === undefined ? {} : { actor_id: binding.actorId }),
    expires_at: binding.expiresAt, flow_kind: binding.flowKind,
    ...(binding.settlementNotAfter === undefined ? {} : { settlement_not_after: binding.settlementNotAfter }),
  });
}

export function readAppleFlowCookie(key: Uint8Array, value: string, now: Date): AppleFlowCookieBinding {
  const parsed = open(key, "apple", value);
  const hasSettlement = typeof parsed === "object" && parsed !== null
    && Object.prototype.hasOwnProperty.call(parsed, "settlement_not_after");
  const flowKind = typeof parsed === "object" && parsed !== null
    ? (parsed as { readonly flow_kind?: unknown }).flow_kind : undefined;
  const keys = flowKind === "link"
    ? hasSettlement
      ? ["transaction_id", "state_digest", "client_kind", "actor_id", "expires_at", "flow_kind", "settlement_not_after"]
      : ["transaction_id", "state_digest", "client_kind", "actor_id", "expires_at", "flow_kind"]
    : ["transaction_id", "state_digest", "client_kind", "expires_at", "flow_kind"];
  if (!exactRecord(parsed, keys) || !boundedString(parsed.transaction_id)
    || typeof parsed.state_digest !== "string" || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/u.test(parsed.state_digest)
    || parsed.client_kind !== "web" || !boundedString(parsed.expires_at)
    || (flowKind !== "sign_in" && flowKind !== "link")
    || (flowKind === "link" && !boundedString(parsed.actor_id))) {
    invalidAuthentication();
  }
  const authExpiry = strictUtc(parsed.expires_at);
  const settlementNotAfter = hasSettlement && boundedString(parsed.settlement_not_after)
    ? strictUtc(parsed.settlement_not_after) : undefined;
  if (authExpiry === undefined || (!hasSettlement && authExpiry <= now.getTime())
    || hasSettlement && (parsed.flow_kind !== "link" || settlementNotAfter === undefined
      || settlementNotAfter !== authExpiry + APPLE_LINK_SETTLEMENT_SECONDS * 1_000)) {
    invalidAuthentication();
  }
  return {
    transactionId: parsed.transaction_id, stateDigest: parsed.state_digest, clientKind: "web",
    ...(flowKind === "link" ? { actorId: parsed.actor_id as string } : {}),
    expiresAt: parsed.expires_at, flowKind,
    ...(settlementNotAfter === undefined ? {} : { settlementNotAfter: new Date(settlementNotAfter).toISOString() }),
  };
}

export function appleFlowStateMatches(
  key: Uint8Array,
  binding: Pick<AppleFlowCookieBinding, "flowKind" | "stateDigest">,
  state: string,
): boolean {
  if (!isOAuthProofString(state)) return false;
  return safeSecretEqual(binding.stateDigest, appleFlowStateDigest(key, binding.flowKind, state));
}

export function safeSecretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function sensitiveFactDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function assertCanonicalHash(supplied: string, facts: Readonly<Record<string, unknown>>): void {
  if (!safeSecretEqual(supplied, canonicalPayloadHash(facts))) invalidRequest();
}

export function assertEmailVerificationPayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly verification_id: string;
  readonly verification_code: string;
}): void {
  assertCanonicalHash(body.payload_hash, {
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    verification_id: body.verification_id,
    verification_code: body.verification_code,
  });
}

export function assertEmailSignInPayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly email: string;
  readonly password: string;
  readonly client_kind: "web" | "iphone" | "macos";
  readonly device_label?: string;
}): void {
  assertCanonicalHash(body.payload_hash, {
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    normalized_email: body.email.toLowerCase(),
    sign_in_proof_digest: sensitiveFactDigest(body.password),
    client_kind: body.client_kind,
    ...(body.device_label === undefined ? {} : { device_label: body.device_label }),
  });
}

export function assertAppleCallbackPayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly client_kind: "web" | "iphone" | "macos";
  readonly transaction_id: string;
  readonly authorization_code: string;
  readonly state: string;
  readonly nonce?: string;
  readonly pkce_code_verifier?: string;
}, flowKind: "apple_sign_in" | "apple_link"): void {
  assertCanonicalHash(body.payload_hash, {
    schema_version: body.schema_version,
    flow_kind: flowKind,
    idempotency_key: body.idempotency_key,
    client_kind: body.client_kind,
    transaction_id: body.transaction_id,
    code_proof_digest: sensitiveFactDigest(body.authorization_code),
    state_proof_digest: sensitiveFactDigest(body.state),
    ...(body.nonce === undefined ? {} : { nonce_proof_digest: sensitiveFactDigest(body.nonce) }),
    ...(body.pkce_code_verifier === undefined ? {} : {
      pkce_proof_digest: sensitiveFactDigest(body.pkce_code_verifier),
    }),
  });
}

export function assertReauthenticationPayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly expected_resource_version: number;
  readonly password: string;
  readonly client_kind?: "web" | "iphone" | "macos";
}): void {
  assertCanonicalHash(body.payload_hash, reauthenticationDurableFacts(body));
}

export function reauthenticationDurableFacts(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly expected_resource_version: number;
  readonly password: string;
  readonly client_kind?: "web" | "iphone" | "macos";
}): Readonly<{
  schema_version: 1;
  idempotency_key: string;
  expected_resource_version: number;
  client_kind?: "web" | "iphone" | "macos";
  reauthentication_proof_digest: string;
}> {
  return Object.freeze({
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    expected_resource_version: body.expected_resource_version,
    ...(body.client_kind === undefined ? {} : { client_kind: body.client_kind }),
    reauthentication_proof_digest: sensitiveFactDigest(body.password),
  });
}

export function assertInvitationAcceptancePayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly expected_resource_version: number;
  readonly invitation_secret: string;
  readonly client_kind?: "web" | "iphone" | "macos";
  readonly authentication_proof?: Readonly<Record<string, unknown>>;
  readonly device_label?: string;
}): void {
  const proof = body.authentication_proof;
  let canonicalProof: Readonly<Record<string, unknown>>;
  if (proof === undefined && body.client_kind !== undefined) {
    canonicalProof = {
      kind: "core_session",
      client_kind: body.client_kind,
    };
  } else if (proof?.kind === "apple") {
    const clientKind = proof.client_kind;
    const nonce = proof.nonce;
    const pkceCodeVerifier = proof.pkce_code_verifier;
    const expectedKeys = clientKind === "web"
      ? ["kind", "client_kind", "transaction_id", "authorization_code", "state"]
      : clientKind === "iphone" || clientKind === "macos"
        ? ["kind", "client_kind", "transaction_id", "authorization_code", "state", "nonce", "pkce_code_verifier"]
        : undefined;
    if (expectedKeys === undefined || !exactRecord(proof, expectedKeys)
      || !boundedString(proof.transaction_id) || !isOAuthProofString(proof.authorization_code)
      || !isOAuthProofString(proof.state)
      || (clientKind !== "web" && (!isOAuthProofString(nonce) || !boundedString(pkceCodeVerifier)))) {
      invalidRequest();
    }
    canonicalProof = {
      kind: "apple",
      client_kind: clientKind,
      callback_proof_digest: canonicalPayloadHash({
        kind: "apple",
        client_kind: clientKind,
        transaction_id: proof.transaction_id,
        code_proof_digest: sensitiveFactDigest(proof.authorization_code),
        state_proof_digest: sensitiveFactDigest(proof.state),
        ...(clientKind === "web" ? {} : {
          nonce_proof_digest: sensitiveFactDigest(nonce as string),
          pkce_proof_digest: sensitiveFactDigest(pkceCodeVerifier as string),
        }),
      }),
    };
  } else if (proof !== undefined) {
    canonicalProof = {
      kind: proof.kind,
      client_kind: proof.client_kind,
      callback_proof_digest: sensitiveFactDigest(JSON.stringify(proof)),
    };
  } else {
    invalidRequest();
  }
  assertCanonicalHash(body.payload_hash, {
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    expected_resource_version: body.expected_resource_version,
    invitation_digest: sensitiveFactDigest(body.invitation_secret),
    authentication: canonicalProof,
    ...(body.device_label === undefined ? {} : { device_label: body.device_label }),
  });
}

export type ProtectedWritePayloadKind =
  | "company_create"
  | "company_member_invite"
  | "company_consultant_grant"
  | "company_consultant_remove"
  | "company_member_suspend"
  | "company_member_revoke"
  | "invitation_revoke";

/** Validate the released public command before Session or durable authority work. */
export function assertProtectedWritePayloadHash(
  kind: ProtectedWritePayloadKind,
  body: Readonly<Record<string, unknown>>,
): void {
  const supplied = body.payload_hash;
  if (typeof supplied !== "string") invalidRequest();
  const { payload_hash: _payloadHash, ...facts } = body;
  const normalizedFacts = kind === "company_create"
    ? { ...facts, administrator_email: String(facts.administrator_email).toLowerCase() }
    : kind === "company_member_invite"
      ? { ...facts, email: String(facts.email).toLowerCase() }
      : facts;
  assertCanonicalHash(supplied, normalizedFacts);
}

export function requireMutationCredentials(request: FastifyRequest): { readonly sessionSecret: string; readonly csrfSecret: string } {
  const sessionSecret = request.cookies[CORE_SESSION_COOKIE_NAME];
  const csrfCookie = request.cookies[CORE_CSRF_COOKIE_NAME];
  const csrfHeaders = rawHeaderValues(request, CSRF_HEADER_NAME);
  if (typeof sessionSecret !== "string" || typeof csrfCookie !== "string" || csrfHeaders.length !== 1 || !safeSecretEqual(csrfCookie, csrfHeaders[0]!)) invalidAuthentication();
  return { sessionSecret, csrfSecret: csrfCookie };
}

export function requireSessionCredential(request: FastifyRequest): string {
  const sessionSecret = request.cookies[CORE_SESSION_COOKIE_NAME];
  if (typeof sessionSecret !== "string") invalidAuthentication();
  return sessionSecret;
}

export function requireNativeSessionCredential(request: FastifyRequest): string {
  const values = rawHeaderValues(request, "authorization");
  if (values.length !== 1) invalidAuthentication();
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(values[0]!);
  if (match?.[1] === undefined) invalidAuthentication();
  return match[1];
}
