#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "infra/hermes/compose.dev.yaml";
const runtimeEnvFile = ".env.runtime";
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function validateCompanyFixture(fixture) {
  if (fixture?.schemaVersion !== 1 || !fixture.tenantId) {
    throw new Error("Invalid company fixture header");
  }
  if (!Array.isArray(fixture.profiles) || fixture.profiles.length === 0) {
    throw new Error("Company fixture must contain profiles");
  }

  const names = new Set();
  for (const profile of fixture.profiles) {
    if (!profileNamePattern.test(profile.name ?? "")) {
      throw new Error(`Invalid profile name: ${profile.name}`);
    }
    if (names.has(profile.name)) {
      throw new Error(`Duplicate profile name: ${profile.name}`);
    }
    if (!profile.description?.trim()) {
      throw new Error(`Missing profile description: ${profile.name}`);
    }
    names.add(profile.name);
  }
}

export function buildProfileOperations(fixture) {
  validateCompanyFixture(fixture);
  return {
    defaultProfile: ["skills", "opt-out", "--remove", "--yes"],
    profiles: fixture.profiles.map((profile) => ({
      name: profile.name,
      show: ["profile", "show", profile.name],
      create: [
        "profile",
        "create",
        profile.name,
        "--no-skills",
        "--no-alias",
        "--description",
        profile.description
      ],
      describe: [
        "profile",
        "describe",
        profile.name,
        "--text",
        profile.description
      ]
    }))
  };
}

function runHermes(arguments_, { allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      runtimeEnvFile,
      "-f",
      composeFile,
      "exec",
      "-T",
      "hermes",
      "hermes",
      ...arguments_
    ],
    {
      cwd: repositoryRoot,
      stdio: quiet ? "ignore" : "inherit"
    }
  );

  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Hermes command failed (${result.status}): hermes ${arguments_.join(" ")}`
    );
  }
  return result.status ?? 1;
}

async function main() {
  const fixtureUrl = new URL(
    "../infra/hermes/tenants/company-demo.json",
    import.meta.url
  );
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const operations = buildProfileOperations(fixture);

  runHermes(operations.defaultProfile);

  for (const profile of operations.profiles) {
    const exists = runHermes(profile.show, {
      allowFailure: true,
      quiet: true
    }) === 0;

    if (exists) {
      runHermes(profile.describe);
    } else {
      runHermes(profile.create);
    }
  }

  runHermes(["profile", "list"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
