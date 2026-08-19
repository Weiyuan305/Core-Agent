import { sql, type Kysely } from "kysely";

import type { RuntimeDatabase } from "../../db/database.js";
import { DomainError } from "../../domain/idempotency.js";

export interface StoredAccountDeletionFinalizationFacts {
  readonly kind: "due" | "not_due" | "cancelled" | "deleted" | "not_found";
  readonly providerSubjects: readonly string[];
  readonly nextCursor: string | null;
  readonly done: boolean;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/u.test(value);
}

/** Reads the durable provider-cleanup set using the PostgreSQL clock. */
export async function readAccountDeletionFinalizationFacts(
  db: Kysely<RuntimeDatabase>,
  accountDeletionId: string,
  cursor: string | null = null,
  limit = 50,
): Promise<StoredAccountDeletionFinalizationFacts> {
  if (!validId(accountDeletionId) || cursor !== null && !validId(cursor)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new DomainError("INVALID_REQUEST", "Account deletion finalization page is invalid");
  }
  return db.transaction().execute(async (trx) => {
    const deletion = await trx.selectFrom("account_deletions")
      .select(["actor_id", "status", "scheduled_for"])
      .where("account_deletion_id", "=", accountDeletionId)
      .forUpdate().executeTakeFirst();
    if (deletion === undefined) return { kind: "not_found", providerSubjects: [], nextCursor: null, done: true };
    if (deletion.status === "cancelled") return { kind: "cancelled", providerSubjects: [], nextCursor: null, done: true };
    if (deletion.status === "deleted") return { kind: "deleted", providerSubjects: [], nextCursor: null, done: true };
    const databaseNow = (await sql<{ now: Date }>`select clock_timestamp() as now`.execute(trx)).rows[0]?.now;
    if (!(databaseNow instanceof Date) || !Number.isFinite(databaseNow.getTime())) {
      throw new DomainError("INTERNAL_ERROR", "Account deletion database clock is invalid");
    }
    if (databaseNow.getTime() < deletion.scheduled_for.getTime()) {
      return { kind: "not_due", providerSubjects: [], nextCursor: null, done: true };
    }
    let query = trx.selectFrom("auth_subjects").select("provider_subject")
      .where("actor_id", "=", deletion.actor_id).orderBy("provider_subject").limit(limit + 1);
    if (cursor !== null) query = query.where("provider_subject", ">", cursor);
    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const subjects = rows.slice(0, limit);
    return Object.freeze({
      kind: "due" as const,
      providerSubjects: Object.freeze(subjects.map((row) => row.provider_subject)),
      nextCursor: hasMore ? subjects.at(-1)!.provider_subject : null,
      done: !hasMore,
    });
  });
}
