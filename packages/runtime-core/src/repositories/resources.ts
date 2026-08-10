import type { Actor, Membership, Profile, Tenant } from "@core-agent/contracts";
import { ActorSchema, MembershipSchema, ProfileSchema, TenantSchema } from "@core-agent/contracts";
import type { TSchema } from "typebox";
import Schema from "typebox/schema";
import type { Kysely, Transaction } from "kysely";

import { assertTenantId, type TenantDatabaseContext, type TenantTransaction } from "../db/transaction.js";
import type { RuntimeDatabase } from "../db/database.js";

export type TenantRepositoryContext =
  | { readonly tenantId: string; readonly db: Kysely<RuntimeDatabase>; readonly transactional: false }
  | { readonly tenantId: string; readonly db: Transaction<RuntimeDatabase>; readonly transactional: true };

export type ProfileInsert = Profile & {
  readonly description: string;
  readonly provider_config_id: string;
  readonly model_id: string;
};

export function repositoryContext(context: TenantDatabaseContext | TenantTransaction): TenantRepositoryContext {
  assertTenantId(context.tenantId);
  return "trx" in context
    ? { tenantId: context.tenantId, db: context.trx, transactional: true }
    : { tenantId: context.tenantId, db: context.db, transactional: false };
}

export function safeContractInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new RangeError("Database bigint is not an integer");
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Database bigint cannot be represented as a safe integer");
  }
  const converted = Number(integer);
  if (!Number.isSafeInteger(converted)) throw new RangeError("Database bigint cannot be represented as a safe integer");
  return converted;
}

export function validateContract<T>(schema: TSchema, value: unknown): T {
  if (typeof value === "object" && value !== null && "resource_version" in value) {
    const resourceVersion = (value as { resource_version: unknown }).resource_version;
    if (typeof resourceVersion !== "number" || !Number.isSafeInteger(resourceVersion) || resourceVersion < 1) {
      throw new RangeError("resource_version must be a positive safe integer");
    }
  }
  if (typeof value === "object" && value !== null && "generation" in value) {
    const generation = (value as { generation: unknown }).generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
      throw new RangeError("generation must be a positive safe integer");
    }
  }
  if (!Schema.Check(schema, value)) throw new Error("Database row violates its contract schema");
  return value as T;
}

function assertOwnedByTenant(value: { tenant_id: string }, tenantId: string): void {
  if (value.tenant_id !== tenantId) throw new Error("Resource tenant ID does not match repository scope");
}

