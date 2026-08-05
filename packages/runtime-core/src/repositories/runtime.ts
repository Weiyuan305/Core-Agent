import { RuntimeContainerSchema, type RuntimeContainer } from "@core-agent/contracts";
import { sql, type Transaction } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import type { TenantRepositoryContext } from "./resources.js";
import { safeContractInteger, validateContract } from "./resources.js";

export type VersionedWriteResult =
  | { kind: "updated"; resource_version: number }
  | { kind: "not_found" }
  | { kind: "version_conflict"; current_resource_version: number };

export class RuntimeRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(runtime: RuntimeContainer): Promise<void> {
    if (runtime.tenant_id !== this.context.tenantId) throw new Error("Resource tenant ID does not match repository scope");
    validateContract<RuntimeContainer>(RuntimeContainerSchema, runtime);
    await this.context.db.insertInto("runtime_containers").values({
      tenant_id: runtime.tenant_id,
      container_id: runtime.container_id,
      schema_version: runtime.schema_version,
      resource_version: runtime.resource_version,
      runtime_kind: runtime.runtime_kind,
      desired_state: runtime.desired_state,
      observed_state: runtime.observed_state,
      image_ref: runtime.image_ref,
      generation: runtime.generation,
      volume_ref: runtime.volume_ref,
      health_status: runtime.health_status,
      last_probed_at: runtime.last_probed_at === undefined ? null : new Date(runtime.last_probed_at),
      failure_summary: runtime.failure_summary ?? null,
      created_at: new Date(runtime.created_at),
      updated_at: new Date(runtime.updated_at),
    }).execute();
  }

  public async find(containerId: string): Promise<RuntimeContainer | undefined> {
    const row = await this.context.db.selectFrom("runtime_containers")
      .select(["tenant_id", "container_id", "schema_version", "resource_version", "runtime_kind", "desired_state", "observed_state", "image_ref", "generation", "volume_ref", "health_status", "last_probed_at", "failure_summary", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("container_id", "=", containerId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<RuntimeContainer>(RuntimeContainerSchema, {
      tenant_id: row.tenant_id,
      container_id: row.container_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      runtime_kind: row.runtime_kind,
      desired_state: row.desired_state,
      observed_state: row.observed_state,
      image_ref: row.image_ref,
      generation: row.generation,
      volume_ref: row.volume_ref,
      health_status: row.health_status,
      ...(row.last_probed_at === null ? {} : { last_probed_at: row.last_probed_at.toISOString() }),
      ...(row.failure_summary === null ? {} : { failure_summary: row.failure_summary }),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }

  public async updateDesiredState(
    containerId: string,
    desiredState: RuntimeContainer["desired_state"],
    expectedVersion: number,
    now: Date,
  ): Promise<VersionedWriteResult> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Runtime update timestamp must be a valid Date");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new Error("Expected resource version must be a positive safe integer");
    }
    if (expectedVersion === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Expected resource version cannot be incremented within the safe integer range");
    }
    if (this.context.transactional) {
      return this.updateDesiredStateInTransaction(this.context.db, containerId, desiredState, expectedVersion, now);
    }
    return this.context.db.transaction().execute(async (trx) => (
      this.updateDesiredStateInTransaction(trx, containerId, desiredState, expectedVersion, now)
    ));
  }

  private async updateDesiredStateInTransaction(
    trx: Transaction<RuntimeDatabase>,
    containerId: string,
    desiredState: RuntimeContainer["desired_state"],
    expectedVersion: number,
    now: Date,
  ): Promise<VersionedWriteResult> {
    const current = await trx.selectFrom("runtime_containers")
      .select("resource_version")
      .where("tenant_id", "=", this.context.tenantId)
      .where("container_id", "=", containerId)
      .forUpdate()
      .executeTakeFirst();
    if (current === undefined) return { kind: "not_found" };

    const currentVersion = safeContractInteger(current.resource_version);
    if (currentVersion !== expectedVersion) {
      return { kind: "version_conflict", current_resource_version: currentVersion };
    }

    const nextVersion = currentVersion + 1;
    if (!Number.isSafeInteger(nextVersion)) {
      throw new RangeError("Resource version cannot be incremented within the safe integer range");
    }
    const updated = await trx.updateTable("runtime_containers")
      .set({ desired_state: desiredState, resource_version: sql`resource_version + 1`, updated_at: now })
      .where("tenant_id", "=", this.context.tenantId)
      .where("container_id", "=", containerId)
      .where("resource_version", "=", expectedVersion.toString())
      .returning("resource_version")
      .executeTakeFirstOrThrow();
    return { kind: "updated", resource_version: safeContractInteger(updated.resource_version) };
  }
}
