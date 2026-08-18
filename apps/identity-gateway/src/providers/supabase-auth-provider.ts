import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";
import { types as utilTypes } from "node:util";

import { strictUtcTimestampMilliseconds } from "@core-agent/runtime-core";

import type {
  AppleAuthorizationCallback,
  AppleAuthorizationInput,
  AppleAuthorizationStart,
  AppleLinkAuthorizationInput,
  AppleLinkInput,
  AuthProviderAdapter,
  EmailCredentialInput,
  EmailVerificationInput,
  EmailVerificationRecoveryInput,
  ProviderClientKind,
  ProviderProof,
  PasswordResetCompletionInput,
  PasswordResetProviderObservation,
  PasswordResetStart,
  PasswordResetStartInput,
  VerifiedProviderSubject,
} from "./auth-provider.js";
import { canonicalProviderStartPayloadHash } from "./auth-provider.js";
import {
  mapProviderFailure,
  ProviderFailure,
  type ProviderFailureCode,
} from "./provider-errors.js";

interface TransientStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): void;
}

export interface SupabaseClientCreationOptions {
  readonly auth: {
    readonly autoRefreshToken: false;
    readonly persistSession: false;
    readonly detectSessionInUrl: false;
    readonly flowType: "pkce";
    readonly experimental: { readonly appendPkceFlowIdToRedirects: false };
    readonly storageKey: string;
    readonly storage: TransientStorage;
  };
}

interface SupabaseAuthPort {
  signUp(input: unknown): Promise<unknown>;
  signInWithPassword(input: unknown): Promise<unknown>;
  verifyOtp(input: { readonly token_hash: string; readonly type: "email" }): Promise<unknown>;
  signInWithOAuth(input: unknown): Promise<unknown>;
  exchangeCodeForSession(code: string, options?: { readonly flowId?: string }): Promise<unknown>;
  getUser(jwt?: string): Promise<unknown>;
  setSession(input: { readonly access_token: string; readonly refresh_token: string }): Promise<unknown>;
  signOut(input: { readonly scope: "local" | "global" }): Promise<unknown>;
  resetPasswordForEmail(email: string, options: { readonly redirectTo: string }): Promise<unknown>;
  linkIdentity(input: unknown): Promise<unknown>;
  readonly admin: {
    updateUserById(
      providerSubject: string,
      attributes: { readonly password: string },
    ): Promise<unknown>;
    deleteUser(providerSubject: string, shouldSoftDelete: boolean): Promise<unknown>;
    getUserById(providerSubject: string): Promise<unknown>;
  };
}

interface SupabaseClientPort {
  readonly auth: SupabaseAuthPort;
}

interface NativeLinkAuthorizationInput {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly accessToken: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

interface NativeLinkAuthorizationPort {
  authorize(input: NativeLinkAuthorizationInput): Promise<string>;
}

export type SupabaseClientFactory = (
  url: string,
  key: string,
  options: SupabaseClientCreationOptions,
) => SupabaseClientPort;

export interface OAuthTransactionRecord {
  readonly oauth_transaction_id: string;
  readonly provider: "supabase";
  readonly flow_kind: "apple_sign_in" | "apple_link" | "password_reset";
  readonly actor_id: string | null;
  readonly client_kind: ProviderClientKind;
  readonly state_digest: Uint8Array;
  readonly nonce_digest: Uint8Array;
  readonly pkce_verifier_ciphertext: Uint8Array;
  readonly redirect_uri: string;
  readonly status: "pending";
  readonly expires_at: string;
  readonly provider_completion_status?: "pending" | "provider_started" | "provider_completed";
  readonly provider_completion_started_at?: string;
  readonly expected_provider_subject_ciphertext?: Uint8Array;
  readonly provider_subject_ciphertext?: Uint8Array;
  readonly provider_completion_payload_hash?: string;
  readonly provider_settlement_expires_at?: string;
  readonly provider_completed_at?: string;
  readonly provider_evidence_at?: string;
}

export interface OAuthTransactionStore {
  save(record: OAuthTransactionRecord): Promise<void>;
  consume(transactionId: string): Promise<OAuthTransactionRecord | undefined>;
  /** Production start idempotency reserves before any provider effect. */
  reserveStart?(record: OAuthTransactionRecord): Promise<boolean>;
  completeStart?(record: OAuthTransactionRecord): Promise<void>;
  loadStart?(transactionId: string): Promise<OAuthTransactionRecord | undefined>;
  beginPasswordResetCompletion?(input: {
    readonly transactionId: string;
    readonly payloadHash: string;
    readonly settlementNotAfter: string;
  }): Promise<{
    readonly kind: "acquired" | "existing";
    readonly startedAt: string;
    readonly settlementExpiresAt: string;
  }>;
  checkpointPasswordResetCompletion?(input: {
    readonly transactionId: string;
    readonly providerEvidenceAt: string;
  }): Promise<void>;
  beginAppleLinkCompletion?(input: {
    readonly transactionId: string;
    readonly payloadHash: string;
  }): Promise<{ readonly kind: "acquired" | "existing" }>;
  checkpointAppleLinkCompletion?(input: {
    readonly transactionId: string;
    readonly providerSubjectCiphertext: Uint8Array;
  }): Promise<void>;
}

export interface TransactionProtector {
  /** Encrypt with integrity protection; decrypt must reject modified ciphertext. */
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export interface SupabaseAuthProviderOptions {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly serviceRoleKey: string;
  readonly appleRedirectUris: readonly string[];
  readonly passwordResetRedirectUri: string;
  readonly emailVerificationRedirectUri: string;
  readonly transactionStore: OAuthTransactionStore;
  readonly transactionProtector: TransactionProtector;
  readonly createClient?: SupabaseClientFactory;
  readonly nativeLinkAuthorization?: NativeLinkAuthorizationPort;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

interface ParsedAppleStart {
  readonly clientKind: ProviderClientKind;
  readonly redirectUri: string;
  readonly nonce: string | null;
  readonly pkceChallenge: string | null;
}

interface ParsedAppleCallback {
  readonly transactionId: string;
  readonly authorizationCode: string;
  readonly state: string;
  readonly clientKind: ProviderClientKind;
  readonly nonce: string | null;
  readonly pkceVerifier: string | null;
  readonly payloadHash: string;
}

interface WebPkceEnvelope {
  readonly kind: "web" | "password_reset";
  readonly flowId: string;
  readonly verifier: string;
  readonly verifierDigest: string;
  readonly providerSubjectDigest?: string;
}

interface NativePkceEnvelope {
  readonly kind: "native";
  readonly flowId: string;
  readonly challenge: string;
  readonly providerSubjectDigest?: string;
}

type DecryptedPkceEnvelope = WebPkceEnvelope | NativePkceEnvelope;

interface ProviderStartMetadata {
  readonly kind: "start_reservation" | "web" | "native" | "password_reset";
  readonly payloadHash: string;
  readonly authorizationUrl?: string;
}

const oauthTransactionTtlMs = 5 * 60 * 1_000;
const transientRefreshPlaceholder = "core-agent-transient-proof";
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

class MemoryStorage implements TransientStorage {
  readonly #values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.#values.delete(key);
  }

  clear(): void {
    this.#values.clear();
  }
}

const nodeRequire = createRequire(import.meta.url);
const supabaseRuntime = nodeRequire("@supabase/supabase-js") as {
  readonly createClient: (url: string, key: string, options: SupabaseClientCreationOptions) => unknown;
};

const defaultClientFactory: SupabaseClientFactory = (url, key, options) => {
  const client = supabaseRuntime.createClient(url, key, options);
  const auth = ownData(client, "auth");
  if (typeof auth !== "object" || auth === null || utilTypes.isProxy(auth)) {
    throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  const storage = Object.getOwnPropertyDescriptor(auth, "storage");
  // supabase-js 2.112.2 deliberately substitutes its own memory storage when
  // persistSession is false. Rebind that private, operation-local slot so the
  // adapter can encrypt the PKCE verifier before destroying the client.
  if (storage === undefined || !("value" in storage) || storage.writable !== true) {
    throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  Object.defineProperty(auth, "storage", { ...storage, value: options.auth.storage });
  return client as SupabaseClientPort;
};

const defaultNativeLinkAuthorization: NativeLinkAuthorizationPort = {
  async authorize(input) {
    const endpoint = new URL("/auth/v1/user/identities/authorize", input.supabaseUrl);
    endpoint.searchParams.set("provider", "apple");
    endpoint.searchParams.set("redirect_to", input.redirectUri);
    endpoint.searchParams.set("code_challenge", input.codeChallenge);
    endpoint.searchParams.set("code_challenge_method", "S256");
    endpoint.searchParams.set("nonce", input.nonce);
    endpoint.searchParams.set("skip_http_redirect", "true");

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers: {
          apikey: input.publishableKey,
          Authorization: `Bearer ${input.accessToken}`,
        },
      });
    } catch (error) {
      throw mapProviderFailure(error);
    }
    if (!response.ok) {
      throw mapProviderFailure(Object.freeze({ status: response.status }), "AUTH_CONFLICT");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw mapProviderFailure(error);
    }
    const authorizationUrl = ownString(data, "url");
    if (authorizationUrl === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    return authorizationUrl;
  },
};

function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnData(value: unknown, key: string): boolean {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  } catch {
    return false;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const property = ownData(value, key);
  return typeof property === "string" ? property : undefined;
}

function readOwnStringArray(value: unknown, maximum: number): readonly string[] | undefined {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) return undefined;
  const length = ownData(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
    return undefined;
  }
  const copy: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = ownString(value, String(index));
    if (item === undefined) return undefined;
    copy.push(item);
  }
  return copy;
}

