import { createHash, timingSafeEqual } from "node:crypto";
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
  PasswordResetStart,
  PasswordResetStartInput,
  VerifiedProviderSubject,
} from "./auth-provider.js";
import { canonicalProviderStartPayloadHash } from "./auth-provider.js";
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
  readonly passwordResetProviderSubject: string | null;
  readonly clientKind: ProviderClientKind;
  readonly redirectUri: string;
  readonly stateDigest: string;
  readonly nonceDigest: string;
  readonly pkceChallenge: string | null;
  readonly providerSubjectDigest: string | null;
  readonly expiresAt: number;
}

const oauthTtlMs = 5 * 60 * 1_000;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function ownData(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null || utilTypes.isProxy(value)) return undefined;
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

function readIdempotency(input: unknown): { readonly key: string; readonly payloadHash: string } {
  const key = ownString(input, "idempotency_key") ?? ownString(input, "idempotencyKey");
  const payloadHash = ownString(input, "payload_hash") ?? ownString(input, "payloadHash");
  if (key === undefined || key.length < 1 || key.length > 255
    || payloadHash === undefined || !/^sha256:[a-f0-9]{64}$/u.test(payloadHash)) {
    throw new ProviderFailure("AUTH_INVALID");
  }
  return { key, payloadHash };
}

function assertFakeStartHash(supplied: string, expected: string): void {
  if (!constantTimeEqual(supplied, expected)) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
}

function readAppleStart(input: AppleAuthorizationInput, flowKind: "sign_in" | "link") {
  const idempotency = readIdempotency(input);
  const clientKind = readClientKind(ownData(input, "client_kind"));
  const redirectUri = ownString(input, "redirect_uri");
  const deviceLabel = ownString(input, "device_label");
  const callerNonce = ownString(input, "nonce");
  const callerChallenge = ownString(input, "pkce_code_challenge");
  const callerMethod = ownString(input, "pkce_code_challenge_method");
  if (clientKind === undefined || redirectUri === undefined || redirectUri.length === 0) {
    throw new ProviderFailure("AUTH_INVALID");
  }
  if (clientKind === "web") {
    if (callerNonce !== undefined || callerChallenge !== undefined || callerMethod !== undefined) {
      throw new ProviderFailure("AUTH_INVALID");
    }
  } else if (callerNonce === undefined || callerNonce.length < 8
    || callerChallenge === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(callerChallenge)
    || callerMethod !== "S256") {
    throw new ProviderFailure("AUTH_INVALID");
  }
  assertFakeStartHash(idempotency.payloadHash, canonicalProviderStartPayloadHash({
    flowKind: flowKind === "sign_in" ? "apple_sign_in" : "apple_link",
    idempotencyKey: idempotency.key,
    clientKind,
    redirectUri,
    ...(deviceLabel === undefined ? {} : { deviceLabel }),
    ...(callerNonce === undefined ? {} : { nonce: callerNonce }),
    ...(callerChallenge === undefined ? {} : { pkceChallenge: callerChallenge }),
  }));
  return { idempotency, clientKind, redirectUri, callerNonce, callerChallenge };
}

function copySubject(subject: VerifiedProviderSubject): VerifiedProviderSubject {
  const provider = ownString(subject, "provider");
  const providerSubject = ownString(subject, "providerSubject");
  const identityKind = ownString(subject, "identityKind");
  const normalizedEmail = ownString(subject, "normalizedEmail");
  const verifiedAt = ownString(subject, "verifiedAt");
  if (provider !== "supabase" || providerSubject === undefined || providerSubject.length === 0
    || (identityKind !== "email_password" && identityKind !== "apple")
    || normalizedEmail === undefined || !validEmail(normalizedEmail)
    || verifiedAt === undefined || !Number.isFinite(new Date(verifiedAt).getTime())) {
    throw new ProviderFailure("AUTH_INVALID");
  }
  return Object.freeze({
    provider: "supabase",
    providerSubject,
    identityKind,
    normalizedEmail,
    verifiedAt: new Date(verifiedAt).toISOString(),
  });
}

function readOwnArray(value: unknown, maximum: number): readonly unknown[] | undefined {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) return undefined;
  const length = ownData(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
    return undefined;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = ownData(value, String(index));
    if (item === undefined) return undefined;
    copy.push(item);
  }
  return copy;
}

export class FakeAuthProvider implements AuthProviderAdapter {
  readonly #subjects = new Map<string, StoredFakeSubject>();
  readonly #proofs = new Map<string, VerifiedProviderSubject>();
  readonly #transactions = new Map<string, FakeAppleTransaction>();
  readonly #emailVerifications = new Map<string, VerifiedProviderSubject>();
  readonly #verifiedEmailSubjects = new Map<string, VerifiedProviderSubject>();
  readonly #providerStarts = new Map<string, { readonly payloadHash: string; readonly response: AppleAuthorizationStart | PasswordResetStart }>();
  readonly #appleSubject: VerifiedProviderSubject;
  readonly #now: () => Date;
  #transactionCounter = 0;

