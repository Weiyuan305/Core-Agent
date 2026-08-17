import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ProviderClientKind } from "../src/providers/auth-provider.js";
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
const credential = Object.freeze({
  email: "USER@EXAMPLE.TEST",
  password: "correct horse battery staple",
});
const currentJwt = ["provider", "jwt", "sentinel"].join("-");
const providerProof = Object.freeze({ accessToken: currentJwt });
const pkceVerifier = ["pkce", "verifier", "sentinel", "x".repeat(32)].join("-");
const providerAccessToken = ["provider", "access", "sentinel"].join("-");
const providerRefreshToken = ["provider", "refresh", "sentinel"].join("-");
const serviceRoleKey = ["service", "role", "sentinel"].join("-");

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
  return new Proxy(value, {
    get() {
      throw new Error(`property access is forbidden (${unknownGetterCalls})`);
    },
  });
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
      const requestOptions = (request as { readonly options: { readonly queryParams: {
        readonly state: string;
        readonly nonce: string;
      } } }).options;
      const authorizationUrl = new URL("https://example.supabase.co/auth/v1/authorize");
      authorizationUrl.searchParams.set("state", requestOptions.queryParams.state);
      authorizationUrl.searchParams.set("nonce", requestOptions.queryParams.nonce);
      return { data: { provider: "apple", url: authorizationUrl.toString(), flowId }, error: null };
    };
    const auth = {
      signUp: async (request: unknown) => {
        methodCalls.push({ name: "signUp", arguments: [request] });
        return { data: { user: user(), session: null }, error: null };
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
            user: user("apple"),
            session: { access_token: providerAccessToken, refresh_token: providerRefreshToken },
          },
          error: null,
        };
      },
      admin: {
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
      passwordResetRedirectUri: "https://identity.example.test/auth/v1/password/reset/callback",
      transactionStore: store,
      transactionProtector: input.transactionProtector ?? protector,
      createClient: factory,
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
  start: { readonly transactionId: string; readonly authorizationUrl: string },
  clientKind: ProviderClientKind = "web",
) {
  const url = new URL(start.authorizationUrl);
  return {
    transactionId: start.transactionId,
    authorizationCode: "one-time-authorization-code",
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
    redirectUri: clientKind === "web" ? callbackUri : nativeCallbackUri,
    clientKind,
  };
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
  assert.deepEqual(
    harness.methodCalls.find((call) => call.name === "resetPasswordForEmail")?.arguments,
    ["user@example.test", { redirectTo: "https://identity.example.test/auth/v1/password/reset/callback" }],
  );
  assert.deepEqual(harness.methodCalls.find((call) => call.name === "deleteUser")?.arguments, [
    "provider-subject-1",
    false,
  ]);
  assert.equal(harness.clientCalls.at(-1)?.key, serviceRoleKey);
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
    passwordResetRedirectUri: callbackUri,
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
    passwordResetRedirectUri: callbackUri,
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
    passwordResetRedirectUri: callbackUri,
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
  let prototypeTrapCalls = 0;
  let getTrapCalls = 0;
  const providerError = new Proxy({ status: 429, code: "over_request_rate_limit" }, {
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
    passwordResetRedirectUri: callbackUri,
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: factory,
  });

  await expectFailure(() => provider.signInEmail(credential), "AUTH_RATE_LIMITED");
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(getTrapCalls, 0);
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
    passwordResetRedirectUri: callbackUri,
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
    passwordResetRedirectUri: callbackUri,
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
    passwordResetRedirectUri: callbackUri,
    transactionStore: new MemoryTransactionStore(),
    transactionProtector: protector,
    createClient: factory,
  });

  await expectFailure(() => provider.signInEmail(credential), "AUTH_PROVIDER_UNAVAILABLE");
  assert.equal(accessorCalls, 0);
});

test("Supabase Apple start persists the actual digest/ciphertext transaction schema without raw PKCE", async () => {
  const harness = createHarness();
  const start = await harness.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: callbackUri,
  });
  const transaction = harness.store.records.get(start.transactionId);

  assert(transaction !== undefined);
  assert.deepEqual(Object.keys(transaction).sort(), [
    "actor_id",
    "client_kind",
    "expires_at",
    "flow_kind",
    "nonce_digest",
    "oauth_transaction_id",
    "pkce_verifier_ciphertext",
    "provider",
    "redirect_uri",
    "state_digest",
    "status",
  ]);
  assert.equal(transaction.provider, "supabase");
  assert.equal(transaction.flow_kind, "apple_sign_in");
  assert.equal(transaction.actor_id, null);
  assert.equal(transaction.client_kind, "web");
  assert.equal(transaction.redirect_uri, callbackUri);
  assert.equal(transaction.status, "pending");
  assert.equal(transaction.state_digest.byteLength, 32);
  assert.equal(transaction.nonce_digest.byteLength, 32);
  assert.notDeepEqual([...transaction.pkce_verifier_ciphertext], [...Buffer.from(pkceVerifier)]);
  assert.equal(JSON.stringify(transaction).includes(pkceVerifier), false);
  const startUrl = new URL(start.authorizationUrl);
  assert.notEqual(startUrl.searchParams.get("state"), startUrl.searchParams.get("nonce"));
  assert.equal(JSON.stringify(transaction).includes(startUrl.searchParams.get("state") ?? ""), false);
  assert.equal(JSON.stringify(transaction).includes(startUrl.searchParams.get("nonce") ?? ""), false);
  assert.deepEqual(Object.keys(start).sort(), ["authorizationUrl", "expiresAt", "transactionId"]);
  assert.equal(start.expiresAt, "2026-08-17T02:05:00.000Z");
  await expectFailure(() => harness.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: "https://attacker.example.test/callback",
  }), "AUTH_CALLBACK_INVALID");
});