function requireResultData(result: unknown, fallback?: ProviderFailureCode): unknown {
  if (!hasOwnData(result, "error") || !hasOwnData(result, "data")) {
    throw new ProviderFailure(fallback ?? "AUTH_PROVIDER_UNAVAILABLE");
  }
  const error = ownData(result, "error");
  if (error !== null && error !== undefined) throw mapProviderFailure(error, fallback);
  const data = ownData(result, "data");
  if (typeof data !== "object" || data === null || utilTypes.isProxy(data)) {
    throw new ProviderFailure(fallback ?? "AUTH_PROVIDER_UNAVAILABLE");
  }
  return data;
}

function requireNoResultError(result: unknown, fallback?: ProviderFailureCode): void {
  if (!hasOwnData(result, "error")) {
    throw new ProviderFailure(fallback ?? "AUTH_PROVIDER_UNAVAILABLE");
  }
  const error = ownData(result, "error");
  if (error !== null && error !== undefined) throw mapProviderFailure(error, fallback);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return email.length >= 3 && email.length <= 320 && /^[^@\s]+@[^@\s]+$/u.test(email);
}

/** Internal durable reset-subject decoder shared with the Core settlement phase. */
export async function readProtectedPasswordResetSubject(
  protector: TransactionProtector,
  ciphertext: Uint8Array,
): Promise<VerifiedProviderSubject> {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = copyBytes(await protector.decrypt(ciphertext), 1, 65_536);
    if (plaintext === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
    const provider = ownString(parsed, "provider");
    const providerSubject = ownString(parsed, "providerSubject");
    const identityKind = ownString(parsed, "identityKind");
    const normalizedEmail = ownString(parsed, "normalizedEmail");
    const verifiedAt = ownString(parsed, "verifiedAt");
    if (ownString(parsed, "kind") !== "password_reset_subject" || provider !== "supabase"
      || providerSubject === undefined || providerSubject.length < 1 || providerSubject.length > 1_024
      || identityKind !== "email_password" || normalizedEmail === undefined
      || !validEmail(normalizedEmail) || normalizedEmail !== normalizeEmail(normalizedEmail)
      || verifiedAt === undefined || strictUtcTimestampMilliseconds(verifiedAt) === undefined) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return Object.freeze({ provider, providerSubject, identityKind, normalizedEmail, verifiedAt });
  } catch (error) {
    throw mapProviderFailure(error, "AUTH_CALLBACK_INVALID");
  } finally {
    plaintext?.fill(0);
  }
}

/** Internal durable Apple-link subject decoder shared with the Core CAS phase. */
export async function readProtectedAppleLinkSubject(
  protector: TransactionProtector,
  ciphertext: Uint8Array,
): Promise<VerifiedProviderSubject> {
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = copyBytes(await protector.decrypt(ciphertext), 1, 65_536);
    if (plaintext === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
    const provider = ownString(parsed, "provider");
    const providerSubject = ownString(parsed, "providerSubject");
    const identityKind = ownString(parsed, "identityKind");
    const normalizedEmail = ownString(parsed, "normalizedEmail");
    const verifiedAt = ownString(parsed, "verifiedAt");
    if (ownString(parsed, "kind") !== "apple_link_subject" || provider !== "supabase"
      || providerSubject === undefined || providerSubject.length < 1 || providerSubject.length > 1_024
      || identityKind !== "apple" || normalizedEmail === undefined
      || normalizedEmail !== normalizeEmail(normalizedEmail) || !validEmail(normalizedEmail)
      || verifiedAt === undefined || strictUtcTimestampMilliseconds(verifiedAt) === undefined) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return Object.freeze({ provider, providerSubject, identityKind, normalizedEmail, verifiedAt });
  } catch (error) {
    throw mapProviderFailure(error, "AUTH_CALLBACK_INVALID");
  } finally {
    plaintext?.fill(0);
  }
}

function readCredential(input: unknown): EmailCredentialInput {
  const email = ownString(input, "email");
  const password = ownString(input, "password");
  if (email === undefined || password === undefined || !validEmail(normalizeEmail(email))
    || password.length < 8 || password.length > 1_024) {
    throw new ProviderFailure("AUTH_INVALID");
  }
  return { email: normalizeEmail(email), password };
}

function readProof(input: unknown): string {
  const accessToken = ownString(input, "accessToken");
  if (accessToken === undefined || accessToken.length === 0 || accessToken.length > 16_384) {
    throw new ProviderFailure("AUTH_INVALID");
  }
  return accessToken;
}

function readClientKind(value: unknown): ProviderClientKind | undefined {
  return value === "web" || value === "iphone" || value === "macos" ? value : undefined;
}

function sha256(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value, "utf8").digest());
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function readStartIdempotency(input: unknown): { readonly key: string; readonly payloadHash: string } {
  const key = ownString(input, "idempotency_key") ?? ownString(input, "idempotencyKey");
  const payloadHash = ownString(input, "payload_hash") ?? ownString(input, "payloadHash");
  if (key === undefined || key.length < 1 || key.length > 255
    || payloadHash === undefined || !/^sha256:[a-f0-9]{64}$/u.test(payloadHash)) {
    throw new ProviderFailure("AUTH_CALLBACK_INVALID");
  }
  return { key, payloadHash };
}

function assertCanonicalStartPayloadHash(supplied: string, expected: string): void {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  try {
    if (suppliedBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
  } finally {
    suppliedBytes.fill(0);
    expectedBytes.fill(0);
  }
}

function idempotentStartTransactionId(flowKind: string, actorId: string | null, key: string): string {
  return `oauth_${sha256Base64Url(`core-agent:provider-start:v1:${flowKind}:${actorId ?? "anonymous"}:${key}`).slice(0, 32)}`;
}

function copyBytes(value: unknown, minimum: number, maximum: number): Uint8Array | undefined {
  if (!ArrayBuffer.isView(value) || utilTypes.isProxy(value)) return undefined;
  try {
    const copy: unknown = structuredClone(value);
    if (!(copy instanceof Uint8Array) || copy.byteLength < minimum || copy.byteLength > maximum) return undefined;
    return copy;
  } catch {
    return undefined;
  }
}

function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== 32 || right.byteLength !== 32) return false;
  return timingSafeEqual(left, right);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function copySubject(
  user: unknown,
  forcedIdentityKind?: VerifiedProviderSubject["identityKind"],
): VerifiedProviderSubject {
  const providerSubject = ownString(user, "id");
  const email = ownString(user, "email");
  const confirmedAt = ownString(user, "email_confirmed_at");
  if (providerSubject === undefined || providerSubject.length === 0 || providerSubject.length > 1_024
    || email === undefined || !validEmail(normalizeEmail(email))) {
    throw new ProviderFailure("AUTH_INVALID");
  }
  if (confirmedAt === undefined) throw new ProviderFailure("AUTH_EMAIL_UNVERIFIED");
  const verifiedTimestamp = strictUtcTimestampMilliseconds(confirmedAt);
  if (verifiedTimestamp === undefined) throw new ProviderFailure("AUTH_EMAIL_UNVERIFIED");

  let identityKind = forcedIdentityKind;
  if (identityKind === undefined) {
    const appMetadata = ownData(user, "app_metadata");
    const provider = ownString(appMetadata, "provider");
    if (provider === "email") identityKind = "email_password";
    else if (provider === "apple") identityKind = "apple";
    else throw new ProviderFailure("AUTH_INVALID");
  }

  return Object.freeze({
    provider: "supabase",
    providerSubject,
    identityKind,
    normalizedEmail: normalizeEmail(email),
    verifiedAt: new Date(verifiedTimestamp).toISOString(),
  });
}