  constructor(options: FakeAuthProviderOptions) {
    if (utilTypes.isProxy(options)) throw new ProviderFailure("AUTH_INVALID");
    const now = ownData(options, "now");
    const subjects = readOwnArray(ownData(options, "subjects"), 10_000);
    if ((now !== undefined && (typeof now !== "function" || utilTypes.isProxy(now)))
      || subjects === undefined) throw new ProviderFailure("AUTH_INVALID");
    this.#now = (now as (() => Date) | undefined) ?? (() => new Date());
    this.#appleSubject = copySubject(ownData(options, "appleSubject") as VerifiedProviderSubject);
    for (const fixture of subjects) {
      const email = ownString(fixture, "email");
      const password = ownString(fixture, "password");
      const proof = ownData(fixture, "proof");
      if (email === undefined || password === undefined || !validEmail(normalizeEmail(email))) {
        throw new ProviderFailure("AUTH_INVALID");
      }
      const normalizedEmail = normalizeEmail(email);
      const subject = copySubject(ownData(fixture, "subject") as VerifiedProviderSubject);
      this.#subjects.set(normalizedEmail, { passwordDigest: digest(password), subject });
      this.#proofs.set(digest(readProof(proof)), subject);
    }
  }

  async signUpEmail(input: EmailCredentialInput): Promise<{
    readonly kind: "verification_pending";
    readonly expectedProviderSubject: string;
  }> {
    const credential = readCredential(input);
    const subject = Object.freeze({
      provider: "supabase" as const,
      providerSubject: `fake-email-${digest(credential.email).slice(0, 24)}`,
      identityKind: "email_password" as const,
      normalizedEmail: credential.email,
      verifiedAt: this.#now().toISOString(),
    });
    this.#emailVerifications.set("fake-email-verification-code", subject);
    return Object.freeze({ kind: "verification_pending", expectedProviderSubject: subject.providerSubject });
  }

