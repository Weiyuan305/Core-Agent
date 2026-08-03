import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Schema from "typebox/schema";

import {
  ContractSchemas,
  validateIdentityGraph,
  validateTrustedRequestContext,
  type IdentityGraph,
  type TrustedRequestContext,
  type TrustedContextAuthority,
} from "../src/index.js";

type SemanticValidator = "identity_graph" | "trusted_context";

interface FixtureWrapper {
  schema_key: string;
  semantic_validator?: SemanticValidator;
  expected: {
    structurally_valid: boolean;
    violation_codes: string[];
  };
  value: unknown;
}

interface FixtureContract {
  schemaKey: keyof typeof ContractSchemas;
  semanticValidator?: SemanticValidator;
  structurallyValid: boolean;
  violationCodes: readonly string[];
}

const validFixtureContracts = Object.fromEntries(
  Object.keys(ContractSchemas).map((schemaKey) => [
    `${schemaKey}.json`,
    {
      schemaKey,
      semanticValidator: schemaKey === "identity-graph"
        ? "identity_graph"
        : schemaKey === "trusted-request-context"
          ? "trusted_context"
          : undefined,
      structurallyValid: true,
      violationCodes: [],
    },
  ]),
) as Record<string, FixtureContract>;

const invalidFixtureContracts = {
  "membership-empty-roles.json": {
    schemaKey: "membership",
    structurallyValid: false,
    violationCodes: [],
  },
  "resource-non-utc-time.json": {
    schemaKey: "tenant",
    structurallyValid: false,
    violationCodes: [],
  },
  "identity-cross-tenant.json": {
    schemaKey: "identity-graph",
    semanticValidator: "identity_graph",
    structurallyValid: true,
    violationCodes: ["TENANT_SCOPE_MISMATCH"],
  },
  "identity-b2c-consultant.json": {
    schemaKey: "identity-graph",
    semanticValidator: "identity_graph",
    structurallyValid: true,
    violationCodes: ["B2C_PROFILE_KIND_INVALID"],
  },
  "context-case-student-mismatch.json": {
    schemaKey: "trusted-request-context",
    semanticValidator: "trusted_context",
    structurallyValid: true,
    violationCodes: ["CASE_STUDENT_MISMATCH"],
  },
  "context-expired.json": {
    schemaKey: "trusted-request-context",
    semanticValidator: "trusted_context",
    structurallyValid: true,
    violationCodes: ["CONTEXT_EXPIRED"],
  },
  "context-forged-role.json": {
    schemaKey: "trusted-request-context",
    semanticValidator: "trusted_context",
    structurallyValid: true,
    violationCodes: ["EFFECTIVE_ROLE_NOT_GRANTED"],
  },
  "event-hidden-reasoning.json": {
    schemaKey: "product-event",
    structurallyValid: false,
    violationCodes: [],
  },
  "error-stack.json": {
    schemaKey: "error-envelope",
    structurallyValid: false,
    violationCodes: [],
  },
} as const satisfies Record<string, FixtureContract>;

const authority: TrustedContextAuthority = {
  expected_issuer: "core-agent-control-plane",
  expected_audience: "capability-gateway",
  now: "2026-08-03T01:02:00Z",
  membership: {
    membership_id: "membership_demo",
    tenant_id: "tenant_demo",
    actor_id: "actor_consultant",
    roles: ["consultant"],
    status: "active",
  },
  profile: {
    profile_id: "profile_demo",
    tenant_id: "tenant_demo",
    owner_actor_id: "actor_consultant",
    status: "active",
  },
};

const root = resolve(import.meta.dirname, "..");

