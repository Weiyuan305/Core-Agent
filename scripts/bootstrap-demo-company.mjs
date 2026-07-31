#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const composeFile = "infra/hermes/compose.dev.yaml";
const runtimeEnvFile = ".env.runtime";
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const profileKeyProvisioningProgram = `import os
import tempfile
from pathlib import Path
import sys

profile_name = sys.argv[1]
key = os.environ["API_SERVER_KEY"]
if len(key) < 16:
    raise SystemExit("API_SERVER_KEY is absent or unusable")

target = Path("/opt/data/profiles") / profile_name / ".env"
lines = target.read_text(encoding="utf-8").splitlines() if target.exists() else []
lines = [line for line in lines if not line.startswith("API_SERVER_KEY=")]
lines.append(f"API_SERVER_KEY={key}")
payload = "\\n".join(lines) + "\\n"

descriptor, temporary_name = tempfile.mkstemp(prefix=".env.", dir=target.parent)
temporary_path = Path(temporary_name)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\\n") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary_path, 0o600)
    os.replace(temporary_path, target)
except BaseException:
    temporary_path.unlink(missing_ok=True)
    raise
`;

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

export function buildProfileKeyProvisioningArgs(fixture, profileName) {
  validateCompanyFixture(fixture);
  if (!fixture.profiles.some((profile) => profile.name === profileName)) {
    throw new Error(`Profile is not declared in company fixture: ${profileName}`);
  }

  return [
    "compose",
    "--env-file",
    runtimeEnvFile,
    "-f",
    composeFile,
    "exec",
    "-T",
    "--user",
    "hermes",
    "hermes",
    "/opt/hermes/.venv/bin/python",
    "-c",
    profileKeyProvisioningProgram,
    profileName
  ];
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

function provisionProfileKey(fixture, profileName) {
  const result = spawnSync(
    "docker",
    buildProfileKeyProvisioningArgs(fixture, profileName),
    {
      cwd: repositoryRoot,
      stdio: "inherit"
    }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Profile API key provisioning failed (${result.status}): ${profileName}`
    );
  }
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
    provisionProfileKey(fixture, profile.name);
  }

  runHermes(["profile", "list"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
