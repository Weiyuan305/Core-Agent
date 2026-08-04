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
  assert.doesNotThrow(() => validateCompanyFixture(fixture));
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
