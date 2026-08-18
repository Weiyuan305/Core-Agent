import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import type {
  AppleAuthorizationCallback,
  AppleAuthorizationStart,
  AppleLinkAuthorizationInput,
  AppleLinkInput,
  ProviderClientKind,
} from "../src/providers/auth-provider.js";
import { mapProviderFailure, ProviderFailure } from "../src/providers/provider-errors.js";
import {
  SupabaseAuthProvider,
  type OAuthTransactionRecord,
  type OAuthTransactionStore,
  type SupabaseClientFactory,
  type TransactionProtector,
} from "../src/providers/supabase-auth-provider.js";

const fixedNow = new Date("2026-08-17T02:00:00.000Z");
const callbackUri = "https://identity.example.test/auth/v1/apple/callback";
const nativeCallbackUri = "coreagent://auth/callback";
const passwordResetCallbackUri = "https://identity.example.test/auth/v1/password/reset/callback";
const credential = Object.freeze({
  email: "USER@EXAMPLE.TEST",
  password: "correct horse battery staple",
});
const currentJwt = ["provider", "jwt", "sentinel"].join("-");
const providerProof = Object.freeze({ accessToken: currentJwt });
const pkceVerifier = ["pkce", "verifier", "sentinel", "x".repeat(32)].join("-");
const nativePkceVerifier = "n".repeat(43);
const nativePkceChallenge = createHash("sha256").update(nativePkceVerifier).digest("base64url");
const nativeNonce = "native-nonce-proof";
const recoveryVerifier = `${"r".repeat(43)}/recovery`;
const providerAccessToken = ["provider", "access", "sentinel"].join("-");
const providerRefreshToken = ["provider", "refresh", "sentinel"].join("-");
const serviceRoleKey = ["service", "role", "sentinel"].join("-");
const payloadHash = `sha256:${"a".repeat(64)}`;

type HasProviderProof<T> = "providerProof" extends keyof T ? true : false;

const appleLinkStartHasNoProviderProof: HasProviderProof<AppleLinkAuthorizationInput> = false;
const appleLinkCallbackHasNoProviderProof: HasProviderProof<AppleLinkInput> = false;

function sha256ForTest(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value, "utf8").digest());
}

class MemoryTransactionStore implements OAuthTransactionStore {
  readonly records = new Map<string, OAuthTransactionRecord>();

  async save(record: OAuthTransactionRecord): Promise<void> {
    assert.equal(this.records.has(record.oauth_transaction_id), false);
    this.records.set(record.oauth_transaction_id, record);
  }

  async consume(transactionId: string): Promise<OAuthTransactionRecord | undefined> {
    const record = this.records.get(transactionId);
    this.records.delete(transactionId);
    return record;
  }

  async reserveStart(record: OAuthTransactionRecord): Promise<boolean> {
    if (this.records.has(record.oauth_transaction_id)) return false;
    this.records.set(record.oauth_transaction_id, record);
    return true;
  }

  async completeStart(record: OAuthTransactionRecord): Promise<void> {
    assert.equal(this.records.has(record.oauth_transaction_id), true);
    this.records.set(record.oauth_transaction_id, record);
  }

  async loadStart(transactionId: string): Promise<OAuthTransactionRecord | undefined> {
    return this.records.get(transactionId);
  }
}

const protector: TransactionProtector = {
  async encrypt(plaintext) {
    const protectedBytes = Uint8Array.from([...plaintext].reverse(), (value) => value ^ 0xa5);
    return Uint8Array.from(Buffer.concat([
      createHash("sha256").update(plaintext).digest(),
      protectedBytes,
    ]));
  },
  async decrypt(ciphertext) {
    const expectedDigest = ciphertext.slice(0, 32);
    const plaintext = Uint8Array.from([...ciphertext.slice(32)].map((value) => value ^ 0xa5).reverse());
    if (!Buffer.from(createHash("sha256").update(plaintext).digest()).equals(Buffer.from(expectedDigest))) {
      throw new Error("ciphertext integrity failure");
    }
    return plaintext;
  },
};

function user(provider: "email" | "apple" = "email", id = "provider-subject-1"): unknown {
  let unknownGetterCalls = 0;
  const value = Object.defineProperties({}, {
    id: { value: id, enumerable: true },
    email: { value: "User@Example.Test", enumerable: true },
    email_confirmed_at: { value: "2026-08-01T00:00:00.000Z", enumerable: true },
    app_metadata: { value: Object.freeze({ provider }), enumerable: true },
    access_token: {
      enumerable: true,
      get() {
        unknownGetterCalls += 1;
        throw new Error("must not execute");
      },
    },
  });
  return value;
}

interface Harness {
  readonly provider: SupabaseAuthProvider;
  readonly store: MemoryTransactionStore;
  readonly clientCalls: Array<{ readonly url: string; readonly key: string; readonly options: unknown }>;
  readonly methodCalls: Array<{ readonly name: string; readonly arguments: readonly unknown[] }>;
  readonly exchangedVerifiers: string[];
}