  async verifyEmail(input: EmailVerificationInput): Promise<VerifiedProviderSubject> {
    const verificationCode = ownString(input, "verificationCode");
    if (verificationCode === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const subject = this.#emailVerifications.get(verificationCode);
    if (subject === undefined) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    const expectedProviderSubject = ownString(input, "expectedProviderSubject");
    if (expectedProviderSubject === undefined
      || !constantTimeEqual(expectedProviderSubject, subject.providerSubject)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const verifiedSubject = copySubject({ ...subject, verifiedAt: this.#now().toISOString() });
    this.#emailVerifications.delete(verificationCode);
    this.#verifiedEmailSubjects.set(subject.providerSubject, verifiedSubject);
    return verifiedSubject;
  }

  async recoverVerifiedEmailSubject(input: EmailVerificationRecoveryInput): Promise<VerifiedProviderSubject> {
    const expectedProviderSubject = ownString(input, "expectedProviderSubject");
    const expectedNormalizedEmail = ownString(input, "expectedNormalizedEmail");
    const verificationStartedAt = ownString(input, "verificationStartedAt");
    const recoveryNotAfter = ownString(input, "recoveryNotAfter");
    const started = verificationStartedAt === undefined ? undefined : strictUtcTimestampMilliseconds(verificationStartedAt);
    const notAfter = recoveryNotAfter === undefined ? undefined : strictUtcTimestampMilliseconds(recoveryNotAfter);
    if (expectedProviderSubject === undefined || expectedProviderSubject.length < 1
      || expectedProviderSubject.length > 1_024 || expectedNormalizedEmail === undefined
      || expectedNormalizedEmail !== normalizeEmail(expectedNormalizedEmail) || !validEmail(expectedNormalizedEmail)
      || started === undefined || notAfter === undefined || started > notAfter) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    const subject = this.#verifiedEmailSubjects.get(expectedProviderSubject);
    if (subject === undefined) throw new ProviderFailure("AUTH_EMAIL_UNVERIFIED");
    const confirmedAt = strictUtcTimestampMilliseconds(subject.verifiedAt);
    if (subject.normalizedEmail !== expectedNormalizedEmail || confirmedAt === undefined
      || confirmedAt < started || confirmedAt > notAfter) throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    return copySubject(subject);
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

  async beginPasswordReset(input: PasswordResetStartInput): Promise<PasswordResetStart> {
    const email = ownString(input, "email");
    const expectedSubject = ownData(input, "expectedSubject");
    const expectedProviderSubject = ownString(expectedSubject, "providerSubject");
    const expectedEmail = ownString(expectedSubject, "normalizedEmail");
    const expectedProvider = ownString(expectedSubject, "provider");
    const expectedKind = ownString(expectedSubject, "identityKind");
    if (typeof email !== "string" || !validEmail(normalizeEmail(email))) {
      throw new ProviderFailure("AUTH_INVALID");
    }
    if (expectedProvider !== "supabase" || expectedKind !== "email_password"
      || expectedProviderSubject === undefined || expectedProviderSubject.length < 1
      || expectedEmail !== normalizeEmail(email)) throw new ProviderFailure("AUTH_INVALID");
    const idempotency = readIdempotency(input);
    if (idempotency !== undefined) assertFakeStartHash(idempotency.payloadHash, canonicalProviderStartPayloadHash({
      flowKind: "password_reset",
      idempotencyKey: idempotency.key,
      normalizedEmail: normalizeEmail(email),
    }));
    const startKey = idempotency === undefined ? undefined : `password_reset:${idempotency.key}`;
    const replay = startKey === undefined ? undefined : this.#providerStarts.get(startKey);
    if (replay !== undefined) {
      if (replay.payloadHash !== idempotency!.payloadHash) throw new ProviderFailure("AUTH_CONFLICT");
      return replay.response as PasswordResetStart;
    }
    this.#transactionCounter += 1;
    const transactionId = `password_reset_fake_${this.#transactionCounter.toString().padStart(4, "0")}`;
    const state = digest(`reset-state:${transactionId}`);
    const expiresAt = this.#now().getTime() + oauthTtlMs;
    this.#transactions.set(transactionId, {
      flowKind: "password_reset",
      actorId: null,
      passwordResetEmail: normalizeEmail(email),
      passwordResetProviderSubject: expectedProviderSubject,
      clientKind: "web",
      redirectUri: "https://fake-auth.invalid/password-reset",
      stateDigest: digest(state),
      nonceDigest: digest(`reset-nonce:${transactionId}`),
      pkceChallenge: null,
      providerSubjectDigest: null,
      expiresAt,
    });
    const response = Object.freeze({
      transaction_id: transactionId,
      state,
      expires_at: new Date(expiresAt).toISOString(),
    });
    if (startKey !== undefined) this.#providerStarts.set(startKey, { payloadHash: idempotency!.payloadHash, response });
    return response;
  }

  async beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart> {
    return this.#beginApple(input, "sign_in", null, null);
  }

  async reauthenticateAndBeginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart> {
    const actorId = ownString(input, "authenticatedActorId") ?? null;
    if (actorId === null) throw new ProviderFailure("AUTH_INVALID");
    readAppleStart(input, "link");
    const subject = await this.signInEmail(readCredential(input));
    return this.#beginApple(input, "link", actorId, digest(subject.providerSubject));
  }

  async completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject> {
    const binding = ownData(input, "binding");
    const transactionId = ownString(binding, "transaction_id");
    const authorizationCode = ownString(input, "authorization_code");
    const state = ownString(binding, "state");
    const expiresAt = ownString(binding, "expires_at");
    const password = ownString(input, "new_password");
    const payloadHash = ownString(input, "payloadHash");
    if (transactionId === undefined || authorizationCode === undefined || authorizationCode.length < 8
      || state === undefined || expiresAt === undefined || !Number.isFinite(new Date(expiresAt).getTime())
      || password === undefined
      || password.length < 8 || password.length > 1_024
      || payloadHash === undefined || !/^sha256:[a-f0-9]{64}$/u.test(payloadHash)) {
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
    if (email === null || fixture === undefined
      || fixture.subject.providerSubject !== transaction.passwordResetProviderSubject) throw new ProviderFailure("AUTH_INVALID");
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
    providerSubjectDigest: string | null,
  ): AppleAuthorizationStart {
    const { idempotency, clientKind, redirectUri, callerNonce, callerChallenge } = readAppleStart(input, flowKind);
    const startKey = `${flowKind}:${actorId ?? "anonymous"}:${idempotency.key}`;
    const replay = this.#providerStarts.get(startKey);
    if (replay !== undefined) {
      if (replay.payloadHash !== idempotency.payloadHash) throw new ProviderFailure("AUTH_CONFLICT");
      return replay.response as AppleAuthorizationStart;
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
      passwordResetProviderSubject: null,
      clientKind,
      redirectUri,
      stateDigest: digest(state),
      nonceDigest: digest(nonce),
      pkceChallenge: callerChallenge ?? null,
      providerSubjectDigest,
      expiresAt,
    });
    const authorizationUrl = new URL("https://fake-auth.invalid/apple");
    authorizationUrl.searchParams.set("nonce", nonce);

    if (callerChallenge !== undefined) {
      authorizationUrl.searchParams.set("code_challenge", callerChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
    }

    const response = Object.freeze({
      transaction_id: transactionId,
      authorization_url: authorizationUrl.toString(),
      expires_at: new Date(expiresAt).toISOString(),
    });
    this.#providerStarts.set(startKey, { payloadHash: idempotency.payloadHash, response });
    return response;
  }

  async completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject> {
    this.#consumeAppleCallback(input, "sign_in", null);
    return copySubject(this.#appleSubject);
  }

  async linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject> {
    const actorId = ownString(input, "authenticatedActorId") ?? null;
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
        || transaction.pkceChallenge !== pkceChallenge(verifier!)))
      || (expectedFlow === "sign_in" && transaction.providerSubjectDigest !== null)) {
      throw new ProviderFailure("AUTH_CALLBACK_INVALID");
    }
    if (expectedFlow === "link" && (transaction.providerSubjectDigest === null
      || !constantTimeEqual(transaction.providerSubjectDigest, digest(this.#appleSubject.providerSubject)))) {
      throw new ProviderFailure("AUTH_CONFLICT");
    }
  }
}
