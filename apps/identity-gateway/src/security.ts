import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { canonicalPayloadHash } from "@core-agent/runtime-core";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { IdentityGatewayConfig } from "./config.js";
import { IdentityGatewayFailure } from "./errors.js";

export const MAX_IDENTITY_BODY_BYTES = 64 * 1024;
export const CORE_SESSION_COOKIE_NAME = "core_agent_session";
export const CORE_CSRF_COOKIE_NAME = "core_agent_csrf";
export const RECOVERY_COOKIE_NAME = "core_agent_recovery";
export const APPLE_FLOW_COOKIE_NAME = "core_agent_apple_flow";
export const CSRF_HEADER_NAME = "x-core-agent-csrf";
export const CORE_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const flowMaxAgeSeconds = 5 * 60;

export interface RecoveryCookieBinding {
  readonly transactionId: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface AppleFlowCookieBinding {
  readonly transactionId: string;
  readonly state: string;
  readonly expiresAt: string;
  readonly flowKind: "sign_in" | "link";
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

function flowCookie(reply: FastifyReply, name: string, value: string, path: string): void {
  appendSetCookie(reply, `${name}=${cookieValue(value)}; Secure; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${flowMaxAgeSeconds}`);
}

function clearFlowCookie(reply: FastifyReply, name: string, path: string): void {
  appendSetCookie(reply, `${name}=; Secure; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=0`);
}

export function issueRecoveryCookie(reply: FastifyReply, value: string): void {
  flowCookie(reply, RECOVERY_COOKIE_NAME, value, "/auth/v1/password/reset/complete");
}

export function clearRecoveryCookie(reply: FastifyReply): void {
  clearFlowCookie(reply, RECOVERY_COOKIE_NAME, "/auth/v1/password/reset/complete");
}

export function issueAppleFlowCookie(reply: FastifyReply, value: string): void {
  flowCookie(reply, APPLE_FLOW_COOKIE_NAME, value, "/auth/v1");
}

export function clearAppleFlowCookie(reply: FastifyReply): void {
  clearFlowCookie(reply, APPLE_FLOW_COOKIE_NAME, "/auth/v1");
}

function assertFlowKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new IdentityGatewayFailure("INTERNAL_ERROR");
  return Buffer.from(key);
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
  if (!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{22}$/u.test(value)) invalidAuthentication();
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

function strictFutureUtc(value: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value && timestamp > now.getTime();
}

export function sealRecoveryCookie(key: Uint8Array, binding: RecoveryCookieBinding): string {
  return seal(key, "recovery", { transaction_id: binding.transactionId, state: binding.state, expires_at: binding.expiresAt });
}

export function readRecoveryCookie(key: Uint8Array, value: string, now: Date): RecoveryCookieBinding {
  const parsed = open(key, "recovery", value);
  if (!exactRecord(parsed, ["transaction_id", "state", "expires_at"]) || !boundedString(parsed.transaction_id) || !boundedString(parsed.state) || !boundedString(parsed.expires_at) || !strictFutureUtc(parsed.expires_at, now)) invalidAuthentication();
  return { transactionId: parsed.transaction_id, state: parsed.state, expiresAt: parsed.expires_at };
}

export function sealAppleFlowCookie(key: Uint8Array, binding: AppleFlowCookieBinding): string {
  return seal(key, "apple", { transaction_id: binding.transactionId, state: binding.state, expires_at: binding.expiresAt, flow_kind: binding.flowKind });
}

export function readAppleFlowCookie(key: Uint8Array, value: string, now: Date): AppleFlowCookieBinding {
  const parsed = open(key, "apple", value);
  if (!exactRecord(parsed, ["transaction_id", "state", "expires_at", "flow_kind"]) || !boundedString(parsed.transaction_id) || !boundedString(parsed.state) || !boundedString(parsed.expires_at) || (parsed.flow_kind !== "sign_in" && parsed.flow_kind !== "link") || !strictFutureUtc(parsed.expires_at, now)) invalidAuthentication();
  return { transactionId: parsed.transaction_id, state: parsed.state, expiresAt: parsed.expires_at, flowKind: parsed.flow_kind };
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

export function assertReauthenticationPayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly expected_resource_version: number;
  readonly password: string;
}): void {
  assertCanonicalHash(body.payload_hash, reauthenticationDurableFacts(body));
}

export function reauthenticationDurableFacts(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly expected_resource_version: number;
  readonly password: string;
}): Readonly<{
  schema_version: 1;
  idempotency_key: string;
  expected_resource_version: number;
  reauthentication_proof_digest: string;
}> {
  return Object.freeze({
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    expected_resource_version: body.expected_resource_version,
    reauthentication_proof_digest: sensitiveFactDigest(body.password),
  });
}

export function assertInvitationAcceptancePayloadHash(body: {
  readonly schema_version: 1;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly expected_resource_version: number;
  readonly invitation_secret: string;
  readonly authentication_proof: Readonly<Record<string, unknown>>;
  readonly device_label?: string;
}): void {
  const proof = body.authentication_proof;
  let canonicalProof: Readonly<Record<string, unknown>>;
  if (proof.kind === "email_password" && typeof proof.client_kind === "string"
    && typeof proof.verification_proof === "string") {
    canonicalProof = {
      kind: proof.kind,
      client_kind: proof.client_kind,
      verification_proof_digest: sensitiveFactDigest(proof.verification_proof),
    };
  } else {
    canonicalProof = {
      kind: proof.kind,
      client_kind: proof.client_kind,
      callback_proof_digest: sensitiveFactDigest(JSON.stringify(proof)),
    };
  }
  assertCanonicalHash(body.payload_hash, {
    schema_version: body.schema_version,
    idempotency_key: body.idempotency_key,
    expected_resource_version: body.expected_resource_version,
    invitation_digest: sensitiveFactDigest(body.invitation_secret),
    authentication_proof: canonicalProof,
    ...(body.device_label === undefined ? {} : { device_label: body.device_label }),
  });
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