function createHarness(input: {
  readonly now?: () => Date;
  readonly transactionProtector?: TransactionProtector;
  readonly adminUpdateError?: unknown;
  readonly adminUpdateData?: unknown;
  readonly exchangedProviderSubject?: string;
} = {}): Harness {
  const store = new MemoryTransactionStore();
  const clientCalls: Harness["clientCalls"] = [];
  const methodCalls: Harness["methodCalls"] = [];
  const exchangedVerifiers: string[] = [];
  let randomCall = 0;
  const factory: SupabaseClientFactory = (url, key, options) => {
    clientCalls.push({ url, key, options });
    const authOptions = (options as { readonly auth: {
      readonly storage: {
        getItem(key: string): Promise<string | null> | string | null;
        setItem(key: string, value: string): Promise<void> | void;
      };
      readonly storageKey: string;
    } }).auth;
    const begin = async (name: "signInWithOAuth" | "linkIdentity", request: unknown) => {
      methodCalls.push({ name, arguments: [request] });
      const flowId = name === "signInWithOAuth" ? "signinflow01" : "linkflow0001";
      await authOptions.storage.setItem(
        `${authOptions.storageKey}-flow-${flowId}-code-verifier`,
        JSON.stringify(pkceVerifier),
      );
      const authorizationUrl = new URL("https://example.supabase.co/auth/v1/authorize");
      const requestOptions = (request as { readonly options: { readonly queryParams: {
        readonly nonce?: unknown;
      } } }).options;
      if (typeof requestOptions.queryParams.nonce === "string") {
        authorizationUrl.searchParams.set("nonce", requestOptions.queryParams.nonce);
      }
      return { data: { provider: "apple", url: authorizationUrl.toString(), flowId }, error: null };
    };
    const auth = {
      signUp: async (request: unknown) => {
        methodCalls.push({ name: "signUp", arguments: [request] });
        return { data: { user: user(), session: null }, error: null };
      },
      verifyOtp: async (request: unknown) => {
        methodCalls.push({ name: "verifyOtp", arguments: [request] });
        return { data: { user: user(), session: { access_token: providerAccessToken, refresh_token: providerRefreshToken } }, error: null };
      },
      signInWithPassword: async (request: unknown) => {
        methodCalls.push({ name: "signInWithPassword", arguments: [request] });
        await authOptions.storage.setItem(authOptions.storageKey, JSON.stringify({
          access_token: providerAccessToken,
          refresh_token: providerRefreshToken,
        }));
        return {
          data: {
            user: user(),
            session: { access_token: providerAccessToken, refresh_token: providerRefreshToken },
          },
          error: null,
        };
      },
      getUser: async (jwt?: string) => {
        methodCalls.push({ name: "getUser", arguments: [jwt] });
        return { data: { user: user() }, error: null };
      },
      setSession: async (session: unknown) => {
        methodCalls.push({ name: "setSession", arguments: [session] });
        await authOptions.storage.setItem(authOptions.storageKey, JSON.stringify(session));
        return {
          data: {
            user: user(),
            session: { access_token: currentJwt, refresh_token: "internal-non-secret-placeholder" },
          },
          error: null,
        };
      },
      signOut: async (request: unknown) => {
        methodCalls.push({ name: "signOut", arguments: [request] });
        return { error: null };
      },
      resetPasswordForEmail: async (...arguments_: unknown[]) => {
        methodCalls.push({ name: "resetPasswordForEmail", arguments: arguments_ });
        await authOptions.storage.setItem(
          `${authOptions.storageKey}-flow-resetflow01-code-verifier`,
          JSON.stringify(recoveryVerifier),
        );
        await authOptions.storage.setItem(
          `${authOptions.storageKey}-flows-code-verifier`,
          JSON.stringify(["resetflow01"]),
        );
        return { data: {}, error: null };
      },
      signInWithOAuth: async (request: unknown) => begin("signInWithOAuth", request),
      linkIdentity: async (request: unknown) => begin("linkIdentity", request),
      exchangeCodeForSession: async (code: string, exchangeOptions: unknown) => {
        methodCalls.push({ name: "exchangeCodeForSession", arguments: [code, exchangeOptions] });
        const flowId = (exchangeOptions as { readonly flowId: string }).flowId;
        const stored = await authOptions.storage.getItem(
          `${authOptions.storageKey}-flow-${flowId}-code-verifier`,
        );
        exchangedVerifiers.push(JSON.parse(stored ?? "null") as string);
        await authOptions.storage.setItem(authOptions.storageKey, JSON.stringify({
          access_token: providerAccessToken,
          refresh_token: providerRefreshToken,
        }));
        return {
          data: {
            user: user("apple", input.exchangedProviderSubject ?? "provider-subject-1"),
            session: { access_token: providerAccessToken, refresh_token: providerRefreshToken },
          },
          error: null,
        };
      },
      updateUser: async (attributes: unknown) => {
        methodCalls.push({ name: "updateUser", arguments: [attributes] });
        return { data: { user: user("email") }, error: null };
      },
      admin: {
        updateUserById: async (...arguments_: unknown[]) => {
          methodCalls.push({ name: "updateUserById", arguments: arguments_ });
          return input.adminUpdateError === undefined
            ? { data: input.adminUpdateData ?? { user: user("email") }, error: null }
            : { data: null, error: input.adminUpdateError };
        },
        deleteUser: async (...arguments_: unknown[]) => {
          methodCalls.push({ name: "deleteUser", arguments: arguments_ });
          return { data: {}, error: null };
        },
      },
    };
    return { auth } as never;
  };

  return {
    store,
    clientCalls,
    methodCalls,
    exchangedVerifiers,
    provider: new SupabaseAuthProvider({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "publishable-key-not-secret",
      serviceRoleKey,
      appleRedirectUris: [callbackUri, nativeCallbackUri],
      passwordResetRedirectUri: passwordResetCallbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
      transactionStore: store,
      transactionProtector: input.transactionProtector ?? protector,
      createClient: factory,
      nativeLinkAuthorization: {
        async authorize(request) {
          methodCalls.push({ name: "nativeAuthorize", arguments: [request] });
          return "https://appleid.apple.com/auth/authorize?state=4fd0445c-badc-4bdb-bc0f-7af9b821c7ec";
        },
      },
      now: input.now ?? (() => new Date(fixedNow)),
      randomBytes: (length) => {
        randomCall += 1;
        return Uint8Array.from({ length }, (_, index) => (index + randomCall) % 256);
      },
    }),
  };
}

async function expectFailure(
  action: () => Promise<unknown>,
  code: ProviderFailure["code"],
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert(error instanceof ProviderFailure);
    assert.equal(error.code, code);
    assert.deepEqual(error.toJSON(), { code });
    return true;
  });
}

function callbackFromStart(
  start: { readonly transaction_id: string; readonly authorization_url: string },
  clientKind?: "web",
): Extract<AppleAuthorizationCallback, { readonly client_kind: "web" }>;
function callbackFromStart(
  start: { readonly transaction_id: string; readonly authorization_url: string },
  clientKind: "iphone" | "macos",
): Extract<AppleAuthorizationCallback, { readonly client_kind: "iphone" | "macos" }>;
function callbackFromStart(
  start: { readonly transaction_id: string; readonly authorization_url: string },
  clientKind: ProviderClientKind = "web",
): AppleAuthorizationCallback {
  const base = {
    schema_version: 1 as const,
    idempotency_key: "idem_apple_callback",
    payload_hash: payloadHash,
    transaction_id: start.transaction_id,
    authorization_code: "one-time-authorization-code",
    state: new URL(start.authorization_url).searchParams.get("state") ?? start.transaction_id,
    client_kind: clientKind,
  };
  return (clientKind === "web" ? base : {
    ...base,
    nonce: nativeNonce,
    pkce_code_verifier: nativePkceVerifier,
  }) as AppleAuthorizationCallback;
}

