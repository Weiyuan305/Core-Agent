#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const tenantIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const rootKeys = ["schemaVersion", "tenantId", "profiles"];
const profileKeys = ["name", "description"];

function exactDataProperties(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid company fixture");
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error("Invalid company fixture");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Invalid company fixture");
    }
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, descriptors[key].value]));
}

function exactArrayValues(value) {
  if (!Array.isArray(value)) {
    throw new Error("Invalid company fixture");
  }
  if (value.length === 0) throw new Error("Company fixture must contain profiles");
  if (value.length > 64) throw new Error("Invalid company fixture");
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.at(-1) !== "length" ||
    keys.slice(0, -1).some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Invalid company fixture");
  }
  return expectedKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("Invalid company fixture");
    }
    return descriptor.value;
  });
}

export function validateCompanyFixture(fixture) {
  const root = exactDataProperties(fixture, rootKeys);
  if (
    typeof root.schemaVersion !== "number" ||
    root.schemaVersion !== 1 ||
    typeof root.tenantId !== "string" ||
    !tenantIdPattern.test(root.tenantId)
  ) {
    throw new Error("Invalid company fixture header");
  }
  const rawProfiles = exactArrayValues(root.profiles);
  const names = new Set();
  const profiles = rawProfiles.map((value) => {
    const profile = exactDataProperties(value, profileKeys);
    if (typeof profile.name !== "string" || !profileNamePattern.test(profile.name)) {
      throw new Error("Invalid profile name");
    }
    if (names.has(profile.name)) throw new Error("Duplicate profile name");
    if (typeof profile.description !== "string" || !profile.description.trim()) {
      throw new Error("Missing profile description");
    }
    if (profile.description.length > 2_000 || profile.description.includes("\0")) {
      throw new Error("Invalid company fixture");
    }
    names.add(profile.name);
    return { name: profile.name, description: profile.description };
  });
  return { schemaVersion: 1, tenantId: root.tenantId, profiles };
}

export async function provisionDemoCompany({
  fixture,
  apiBaseUrl = process.env.CORE_AGENT_INTERNAL_API_URL ?? "http://127.0.0.1:8787",
  fetchImpl = fetch
}) {
  const dto = validateCompanyFixture(fixture);
  const response = await fetchImpl(
    `${apiBaseUrl.replace(/\/+$/, "")}/internal/v1/tenant-provisioning`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dto)
    }
  );
  if (!response.ok) throw new Error(`Internal provisioning API failed with status ${response.status}`);
  return response.json();
}

async function main() {
  const fixture = JSON.parse(await readFile(
    new URL("../infra/hermes/tenants/company-demo.json", import.meta.url),
    "utf8"
  ));
  const result = await provisionDemoCompany({ fixture });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
