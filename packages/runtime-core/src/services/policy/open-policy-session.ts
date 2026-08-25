import { randomUUID } from "node:crypto";

import type { OpenPolicySessionRequest, OpenPolicySessionResponse } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { withDatabaseTransactionRetry } from "../../db/transaction-retry.js";
import { canonicalPayloadHash, DomainError } from "../../domain/idempotency.js";
import { BUILTIN_READ_POLICY } from "../../policy/builtin-read-policy.js";
import { loadCurrentSnapshotAuthority } from "../entitlements/current-authority.js";
import { verifyTrustedContextSignature, type TrustedContextPublicKey } from "../identity/trusted-context.js";
import { appendPolicySessionEffect } from "./policy-effects.js";

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
    if (payload.container_id !== request.runtime_container_id || payload.core_session_id === undefined) {
      throw new DomainError("UNAUTHENTICATED", "Policy session context is invalid");
    }
    const authority = await loadCurrentSnapshotAuthority({ trx, tenantId: payload.tenant_id, profileId: payload.profile_id, now });
    if (!authority.current || authority.snapshotRef.snapshot_id !== payload.entitlement_snapshot_ref.snapshot_id
      || authority.snapshotRef.version !== payload.entitlement_snapshot_ref.version
      || authority.snapshotRef.evaluated_at !== payload.entitlement_snapshot_ref.evaluated_at
      || JSON.stringify([...authority.capabilityIds].sort()) !== JSON.stringify([...payload.capability_ids].sort())) {
      throw new DomainError("POLICY_DENIED", "Current policy authority changed");
    }
    const tenant = await trx.selectFrom("tenants").select("status")
      .where("tenant_id", "=", payload.tenant_id).forShare().executeTakeFirst();
    const actor = await trx.selectFrom("actors").select("status")
      .where("actor_id", "=", payload.actor_id).forShare().executeTakeFirst();
    const membership = await trx.selectFrom("memberships").select(["actor_id", "roles", "status"])
      .where("tenant_id", "=", payload.tenant_id).where("membership_id", "=", payload.membership_id)
      .forShare().executeTakeFirst();
    const profile = await trx.selectFrom("profiles").select(["owner_actor_id", "status"])
      .where("tenant_id", "=", payload.tenant_id).where("profile_id", "=", payload.profile_id)
      .forShare().executeTakeFirst();
    const conversation = await trx.selectFrom("conversations").select(["profile_id", "created_by_actor_id", "status"])
      .where("tenant_id", "=", payload.tenant_id).where("conversation_id", "=", payload.conversation_id)
      .forShare().executeTakeFirst();
    const runtime = await trx.selectFrom("runtime_containers").select(["generation", "desired_state", "observed_state", "health_status"])
      .where("tenant_id", "=", payload.tenant_id).where("container_id", "=", request.runtime_container_id).forShare().executeTakeFirst();
    const run = await trx.selectFrom("agent_runs").select(["conversation_id", "request_id", "trace_id", "status"])
      .where("tenant_id", "=", payload.tenant_id).where("run_id", "=", payload.run_id).forShare().executeTakeFirst();
    const session = await trx.selectFrom("sessions").select(["session_id", "profile_id", "actor_id", "conversation_id", "status", "expires_at"])
      .where("tenant_id", "=", payload.tenant_id).where("hermes_session_ref", "=", request.hermes_session_ref).forShare().executeTakeFirst();
    const coreSession = await trx.selectFrom("core_sessions").select(["actor_id", "status", "idle_expires_at", "absolute_expires_at"])
      .where("session_id", "=", payload.core_session_id).forShare().executeTakeFirst();
    if (tenant?.status !== "active" || actor?.status !== "active"
      || membership?.actor_id !== payload.actor_id || membership.status !== "active"
      || !membership.roles.includes(payload.effective_role)
      || profile?.owner_actor_id !== payload.actor_id || profile.status !== "active"
      || conversation?.profile_id !== payload.profile_id || conversation.created_by_actor_id !== payload.actor_id
      || conversation.status !== "active"
      || runtime?.generation !== request.runtime_generation || runtime.desired_state !== "running"
      || runtime.observed_state !== "ready" || runtime.health_status !== "healthy"
      || run?.conversation_id !== payload.conversation_id || run.request_id !== payload.request_id || run.trace_id !== payload.trace_id
      || !["queued", "running"].includes(run.status) || session?.profile_id !== payload.profile_id
      || session.actor_id !== payload.actor_id || session.conversation_id !== payload.conversation_id
      || session.status !== "active" || session.expires_at <= now || coreSession?.actor_id !== payload.actor_id
      || coreSession.status !== "active" || coreSession.idle_expires_at <= now || coreSession.absolute_expires_at <= now) {
      throw new DomainError("POLICY_DENIED", "Policy session linkage is invalid");
    }
    const payloadHash = canonicalPayloadHash({
      tenant_id: payload.tenant_id, actor_id: payload.actor_id, membership_id: payload.membership_id,
      effective_role: payload.effective_role, profile_id: payload.profile_id,
      conversation_id: payload.conversation_id, run_id: payload.run_id, session_id: session.session_id,
      core_session_id: payload.core_session_id,
      runtime_container_id: request.runtime_container_id, runtime_generation: request.runtime_generation,
      hermes_session_ref: request.hermes_session_ref, snapshot: payload.entitlement_snapshot_ref,
      request_id: payload.request_id, trace_id: payload.trace_id,
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
    const expiresAt = new Date(Math.min(
      Date.parse(payload.expires_at), session.expires_at.getTime(), coreSession.idle_expires_at.getTime(),
      coreSession.absolute_expires_at.getTime(), now.getTime() + maximumTtl,
    ));
    if (!(maximumTtl >= 1_000 && maximumTtl <= 300_000) || expiresAt <= now) throw new DomainError("UNAUTHENTICATED", "Policy session lifetime is invalid");
    const policySessionId = `policy-session-${randomUUID()}`;
    const inserted = await trx.insertInto("policy_sessions").values({
      tenant_id: payload.tenant_id, policy_session_id: policySessionId, actor_id: payload.actor_id,
      membership_id: payload.membership_id, effective_role: payload.effective_role,
      profile_id: payload.profile_id, session_id: session.session_id,
      core_session_id: payload.core_session_id,
      conversation_id: payload.conversation_id, run_id: payload.run_id, runtime_container_id: request.runtime_container_id,
      runtime_generation: request.runtime_generation, hermes_session_ref: request.hermes_session_ref,
      snapshot_id: authority.snapshotRef.snapshot_id, snapshot_version: authority.snapshotRef.version,
      // PostgreSQL timestamptz retains microseconds while JavaScript Date and the
      // signed JSON envelope are millisecond-precision. Copy the authoritative
      // value inside PostgreSQL so the exact snapshot foreign key cannot be
      // broken by a lossy database -> JS -> database round trip.
      snapshot_evaluated_at: sql<Date>`(
        select evaluated_at from entitlement_snapshots
        where tenant_id = ${payload.tenant_id}
          and profile_id = ${payload.profile_id}
          and snapshot_id = ${authority.snapshotRef.snapshot_id}
      )`,
      policy_version_id: BUILTIN_READ_POLICY.version,
      state: "active", close_reason: null, idempotency_key: request.idempotency_key, payload_hash: payloadHash,
      request_id: payload.request_id, trace_id: payload.trace_id, correlation_id: request.correlation_id,
      expires_at: expiresAt, closed_at: null, resource_version: 1,
    }).returningAll().executeTakeFirstOrThrow();
    await appendPolicySessionEffect(trx, inserted, now, { kind: "opened", resourceVersion: 1 });
    return { schema_version: 1, policy_session_id: policySessionId, state: "active", policy_version: BUILTIN_READ_POLICY.version, expires_at: expiresAt.toISOString() };
  });
}
