import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createManagedRuntimeDependencies,
  runControlPlaneSmoke,
  runManagedRuntimeSession,
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

const managedContext = Object.freeze({
  tenantId: "synthetic-managed-tenant",
  profileId: "synthetic-managed-profile",
  runtimeId: `runtime_${"a".repeat(32)}`,
});
const managedRuntime = Object.freeze({ observed_state: "ready" });

function lifecycleFixture(overrides = {}) {
  const calls = [];
  const dependencies = {
    validatePrerequisites: async () => calls.push("validatePrerequisites"),
    startTopology: async () => calls.push("startTopology"),
    prepareProvisioningContext: () => {
      calls.push("prepareProvisioningContext");
      return managedContext;
    },
    provision: async (context) => {
      assert.equal(context, managedContext);
      calls.push("provision");
    },
    pollRuntime: async (context) => {
      assert.equal(context, managedContext);
      calls.push("pollRuntime");
      return managedRuntime;
    },
    deleteRuntime: async () => calls.push("deleteRuntime"),
    waitForContainerRemoval: async () => calls.push("waitForContainerRemoval"),
    stopTopology: async () => calls.push("stopTopology"),
    releaseProductImageLockSnapshot: async () => calls.push("releaseProductImageLockSnapshot"),
    releaseSecrets: async () => calls.push("releaseSecrets"),
    ...overrides,
  };
  return { calls, dependencies };
}

test("managed Runtime session owns one ordered lifecycle and default cleanup", async () => {
  const fixture = lifecycleFixture();
  const value = await runManagedRuntimeSession({
    environment: {},
    keepRuntime: false,
    dependencies: fixture.dependencies,
    use: async (session) => {
      fixture.calls.push("use");
      assert.ok(Object.isFrozen(session));
      assert.equal(session.context, managedContext);
      assert.equal(session.runtime, managedRuntime);
      assert.equal(session.operations, fixture.dependencies);
      return "synthetic-use-result";
    },
  });

  assert.equal(value, "synthetic-use-result");
  assert.deepEqual(fixture.calls, [
    "validatePrerequisites",
    "startTopology",
    "prepareProvisioningContext",
    "provision",
    "pollRuntime",
    "use",
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Runtime session continues cleanup and preserves its first cleanup error", async () => {
  const deleteFailure = new Error("private delete detail");
  const fixture = lifecycleFixture({
    deleteRuntime: async () => {
      fixture.calls.push("deleteRuntime");
      throw deleteFailure;
    },
    waitForContainerRemoval: async () => {
      fixture.calls.push("waitForContainerRemoval");
      throw new Error("private wait detail");
    },
    stopTopology: async () => {
      fixture.calls.push("stopTopology");
      throw new Error("private stop detail");
    },
  });

  await assert.rejects(
    runManagedRuntimeSession({
      environment: {},
      keepRuntime: false,
      dependencies: fixture.dependencies,
      use: async () => fixture.calls.push("use"),
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED"
      && error.message === "SMOKE_STAGE_FAILED"
      && error.cause === deleteFailure,
  );
  assert.deepEqual(fixture.calls.slice(-5), [
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Runtime session cleans after use failure and always releases secrets", async () => {
  const useFailure = new Error("private use detail");
  const fixture = lifecycleFixture();
  await assert.rejects(
    runManagedRuntimeSession({
      environment: {},
      keepRuntime: false,
      dependencies: fixture.dependencies,
      use: async () => {
        fixture.calls.push("use");
        throw useFailure;
      },
    }),
    (error) => error?.code === "SMOKE_STAGE_FAILED" && error.cause === useFailure,
  );
  assert.deepEqual(fixture.calls.slice(-5), [
    "deleteRuntime",
    "waitForContainerRemoval",
    "stopTopology",
    "releaseProductImageLockSnapshot",
    "releaseSecrets",
  ]);
});

test("managed Runtime kept success preserves topology and snapshot but zeroizes secrets", async () => {
  const fixture = lifecycleFixture();
  await runManagedRuntimeSession({
    environment: {},
    keepRuntime: true,
    dependencies: fixture.dependencies,
    use: async () => fixture.calls.push("use"),
  });
  assert.deepEqual(fixture.calls, [
    "validatePrerequisites",
    "startTopology",
    "prepareProvisioningContext",
    "provision",
    "pollRuntime",
    "use",
    "releaseSecrets",
  ]);
});
