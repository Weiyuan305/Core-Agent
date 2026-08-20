import { createHash } from "node:crypto";

import {
  FakeAuthProvider,
  type FakeAuthProviderOptions,
} from "../../../apps/identity-gateway/src/providers/fake-auth-provider.js";
import type {
  EmailCredentialInput,
  VerifiedProviderSubject,
} from "../../../apps/identity-gateway/src/providers/auth-provider.js";
import { ProviderFailure } from "../../../apps/identity-gateway/src/providers/provider-errors.js";

export const INTEGRATION_B2C_EMAIL = "student.task11@example.test";
export const INTEGRATION_B2C_PASSWORD = "task11-student-password";
export const INTEGRATION_B2B_EMAIL = "administrator.task11@example.test";
export const INTEGRATION_B2B_PASSWORD = "task11-administrator-password";

function fakeSignupProviderSubject(email: string): string {
  return `fake-email-${createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex").slice(0, 24)}`;
}

function subject(email: string, identityKind: "email_password" | "apple" = "email_password"): VerifiedProviderSubject {
  return Object.freeze({
    provider: "supabase",
    providerSubject: identityKind === "apple" ? "fake-apple-task11" : fakeSignupProviderSubject(email),
    identityKind,
    normalizedEmail: email,
    verifiedAt: "2026-08-20T05:00:00.000Z",
  });
}

export class IntegrationFakeAuthProvider extends FakeAuthProvider {
  #available = true;

  public constructor(options: FakeAuthProviderOptions) {
    super(options);
  }

  public setAvailable(available: boolean): void {
    this.#available = available;
  }

  public override async signInEmail(input: EmailCredentialInput): Promise<VerifiedProviderSubject> {
    if (!this.#available) throw new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
    return super.signInEmail(input);
  }
}

export function createIntegrationFakeAuthProvider(now: () => Date = () => new Date()): IntegrationFakeAuthProvider {
  return new IntegrationFakeAuthProvider({
    now,
    subjects: [
      {
        email: INTEGRATION_B2C_EMAIL,
        password: INTEGRATION_B2C_PASSWORD,
        proof: { accessToken: "task11-b2c-provider-proof" },
        subject: subject(INTEGRATION_B2C_EMAIL),
      },
      {
        email: INTEGRATION_B2B_EMAIL,
        password: INTEGRATION_B2B_PASSWORD,
        proof: { accessToken: "task11-b2b-provider-proof" },
        subject: subject(INTEGRATION_B2B_EMAIL),
      },
      {
        email: "second-administrator.task11@example.test",
        password: "task11-second-administrator-password",
        proof: { accessToken: "task11-second-b2b-provider-proof" },
        subject: subject("second-administrator.task11@example.test"),
      },
    ],
    appleSubject: subject("apple.task11@example.test", "apple"),
  });
}
