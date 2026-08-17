import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createRequire } from "node:module";

import type {
  AppleAuthorizationCallback,
  AppleAuthorizationInput,
  AppleAuthorizationStart,
  AppleLinkInput,
  AuthProviderAdapter,
  EmailCredentialInput,
  ProviderClientKind,
  ProviderProof,
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
  readonly flow_kind: "apple_sign_in" | "apple_link";
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
  readonly flowKind: "sign_in" | "link";
  readonly clientKind: ProviderClientKind;
  readonly redirectUri: string;
  readonly actorId: string | null;
  readonly accessToken: string | null;
}

interface ParsedAppleCallback {
  readonly transactionId: string;
  readonly authorizationCode: string;
  readonly state: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly clientKind: ProviderClientKind;
}

interface DecryptedPkceEnvelope {
  readonly flowId: string;
  readonly verifier: string;
  readonly verifierDigest: string;
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
    const { client, storage } = this.#newClient();
    try {
      requireResultData(await safeProviderCall(() => client.auth.resetPasswordForEmail(
        normalizeEmail(email),
        { redirectTo: this.#passwordResetRedirectUri },
      )));
    } finally {
      storage.clear();
    }
  }

  async beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart> {
    const parsed = this.#parseAppleStart(input);
    const transactionId = `oauth_${encodeOpaque(this.#randomBytes(18))}`;
    const state = encodeOpaque(this.#randomBytes(32));
    const nonce = encodeOpaque(this.#randomBytes(32));
    const expiresAt = new Date(this.#now().getTime() + oauthTransactionTtlMs).toISOString();
    const { client, storage, storageKey } = this.#newClient(undefined, transactionId);
    let verifierBytes: Uint8Array | undefined;
    try {
      if (parsed.flowKind === "link") {
        await this.#hydrateProof(client, parsed.accessToken ?? "");
      }
      const oauthRequest = {
        provider: "apple",
        options: {
          redirectTo: parsed.redirectUri,
          skipBrowserRedirect: true,
          queryParams: { state, nonce },
        },
      } as const;
      const result = parsed.flowKind === "link"
        ? await safeProviderCall(() => client.auth.linkIdentity(oauthRequest), "AUTH_CONFLICT")
        : await safeProviderCall(() => client.auth.signInWithOAuth(oauthRequest), "AUTH_CALLBACK_INVALID");
      const data = requireResultData(result, parsed.flowKind === "link" ? "AUTH_CONFLICT" : "AUTH_CALLBACK_INVALID");
      const authorizationUrl = ownString(data, "url");
      const flowId = ownString(data, "flowId");
      if (authorizationUrl === undefined || flowId === undefined || !/^[A-Za-z0-9_-]{8,64}$/u.test(flowId)) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      try {
        const parsedUrl = new URL(authorizationUrl);
        if (parsedUrl.protocol !== "https:") throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      } catch (error) {
        throw mapProviderFailure(error, "AUTH_PROVIDER_UNAVAILABLE");
      }
      const verifier = parseStoredString(await storage.getItem(
        `${storageKey}-flow-${flowId}-code-verifier`,
      ));
      if (verifier === undefined || verifier.length < 43 || verifier.length > 512) {
        throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
      }
      verifierBytes = utf8.encode(JSON.stringify({
        flowId,
        verifier,
        verifierDigest: Buffer.from(sha256(verifier)).toString("hex"),
      } satisfies DecryptedPkceEnvelope));
      const ciphertext = await safeProviderCall(
        () => this.#transactionProtector.encrypt(verifierBytes!),
      );
      const transaction: OAuthTransactionRecord = Object.freeze({
        oauth_transaction_id: transactionId,
        provider: "supabase",
        flow_kind: parsed.flowKind === "link" ? "apple_link" : "apple_sign_in",
        actor_id: parsed.actorId,
        client_kind: parsed.clientKind,
        state_digest: sha256(state),
        nonce_digest: sha256(nonce),
        pkce_verifier_ciphertext: Uint8Array.from(ciphertext),
        redirect_uri: parsed.redirectUri,
        status: "pending",
        expires_at: expiresAt,
      });
      await safeProviderCall(() => this.#transactionStore.save(transaction));
      return Object.freeze({ transactionId, authorizationUrl, expiresAt });
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
    const flowKind = ownString(input, "flowKind");
    const clientKind = readClientKind(ownData(input, "clientKind"));
    const redirectUri = ownString(input, "redirectUri");
    if ((flowKind !== "sign_in" && flowKind !== "link") || clientKind === undefined
      || redirectUri === undefined || !validateRedirectUri(redirectUri, this.#appleRedirectUris)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    if (flowKind === "sign_in") {
      return { flowKind, clientKind, redirectUri, actorId: null, accessToken: null };
    }
    const actorId = ownString(input, "authenticatedActorId");
    if (actorId === undefined || actorId.length === 0) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    return {
      flowKind,
      clientKind,
      redirectUri,
      actorId,
      accessToken: readProof(ownData(input, "providerProof")),
    };
  }

  #parseAppleCallback(input: AppleAuthorizationCallback): ParsedAppleCallback {
    const transactionId = ownString(input, "transactionId");
    const authorizationCode = ownString(input, "authorizationCode");
    const state = ownString(input, "state");
    const nonce = ownString(input, "nonce");
    const redirectUri = ownString(input, "redirectUri");
    const clientKind = readClientKind(ownData(input, "clientKind"));
    if (transactionId === undefined || transactionId.length === 0 || transactionId.length > 256
      || authorizationCode === undefined || authorizationCode.length === 0 || authorizationCode.length > 8_192
      || state === undefined || state.length === 0 || state.length > 4_096
      || nonce === undefined || nonce.length === 0 || nonce.length > 4_096
      || redirectUri === undefined || clientKind === undefined) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    return { transactionId, authorizationCode, state, nonce, redirectUri, clientKind };
  }

  async #completeAppleTransaction(
    callback: ParsedAppleCallback,
    expectedFlowKind: OAuthTransactionRecord["flow_kind"],
    expectedActorId: string | null,
    accessToken: string | null,
  ): Promise<VerifiedProviderSubject> {
    const transaction = await safeProviderCall(
      () => this.#transactionStore.consume(callback.transactionId),
    );
    const expiresAt = transaction === undefined ? Number.NaN : new Date(transaction.expires_at).getTime();
    if (transaction === undefined || transaction.provider !== "supabase"
      || transaction.status !== "pending" || transaction.flow_kind !== expectedFlowKind
      || transaction.actor_id !== expectedActorId || transaction.client_kind !== callback.clientKind
      || transaction.redirect_uri !== callback.redirectUri
      || !Number.isFinite(expiresAt) || expiresAt <= this.#now().getTime()
      || !equalDigest(transaction.state_digest, sha256(callback.state))
      || !equalDigest(transaction.nonce_digest, sha256(callback.nonce))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }

    let plaintext: Uint8Array | undefined;
    let envelope: DecryptedPkceEnvelope;
    try {
      plaintext = await this.#transactionProtector.decrypt(transaction.pkce_verifier_ciphertext);
      const parsed: unknown = JSON.parse(utf8Decoder.decode(plaintext));
      const flowId = ownString(parsed, "flowId");
      const verifier = ownString(parsed, "verifier");
      const verifierDigest = ownString(parsed, "verifierDigest");
      if (flowId === undefined || !/^[A-Za-z0-9_-]{8,64}$/u.test(flowId)
        || verifier === undefined || verifier.length < 43 || verifier.length > 512
        || verifierDigest === undefined || !/^[a-f0-9]{64}$/u.test(verifierDigest)
        || !equalDigest(sha256(verifier), Uint8Array.from(Buffer.from(verifierDigest, "hex")))) {
        throw new ProviderFailure("AUTH_CALLBACK_INVALID");
      }
      envelope = { flowId, verifier, verifierDigest };
    } catch (error) {
      throw mapProviderFailure(error, "AUTH_CALLBACK_INVALID");
    } finally {
      plaintext?.fill(0);
    }

    const { client, storage, storageKey } = this.#newClient(undefined, callback.transactionId);
    try {
      await storage.setItem(
        `${storageKey}-flow-${envelope.flowId}-code-verifier`,
        JSON.stringify(envelope.verifier),
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
}