test("Supabase email, proof, reset, current-session revoke, and deletion use fresh bounded clients", async () => {
  const harness = createHarness();
  const outputs = [
    await harness.provider.signUpEmail(credential),
    await harness.provider.signInEmail(credential),
    await harness.provider.verifyCurrentSubject(providerProof),
    await harness.provider.reauthenticatePassword(credential),
    await harness.provider.beginPasswordReset("USER@EXAMPLE.TEST"),
    await harness.provider.revokeCurrentProviderSession(providerProof),
    await harness.provider.deleteProviderSubject("provider-subject-1"),
  ];

  assert.equal(harness.clientCalls.length, 7);
  for (const call of harness.clientCalls) {
    const auth = (call.options as { readonly auth: Record<string, unknown> & {
      readonly storage: { getItem(key: string): Promise<string | null> };
      readonly storageKey: string;
    } }).auth;
    assert.equal(auth.autoRefreshToken, false);
    assert.equal(auth.persistSession, false);
    assert.equal(auth.detectSessionInUrl, false);
    assert.equal(await auth.storage.getItem(auth.storageKey), null);
  }
  assert.deepEqual(outputs[0], { kind: "verification_pending" });
  for (const output of outputs.slice(1, 4)) {
    assert.deepEqual(output, {
      provider: "supabase",
      providerSubject: "provider-subject-1",
      identityKind: "email_password",
      normalizedEmail: "user@example.test",
      verifiedAt: "2026-08-01T00:00:00.000Z",
    });
  }
  assert.equal(JSON.stringify(outputs).includes(providerAccessToken), false);
  assert.equal(JSON.stringify(outputs).includes(providerRefreshToken), false);
  assert.deepEqual(
    harness.methodCalls.filter((call) => call.name === "signOut").map((call) => call.arguments[0]),
    [{ scope: "local" }, { scope: "local" }, { scope: "global" }],
  );
  const revokeSetSession = harness.methodCalls.filter((call) => call.name === "setSession").at(-1);
  assert.equal((revokeSetSession?.arguments[0] as { readonly access_token: string }).access_token, currentJwt);
  assert.equal(JSON.stringify(harness.store.records).includes(currentJwt), false);
  const resetArguments = harness.methodCalls.find((call) => call.name === "resetPasswordForEmail")?.arguments;
  assert.equal(resetArguments?.[0], "user@example.test");
  assert.equal((resetArguments?.[1] as { readonly redirectTo: string }).redirectTo, passwordResetCallbackUri);
  assert.deepEqual(Object.keys(outputs[4] as object).sort(), ["expires_at", "state", "transaction_id"]);
  assert.equal(Object.isFrozen(outputs[4]), true);
  assert.deepEqual(harness.methodCalls.find((call) => call.name === "deleteUser")?.arguments, [
    "provider-subject-1",
    false,
  ]);
  assert.equal(harness.clientCalls.at(-1)?.key, serviceRoleKey);
});

test("Supabase signup uses the exact email callback and verification exchanges only a token hash", async () => {
  const harness = createHarness();
  await harness.provider.signUpEmail(credential);
  const provider = harness.provider as unknown as { verifyEmail?: (input: { verificationCode: string }) => Promise<unknown> };
  assert.equal(typeof provider.verifyEmail, "function");
  const verified = await provider.verifyEmail!({ verificationCode: "opaque-email-token-hash" });
  assert.deepEqual(verified, {
    provider: "supabase",
    providerSubject: "provider-subject-1",
    identityKind: "email_password",
    normalizedEmail: "user@example.test",
    verifiedAt: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(harness.methodCalls.find((call) => call.name === "verifyOtp")?.arguments, [
    { token_hash: "opaque-email-token-hash", type: "email" },
  ]);
  const signUp = harness.methodCalls.find((call) => call.name === "signUp")?.arguments[0] as { options?: { emailRedirectTo?: unknown } };
  assert.equal(signUp.options?.emailRedirectTo, "https://identity.example.test/auth/v1/email/verification");
  assert.equal(JSON.stringify(harness.methodCalls).includes(providerAccessToken), false);
});

test("Supabase provider-subject deletion is idempotent without reading a provider body", async () => {
  let bodyGetterCalls = 0;
  const missing = Object.defineProperties({}, {
    status: { value: 404, enumerable: true },
    code: { value: "user_not_found", enumerable: true },
    message: {
      enumerable: true,
      get() {
        bodyGetterCalls += 1;
        return "private provider body";
      },
    },
  });
  const factory: SupabaseClientFactory = () => ({
    auth: {
      admin: {
        deleteUser: async () => ({ data: null, error: missing }),
      },
    },
  } as never);
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: factory,
  });

  assert.equal(await provider.deleteProviderSubject("already-deleted-subject"), undefined);
  assert.equal(bodyGetterCalls, 0);
});

test("Supabase copies only allowlisted own user facts and validates confirmed email", async () => {
  const harness = createHarness();
  const result = await harness.provider.signInEmail(credential);

  assert.deepEqual(Object.keys(result).sort(), [
    "identityKind",
    "normalizedEmail",
    "provider",
    "providerSubject",
    "verifiedAt",
  ]);
  assert.equal(Object.isFrozen(result), true);

  const unverifiedFactory: SupabaseClientFactory = () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: { id: "subject", email: "user@example.test", email_confirmed_at: null } },
        error: null,
      }),
      signOut: async () => ({ error: null }),
    },
  } as never);
  const unverified = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: unverifiedFactory,
  });
  await expectFailure(() => unverified.signInEmail(credential), "AUTH_EMAIL_UNVERIFIED");
});

test("Supabase maps only status/code and never reads or exposes provider bodies", async () => {
  let messageGetterCalls = 0;
  const providerBodySentinel = ["private", "provider", "body"].join("-");
  const providerError = Object.defineProperties({}, {
    status: { value: 429, enumerable: true },
    code: { value: "over_request_rate_limit", enumerable: true },
    message: {
      enumerable: true,
      get() {
        messageGetterCalls += 1;
        return providerBodySentinel;
      },
    },
  });
  const factory: SupabaseClientFactory = () => ({
    auth: {
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: providerError }),
    },
  } as never);
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: factory,
  });

  await assert.rejects(() => provider.signInEmail(credential), (error: unknown) => {
    assert(error instanceof ProviderFailure);
    assert.equal(error.code, "AUTH_RATE_LIMITED");
    assert.equal(JSON.stringify(error).includes(providerBodySentinel), false);
    assert.equal(String(error).includes(providerBodySentinel), false);
    return true;
  });
  assert.equal(messageGetterCalls, 0);
});

test("provider failures map to the six-code vocabulary without message matching", () => {
  const cases = [
    [{ status: 401 }, undefined, "AUTH_INVALID"],
    [{ code: "email_not_confirmed" }, undefined, "AUTH_EMAIL_UNVERIFIED"],
    [{ status: 429 }, undefined, "AUTH_RATE_LIMITED"],
    [{ status: 503 }, undefined, "AUTH_PROVIDER_UNAVAILABLE"],
    [{ status: 400 }, "AUTH_CALLBACK_INVALID", "AUTH_CALLBACK_INVALID"],
    [{ code: "identity_already_exists" }, undefined, "AUTH_CONFLICT"],
  ] as const;

  assert.deepEqual(cases.map(([error, fallback]) => mapProviderFailure(error, fallback).code),
    cases.map(([, , code]) => code));
});

