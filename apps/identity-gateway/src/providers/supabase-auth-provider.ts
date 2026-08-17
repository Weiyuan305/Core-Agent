import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";
import { types as utilTypes } from "node:util";

import type {
  AppleAuthorizationCallback,
  AppleAuthorizationInput,
  AppleAuthorizationStart,
  AppleLinkAuthorizationInput,
  AppleLinkInput,
  AuthProviderAdapter,
  EmailCredentialInput,
  ProviderClientKind,
  ProviderProof,
  PasswordResetCompletionInput,
  VerifiedProviderSubject,
} from "./auth-provider.js";
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
  signInWithOAuth(input: unknown): Promise<unknown>;
  exchangeCodeForSession(code: string, options?: { readonly flowId?: string }): Promise<unknown>;
  getUser(jwt?: string): Promise<unknown>;
  setSession(input: { readonly access_token: string; readonly refresh_token: string }): Promise<unknown>;
  signOut(input: { readonly scope: "local" | "global" }): Promise<unknown>;
  resetPasswordForEmail(email: string, options: { readonly redirectTo: string }): Promise<unknown>;
  updateUser(input: { readonly password: string }): Promise<unknown>;
  linkIdentity(input: unknown): Promise<unknown>;
  readonly admin: {
    deleteUser(providerSubject: string, shouldSoftDelete: boolean): Promise<unknown>;
  };
}

interface SupabaseClientPort {
  readonly auth: SupabaseAuthPort;
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
}

export interface OAuthTransactionStore {
  save(record: OAuthTransactionRecord): Promise<void>;
  consume(transactionId: string): Promise<OAuthTransactionRecord | undefined>;
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
  readonly transactionStore: OAuthTransactionStore;
  readonly transactionProtector: TransactionProtector;
  readonly createClient?: SupabaseClientFactory;
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
}

interface WebPkceEnvelope {
  readonly kind: "web" | "password_reset";
  readonly flowId: string;
  readonly verifier: string;
  readonly verifierDigest: string;
}

interface NativePkceEnvelope {
  readonly kind: "native";
  readonly flowId: string;
  readonly challenge: string;
}

type DecryptedPkceEnvelope = WebPkceEnvelope | NativePkceEnvelope;

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
  if (typeof auth !== "object" || auth === null) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
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

