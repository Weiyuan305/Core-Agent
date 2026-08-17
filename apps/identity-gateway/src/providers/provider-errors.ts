export type ProviderFailureCode =
  | "AUTH_INVALID"
  | "AUTH_EMAIL_UNVERIFIED"
  | "AUTH_RATE_LIMITED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "AUTH_CALLBACK_INVALID"
  | "AUTH_CONFLICT";

const providerFailureCodes = new Set<ProviderFailureCode>([
  "AUTH_INVALID",
  "AUTH_EMAIL_UNVERIFIED",
  "AUTH_RATE_LIMITED",
  "AUTH_PROVIDER_UNAVAILABLE",
  "AUTH_CALLBACK_INVALID",
  "AUTH_CONFLICT",
]);

export class ProviderFailure extends Error {
  readonly code: ProviderFailureCode;

  constructor(code: ProviderFailureCode) {
    super(code);
    this.name = "ProviderFailure";
    this.code = code;
  }

  toJSON(): { readonly code: ProviderFailureCode } {
    return { code: this.code };
  }
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

export function mapProviderFailure(
  error: unknown,
  fallback: ProviderFailureCode = "AUTH_PROVIDER_UNAVAILABLE",
): ProviderFailure {
  const status = ownData(error, "status");
  const code = ownData(error, "code");

  if (typeof code === "string" && providerFailureCodes.has(code as ProviderFailureCode)) {
    return new ProviderFailure(code as ProviderFailureCode);
  }

  if (status === 429 || code === "over_request_rate_limit" || code === "rate_limit_exceeded") {
    return new ProviderFailure("AUTH_RATE_LIMITED");
  }
  if (code === "email_not_confirmed") return new ProviderFailure("AUTH_EMAIL_UNVERIFIED");
  if (code === "user_already_exists" || code === "email_exists" || code === "identity_already_exists") {
    return new ProviderFailure("AUTH_CONFLICT");
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return new ProviderFailure(fallback === "AUTH_CALLBACK_INVALID" ? fallback : "AUTH_INVALID");
  }
  if (typeof status === "number" && status >= 500) {
    return new ProviderFailure("AUTH_PROVIDER_UNAVAILABLE");
  }
  return new ProviderFailure(fallback);
}