test("Supabase error mapping does not execute proxy property or prototype traps", async () => {
  let descriptorTrapCalls = 0;
  let ownKeysTrapCalls = 0;
  let prototypeTrapCalls = 0;
  let getTrapCalls = 0;
  const providerError = new Proxy({ status: 429, code: "over_request_rate_limit" }, {
    getOwnPropertyDescriptor() {
      descriptorTrapCalls += 1;
      throw new Error("descriptor access is forbidden");
    },
    ownKeys() {
      ownKeysTrapCalls += 1;
      throw new Error("ownKeys access is forbidden");
    },
    get() {
      getTrapCalls += 1;
      throw new Error("property access is forbidden");
    },
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("prototype access is forbidden");
    },
  });
  const factory: SupabaseClientFactory = () => ({
    auth: {
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: providerError }),
    },
  } as never);
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: factory,
  });

  await expectFailure(() => provider.signInEmail(credential), "AUTH_PROVIDER_UNAVAILABLE");
  assert.equal(descriptorTrapCalls, 0);
  assert.equal(ownKeysTrapCalls, 0);
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(getTrapCalls, 0);
});

test("Supabase rejects Proxy config, store, and result inputs without invoking structural traps", async () => {
  const calls = { descriptor: 0, keys: 0, get: 0, prototype: 0 };
  const getKeys: PropertyKey[] = [];
  const traps = {
    getOwnPropertyDescriptor() { calls.descriptor += 1; throw new Error("no descriptor"); },
    ownKeys() { calls.keys += 1; throw new Error("no keys"); },
    get(_target: object, key: PropertyKey) { calls.get += 1; getKeys.push(key); throw new Error("no get"); },
    getPrototypeOf() { calls.prototype += 1; throw new Error("no prototype"); },
  };
  const assertStableConstructorFailure = (options: unknown) => {
    assert.throws(
      () => new SupabaseAuthProvider(options as never),
      (error: unknown) => error instanceof ProviderFailure && error.code === "AUTH_PROVIDER_UNAVAILABLE",
    );
    assert.deepEqual(calls, { descriptor: 0, keys: 0, get: 0, prototype: 0 });
  };

  assertStableConstructorFailure(new Proxy({}, traps));
  assertStableConstructorFailure({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new Proxy({}, traps),
    transactionProtector: protector,
  });

  const revokedRedirects = Proxy.revocable([callbackUri], {});
  revokedRedirects.revoke();
  assertStableConstructorFailure({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: revokedRedirects.proxy,
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
  });

  const resultProxy = new Proxy({}, traps);
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: () => ({
      auth: { signInWithPassword: async () => ({ data: resultProxy, error: null }) },
    } as never),
  });
  await expectFailure(() => provider.signInEmail(credential), "AUTH_PROVIDER_UNAVAILABLE");
  assert.deepEqual({ calls, getKeys }, {
    calls: { descriptor: 0, keys: 0, get: 0, prototype: 0 },
    getKeys: [],
  });
});

test("Supabase bounds client-construction failures without inspecting error prototypes", async () => {
  let prototypeTrapCalls = 0;
  const constructionError = new Proxy({ status: 503 }, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("prototype inspection is forbidden");
    },
  });
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: () => {
      throw constructionError;
    },
  });

  await expectFailure(() => provider.signInEmail(credential), "AUTH_PROVIDER_UNAVAILABLE");
  assert.equal(prototypeTrapCalls, 0);
});

test("Supabase bounds synchronous provider-port failures", async () => {
  const synchronousError = { status: 503 };
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: () => ({
      auth: {
        signInWithPassword() {
          throw synchronousError;
        },
      },
    } as never),
  });

  await expectFailure(() => provider.signInEmail(credential), "AUTH_PROVIDER_UNAVAILABLE");
});

test("Supabase fails closed without invoking accessor-shaped result fields", async () => {
  let accessorCalls = 0;
  const result = Object.defineProperties({}, {
    error: {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return null;
      },
    },
    data: {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return { user: user(), session: {} };
      },
    },
  });
  const factory: SupabaseClientFactory = () => ({
    auth: { signInWithPassword: async () => result },
  } as never);
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: factory,
  });

  await expectFailure(() => provider.signInEmail(credential), "AUTH_PROVIDER_UNAVAILABLE");
  assert.equal(accessorCalls, 0);
});

function webAppleStart() {
  return {
    schema_version: 1 as const,
    idempotency_key: "idem_apple_start",
    payload_hash: payloadHash,
    client_kind: "web" as const,
    redirect_uri: callbackUri,
  };
}

function nativeAppleStart(client_kind: "iphone" | "macos" = "iphone") {
  return {
    schema_version: 1 as const,
    idempotency_key: "idem_native_apple_start",
    payload_hash: payloadHash,
    client_kind,
    redirect_uri: nativeCallbackUri,
    nonce: nativeNonce,
    pkce_code_challenge: nativePkceChallenge,
    pkce_code_challenge_method: "S256" as const,
  };
}

test("Supabase provider starts replay one idempotent effect", async () => {
  const harness = createHarness();
  const appleFirst = await harness.provider.beginApple(webAppleStart());
  const appleReplay = await harness.provider.beginApple(webAppleStart());
  assert.deepEqual(appleReplay, appleFirst);
  assert.equal(harness.methodCalls.filter(({ name }) => name === "signInWithOAuth").length, 1);

  const reset = {
    email: "USER@EXAMPLE.TEST",
    idempotencyKey: "idem_password_reset",
    payloadHash,
  };
  const resetFirst = await harness.provider.beginPasswordReset(reset);
  const resetReplay = await harness.provider.beginPasswordReset(reset);
  assert.deepEqual(resetReplay, resetFirst);
  assert.equal(harness.methodCalls.filter(({ name }) => name === "resetPasswordForEmail").length, 1);

  const linkHarness = createHarness();
  const linkInput = { ...webAppleStart(), idempotency_key: "idem_apple_link_start", authenticatedActorId: "actor-1", ...credential };
  const linkFirst = await linkHarness.provider.reauthenticateAndBeginAppleLink(linkInput);
  const linkReplay = await linkHarness.provider.reauthenticateAndBeginAppleLink(linkInput);
  assert.deepEqual(linkReplay, linkFirst);
  assert.equal(linkHarness.methodCalls.filter(({ name }) => name === "signInWithPassword").length, 1);
  assert.equal(linkHarness.methodCalls.filter(({ name }) => name === "linkIdentity").length, 1);

  await expectFailure(() => harness.provider.beginApple({
    ...webAppleStart(), payload_hash: `sha256:${"b".repeat(64)}`,
  }), "AUTH_CONFLICT");

  const concurrent = createHarness();
  const attempts = await Promise.allSettled([
    concurrent.provider.beginApple(webAppleStart()),
    concurrent.provider.beginApple(webAppleStart()),
  ]);
  assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(concurrent.methodCalls.filter(({ name }) => name === "signInWithOAuth").length, 1);
  const completed = attempts.find((attempt): attempt is PromiseFulfilledResult<AppleAuthorizationStart> => attempt.status === "fulfilled")!.value;
  assert.deepEqual(await concurrent.provider.beginApple(webAppleStart()), completed);
});

