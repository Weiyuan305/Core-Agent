import { createHmac } from "node:crypto";

import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

export type PublicRateLimitBucketKind =
  | "signup"
  | "login"
  | "reset"
  | "email_verification"
  | "reset_complete"
  | "apple_start"
  | "apple_link"
  | "apple_callback"
  | "invitation_accept"
  | "reauthenticate";

export interface ConsumePublicRateLimitDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly hmacKey: Uint8Array;
}

export interface ConsumePublicRateLimitInput {
  readonly bucketKind: PublicRateLimitBucketKind;
  readonly accountIdentifier: string;
  readonly clientIdentifier: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly dimensions?: "both" | "account" | "client";
}

const bucketKinds = new Set<PublicRateLimitBucketKind>([
  "signup", "login", "reset", "email_verification", "reset_complete", "apple_start", "apple_link", "apple_callback", "invitation_accept", "reauthenticate",
]);

function invalidConfiguration(): never {
  throw new DomainError("INTERNAL_ERROR", "Public rate-limit configuration is invalid");
}

function invalidInput(): never {
  throw new DomainError("INVALID_REQUEST", "Public rate-limit input is invalid");
}

function assertInput(
  dependencies: ConsumePublicRateLimitDependencies,
  input: ConsumePublicRateLimitInput,
): void {
  if (dependencies.hmacKey.byteLength < 32) invalidConfiguration();
  if (
    !bucketKinds.has(input.bucketKind)
    || typeof input.accountIdentifier !== "string"
    || input.accountIdentifier.length < 1
    || input.accountIdentifier.length > 4_096
    || typeof input.clientIdentifier !== "string"
    || input.clientIdentifier.length < 1
    || input.clientIdentifier.length > 4_096
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000_000
    || !Number.isSafeInteger(input.windowMs)
    || input.windowMs < 1_000
    || input.windowMs > 30 * 24 * 60 * 60 * 1_000
    || input.dimensions !== undefined && input.dimensions !== "both"
      && input.dimensions !== "account" && input.dimensions !== "client"
  ) invalidInput();
}

function safeRetryAfter(value: string): number {
  if (!/^\d+$/u.test(value)) throw new DomainError("INTERNAL_ERROR", "Public rate-limit result is invalid");
  const retryAfterMs = Number(value);
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new DomainError("INTERNAL_ERROR", "Public rate-limit result is invalid");
  }
  return retryAfterMs;
}

/**
 * Atomically consumes one fixed-window attempt. A null result is allowed; a
 * numeric result is the only public exhaustion fact and is safe for retry_after_ms.
 */
export async function consumePublicRateLimit(
  dependencies: ConsumePublicRateLimitDependencies,
  input: ConsumePublicRateLimitInput,
): Promise<number | null> {
  assertInput(dependencies, input);
  const accountIdentifierHmac = createHmac("sha256", dependencies.hmacKey)
    .update(`account:${input.accountIdentifier}`, "utf8")
    .digest();
  const clientIdentifierHmac = createHmac("sha256", dependencies.hmacKey)
    .update(`client:${input.clientIdentifier}`, "utf8")
    .digest();
  const anyAccountHmac = createHmac("sha256", dependencies.hmacKey)
    .update("account:*", "utf8").digest();
  const anyClientHmac = createHmac("sha256", dependencies.hmacKey)
    .update("client:*", "utf8").digest();
  const dimensions = input.dimensions ?? "both";
  const dimensionRows = dimensions === "account"
    ? sql`(${accountIdentifierHmac}::bytea, ${anyClientHmac}::bytea)`
    : dimensions === "client"
      ? sql`(${anyAccountHmac}::bytea, ${clientIdentifierHmac}::bytea)`
      : sql`(${accountIdentifierHmac}::bytea, ${anyClientHmac}::bytea),
          (${anyAccountHmac}::bytea, ${clientIdentifierHmac}::bytea)`;
  const expectedRowCount = dimensions === "both" ? 2 : 1;
  try {
    const result = await sql<{ request_count: number; retry_after_ms: string }>`
      with boundary as materialized (
        select clock_timestamp() as now
      ), fixed_window as materialized (
        select
          now,
          to_timestamp(
            floor(extract(epoch from now) * 1000 / ${input.windowMs})
            * ${input.windowMs} / 1000
          ) as window_started_at
        from boundary
      ), consumed as (
        insert into public_rate_limits (
          bucket_kind, account_identifier_hmac, client_identifier_hmac,
          window_started_at, request_count, expires_at, updated_at
        )
        select ${input.bucketKind}, dimension.account_hmac, dimension.client_hmac,
          fixed_window.window_started_at, 1,
          fixed_window.window_started_at + ${input.windowMs} * interval '1 millisecond',
          fixed_window.now
        from fixed_window
        cross join (values ${dimensionRows}) as dimension(account_hmac, client_hmac)
        on conflict (
          bucket_kind, account_identifier_hmac, client_identifier_hmac, window_started_at
        ) do update set
          request_count = public_rate_limits.request_count + 1,
          updated_at = excluded.updated_at
        returning request_count, expires_at
      )
      select
        request_count,
        greatest(
          0,
          ceil(extract(epoch from (expires_at - clock_timestamp())) * 1000)
        )::bigint::text as retry_after_ms
      from consumed
    `.execute(dependencies.db);
    if (result.rows.length !== expectedRowCount || result.rows.some((row) => (
      !Number.isSafeInteger(row.request_count) || row.request_count < 1
    ))) {
      throw new DomainError("INTERNAL_ERROR", "Public rate-limit result is invalid");
    }
    const exhausted = result.rows.filter((row) => row.request_count > input.limit);
    return exhausted.length === 0 ? null : Math.max(...exhausted.map((row) => safeRetryAfter(row.retry_after_ms)));
  } finally {
    accountIdentifierHmac.fill(0);
    clientIdentifierHmac.fill(0);
    anyAccountHmac.fill(0);
    anyClientHmac.fill(0);
  }
}
