import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildProfileKeyProvisioningArgs,
  buildProfileOperations,
  validateCompanyFixture
} from "../../scripts/bootstrap-demo-company.mjs";

const fixtureUrl = new URL(
  "../../infra/hermes/tenants/company-demo.json",
  import.meta.url
);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));

test("company fixture contains two safe consultant profiles", () => {
  assert.doesNotThrow(() => validateCompanyFixture(fixture));
  assert.equal(fixture.tenantId, "company-demo");
  assert.deepEqual(
    fixture.profiles.map((profile) => profile.name),
    ["consultant-a", "consultant-b"]
  );
});

test("bootstrap operations always opt out of bundled skills", () => {
  const operations = buildProfileOperations(fixture);
  assert.deepEqual(operations.defaultProfile, [
    "skills",
    "opt-out",
    "--remove",
    "--yes"
  ]);
  for (const profile of operations.profiles) {
    assert.ok(profile.create.includes("--no-skills"));
    assert.ok(profile.create.includes("--no-alias"));
    assert.equal(profile.create[0], "profile");
    assert.equal(profile.show[0], "profile");
  }
});

test("unsafe profile names are rejected before invoking Docker", () => {
  const unsafe = structuredClone(fixture);
  unsafe.profiles[0].name = "../escape";
  assert.throws(() => validateCompanyFixture(unsafe), /Invalid profile name/);
});

test("invalid fixture headers are rejected", () => {
  const invalidVersion = structuredClone(fixture);
  invalidVersion.schemaVersion = 2;
  assert.throws(
    () => validateCompanyFixture(invalidVersion),
    /Invalid company fixture header/
  );

  const missingTenant = structuredClone(fixture);
  missingTenant.tenantId = "";
  assert.throws(
    () => validateCompanyFixture(missingTenant),
    /Invalid company fixture header/
  );
});

test("fixtures require at least one profile", () => {
  const empty = structuredClone(fixture);
  empty.profiles = [];
  assert.throws(
    () => validateCompanyFixture(empty),
    /Company fixture must contain profiles/
  );
});

test("duplicate profile names are rejected", () => {
  const duplicate = structuredClone(fixture);
  duplicate.profiles[1].name = duplicate.profiles[0].name;
  assert.throws(
    () => validateCompanyFixture(duplicate),
    /Duplicate profile name/
  );
});

test("profile descriptions cannot be empty", () => {
  const missingDescription = structuredClone(fixture);
  missingDescription.profiles[0].description = "  ";
  assert.throws(
    () => validateCompanyFixture(missingDescription),
    /Missing profile description/
  );
});

test("profile key provisioning uses a validated final argument without exposing the key", () => {
  const sentinelSecret = "unit-test-secret-that-must-not-enter-argv";
  const previousSecret = process.env.API_SERVER_KEY;
  process.env.API_SERVER_KEY = sentinelSecret;

  let args;
  try {
    args = buildProfileKeyProvisioningArgs(fixture, "consultant-a");
  } finally {
    if (previousSecret === undefined) {
      delete process.env.API_SERVER_KEY;
    } else {
      process.env.API_SERVER_KEY = previousSecret;
    }
  }

  assert.deepEqual(args.slice(0, 10), [
    "compose",
    "--env-file",
    ".env.runtime",
    "-f",
    "infra/hermes/compose.dev.yaml",
    "exec",
    "-T",
    "--user",
    "hermes",
    "hermes"
  ]);
  assert.equal(args.at(-4), "/opt/hermes/.venv/bin/python");
  assert.equal(args.at(-3), "-c");
  assert.equal(args.at(-1), "consultant-a");
  assert.doesNotMatch(args.join("\n"), new RegExp(sentinelSecret));
  assert.doesNotMatch(
    args.filter((_, index) => index !== args.length - 2).join("\n"),
    /API_SERVER_KEY=/
  );
  assert.throws(
    () => buildProfileKeyProvisioningArgs(fixture, "../escape"),
    /Profile is not declared in company fixture/
  );
});

test("profile key provisioning atomically replaces only the target key", () => {
  const args = buildProfileKeyProvisioningArgs(fixture, "consultant-b");
  const program = args.at(-2);

  assert.match(program, /os\.environ\["API_SERVER_KEY"\]/);
  assert.match(program, /Path\("\/opt\/data\/profiles"\) \/ profile_name \/ "\.env"/);
  assert.match(program, /line\.startswith\("API_SERVER_KEY="\)/);
  assert.match(program, /lines\.append\(f"API_SERVER_KEY=\{key\}"\)/);
  assert.match(program, /"\\n"\.join\(lines\) \+ "\\n"/);
  assert.match(program, /tempfile\.mkstemp/);
  assert.match(program, /os\.replace\(temporary_path, target\)/);
  assert.match(program, /os\.chmod\(temporary_path, 0o600\)/);
  assert.doesNotMatch(program, /consultant-a|consultant-b/);
});

test("profile key provisioning fails closed before writing an unusable key", () => {
  const args = buildProfileKeyProvisioningArgs(fixture, "consultant-a");
  const program = args.at(-2);

  assert.match(program, /if len\(key\) < 16:/);
  assert.ok(
    program.indexOf("if len(key) < 16:") <
      program.indexOf("tempfile.mkstemp")
  );
});