test("installed Supabase 2.112.2 default factory captures SDK PKCE state offline", async () => {
  const runtimePackage = createRequire(import.meta.url)("@supabase/supabase-js/package.json") as {
    readonly version?: unknown;
  };
  assert.equal(runtimePackage.version, "2.112.2");
  const store = new MemoryTransactionStore();
  let randomSeed = 0;
  const provider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co",
    publishableKey: "publishable-key-not-secret",
    serviceRoleKey,
    appleRedirectUris: [callbackUri],
    passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: store,
    transactionProtector: protector,
    now: () => new Date(fixedNow),
    randomBytes: (length) => {
      randomSeed += 1;
      return Uint8Array.from({ length }, (_, index) => (index + randomSeed) % 256);
    },
  });

  const start = await provider.beginApple(webAppleStart());
  const authorizationUrl = new URL(start.authorization_url);
  assert.equal(authorizationUrl.origin, "https://example.supabase.co");
  assert.equal(authorizationUrl.pathname, "/auth/v1/authorize");
  assert.equal(authorizationUrl.searchParams.get("state"), start.transaction_id);
  assert.equal(authorizationUrl.searchParams.get("redirect_to"), callbackUri);
  assert.match(authorizationUrl.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  const transaction = store.records.get(start.transaction_id);
  assert(transaction !== undefined);
  const envelope = JSON.parse(new TextDecoder().decode(
    await protector.decrypt(transaction.pkce_verifier_ciphertext),
  )) as { readonly kind?: unknown; readonly flowId?: unknown; readonly verifier?: unknown };
  assert.equal(envelope.kind, "web");
  assert.match(String(envelope.flowId), /^[A-Za-z0-9_-]{8,64}$/u);
  assert.match(String(envelope.verifier), /^[A-Za-z0-9._~-]{43,128}$/u);
});

test("Supabase Apple Web uses the released request/callback shape and trusted provider evidence", async () => {
  const harness = createHarness();
  const start = await harness.provider.beginApple(webAppleStart());
  const transaction = harness.store.records.get(start.transaction_id);

  assert(transaction !== undefined);
  assert.deepEqual(Object.keys(transaction).sort(), [
    "actor_id", "client_kind", "expires_at", "flow_kind", "nonce_digest",
    "oauth_transaction_id", "pkce_verifier_ciphertext", "provider", "redirect_uri",
    "state_digest", "status",
  ]);
  assert.equal(transaction.flow_kind, "apple_sign_in");
  assert.equal(transaction.redirect_uri, callbackUri);
  assert.deepEqual(transaction.state_digest, sha256ForTest(start.transaction_id));
  assert.equal(transaction.state_digest.byteLength, 32);
  assert.equal(transaction.nonce_digest.byteLength, 32);
  assert.equal(JSON.stringify(transaction).includes(pkceVerifier), false);
  assert.deepEqual(Object.keys(start).sort(), ["authorization_url", "expires_at", "transaction_id"]);
  const request = harness.methodCalls.find((call) => call.name === "signInWithOAuth")?.arguments[0] as {
    readonly options: { readonly queryParams: Record<string, unknown> };
  };
  assert.equal(Object.hasOwn(request.options.queryParams, "state"), false);
  assert.equal(new URL(start.authorization_url).searchParams.get("state"), start.transaction_id);
  assert.equal(new URL(start.authorization_url).searchParams.get("redirect_to"), callbackUri);
  const callback = callbackFromStart(start);
  assert.equal("nonce" in callback, false);
  assert.equal((await harness.provider.completeApple(callback)).identityKind, "apple");
  assert.deepEqual(harness.exchangedVerifiers, [pkceVerifier]);
  assert.equal(harness.store.records.has(start.transaction_id), false);
  await expectFailure(() => harness.provider.completeApple(callback), "AUTH_CALLBACK_INVALID");
});

test("Supabase Apple native binds caller nonce and exact S256 challenge before exchanging its verifier", async () => {
  const harness = createHarness();
  const start = await harness.provider.beginApple(nativeAppleStart());
  const url = new URL(start.authorization_url);
  assert.equal(url.searchParams.get("nonce"), nativeNonce);
  assert.equal(url.searchParams.get("code_challenge"), nativePkceChallenge);
  assert.equal(url.searchParams.get("code_challenge_method")?.toUpperCase(), "S256");
  const request = harness.methodCalls.find((call) => call.name === "signInWithOAuth")?.arguments[0] as {
    readonly options: { readonly queryParams: Record<string, unknown> };
  };
  assert.equal(Object.hasOwn(request.options.queryParams, "state"), false);
  assert.equal(url.searchParams.get("state"), start.transaction_id);
  assert.equal(url.searchParams.get("redirect_to"), nativeCallbackUri);

  const subject = await harness.provider.completeApple(callbackFromStart(start, "iphone"));
  assert.equal(subject.identityKind, "apple");
  assert.deepEqual(harness.exchangedVerifiers, [nativePkceVerifier]);

  const wrong = createHarness();
  const wrongStart = await wrong.provider.beginApple(nativeAppleStart());
  await expectFailure(() => wrong.provider.completeApple({
    ...callbackFromStart(wrongStart, "iphone"),
    pkce_code_verifier: "x".repeat(43),
  }), "AUTH_CALLBACK_INVALID");
  assert.equal(wrong.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);
});

test("Supabase Apple rejects Web/native cross-shapes and mismatched state/client before exchange", async () => {
  const web = createHarness();
  await expectFailure(() => web.provider.beginApple({ ...webAppleStart(), nonce: nativeNonce } as never), "AUTH_CALLBACK_INVALID");
  await expectFailure(() => web.provider.beginApple({ ...nativeAppleStart(), pkce_code_challenge: "x".repeat(42) } as never), "AUTH_CALLBACK_INVALID");

  for (const mutate of [
    (callback: AppleAuthorizationCallback) => ({ ...callback, state: "changed-state" }),
    (callback: AppleAuthorizationCallback) => ({ ...callback, client_kind: "iphone" as const }),
    (callback: AppleAuthorizationCallback) => ({ ...callback, nonce: nativeNonce }),
  ]) {
    const isolated = createHarness();
    const isolatedStart = await isolated.provider.beginApple(webAppleStart());
    await expectFailure(() => isolated.provider.completeApple(mutate(callbackFromStart(isolatedStart)) as never), "AUTH_CALLBACK_INVALID");
    assert.equal(isolated.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);
  }
});

