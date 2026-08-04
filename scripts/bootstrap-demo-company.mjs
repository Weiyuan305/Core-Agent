#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateCompanyFixture(fixture) {
  if (fixture?.schemaVersion !== 1 || typeof fixture.tenantId !== "string" || !fixture.tenantId) {
    throw new Error("Invalid company fixture header");
  }
  if (!Array.isArray(fixture.profiles) || fixture.profiles.length === 0) {
    throw new Error("Company fixture must contain profiles");
  }
  const names = new Set();
  for (const profile of fixture.profiles) {
    if (!profileNamePattern.test(profile?.name ?? "")) throw new Error("Invalid profile name");
    if (names.has(profile.name)) throw new Error("Duplicate profile name");
    if (typeof profile.description !== "string" || !profile.description.trim()) {
      throw new Error("Missing profile description");
    }
    names.add(profile.name);
  }
}

export async function provisionDemoCompany({
  fixture,
  apiBaseUrl = process.env.CORE_AGENT_INTERNAL_API_URL ?? "http://127.0.0.1:8787",
  fetchImpl = fetch
}) {
  validateCompanyFixture(fixture);
  const response = await fetchImpl(
    `${apiBaseUrl.replace(/\/+$/, "")}/internal/v1/tenant-provisioning`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture)
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
