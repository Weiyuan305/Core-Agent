const MAX_OAUTH_PROOF_CODE_POINTS = 4_096;
const MAX_OAUTH_PROOF_UTF8_BYTES = MAX_OAUTH_PROOF_CODE_POINTS * 4;

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