test("Supabase Apple callback rejects expired, tampered, accessor, and Proxy transaction records without traps", async () => {
  let now = new Date(fixedNow);
  const expired = createHarness({ now: () => new Date(now) });
  const expiredStart = await expired.provider.beginApple(webAppleStart());
  now = new Date(fixedNow.getTime() + 5 * 60 * 1_000);
  await expectFailure(() => expired.provider.completeApple(callbackFromStart(expiredStart)), "AUTH_CALLBACK_INVALID");

  const tampered = createHarness();
  const tamperedStart = await tampered.provider.beginApple(webAppleStart());
  const transaction = tampered.store.records.get(tamperedStart.transaction_id);
  assert(transaction !== undefined);
  transaction.pkce_verifier_ciphertext[0] = (transaction.pkce_verifier_ciphertext[0] ?? 0) ^ 1;
  await expectFailure(() => tampered.provider.completeApple(callbackFromStart(tamperedStart)), "AUTH_CALLBACK_INVALID");

  let accessorCalls = 0;
  const accessorRecord = Object.defineProperties({}, {
    oauth_transaction_id: { value: "oauth_accessor", enumerable: true },
    provider: { value: "supabase", enumerable: true },
    flow_kind: { value: "apple_sign_in", enumerable: true },
    actor_id: {
      enumerable: true,
      get() {
        accessorCalls += 1;
        throw new Error("transaction accessor must not execute");
      },
    },
    client_kind: { value: "web", enumerable: true },
    state_digest: { value: sha256ForTest("opaque-state"), enumerable: true },
    nonce_digest: { value: sha256ForTest("opaque-nonce"), enumerable: true },
    pkce_verifier_ciphertext: { value: Uint8Array.of(1), enumerable: true },
    redirect_uri: { value: callbackUri, enumerable: true },
    status: { value: "pending", enumerable: true },
    expires_at: { value: new Date(fixedNow.getTime() + 60_000).toISOString(), enumerable: true },
  }) as OAuthTransactionRecord;
  const accessorProvider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co", publishableKey: "publishable-key-not-secret",
    serviceRoleKey, appleRedirectUris: [callbackUri], passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: { async save() {}, async consume() { return accessorRecord; } },
    transactionProtector: protector, createClient: () => ({ auth: {} }) as never,
    now: () => new Date(fixedNow),
  });
  await expectFailure(() => accessorProvider.completeApple({
    ...callbackFromStart({ transaction_id: "oauth_accessor", authorization_url: "https://example.test/?state=opaque-state" }),
  }), "AUTH_CALLBACK_INVALID");
  assert.equal(accessorCalls, 0);

  const validRecord = {
    oauth_transaction_id: "oauth_malformed_bytes",
    provider: "supabase" as const,
    flow_kind: "apple_sign_in" as const,
    actor_id: null,
    client_kind: "web" as const,
    state_digest: sha256ForTest("opaque-state"),
    nonce_digest: sha256ForTest("opaque-nonce"),
    pkce_verifier_ciphertext: Uint8Array.of(1),
    redirect_uri: callbackUri,
    status: "pending" as const,
    expires_at: new Date(fixedNow.getTime() + 60_000).toISOString(),
  };
  for (const malformedRecord of [
    { ...validRecord, state_digest: new DataView(new ArrayBuffer(32)) as never },
    { ...validRecord, state_digest: new Uint8Array(31) },
    { ...validRecord, pkce_verifier_ciphertext: new Uint8Array(65_537) },
  ]) {
    let clientCreations = 0;
    const malformedProvider = new SupabaseAuthProvider({
      supabaseUrl: "https://example.supabase.co", publishableKey: "publishable-key-not-secret",
      serviceRoleKey, appleRedirectUris: [callbackUri], passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
      transactionStore: { async save() {}, async consume() { return malformedRecord; } },
      transactionProtector: protector,
      createClient: () => { clientCreations += 1; return { auth: {} } as never; },
      now: () => new Date(fixedNow),
    });
    await expectFailure(() => malformedProvider.completeApple({
      ...callbackFromStart({
        transaction_id: "oauth_malformed_bytes",
        authorization_url: "https://example.test/?state=opaque-state",
      }),
    }), "AUTH_CALLBACK_INVALID");
    assert.equal(clientCreations, 0);
  }

  let descriptorTrapCalls = 0;
  const proxyStore: OAuthTransactionStore = {
    async save() {},
    async consume() {
      return new Proxy({}, {
        getOwnPropertyDescriptor() {
          descriptorTrapCalls += 1;
          throw new Error("descriptor trap must not execute");
        },
      }) as OAuthTransactionRecord;
    },
  };
  const proxyProvider = new SupabaseAuthProvider({
    supabaseUrl: "https://example.supabase.co", publishableKey: "publishable-key-not-secret",
    serviceRoleKey, appleRedirectUris: [callbackUri], passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
    transactionStore: proxyStore, transactionProtector: protector, createClient: () => ({ auth: {} }) as never,
  });
  await expectFailure(() => proxyProvider.completeApple({
    ...callbackFromStart({ transaction_id: "oauth_proxy", authorization_url: "https://example.test/?state=opaque-state" }),
  }), "AUTH_CALLBACK_INVALID");
  assert.equal(descriptorTrapCalls, 0);
});

