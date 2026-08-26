import { createHash, timingSafeEqual } from "node:crypto";

export interface RuntimeGatewayIdentity { readonly tenantId: string; readonly profileId: string }

function digest(value: string): Buffer { return createHash("sha256").update(value, "utf8").digest(); }

export function constantTimeTokenMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || actual.length < 16 || actual.length > 4096 || expected.length < 16) return false;
  return timingSafeEqual(digest(actual), digest(expected));
}

export function bearerToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("Bearer ") || value.length > 4103) return undefined;
  const token = value.slice(7);
  return token.length >= 16 && token.trim() === token ? token : undefined;
}
