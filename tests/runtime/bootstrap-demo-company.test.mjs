import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
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