test("Supabase Apple link reauthenticates and starts on one transient client without provider proof", async () => {
  const harness = createHarness();
  const start = await harness.provider.reauthenticateAndBeginAppleLink({
    ...webAppleStart(), authenticatedActorId: "actor-1", ...credential,
  });
  assert.equal(harness.clientCalls.length, 1);
  assert.equal(harness.store.records.get(start.transaction_id)?.flow_kind, "apple_link");
  const result = await harness.provider.linkApple({
    ...callbackFromStart(start), authenticatedActorId: "actor-1",
  });
  assert.equal(result.identityKind, "apple");
  assert.equal(JSON.stringify(result).includes(currentJwt), false);
  assert.equal(JSON.stringify(result).includes(credential.password), false);
  assert.equal(appleLinkStartHasNoProviderProof, false);
  assert.equal(appleLinkCallbackHasNoProviderProof, false);
  assert.deepEqual(
    harness.methodCalls.slice(0, 3).map((call) => call.name),
    ["signInWithPassword", "linkIdentity", "signOut"],
  );
  assert.equal(harness.methodCalls.some((call) => call.name === "setSession"), false);
  assert.equal(harness.methodCalls.filter((call) => call.name === "linkIdentity").length, 1);
  const linkRequest = harness.methodCalls.find((call) => call.name === "linkIdentity")?.arguments[0] as {
    readonly options: { readonly queryParams: Record<string, unknown> };
  };
  assert.equal(Object.hasOwn(linkRequest.options.queryParams, "state"), false);

  const native = createHarness();
  const nativeStart = await native.provider.reauthenticateAndBeginAppleLink({
    ...nativeAppleStart(), authenticatedActorId: "actor-1", ...credential,
  });
  const nativeAuthorizationUrl = new URL(nativeStart.authorization_url);
  assert.equal(nativeAuthorizationUrl.searchParams.get("state"), "4fd0445c-badc-4bdb-bc0f-7af9b821c7ec");
  assert.notEqual(nativeAuthorizationUrl.searchParams.get("state"), nativeStart.transaction_id);
  assert.equal(nativeAuthorizationUrl.searchParams.has("code_challenge"), false);
  const nativeRequest = native.methodCalls.find((call) => call.name === "nativeAuthorize")?.arguments[0] as object;
  assert.equal(Object.hasOwn(nativeRequest, "state"), false);
  assert.equal((await native.provider.linkApple({
    ...callbackFromStart(nativeStart, "iphone"), authenticatedActorId: "actor-1",
  })).identityKind, "apple");

  const changed = createHarness();
  const changedStart = await changed.provider.reauthenticateAndBeginAppleLink({
    ...nativeAppleStart(), authenticatedActorId: "actor-1", ...credential,
  });
  await expectFailure(() => changed.provider.linkApple({
    ...callbackFromStart(changedStart, "iphone"),
    state: `${changedStart.transaction_id}-changed`,
    authenticatedActorId: "actor-1",
  }), "AUTH_CALLBACK_INVALID");
  assert.equal(changed.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);

  const conflicting = createHarness({ exchangedProviderSubject: "different-provider-subject" });
  const conflictingStart = await conflicting.provider.reauthenticateAndBeginAppleLink({
    ...webAppleStart(), authenticatedActorId: "actor-1", ...credential,
  });
  await expectFailure(() => conflicting.provider.linkApple({
    ...callbackFromStart(conflictingStart), authenticatedActorId: "actor-1",
  }), "AUTH_CONFLICT");
});

