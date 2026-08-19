import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerClock, createWorkerLeaseOwner, loadIdentityFinalizerConfiguration } from "../src/server.js";
import { workerClaimJobKinds } from "../src/main.js";

test("idle wait removes its abort listener after the timer resolves", async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];

  await createWorkerClock().wait(1, controller.signal);
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("already-aborted idle waits add no listener", async () => {
  const controller = new AbortController();
  controller.abort();
  let added = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    added += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];

  await createWorkerClock().wait(1, controller.signal);
  assert.equal(added, 0);
});

test("aborting after idle listener registration removes that listener", async () => {
  const controller = new AbortController();
  let removed = 0;
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removed += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];
  const wait = createWorkerClock().wait(10_000, controller.signal);
  controller.abort();
  await wait;
  assert.equal(removed, 1);
});

test("each Worker process has a bounded unique lease-owner incarnation", () => {
  const first = createWorkerLeaseOwner("worker_alpha", () => "11111111-1111-4111-8111-111111111111");
  const second = createWorkerLeaseOwner("worker_alpha", () => "22222222-2222-4222-8222-222222222222");
  assert.notEqual(first, second);
  assert.match(first, /^worker_alpha:[0-9a-f-]{36}$/);
  assert.equal(first.length <= 128, true);
  assert.throws(() => createWorkerLeaseOwner("invalid worker", () => "11111111-1111-4111-8111-111111111111"), /worker/i);
});

test("identity finalizer production configuration is all-or-none", () => {
  assert.equal(loadIdentityFinalizerConfiguration({}), undefined);
  assert.throws(() => loadIdentityFinalizerConfiguration({
    IDENTITY_DATABASE_URL: "postgresql://core_agent_identity@postgres/core_agent_runtime",
  }), /configuration is incomplete/u);
  assert.deepEqual(loadIdentityFinalizerConfiguration({
    CONTROL_PLANE_DATABASE_URL: "postgresql://core_agent_app@postgres/core_agent_runtime",
    IDENTITY_DATABASE_URL: "postgresql://core_agent_identity@postgres/core_agent_runtime",
    IDENTITY_DATABASE_PASSWORD_FILE: "/run/identity/database-password",
    IDENTITY_PROVIDER_URL: "https://provider.example.test",
    IDENTITY_PROVIDER_SERVICE_ROLE_KEY_FILE: "/run/identity/service-role-key",
  }), {
    databaseUrl: "postgresql://core_agent_identity@postgres/core_agent_runtime",
    databasePasswordFile: "/run/identity/database-password",
    providerUrl: "https://provider.example.test",
    providerServiceRoleKeyFile: "/run/identity/service-role-key",
  });
  for (const identityDatabaseUrl of [
    "postgresql://core_agent_identity@other-postgres/core_agent_runtime",
    "postgresql://core_agent_identity@postgres/other_database",
    "postgresql://core_agent_identity@postgres:5433/core_agent_runtime",
    "postgresql://core_agent_app@postgres/core_agent_runtime",
  ]) {
    assert.throws(() => loadIdentityFinalizerConfiguration({
      CONTROL_PLANE_DATABASE_URL: "postgresql://core_agent_app@postgres/core_agent_runtime",
      IDENTITY_DATABASE_URL: identityDatabaseUrl,
      IDENTITY_DATABASE_PASSWORD_FILE: "/run/identity/database-password",
      IDENTITY_PROVIDER_URL: "https://provider.example.test",
      IDENTITY_PROVIDER_SERVICE_ROLE_KEY_FILE: "/run/identity/service-role-key",
    }), /configuration is invalid/u);
  }
});

test("Worker claims account finalization only with both protected identity dependencies", () => {
  assert.equal(workerClaimJobKinds({}).includes("finalize_account_deletion"), false);
  const identityDb = {} as never;
  const identityProviderDeletion = {} as never;
  assert.equal(workerClaimJobKinds({ identityDb, identityProviderDeletion }).includes("finalize_account_deletion"), true);
  assert.throws(() => workerClaimJobKinds({ identityDb }), /configuration is incomplete/u);
  assert.throws(() => workerClaimJobKinds({ identityProviderDeletion }), /configuration is incomplete/u);
});
