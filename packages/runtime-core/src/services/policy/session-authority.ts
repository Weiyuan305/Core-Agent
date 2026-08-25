import type { Selectable, Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import type { PolicySessionTable } from "../../db/policy-mcp-tables.js";
import { loadCurrentSnapshotAuthority, type CurrentSnapshotAuthority } from "../entitlements/current-authority.js";

export interface PolicyPluginIdentity {
  readonly tenantId: string;
  readonly runtimeContainerId: string;
  readonly runtimeGeneration: number;
}

export interface PolicyRuntimeIdentity extends PolicyPluginIdentity {
  readonly profileId: string;
}

export type CurrentPolicySessionAuthority = Readonly<
  | { current: true; snapshot: CurrentSnapshotAuthority; effectiveRole: "admin" | "consultant" | "student" }
  | { current: false }
>;

export async function loadCurrentPolicySessionAuthority(
  trx: Transaction<RuntimeDatabase>,
  session: Selectable<PolicySessionTable>,
  now: Date,
  identity?: PolicyPluginIdentity | PolicyRuntimeIdentity,
): Promise<CurrentPolicySessionAuthority> {
  if (session.state !== "active" || session.expires_at <= now
    || identity?.tenantId !== undefined && identity.tenantId !== session.tenant_id
    || identity?.runtimeContainerId !== undefined && identity.runtimeContainerId !== session.runtime_container_id
    || identity?.runtimeGeneration !== undefined && identity.runtimeGeneration !== session.runtime_generation
    || "profileId" in (identity ?? {}) && (identity as PolicyRuntimeIdentity).profileId !== session.profile_id) {
    return { current: false };
  }
  const tenant = await trx.selectFrom("tenants").select("status")
    .where("tenant_id", "=", session.tenant_id).executeTakeFirst();
  const actor = await trx.selectFrom("actors").select("status")
    .where("actor_id", "=", session.actor_id).executeTakeFirst();
  const membership = await trx.selectFrom("memberships").select(["actor_id", "roles", "status"])
    .where("tenant_id", "=", session.tenant_id).where("membership_id", "=", session.membership_id).executeTakeFirst();
  const profile = await trx.selectFrom("profiles").select(["owner_actor_id", "status"])
    .where("tenant_id", "=", session.tenant_id).where("profile_id", "=", session.profile_id).executeTakeFirst();
  const conversation = await trx.selectFrom("conversations").select(["profile_id", "created_by_actor_id", "status"])
    .where("tenant_id", "=", session.tenant_id).where("conversation_id", "=", session.conversation_id).executeTakeFirst();
  const run = await trx.selectFrom("agent_runs").select(["conversation_id", "request_id", "trace_id", "status"])
    .where("tenant_id", "=", session.tenant_id).where("run_id", "=", session.run_id).executeTakeFirst();
  const agentSession = await trx.selectFrom("sessions")
    .select(["profile_id", "actor_id", "conversation_id", "status", "expires_at", "hermes_session_ref"])
    .where("tenant_id", "=", session.tenant_id).where("session_id", "=", session.session_id).executeTakeFirst();
  const coreSession = await trx.selectFrom("core_sessions")
    .select(["actor_id", "status", "idle_expires_at", "absolute_expires_at"])
    .where("session_id", "=", session.core_session_id).executeTakeFirst();
  const runtime = await trx.selectFrom("runtime_containers")
    .select(["generation", "desired_state", "observed_state", "health_status"])
    .where("tenant_id", "=", session.tenant_id).where("container_id", "=", session.runtime_container_id).executeTakeFirst();
  if (tenant?.status !== "active" || actor?.status !== "active"
    || membership?.actor_id !== session.actor_id || membership.status !== "active"
    || !membership.roles.includes(session.effective_role)
    || profile?.owner_actor_id !== session.actor_id || profile.status !== "active"
    || conversation?.profile_id !== session.profile_id || conversation.created_by_actor_id !== session.actor_id
    || conversation.status !== "active"
    || run?.conversation_id !== session.conversation_id || run.request_id !== session.request_id
    || run.trace_id !== session.trace_id || run.status !== "running"
    || agentSession?.profile_id !== session.profile_id || agentSession.actor_id !== session.actor_id
    || agentSession.conversation_id !== session.conversation_id || agentSession.status !== "active"
    || agentSession.expires_at <= now || agentSession.hermes_session_ref !== session.hermes_session_ref
    || coreSession?.actor_id !== session.actor_id || coreSession.status !== "active"
    || coreSession.idle_expires_at <= now || coreSession.absolute_expires_at <= now
    || runtime?.generation !== session.runtime_generation || runtime.desired_state !== "running"
    || runtime.observed_state !== "ready" || runtime.health_status !== "healthy") {
    return { current: false };
  }
  const snapshot = await loadCurrentSnapshotAuthority({
    trx, tenantId: session.tenant_id, profileId: session.profile_id, now,
  });
  if (!snapshot.current || snapshot.snapshotRef.snapshot_id !== session.snapshot_id
    || snapshot.snapshotRef.version !== Number(session.snapshot_version)
    || snapshot.snapshotRef.evaluated_at !== session.snapshot_evaluated_at.toISOString()) {
    return { current: false };
  }
  return { current: true, snapshot, effectiveRole: session.effective_role };
}
