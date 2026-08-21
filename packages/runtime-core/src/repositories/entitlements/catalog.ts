import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";

export async function lockCapabilityVersion(trx: Transaction<RuntimeDatabase>, capabilityVersionId: string) {
  return trx.selectFrom("capability_versions").selectAll().where("capability_version_id", "=", capabilityVersionId).forUpdate().executeTakeFirst();
}
export async function lockPackVersion(trx: Transaction<RuntimeDatabase>, packVersionId: string) {
  return trx.selectFrom("pack_versions").selectAll().where("pack_version_id", "=", packVersionId).forUpdate().executeTakeFirst();
}
export async function lockPackMembersAndCapabilities(trx: Transaction<RuntimeDatabase>, packVersionId: string) {
  const members = await trx.selectFrom("pack_members").selectAll().where("pack_version_id", "=", packVersionId)
    .orderBy("capability_version_id", "asc").orderBy("capability_id", "asc").orderBy("version", "asc").forUpdate().execute();
  const identifiers = [...new Set(members.map((member) => member.capability_version_id))].sort();
  const capabilities = identifiers.length === 0 ? [] : await trx.selectFrom("capability_versions").selectAll()
    .where("capability_version_id", "in", identifiers).orderBy("capability_version_id", "asc").forUpdate().execute();
  return { members, capabilities };
}