test("installed Supabase 2.112.2 Apple link uses only its operation-local password session", async () => {
  const runtimePackage = createRequire(import.meta.url)("@supabase/supabase-js/package.json") as {
    readonly version?: unknown;
  };
  assert.equal(runtimePackage.version, "2.112.2");

  const originalFetch = globalThis.fetch;
  const serverRequests: Request[] = [];
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: 4_102_444_800 })).toString("base64url"),
    "unsigned-test-sentinel",
  ].join(".");
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    serverRequests.push(request);
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/auth/v1/token" && requestUrl.searchParams.get("grant_type") === "password") {
      return Response.json({
        access_token: accessToken,
        refresh_token: "installed-sdk-refresh-sentinel",
        expires_in: 3600,
        token_type: "bearer",
        user: {
          id: "provider-subject-1",
          email: "User@Example.Test",
          email_confirmed_at: "2026-08-01T00:00:00.000Z",
          app_metadata: { provider: "email" },
        },
      });
    }
    if (requestUrl.pathname === "/auth/v1/user") {
      return Response.json({ user: {
        id: "provider-subject-1",
        email: "User@Example.Test",
        email_confirmed_at: "2026-08-01T00:00:00.000Z",
        app_metadata: { provider: "email" },
      } });
    }
    if (requestUrl.pathname === "/auth/v1/user/identities/authorize") {
      // supabase/auth@0fb56ca93fcbe033bc2b0309bafbd86ef97aa468:
      // external.go creates a UUID flow state; provider/apple.go ignores AuthCodeURL
      // options and reports RequiresPKCE=false, so caller PKCE remains at GoTrue.
      const authorizationUrl = new URL("https://appleid.apple.com/auth/authorize");
      authorizationUrl.searchParams.set("state", "4fd0445c-badc-4bdb-bc0f-7af9b821c7ec");
      return Response.json({ url: authorizationUrl.toString() });
    }
    if (requestUrl.pathname === "/auth/v1/logout") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ code: "unexpected_test_request" }, { status: 500 });
  };

  try {
    const store = new MemoryTransactionStore();
    const provider = new SupabaseAuthProvider({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "publishable-key-not-secret",
      serviceRoleKey,
      appleRedirectUris: [nativeCallbackUri],
      passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
      transactionStore: store,
      transactionProtector: protector,
      now: () => new Date(fixedNow),
    });

    const start = await provider.reauthenticateAndBeginAppleLink({
      ...nativeAppleStart(),
      authenticatedActorId: "actor-1",
      ...credential,
    });

    const authorizationRequest = serverRequests.find(
      (request) => new URL(request.url).pathname === "/auth/v1/user/identities/authorize",
    );
    assert(authorizationRequest !== undefined);
    const authorizationRequestUrl = new URL(authorizationRequest.url);
    assert.equal(authorizationRequestUrl.searchParams.get("code_challenge"), nativePkceChallenge);
    assert.equal(authorizationRequestUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizationRequestUrl.searchParams.has("state"), false);
    assert.equal(authorizationRequest.headers.get("authorization"), `Bearer ${accessToken}`);
    assert.equal(authorizationRequest.headers.get("apikey"), "publishable-key-not-secret");
    const appleAuthorizationUrl = new URL(start.authorization_url);
    assert.equal(appleAuthorizationUrl.searchParams.get("state"), "4fd0445c-badc-4bdb-bc0f-7af9b821c7ec");
    assert.notEqual(appleAuthorizationUrl.searchParams.get("state"), start.transaction_id);
    assert.equal(appleAuthorizationUrl.searchParams.has("code_challenge"), false);
    assert.equal(appleAuthorizationUrl.searchParams.has("code_challenge_method"), false);
    const transaction = store.records.get(start.transaction_id);
    assert(transaction !== undefined);
    const envelopeText = new TextDecoder().decode(
      await protector.decrypt(transaction.pkce_verifier_ciphertext),
    );
    assert.equal(envelopeText.includes(accessToken), false);
    assert.equal(envelopeText.includes(credential.password), false);
    assert.equal(JSON.stringify(start).includes(accessToken), false);
    assert.equal(JSON.stringify(start).includes(credential.password), false);

    const webStore = new MemoryTransactionStore();
    const webRequestOffset = serverRequests.length;
    const webProvider = new SupabaseAuthProvider({
      supabaseUrl: "https://example.supabase.co",
      publishableKey: "publishable-key-not-secret",
      serviceRoleKey,
      appleRedirectUris: [callbackUri],
      passwordResetRedirectUri: callbackUri, emailVerificationRedirectUri: "https://identity.example.test/auth/v1/email/verification",
      transactionStore: webStore,
      transactionProtector: protector,
      now: () => new Date(fixedNow),
    });
    const webStart = await webProvider.reauthenticateAndBeginAppleLink({
      ...webAppleStart(),
      authenticatedActorId: "actor-1",
      ...credential,
    });
    const webAuthorizationRequest = serverRequests.slice(webRequestOffset).find(
      (request) => new URL(request.url).pathname === "/auth/v1/user/identities/authorize",
    );
    assert(webAuthorizationRequest !== undefined);
    assert.equal(webAuthorizationRequest.headers.get("authorization"), `Bearer ${accessToken}`);
    const webTransaction = webStore.records.get(webStart.transaction_id);
    assert(webTransaction !== undefined);
    const webEnvelope = JSON.parse(new TextDecoder().decode(
      await protector.decrypt(webTransaction.pkce_verifier_ciphertext),
    )) as Record<string, unknown>;
    assert.equal(
      webEnvelope.providerSubjectDigest,
      Buffer.from(sha256ForTest("provider-subject-1")).toString("hex"),
    );
    assert.equal(JSON.stringify(webEnvelope).includes(accessToken), false);
    assert.equal(JSON.stringify(webEnvelope).includes(credential.password), false);
    assert.equal(JSON.stringify(webStart).includes(accessToken), false);
    assert.equal(JSON.stringify(webStart).includes(credential.password), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Supabase password recovery uses the fresh admin atomic password-and-session update path", async () => {
  const harness = createHarness();
  const binding = await harness.provider.beginPasswordReset("USER@EXAMPLE.TEST");
  const resetCall = harness.methodCalls.find((call) => call.name === "resetPasswordForEmail");
  const sentRedirect = (resetCall?.arguments[1] as { redirectTo: string }).redirectTo;
  assert.equal(sentRedirect, passwordResetCallbackUri);
  assert.equal(new URL(sentRedirect).search, "");
  assert.deepEqual(Object.keys(binding).sort(), ["expires_at", "state", "transaction_id"]);
  assert.equal(Object.isFrozen(binding), true);
  assert.match(binding.transaction_id, /^oauth_[A-Za-z0-9_-]+$/u);
  assert.match(binding.state, /^[A-Za-z0-9_-]+$/u);
  assert.equal(binding.expires_at, "2026-08-17T02:05:00.000Z");
  assert.equal(JSON.stringify(binding).includes("user@example.test"), false);
  assert.equal(JSON.stringify(binding).includes(recoveryVerifier), false);
  assert.equal(JSON.stringify(binding).includes(providerAccessToken), false);
  const transaction = harness.store.records.get(binding.transaction_id);
  assert.equal(transaction?.flow_kind, "password_reset");
  assert.equal(transaction?.redirect_uri, passwordResetCallbackUri);
  const result = await harness.provider.completePasswordReset({
    binding,
    authorization_code: "one-time-recovery-code",
    new_password: "new correct horse battery staple",
  });
  assert.equal(result.providerSubject, "provider-subject-1");
  assert.deepEqual(harness.exchangedVerifiers, [recoveryVerifier]);
  assert.deepEqual(harness.methodCalls.find((call) => call.name === "updateUserById")?.arguments,
    ["provider-subject-1", { password: "new correct horse battery staple" }]);
  assert.deepEqual(
    harness.methodCalls.filter((call) => ["exchangeCodeForSession", "updateUserById"].includes(call.name))
      .map((call) => call.name),
    ["exchangeCodeForSession", "updateUserById"],
  );
  assert.equal(harness.methodCalls.some((call) => call.name === "updateUser"), false);
  assert.equal(harness.methodCalls.some((call) => call.name === "signOut"), false);
  assert.equal(harness.clientCalls.at(-1)?.key, serviceRoleKey);
  assert.equal(JSON.stringify(result).includes(providerAccessToken), false);
  assert.equal(harness.store.records.has(binding.transaction_id), false);
  await expectFailure(() => harness.provider.completePasswordReset({
    binding, authorization_code: "one-time-recovery-code", new_password: "another valid password",
  }), "AUTH_CALLBACK_INVALID");

  for (const mutate of [
    (input: typeof binding) => ({ ...input, state: `${input.state}-changed` }),
    (input: typeof binding) => ({ ...input, expires_at: "2026-08-17T02:04:59.000Z" }),
  ]) {
    const isolated = createHarness();
    const isolatedBinding = await isolated.provider.beginPasswordReset("USER@EXAMPLE.TEST");
    const isolatedInput = mutate(isolatedBinding);
    await expectFailure(() => isolated.provider.completePasswordReset({
      binding: isolatedInput,
      authorization_code: "one-time-recovery-code",
      new_password: "another valid password",
    }), "AUTH_CALLBACK_INVALID");
    assert.equal(isolated.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);
  }
});

test("Supabase password recovery returns no subject when the atomic admin update fails", async () => {
  let providerBodyGetterCalls = 0;
  const adminError = Object.defineProperties({}, {
    status: { value: 503, enumerable: true },
    message: {
      enumerable: true,
      get() {
        providerBodyGetterCalls += 1;
        throw new Error("provider body must not be read");
      },
    },
  });
  const harness = createHarness({ adminUpdateError: adminError });
  const binding = await harness.provider.beginPasswordReset("USER@EXAMPLE.TEST");

  await expectFailure(() => harness.provider.completePasswordReset({
    binding,
    authorization_code: "one-time-recovery-code",
    new_password: "new correct horse battery staple",
  }), "AUTH_PROVIDER_UNAVAILABLE");

  assert.deepEqual(
    harness.methodCalls.filter((call) => ["exchangeCodeForSession", "updateUserById"].includes(call.name))
      .map((call) => call.name),
    ["exchangeCodeForSession", "updateUserById"],
  );
  assert.equal(harness.methodCalls.some((call) => call.name === "signOut"), false);
  assert.equal(providerBodyGetterCalls, 0);
});

test("Supabase password recovery requires the admin update to return the exact recovered subject", async () => {
  for (const adminUpdateData of [
    {},
    { user: null },
    { user: user("email", "different-provider-subject") },
  ]) {
    const harness = createHarness({ adminUpdateData });
    const binding = await harness.provider.beginPasswordReset("USER@EXAMPLE.TEST");

    await expectFailure(() => harness.provider.completePasswordReset({
      binding,
      authorization_code: "one-time-recovery-code",
      new_password: "new correct horse battery staple",
    }), "AUTH_PROVIDER_UNAVAILABLE");

    assert.deepEqual(
      harness.methodCalls.filter((call) => ["exchangeCodeForSession", "updateUserById"].includes(call.name))
        .map((call) => call.name),
      ["exchangeCodeForSession", "updateUserById"],
    );
  }
});
