import type { VerifiedAuthSubjectInput } from "@core-agent/runtime-core";
import type {
  AppleAuthorizationCallbackRequest,
  AppleAuthorizationStartRequest,
  AppleAuthorizationStartResponse,
  AppleIdentityLinkRequest,
  AppleIdentityLinkStartRequest,
} from "@core-agent/contracts";

export type VerifiedProviderSubject = VerifiedAuthSubjectInput;
export type ProviderClientKind = "web" | "iphone" | "macos";

export interface EmailCredentialInput {
  readonly email: string;
  readonly password: string;
}

export interface EmailVerificationInput {
  readonly verificationCode: string;
}

export interface ProviderProof {
  readonly accessToken: string;
}

export type AppleAuthorizationInput = AppleAuthorizationStartRequest;
export type AppleAuthorizationStart = Pick<
  AppleAuthorizationStartResponse,
  "transaction_id" | "authorization_url" | "expires_at"
>;
export type AppleAuthorizationCallback = AppleAuthorizationCallbackRequest;

export type AppleLinkAuthorizationInput = AppleIdentityLinkStartRequest & {
  readonly authenticatedActorId: string;
  readonly email: string;
  readonly password: string;
};

export type AppleLinkInput = AppleIdentityLinkRequest & {
  readonly authenticatedActorId: string;
};

/**
 * Internal recovery binding. Task 7 must transport this only in a Secure,
 * HttpOnly, SameSite cookie and must never serialize it into public JSON.
 */
export interface PasswordResetStart {
  readonly transaction_id: string;
  readonly state: string;
  readonly expires_at: string;
}

export interface PasswordResetStartInput {
  readonly email: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

export interface PasswordResetCompletionInput {
  readonly binding: PasswordResetStart;
  readonly authorization_code: string;
  readonly new_password: string;
}

export interface AuthProviderAdapter {
  signUpEmail(input: EmailCredentialInput): Promise<{ readonly kind: "verification_pending" }>;
  verifyEmail(input: EmailVerificationInput): Promise<VerifiedProviderSubject>;
  signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart>;
  reauthenticateAndBeginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart>;
  completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject>;
  verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject>;
  reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginPasswordReset(input: string | PasswordResetStartInput): Promise<PasswordResetStart>;
  completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject>;
  linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject>;
  revokeCurrentProviderSession(input: ProviderProof): Promise<void>;
  deleteProviderSubject(providerSubject: string): Promise<void>;
}
