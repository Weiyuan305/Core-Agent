import { randomUUID } from "node:crypto";

import type { OpenPolicySessionRequest, OpenPolicySessionResponse } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { canonicalPayloadHash, DomainError } from "../../domain/idempotency.js";
import { BUILTIN_READ_POLICY } from "../../policy/builtin-read-policy.js";
import { loadCurrentSnapshotAuthority } from "../entitlements/current-authority.js";
import { verifyTrustedContextSignature, type TrustedContextPublicKey } from "../identity/trusted-context.js";

export interface OpenPolicySessionDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly trustedContextKeys: readonly TrustedContextPublicKey[];
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly maximumSessionTtlMs?: number;
}

export async function openPolicySession(
  dependencies: OpenPolicySessionDependencies, request: OpenPolicySessionRequest,
): Promise<OpenPolicySessionResponse> {
  return withDatabaseTransactionRetry(dependencies.db, async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const envelope = verifyTrustedContextSignature({
      envelope: request.signed_context, keys: dependencies.trustedContextKeys,
      expectedIssuer: dependencies.expectedIssuer, expectedAudience: dependencies.expectedAudience, now,
    });
    const payload = envelope.payload;
    if (payload.container_id !== request.runtime_container_id) throw new DomainError("UNAUTHENTICATED", "Policy session context is invalid");
    const authority = await loadCurrentSnapshotAuthority({ trx, tenantId: payload.tenant_id, profileId: payload.profile_id, now });
    if (!authority.current || authority.snapshotRef.snapshot_id !== payload.entitlement_snapshot_ref.snapshot_id
      || authority.snapshotRef.version !== payload.entitlement_snapshot_ref.version
      || authority.snapshotRef.evaluated_at !== payload.entitlement_snapshot_ref.evaluated_at
      || JSON.stringify([...authority.capabilityIds].sort()) !== JSON.stringify([...payload.capability_ids].sort())) {
      throw new DomainError("POLICY_DENIED", "Current policy authority changed");
    }
    const runtime = await trx.selectFrom("runtime_containers").select(["generation", "observed_state", "health_status"])
      .where("tenant_id", "=", payload.tenant_id).where("container_id", "=", request.runtime_container_id).forShare().executeTakeFirst();
    const run = await trx.selectFrom("agent_runs").select(["conversation_id", "request_id", "trace_id", "status"])
      .where("tenant_id", "=", payload.tenant_id).where("run_id", "=", payload.run_id).forShare().executeTakeFirst();
    const session = await trx.selectFrom("sessions").select(["session_id", "profile_id", "actor_id", "conversation_id", "status", "expires_at"])
      .where("tenant_id", "=", payload.tenant_id).where("hermes_session_ref", "=", request.hermes_session_ref).forShare().executeTakeFirst();
    if (runtime?.generation !== request.runtime_generation || runtime.observed_state !== "ready" || runtime.health_status !== "healthy"
      || run?.conversation_id !== payload.conversation_id || run.request_id !== payload.request_id || run.trace_id !== payload.trace_id
      || !["queued", "running"].includes(run.status) || session?.profile_id !== payload.profile_id
      || session.actor_id !== payload.actor_id || session.conversation_id !== payload.conversation_id
      || session.status !== "active" || session.expires_at <= now) {
      throw new DomainError("POLICY_DENIED", "Policy session linkage is invalid");
    }
    const payloadHash = canonicalPayloadHash({
      tenant_id: payload.tenant_id, run_id: payload.run_id, session_id: session.session_id,
      runtime_container_id: request.runtime_container_id, runtime_generation: request.runtime_generation,
      hermes_session_ref: request.hermes_session_ref, snapshot: payload.entitlement_snapshot_ref,
    });
    const existing = await trx.selectFrom("policy_sessions").selectAll().where("tenant_id", "=", payload.tenant_id)
      .where("idempotency_key", "=", request.idempotency_key).forUpdate().executeTakeFirst();
    if (existing !== undefined) {
      if (existing.payload_hash !== payloadHash || existing.state !== "active" || existing.expires_at <= now) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Policy session replay conflicts with current state");
      }
      return { schema_version: 1, policy_session_id: existing.policy_session_id, state: "active", policy_version: BUILTIN_READ_POLICY.version, expires_at: existing.expires_at.toISOString() };
    }
    const maximumTtl = dependencies.maximumSessionTtlMs ?? 300_000;
    const expiresAt = new Date(Math.min(Date.parse(payload.expires_at), now.getTime() + maximumTtl));
    if (!(maximumTtl >= 1_000 && maximumTtl <= 300_000) || expiresAt <= now) throw new DomainError("UNAUTHENTICATED", "Policy session lifetime is invalid");
    const policySessionId = `policy-session-${randomUUID()}`;
    await trx.insertInto("policy_sessions").values({
      tenant_id: payload.tenant_id, policy_session_id: policySessionId, actor_id: payload.actor_id,
      membership_id: payload.membership_id, profile_id: payload.profile_id, session_id: session.session_id,
      conversation_id: payload.conversation_id, run_id: payload.run_id, runtime_container_id: request.runtime_container_id,
      runtime_generation: request.runtime_generation, hermes_session_ref: request.hermes_session_ref,
      snapshot_id: authority.snapshotRef.snapshot_id, snapshot_version: authority.snapshotRef.version,
      snapshot_evaluated_at: new Date(authority.snapshotRef.evaluated_at), policy_version_id: BUILTIN_READ_POLICY.version,
      state: "active", close_reason: null, idempotency_key: request.idempotency_key, payload_hash: payloadHash,
      request_id: payload.request_id, trace_id: payload.trace_id, correlation_id: request.correlation_id,
      expires_at: expiresAt, closed_at: null, resource_version: 1,
    }).execute();
    return { schema_version: 1, policy_session_id: policySessionId, state: "active", policy_version: BUILTIN_READ_POLICY.version, expires_at: expiresAt.toISOString() };
  });
}
