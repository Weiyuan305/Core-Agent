import type { GatewayToolDescriptor } from "@core-agent/contracts";
import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { listReviewedToolBindings } from "../../repositories/policy/catalog.js";
import { loadCurrentSnapshotAuthority } from "../entitlements/current-authority.js";

export async function listAuthorizedTools(
  db: Kysely<RuntimeDatabase>, tenantId: string, hermesSessionRef: string,
): Promise<readonly GatewayToolDescriptor[]> {
  return db.transaction().execute(async (trx) => {
    const now = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]!.now;
    const session = await trx.selectFrom("policy_sessions").selectAll().where("tenant_id", "=", tenantId)
      .where("hermes_session_ref", "=", hermesSessionRef).executeTakeFirst();
    if (session?.state !== "active" || session.expires_at <= now) return Object.freeze([]);
    const authority = await loadCurrentSnapshotAuthority({ trx, tenantId, profileId: session.profile_id, now });
    if (!authority.current || authority.snapshotRef.snapshot_id !== session.snapshot_id
      || authority.snapshotRef.version !== Number(session.snapshot_version)
      || authority.snapshotRef.evaluated_at !== session.snapshot_evaluated_at.toISOString()) return Object.freeze([]);
    const versions = await trx.selectFrom("entitlement_snapshot_capabilities").select("capability_version_id")
      .where("tenant_id", "=", tenantId).where("profile_id", "=", session.profile_id)
      .where("snapshot_id", "=", session.snapshot_id).orderBy("capability_order", "asc").execute();
    const bindings = await listReviewedToolBindings(trx, versions.map((row) => row.capability_version_id));
    return Object.freeze(bindings.map((binding) => Object.freeze({
      name: binding.publicToolName, title: binding.title, description: binding.description,
      inputSchema: binding.inputSchema,
      annotations: Object.freeze({ readOnlyHint: true as const, destructiveHint: false as const, idempotentHint: true as const, openWorldHint: false as const }),
    })));
  });
}
