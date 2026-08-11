import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testsRoot = dirname(fileURLToPath(import.meta.url));

test("Control Plane identity fixtures use global Actors and explicit Membership sources", async () => {
  const admissionSupport = await readFile(join(testsRoot, "admission-http-test-support.ts"), "utf8");
  const provisioning = await readFile(join(testsRoot, "provisioning.test.ts"), "utf8");
  const runtime = await readFile(join(testsRoot, "runtime.test.ts"), "utf8");

  const actorFixture = admissionSupport.slice(
    admissionSupport.indexOf('insertInto("actors")'),
    admissionSupport.indexOf('insertInto("memberships")'),
  );
  assert.doesNotMatch(actorFixture, /tenant_id:/);

  const admissionMemberships = admissionSupport.slice(
    admissionSupport.indexOf('insertInto("memberships")'),
    admissionSupport.indexOf('insertInto("profiles")'),
  );
  assert.match(admissionMemberships, /membership_source: "self"/);
  assert.match(admissionMemberships, /membership_source: "platform"/);
  assert.match(provisioning, /membership_source: "self"/);
  assert.match(runtime, /membership_source: "self"/);
});