function diagnosticPath(path: string): string {
  return relative(root, path);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function isFixtureWrapper(value: unknown): value is FixtureWrapper {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const expected = candidate.expected;
  return typeof candidate.schema_key === "string"
    && (candidate.semantic_validator === undefined || typeof candidate.semantic_validator === "string")
    && expected !== null
    && typeof expected === "object"
    && typeof (expected as Record<string, unknown>).structurally_valid === "boolean"
    && Array.isArray((expected as Record<string, unknown>).violation_codes)
    && ((expected as Record<string, unknown>).violation_codes as unknown[])
      .every((code) => typeof code === "string")
    && "value" in candidate;
}

async function manifestFailures(
  directory: string,
  contracts: Record<string, FixtureContract>,
  label: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const actual = new Map(entries.map((entry) => [entry.name, entry]));
  const expectedNames = Object.keys(contracts).sort((left, right) => left.localeCompare(right));
  const expected = new Set(expectedNames);
  const failures: string[] = [];

  for (const fileName of expectedNames) {
    const entry = actual.get(fileName);
    if (entry === undefined) failures.push(`${label} ${fileName}: missing`);
    else if (!entry.isFile()) failures.push(`${label} ${fileName}: not a file`);
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!expected.has(entry.name)) failures.push(`${label} ${entry.name}: unexpected`);
  }
  return failures;
}

async function verifyFixture(path: string, contract: FixtureContract): Promise<string[]> {
  let fixture: unknown;
  try {
    fixture = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [`${diagnosticPath(path)}: fixture is not valid JSON`];
  }
  if (!isFixtureWrapper(fixture)) {
    return [`${diagnosticPath(path)}: fixture wrapper is invalid`];
  }
  if (
    fixture.schema_key !== contract.schemaKey
    || fixture.semantic_validator !== contract.semanticValidator
    || fixture.expected.structurally_valid !== contract.structurallyValid
    || !sameStrings(fixture.expected.violation_codes, contract.violationCodes)
  ) {
    return [`${diagnosticPath(path)}: fixture contract mismatch`];
  }

  const errors: string[] = [];
  const structurallyValid = Schema.Compile(ContractSchemas[contract.schemaKey]).Check(fixture.value);
  if (structurallyValid !== contract.structurallyValid) {
    errors.push(
      `${diagnosticPath(path)}: structurally_valid expected ${contract.structurallyValid} actual ${structurallyValid}`,
    );
  }

  let actualCodes: string[] = [];
  if (structurallyValid && contract.semanticValidator === "identity_graph") {
    actualCodes = validateIdentityGraph(fixture.value as IdentityGraph).map((item) => item.code);
  }
  if (structurallyValid && contract.semanticValidator === "trusted_context") {
    actualCodes = validateTrustedRequestContext(
      fixture.value as TrustedRequestContext,
      authority,
    ).map((item) => item.code);
  }
  if (!sameStrings(actualCodes, contract.violationCodes)) {
    errors.push(
      `${diagnosticPath(path)}: violation_codes expected ${JSON.stringify([...contract.violationCodes].sort())} actual ${JSON.stringify(actualCodes.sort())}`,
    );
  }
  return errors;
}

export async function verifyFixtureDirectories(
  validDirectory: string,
  invalidDirectory: string,
): Promise<{ validCount: number; invalidCount: number }> {
  const manifestErrors = [
    ...await manifestFailures(validDirectory, validFixtureContracts, "valid fixture manifest"),
    ...await manifestFailures(invalidDirectory, invalidFixtureContracts, "invalid fixture manifest"),
  ];
  if (manifestErrors.length > 0) throw new Error(manifestErrors.join("\n"));

  const fixtureErrors = (
    await Promise.all([
      ...Object.entries(validFixtureContracts),
      ...Object.entries(invalidFixtureContracts),
    ].map(([fileName, contract]) => verifyFixture(
      resolve(fileName in validFixtureContracts ? validDirectory : invalidDirectory, fileName),
      contract,
    )))
  ).flat();
  if (fixtureErrors.length > 0) {
    fixtureErrors.sort((left, right) => left.localeCompare(right));
    throw new Error(fixtureErrors.join("\n"));
  }

  return {
    validCount: Object.keys(validFixtureContracts).length,
    invalidCount: Object.keys(invalidFixtureContracts).length,
  };
}

async function main(): Promise<void> {
  const result = await verifyFixtureDirectories(
    resolve(root, "fixtures/v1/valid"),
    resolve(root, "fixtures/v1/invalid"),
  );
  console.log(`Verified ${result.validCount} valid fixtures and ${result.invalidCount} invalid fixtures`);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fixture verification failed");
    process.exitCode = 1;
  });
}
