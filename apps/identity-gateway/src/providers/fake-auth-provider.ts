import { createHash } from "node:crypto";

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
  PasswordResetStart,
  VerifiedProviderSubject,
} from "./auth-provider.js";
import { ProviderFailure } from "./provider-errors.js";

export interface FakeAuthProviderSubject {
  readonly email: string;
  readonly password: string;
  readonly proof: ProviderProof;
  readonly subject: VerifiedProviderSubject;
}

export interface FakeAuthProviderOptions {
  readonly subjects: readonly FakeAuthProviderSubject[];
  readonly appleSubject: VerifiedProviderSubject;
  readonly now?: () => Date;
}

interface StoredFakeSubject {
  readonly passwordDigest: string;
  readonly subject: VerifiedProviderSubject;
}

interface FakeAppleTransaction {
  readonly flowKind: "sign_in" | "link" | "password_reset";
  readonly actorId: string | null;
  readonly passwordResetEmail: string | null;
  readonly clientKind: ProviderClientKind;
  readonly redirectUri: string;
  readonly stateDigest: string;
  readonly nonceDigest: string;
  readonly pkceChallenge: string | null;
  readonly expiresAt: number;
}

const oauthTtlMs = 5 * 60 * 1_000;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const property = ownData(value, key);
  return typeof property === "string" ? property : undefined;
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

function copySubject(subject: VerifiedProviderSubject): VerifiedProviderSubject {
  return Object.freeze({
    provider: "supabase",
    providerSubject: subject.providerSubject,
    identityKind: subject.identityKind,
    normalizedEmail: subject.normalizedEmail,
    verifiedAt: subject.verifiedAt,
  });
}

export class FakeAuthProvider implements AuthProviderAdapter {
  readonly #subjects = new Map<string, StoredFakeSubject>();
  readonly #proofs = new Map<string, VerifiedProviderSubject>();
  readonly #transactions = new Map<string, FakeAppleTransaction>();
  readonly #appleSubject: VerifiedProviderSubject;
  readonly #now: () => Date;
  #transactionCounter = 0;

  constructor(options: FakeAuthProviderOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#appleSubject = copySubject(options.appleSubject);
    for (const fixture of options.subjects) {
      const normalizedEmail = normalizeEmail(fixture.email);
      const subject = copySubject(fixture.subject);
      this.#subjects.set(normalizedEmail, { passwordDigest: digest(fixture.password), subject });
      this.#proofs.set(digest(readProof(fixture.proof)), subject);
    }
  }

  async signUpEmail(input: EmailCredentialInput): Promise<{ readonly kind: "verification_pending" }> {
    readCredential(input);
    return Object.freeze({ kind: "verification_pending" });
  }

  async signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject> {
    const credential = readCredential(input);
    const fixture = this.#subjects.get(credential.email);
    if (fixture === undefined || fixture.passwordDigest !== digest(credential.password)) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    return copySubject(fixture.subject);
  }

  async verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject> {
    const subject = this.#proofs.get(digest(readProof(input)));
    if (subject === undefined) throw new ProviderFailure("AUTH_INVALID");
    return copySubject(subject);
  }

  async reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject> {
    return this.signInEmail(input);
  }

