import { createHmac, timingSafeEqual } from "node:crypto";

const proofPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface PolicyProofKey {
  withBytes<T>(use: (bytes: Uint8Array) => T): T;
}

function hmac(key: Uint8Array, domain: string, value: string): Buffer {
  return createHmac("sha256", key).update(domain).update("\0").update(value).digest();
}

export function deriveExecutionProof(
  key: PolicyProofKey, facts: { tenantId: string; policySessionId: string; decisionId: string; proofId: string; argumentsHash: string },
): string {
  const canonical = [facts.tenantId, facts.policySessionId, facts.decisionId, facts.proofId, facts.argumentsHash].join("\0");
  return key.withBytes((bytes) => hmac(bytes, "core-agent-policy-proof-v1", canonical).toString("base64url"));
}

export function executionProofDigest(key: PolicyProofKey, proof: unknown): Buffer | undefined {
  if (typeof proof !== "string" || !proofPattern.test(proof)) return undefined;
  return key.withBytes((bytes) => hmac(bytes, "core-agent-policy-proof-digest-v1", proof));
}

export function proofDigestMatches(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
