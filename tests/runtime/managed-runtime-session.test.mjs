import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createManagedRuntimeDependencies,
  runControlPlaneSmoke,
  smokePublicErrorCode,
} from "../../scripts/lib/managed-runtime-session.mjs";
import * as smokeWrapper from "../../scripts/smoke-control-plane.mjs";

const wrapperSource = await readFile(
  new URL("../../scripts/smoke-control-plane.mjs", import.meta.url),
  "utf8",
);

test("managed Runtime implementation is behind a thin smoke compatibility wrapper", () => {
  assert.equal(typeof createManagedRuntimeDependencies, "function");
  assert.equal(smokeWrapper.runControlPlaneSmoke, runControlPlaneSmoke);
  assert.equal(smokeWrapper.createManagedRuntimeDependencies, createManagedRuntimeDependencies);
  assert.equal(smokeWrapper.smokePublicErrorCode, smokePublicErrorCode);

  for (const forbidden of [
    /\bdocker\b/iu,
    /readProtectedSecret/u,
    /SELECT|INSERT|UPDATE|DELETE FROM/u,
    /provider_secret_ref/u,
    /text\/event-stream/u,
    /message\.delta/u,
  ]) {
    assert.doesNotMatch(wrapperSource, forbidden);
  }
  assert.match(wrapperSource, /export \* from "\.\/lib\/managed-runtime-session\.mjs"/u);
  assert.match(wrapperSource, /process\.once\("SIGINT"/u);
  assert.match(wrapperSource, /process\.once\("SIGTERM"/u);
});

test("smoke public errors remain fixed and never reflect unknown failures", () => {
  assert.equal(smokePublicErrorCode(new Error("private failure detail")), "SMOKE_FAILED");
  assert.equal(smokePublicErrorCode({ code: "PRIVATE_DETAIL" }), "SMOKE_FAILED");
});