test("Supabase Apple callback validates and consumes state, nonce, PKCE, redirect, client, expiry, and flow before exchange", async () => {
  const harness = createHarness();
  const start = await harness.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: callbackUri,
  });
  const callback = callbackFromStart(start);
  const subject = await harness.provider.completeApple(callback);

  assert.equal(subject.identityKind, "apple");
  assert.deepEqual(harness.exchangedVerifiers, [pkceVerifier]);
  assert.deepEqual(
    harness.methodCalls.find((call) => call.name === "exchangeCodeForSession")?.arguments,
    ["one-time-authorization-code", { flowId: "signinflow01" }],
  );
  assert.equal(harness.store.records.has(start.transactionId), false);
  await expectFailure(() => harness.provider.completeApple(callback), "AUTH_CALLBACK_INVALID");

  for (const changed of [
    { field: "state", value: "changed-state" },
    { field: "nonce", value: "changed-nonce" },
    { field: "redirectUri", value: nativeCallbackUri },
    { field: "clientKind", value: "iphone" },
  ] as const) {
    const isolated = createHarness();
    const isolatedStart = await isolated.provider.beginApple({
      flowKind: "sign_in",
      clientKind: "web",
      redirectUri: callbackUri,
    });
    const invalid = { ...callbackFromStart(isolatedStart), [changed.field]: changed.value };
    await expectFailure(() => isolated.provider.completeApple(invalid as never), "AUTH_CALLBACK_INVALID");
    assert.equal(isolated.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);
  }
});

test("Supabase Apple callback fails closed for expired or tampered encrypted verifier transactions", async () => {
  let now = new Date(fixedNow);
  const expired = createHarness({ now: () => new Date(now) });
  const expiredStart = await expired.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: callbackUri,
  });
  now = new Date(fixedNow.getTime() + 5 * 60 * 1_000);
  await expectFailure(
    () => expired.provider.completeApple(callbackFromStart(expiredStart)),
    "AUTH_CALLBACK_INVALID",
  );
  assert.equal(expired.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);

  const tampered = createHarness();
  const tamperedStart = await tampered.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: callbackUri,
  });
  const transaction = tampered.store.records.get(tamperedStart.transactionId);
  assert(transaction !== undefined);
  transaction.pkce_verifier_ciphertext[0] = (transaction.pkce_verifier_ciphertext[0] ?? 0) ^ 1;
  await expectFailure(
    () => tampered.provider.completeApple(callbackFromStart(tamperedStart)),
    "AUTH_CALLBACK_INVALID",
  );
  assert.equal(tampered.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);

  const invalidExpiry = createHarness();
  const invalidExpiryStart = await invalidExpiry.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: callbackUri,
  });
  const invalidExpiryTransaction = invalidExpiry.store.records.get(invalidExpiryStart.transactionId);
  assert(invalidExpiryTransaction !== undefined);
  invalidExpiry.store.records.set(invalidExpiryStart.transactionId, {
    ...invalidExpiryTransaction,
    expires_at: "not-a-timestamp",
  });
  await expectFailure(
    () => invalidExpiry.provider.completeApple(callbackFromStart(invalidExpiryStart)),
    "AUTH_CALLBACK_INVALID",
  );
  assert.equal(invalidExpiry.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);
});

test("Supabase Apple callback bounds unknown protector errors without prototype inspection", async () => {
  let prototypeTrapCalls = 0;
  const protectorError = new Proxy({}, {
    getPrototypeOf() {
      prototypeTrapCalls += 1;
      throw new Error("prototype inspection is forbidden");
    },
  });
  const failingProtector: TransactionProtector = {
    encrypt: protector.encrypt,
    async decrypt() {
      throw protectorError;
    },
  };
  const harness = createHarness({ transactionProtector: failingProtector });
  const start = await harness.provider.beginApple({
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: callbackUri,
  });

  await expectFailure(
    () => harness.provider.completeApple(callbackFromStart(start)),
    "AUTH_CALLBACK_INVALID",
  );
  assert.equal(prototypeTrapCalls, 0);
  assert.equal(harness.methodCalls.some((call) => call.name === "exchangeCodeForSession"), false);
});

test("Supabase Apple link binds the authenticated actor and current proof without returning provider tokens", async () => {
  const harness = createHarness();
  const start = await harness.provider.beginApple({
    flowKind: "link",
    clientKind: "web",
    redirectUri: callbackUri,
    authenticatedActorId: "actor-1",
    providerProof,
  });
  const stored = harness.store.records.get(start.transactionId);
  assert.equal(stored?.flow_kind, "apple_link");
  assert.equal(stored?.actor_id, "actor-1");

  const result = await harness.provider.linkApple({
    ...callbackFromStart(start),
    authenticatedActorId: "actor-1",
    providerProof,
  });

  assert.equal(result.identityKind, "apple");
  assert.equal(JSON.stringify(result).includes(currentJwt), false);
  assert.equal(JSON.stringify(result).includes(providerAccessToken), false);
  assert.equal(JSON.stringify(result).includes(providerRefreshToken), false);
  assert.equal(harness.methodCalls.filter((call) => call.name === "setSession").length, 2);
  assert.equal(harness.methodCalls.filter((call) => call.name === "linkIdentity").length, 1);
});