export class TenantRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(tenant: Tenant): Promise<void> {
    assertOwnedByTenant(tenant, this.context.tenantId);
    validateContract<Tenant>(TenantSchema, tenant);
    await this.context.db.insertInto("tenants").values({
      tenant_id: tenant.tenant_id,
      schema_version: tenant.schema_version,
      resource_version: tenant.resource_version,
      tenant_mode: tenant.tenant_mode,
      status: tenant.status,
      display_name: tenant.display_name,
      created_at: new Date(tenant.created_at),
      updated_at: new Date(tenant.updated_at),
    }).execute();
  }

  public async find(): Promise<Tenant | undefined> {
    const row = await this.context.db.selectFrom("tenants")
      .select(["tenant_id", "schema_version", "resource_version", "tenant_mode", "status", "display_name", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Tenant>(TenantSchema, {
      tenant_id: row.tenant_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      tenant_mode: row.tenant_mode,
      status: row.status,
      display_name: row.display_name,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}

export class ActorRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(actor: Actor): Promise<void> {
    validateContract<Actor>(ActorSchema, actor);
    await this.context.db.insertInto("actors").values({
      actor_id: actor.actor_id,
      schema_version: actor.schema_version,
      resource_version: actor.resource_version,
      actor_kind: actor.actor_kind,
      display_name: actor.display_name ?? null,
      status: actor.status,
      created_at: new Date(actor.created_at),
      updated_at: new Date(actor.updated_at),
    }).onConflict((conflict) => conflict.column("actor_id").doNothing()).execute();
    const stored = await this.context.db.selectFrom("actors")
      .select(["actor_kind", "display_name", "status"])
      .where("actor_id", "=", actor.actor_id)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    if (
      stored.actor_kind !== actor.actor_kind
      || stored.display_name !== (actor.display_name ?? null)
      || stored.status !== actor.status
    ) throw new Error("Global Actor facts conflict with existing identity authority");
  }

  public async find(actorId: string): Promise<Actor | undefined> {
    const row = await this.context.db.selectFrom("actors")
      .select(["actor_id", "schema_version", "resource_version", "actor_kind", "display_name", "status", "created_at", "updated_at"])
      .where("actor_id", "=", actorId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Actor>(ActorSchema, {
      actor_id: row.actor_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      actor_kind: row.actor_kind,
      ...(row.display_name === null ? {} : { display_name: row.display_name }),
      status: row.status === "active" ? "active" : "disabled",
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}

export class MembershipRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(membership: Membership): Promise<void> {
    assertOwnedByTenant(membership, this.context.tenantId);
    validateContract<Membership>(MembershipSchema, membership);
    if (membership.membership_source === undefined) {
      throw new Error("Membership source must be explicit for database writes");
    }
    await this.context.db.insertInto("memberships").values({
      tenant_id: membership.tenant_id,
      membership_id: membership.membership_id,
      actor_id: membership.actor_id,
      schema_version: membership.schema_version,
      resource_version: membership.resource_version,
      roles: membership.roles,
      membership_source: membership.membership_source,
      seat_ref: membership.seat_ref ?? null,
      status: membership.status,
      created_at: new Date(membership.created_at),
      updated_at: new Date(membership.updated_at),
    }).execute();
  }

  public async find(membershipId: string): Promise<Membership | undefined> {
    const row = await this.context.db.selectFrom("memberships")
      .select(["tenant_id", "membership_id", "actor_id", "schema_version", "resource_version", "roles", "membership_source", "seat_ref", "status", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("membership_id", "=", membershipId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Membership>(MembershipSchema, {
      tenant_id: row.tenant_id,
      membership_id: row.membership_id,
      actor_id: row.actor_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      roles: row.roles,
      membership_source: row.membership_source,
      ...(row.seat_ref === null ? {} : { seat_ref: row.seat_ref }),
      status: row.status,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}

export class ProfileRepository {
  public constructor(private readonly context: TenantRepositoryContext) {}

  public async insert(profile: ProfileInsert): Promise<void> {
    const { description, provider_config_id, model_id, ...contract } = profile;
    assertOwnedByTenant(contract, this.context.tenantId);
    validateContract<Profile>(ProfileSchema, contract);
    await this.context.db.insertInto("profiles").values({
      tenant_id: contract.tenant_id,
      profile_id: contract.profile_id,
      schema_version: contract.schema_version,
      resource_version: contract.resource_version,
      owner_actor_id: contract.owner_actor_id,
      profile_kind: contract.profile_kind,
      hermes_profile_ref: contract.hermes_profile_ref,
      description,
      status: contract.status,
      provider_config_id,
      model_id,
      created_at: new Date(contract.created_at),
      updated_at: new Date(contract.updated_at),
    }).execute();
  }

  public async find(profileId: string): Promise<Profile | undefined> {
    const row = await this.context.db.selectFrom("profiles")
      .select(["tenant_id", "profile_id", "schema_version", "resource_version", "owner_actor_id", "profile_kind", "hermes_profile_ref", "status", "created_at", "updated_at"])
      .where("tenant_id", "=", this.context.tenantId)
      .where("profile_id", "=", profileId)
      .executeTakeFirst();
    return row === undefined ? undefined : validateContract<Profile>(ProfileSchema, {
      tenant_id: row.tenant_id,
      profile_id: row.profile_id,
      schema_version: row.schema_version,
      resource_version: safeContractInteger(row.resource_version),
      owner_actor_id: row.owner_actor_id,
      profile_kind: row.profile_kind,
      hermes_profile_ref: row.hermes_profile_ref,
      status: row.status,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }
}
