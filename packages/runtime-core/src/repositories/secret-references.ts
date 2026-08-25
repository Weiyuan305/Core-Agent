import type { TenantDatabaseContext, TenantTransaction } from "../db/transaction.js";
import {
  assertSecretReference,
  assertSecretReferenceId,
  type SecretPurpose,
  type SecretReference,
} from "../secrets/secret-store.js";
import { repositoryContext, safeContractInteger, type TenantRepositoryContext } from "./resources.js";

export const secretReferenceStatuses = ["active", "rotated", "revoked"] as const;
export type SecretReferenceStatus = (typeof secretReferenceStatuses)[number];
type StoredSecretPurpose = "provider_credential" | "integration" | "bootstrap";
type StoredPublicSecretPurpose = Exclude<SecretPurpose, "identity_signing" | "policy_runtime" | "policy_plugin">;

const storedPurposeByPublicPurpose: Readonly<Record<StoredPublicSecretPurpose, StoredSecretPurpose>> = {
  model_provider: "provider_credential",
  hermes_ingress: "integration",
  bootstrap_service: "bootstrap",
};

export interface SecretReferenceMetadata extends Omit<SecretReference, "purpose"> {
  readonly purpose: StoredPublicSecretPurpose;
  readonly status: SecretReferenceStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

function assertStatus(status: SecretReferenceStatus): void {
  if (!secretReferenceStatuses.includes(status)) {
    throw new Error("Invalid secret reference status");
  }
}

function parseTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("Invalid secret reference timestamp");
  }
  return parsed;
}

function publicPurposeFromStored(purpose: string): StoredPublicSecretPurpose {
  switch (purpose) {
    case "provider_credential": return "model_provider";
    case "integration": return "hermes_ingress";
    case "bootstrap": return "bootstrap_service";
    default: throw new Error("Invalid stored secret reference purpose");
  }
}

export class SecretReferenceRepository {
  readonly #context: TenantRepositoryContext;

  public constructor(context: TenantDatabaseContext | TenantTransaction) {
    this.#context = repositoryContext(context);
  }

  public async insert(metadata: SecretReferenceMetadata): Promise<void> {
    assertSecretReference(metadata);
    assertStatus(metadata.status);
    const createdAt = parseTimestamp(metadata.created_at);
    const updatedAt = parseTimestamp(metadata.updated_at);

    await this.#context.db.insertInto("secret_references").values({
      tenant_id: this.#context.tenantId,
      reference_id: metadata.reference_id,
      purpose: storedPurposeByPublicPurpose[metadata.purpose],
      version: metadata.version,
      status: metadata.status,
      created_at: createdAt,
      updated_at: updatedAt,
    }).execute();
  }

  public async find(referenceId: string): Promise<SecretReferenceMetadata | undefined> {
    assertSecretReferenceId(referenceId);
    const row = await this.#context.db.selectFrom("secret_references")
      .select(["reference_id", "purpose", "version", "status", "created_at", "updated_at"])
      .where("tenant_id", "=", this.#context.tenantId)
      .where("reference_id", "=", referenceId)
      .executeTakeFirst();
    if (row === undefined) return undefined;

    const version = safeContractInteger(row.version);
    const purpose = publicPurposeFromStored(row.purpose);
    assertStatus(row.status as SecretReferenceStatus);
    return {
      reference_id: row.reference_id,
      purpose,
      version,
      status: row.status as SecretReferenceStatus,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}
