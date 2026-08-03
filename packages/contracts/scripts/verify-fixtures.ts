import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import Schema from "typebox/schema";

import {
  ContractSchemas,
  validateIdentityGraph,
  validateTrustedRequestContext,
  type IdentityGraph,
  type TrustedRequestContext,
  type TrustedContextAuthority,
} from "../src/index.js";

interface FixtureWrapper {
  schema_key: string;
  semantic_validator?: "identity_graph" | "trusted_context";
  expected: {
    structurally_valid: boolean;
    violation_codes: string[];
  };
  value: unknown;
}

const root = resolve(import.meta.dirname, "..");
const fixturesDirectory = resolve(root, "fixtures/v1");
const validDirectory = resolve(fixturesDirectory, "valid");
const invalidDirectory = resolve(fixturesDirectory, "invalid");

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

async function fixturePaths(directory: string): Promise<string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function diagnosticPath(path: string): string {
  return relative(root, path);
}

async function verifyFixture(path: string): Promise<{ schemaKey?: string; errors: string[] }> {
  const errors: string[] = [];
  let fixture: FixtureWrapper;
  try {
    fixture = JSON.parse(await readFile(path, "utf8")) as FixtureWrapper;
  } catch {
    return { errors: [`${diagnosticPath(path)}: fixture is not valid JSON`] };
  }

  if (!(fixture.schema_key in ContractSchemas)) {
    return { errors: [`${diagnosticPath(path)}: unknown schema_key ${JSON.stringify(fixture.schema_key)}`] };
  }

  const schemaKey = fixture.schema_key as keyof typeof ContractSchemas;
  const structurallyValid = Schema.Compile(ContractSchemas[schemaKey]).Check(fixture.value);
  if (structurallyValid !== fixture.expected.structurally_valid) {
    errors.push(
      `${diagnosticPath(path)}: structurally_valid expected ${fixture.expected.structurally_valid} actual ${structurallyValid}`,
    );
  }

  let actualCodes: string[] = [];
  if (structurallyValid && fixture.semantic_validator === "identity_graph") {
    actualCodes = validateIdentityGraph(fixture.value as IdentityGraph).map((item) => item.code);
  }
  if (structurallyValid && fixture.semantic_validator === "trusted_context") {
    actualCodes = validateTrustedRequestContext(
      fixture.value as TrustedRequestContext,
      authority,
    ).map((item) => item.code);
  }
  actualCodes.sort();
  const expectedCodes = [...fixture.expected.violation_codes].sort();
  if (JSON.stringify(actualCodes) !== JSON.stringify(expectedCodes)) {
    errors.push(
      `${diagnosticPath(path)}: violation_codes expected ${JSON.stringify(expectedCodes)} actual ${JSON.stringify(actualCodes)}`,
    );
  }

  return { schemaKey, errors };
}

const validPaths = await fixturePaths(validDirectory);
const invalidPaths = await fixturePaths(invalidDirectory);
const results = await Promise.all([...validPaths, ...invalidPaths].map(verifyFixture));
const errors = results.flatMap((result) => result.errors);
const validKeys = validPaths.map((_, index) => results[index]?.schemaKey).filter((key) => key !== undefined);
const expectedKeys = Object.keys(ContractSchemas).sort();
const actualKeys = [...new Set(validKeys)].sort();

if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const unexpected = actualKeys.filter((key) => !expectedKeys.includes(key));
  errors.push(`valid fixture coverage mismatch: missing ${JSON.stringify(missing)} unexpected ${JSON.stringify(unexpected)}`);
}
if (validKeys.length !== actualKeys.length) {
  errors.push("valid fixture coverage mismatch: duplicate schema_key entries");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified ${validPaths.length} valid fixtures and ${invalidPaths.length} invalid fixtures`);
}
