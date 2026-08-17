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
  assert.equal(await provider.beginPasswordReset("unknown@example.test"), undefined);
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
    flowKind: "sign_in",
    clientKind: "web",
    redirectUri: "https://identity.example.test/auth/v1/apple/callback",
  });
  const signInUrl = new URL(signInStart.authorizationUrl);
  const callback = {
    transactionId: signInStart.transactionId,
    authorizationCode: "fake-authorization-code",
    state: signInUrl.searchParams.get("state") ?? "",
    nonce: signInUrl.searchParams.get("nonce") ?? "",
    redirectUri: "https://identity.example.test/auth/v1/apple/callback",
    clientKind: "web" as const,
  };

  assert.equal(signInStart.expiresAt, "2026-08-17T01:07:03.000Z");
  assert.equal((await provider.completeApple(callback)).identityKind, "apple");
  await expectFailure(() => provider.completeApple(callback), "AUTH_CALLBACK_INVALID");

  const linkStart = await provider.beginApple({
    flowKind: "link",
    clientKind: "web",
    redirectUri: "https://identity.example.test/auth/v1/apple/callback",
    authenticatedActorId: "actor-1",
    providerProof,
  });
  const linkUrl = new URL(linkStart.authorizationUrl);
  assert.equal((await provider.linkApple({
    transactionId: linkStart.transactionId,
    authorizationCode: "fake-link-code",
    state: linkUrl.searchParams.get("state") ?? "",
    nonce: linkUrl.searchParams.get("nonce") ?? "",
    redirectUri: "https://identity.example.test/auth/v1/apple/callback",
    clientKind: "web",
    authenticatedActorId: "actor-1",
    providerProof,
  })).identityKind, "apple");
});

test("deterministic fake rejects changed Apple callback authority before returning a subject", async () => {
  const provider = createProvider();
  const start = await provider.beginApple({
    flowKind: "sign_in",
    clientKind: "iphone",
    redirectUri: "coreagent://auth/callback",
  });
  const url = new URL(start.authorizationUrl);

  await expectFailure(() => provider.completeApple({
    transactionId: start.transactionId,
    authorizationCode: "fake-code",
    state: `${url.searchParams.get("state") ?? ""}-changed`,
    nonce: url.searchParams.get("nonce") ?? "",
    redirectUri: "coreagent://auth/callback",
    clientKind: "iphone",
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
