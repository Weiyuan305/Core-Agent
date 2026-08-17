import type { VerifiedAuthSubjectInput } from "@core-agent/runtime-core";

export type VerifiedProviderSubject = VerifiedAuthSubjectInput;
export type ProviderClientKind = "web" | "iphone" | "macos";

export interface EmailCredentialInput {
  readonly email: string;
  readonly password: string;
}

export interface ProviderProof {
  readonly accessToken: string;
}

interface AppleAuthorizationBase {
  readonly clientKind: ProviderClientKind;
  readonly redirectUri: string;
}

export type AppleAuthorizationInput =
  | (AppleAuthorizationBase & {
      readonly flowKind: "sign_in";
    })
  | (AppleAuthorizationBase & {
      readonly flowKind: "link";
      readonly authenticatedActorId: string;
      readonly providerProof: ProviderProof;
    });

export interface AppleAuthorizationStart {
  readonly transactionId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface AppleAuthorizationCallback {
  readonly transactionId: string;
  readonly authorizationCode: string;
  readonly state: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly clientKind: ProviderClientKind;
}

export interface AppleLinkInput extends AppleAuthorizationCallback {
  readonly authenticatedActorId: string;
  readonly providerProof: ProviderProof;
}

export interface AuthProviderAdapter {
  signUpEmail(input: EmailCredentialInput): Promise<{ readonly kind: "verification_pending" }>;
  signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart>;
  completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject>;
  verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject>;
  reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginPasswordReset(email: string): Promise<void>;
  linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject>;
  revokeCurrentProviderSession(input: ProviderProof): Promise<void>;
  deleteProviderSubject(providerSubject: string): Promise<void>;
}
