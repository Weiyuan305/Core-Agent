import { canonicalPayloadHash, type VerifiedAuthSubjectInput } from "@core-agent/runtime-core";
import type {
  AppleAuthorizationCallbackRequest,
  AppleAuthorizationStartRequest,
  AppleIdentityLinkRequest,
  AppleIdentityLinkStartRequest,
} from "@core-agent/contracts";

export type VerifiedProviderSubject = VerifiedAuthSubjectInput;
export type ProviderClientKind = "web" | "iphone" | "macos";

export type ProviderStartPayloadFacts =
  | {
    readonly flowKind: "password_reset";
    readonly idempotencyKey: string;
    readonly normalizedEmail: string;
  }
  | {
    readonly flowKind: "apple_sign_in" | "apple_link";
    readonly idempotencyKey: string;
    readonly clientKind: ProviderClientKind;
    readonly redirectUri: string;
    readonly deviceLabel?: string;
    readonly nonce?: string;
    readonly pkceChallenge?: string;
    readonly passwordProofHmac?: string;
  };

export function canonicalProviderStartPayloadHash(input: ProviderStartPayloadFacts): string {
  return canonicalPayloadHash({
    schema_version: 1,
    flow_kind: input.flowKind,
    idempotency_key: input.idempotencyKey,
    ...(input.flowKind === "password_reset" ? {
      normalized_email: input.normalizedEmail,
    } : {
      client_kind: input.clientKind,
      redirect_uri: input.redirectUri,
      ...(input.deviceLabel === undefined ? {} : { device_label: input.deviceLabel }),
      ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
      ...(input.pkceChallenge === undefined ? {} : {
        pkce_code_challenge: input.pkceChallenge,
        pkce_code_challenge_method: "S256",
      }),
      ...(input.passwordProofHmac === undefined ? {} : {
        proof_binding_hmac: input.passwordProofHmac,
      }),
    }),
  });
}

export interface EmailCredentialInput {
  readonly email: string;
  readonly password: string;
}

export interface EmailVerificationInput {
  readonly verificationCode: string;
  readonly expectedProviderSubject: string;
}

export interface ProviderProof {
  readonly accessToken: string;
}

export type AppleAuthorizationInput = AppleAuthorizationStartRequest;
export interface AppleAuthorizationStart {
  readonly transaction_id: string;
  readonly authorization_url: string;
  readonly expires_at: string;
}
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
  readonly expectedSubject: VerifiedProviderSubject;
}

export interface PasswordResetCompletionInput {
  readonly binding: PasswordResetStart & { readonly settlement_not_after: string };
  readonly authorization_code: string;
  readonly new_password: string;
  readonly payloadHash: string;
}

/**
 * Closed, internal observation of a previously admitted password-reset
 * provider effect. The Core database clock remains authoritative for expiry
 * and evidence-time classification.
 */
export type PasswordResetProviderObservation =
  | {
    readonly kind: "password_reset_provider_observation";
    readonly outcome: "ambiguous";
  }
  | {
    readonly kind: "password_reset_provider_observation";
    readonly outcome: "exact";
    readonly verifiedSubject: VerifiedProviderSubject;
    readonly providerEvidenceAt: string;
  }
  | {
    readonly kind: "password_reset_provider_observation";
    readonly outcome: "invalid";
    readonly reason: "provider_subject_mismatch" | "provider_email_mismatch" | "provider_evidence_malformed";
  };

/** Closed observation; the Core PostgreSQL clock decides whether settlement remains open. */
export interface AppleLinkProviderObservation {
  readonly kind: "apple_link_provider_observation";
  readonly outcome: "in_progress";
  readonly transactionId: string;
  readonly payloadHash: string;
}

export interface AuthProviderAdapter {
  signUpEmail(input: EmailCredentialInput): Promise<{
    readonly kind: "verification_pending";
    readonly expectedProviderSubject: string;
  }>;
  verifyEmail(input: EmailVerificationInput): Promise<VerifiedProviderSubject>;
  signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginApple(input: AppleAuthorizationInput): Promise<AppleAuthorizationStart>;
  reauthenticateAndBeginAppleLink(input: AppleLinkAuthorizationInput): Promise<AppleAuthorizationStart>;
  completeApple(input: AppleAuthorizationCallback): Promise<VerifiedProviderSubject>;
  verifyCurrentSubject(input: ProviderProof): Promise<VerifiedProviderSubject>;
  reauthenticatePassword(input: EmailCredentialInput): Promise<VerifiedProviderSubject>;
  beginPasswordReset(input: PasswordResetStartInput): Promise<PasswordResetStart>;
  completePasswordReset(input: PasswordResetCompletionInput): Promise<VerifiedProviderSubject | PasswordResetProviderObservation>;
  linkApple(input: AppleLinkInput): Promise<VerifiedProviderSubject | AppleLinkProviderObservation>;
  revokeCurrentProviderSession(input: ProviderProof): Promise<void>;
  deleteProviderSubject(providerSubject: string): Promise<void>;
}
