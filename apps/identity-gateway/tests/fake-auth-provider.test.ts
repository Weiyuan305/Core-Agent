import assert from "node:assert/strict";
import test from "node:test";

import type {
  AppleLinkAuthorizationInput,
  AppleLinkInput,
  AuthProviderAdapter,
} from "../src/providers/auth-provider.js";
import { canonicalProviderStartPayloadHash } from "../src/providers/auth-provider.js";
import { FakeAuthProvider } from "../src/providers/fake-auth-provider.js";
import { ProviderFailure } from "../src/providers/provider-errors.js";

const fixedNow = "2026-08-17T01:02:03.000Z";
const credential = Object.freeze({
  email: "USER@EXAMPLE.TEST",
  password: "correct horse battery staple",
});
const providerProof = Object.freeze({ accessToken: ["fake", "current", "jwt"].join("-") });
const payloadHash = `sha256:${"a".repeat(64)}`;

type HasProviderProof<T> = "providerProof" extends keyof T ? true : false;

const appleLinkStartHasNoProviderProof: HasProviderProof<AppleLinkAuthorizationInput> = false;
const appleLinkCallbackHasNoProviderProof: HasProviderProof<AppleLinkInput> = false;

function createProvider(appleProviderSubject = "provider-subject-1"): FakeAuthProvider {
  return new FakeAuthProvider({
    now: () => new Date(fixedNow),
    subjects: [{
      email: "user@example.test",
      password: credential.password,
      proof: providerProof,
      subject: {
        provider: "supabase",
        providerSubject: "provider-subject-1",
        identityKind: "email_password",
        normalizedEmail: "user@example.test",
        verifiedAt: "2026-08-01T00:00:00.000Z",
      },
    }],
    appleSubject: {
      provider: "supabase",
      providerSubject: appleProviderSubject,
      identityKind: "apple",
      normalizedEmail: "user@example.test",
      verifiedAt: "2026-08-01T00:00:00.000Z",
    },
  });
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

test("deterministic fake implements the closed adapter and returns only verified subject facts", async () => {
  const provider: AuthProviderAdapter = createProvider();

  assert.deepEqual(await provider.signInEmail(credential), {
    provider: "supabase",
    providerSubject: "provider-subject-1",
    identityKind: "email_password",
    normalizedEmail: "user@example.test",
    verifiedAt: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(await provider.reauthenticatePassword(credential), await provider.signInEmail(credential));
  assert.deepEqual(await provider.verifyCurrentSubject(providerProof), await provider.signInEmail(credential));
  const signup = await provider.signUpEmail({
    email: "new-user@example.test",
    password: "a sufficiently long password",
  });
  assert.deepEqual(signup, {
    kind: "verification_pending",
    expectedProviderSubject: "fake-email-f2d3ae2417396d63d9061593",
  });
  const verifier = provider as unknown as {
    verifyEmail?: (input: { verificationCode: string; expectedProviderSubject: string }) => Promise<unknown>;
    recoverVerifiedEmailSubject?: (input: {
      expectedProviderSubject: string;
      expectedNormalizedEmail: string;
      verificationStartedAt: string;
      recoveryNotAfter: string;
    }) => Promise<unknown>;
  };
  assert.equal(typeof verifier.verifyEmail, "function");
  assert.equal(typeof verifier.recoverVerifiedEmailSubject, "function");
  await expectFailure(() => verifier.recoverVerifiedEmailSubject!({
    expectedProviderSubject: signup.expectedProviderSubject,
    expectedNormalizedEmail: "new-user@example.test",
    verificationStartedAt: "2026-08-17T01:02:03.000Z",
    recoveryNotAfter: "2026-08-17T01:02:04.000Z",
  }), "AUTH_EMAIL_UNVERIFIED");
  assert.equal((await verifier.verifyEmail!({
    verificationCode: "fake-email-verification-code",
    expectedProviderSubject: signup.expectedProviderSubject,
  }) as { normalizedEmail?: unknown }).normalizedEmail, "new-user@example.test");
  assert.equal((await verifier.recoverVerifiedEmailSubject!({
    expectedProviderSubject: signup.expectedProviderSubject,
    expectedNormalizedEmail: "new-user@example.test",
    verificationStartedAt: "2026-08-17T01:02:03.000Z",
    recoveryNotAfter: "2026-08-17T01:02:04.000Z",
  }) as { providerSubject?: unknown }).providerSubject, signup.expectedProviderSubject);
  await expectFailure(() => verifier.verifyEmail!({
    verificationCode: "fake-email-verification-code",
    expectedProviderSubject: signup.expectedProviderSubject,
  }), "AUTH_CALLBACK_INVALID");
  const unknownBinding = await provider.beginPasswordReset("unknown@example.test");
  assert.deepEqual(Object.keys(unknownBinding).sort(), ["expires_at", "state", "transaction_id"]);
  assert.equal(Object.isFrozen(unknownBinding), true);
  assert.equal(JSON.stringify(unknownBinding).includes("unknown@example.test"), false);
  await expectFailure(() => provider.completePasswordReset({
    binding: unknownBinding,
    authorization_code: "fake-recovery-code",
    new_password: "must not reset another account",
  }), "AUTH_INVALID");
  const binding = await provider.beginPasswordReset(credential.email);
  assert.equal(binding.expires_at, "2026-08-17T01:07:03.000Z");
  assert.equal((await provider.completePasswordReset({
    binding,
    authorization_code: "fake-recovery-code",
    new_password: "a new sufficiently long password",
  })).providerSubject, "provider-subject-1");
  await expectFailure(() => provider.signInEmail(credential), "AUTH_INVALID");
  assert.equal((await provider.signInEmail({
    email: credential.email,
    password: "a new sufficiently long password",
  })).providerSubject, "provider-subject-1");
  await expectFailure(() => provider.verifyCurrentSubject(providerProof), "AUTH_INVALID");
});

test("deterministic fake accepts inert own data properties without invoking getters or reflecting input", async () => {
  let getterCalls = 0;
  const target = Object.defineProperties({}, {
    email: { value: credential.email, enumerable: true },
    password: { value: credential.password, enumerable: true },
    access_token: {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not execute");
      },
    },
  });
  const result = await createProvider().signInEmail(target as never);

  assert.equal(getterCalls, 0);
  assert.deepEqual(Object.keys(result).sort(), [
    "identityKind",
    "normalizedEmail",
    "provider",
    "providerSubject",
    "verifiedAt",
  ]);
  assert.equal(JSON.stringify(result).includes(credential.password), false);
});

test("deterministic fake rejects Node Proxy inputs without invoking any structural trap", async () => {
  const calls = { descriptor: 0, keys: 0, get: 0, prototype: 0 };
  const trapped = new Proxy({ ...credential }, {
    getOwnPropertyDescriptor() {
      calls.descriptor += 1;
      throw new Error("descriptor trap must not execute");
    },
    ownKeys() {
      calls.keys += 1;
      throw new Error("ownKeys trap must not execute");
    },
    get() {
      calls.get += 1;
      throw new Error("get trap must not execute");
    },
    getPrototypeOf() {
      calls.prototype += 1;
      throw new Error("prototype trap must not execute");
    },
  });

  await expectFailure(() => createProvider().signInEmail(trapped as never), "AUTH_INVALID");
  assert.deepEqual(calls, { descriptor: 0, keys: 0, get: 0, prototype: 0 });

  assert.throws(
    () => new FakeAuthProvider(new Proxy({} as never, {
      getOwnPropertyDescriptor() { calls.descriptor += 1; throw new Error("no descriptor"); },
      ownKeys() { calls.keys += 1; throw new Error("no keys"); },
      get() { calls.get += 1; throw new Error("no get"); },
      getPrototypeOf() { calls.prototype += 1; throw new Error("no prototype"); },
    })),
    (error: unknown) => error instanceof ProviderFailure && error.code === "AUTH_INVALID",
  );
  assert.deepEqual(calls, { descriptor: 0, keys: 0, get: 0, prototype: 0 });

  const revokedSubjects = Proxy.revocable([], {});
  revokedSubjects.revoke();
  assert.throws(
    () => new FakeAuthProvider({
      subjects: revokedSubjects.proxy,
      appleSubject: {} as never,
    }),
    (error: unknown) => error instanceof ProviderFailure && error.code === "AUTH_INVALID",
  );
});

test("deterministic fake rejects inherited or accessor credentials with a stable bounded failure", async () => {
  const inherited = Object.create({ email: credential.email, password: credential.password });
  const accessor = Object.defineProperties({}, {
    email: { value: credential.email, enumerable: true },
    password: {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    },
  });

  await expectFailure(() => createProvider().signInEmail(inherited), "AUTH_INVALID");
  await expectFailure(() => createProvider().signInEmail(accessor as never), "AUTH_INVALID");
  await expectFailure(
    () => createProvider().signInEmail({ ...credential, password: "wrong password" }),
    "AUTH_INVALID",
  );
});

test("deterministic fake validates one-time Apple sign-in and link transactions", async () => {
  const provider = createProvider();
  const signInStart = await provider.beginApple({
    schema_version: 1,
    idempotency_key: "idem_fake_start",
    payload_hash: canonicalProviderStartPayloadHash({
      flowKind: "apple_sign_in", idempotencyKey: "idem_fake_start", clientKind: "web",
      redirectUri: "https://identity.example.test/auth/v1/apple/callback",
    }),
    client_kind: "web",
    redirect_uri: "https://identity.example.test/auth/v1/apple/callback",
  });
  assert.equal(new URL(signInStart.authorization_url).searchParams.has("state"), false);
  const callback = {
    schema_version: 1 as const,
    idempotency_key: "idem_fake_callback",
    payload_hash: payloadHash,
    transaction_id: signInStart.transaction_id,
    authorization_code: "fake-authorization-code",
    state: signInStart.transaction_id,
    client_kind: "web" as const,
  };

  assert.equal(signInStart.expires_at, "2026-08-17T01:07:03.000Z");
  assert.equal((await provider.completeApple(callback)).identityKind, "apple");
  await expectFailure(() => provider.completeApple(callback), "AUTH_CALLBACK_INVALID");

  const linkStart = await provider.reauthenticateAndBeginAppleLink({
    schema_version: 1,
    idempotency_key: "idem_fake_link_start",
    payload_hash: canonicalProviderStartPayloadHash({
      flowKind: "apple_link", idempotencyKey: "idem_fake_link_start", clientKind: "web",
      redirectUri: "https://identity.example.test/auth/v1/apple/callback",
    }),
    client_kind: "web",
    redirect_uri: "https://identity.example.test/auth/v1/apple/callback",
    authenticatedActorId: "actor-1",
    email: credential.email,
    password: credential.password,
  });
  assert.equal(new URL(linkStart.authorization_url).searchParams.has("state"), false);
  assert.equal((await provider.linkApple({
    schema_version: 1,
    idempotency_key: "idem_fake_link_callback",
    payload_hash: payloadHash,
    transaction_id: linkStart.transaction_id,
    authorization_code: "fake-link-code",
    state: linkStart.transaction_id,
    client_kind: "web",
    authenticatedActorId: "actor-1",
  })).identityKind, "apple");
  assert.equal(appleLinkStartHasNoProviderProof, false);
  assert.equal(appleLinkCallbackHasNoProviderProof, false);
});

test("deterministic fake rejects an Apple link callback for a different provider subject", async () => {
  const provider = createProvider("different-provider-subject");
  const start = await provider.reauthenticateAndBeginAppleLink({
    schema_version: 1,
    idempotency_key: "idem_fake_link_conflict_start",
    payload_hash: canonicalProviderStartPayloadHash({
      flowKind: "apple_link", idempotencyKey: "idem_fake_link_conflict_start", clientKind: "web",
      redirectUri: "https://identity.example.test/auth/v1/apple/callback",
    }),
    client_kind: "web",
    redirect_uri: "https://identity.example.test/auth/v1/apple/callback",
    authenticatedActorId: "actor-1",
    email: credential.email,
    password: credential.password,
  });

  await expectFailure(() => provider.linkApple({
    schema_version: 1,
    idempotency_key: "idem_fake_link_conflict_callback",
    payload_hash: payloadHash,
    transaction_id: start.transaction_id,
    authorization_code: "fake-link-code",
    state: start.transaction_id,
    client_kind: "web",
    authenticatedActorId: "actor-1",
  }), "AUTH_CONFLICT");
});

test("deterministic fake rejects changed Apple callback authority before returning a subject", async () => {
  const provider = createProvider();
  const start = await provider.beginApple({
    schema_version: 1,
    idempotency_key: "idem_fake_native_start",
    payload_hash: canonicalProviderStartPayloadHash({
      flowKind: "apple_sign_in", idempotencyKey: "idem_fake_native_start", clientKind: "iphone",
      redirectUri: "coreagent://auth/callback", nonce: "opaque-native-nonce", pkceChallenge: "a".repeat(43),
    }),
    client_kind: "iphone",
    redirect_uri: "coreagent://auth/callback",
    nonce: "opaque-native-nonce",
    pkce_code_challenge: "a".repeat(43),
    pkce_code_challenge_method: "S256",
  });
  await expectFailure(() => provider.completeApple({
    schema_version: 1,
    idempotency_key: "idem_fake_native_callback",
    payload_hash: payloadHash,
    transaction_id: start.transaction_id,
    authorization_code: "fake-code",
    state: `${start.transaction_id}-changed`,
    nonce: "opaque-native-nonce",
    pkce_code_verifier: "b".repeat(43),
    client_kind: "iphone",
  }), "AUTH_CALLBACK_INVALID");
});

test("deterministic fake revokes the current proof and deletes a provider subject", async () => {
  const provider = createProvider();

  await provider.revokeCurrentProviderSession(providerProof);
  await expectFailure(() => provider.verifyCurrentSubject(providerProof), "AUTH_INVALID");

  await provider.deleteProviderSubject("provider-subject-1");
  await expectFailure(() => provider.signInEmail(credential), "AUTH_INVALID");
  await provider.deleteProviderSubject("provider-subject-1");
});