  async beginPasswordReset(email: string): Promise<PasswordResetStart> {
    if (typeof email !== "string" || !validEmail(normalizeEmail(email))) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    this.#transactionCounter += 1;
    const transactionId = `password_reset_fake_${this.#transactionCounter.toString().padStart(4, "0")}`;
    const state = digest(`reset-state:${transactionId}`);
    const expiresAt = this.#now().getTime() + oauthTtlMs;
    this.#transactions.set(transactionId, {
      flowKind: "password_reset",
      actorId: null,
      passwordResetEmail: normalizeEmail(email),
      clientKind: "web",
      redirectUri: "https://fake-auth.invalid/password-reset",
      stateDigest: digest(state),
      nonceDigest: digest(`reset-nonce:${transactionId}`),
      pkceChallenge: null,
      expiresAt,
    });
    return Object.freeze({
      transaction_id: transactionId,
      state,
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  async beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart> {
    return this.#beginApple(input, "sign_in", null);
  }

  async beginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart> {
    const actorId = ownString(input, "authenticatedActorId") ?? null;
    if (actorId === null) throw new ProviderFailure("AUTH_INVALID");
    await this.verifyCurrentSubject(ownData(input, "providerProof") as ProviderProof);
    return this.#beginApple(input, "link", actorId);
  }

  async completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject> {
    const binding = ownData(input, "binding");
    const transactionId = ownString(binding, "transaction_id");
    const authorizationCode = ownString(input, "authorization_code");
    const state = ownString(binding, "state");
    const expiresAt = ownString(binding, "expires_at");
    const password = ownString(input, "new_password");
    if (transactionId === undefined || authorizationCode === undefined || authorizationCode.length < 8
      || state === undefined || expiresAt === undefined || !Number.isFinite(new Date(expiresAt).getTime())
      || password === undefined
      || password.length < 8 || password.length > 1_024) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const transaction = this.#transactions.get(transactionId);
    this.#transactions.delete(transactionId);
    if (transaction === undefined || transaction.flowKind !== "password_reset"
      || transaction.redirectUri !== "https://fake-auth.invalid/password-reset"
      || new Date(transaction.expiresAt).toISOString() !== expiresAt
      || transaction.expiresAt <= this.#now().getTime()
      || transaction.stateDigest !== digest(state)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const email = transaction.passwordResetEmail;
    const fixture = email === null ? undefined : this.#subjects.get(email);
    if (email === null || fixture === undefined) throw new ProviderFailure("AUTH_INVALID");
    this.#subjects.set(email, { passwordDigest: digest(password), subject: fixture.subject });
    for (const [proofDigest, subject] of this.#proofs) {
      if (subject.providerSubject === fixture.subject.providerSubject) this.#proofs.delete(proofDigest);
    }
    return copySubject(fixture.subject);
  }

  #beginApple(
    input: AppleAuthorizationInput,
    flowKind: "sign_in" | "link",
    actorId: string | null,
  ): AppleAuthorizationStart {
    const clientKind = readClientKind(ownData(input, "client_kind"));
    const redirectUri = ownString(input, "redirect_uri");
    if (clientKind === undefined || redirectUri === undefined || redirectUri.length === 0) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    const callerNonce = ownString(input, "nonce");
    const callerChallenge = ownString(input, "pkce_code_challenge");
    const callerMethod = ownString(input, "pkce_code_challenge_method");
    if (clientKind === "web") {
      if (callerNonce !== undefined || callerChallenge !== undefined || callerMethod !== undefined) {
        throw new ProviderFailure("AUTH_INVALID");
      }
    } else if (callerNonce === undefined || callerNonce.length < 8
      || callerChallenge === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(callerChallenge)
      || callerMethod !== "S256") {
      throw new ProviderFailure("AUTH_INVALID");
    }

    this.#transactionCounter += 1;
    const transactionId = `oauth_fake_${this.#transactionCounter.toString().padStart(4, "0")}`;
    const state = transactionId;
    const nonce = callerNonce ?? digest(`nonce:${transactionId}`);
    const expiresAt = this.#now().getTime() + oauthTtlMs;
    this.#transactions.set(transactionId, {
      flowKind,
      actorId,
      passwordResetEmail: null,
      clientKind,
      redirectUri,
      stateDigest: digest(state),
      nonceDigest: digest(nonce),
      pkceChallenge: callerChallenge ?? null,
      expiresAt,
    });
    const authorizationUrl = new URL("https://fake-auth.invalid/apple");
    authorizationUrl.searchParams.set("nonce", nonce);

    if (callerChallenge !== undefined) {
      authorizationUrl.searchParams.set("code_challenge", callerChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
    }

    return Object.freeze({
      transaction_id: transactionId,
      authorization_url: authorizationUrl.toString(),
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  async completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject> {
    this.#consumeAppleCallback(input, "sign_in", null);
    return copySubject(this.#appleSubject);
  }

  async linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject> {
    const actorId = ownString(input, "authenticatedActorId") ?? null;
    await this.verifyCurrentSubject(ownData(input, "providerProof") as ProviderProof);
    this.#consumeAppleCallback(input, "link", actorId);
    return copySubject(this.#appleSubject);
  }

  async revokeCurrentProviderSession(input: ProviderProof): Promise<void> {
    const proofDigest = digest(readProof(input));
    if (!this.#proofs.delete(proofDigest)) throw new ProviderFailure("AUTH_INVALID");
  }

  async deleteProviderSubject(providerSubject: string): Promise<void> {
    if (typeof providerSubject !== "string" || providerSubject.length === 0) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    for (const [email, fixture] of this.#subjects) {
      if (fixture.subject.providerSubject === providerSubject) this.#subjects.delete(email);
    }
    for (const [proofDigest, subject] of this.#proofs) {
      if (subject.providerSubject === providerSubject) this.#proofs.delete(proofDigest);
    }
  }

  #consumeAppleCallback(
    input: AppleAuthorizationCallback,
    expectedFlow: "sign_in" | "link",
    expectedActorId: string | null,
  ): void {
    const transactionId = ownString(input, "transaction_id");
    const authorizationCode = ownString(input, "authorization_code");
    const state = ownString(input, "state");
    const nonce = ownString(input, "nonce");
    const verifier = ownString(input, "pkce_code_verifier");
    const clientKind = readClientKind(ownData(input, "client_kind"));
    if (transactionId === undefined || authorizationCode === undefined || authorizationCode.length === 0
      || state === undefined || clientKind === undefined
      || (clientKind === "web" && (nonce !== undefined || verifier !== undefined))
      || (clientKind !== "web" && (nonce === undefined || nonce.length < 8
        || verifier === undefined || !/^[A-Za-z0-9._~-]{43}$/u.test(verifier)))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const transaction = this.#transactions.get(transactionId);
    this.#transactions.delete(transactionId);
    if (transaction === undefined || transaction.flowKind !== expectedFlow
      || transaction.actorId !== expectedActorId || transaction.clientKind !== clientKind
      || transaction.expiresAt <= this.#now().getTime() || transaction.stateDigest !== digest(state)
      || (clientKind !== "web" && (transaction.nonceDigest !== digest(nonce!)
        || transaction.pkceChallenge !== pkceChallenge(verifier!)))) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
  }
}
