import type { GatewayToolDescriptor } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { listReviewedToolBindings } from "../../repositories/policy/catalog.js";
import { terminatePolicySession } from "./policy-effects.js";
import { loadCurrentPolicySessionAuthority, type PolicyRuntimeIdentity } from "./session-authority.js";

export async function listAuthorizedTools(
  db: Kysely<RuntimeDatabase>, identity: PolicyRuntimeIdentity, policySessionId: string,
): Promise<readonly GatewayToolDescriptor[]> {
  return db.transaction().execute(async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const session = await trx.selectFrom("policy_sessions").selectAll().where("tenant_id", "=", identity.tenantId)
      .where("policy_session_id", "=", policySessionId).forUpdate().executeTakeFirst();
    if (session === undefined) return Object.freeze([]);
    if (session.profile_id !== identity.profileId || session.runtime_container_id !== identity.runtimeContainerId
      || session.runtime_generation !== identity.runtimeGeneration) return Object.freeze([]);
    const authority = await loadCurrentPolicySessionAuthority(trx, session, now, identity);
    if (!authority.current) {
      if (session.state === "active") await terminatePolicySession(trx, session, now,
        session.expires_at <= now ? "expired" : "closed", session.expires_at <= now ? "run_expired" : "authority_changed");
      return Object.freeze([]);
    }
    const versions = await trx.selectFrom("entitlement_snapshot_capabilities").select("capability_version_id")
      .where("tenant_id", "=", identity.tenantId).where("profile_id", "=", session.profile_id)
      .where("snapshot_id", "=", session.snapshot_id).orderBy("capability_order", "asc").execute();
    const bindings = await listReviewedToolBindings(trx, versions.map((row) => row.capability_version_id));
    return Object.freeze(bindings.map((binding) => Object.freeze({
      name: binding.publicToolName, title: binding.title, description: binding.description,
      inputSchema: binding.inputSchema,
      annotations: Object.freeze({ readOnlyHint: true as const, destructiveHint: false as const, idempotentHint: true as const, openWorldHint: false as const }),
    })));
  });
}
