import assert from "node:assert/strict";
import test from "node:test";

import type { AuthProviderAdapter } from "../src/providers/auth-provider.js";
import { FakeAuthProvider } from "../src/providers/fake-auth-provider.js";
import { ProviderFailure } from "../src/providers/provider-errors.js";

const fixedNow = "2026-08-17T01:02:03.000Z";
const credential = Object.freeze({
  email: "USER@EXAMPLE.TEST",
  password: "correct horse battery staple",
});
const providerProof = Object.freeze({ accessToken: ["fake", "current", "jwt"].join("-") });
const payloadHash = `sha256:${"a".repeat(64)}`;

function createProvider(): FakeAuthProvider {
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
      providerSubject: "provider-subject-1",
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
  assert.deepEqual(await provider.signUpEmail({
    email: "new-user@example.test",
    password: "a sufficiently long password",
  }), { kind: "verification_pending" });
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
  const trapped = new Proxy(target, {
    get() {
      throw new Error("property access is forbidden");
    },
  });

  const result = await createProvider().signInEmail(trapped as never);

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
    payload_hash: payloadHash,
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

  const linkStart = await provider.beginAppleLink({
    schema_version: 1,
    idempotency_key: "idem_fake_link_start",
    payload_hash: payloadHash,
    client_kind: "web",
    redirect_uri: "https://identity.example.test/auth/v1/apple/callback",
    authenticatedActorId: "actor-1",
    providerProof,
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
    providerProof,
  })).identityKind, "apple");
});

test("deterministic fake rejects changed Apple callback authority before returning a subject", async () => {
  const provider = createProvider();
  const start = await provider.beginApple({
    schema_version: 1,
    idempotency_key: "idem_fake_native_start",
    payload_hash: payloadHash,
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
