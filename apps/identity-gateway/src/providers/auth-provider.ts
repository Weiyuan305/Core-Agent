import type { VerifiedAuthSubjectInput } from "@core-agent/runtime-core";
import type {
  AppleAuthorizationCallbackRequest,
  AppleAuthorizationStartRequest,
  AppleAuthorizationStartResponse,
  AppleIdentityLinkRequest,
} from "@core-agent/contracts";

export type VerifiedProviderSubject = VerifiedAuthSubjectInput;
export type ProviderClientKind = "web" | "iphone" | "macos";

export interface EmailCredentialInput {
  readonly email: string;
  readonly password: string;
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

export type AppleLinkAuthorizationInput = AppleAuthorizationInput & {
  readonly authenticatedActorId: string;
  readonly providerProof: ProviderProof;
};

export type AppleLinkInput = AppleIdentityLinkRequest & {
  readonly authenticatedActorId: string;
  readonly providerProof: ProviderProof;
};

export interface PasswordResetCompletionInput {
  readonly transaction_id: string;
  readonly authorization_code: string;
  readonly state: string;
  readonly redirect_uri: string;
  readonly new_password: string;
}

export interface AuthProviderAdapter {
  signUpEmail(input: EmailCredentialInput): Promise<{ readonly kind: "verification_pending" }>;
  signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart>;
  beginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart>;
  completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject>;
  verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject>;
  reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginPasswordReset(email: string): Promise<void>;
  completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject>;
  linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject>;
  revokeCurrentProviderSession(input: ProviderProof): Promise<void>;
  deleteProviderSubject(providerSubject: string): Promise<void>;
}