function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasOwnData(value: unknown, key: string): boolean {
  try {
    if (typeof value !== "object" || value === null) return false;
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

function requireResultData(result: unknown, fallback?: ProviderFailureCode): unknown {
  if (!hasOwnData(result, "error") || !hasOwnData(result, "data")) {
    throw new ProviderFailure(fallback ?? "AUTH_PROVIDER_UNAVAILABLE");
  }
  const error = ownData(result, "error");
  if (error !== null && error !== undefined) throw mapProviderFailure(error, fallback);
  const data = ownData(result, "data");
  if (typeof data !== "object" || data === null) {
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
  const verifiedTime = new Date(confirmedAt);
  if (!Number.isFinite(verifiedTime.getTime())) throw new ProviderFailure("AUTH_EMAIL_UNVERIFIED");

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
    verifiedAt: verifiedTime.toISOString(),
  });
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
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
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
  if (transactionId === undefined || transactionId.length === 0 || transactionId.length > 256
    || provider !== "supabase"
    || (flowKind !== "apple_sign_in" && flowKind !== "apple_link" && flowKind !== "password_reset")
    || (actor !== null && (typeof actor !== "string" || actor.length === 0 || actor.length > 256))
    || clientKind === undefined || stateDigest === undefined || nonceDigest === undefined
    || ciphertext === undefined || redirectUri === undefined || redirectUri.length === 0
    || redirectUri.length > 2_048 || status !== "pending" || !Number.isFinite(expiresAt)) return undefined;
  return {
    transactionId, flowKind, actorId: actor as string | null, clientKind,
    stateDigest, nonceDigest, ciphertext, redirectUri, expiresAt,
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
  readonly #transactionStore: OAuthTransactionStore;
  readonly #transactionProtector: TransactionProtector;
  readonly #createClient: SupabaseClientFactory;
  readonly #now: () => Date;
  readonly #randomBytes: (length: number) => Uint8Array;

  constructor(options: SupabaseAuthProviderOptions) {
    this.#url = options.supabaseUrl;
    this.#publishableKey = options.publishableKey;
    this.#serviceRoleKey = options.serviceRoleKey;
    this.#appleRedirectUris = new Set(options.appleRedirectUris);
    this.#passwordResetRedirectUri = options.passwordResetRedirectUri;
    this.#transactionStore = options.transactionStore;
    this.#transactionProtector = options.transactionProtector;
    this.#createClient = options.createClient ?? defaultClientFactory;
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? ((length) => Uint8Array.from(nodeRandomBytes(length)));
  }

  async signUpEmail(input: EmailCredentialInput): Promise<{ readonly kind: "verification_pending" }> {
    const credential = readCredential(input);
    const { client, storage } = this.#newClient();
    try {
      const data = requireResultData(await safeProviderCall(() => client.auth.signUp({
        email: credential.email,
        password: credential.password,
      })));
      if (ownData(data, "session") !== null) {
        await this.#signOut(client, "local");
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      return Object.freeze({ kind: "verification_pending" });
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

  async beginPasswordReset(email: string): Promise<void> {
    if (typeof email !== "string" || !validEmail(normalizeEmail(email))) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    const transactionId = `oauth_${encodeOpaque(this.#randomBytes(18))}`;
    const state = encodeOpaque(this.#randomBytes(32));
    const redirect = new URL(this.#passwordResetRedirectUri);
    redirect.searchParams.set("transaction_id", transactionId);
    redirect.searchParams.set("state", state);
    const exactRedirect = redirect.toString();
    const expiresAt = new Date(this.#now().getTime() + oauthTransactionTtlMs).toISOString();
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    let verifierBytes: Uint8Array | undefined;
    try {
      requireResultData(await safeProviderCall(() => client.auth.resetPasswordForEmail(
        normalizeEmail(email),
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
      } satisfies WebPkceEnvelope));
      const ciphertext = copyBytes(await safeProviderCall(
        () => this.#transactionProtector.encrypt(verifierBytes!),
      ), 1, 65_536);
      if (ciphertext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      await safeProviderCall(() => this.#transactionStore.save(Object.freeze({
        oauth_transaction_id: transactionId,
        provider: "supabase",
        flow_kind: "password_reset",
        actor_id: null,
        client_kind: "web",
        state_digest: sha256(state),
        nonce_digest: sha256(`password-reset:${transactionId}`),
        pkce_verifier_ciphertext: ciphertext,
        redirect_uri: exactRedirect,
        status: "pending",
        expires_at: expiresAt,
      })));
    } finally {
      verifierBytes?.fill(0);
      storage.clear();
    }
  }

  async beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart> {
    return this.#beginAppleTransaction(input, "apple_sign_in", null, null);
  }

  async beginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart> {
    const actorId = ownString(input, "authenticatedActorId");
    if (actorId === undefined || actorId.length === 0 || actorId.length > 256) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return this.#beginAppleTransaction(
      input,
      "apple_link",
      actorId,
      readProof(ownData(input, "providerProof")),
    );
  }

  async #beginAppleTransaction(
    input: AppleAuthorizationInput,
    flowKind: "apple_sign_in" | "apple_link",
    actorId: string | null,
    accessToken: string | null,
  ): Promise<AppleAuthorizationStart> {
    const parsed = this.#parseAppleStart(input);
    const transactionId = `oauth_${encodeOpaque(this.#randomBytes(18))}`;
    const state = encodeOpaque(this.#randomBytes(32));
    const nonce = parsed.nonce ?? encodeOpaque(this.#randomBytes(32));
    const expiresAt = new Date(this.#now().getTime() + oauthTransactionTtlMs).toISOString();
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    let verifierBytes: Uint8Array | undefined;
    try {
      if (accessToken !== null) await this.#hydrateProof(client, accessToken);
      const oauthRequest = {
        provider: "apple",
        options: {
          redirectTo: parsed.redirectUri,
          skipBrowserRedirect: true,
          queryParams: { state, nonce },
        },
      } as const;
      const result = flowKind === "apple_link"
        ? await safeProviderCall(() => client.auth.linkIdentity(oauthRequest), "AUTH_CONFLICT")
        : await safeProviderCall(() => client.auth.signInWithOAuth(oauthRequest), "AUTH_CALLBACK_INVALID");
      const data = requireResultData(result, flowKind === "apple_link" ? "AUTH_CONFLICT" : "AUTH_CALLBACK_INVALID");
      const rawAuthorizationUrl = ownString(data, "url");
      const flowId = ownString(data, "flowId");
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
        };
      } else {
        envelope = { kind: "native", flowId, challenge: parsed.pkceChallenge! };
        authorizationUrl.searchParams.set("code_challenge", parsed.pkceChallenge!);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
      }
      verifierBytes = utf8.encode(JSON.stringify(envelope));
      const ciphertext = copyBytes(await safeProviderCall(
        () => this.#transactionProtector.encrypt(verifierBytes!),
      ), 1, 65_536);
      if (ciphertext === undefined) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      const transaction: OAuthTransactionRecord = Object.freeze({
        oauth_transaction_id: transactionId,
        provider: "supabase",
        flow_kind: flowKind,
        actor_id: actorId,
        client_kind: parsed.clientKind,
        state_digest: sha256(state),
        nonce_digest: sha256(nonce),
        pkce_verifier_ciphertext: ciphertext,
        redirect_uri: parsed.redirectUri,
        status: "pending",
        expires_at: expiresAt,
      });
      await safeProviderCall(() => this.#transactionStore.save(transaction));
      return Object.freeze({
        transaction_id: transactionId,
        authorization_url: authorizationUrl.toString(),
        expires_at: expiresAt,
      });
    } finally {
      verifierBytes?.fill(0);
      storage.clear();
    }
  }

  async completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject> {
    const parsed = this.#parseAppleCallback(input);
    return this.#completeAppleTransaction(parsed, "apple_sign_in", null, null);
  }

  async linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject> {
    const parsed = this.#parseAppleCallback(input);
    const actorId = ownString(input, "authenticatedActorId");
    const proof = ownData(input, "providerProof");
    if (actorId === undefined || actorId.length === 0) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const accessToken = readProof(proof);
    return this.#completeAppleTransaction(parsed, "apple_link", actorId, accessToken);
  }

  async completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject> {
    const transactionId = ownString(input, "transaction_id");
    const authorizationCode = ownString(input, "authorization_code");
    const state = ownString(input, "state");
    const redirectUri = ownString(input, "redirect_uri");
    const newPassword = ownString(input, "new_password");
    if (transactionId === undefined || transactionId.length === 0 || transactionId.length > 256
      || authorizationCode === undefined || authorizationCode.length < 8 || authorizationCode.length > 8_192
      || state === undefined || state.length < 8 || state.length > 4_096
      || redirectUri === undefined || redirectUri.length > 2_048
      || newPassword === undefined || newPassword.length < 8 || newPassword.length > 1_024) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const transaction = await this.#consumeTransaction(transactionId);
    const expectedRedirect = new URL(this.#passwordResetRedirectUri);
    expectedRedirect.searchParams.set("transaction_id", transactionId);
    expectedRedirect.searchParams.set("state", state);
    if (transaction.flowKind !== "password_reset" || transaction.actorId !== null
      || transaction.clientKind !== "web" || transaction.redirectUri !== redirectUri
      || transaction.redirectUri !== expectedRedirect.toString()
      || transaction.expiresAt <= this.#now().getTime()
      || !equalDigest(transaction.stateDigest, sha256(state))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const envelope = await this.#decryptEnvelope(transaction.ciphertext);
    if (envelope.kind !== "password_reset") throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    try {
      await storage.setItem(`${storageKey}-flow-${envelope.flowId}-code-verifier`, JSON.stringify(envelope.verifier));
      const data = requireResultData(await safeProviderCall(
        () => client.auth.exchangeCodeForSession(authorizationCode, { flowId: envelope.flowId }),
        "AUTH_CALLBACK_INVALID",
      ), "AUTH_CALLBACK_INVALID");
      if (ownData(data, "session") === null || ownData(data, "session") === undefined) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      const subject = copySubject(ownData(data, "user"), "email_password");
      requireResultData(await safeProviderCall(() => client.auth.updateUser({ password: newPassword })));
      await this.#signOut(client, "global");
      return subject;
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
    let authenticated = false;
    try {
      const data = requireResultData(await safeProviderCall(() => client.auth.signInWithPassword({
        email: credential.email,
        password: credential.password,
      })));
      authenticated = ownData(data, "session") !== null && ownData(data, "session") !== undefined;
      const subject = copySubject(ownData(data, "user"), "email_password");
      if (!authenticated) throw new ProviderFailure("AUTH_INVALID");
      await this.#signOut(client, "local");
      return subject;
    } finally {
      storage.clear();
    }
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
    };
  }

  async #completeAppleTransaction(
    callback: ParsedAppleCallback,
    expectedFlowKind: OAuthTransactionRecord["flow_kind"],
    expectedActorId: string | null,
    accessToken: string | null,
  ): Promise<VerifiedProviderSubject> {
    const transaction = await this.#consumeTransaction(callback.transactionId);
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

    const { client, storage, storageKey } = this.#newClient(undefined, callback.transactionId);
    try {
      await storage.setItem(
        `${storageKey}-flow-${envelope.flowId}-code-verifier`,
        JSON.stringify(verifier),
      );
      let currentSubject: VerifiedProviderSubject | undefined;
      if (accessToken !== null) currentSubject = await this.#hydrateProof(client, accessToken);
      const data = requireResultData(await safeProviderCall(
        () => client.auth.exchangeCodeForSession(callback.authorizationCode, { flowId: envelope.flowId }),
        "AUTH_CALLBACK_INVALID",
      ), "AUTH_CALLBACK_INVALID");
      const subject = copySubject(ownData(data, "user"), "apple");
      if (currentSubject !== undefined && currentSubject.providerSubject !== subject.providerSubject) {
        throw new ProviderFailure("AUTH_CONFLICT");
      }
      if (ownData(data, "session") === null || ownData(data, "session") === undefined) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      await this.#signOut(client, "local");
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
        if (challenge === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
          throw new ProviderFailure("AUTH_CALLBACK_INVALID");
        }
        return { kind, flowId, challenge };
      }
      const verifier = ownString(parsed, "verifier");
      const verifierDigest = ownString(parsed, "verifierDigest");
      if ((kind !== "web" && kind !== "password_reset") || verifier === undefined
        || verifier.length < 43 || verifier.length > 512
        || verifierDigest === undefined || !/^[a-f0-9]{64}$/u.test(verifierDigest)
        || !equalDigest(sha256(verifier), Uint8Array.from(Buffer.from(verifierDigest, "hex")))) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      return { kind, flowId, verifier, verifierDigest };
    } catch (error) {
      throw mapProviderFailure(error, "AUTH_CALLBACK_INVALID");
    } finally {
      plaintext?.fill(0);
    }
  }
}