function readExpectedPasswordResetSubject(input: unknown, normalizedEmail: string): VerifiedProviderSubject {
  const subject = ownData(input, "expectedSubject");
  const provider = ownString(subject, "provider");
  const providerSubject = ownString(subject, "providerSubject");
  const identityKind = ownString(subject, "identityKind");
  const email = ownString(subject, "normalizedEmail");
  const verifiedAt = ownString(subject, "verifiedAt");
  if (provider !== "supabase" || providerSubject === undefined || providerSubject.length < 1 || providerSubject.length > 1_024
    || identityKind !== "email_password" || email !== normalizedEmail
    || verifiedAt === undefined || strictUtcTimestampMilliseconds(verifiedAt) === undefined) {
    throw new ProviderFailure("AUTH_CALLBACK_INVALID");
  }
  return Object.freeze({ provider, providerSubject, identityKind, normalizedEmail: email, verifiedAt });
}

function copyExpectedProviderSubject(user: unknown, normalizedEmail: string): string {
  const providerSubject = ownString(user, "id");
  const email = ownString(user, "email");
  if (providerSubject === undefined || providerSubject.length < 1 || providerSubject.length > 1_024
    || email === undefined || normalizeEmail(email) !== normalizedEmail) {
    throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  return providerSubject;
}

function encodeOpaque(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function validateRedirectUri(uri: string, allowlist: ReadonlySet<string>): boolean {
  if (!allowlist.has(uri)) return false;
  try {
    const parsed = new URL(uri);
    return parsed.toString() === uri || (parsed.protocol === "coreagent:" && parsed.href === uri);
  } catch {
    return false;
  }
}

function parseStoredString(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredFlowId(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (utilTypes.isProxy(parsed) || !Array.isArray(parsed) || parsed.length !== 1) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(parsed, "0");
    const flowId = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    return typeof flowId === "string" && /^[A-Za-z0-9_-]{8,64}$/u.test(flowId) ? flowId : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedOAuthTransaction {
  readonly transactionId: string;
  readonly flowKind: OAuthTransactionRecord["flow_kind"];
  readonly actorId: string | null;
  readonly clientKind: ProviderClientKind;
  readonly stateDigest: Uint8Array;
  readonly nonceDigest: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly redirectUri: string;
  readonly expiresAt: number;
  readonly providerCompletionStatus: "pending" | "provider_started" | "provider_completed";
  readonly providerCompletionStartedAt?: string;
  readonly expectedProviderSubjectCiphertext?: Uint8Array;
  readonly providerSubjectCiphertext?: Uint8Array;
  readonly providerCompletionPayloadHash?: string;
  readonly providerSettlementExpiresAt?: string;
  readonly providerCompletedAt?: string;
  readonly providerEvidenceAt?: string;
}

function parseOAuthTransaction(record: unknown): ParsedOAuthTransaction | undefined {
  if (utilTypes.isProxy(record)) return undefined;
  const transactionId = ownString(record, "oauth_transaction_id");
  const provider = ownString(record, "provider");
  const flowKind = ownString(record, "flow_kind");
  const actor = ownData(record, "actor_id");
  const clientKind = readClientKind(ownData(record, "client_kind"));
  const stateDigest = copyBytes(ownData(record, "state_digest"), 32, 32);
  const nonceDigest = copyBytes(ownData(record, "nonce_digest"), 32, 32);
  const ciphertext = copyBytes(ownData(record, "pkce_verifier_ciphertext"), 1, 65_536);
  const redirectUri = ownString(record, "redirect_uri");
  const status = ownString(record, "status");
  const expiresAtText = ownString(record, "expires_at");
  const expiresAt = expiresAtText === undefined ? Number.NaN : new Date(expiresAtText).getTime();
  const completionStatusValue = ownString(record, "provider_completion_status") ?? "pending";
  const completionStatus = completionStatusValue === "pending" || completionStatusValue === "provider_started"
    || completionStatusValue === "provider_completed" ? completionStatusValue : undefined;
  const completionStartedAt = ownString(record, "provider_completion_started_at");
  const expectedProviderSubjectCiphertext = copyBytes(ownData(record, "expected_provider_subject_ciphertext"), 33, 65_536);
  const providerSubjectCiphertext = copyBytes(ownData(record, "provider_subject_ciphertext"), 33, 65_536);
  const providerCompletionPayloadHash = ownString(record, "provider_completion_payload_hash");
  const providerSettlementExpiresAt = ownString(record, "provider_settlement_expires_at");
  const providerCompletedAt = ownString(record, "provider_completed_at");
  const providerEvidenceAt = ownString(record, "provider_evidence_at");
  if (transactionId === undefined || transactionId.length === 0 || transactionId.length > 256
    || provider !== "supabase"
    || (flowKind !== "apple_sign_in" && flowKind !== "apple_link" && flowKind !== "password_reset")
    || (actor !== null && (typeof actor !== "string" || actor.length === 0 || actor.length > 256))
    || clientKind === undefined || stateDigest === undefined || nonceDigest === undefined
    || ciphertext === undefined || redirectUri === undefined || redirectUri.length === 0
    || redirectUri.length > 2_048 || status !== "pending" || !Number.isFinite(expiresAt)
    || completionStatus === undefined
    || (flowKind === "password_reset" && expectedProviderSubjectCiphertext === undefined)
    || (flowKind !== "password_reset" && expectedProviderSubjectCiphertext !== undefined)
    || (completionStatus === "pending" && (completionStartedAt !== undefined || providerSubjectCiphertext !== undefined
      || providerCompletionPayloadHash !== undefined
      || providerSettlementExpiresAt !== undefined
      || providerCompletedAt !== undefined || providerEvidenceAt !== undefined))
    || (completionStatus === "provider_started" && (completionStartedAt === undefined
      || (flowKind === "password_reset" ? providerSubjectCiphertext === undefined : providerSubjectCiphertext !== undefined)
      || providerCompletionPayloadHash === undefined
      || !/^sha256:[a-f0-9]{64}$/u.test(providerCompletionPayloadHash)
      || providerSettlementExpiresAt === undefined || strictUtcTimestampMilliseconds(providerSettlementExpiresAt) === undefined
      || providerCompletedAt !== undefined || providerEvidenceAt !== undefined))
    || (completionStatus === "provider_completed" && (completionStartedAt === undefined
      || providerSubjectCiphertext === undefined || providerCompletionPayloadHash === undefined
      || !/^sha256:[a-f0-9]{64}$/u.test(providerCompletionPayloadHash)
      || providerSettlementExpiresAt === undefined || strictUtcTimestampMilliseconds(providerSettlementExpiresAt) === undefined
      || providerCompletedAt === undefined || providerEvidenceAt === undefined))) return undefined;
  return {
    transactionId, flowKind, actorId: actor as string | null, clientKind,
    stateDigest, nonceDigest, ciphertext, redirectUri, expiresAt,
    providerCompletionStatus: completionStatus,
    ...(completionStartedAt === undefined ? {} : { providerCompletionStartedAt: completionStartedAt }),
    ...(expectedProviderSubjectCiphertext === undefined ? {} : { expectedProviderSubjectCiphertext }),
    ...(providerSubjectCiphertext === undefined ? {} : { providerSubjectCiphertext }),
    ...(providerCompletionPayloadHash === undefined ? {} : { providerCompletionPayloadHash }),
    ...(providerSettlementExpiresAt === undefined ? {} : { providerSettlementExpiresAt }),
    ...(providerCompletedAt === undefined ? {} : { providerCompletedAt }),
    ...(providerEvidenceAt === undefined ? {} : { providerEvidenceAt }),
  };
}

async function safeProviderCall<T>(operation: () => Promise<T>, fallback?: ProviderFailureCode): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw mapProviderFailure(error, fallback);
  }
}

export class SupabaseAuthProvider implements AuthProviderAdapter {
  readonly #url: string;
  readonly #publishableKey: string;
  readonly #serviceRoleKey: string;
  readonly #appleRedirectUris: ReadonlySet<string>;
  readonly #passwordResetRedirectUri: string;
  readonly #emailVerificationRedirectUri: string;
  readonly #transactionStore: OAuthTransactionStore;
  readonly #transactionProtector: TransactionProtector;
  readonly #createClient: SupabaseClientFactory;
  readonly #nativeLinkAuthorization: NativeLinkAuthorizationPort;
  readonly #now: () => Date;
  readonly #randomBytes: (length: number) => Uint8Array;

  constructor(options: SupabaseAuthProviderOptions) {
    if (utilTypes.isProxy(options)) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    const supabaseUrl = ownString(options, "supabaseUrl");
    const publishableKey = ownString(options, "publishableKey");
    const serviceRoleKey = ownString(options, "serviceRoleKey");
    const appleRedirectUris = readOwnStringArray(ownData(options, "appleRedirectUris"), 128);
    const passwordResetRedirectUri = ownString(options, "passwordResetRedirectUri");
    const emailVerificationRedirectUri = ownString(options, "emailVerificationRedirectUri");
    const transactionStore = ownData(options, "transactionStore");
    const transactionProtector = ownData(options, "transactionProtector");
    const createClient = ownData(options, "createClient");
    const nativeLinkAuthorization = ownData(options, "nativeLinkAuthorization");
    const now = ownData(options, "now");
    const randomBytes = ownData(options, "randomBytes");
    if (supabaseUrl === undefined || publishableKey === undefined || serviceRoleKey === undefined
      || appleRedirectUris === undefined || passwordResetRedirectUri === undefined
      || emailVerificationRedirectUri === undefined
      || typeof transactionStore !== "object" || transactionStore === null || utilTypes.isProxy(transactionStore)
      || typeof transactionProtector !== "object" || transactionProtector === null
      || utilTypes.isProxy(transactionProtector)
      || (createClient !== undefined && (typeof createClient !== "function" || utilTypes.isProxy(createClient)))
      || (nativeLinkAuthorization !== undefined
        && (typeof nativeLinkAuthorization !== "object" || nativeLinkAuthorization === null
          || utilTypes.isProxy(nativeLinkAuthorization)))
      || (now !== undefined && (typeof now !== "function" || utilTypes.isProxy(now)))
      || (randomBytes !== undefined && (typeof randomBytes !== "function" || utilTypes.isProxy(randomBytes)))) {
      throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    }
    this.#url = supabaseUrl;
    this.#publishableKey = publishableKey;
    this.#serviceRoleKey = serviceRoleKey;
    this.#appleRedirectUris = new Set(appleRedirectUris);
    this.#passwordResetRedirectUri = passwordResetRedirectUri;
    this.#emailVerificationRedirectUri = emailVerificationRedirectUri;
    this.#transactionStore = transactionStore as OAuthTransactionStore;
    this.#transactionProtector = transactionProtector as TransactionProtector;
    this.#createClient = (createClient as SupabaseClientFactory | undefined) ?? defaultClientFactory;
    this.#nativeLinkAuthorization = (nativeLinkAuthorization as NativeLinkAuthorizationPort | undefined)
      ?? defaultNativeLinkAuthorization;
    this.#now = (now as (() => Date) | undefined) ?? (() => new Date());
    this.#randomBytes = (randomBytes as ((length: number) => Uint8Array) | undefined)
      ?? ((length) => Uint8Array.from(nodeRandomBytes(length)));
  }

  async signUpEmail(input: EmailCredentialInput): Promise<{
    readonly kind: "verification_pending";
    readonly expectedProviderSubject: string;
  }> {
    const credential = readCredential(input);
    const { client, storage } = this.#newClient();
    try {
      const data = requireResultData(await safeProviderCall(() => client.auth.signUp({
        email: credential.email,
        password: credential.password,
        options: { emailRedirectTo: this.#emailVerificationRedirectUri },
      })));
      if (ownData(data, "session") !== null) {
        await this.#signOut(client, "local");
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      return Object.freeze({
        kind: "verification_pending",
        expectedProviderSubject: copyExpectedProviderSubject(ownData(data, "user"), credential.email),
      });
    } finally {
      storage.clear();
    }
  }

  async verifyEmail(input: EmailVerificationInput): Promise<VerifiedProviderSubject> {
    const verificationCode = ownString(input, "verificationCode");
    const expectedProviderSubject = ownString(input, "expectedProviderSubject");
    if (verificationCode === undefined || verificationCode.length < 8 || verificationCode.length > 4_096
      || expectedProviderSubject === undefined || expectedProviderSubject.length < 1
      || expectedProviderSubject.length > 1_024) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const { client, storage } = this.#newClient();
    try {
      const data = requireResultData(await safeProviderCall(
        () => client.auth.verifyOtp({ token_hash: verificationCode, type: "email" }),
        "AUTH_CALLBACK_INVALID",
      ));
      const subject = copySubject(ownData(data, "user"), "email_password");
      if (!constantTimeStringEqual(subject.providerSubject, expectedProviderSubject)) {
        await this.#signOut(client, "local");
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      await this.#signOut(client, "local");
      return subject;
    } finally {
      storage.clear();
    }
  }

  async recoverVerifiedEmailSubject(input: EmailVerificationRecoveryInput): Promise<VerifiedProviderSubject> {
    const expectedProviderSubject = ownString(input, "expectedProviderSubject");
    const expectedNormalizedEmail = ownString(input, "expectedNormalizedEmail");
    const verificationStartedAt = ownString(input, "verificationStartedAt");
    const recoveryNotAfter = ownString(input, "recoveryNotAfter");
    const verificationStartedTimestamp = verificationStartedAt === undefined
      ? undefined : strictUtcTimestampMilliseconds(verificationStartedAt);
    const recoveryNotAfterTimestamp = recoveryNotAfter === undefined
      ? undefined : strictUtcTimestampMilliseconds(recoveryNotAfter);
    if (expectedProviderSubject === undefined || expectedProviderSubject.length < 1
      || expectedProviderSubject.length > 1_024 || expectedNormalizedEmail === undefined
      || expectedNormalizedEmail !== normalizeEmail(expectedNormalizedEmail) || !validEmail(expectedNormalizedEmail)
      || verificationStartedTimestamp === undefined || recoveryNotAfterTimestamp === undefined
      || verificationStartedTimestamp > recoveryNotAfterTimestamp) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const { client, storage } = this.#newClient(this.#serviceRoleKey);
    try {
      const data = requireResultData(await safeProviderCall(
        () => client.auth.admin.getUserById(expectedProviderSubject),
        "AUTH_PROVIDER_UNAVAILABLE",
      ));
      const providerUser = ownData(data, "user");
      const confirmedAt = ownString(providerUser, "email_confirmed_at");
      const confirmedTimestamp = confirmedAt === undefined ? undefined : strictUtcTimestampMilliseconds(confirmedAt);
      if (confirmedTimestamp === undefined || confirmedTimestamp < verificationStartedTimestamp
        || confirmedTimestamp > recoveryNotAfterTimestamp) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      const subject = copySubject(providerUser, "email_password");
      if (!constantTimeStringEqual(subject.providerSubject, expectedProviderSubject)
        || !constantTimeStringEqual(subject.normalizedEmail, expectedNormalizedEmail)) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      return subject;
    } finally {
      storage.clear();
    }
  }

  async signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject> {
    const credential = readCredential(input);
    return this.#passwordSubject(credential);
  }

  async verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject> {
    const accessToken = readProof(input);
    const { client, storage } = this.#newClient();
    try {
      const data = requireResultData(await safeProviderCall(() => client.auth.getUser(accessToken)));
      return copySubject(ownData(data, "user"));
    } finally {
      storage.clear();
    }
  }

  async reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject> {
    const credential = readCredential(input);
    return this.#passwordSubject(credential);
  }

  async #protectStartEnvelope(value: Readonly<Record<string, unknown>>): Promise<Uint8Array> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = utf8.encode(JSON.stringify(value));
      const ciphertext = copyBytes(await safeProviderCall(
        () => this.#transactionProtector.encrypt(plaintext!),
      ), 1, 65_536);
      if (ciphertext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      return ciphertext;
    } finally {
      plaintext?.fill(0);
    }
  }

  async #protectPasswordResetSubject(subject: VerifiedProviderSubject): Promise<Uint8Array> {
    return this.#protectStartEnvelope({
      kind: "password_reset_subject", provider: subject.provider,
      providerSubject: subject.providerSubject, identityKind: "email_password",
      normalizedEmail: subject.normalizedEmail, verifiedAt: subject.verifiedAt,
    });
  }

  async #protectAppleLinkSubject(subject: VerifiedProviderSubject): Promise<Uint8Array> {
    return this.#protectStartEnvelope({
      kind: "apple_link_subject", provider: subject.provider,
      providerSubject: subject.providerSubject, identityKind: "apple",
      normalizedEmail: subject.normalizedEmail, verifiedAt: subject.verifiedAt,
    });
  }

  async #readAppleLinkSubject(ciphertext: Uint8Array): Promise<VerifiedProviderSubject> {
    return readProtectedAppleLinkSubject(this.#transactionProtector, ciphertext);
  }

  async #readPasswordResetSubject(ciphertext: Uint8Array): Promise<VerifiedProviderSubject> {
    return readProtectedPasswordResetSubject(this.#transactionProtector, ciphertext);
  }

  async #startMetadata(ciphertext: Uint8Array): Promise<ProviderStartMetadata> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = copyBytes(await this.#transactionProtector.decrypt(ciphertext), 1, 65_536);
      if (plaintext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
      const kind = ownString(parsed, "kind");
      const payloadHash = ownString(parsed, "startPayloadHash");
      const authorizationUrl = ownString(parsed, "authorizationUrl");
      if ((kind !== "start_reservation" && kind !== "web" && kind !== "native" && kind !== "password_reset")
        || payloadHash === undefined || !/^sha256:[a-f0-9]{64}$/u.test(payloadHash)
        || authorizationUrl !== undefined && (authorizationUrl.length < 1 || authorizationUrl.length > 8_192)) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      return { kind, payloadHash, ...(authorizationUrl === undefined ? {} : { authorizationUrl }) };
    } catch (error) {
      throw mapProviderFailure(error, "AUTH_PROVIDER_UNAVAILABLE");
    } finally {
      plaintext?.fill(0);
    }
  }

  async #reserveProviderStart(
    record: Omit<OAuthTransactionRecord, "pkce_verifier_ciphertext">,
    payloadHash: string,
  ): Promise<{ readonly kind: "legacy" | "acquired" } | { readonly kind: "existing"; readonly record: OAuthTransactionRecord }> {
    const reserve = this.#transactionStore.reserveStart;
    const load = this.#transactionStore.loadStart;
    const complete = this.#transactionStore.completeStart;
    if (typeof reserve !== "function" || typeof load !== "function" || typeof complete !== "function") {
      return { kind: "legacy" };
    }
    const reservation = Object.freeze({
      ...record,
      pkce_verifier_ciphertext: await this.#protectStartEnvelope({ kind: "start_reservation", startPayloadHash: payloadHash }),
    });
    if (await safeProviderCall(() => reserve.call(this.#transactionStore, reservation))) return { kind: "acquired" };
    const existing = await safeProviderCall(() => load.call(this.#transactionStore, record.oauth_transaction_id));
    if (existing === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    return { kind: "existing", record: existing };
  }

  async #completeProviderStart(record: OAuthTransactionRecord, reservationKind: "legacy" | "acquired"): Promise<void> {
    if (reservationKind === "legacy") {
      await safeProviderCall(() => this.#transactionStore.save(record));
      return;
    }
    await safeProviderCall(() => this.#transactionStore.completeStart!(record));
  }

  async beginPasswordReset(input: PasswordResetStartInput): Promise<PasswordResetStart> {
    const email = ownString(input, "email");
    if (typeof email !== "string" || !validEmail(normalizeEmail(email))) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    const normalizedEmail = normalizeEmail(email);
    const idempotency = readStartIdempotency(input);
    assertCanonicalStartPayloadHash(idempotency.payloadHash, canonicalProviderStartPayloadHash({
      flowKind: "password_reset", idempotencyKey: idempotency.key, normalizedEmail,
    }));
    const expectedSubject = readExpectedPasswordResetSubject(input, normalizedEmail);
    const expectedSubjectCiphertext = await this.#protectPasswordResetSubject(expectedSubject);
    const transactionId = idempotentStartTransactionId("password_reset", null, idempotency.key);
    const state = transactionId;
    const exactRedirect = this.#passwordResetRedirectUri;
    const expiresAt = new Date(this.#now().getTime() + oauthTransactionTtlMs).toISOString();
    const recordBase = Object.freeze({
      oauth_transaction_id: transactionId,
      provider: "supabase" as const,
      flow_kind: "password_reset" as const,
      actor_id: null,
      client_kind: "web" as const,
      state_digest: sha256(state),
      nonce_digest: sha256(`password-reset:${transactionId}`),
      redirect_uri: exactRedirect,
      status: "pending" as const,
      expires_at: expiresAt,
      expected_provider_subject_ciphertext: expectedSubjectCiphertext,
    });
    const reservation = await this.#reserveProviderStart(recordBase, idempotency.payloadHash);
    if (reservation.kind === "existing") {
      const parsed = parseOAuthTransaction(reservation.record);
      if (parsed === undefined || parsed.transactionId !== transactionId || parsed.flowKind !== "password_reset"
        || parsed.actorId !== null || parsed.clientKind !== "web" || parsed.redirectUri !== exactRedirect
        || parsed.expiresAt <= this.#now().getTime()) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const metadata = await this.#startMetadata(parsed.ciphertext);
      if (metadata.payloadHash !== idempotency.payloadHash) throw new ProviderFailure("AUTH_CONFLICT");
      if (metadata.kind !== "password_reset") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      if (parsed.expectedProviderSubjectCiphertext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const storedExpected = await this.#readPasswordResetSubject(parsed.expectedProviderSubjectCiphertext);
      if (storedExpected.providerSubject !== expectedSubject.providerSubject
        || storedExpected.normalizedEmail !== expectedSubject.normalizedEmail) throw new ProviderFailure("AUTH_CONFLICT");
      return Object.freeze({ transaction_id: transactionId, state, expires_at: reservation.record.expires_at });
    }
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    let verifierBytes: Uint8Array | undefined;
    try {
      requireResultData(await safeProviderCall(() => client.auth.resetPasswordForEmail(
        normalizedEmail,
        { redirectTo: exactRedirect },
      )));
      const flowId = parseStoredFlowId(await storage.getItem(`${storageKey}-flows-code-verifier`));
      const verifier = flowId === undefined ? undefined : parseStoredString(await storage.getItem(
        `${storageKey}-flow-${flowId}-code-verifier`,
      ));
      if (flowId === undefined || verifier === undefined || !/^[A-Za-z0-9._~-]{43,128}\/recovery$/u.test(verifier)) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      verifierBytes = utf8.encode(JSON.stringify({
        kind: "password_reset",
        flowId,
        verifier,
        verifierDigest: Buffer.from(sha256(verifier)).toString("hex"),
        startPayloadHash: idempotency.payloadHash,
      }));
      const ciphertext = copyBytes(await safeProviderCall(
        () => this.#transactionProtector.encrypt(verifierBytes!),
      ), 1, 65_536);
      if (ciphertext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      await this.#completeProviderStart(Object.freeze({
        ...recordBase,
        pkce_verifier_ciphertext: ciphertext,
      }), reservation.kind);
      return Object.freeze({
        transaction_id: transactionId,
        state,
        expires_at: expiresAt,
      });
    } finally {
      verifierBytes?.fill(0);
      storage.clear();
    }
  }

  async beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart> {
    return this.#beginAppleTransaction(input, "apple_sign_in", null, null);
  }

  async reauthenticateAndBeginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart> {
    const actorId = ownString(input, "authenticatedActorId");
    if (actorId === undefined || actorId.length === 0 || actorId.length > 256) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return this.#beginAppleTransaction(
      input,
      "apple_link",
      actorId,
      readCredential(input),
    );
  }

  async #beginAppleTransaction(
    input: AppleAuthorizationInput,
    flowKind: "apple_sign_in" | "apple_link",
    actorId: string | null,
    linkCredential: EmailCredentialInput | null,
  ): Promise<AppleAuthorizationStart> {
    const parsed = this.#parseAppleStart(input);
    const idempotency = readStartIdempotency(input);
    const deviceLabel = ownString(input, "device_label");
    assertCanonicalStartPayloadHash(idempotency.payloadHash, canonicalProviderStartPayloadHash({
      flowKind,
      idempotencyKey: idempotency.key,
      clientKind: parsed.clientKind,
      redirectUri: parsed.redirectUri,
      ...(deviceLabel === undefined ? {} : { deviceLabel }),
      ...(parsed.nonce === null ? {} : { nonce: parsed.nonce }),
      ...(parsed.pkceChallenge === null ? {} : { pkceChallenge: parsed.pkceChallenge }),
    }));
    const transactionId = idempotentStartTransactionId(flowKind, actorId, idempotency.key);
    const state = transactionId;
    const nonce = parsed.nonce ?? encodeOpaque(this.#randomBytes(32));
    const expiresAt = new Date(this.#now().getTime() + oauthTransactionTtlMs).toISOString();
    const recordBase = Object.freeze({
      oauth_transaction_id: transactionId,
      provider: "supabase" as const,
      flow_kind: flowKind,
      actor_id: actorId,
      client_kind: parsed.clientKind,
      state_digest: sha256(state),
      nonce_digest: sha256(nonce),
      redirect_uri: parsed.redirectUri,
      status: "pending" as const,
      expires_at: expiresAt,
    });
    const reservation = await this.#reserveProviderStart(recordBase, idempotency.payloadHash);
    if (reservation.kind === "existing") {
      const stored = parseOAuthTransaction(reservation.record);
      if (stored === undefined || stored.transactionId !== transactionId || stored.flowKind !== flowKind
        || stored.actorId !== actorId || stored.clientKind !== parsed.clientKind
        || stored.redirectUri !== parsed.redirectUri || stored.expiresAt <= this.#now().getTime()) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      const metadata = await this.#startMetadata(stored.ciphertext);
      if (metadata.payloadHash !== idempotency.payloadHash) throw new ProviderFailure("AUTH_CONFLICT");
      if ((metadata.kind !== "web" && metadata.kind !== "native") || metadata.authorizationUrl === undefined) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      return Object.freeze({
        transaction_id: transactionId,
        authorization_url: metadata.authorizationUrl,
        expires_at: reservation.record.expires_at,
      });
    }
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    let verifierBytes: Uint8Array | undefined;
    let transientLinkSession = false;
    try {
      const linkAuthentication = linkCredential === null
        ? null
        : await this.#authenticatePasswordOnClient(client, linkCredential);
      transientLinkSession = linkAuthentication !== null;
      const oauthRequest = {
        provider: "apple",
        options: {
          redirectTo: parsed.redirectUri,
          skipBrowserRedirect: true,
          queryParams: { nonce },
        },
      } as const;
      let rawAuthorizationUrl: string | undefined;
      let flowId: string | undefined;
      if (flowKind === "apple_link" && parsed.clientKind !== "web") {
        flowId = encodeOpaque(this.#randomBytes(12));
        rawAuthorizationUrl = await safeProviderCall(() => this.#nativeLinkAuthorization.authorize({
          supabaseUrl: this.#url,
          publishableKey: this.#publishableKey,
          accessToken: linkAuthentication!.accessToken,
          redirectUri: parsed.redirectUri,
          nonce,
          codeChallenge: parsed.pkceChallenge!,
        }), "AUTH_CONFLICT");
      } else {
        const result = flowKind === "apple_link"
          ? await safeProviderCall(() => client.auth.linkIdentity(oauthRequest), "AUTH_CONFLICT")
          : await safeProviderCall(() => client.auth.signInWithOAuth(oauthRequest), "AUTH_CALLBACK_INVALID");
        const data = requireResultData(
          result,
          flowKind === "apple_link" ? "AUTH_CONFLICT" : "AUTH_CALLBACK_INVALID",
        );
        rawAuthorizationUrl = ownString(data, "url");
        flowId = ownString(data, "flowId");
      }
      if (rawAuthorizationUrl === undefined || flowId === undefined || !/^[A-Za-z0-9_-]{8,64}$/u.test(flowId)) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      let authorizationUrl: URL;
      try {
        authorizationUrl = new URL(rawAuthorizationUrl);
        if (authorizationUrl.protocol !== "https:") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      } catch (error) {
        throw mapProviderFailure(error, "AUTH_PROVIDER_UNAVAILABLE");
      }
      let callbackState = state;
      if (flowKind === "apple_link" && parsed.clientKind !== "web") {
        const providerState = authorizationUrl.searchParams.get("state");
        if (providerState === null || providerState.length < 1 || providerState.length > 4_096
          || authorizationUrl.searchParams.getAll("state").length !== 1) {
          throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        }
        callbackState = providerState;
      } else {
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.delete("redirect_uri");
        authorizationUrl.searchParams.set("redirect_to", parsed.redirectUri);
      }
      let envelope: DecryptedPkceEnvelope;
      if (parsed.clientKind === "web") {
        const verifier = parseStoredString(await storage.getItem(
          `${storageKey}-flow-${flowId}-code-verifier`,
        ));
        if (verifier === undefined || verifier.length < 43 || verifier.length > 512) {
          throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        }
        envelope = {
          kind: "web", flowId, verifier,
          verifierDigest: Buffer.from(sha256(verifier)).toString("hex"),
          ...(linkAuthentication === null ? {} : {
            providerSubjectDigest: Buffer.from(
              sha256(linkAuthentication.subject.providerSubject),
            ).toString("hex"),
          }),
        };
      } else {
        envelope = {
          kind: "native",
          flowId,
          challenge: parsed.pkceChallenge!,
          ...(linkAuthentication === null ? {} : {
            providerSubjectDigest: Buffer.from(
              sha256(linkAuthentication.subject.providerSubject),
            ).toString("hex"),
          }),
        };
        if (flowKind === "apple_sign_in") {
          authorizationUrl.searchParams.set("code_challenge", parsed.pkceChallenge!);
          authorizationUrl.searchParams.set("code_challenge_method", "S256");
        }
      }
      const replayEnvelope = {
        ...envelope,
        startPayloadHash: idempotency.payloadHash,
        authorizationUrl: authorizationUrl.toString(),
      };
      verifierBytes = utf8.encode(JSON.stringify(replayEnvelope));
      const ciphertext = copyBytes(await safeProviderCall(
        () => this.#transactionProtector.encrypt(verifierBytes!),
      ), 1, 65_536);
      if (ciphertext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const transaction: OAuthTransactionRecord = Object.freeze({
        ...recordBase,
        state_digest: sha256(callbackState),
        pkce_verifier_ciphertext: ciphertext,
      });
      await this.#completeProviderStart(transaction, reservation.kind);
      return Object.freeze({
        transaction_id: transactionId,
        authorization_url: authorizationUrl.toString(),
        expires_at: expiresAt,
      });
    } finally {
      verifierBytes?.fill(0);
      try {
        if (transientLinkSession) await this.#signOut(client, "local");
      } finally {
        storage.clear();
      }
    }
  }

  async completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject> {
    const parsed = this.#parseAppleCallback(input);
    return this.#completeAppleTransaction(parsed, "apple_sign_in", null);
  }

  async linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject> {
    const parsed = this.#parseAppleCallback(input);
    const actorId = ownString(input, "authenticatedActorId");
    if (actorId === undefined || actorId.length === 0) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    return this.#completeAppleTransaction(parsed, "apple_link", actorId);
  }

  async completePasswordReset(
    input: PasswordResetCompletionInput,
  ): Promise<VerifiedProviderSubject | PasswordResetProviderObservation> {
    const binding = ownData(input, "binding");
    const transactionId = ownString(binding, "transaction_id");
    const authorizationCode = ownString(input, "authorization_code");
    const state = ownString(binding, "state");
    const bindingExpiresAtText = ownString(binding, "expires_at");
    const bindingExpiresAt = bindingExpiresAtText === undefined
      ? Number.NaN
      : new Date(bindingExpiresAtText).getTime();
    const bindingSettlementNotAfterText = ownString(binding, "settlement_not_after");
    const bindingSettlementNotAfter = bindingSettlementNotAfterText === undefined
      ? Number.NaN
      : new Date(bindingSettlementNotAfterText).getTime();
    const newPassword = ownString(input, "new_password");
    const payloadHash = ownString(input, "payloadHash");
    if (transactionId === undefined || transactionId.length === 0 || transactionId.length > 256
      || authorizationCode === undefined || authorizationCode.length < 8 || authorizationCode.length > 8_192
      || state === undefined || state.length < 8 || state.length > 4_096
      || bindingExpiresAtText === undefined || bindingExpiresAtText.length > 64
      || !Number.isFinite(bindingExpiresAt)
      || bindingSettlementNotAfterText === undefined || bindingSettlementNotAfterText.length > 64
      || !Number.isFinite(bindingSettlementNotAfter)
      || newPassword === undefined || newPassword.length < 8 || newPassword.length > 1_024
      || payloadHash === undefined || !/^sha256:[a-f0-9]{64}$/u.test(payloadHash)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const load = this.#transactionStore.loadStart;
    const beginCompletion = this.#transactionStore.beginPasswordResetCompletion;
    const checkpointCompletion = this.#transactionStore.checkpointPasswordResetCompletion;
    if (load === undefined || beginCompletion === undefined || checkpointCompletion === undefined) {
      throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    }
    const transaction = parseOAuthTransaction(await safeProviderCall(
      () => load.call(this.#transactionStore, transactionId), "AUTH_CALLBACK_INVALID",
    ));
    if (transaction === undefined || transaction.transactionId !== transactionId) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    if (transaction.flowKind !== "password_reset" || transaction.actorId !== null
      || transaction.clientKind !== "web" || transaction.redirectUri !== this.#passwordResetRedirectUri
      || transaction.expiresAt !== bindingExpiresAt
      || bindingSettlementNotAfter !== transaction.expiresAt + 30 * 60 * 1_000
      || !equalDigest(transaction.stateDigest, sha256(state))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    if (transaction.providerCompletionStatus === "provider_completed") {
      const settlementExpiresAt = transaction.providerSettlementExpiresAt === undefined
        ? undefined : strictUtcTimestampMilliseconds(transaction.providerSettlementExpiresAt);
      if (transaction.providerSubjectCiphertext === undefined || transaction.providerCompletionPayloadHash !== payloadHash
        || settlementExpiresAt === undefined || settlementExpiresAt > bindingSettlementNotAfter) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      return this.#readPasswordResetSubject(transaction.providerSubjectCiphertext);
    }
    if (transaction.providerCompletionStatus === "provider_started") {
      const settlementExpiresAt = transaction.providerSettlementExpiresAt === undefined
        ? undefined : strictUtcTimestampMilliseconds(transaction.providerSettlementExpiresAt);
      if (transaction.providerSubjectCiphertext === undefined || transaction.providerCompletionPayloadHash !== payloadHash
        || settlementExpiresAt === undefined || settlementExpiresAt > bindingSettlementNotAfter) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      await this.#readPasswordResetSubject(transaction.providerSubjectCiphertext);
      return Object.freeze({
        kind: "password_reset_provider_observation" as const,
        outcome: "ambiguous" as const,
      });
    }

    if (transaction.expiresAt <= this.#now().getTime()
      || transaction.expectedProviderSubjectCiphertext === undefined
      || bindingSettlementNotAfter !== transaction.expiresAt + 30 * 60 * 1_000) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const envelope = await this.#decryptEnvelope(transaction.ciphertext);
    if (envelope.kind !== "password_reset") throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const expectedSubject = await this.#readPasswordResetSubject(transaction.expectedProviderSubjectCiphertext);
    const started = await safeProviderCall(() => beginCompletion.call(this.#transactionStore, {
      transactionId, payloadHash, settlementNotAfter: bindingSettlementNotAfterText,
    }));
    if (started.kind === "existing") {
      throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    }
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    try {
      await storage.setItem(`${storageKey}-flow-${envelope.flowId}-code-verifier`, JSON.stringify(envelope.verifier));
      const data = requireResultData(await safeProviderCall(
        () => client.auth.exchangeCodeForSession(authorizationCode, { flowId: envelope.flowId }),
        "AUTH_CALLBACK_INVALID",
      ), "AUTH_CALLBACK_INVALID");
      if (ownData(data, "session") === null || ownData(data, "session") === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      const subject = copySubject(ownData(data, "user"), "email_password");
      if (subject.providerSubject !== expectedSubject.providerSubject
        || subject.normalizedEmail !== expectedSubject.normalizedEmail) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      const { client: adminClient, storage: adminStorage } = this.#newClient(this.#serviceRoleKey);
      try {
        const adminData = requireResultData(await safeProviderCall(
          () => adminClient.auth.admin.updateUserById(subject.providerSubject, { password: newPassword }),
        ));
        const providerUser = ownData(adminData, "user");
        if (ownString(providerUser, "id") !== subject.providerSubject) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        const evidence = ownString(providerUser, "updated_at");
        const startedTimestamp = strictUtcTimestampMilliseconds(started.startedAt);
        const evidenceTimestamp = evidence === undefined ? undefined : strictUtcTimestampMilliseconds(evidence);
        if (startedTimestamp === undefined || evidenceTimestamp === undefined
          || evidenceTimestamp < startedTimestamp || evidenceTimestamp > this.#now().getTime()) {
          throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        }
        await safeProviderCall(() => checkpointCompletion.call(this.#transactionStore, {
          transactionId, providerEvidenceAt: evidence!,
        }));
        return subject;
      } finally {
        adminStorage.clear();
      }
    } finally {
      storage.clear();
    }
  }

  async revokeCurrentProviderSession(input: ProviderProof): Promise<void> {
    const accessToken = readProof(input);
    const { client, storage } = this.#newClient();
    try {
      await this.#hydrateProof(client, accessToken);
      await this.#signOut(client, "global");
    } finally {
      storage.clear();
    }
  }

  async deleteProviderSubject(providerSubject: string): Promise<void> {
    if (typeof providerSubject !== "string" || providerSubject.length === 0 || providerSubject.length > 1_024) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    const { client, storage } = this.#newClient(this.#serviceRoleKey);
    try {
      const result = await safeProviderCall(
        () => client.auth.admin.deleteUser(providerSubject, false),
      );
      if (!hasOwnData(result, "error")) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const error = ownData(result, "error");
      if (error !== null && error !== undefined) {
        if (ownData(error, "status") === 404 || ownString(error, "code") === "user_not_found") return;
        throw mapProviderFailure(error);
      }
      if (!hasOwnData(result, "data")) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    } finally {
      storage.clear();
    }
  }

  async #passwordSubject(credential: EmailCredentialInput): Promise<VerifiedProviderSubject> {
    const { client, storage } = this.#newClient();
    try {
      const authentication = await this.#authenticatePasswordOnClient(client, credential);
      await this.#signOut(client, "local");
      return authentication.subject;
    } finally {
      storage.clear();
    }
  }

  async #authenticatePasswordOnClient(
    client: SupabaseClientPort,
    credential: EmailCredentialInput,
  ): Promise<{ readonly subject: VerifiedProviderSubject; readonly accessToken: string }> {
    const data = requireResultData(await safeProviderCall(() => client.auth.signInWithPassword({
      email: credential.email,
      password: credential.password,
    })));
    const session = ownData(data, "session");
    const subject = copySubject(ownData(data, "user"), "email_password");
    const accessToken = ownString(session, "access_token");
    if (accessToken === undefined || accessToken.length === 0 || accessToken.length > 16_384) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    return Object.freeze({
      subject,
      accessToken,
    });
  }

  async #hydrateProof(client: SupabaseClientPort, accessToken: string): Promise<VerifiedProviderSubject> {
    const data = requireResultData(await safeProviderCall(() => client.auth.setSession({
      access_token: accessToken,
      refresh_token: transientRefreshPlaceholder,
    })));
    return copySubject(ownData(data, "user"));
  }

  async #signOut(client: SupabaseClientPort, scope: "local" | "global"): Promise<void> {
    requireNoResultError(await safeProviderCall(() => client.auth.signOut({ scope })));
  }

  #newClient(
    key = this.#publishableKey,
    operationId = encodeOpaque(this.#randomBytes(12)),
  ): {
    readonly client: SupabaseClientPort;
    readonly storage: TransientStorage;
    readonly storageKey: string;
  } {
    const storage = new MemoryStorage();
    const storageKey = `core-agent-${operationId}`;
    const options: SupabaseClientCreationOptions = {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: "pkce",
        experimental: { appendPkceFlowIdToRedirects: false },
        storageKey,
        storage,
      },
    };
    try {
      return { client: this.#createClient(this.#url, key, options), storage, storageKey };
    } catch (error) {
      storage.clear();
      throw mapProviderFailure(error);
    }
  }

  #parseAppleStart(input: AppleAuthorizationInput): ParsedAppleStart {
    const clientKind = readClientKind(ownData(input, "client_kind"));
    const redirectUri = ownString(input, "redirect_uri");
    const nonce = ownString(input, "nonce");
    const challenge = ownString(input, "pkce_code_challenge");
    const method = ownString(input, "pkce_code_challenge_method");
    if (clientKind === undefined || redirectUri === undefined
      || !validateRedirectUri(redirectUri, this.#appleRedirectUris)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    if (clientKind === "web") {
      if (nonce !== undefined || challenge !== undefined || method !== undefined) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      return { clientKind, redirectUri, nonce: null, pkceChallenge: null };
    }
    if (nonce === undefined || nonce.length < 8 || nonce.length > 4_096
      || challenge === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(challenge) || method !== "S256") {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return { clientKind, redirectUri, nonce, pkceChallenge: challenge };
  }

  #parseAppleCallback(input: AppleAuthorizationCallback): ParsedAppleCallback {
    const transactionId = ownString(input, "transaction_id");
    const authorizationCode = ownString(input, "authorization_code");
    const state = ownString(input, "state");
    const nonce = ownString(input, "nonce");
    const verifier = ownString(input, "pkce_code_verifier");
    const clientKind = readClientKind(ownData(input, "client_kind"));
    const idempotency = readStartIdempotency(input);
    if (transactionId === undefined || transactionId.length === 0 || transactionId.length > 256
      || authorizationCode === undefined || authorizationCode.length === 0 || authorizationCode.length > 8_192
      || state === undefined || state.length === 0 || state.length > 4_096
      || clientKind === undefined
      || (clientKind === "web" && (nonce !== undefined || verifier !== undefined))
      || (clientKind !== "web" && (nonce === undefined || nonce.length < 8 || nonce.length > 4_096
        || verifier === undefined || !/^[A-Za-z0-9._~-]{43}$/u.test(verifier)))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return {
      transactionId, authorizationCode, state, clientKind,
      nonce: nonce ?? null, pkceVerifier: verifier ?? null,
      payloadHash: idempotency.payloadHash,
    };
  }

  async #completeAppleTransaction(
    callback: ParsedAppleCallback,
    expectedFlowKind: OAuthTransactionRecord["flow_kind"],
    expectedActorId: string | null,
  ): Promise<VerifiedProviderSubject> {
    let transaction: ParsedOAuthTransaction;
    if (expectedFlowKind === "apple_link") {
      const load = this.#transactionStore.loadStart;
      if (load === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const loaded = parseOAuthTransaction(await safeProviderCall(
        () => load.call(this.#transactionStore, callback.transactionId),
        "AUTH_CALLBACK_INVALID",
      ));
      if (loaded === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      transaction = loaded;
    } else {
      transaction = await this.#consumeTransaction(callback.transactionId);
    }
    if (transaction.flowKind !== expectedFlowKind || transaction.actorId !== expectedActorId
      || transaction.clientKind !== callback.clientKind
      || !validateRedirectUri(transaction.redirectUri, this.#appleRedirectUris)
      || transaction.expiresAt <= this.#now().getTime()
      || !equalDigest(transaction.stateDigest, sha256(callback.state))
      || (callback.clientKind !== "web"
        && !equalDigest(transaction.nonceDigest, sha256(callback.nonce!)))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const envelope = await this.#decryptEnvelope(transaction.ciphertext);
    const verifier = envelope.kind === "web" ? envelope.verifier : callback.pkceVerifier;
    if ((callback.clientKind === "web" && envelope.kind !== "web")
      || (callback.clientKind !== "web" && (envelope.kind !== "native" || verifier === null
        || sha256Base64Url(verifier) !== envelope.challenge))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }

    if (expectedFlowKind === "apple_link") {
      if (transaction.providerCompletionStatus === "provider_completed") {
        if (transaction.providerCompletionPayloadHash !== callback.payloadHash
          || transaction.providerSubjectCiphertext === undefined) {
          throw new ProviderFailure("AUTH_CONFLICT");
        }
        return this.#readAppleLinkSubject(transaction.providerSubjectCiphertext);
      }
      if (transaction.providerCompletionStatus === "provider_started") {
        if (transaction.providerCompletionPayloadHash !== callback.payloadHash) {
          throw new ProviderFailure("AUTH_CONFLICT");
        }
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      const begin = this.#transactionStore.beginAppleLinkCompletion;
      if (begin === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const admission = await safeProviderCall(() => begin.call(this.#transactionStore, {
        transactionId: callback.transactionId, payloadHash: callback.payloadHash,
      }));
      if (admission.kind !== "acquired") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    }

    const { client, storage, storageKey } = this.#newClient(undefined, callback.transactionId);
    try {
      await storage.setItem(
        `${storageKey}-flow-${envelope.flowId}-code-verifier`,
        JSON.stringify(verifier),
      );
      const data = requireResultData(await safeProviderCall(
        () => client.auth.exchangeCodeForSession(callback.authorizationCode, { flowId: envelope.flowId }),
        "AUTH_CALLBACK_INVALID",
      ), "AUTH_CALLBACK_INVALID");
      const subject = copySubject(ownData(data, "user"), "apple");
      const expectedSubjectDigest = envelope.providerSubjectDigest;
      if ((expectedFlowKind === "apple_sign_in" && expectedSubjectDigest !== undefined)
        || (expectedFlowKind === "apple_link"
          && (expectedSubjectDigest === undefined
            || !equalDigest(
              sha256(subject.providerSubject),
              Uint8Array.from(Buffer.from(expectedSubjectDigest, "hex")),
            )))) {
        throw new ProviderFailure("AUTH_CONFLICT");
      }
      if (ownData(data, "session") === null || ownData(data, "session") === undefined) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      await this.#signOut(client, "local");
      if (expectedFlowKind === "apple_link") {
        const checkpoint = this.#transactionStore.checkpointAppleLinkCompletion;
        if (checkpoint === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
        const ciphertext = await this.#protectAppleLinkSubject(subject);
        try {
          await safeProviderCall(() => checkpoint.call(this.#transactionStore, {
            transactionId: callback.transactionId,
            providerSubjectCiphertext: ciphertext,
          }));
        } finally {
          ciphertext.fill(0);
        }
      }
      return subject;
    } finally {
      storage.clear();
    }
  }

  async #consumeTransaction(transactionId: string): Promise<ParsedOAuthTransaction> {
    const consumed = await safeProviderCall(
      () => this.#transactionStore.consume(transactionId),
      "AUTH_CALLBACK_INVALID",
    );
    const transaction = parseOAuthTransaction(consumed);
    if (transaction === undefined || transaction.transactionId !== transactionId) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return transaction;
  }

  async #decryptEnvelope(ciphertext: Uint8Array): Promise<DecryptedPkceEnvelope> {
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = copyBytes(await this.#transactionProtector.decrypt(ciphertext), 1, 65_536);
      if (plaintext === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
      const kind = ownString(parsed, "kind");
      const flowId = ownString(parsed, "flowId");
      if (flowId === undefined || !/^[A-Za-z0-9_-]{8,64}$/u.test(flowId)) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      if (kind === "native") {
        const challenge = ownString(parsed, "challenge");
        const providerSubjectDigest = ownString(parsed, "providerSubjectDigest");
        if (challenge === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
          throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        }
        if (providerSubjectDigest !== undefined && !/^[a-f0-9]{64}$/u.test(providerSubjectDigest)) {
          throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        }
        return {
          kind, flowId, challenge,
          ...(providerSubjectDigest === undefined ? {} : { providerSubjectDigest }),
        };
      }
      const verifier = ownString(parsed, "verifier");
      const verifierDigest = ownString(parsed, "verifierDigest");
      const providerSubjectDigest = ownString(parsed, "providerSubjectDigest");
      if ((kind !== "web" && kind !== "password_reset") || verifier === undefined
        || verifier.length < 43 || verifier.length > 512
        || verifierDigest === undefined || !/^[a-f0-9]{64}$/u.test(verifierDigest)
        || !equalDigest(sha256(verifier), Uint8Array.from(Buffer.from(verifierDigest, "hex")))
        || (providerSubjectDigest !== undefined && !/^[a-f0-9]{64}$/u.test(providerSubjectDigest))) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      return {
        kind, flowId, verifier, verifierDigest,
        ...(providerSubjectDigest === undefined ? {} : { providerSubjectDigest }),
      };
    } catch (error) {
      throw mapProviderFailure(error, "AUTH_CALLBACK_INVALID");
    } finally {
      plaintext?.fill(0);
    }
  }
}
