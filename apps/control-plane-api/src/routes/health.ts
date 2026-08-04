import {
  assertSchemaVersion,
  DomainError,
  EXPECTED_SCHEMA_VERSION,
  redactSummary,
  type ProviderCatalog,
  type Redactor,
  type RuntimeDatabase,
} from "@core-agent/runtime-core";
import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";

export type DependencyStatus = "available" | "unavailable" | "unknown";

export interface DependencyDetail {
  readonly status: DependencyStatus;
  readonly summary?: string;
}

export interface HealthDependencies {
  readonly db: Kysely<RuntimeDatabase>;
  readonly providerCatalog: ProviderCatalog;
  readonly imageLock: unknown;
  readonly redactor: Redactor;
  readonly dependencyDetails?: {
    readonly supervisor: DependencyDetail;
    readonly hermes: DependencyDetail;
  };
}

const repositoryPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const imageTagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const imageDigestPattern = /^[a-f0-9]{64}$/;

function exactRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Managed configuration is invalid");
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  ) throw new Error("Managed configuration is invalid");
}

function validateManagedConfiguration(providerCatalog: ProviderCatalog, imageLock: unknown): void {
  if (providerCatalog.entries.length < 1) throw new Error("Managed configuration is invalid");
  for (const provider of providerCatalog.entries) {
    if (provider.model_ids.length < 1) throw new Error("Managed configuration is invalid");
    for (const model of provider.model_ids) providerCatalog.require(provider.provider_config_id, model);
  }

  exactRecord(imageLock, ["schemaVersion", "repository", "tag", "platforms"]);
  if (
    imageLock.schemaVersion !== 1
    || typeof imageLock.repository !== "string"
    || !repositoryPattern.test(imageLock.repository)
    || typeof imageLock.tag !== "string"
    || !imageTagPattern.test(imageLock.tag)
  ) {
    throw new Error("Managed configuration is invalid");
  }
  const expectedReferencePrefix = `${imageLock.repository}:${imageLock.tag}@sha256:`;
  exactRecord(imageLock.platforms, ["linux/amd64", "linux/arm64"]);
  for (const platform of ["linux/amd64", "linux/arm64"] as const) {
    exactRecord(imageLock.platforms[platform], ["reference"]);
    const reference = imageLock.platforms[platform].reference;
    if (
      typeof reference !== "string"
      || !reference.startsWith(expectedReferencePrefix)
      || !imageDigestPattern.test(reference.slice(expectedReferencePrefix.length))
    ) {
      throw new Error("Managed configuration is invalid");
    }
  }
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
    ? descriptor.value
    : undefined;
}

function sanitizedDependency(detail: DependencyDetail | undefined, redactor: Redactor) {
  const candidateStatus = ownDataValue(detail, "status");
  const status = candidateStatus === "available" || candidateStatus === "unavailable" || candidateStatus === "unknown"
    ? candidateStatus
    : "unknown";
  const summary = ownDataValue(detail, "summary");
  return typeof summary === "string"
    ? { status, summary: redactSummary(summary, 200, redactor) }
    : { status };
}

export async function assertApiReady(dependencies: HealthDependencies): Promise<void> {
  try {
    const result = await sql<{ ready: number }>`select 1 as ready`.execute(dependencies.db);
    if (result.rows[0]?.ready !== 1) throw new Error("Database probe failed");
    await assertSchemaVersion(dependencies.db, EXPECTED_SCHEMA_VERSION);
    validateManagedConfiguration(dependencies.providerCatalog, dependencies.imageLock);
  } catch {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "API readiness failed", true);
  }
}

export async function registerHealthRoutes(app: FastifyInstance, dependencies: HealthDependencies): Promise<void> {
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async () => {
    await assertApiReady(dependencies);
    return {
      status: "ready",
      dependencies: {
        database: { status: "available" },
        supervisor: sanitizedDependency(dependencies.dependencyDetails?.supervisor, dependencies.redactor),
        hermes: sanitizedDependency(dependencies.dependencyDetails?.hermes, dependencies.redactor),
      },
    };
  });
}
