const MAX_OAUTH_PROOF_CODE_POINTS = 4_096;
const MAX_OAUTH_PROOF_UTF8_BYTES = MAX_OAUTH_PROOF_CODE_POINTS * 4;
const MAX_AUTHORIZATION_URL_CODE_POINTS = 2_048;
const MAX_AUTHORIZATION_URL_UTF8_BYTES = 2_048;

export function isOAuthProofString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let codePoints = 0;
  for (const _character of value) {
    codePoints += 1;
    if (codePoints > MAX_OAUTH_PROOF_CODE_POINTS) return false;
  }
  return codePoints >= 8 && Buffer.byteLength(value, "utf8") <= MAX_OAUTH_PROOF_UTF8_BYTES;
}

export function isPkceCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/u.test(value);
}

export function isProviderAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_AUTHORIZATION_URL_UTF8_BYTES) return false;
  let codePoints = 0;
  for (const _character of value) {
    codePoints += 1;
    if (codePoints > MAX_AUTHORIZATION_URL_CODE_POINTS) return false;
  }
  return true;
}
