import type { Transaction } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

/** Proves the v1 B2C invariant: one active student Membership and one active default Profile. */
export async function assertAutomaticB2cProfile(
  trx: Transaction<RuntimeDatabase>,
  tenantId: string,
  profileId: string,
): Promise<void> {
  const memberships = await trx.selectFrom("memberships")
    .select(["membership_id", "actor_id", "roles", "membership_source", "status"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "active")
    .orderBy("membership_id", "asc")
    .forUpdate().execute();
  const students = memberships.filter((membership) => (
    membership.membership_source === "self" && membership.roles.includes("student")
  ));
  const profiles = await trx.selectFrom("profiles")
    .select(["profile_id", "owner_actor_id", "profile_kind", "status"])
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "active")
    .orderBy("profile_id", "asc")
    .forUpdate().execute();
  const defaults = profiles.filter((profile) => profile.profile_kind === "default");
  if (
    students.length !== 1
    || defaults.length !== 1
    || defaults[0]?.profile_id !== profileId
    || defaults[0]?.owner_actor_id !== students[0]?.actor_id
  ) throw new DomainError("ENTITLEMENT_DENIED", "B2C automatic Profile authority is invalid");
}
