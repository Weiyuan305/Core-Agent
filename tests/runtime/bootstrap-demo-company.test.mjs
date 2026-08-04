import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  provisionDemoCompany,
  validateCompanyFixture
} from "../../scripts/bootstrap-demo-company.mjs";

const fixtureUrl = new URL(
  "../../infra/hermes/tenants/company-demo.json",
  import.meta.url
);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const bootstrapSource = await readFile(
  new URL("../../scripts/bootstrap-demo-company.mjs", import.meta.url),
  "utf8"
);

test("company fixture contains two safe consultant profiles", () => {
  const dto = validateCompanyFixture(fixture);
  assert.deepEqual(dto, fixture);
  assert.notEqual(dto, fixture);
  assert.notEqual(dto.profiles, fixture.profiles);
  assert.notEqual(dto.profiles[0], fixture.profiles[0]);
  assert.equal(fixture.tenantId, "company-demo");
  assert.deepEqual(
    fixture.profiles.map((profile) => profile.name),
    ["consultant-a", "consultant-b"]
  );
});

test("unsafe or incomplete company fixtures are rejected before provisioning", () => {
  const invalidVersion = structuredClone(fixture);
  invalidVersion.schemaVersion = 2;
  assert.throws(() => validateCompanyFixture(invalidVersion), /Invalid company fixture header/);

  const missingTenant = structuredClone(fixture);
  missingTenant.tenantId = "";
  assert.throws(() => validateCompanyFixture(missingTenant), /Invalid company fixture header/);

  const empty = structuredClone(fixture);
  empty.profiles = [];
  assert.throws(() => validateCompanyFixture(empty), /must contain profiles/);

  const unsafe = structuredClone(fixture);
  unsafe.profiles[0].name = "../escape";
  assert.throws(() => validateCompanyFixture(unsafe), /Invalid profile name/);

  const duplicate = structuredClone(fixture);
  duplicate.profiles[1].name = duplicate.profiles[0].name;
  assert.throws(() => validateCompanyFixture(duplicate), /Duplicate profile name/);

  const missingDescription = structuredClone(fixture);
  missingDescription.profiles[0].description = "  ";
  assert.throws(() => validateCompanyFixture(missingDescription), /Missing profile description/);

  const unknownRoot = structuredClone(fixture);
  unknownRoot.docker_options = { privileged: true };
  assert.throws(() => validateCompanyFixture(unknownRoot), /Invalid company fixture/);

  const secretBearing = structuredClone(fixture);
  secretBearing.profiles[0].providerKey = "sentinel-provider-key";
  assert.throws(() => validateCompanyFixture(secretBearing), /Invalid company fixture/);

  const tooMany = structuredClone(fixture);
  tooMany.profiles = Array.from({ length: 65 }, (_, index) => ({
    name: `consultant-${index}`,
    description: "Synthetic"
  }));
  assert.throws(() => validateCompanyFixture(tooMany), /Invalid company fixture/);

  const longDescription = structuredClone(fixture);
  longDescription.profiles[0].description = "x".repeat(2_001);
  assert.throws(() => validateCompanyFixture(longDescription), /Invalid company fixture/);
});

test("company fixture validation rejects accessors, symbols, and non-enumerable properties without invoking them", () => {
  for (const placement of ["root", "profile"]) {
    const hostile = structuredClone(fixture);
    const target = placement === "root" ? hostile : hostile.profiles[0];
    let invoked = false;
    Object.defineProperty(target, "providerKey", {
      enumerable: true,
      get() {
        invoked = true;
        return "sentinel-provider-key";
      }
    });
    assert.throws(() => validateCompanyFixture(hostile), /Invalid company fixture/);
    assert.equal(invoked, false);
  }

  const allowedAccessor = structuredClone(fixture);
  let allowedAccessorInvoked = false;
  Object.defineProperty(allowedAccessor.profiles[0], "name", {
    enumerable: true,
    get() {
      allowedAccessorInvoked = true;
      return "consultant-a";
    }
  });
  assert.throws(() => validateCompanyFixture(allowedAccessor), /Invalid company fixture/);
  assert.equal(allowedAccessorInvoked, false);

  const symbolProperty = structuredClone(fixture);
  symbolProperty.profiles[0][Symbol("providerKey")] = "sentinel-provider-key";
  assert.throws(() => validateCompanyFixture(symbolProperty), /Invalid company fixture/);

  const hiddenProperty = structuredClone(fixture);
  Object.defineProperty(hiddenProperty, "docker_options", {
    enumerable: false,
    value: { privileged: true }
  });
  assert.throws(() => validateCompanyFixture(hiddenProperty), /Invalid company fixture/);

  const hiddenAllowedProperty = structuredClone(fixture);
  Object.defineProperty(hiddenAllowedProperty.profiles[0], "description", {
    enumerable: false,
    value: "Synthetic"
  });
  assert.throws(() => validateCompanyFixture(hiddenAllowedProperty), /Invalid company fixture/);
});

test("legacy bootstrap never invokes docker compose exec or reads a provider key", () => {
  assert.doesNotMatch(bootstrapSource, /compose[\s\S]*exec/);
  assert.doesNotMatch(bootstrapSource, /python[\s\S]*-c/);
  assert.doesNotMatch(bootstrapSource, /API_SERVER_KEY|provider[_-]?key/i);
});

test("compatibility bootstrap posts the anonymous fixture to the internal provisioning API", async () => {
  let request;
  const response = await provisionDemoCompany({
    fixture,
    apiBaseUrl: "http://127.0.0.1:8787",
    async fetchImpl(url, options) {
      request = { url, options };
      return {
        ok: true,
        status: 202,
        async json() { return { accepted: true }; }
      };
    }
  });

  assert.deepEqual(response, { accepted: true });
  assert.equal(request.url, "http://127.0.0.1:8787/internal/v1/tenant-provisioning");
  assert.deepEqual(request.options, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixture)
  });
});

test("compatibility bootstrap constructs an allowlisted DTO and never serializes secret-bearing input", async () => {
  const hostile = structuredClone(fixture);
  Object.defineProperty(hostile.profiles[0], "providerKey", {
    enumerable: false,
    value: "sentinel-provider-key"
  });
  let called = false;
  await assert.rejects(
    provisionDemoCompany({
      fixture: hostile,
      async fetchImpl() {
        called = true;
        throw new Error("must not call");
      }
    }),
    /Invalid company fixture/
  );
  assert.equal(called, false);
});

test("compatibility bootstrap reports a bounded API failure without response content", async () => {
  await assert.rejects(
    provisionDemoCompany({
      fixture,
      apiBaseUrl: "http://127.0.0.1:8787",
      async fetchImpl() {
        return { ok: false, status: 503, async json() { return { secret: "sentinel" }; } };
      }
    }),
    /^Error: Internal provisioning API failed with status 503$/
  );
});
