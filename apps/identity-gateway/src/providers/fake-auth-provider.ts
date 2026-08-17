import { createHash } from "node:crypto";

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
  readonly flowKind: "sign_in" | "link";
  readonly actorId: string | null;
  readonly clientKind: ProviderClientKind;
  readonly redirectUri: string;
  readonly stateDigest: string;
  readonly nonceDigest: string;
  readonly expiresAt: number;
}

const oauthTtlMs = 5 * 60 * 1_000;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

  async beginPasswordReset(email: string): Promise<void> {
    if (typeof email !== "string" || !validEmail(normalizeEmail(email))) {
      throw new ProviderFailure("AUTH_INVALID");
    }
  }

  async beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart> {
    const flowKind = ownString(input, "flowKind");
    const clientKind = readClientKind(ownData(input, "clientKind"));
    const redirectUri = ownString(input, "redirectUri");
    if ((flowKind !== "sign_in" && flowKind !== "link") || clientKind === undefined
      || redirectUri === undefined || redirectUri.length === 0) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    let actorId: string | null = null;
    if (flowKind === "link") {
      actorId = ownString(input, "authenticatedActorId") ?? null;
      const proof = ownData(input, "providerProof");
      if (actorId === null) throw new ProviderFailure("AUTH_INVALID");
      await this.verifyCurrentSubject(proof as ProviderProof);
    }

    this.#transactionCounter += 1;
    const transactionId = `oauth_fake_${this.#transactionCounter.toString().padStart(4, "0")}`;
    const state = digest(`state:${transactionId}`);
    const nonce = digest(`nonce:${transactionId}`);
    const expiresAt = this.#now().getTime() + oauthTtlMs;
    this.#transactions.set(transactionId, {
      flowKind,
      actorId,
      clientKind,
      redirectUri,
      stateDigest: digest(state),
      nonceDigest: digest(nonce),
      expiresAt,
    });
    const authorizationUrl = new URL("https://fake-auth.invalid/apple");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);

    return Object.freeze({
      transactionId,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: new Date(expiresAt).toISOString(),
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
    expectedFlow: FakeAppleTransaction["flowKind"],
    expectedActorId: string | null,
  ): void {
    const transactionId = ownString(input, "transactionId");
    const authorizationCode = ownString(input, "authorizationCode");
    const state = ownString(input, "state");
    const nonce = ownString(input, "nonce");
    const redirectUri = ownString(input, "redirectUri");
    const clientKind = readClientKind(ownData(input, "clientKind"));
    if (transactionId === undefined || authorizationCode === undefined || authorizationCode.length === 0
      || state === undefined || nonce === undefined || redirectUri === undefined || clientKind === undefined) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const transaction = this.#transactions.get(transactionId);
    this.#transactions.delete(transactionId);
    if (transaction === undefined || transaction.flowKind !== expectedFlow
      || transaction.actorId !== expectedActorId || transaction.clientKind !== clientKind
      || transaction.redirectUri !== redirectUri || transaction.expiresAt <= this.#now().getTime()
      || transaction.stateDigest !== digest(state) || transaction.nonceDigest !== digest(nonce)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
  }
}
